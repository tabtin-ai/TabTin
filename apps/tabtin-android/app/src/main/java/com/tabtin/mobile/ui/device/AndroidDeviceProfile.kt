package com.tabtin.mobile.ui.device

import android.content.Context
import android.os.Build
import android.util.DisplayMetrics
import android.view.WindowManager

/**
 * Reads maximum display bounds so Android Pad remains a tablet in split-screen or a floating window.
 */
internal fun Context.stableDeviceMetrics(): StableDeviceMetrics {
    val windowManager = getSystemService(WindowManager::class.java)
    val bounds = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
        windowManager.maximumWindowMetrics.bounds
    } else {
        @Suppress("DEPRECATION")
        val metrics = DisplayMetrics().also(windowManager.defaultDisplay::getRealMetrics)
        android.graphics.Rect(0, 0, metrics.widthPixels, metrics.heightPixels)
    }
    return StableDeviceMetrics(
        maximumWidthPx = bounds.width(),
        maximumHeightPx = bounds.height(),
        density = resources.displayMetrics.density,
    )
}

internal fun Context.stableMobileFormFactor(): MobileFormFactor =
    resolveMobileFormFactor(stableDeviceMetrics())
