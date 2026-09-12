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
// Retry policy: failures stay in a capped on-device queue (20 items max,
// bodies dropped after MAX attempts). No unbounded accumulation, no
// plaintext message log files — the ledger on the hub is the record.
class PollService : Service() {

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private lateinit var config: BridgeConfig
    private lateinit var listener: KakaoListener

    override fun onCreate() {
        super.onCreate()
        config = BridgeConfig(this)
        startForeground(STATUS_ID, statusNotification("starting"))
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        scope.launch { loop() }
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
        retryDue()
        val items = HubClient.pollOutbox(baseUrl, config.lastAckTs)
        var maxTs = config.lastAckTs
        for (item in items) {
            deliver(item)
            if (item.ts > maxTs) maxTs = item.ts
        }
        config.lastAckTs = maxTs
        updateStatus(items.size)
    }

    private suspend fun deliver(item: OutboxItem) {
        val room = config.defaultRoom
        if (room.isEmpty()) {
            HubClient.ack(config.coreBaseUrl, item.messageId, false, "no-default-room")
            return
        }
        // ③ Dry run: rehearse everything except the actual send. Recorded
        // as its own verdict — never as delivered.
        if (config.dryRun) {
            HubClient.ack(config.coreBaseUrl, item.messageId, true, mode = "dry-run")
            return
        }
        // ① Pacing first: quiet hours, daily cap, per-room cooldown + jitter.
        val now = System.currentTimeMillis()
        val calendar = java.util.Calendar.getInstance()
        val pace = config.paceCheck(
            room = room,
            nowMs = now,
            hour = calendar.get(java.util.Calendar.HOUR_OF_DAY),
            day = "%04d-%02d-%02d".format(
                calendar.get(java.util.Calendar.YEAR),
                calendar.get(java.util.Calendar.MONTH) + 1,
                calendar.get(java.util.Calendar.DAY_OF_MONTH),
            ),
        )
        if (!pace.allowed) {
            if (pace.reason == "cooling-down") {
                enqueueRetry(item, room, pace.reason, delayMs = pace.waitMs)
            } else {
                // quiet-hours / daily-cap: not retryable right now, record and drop.
                HubClient.ack(config.coreBaseUrl, item.messageId, false, pace.reason)
            }
            return
        }
        // ② Ambiguity block: zero or several live notifications for one title.
        val found = ReplySender.findNotification(listener(), room)
        if (found == null) {
            enqueueRetry(item, room, ReplySender.resolutionError(room) ?: "no-notification-for-room")
            return
        }
        val result = ReplySender.reply(listener(), found.first, item.body)
        if (result.ok) {
            config.recordSend(room, now, dayOf(calendar))
            HubClient.ack(config.coreBaseUrl, item.messageId, true)
        } else {
            enqueueRetry(item, room, result.error)
        }
    }

    private fun dayOf(calendar: java.util.Calendar): String =
        "%04d-%02d-%02d".format(
            calendar.get(java.util.Calendar.YEAR),
            calendar.get(java.util.Calendar.MONTH) + 1,
            calendar.get(java.util.Calendar.DAY_OF_MONTH),
        )

    private suspend fun retryDue() {
        val now = System.currentTimeMillis()
        val queue = readQueue().toMutableList()
        val due = queue.filter { it.nextTs <= now }
        if (due.isEmpty()) return
        for (job in due) {
            queue.remove(job)
            if (job.tries >= config.maxRetry) {
                HubClient.ack(config.coreBaseUrl, job.messageId, false, "retry-exhausted")
                continue
            }
            val found = ReplySender.findNotification(listener(), job.room)
            if (found == null) {
                requeue(queue, job, ReplySender.resolutionError(job.room) ?: "no-notification-for-room")
                continue
            }
            val result = ReplySender.reply(listener(), found.first, job.body)
            if (result.ok) {
                HubClient.ack(config.coreBaseUrl, job.messageId, true)
            } else {
                requeue(queue, job, result.error)
            }
        }
        writeQueue(queue)
    }

    private fun requeue(queue: MutableList<RetryJob>, job: RetryJob, error: String) {
        val tries = job.tries + 1
        if (tries > config.maxRetry) {
            scope.launch { HubClient.ack(config.coreBaseUrl, job.messageId, false, "retry-exhausted") }
            return
        }
        queue.add(job.copy(tries = tries, nextTs = System.currentTimeMillis() + tries * 60_000L))
        scope.launch { HubClient.ack(config.coreBaseUrl, job.messageId, false, error) }
    }

    private suspend fun enqueueRetry(item: OutboxItem, room: String, error: String, delayMs: Long = 60_000L) {
        val queue = readQueue().toMutableList()
        queue.add(RetryJob(item.messageId, item.body, room, tries = 1, nextTs = System.currentTimeMillis() + delayMs))
        while (queue.size > MAX_QUEUE) queue.removeAt(0)
        writeQueue(queue)
        HubClient.ack(config.coreBaseUrl, item.messageId, false, error)
    }

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
        manager.notify(STATUS_ID, statusNotification("last poll: $fetched item(s)"))
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
