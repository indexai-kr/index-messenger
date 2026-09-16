package ai.index.messenger

import android.util.Log
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

// Minimal HTTP layer on HttpURLConnection — no third-party client,
// so the app has no network dependency beyond the platform itself.
// Message bodies are sent to the hub only; they are never logged.
object Net {
    // Shared core token (CORE_AUTH_TOKEN on the hub). Empty = the core
    // runs open on loopback and expects no header. Never logged.
    @Volatile var authToken: String = ""

    private fun HttpURLConnection.withAuth(): HttpURLConnection {
        if (authToken.isNotEmpty()) setRequestProperty("Authorization", "Bearer $authToken")
        return this
    }

    suspend fun postJson(url: String, body: JSONObject, timeoutMs: Int = 10_000): Int =
        withContext(Dispatchers.IO) {
            val conn = (URL(url).openConnection() as HttpURLConnection).apply {
                requestMethod = "POST"
                connectTimeout = timeoutMs
                readTimeout = timeoutMs
                doOutput = true
                setRequestProperty("Content-Type", "application/json; charset=utf-8")
            }.withAuth()
            try {
                conn.outputStream.use { it.write(body.toString().toByteArray(Charsets.UTF_8)) }
                conn.responseCode
            } finally {
                conn.disconnect()
            }
        }

    suspend fun getJson(url: String, timeoutMs: Int = 10_000): String =
        withContext(Dispatchers.IO) {
            val conn = (URL(url).openConnection() as HttpURLConnection).apply {
                connectTimeout = timeoutMs
                readTimeout = timeoutMs
            }.withAuth()
            try {
                conn.inputStream.use { it.readBytes().toString(Charsets.UTF_8) }
            } finally {
                conn.disconnect()
            }
        }
}

data class OutboxItem(
    val messageId: String,
    val body: String,
    val lang: String,
    val ts: Long,
)

// Core /ingress + /outbox clients. Sender follows the P2-0 schema:
// { platform: "kakao", id, displayName }.
object HubClient {
    suspend fun ingress(
        baseUrl: String,
        nativeId: String,
        lang: String,
        body: String,
        senderId: String,
        displayName: String,
    ): Boolean {
        val payload = JSONObject()
            .put("origin", "kakao")
            .put("nativeId", nativeId)
            .put("lang", lang)
            .put("body", body)
            .put(
                "sender",
                JSONObject()
                    .put("platform", "kakao")
                    .put("id", senderId)
                    .put("displayName", displayName),
            )
        return try {
            val code = Net.postJson("$baseUrl/ingress", payload)
            Log.i(TAG, "ingress http=$code")
            code in 200..299
        } catch (e: Exception) {
            // Exception class only — a network failure must be visible in
            // logcat during measurement, but never carries message data.
            Log.w(TAG, "ingress failed ${e.javaClass.simpleName}")
            false
        }
    }

    suspend fun pollOutbox(baseUrl: String, since: Long): List<OutboxItem> {
        return try {
            val raw = Net.getJson("$baseUrl/outbox?channel=kakao&since=$since")
            val items = JSONObject(raw).optJSONArray("items") ?: return emptyList()
            val parsed = List(items.length()) { i ->
                val o = items.getJSONObject(i)
                OutboxItem(
                    messageId = o.getString("messageId"),
                    body = o.optString("body", ""),
                    lang = o.optString("lang", "ko"),
                    ts = o.optLong("ts", 0L),
                )
            }
            if (parsed.isNotEmpty()) Log.i(TAG, "poll items=${parsed.size} since=$since")
            parsed
        } catch (e: Exception) {
            Log.w(TAG, "poll failed ${e.javaClass.simpleName}")
            emptyList()
        }
    }

    suspend fun ack(baseUrl: String, messageId: String, ok: Boolean, error: String = "", mode: String = ""): Boolean {
        val payload = JSONObject()
            .put("messageId", messageId)
            .put("channel", "kakao")
            .put("ok", ok)
            .put("error", error)
            .put("mode", mode)
        return try {
            val code = Net.postJson("$baseUrl/outbox/ack", payload)
            Log.i(TAG, "ack ok=$ok mode=${mode.ifEmpty { "-" }} error=${error.ifEmpty { "-" }} http=$code")
            code in 200..299
        } catch (e: Exception) {
            Log.w(TAG, "ack failed ${e.javaClass.simpleName}")
            false
        }
    }

    private const val TAG = "IndexBridge"
}
