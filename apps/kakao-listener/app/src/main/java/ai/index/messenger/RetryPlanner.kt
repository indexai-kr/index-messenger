package ai.index.messenger

// Pure retry policy (no Android dependencies) shared by the first
// delivery attempt and every retry, so both follow one rule set:
//
//   cooling-down   the room's pacing window is not over: wait exactly
//                  as long as pacing says, and do NOT consume a try —
//                  waiting is policy, not a failure
//   transient      no notification / reply action failed / network:
//                  consume a try, back off tries × 60 s
//   exhausted      tries would exceed maxRetry: report and drop
//   queue-overflow the on-device queue is full: the oldest job is
//                  reported and dropped, never silently removed
sealed class RetryStep {
    data class Requeue(val job: RetryJob, val error: String) : RetryStep()
    data class Exhausted(val messageId: String) : RetryStep()
}

object RetryPlanner {
    const val BACKOFF_MS = 60_000L

    fun afterFailure(job: RetryJob, error: String, maxRetry: Int, nowMs: Long): RetryStep {
        val tries = job.tries + 1
        if (tries > maxRetry) return RetryStep.Exhausted(job.messageId)
        return RetryStep.Requeue(job.copy(tries = tries, nextTs = nowMs + tries * BACKOFF_MS), error)
    }

    fun afterCooldown(job: RetryJob, waitMs: Long, nowMs: Long): RetryStep =
        RetryStep.Requeue(job.copy(nextTs = nowMs + waitMs.coerceAtLeast(1_000L)), "cooling-down")

    /** Jobs that must be dropped to make room, oldest first. */
    fun overflow(queue: List<RetryJob>, max: Int): List<RetryJob> =
        if (queue.size <= max) emptyList() else queue.sortedBy { it.nextTs }.take(queue.size - max)
}
