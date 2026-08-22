package com.tabtin.mobile.features.doc

import android.graphics.Rect
import android.view.TouchDelegate
import android.view.View

/**
 * Presentation decisions for the content-first document chrome.
 * SwiftUI / View wiring stays in the screens; these rules are shared with iOS tests.
 */
internal data class DocEditorMoreMenu(
    val showShareLink: Boolean,
    val showDirectMessage: Boolean,
    val showVersionHistory: Boolean,
    val showFullEditor: Boolean,
    val showSave: Boolean,
)

internal object DocPageChromePolicy {
    const val LIST_MARKER_VISUAL_COLUMN_DP = 24f

    /** Only actionable markers (task checkbox) claim this; bullets and numbers stay decorative. */
    const val LIST_MARKER_HIT_TARGET_DP = 48f

    fun showsInlineEditChrome(
        canEdit: Boolean,
        isFocused: Boolean,
        isSelected: Boolean,
    ): Boolean = canEdit && (isFocused || isSelected)

    fun showsSaveIndicator(state: SaveState): Boolean = state != SaveState.IDLE

    fun showsSaveRetry(state: SaveState): Boolean = state == SaveState.FAILED

    fun moreMenu(
        canShareLink: Boolean,
        canSendDirectMessage: Boolean,
        canOpenFullEditor: Boolean,
        canSave: Boolean,
    ): DocEditorMoreMenu = DocEditorMoreMenu(
        showShareLink = canShareLink,
        showDirectMessage = canSendDirectMessage,
        showVersionHistory = true,
        showFullEditor = canOpenFullEditor,
        showSave = canSave,
    )
}

internal fun View.expandListMarkerHitTarget() {
    val parent = parent as? View ?: return
    parent.post {
        val minPx = (
            DocPageChromePolicy.LIST_MARKER_HIT_TARGET_DP * resources.displayMetrics.density
            ).toInt()
        val rect = Rect()
        getHitRect(rect)
        val extraX = ((minPx - rect.width()) / 2).coerceAtLeast(0)
        val extraY = ((minPx - rect.height()) / 2).coerceAtLeast(0)
        if (extraX == 0 && extraY == 0) return@post
        rect.inset(-extraX, -extraY)
        parent.touchDelegate = TouchDelegate(rect, this)
    }
}
