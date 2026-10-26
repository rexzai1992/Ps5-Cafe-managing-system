package com.ps5cafe.tvcompanion

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.random.Random

class RetryPolicyTest {

    @Test
    fun ceilingDoublesAndIsCapped() {
        assertEquals(2_000L, RetryPolicy.ceilingMs(1))
        assertEquals(4_000L, RetryPolicy.ceilingMs(2))
        assertEquals(32_000L, RetryPolicy.ceilingMs(5))
        assertEquals(60_000L, RetryPolicy.ceilingMs(6))
        assertEquals(60_000L, RetryPolicy.ceilingMs(1_000_000))
        assertEquals(2_000L, RetryPolicy.ceilingMs(0))
    }

    @Test
    fun delayStaysWithinHalfCeilingAndCeiling() {
        val random = Random(42)
        for (attempt in 1..50) {
            val ceiling = RetryPolicy.ceilingMs(attempt)
            repeat(200) {
                val d = RetryPolicy.delayMs(attempt, random)
                assertTrue("attempt $attempt delay $d", d in ceiling / 2..ceiling)
            }
        }
    }

    @Test
    fun jitterSpreadsTenTvsApart() {
        val random = Random(7)
        val delays = (1..10).map { RetryPolicy.delayMs(6, random) }.toSet()
        assertTrue("expected distinct delays, got $delays", delays.size >= 8)
    }
}
