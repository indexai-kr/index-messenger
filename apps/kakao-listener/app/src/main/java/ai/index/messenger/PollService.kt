package ai.index.messenger

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.IBinder
import androidx.core.app.NotificationCompat
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import org.json.JSONArray
import org.json.JSONObject

// Hub-to-Kakao delivery: polls the core outbox (default every 3 s) and
// answers through the room's notification reply action. Hub-originated
// traffic only — nothing else is ever sent.
//
// One delivery path. A message coming straight from the outbox and a
// message coming back from the retry queue go through the same
// attempt(): dry-run switch, pacing (quiet hours, daily cap, per-room
// cooldown), room resolution, reply, send bookkeeping. Nothing can be
// sent through a side door that skips a check.
//
// Retry policy: failures stay in a capped on-device queue (20 items max,
// bodies dropped after MAX attempts). Overflow is reported to the hub as
// its own error, never silently removed. No plaintext message log files
// — the ledger on the hub is the record.
class PollService : Service() {

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private var loopJob: Job? = null
    private lateinit var config: BridgeConfig

    override fun onCreate() {
        super.onCreate()
        config = BridgeConfig(this)
        startForeground(STATUS_ID, statusNotification("starting"))
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        // START_STICKY and the settings screen both call this again; one
        // poll loop per process, never a second one racing the queue.
        if (loopJob?.isActive != true) loopJob = scope.launch { loop() }
        return START_STICKY
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onDestroy() {
        scope.cancel()
        super.onDestroy()
    }

    private suspend fun loop() {
        while (scope.isActive) {
            try {
                pollOnce()
            } catch (_: Exception) {
                // Metadata-only failure handling; loop never dies loudly.
            }
            delay(config.pollSecs * 1000L)
        }
    }

    private suspend fun pollOnce() {
        val baseUrl = config.coreBaseUrl
        if (baseUrl.isEmpty()) return
        // First boot starts at now: the backlog already sitting in the
        // outbox (e.g. older fan-outs) is NOT auto-fired into the test
        // room. Backfill is opt-in via settings. The ledger is untouched.
        if (config.lastAckTs < 0 && !config.allowBackfill) {
            config.lastAckTs = System.currentTimeMillis()
            updateStatus(0)
            return
        }
        val items = HubClient.pollOutbox(baseUrl, config.lastAckTs)
        var maxTs = config.lastAckTs
        val seen = config.snapshotDelivered().toMutableSet()
        val queue = readQueue().toMutableList()
        val queued = queue.map { it.messageId }.toSet()
        val now = System.currentTimeMillis()
        val fresh = mutableListOf<RetryJob>()
        for (item in items) {
            // App-side echo guard: never execute a messageId twice, even if
            // the server ever serves it again — and never start a second
            // attempt for one that is already waiting in the retry queue.
            if (Dedupe.shouldDeliver(seen, item.messageId) && item.messageId !in queued) {
                fresh.add(RetryJob(item.messageId, item.body, config.defaultRoom, tries = 0, nextTs = now))
                seen.add(item.messageId)
            }
            if (item.ts > maxTs) maxTs = item.ts
        }
        // Everything that may go now — due retries and fresh items — is
        // one batch: one reply action, one pacing slot, every line.
        val due = queue.filter { it.nextTs <= now }
        val batch = due + fresh
        if (batch.isNotEmpty()) {
            queue.removeAll(due)
            val steps = attemptBatch(batch)
            for (step in steps) if (step is RetryStep.Requeue) queue.add(step.job)
            for (evicted in RetryPlanner.overflow(queue, MAX_QUEUE)) {
                queue.remove(evicted)
                settle(evicted.messageId, ok = false, error = "queue-overflow")
            }
            writeQueue(queue)
        }
        config.lastAckTs = maxTs
        updateStatus(items.size)
    }

    // One reply for the whole batch. Checks run once (dry-run, pacing, room
    // resolution); the outcome applies to every job in it: all settled
    // on success, all requeued on a hold or a failure.
    private suspend fun attemptBatch(jobs: List<RetryJob>): List<RetryStep> {
        if (jobs.size == 1) return listOfNotNull(attempt(jobs[0], fromQueue = true))
        val room = config.defaultRoom
        val now = System.currentTimeMillis()
        if (room.isEmpty() || config.dryRun) {
            // Same per-job handling as a single attempt; nothing is sent.
            return jobs.mapNotNull { attempt(it, fromQueue = true) }
        }
        val calendar = java.util.Calendar.getInstance()
        val pace = config.paceCheck(
            room = room,
            nowMs = now,
            hour = calendar.get(java.util.Calendar.HOUR_OF_DAY),
            day = dayOf(calendar),
        )
        if (!pace.allowed) {
            if (pace.reason == "cooling-down") {
                return jobs.map { job ->
                    val step = RetryPlanner.afterCooldown(job, pace.waitMs, now)
                    HubClient.ack(config.coreBaseUrl, job.messageId, false, "cooling-down")
                    step
                }
            }
            jobs.forEach { settle(it.messageId, ok = false, error = pace.reason) }
            return emptyList()
        }
        val found = ReplySender.findNotification(listener(), room)
        if (found == null) {
            val error = ReplySender.resolutionError(room) ?: "no-notification-for-room"
            return jobs.mapNotNull { job -> schedule(RetryPlanner.afterFailure(job, error, config.maxRetry, now), fromQueue = true) }
        }
        val result = ReplySender.reply(listener(), found.first, RetryPlanner.batchBody(jobs))
        return if (result.ok) {
            config.recordSend(room, now, dayOf(calendar))
            jobs.forEach { settle(it.messageId, ok = true) }
            emptyList()
        } else {
            jobs.mapNotNull { job -> schedule(RetryPlanner.afterFailure(job, result.error, config.maxRetry, now), fromQueue = true) }
        }
    }

    // The single delivery path. Returns the step the job takes next, or
    // null when it is settled (sent, dry-run, or reported as final).
    private suspend fun attempt(job: RetryJob, fromQueue: Boolean): RetryStep? {
        val room = job.room
        if (room.isEmpty()) {
            settle(job.messageId, ok = false, error = "no-default-room")
            return null
        }
        // ③ Dry run: rehearse everything except the actual send. Recorded
        // as its own verdict — never as delivered. Checked on every
        // attempt, so flipping the switch while a retry waits is honoured.
        if (config.dryRun) {
            HubClient.ack(config.coreBaseUrl, job.messageId, true, mode = "dry-run")
            config.markDelivered(job.messageId)
            return null
        }
        // ① Pacing on every attempt: quiet hours, daily cap, per-room
        // cooldown + jitter. A retry does not get to skip the queue.
        val now = System.currentTimeMillis()
        val calendar = java.util.Calendar.getInstance()
        val pace = config.paceCheck(
            room = room,
            nowMs = now,
            hour = calendar.get(java.util.Calendar.HOUR_OF_DAY),
            day = dayOf(calendar),
        )
        if (!pace.allowed) {
            if (pace.reason == "cooling-down") {
                // Waiting is policy, not a failure: no try is consumed.
                return schedule(RetryPlanner.afterCooldown(job, pace.waitMs, now), fromQueue)
            }
            // quiet-hours / daily-cap: not retryable right now, record and drop.
            settle(job.messageId, ok = false, error = pace.reason)
            return null
        }
        // ② Ambiguity block: zero or several live notifications for one title.
        val found = ReplySender.findNotification(listener(), room)
        if (found == null) {
            val error = ReplySender.resolutionError(room) ?: "no-notification-for-room"
            return schedule(RetryPlanner.afterFailure(job, error, config.maxRetry, now), fromQueue)
        }
        val result = ReplySender.reply(listener(), found.first, job.body)
        return if (result.ok) {
            // The reply action fired. That is what we know: the hub records
            // it as delivered on the app's word, the notification API gives
            // no receipt beyond this.
            config.recordSend(room, now, dayOf(calendar))
            settle(job.messageId, ok = true)
            null
        } else {
            schedule(RetryPlanner.afterFailure(job, result.error, config.maxRetry, now), fromQueue)
        }
    }

    // Apply a planner step. A job coming from the queue is re-inserted by
    // retryDue() (which owns the list for that pass); a fresh outbox item
    // is enqueued here.
    private suspend fun schedule(step: RetryStep, fromQueue: Boolean): RetryStep? {
        when (step) {
            is RetryStep.Exhausted -> {
                settle(step.messageId, ok = false, error = "retry-exhausted")
                return null
            }
            is RetryStep.Requeue -> {
                // The caller (pollOnce) owns the queue for this pass and
                // re-inserts requeued jobs; nothing is written from here.
                HubClient.ack(config.coreBaseUrl, step.job.messageId, false, step.error)
                return step
            }
        }
    }

    private suspend fun settle(messageId: String, ok: Boolean, error: String = "") {
        HubClient.ack(config.coreBaseUrl, messageId, ok, error)
        config.markDelivered(messageId)
    }

    private fun dayOf(calendar: java.util.Calendar): String =
        "%04d-%02d-%02d".format(
            calendar.get(java.util.Calendar.YEAR),
            calendar.get(java.util.Calendar.MONTH) + 1,
            calendar.get(java.util.Calendar.DAY_OF_MONTH),
        )

    private fun readQueue(): List<RetryJob> {
        val prefs = getSharedPreferences("index_retry", Context.MODE_PRIVATE)
        val raw = prefs.getString(KEY_QUEUE, "[]") ?: "[]"
        return try {
            val arr = JSONArray(raw)
            List(arr.length()) { i ->
                val o = arr.getJSONObject(i)
                RetryJob(
                    messageId = o.getString("messageId"),
                    body = o.getString("body"),
                    room = o.getString("room"),
                    tries = o.getInt("tries"),
                    nextTs = o.getLong("nextTs"),
                )
            }
        } catch (_: Exception) {
            emptyList()
        }
    }

    private fun writeQueue(queue: List<RetryJob>) {
        val arr = JSONArray()
        queue.forEach { arr.put(JSONObject().put("messageId", it.messageId).put("body", it.body).put("room", it.room).put("tries", it.tries).put("nextTs", it.nextTs)) }
        getSharedPreferences("index_retry", Context.MODE_PRIVATE).edit().putString(KEY_QUEUE, arr.toString()).apply()
    }

    // The listener instance is owned by the system; reach it through the
    // running service set is unreliable, so delivery binds on first
    // notification via RoomIndex and a static handle set by KakaoListener.
    private fun listener(): KakaoListener = ListenerHandle.get()
        ?: throw IllegalStateException("listener-not-running")

    private fun statusNotification(text: String): Notification {
        val manager = getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(
            NotificationChannel(CHANNEL_ID, "Index bridge", NotificationManager.IMPORTANCE_LOW),
        )
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("Index Kakao bridge")
            .setContentText(text)
            .setSmallIcon(android.R.drawable.stat_notify_sync)
            .setOngoing(true)
            .build()
    }

    private fun updateStatus(fetched: Int) {
        val manager = getSystemService(NotificationManager::class.java)
        val waiting = readQueue()
        val next = waiting.minOfOrNull { it.nextTs }
        val queueNote = if (waiting.isEmpty()) "" else {
            val inSecs = ((next ?: 0L) - System.currentTimeMillis()).coerceAtLeast(0L) / 1000
            " · ${waiting.size} waiting, next in ${inSecs}s"
        }
        manager.notify(STATUS_ID, statusNotification("last poll: $fetched item(s)$queueNote"))
    }

    companion object {
        private const val CHANNEL_ID = "index_bridge_status"
        private const val STATUS_ID = 41
        private const val KEY_QUEUE = "retry_queue"
        private const val MAX_QUEUE = 20
    }
}

data class RetryJob(
    val messageId: String,
    val body: String,
    val room: String,
    val tries: Int,
    val nextTs: Long,
)

// Set by KakaoListener.onCreate so the poll loop can reach RemoteInput.
object ListenerHandle {
    @Volatile private var ref: KakaoListener? = null
    fun set(l: KakaoListener) { ref = l }
    fun get(): KakaoListener? = ref
}
