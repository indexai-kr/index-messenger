package ai.index.messenger

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

// Pure retry policy, shared by the first attempt and every retry.
class RetryPlannerTest {
    private val job = RetryJob("hub:a->kakao", "x", "room", tries = 0, nextTs = 0L)

    @Test
    fun `cooling down waits the pacing window and consumes no try`() {
        val step = RetryPlanner.afterCooldown(job.copy(tries = 2), waitMs = 12_000L, nowMs = 1_000L)
        assertTrue(step is RetryStep.Requeue)
        step as RetryStep.Requeue
        assertEquals(2, step.job.tries)
        assertEquals(13_000L, step.job.nextTs)
        assertEquals("cooling-down", step.error)
    }

    @Test
    fun `a failure consumes a try and backs off tries x 60s`() {
        val first = RetryPlanner.afterFailure(job, "no-notification-for-room", maxRetry = 3, nowMs = 0L) as RetryStep.Requeue
        assertEquals(1, first.job.tries)
        assertEquals(60_000L, first.job.nextTs)
        val second = RetryPlanner.afterFailure(first.job, "x", maxRetry = 3, nowMs = 0L) as RetryStep.Requeue
        assertEquals(2, second.job.tries)
        assertEquals(120_000L, second.job.nextTs)
    }

    @Test
    fun `tries beyond maxRetry are exhausted`() {
        val step = RetryPlanner.afterFailure(job.copy(tries = 3), "x", maxRetry = 3, nowMs = 0L)
        assertEquals(RetryStep.Exhausted("hub:a->kakao"), step)
    }

    @Test
    fun `overflow names the oldest jobs to drop, never silently`() {
        val queue = (1..23).map { job.copy(messageId = "m$it", nextTs = it.toLong()) }
        val evicted = RetryPlanner.overflow(queue, max = 20)
        assertEquals(listOf("m1", "m2", "m3"), evicted.map { it.messageId })
        assertEquals(emptyList<RetryJob>(), RetryPlanner.overflow(queue.take(20), max = 20))
    }
}
