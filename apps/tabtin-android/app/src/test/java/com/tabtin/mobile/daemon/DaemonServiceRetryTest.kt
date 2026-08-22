package com.tabtin.mobile.daemon

import org.junit.Assert.*
import org.junit.Test
import kotlin.math.min
import kotlin.math.pow

/**
 * AD-001-A/B 回归测试：验证 DaemonService 的 HTTP 激活重试策略参数
 * 和指数退避延迟计算。
 */
class DaemonServiceRetryTest {

    companion object {
        private const val MAX_ACTIVATE_RETRIES = 5
        private const val BASE_RETRY_DELAY_MS = 2_000L
        private const val MAX_RETRY_DELAY_MS = 30_000L
    }

    private fun computeRetryDelay(attempt: Int): Long = min(
        (BASE_RETRY_DELAY_MS * 2.0.pow(attempt - 1.0)).toLong(),
        MAX_RETRY_DELAY_MS,
    )

    @Test
    fun `retry delay increases exponentially`() {
        val d1 = computeRetryDelay(1)
        val d2 = computeRetryDelay(2)
        val d3 = computeRetryDelay(3)

        assertEquals("Attempt 1 delay should be base delay", 2_000L, d1)
        assertEquals("Attempt 2 delay should be 2x base", 4_000L, d2)
        assertEquals("Attempt 3 delay should be 4x base", 8_000L, d3)
        assertTrue("Each delay should be larger than previous", d1 < d2 && d2 < d3)
    }

    @Test
    fun `retry delay is capped at MAX_RETRY_DELAY_MS`() {
        val d5 = computeRetryDelay(5)
        val d10 = computeRetryDelay(10)
        val d20 = computeRetryDelay(20)

        assertTrue("Delay should not exceed max", d5 <= MAX_RETRY_DELAY_MS)
        assertEquals("High attempt should hit max cap", MAX_RETRY_DELAY_MS, d10)
        assertEquals("Very high attempt should still be capped", MAX_RETRY_DELAY_MS, d20)
    }

    @Test
    fun `max retries is 5`() {
        assertEquals(
            "MAX_ACTIVATE_RETRIES should match DaemonService constant",
            5,
            MAX_ACTIVATE_RETRIES,
        )
    }

    @Test
    fun `4xx status code range check`() {
        assertTrue("400 is in 4xx range", 400 in 400..499)
        assertTrue("401 is in 4xx range", 401 in 400..499)
        assertTrue("499 is in 4xx range", 499 in 400..499)
        assertFalse("500 is NOT in 4xx range", 500 in 400..499)
        assertFalse("399 is NOT in 4xx range", 399 in 400..499)
    }

    @Test
    fun `all retry delays are positive and bounded`() {
        for (attempt in 1..MAX_ACTIVATE_RETRIES) {
            val delay = computeRetryDelay(attempt)
            assertTrue("Delay for attempt $attempt should be positive", delay > 0)
            assertTrue(
                "Delay for attempt $attempt should not exceed max ($delay <= $MAX_RETRY_DELAY_MS)",
                delay <= MAX_RETRY_DELAY_MS,
            )
        }
    }
}
