package com.tabtin.mobile.features.workspace

import com.tabtin.mobile.data.model.UsageDashboardResponse
import org.junit.Assert.assertEquals
import org.junit.Test
import java.math.BigDecimal
import java.util.Locale

class UsagePresentationTest {
    @Test
    fun `usage credits follow Electron precision contract without Double conversion`() {
        assertEquals("0", formatUsageCredits(BigDecimal.ZERO, Locale.US))
        assertEquals("0.0049", formatUsageCredits(BigDecimal("0.0049"), Locale.US))
        assertEquals("0.40", formatUsageCredits(BigDecimal("0.4"), Locale.US))
        assertEquals("1,234.57", formatUsageCredits(BigDecimal("1234.567"), Locale.US))
    }

    @Test
    fun `dashboard preserves decimal precision from wire values`() {
        val response = UsageDashboardResponse(
            currentMonthTotalCreditsRaw = "12345678901234567890.0049",
        )

        assertEquals(BigDecimal("12345678901234567890.0049"), response.currentMonthTotal)
    }

    @Test
    fun `mobile model ranking uses full backend dashboard limit`() {
        assertEquals(20, USAGE_MODEL_RANK_LIMIT)
    }
}
