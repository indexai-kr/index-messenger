package ai.index.messenger

// Pure delivery-guard logic (no Android dependencies) so the outbox echo
// rule is unit-testable: a messageId executes at most once per device,
// no matter how often the server serves it.
object Dedupe {
    fun shouldDeliver(seen: Set<String>, messageId: String): Boolean =
        !seen.contains(messageId)
}
