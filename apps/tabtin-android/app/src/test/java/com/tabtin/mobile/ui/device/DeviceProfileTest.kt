package com.tabtin.mobile.ui.device

import org.junit.Assert.assertEquals
import org.junit.Test

class DeviceProfileTest {

    @Test
    fun `phone remains portrait below tablet breakpoint`() {
        val metrics = StableDeviceMetrics(
            maximumWidthPx = 1178,
            maximumHeightPx = 2556,
            density = 2f,
        )

        assertEquals(MobileFormFactor.PHONE, resolveMobileFormFactor(metrics))
        assertEquals(
            MainActivityOrientationPolicy.PORTRAIT,
            resolveMainActivityOrientationPolicy(metrics),
        )
    }

    @Test
    fun `tablet follows user rotation at stable maximum-display breakpoint`() {
        val metrics = StableDeviceMetrics(
            maximumWidthPx = 1200,
            maximumHeightPx = 2000,
            density = 2f,
        )

        assertEquals(MobileFormFactor.TABLET, resolveMobileFormFactor(metrics))
        assertEquals(
            MainActivityOrientationPolicy.FOLLOW_USER,
            resolveMainActivityOrientationPolicy(metrics),
        )
    }

    @Test
    fun `tablet identity does not depend on a narrow split-screen window`() {
        val stableDisplay = StableDeviceMetrics(
            maximumWidthPx = 1800,
            maximumHeightPx = 2880,
            density = 2.5f,
        )

        // The current app window could be only 320dp wide; it is deliberately not an input here.
        assertEquals(720, stableDisplay.smallestMaximumWidthDp)
        assertEquals(MobileFormFactor.TABLET, resolveMobileFormFactor(stableDisplay))
    }
}
