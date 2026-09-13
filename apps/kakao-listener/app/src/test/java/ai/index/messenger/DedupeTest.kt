package ai.index.messenger

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

// Runs under `./gradlew test` on a JDK machine (no Android SDK needed for
// this pure-logic case). Not yet executed: this repo has no JVM here.
class DedupeTest {
    @Test
    fun `first sight delivers, second sight drops`() {
        val seen = mutableSetOf<String>()
        assertTrue(Dedupe.shouldDeliver(seen, "hub:a->kakao"))
        seen.add("hub:a->kakao")
        assertFalse(Dedupe.shouldDeliver(seen, "hub:a->kakao"))
    }

    @Test
    fun `different ids are independent`() {
        val seen = setOf("hub:a->kakao")
        assertTrue(Dedupe.shouldDeliver(seen, "hub:b->kakao"))
    }
}
