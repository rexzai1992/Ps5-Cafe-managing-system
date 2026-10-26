package com.ps5cafe.tvcompanion

import kotlin.random.Random

/**
 * Capped exponential backoff with "equal jitter" for reloading the screen page.
 *
 * Attempt n waits a random time in [ceiling / 2, ceiling], where ceiling = min(CAP, BASE * 2^(n-1)).
 * Half of the delay is fixed (never a tight loop), half is random (ten TVs that lose the server at
 * the same moment do not all reconnect in the same second).
 */
object RetryPolicy {
    const val BASE_MS = 2_000L
    const val CAP_MS = 60_000L

    fun ceilingMs(attempt: Int): Long {
        val exponent = (attempt - 1).coerceIn(0, 20)
        return minOf(CAP_MS, BASE_MS shl exponent)
    }

    fun delayMs(attempt: Int, random: Random): Long {
        val ceiling = ceilingMs(attempt)
        val floor = ceiling / 2
        return random.nextLong(floor, ceiling + 1)
    }
}
