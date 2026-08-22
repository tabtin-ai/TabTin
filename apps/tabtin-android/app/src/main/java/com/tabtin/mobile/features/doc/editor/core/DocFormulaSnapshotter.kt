package com.tabtin.mobile.features.doc.editor.core

import android.content.Context
import android.graphics.drawable.Drawable
import android.widget.FrameLayout

/**
 * 行内公式出图入口。真正的 WebView 在 [DocFormulaPaintHost]，
 * 和块级一样挂在编辑器里。
 */
internal object DocFormulaSnapshotter {
    fun hostLayoutParams(width: Int, height: Int): FrameLayout.LayoutParams =
        FrameLayout.LayoutParams(width, height)

    fun request(
        context: Context,
        latex: String,
        displayMode: Boolean,
        fontSizePx: Float,
        textColor: Int,
        onDone: (Drawable?) -> Unit,
    ) {
        DocFormulaPaintHost.request(
            context = context,
            latex = latex,
            displayMode = displayMode,
            fontSizePx = fontSizePx,
            textColor = textColor,
            onDone = onDone,
        )
    }
}
