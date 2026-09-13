package ai.index.messenger

import android.content.Context
import android.content.SharedPreferences

// Hub connection + polling policy. Everything lives in the on-device
// settings screen — nothing is hardcoded, nothing leaves the device
// except the /ingress and /outbox calls themselves.
class BridgeConfig(context: Context) {
    private val prefs: SharedPreferences =
        context.getSharedPreferences("index_messenger", Context.MODE_PRIVATE)

    // Documentation address only (TEST-NET-1). The user overwrites it
    // with their own hub address on first launch.
    var coreBaseUrl: String
        get() = prefs.getString(KEY_BASE_URL, "http://192.0.2.1:8787") ?: ""
        set(v) = prefs.edit().putString(KEY_BASE_URL, v.trimEnd('/')).apply()

    var pollSecs: Int
        get() = prefs.getInt(KEY_POLL_SECS, 3).coerceIn(1, 60)
        set(v) = prefs.edit().putInt(KEY_POLL_SECS, v).apply()

    var maxRetry: Int
        get() = prefs.getInt(KEY_MAX_RETRY, 5).coerceIn(0, 20)
        set(v) = prefs.edit().putInt(KEY_MAX_RETRY, v).apply()

    // P3 scope: hub-to-kakao delivery targets a single room by title.
    // Multi-room routing is future work, not silent behavior.
    var defaultRoom: String
        get() = prefs.getString(KEY_ROOM, "") ?: ""
        set(v) = prefs.edit().putString(KEY_ROOM, v).apply()

    // ① Send pacing (anti-ban): same room / room switch intervals (sec),
    // quiet hours [start, end), daily cap, dry-run rehearsal switch.
    var sameRoomSecs: Int
        get() = prefs.getInt(KEY_SAME_ROOM, 30).coerceIn(5, 600)
        set(v) = prefs.edit().putInt(KEY_SAME_ROOM, v).apply()

    var roomSwitchSecs: Int
        get() = prefs.getInt(KEY_SWITCH_ROOM, 10).coerceIn(5, 600)
        set(v) = prefs.edit().putInt(KEY_SWITCH_ROOM, v).apply()

    var quietStart: Int
        get() = prefs.getInt(KEY_QUIET_START, 1).coerceIn(0, 23)
        set(v) = prefs.edit().putInt(KEY_QUIET_START, v).apply()

    var quietEnd: Int
        get() = prefs.getInt(KEY_QUIET_END, 7).coerceIn(0, 23)
        set(v) = prefs.edit().putInt(KEY_QUIET_END, v).apply()

    var dailyCap: Int
        get() = prefs.getInt(KEY_DAILY_CAP, 50).coerceIn(1, 500)
        set(v) = prefs.edit().putInt(KEY_DAILY_CAP, v).apply()

    var dryRun: Boolean
        get() = prefs.getBoolean(KEY_DRY_RUN, false)
        set(v) = prefs.edit().putBoolean(KEY_DRY_RUN, v).apply()

    // Pacing state. Dates are local day strings; counters reset on rollover.
    fun paceCheck(room: String, nowMs: Long, hour: Int, day: String): PaceDecision {
        if (inQuiet(hour)) return PaceDecision(false, "quiet-hours", 0L)
        val lastDay = prefs.getString(KEY_DAY, "")
        var count = prefs.getInt(KEY_COUNT, 0)
        if (lastDay != day) {
            count = 0
            prefs.edit().putString(KEY_DAY, day).putInt(KEY_COUNT, 0).apply()
        }
        if (count >= dailyCap) return PaceDecision(false, "daily-cap", 0L)
        val lastRoom = prefs.getString(KEY_LAST_ROOM, null)
        val lastTs = prefs.getLong(KEY_LAST_TS, 0L)
        val baseSecs = if (lastRoom == room) sameRoomSecs else roomSwitchSecs
        // Jitter ±20%: exact intervals look mechanical, humans never do that.
        val waitMs = (baseSecs * 1000L * (0.8 + Math.random() * 0.4)).toLong()
        val elapsed = nowMs - lastTs
        if (lastTs != 0L && elapsed < waitMs) return PaceDecision(false, "cooling-down", waitMs - elapsed)
        return PaceDecision(true, "", 0L)
    }

    fun recordSend(room: String, nowMs: Long, day: String) {
        prefs.edit()
            .putString(KEY_LAST_ROOM, room)
            .putLong(KEY_LAST_TS, nowMs)
            .putString(KEY_DAY, day)
            .putInt(KEY_COUNT, prefs.getInt(KEY_COUNT, 0) + 1)
            .apply()
    }

    private fun inQuiet(hour: Int): Boolean {
        return if (quietStart <= quietEnd) hour in quietStart until quietEnd
        else hour >= quietStart || hour < quietEnd
    }

    var lastAckTs: Long
        get() = prefs.getLong(KEY_SINCE, -1L)
        set(v) = prefs.edit().putLong(KEY_SINCE, v).apply()

    // Opt-in backlog catch-up. Default false: first boot starts at now.
    var allowBackfill: Boolean
        get() = prefs.getBoolean(KEY_BACKFILL, false)
        set(v) = prefs.edit().putBoolean(KEY_BACKFILL, v).apply()

    // Outbox-side dedupe uses the same delivered set as ingress
    // (messageIds are globally unique), hence no second store.

    // Delivered ingress ids (dedupe). Bodies are never stored here.
    fun isDelivered(id: String): Boolean = delivered().contains(id)

    fun snapshotDelivered(): Set<String> = delivered().toSet()

    fun markDelivered(id: String) {
        val keep = (delivered() + id).takeLast(MAX_DELIVERED)
        prefs.edit().putString(KEY_DELIVERED, keep.joinToString("\n")).apply()
    }

    private fun delivered(): List<String> =
        (prefs.getString(KEY_DELIVERED, "") ?: "").split("\n").filter { it.isNotEmpty() }

    companion object {
        private const val KEY_BASE_URL = "core_base_url"
        private const val KEY_POLL_SECS = "poll_secs"
        private const val KEY_MAX_RETRY = "max_retry"
        private const val KEY_ROOM = "default_room"
        private const val KEY_SINCE = "last_ack_ts"
        private const val KEY_BACKFILL = "allow_backfill"
        private const val KEY_DELIVERED = "delivered_ids"
        private const val KEY_SAME_ROOM = "same_room_secs"
        private const val KEY_SWITCH_ROOM = "room_switch_secs"
        private const val KEY_QUIET_START = "quiet_start"
        private const val KEY_QUIET_END = "quiet_end"
        private const val KEY_DAILY_CAP = "daily_cap"
        private const val KEY_DRY_RUN = "dry_run"
        private const val KEY_LAST_ROOM = "last_send_room"
        private const val KEY_LAST_TS = "last_send_ts"
        private const val KEY_DAY = "send_day"
        private const val KEY_COUNT = "send_count"
        private const val MAX_DELIVERED = 500
    }
}

data class PaceDecision(val allowed: Boolean, val reason: String, val waitMs: Long)
