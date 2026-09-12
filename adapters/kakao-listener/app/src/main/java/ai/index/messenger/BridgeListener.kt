package ai.index.messenger

import android.app.RemoteInput
import android.content.Intent
import android.os.Bundle
import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification

// P3 skeleton: reads KakaoTalk message notifications and forwards them
// to the core /ingress endpoint. No protocol reversing of any kind.
class BridgeListener : NotificationListenerService() {

    override fun onNotificationPosted(sbn: StatusBarNotification) {
        if (sbn.packageName != "com.kakao.talk") return
        val extras = sbn.notification.extras
        val text = extras.getCharSequence("android.text")?.toString() ?: return
        val title = extras.getCharSequence("android.title")?.toString() ?: "unknown"
        // TODO(P3): POST { origin:"kakao", nativeId:"<sbn.key>", lang:"ko", body:text }
        // to CORE_BASE_URL/ingress on a background dispatcher, then
        // remember the notification key per room for ReplySender.
    }

    companion object {
        fun replyIntent(actionTitle: String, seed: Intent): Intent {
            val remoteInputs: Array<RemoteInput>? = null
            // TODO(P3): extract RemoteInput from the WearableExtender action
            // named `actionTitle` and fire it with the translated reply.
            return seed
        }

        fun replyBundle(text: String): Bundle = Bundle().apply {
            // TODO(P3): putCharSequence(remoteInput.resultKey, text)
        }
    }
}
