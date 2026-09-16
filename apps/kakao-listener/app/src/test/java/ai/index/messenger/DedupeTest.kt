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
    fun `native id is stable across notification re-posts and distinct per message`() {
        val a = Dedupe.nativeId("0|com.kakao.talk|2|room|10378", 1_000L, "김뚱", "hey")
        val again = Dedupe.nativeId("0|com.kakao.talk|2|room|10378", 1_000L, "김뚱", "hey")
        assertTrue(a == again)
        val sameTextLater = Dedupe.nativeId("0|com.kakao.talk|2|room|10378", 2_000L, "김뚱", "hey")
        assertFalse(a == sameTextLater)
        val otherText = Dedupe.nativeId("0|com.kakao.talk|2|room|10378", 1_000L, "김뚱", "hey man")
        assertFalse(a == otherText)
    }

    @Test
    fun `history at or before the floor is not fresh`() {
        assertFalse(Dedupe.fresh(1_000L, 1_000L))
        assertFalse(Dedupe.fresh(999L, 1_000L))
        assertTrue(Dedupe.fresh(1_001L, 1_000L))
        assertTrue(Dedupe.fresh(1L, 0L))
    }

    @Test
    fun `different ids are independent`() {
        val seen = setOf("hub:a->kakao")
        assertTrue(Dedupe.shouldDeliver(seen, "hub:b->kakao"))
    }
}
