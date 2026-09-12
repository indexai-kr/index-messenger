package ai.index.messenger

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

// Minimal HTTP layer on HttpURLConnection — no third-party client,
// so the app has no network dependency beyond the platform itself.
// Message bodies are sent to the hub only; they are never logged.
object Net {
    suspend fun postJson(url: String, body: JSONObject, timeoutMs: Int = 10_000): Int =
        withContext(Dispatchers.IO) {
            val conn = (URL(url).openConnection() as HttpURLConnection).apply {
                requestMethod = "POST"
                connectTimeout = timeoutMs
                readTimeout = timeoutMs
                doOutput = true
                setRequestProperty("Content-Type", "application/json; charset=utf-8")
            }
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
            }
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
            Net.postJson("$baseUrl/ingress", payload) in 200..299
        } catch (_: Exception) {
            false
        }
    }

    suspend fun pollOutbox(baseUrl: String, since: Long): List<OutboxItem> {
        return try {
            val raw = Net.getJson("$baseUrl/outbox?channel=kakao&since=$since")
            val items = JSONObject(raw).optJSONArray("items") ?: return emptyList()
            List(items.length()) { i ->
                val o = items.getJSONObject(i)
                OutboxItem(
                    messageId = o.getString("messageId"),
                    body = o.optString("body", ""),
                    lang = o.optString("lang", "ko"),
                    ts = o.optLong("ts", 0L),
                )
            }
        } catch (_: Exception) {
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
            Net.postJson("$baseUrl/outbox/ack", payload) in 200..299
        } catch (_: Exception) {
            false
        }
    }
}
