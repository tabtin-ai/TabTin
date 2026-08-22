package com.tabtin.mobile.ui.components

import org.junit.Assert.assertEquals
import org.junit.Test

class BrandedPullToRefreshTest {
    @Test
    fun `refreshing phase keeps the indicator at the pull threshold position`() {
        val thresholdOffset = brandedRefreshIndicatorOffsetDp(
            isRefreshing = false,
            pullProgress = 1f,
        )
        val refreshingOffset = brandedRefreshIndicatorOffsetDp(
            isRefreshing = true,
            pullProgress = 1f,
        )

        assertEquals(thresholdOffset, refreshingOffset, 0f)
    }
}
