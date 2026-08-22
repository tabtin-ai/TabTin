package com.tabtin.mobile.ui.components

import android.view.View
import android.view.WindowManager
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.window.DialogWindowProvider

/** Ensures floating Compose dialogs resize with the IME instead of being panned behind it. */
@Suppress("DEPRECATION") // Floating dialog windows still need explicit resize behavior.
@Composable
internal fun EnableDialogImeResize() {
    val window = generateSequence(LocalView.current) { it.parent as? View }
        .filterIsInstance<DialogWindowProvider>()
        .firstOrNull()
        ?.window

    DisposableEffect(window) {
        if (window == null) {
            onDispose { }
        } else {
            val originalSoftInputMode = window.attributes.softInputMode
            val resizeSoftInputMode =
                (originalSoftInputMode and WindowManager.LayoutParams.SOFT_INPUT_MASK_ADJUST.inv()) or
                    WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE
            window.setSoftInputMode(resizeSoftInputMode)
            onDispose { window.setSoftInputMode(originalSoftInputMode) }
        }
    }
}
