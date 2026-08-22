package com.tabtin.mobile.ui.device

import kotlin.math.min

/** Android large-screen breakpoint, aligned with the platform's tablet resource qualifier. */
internal const val TABLET_SMALLEST_WIDTH_DP = 600

internal enum class MobileFormFactor(val wireValue: String) {
    PHONE("phone"),
    TABLET("tablet"),
}

internal enum class MainActivityOrientationPolicy {
    PORTRAIT,
    FOLLOW_USER,
}

/**
 * Stable maximum bounds of the device's current display, not the app's current split-screen window.
 */
internal data class StableDeviceMetrics(
    val maximumWidthPx: Int,
    val maximumHeightPx: Int,
    val density: Float,
) {
    val smallestMaximumWidthDp: Int
        get() {
            val safeDensity = density.takeIf { it.isFinite() && it > 0f } ?: 1f
            return (min(maximumWidthPx, maximumHeightPx) / safeDensity).toInt()
        }
}

internal fun resolveMobileFormFactor(metrics: StableDeviceMetrics): MobileFormFactor =
    if (metrics.smallestMaximumWidthDp >= TABLET_SMALLEST_WIDTH_DP) {
        MobileFormFactor.TABLET
    } else {
        MobileFormFactor.PHONE
    }

/** Phones stay portrait-first; tablets respect the user's current rotation. */
internal fun resolveMainActivityOrientationPolicy(
    metrics: StableDeviceMetrics,
): MainActivityOrientationPolicy = when (resolveMobileFormFactor(metrics)) {
    MobileFormFactor.PHONE -> MainActivityOrientationPolicy.PORTRAIT
    MobileFormFactor.TABLET -> MainActivityOrientationPolicy.FOLLOW_USER
}
