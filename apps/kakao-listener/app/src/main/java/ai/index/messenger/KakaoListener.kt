package ai.index.messenger

import android.content.Intent
import android.os.Bundle
import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.RemoteInput
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import java.util.concurrent.ConcurrentHashMap

// KakaoTalk ingress: reads message notifications (NotificationListenerService)
// and forwards them to the hub. No protocol reversing of any kind.
//
// Inherent limits (also stated in the repo README, not hidden):
// - a powered-on phone is required around the clock,
// - rooms with notifications muted cannot be received,
// - long messages may arrive truncated by the notification itself.
class KakaoListener : NotificationListenerService() {

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private lateinit var config: BridgeConfig

    override fun onCreate() {
        super.onCreate()
        config = BridgeConfig(this)
        ListenerHandle.set(this)
    }

    override fun onNotificationPosted(sbn: StatusBarNotification) {
        if (sbn.packageName != KAKAO_PACKAGE) return
        val extras = sbn.notification.extras ?: return
        val room = roomOf(extras) ?: return
        // One room only. The bridge is scoped to the room the owner named
        // in settings; every other KakaoTalk notification on this phone is
        // none of the hub's business — not read, not indexed, not sent
        // anywhere. An empty setting means no room, hence no ingress.
        val bound = config.defaultRoom
        val matched = bound.isNotEmpty() && room == bound
        val items = if (matched) messagesOf(extras) else emptyList()
        // Metadata-only trace for live measurement (logcat): never a room
        // title, never a sender, never a body. Lengths and counts only.
        Log.i(
            TAG,
            "kakao notif id=${sbn.id} roomMatch=$matched titleLen=${room.length} " +
                "hasConversationTitle=${extras.getCharSequence("android.conversationTitle") != null} " +
                "messages=${items.size}",
        )
        if (!matched || items.isEmpty()) return
        RoomIndex.put(room, sbn.key)
        scope.launch {
            val baseUrl = config.coreBaseUrl
            if (baseUrl.isEmpty()) return@launch
            items.forEachIndexed { index, (sender, text) ->
                val nativeId = "${sbn.key}:${sbn.postTime}:$index"
                if (config.isDelivered(nativeId)) return@forEachIndexed
                val ok = HubClient.ingress(
                    baseUrl = baseUrl,
                    nativeId = nativeId,
                    lang = "ko",
                    body = text,
                    senderId = sender,
                    displayName = sender,
                )
                Log.i(TAG, "ingress index=$index ok=$ok bodyLen=${text.length}")
                if (ok) config.markDelivered(nativeId)
            }
        }
    }

    override fun onNotificationRemoved(sbn: StatusBarNotification) {
        RoomIndex.removeKey(sbn.key)
    }

    private fun roomOf(extras: Bundle): String? {
        // Group rooms expose a conversation title; 1:1 rooms fall back to
        // the title, which is the sender (= the room) there.
        val conversation = extras.getCharSequence("android.conversationTitle")?.toString()
        if (!conversation.isNullOrEmpty()) return conversation
        return extras.getCharSequence("android.title")?.toString()
    }

    // Bundled MessagingStyle messages first (a burst in one room arrives as
    // several — inject every undelivered one, not just the last), then the
    // single-text fallback.
    private fun messagesOf(extras: Bundle): List<Pair<String, String>> {
        val bundled = extras.getParcelableArray("android.messages")
            ?.mapNotNull { it as? Bundle }
            ?.mapNotNull { b ->
                val text = b.getCharSequence("text")?.toString() ?: return@mapNotNull null
                val sender = b.getCharSequence("sender")?.toString() ?: "unknown"
                sender to text
            }
        if (!bundled.isNullOrEmpty()) return bundled
        val text = extras.getCharSequence("android.text")?.toString() ?: return emptyList()
        val sender = extras.getCharSequence("android.title")?.toString() ?: "unknown"
        return listOf(sender to text)
    }

    companion object {
        const val KAKAO_PACKAGE = "com.kakao.talk"
        const val TAG = "IndexBridge"
    }
}

// Notification keys per room title. Titles are NOT unique — two rooms can
// share a name, and replying would hit the wrong one. Callers must treat
// anything but exactly-one-key as undeliverable (see RoomResolution).
object RoomIndex {
    private val rooms = ConcurrentHashMap<String, MutableSet<String>>()

    fun put(room: String, key: String) {
        rooms.computeIfAbsent(room) { ConcurrentHashMap.newKeySet() }.add(key)
    }

    fun removeKey(key: String) {
        rooms.values.forEach { it.remove(key) }
        rooms.entries.removeIf { it.value.isEmpty() }
    }

    fun keysFor(room: String): Set<String> = rooms[room]?.toSet() ?: emptySet()
}

sealed interface RoomResolution {
    data class Unique(val key: String) : RoomResolution
    data class Unresolvable(val reason: String) : RoomResolution

    companion object {
        fun resolve(room: String): RoomResolution {
            val keys = RoomIndex.keysFor(room)
            return when {
                keys.isEmpty() -> Unresolvable("no-notification-for-room")
                keys.size > 1 -> Unresolvable("ambiguous-room")
                else -> Unique(keys.first())
            }
        }
    }
}

// Outbound reply through the notification's own reply action.
// Returns an error code, never throws, never logs message content.
object ReplySender {
    fun reply(listener: KakaoListener, sbn: StatusBarNotification, text: String): ReplyResult {
        return try {
            val action = remoteInputAction(sbn) ?: return ReplyResult(false, "no-remote-input")
            val remoteInputs = action.remoteInputs ?: return ReplyResult(false, "no-remote-input")
            val pending = action.actionIntent ?: return ReplyResult(false, "no-action-intent")
            val results = Bundle()
            remoteInputs.forEach { remoteInput ->
                results.putCharSequence(remoteInput.resultKey, text)
            }
            val filled = Intent().also { RemoteInput.addResultsToIntent(remoteInputs, it, results) }
            pending.send(listener, 0, filled)
            ReplyResult(true)
        } catch (e: Exception) {
            ReplyResult(false, e.javaClass.simpleName)
        }
    }

    // Compat types end to end: framework actions are read through
    // NotificationCompat.getAction so they share one RemoteInput type with
    // the wearable extender actions.
    private fun remoteInputAction(sbn: StatusBarNotification): NotificationCompat.Action? {
        val notification = sbn.notification
        val framework = (0 until NotificationCompat.getActionCount(notification))
            .mapNotNull { NotificationCompat.getAction(notification, it) }
        val wearable = NotificationCompat.WearableExtender(notification).actions
        return (framework + wearable).firstOrNull { !it.remoteInputs.isNullOrEmpty() }
    }

    fun findNotification(listener: KakaoListener, room: String): Pair<StatusBarNotification, RoomResolution>? {
        return when (val resolution = RoomResolution.resolve(room)) {
            is RoomResolution.Unique -> {
                val sbn = try {
                    listener.activeNotifications.firstOrNull { it.key == resolution.key }
                } catch (_: SecurityException) {
                    null
                } ?: return null
                sbn to resolution
            }
            is RoomResolution.Unresolvable -> null
        }
    }

    fun resolutionError(room: String): String? {
        return (RoomResolution.resolve(room) as? RoomResolution.Unresolvable)?.reason
    }
}

data class ReplyResult(val ok: Boolean, val error: String = "")
