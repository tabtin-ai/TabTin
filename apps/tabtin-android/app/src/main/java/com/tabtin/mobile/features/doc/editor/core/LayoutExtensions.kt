package com.tabtin.mobile.features.doc.editor.core

import android.os.Build
import android.text.Layout

/**
 * Derived from anytype-kotlin core-ui LayoutExtensions.
 * Layout extensions for precise line position calculation (padding/spacing aware).
 */

private const val DEFAULT_LINESPACING_EXTRA = 0f
private const val DEFAULT_LINESPACING_MULTIPLIER = 1f

public fun Layout.getLineBottomWithoutSpacing(line: Int): Int {
    val lineBottom = getLineBottom(line)
    val lastLineSpacingNotAdded = Build.VERSION.SDK_INT >= 19
    val isLastLine = line == lineCount - 1

    val lineSpacingExtra = spacingAdd
    val lineSpacingMultiplier = spacingMultiplier
    val hasLineSpacing = lineSpacingExtra != DEFAULT_LINESPACING_EXTRA
            || lineSpacingMultiplier != DEFAULT_LINESPACING_MULTIPLIER

    if (!hasLineSpacing || isLastLine && lastLineSpacingNotAdded) {
        return lineBottom
    }

    val extra: Float = if (lineSpacingMultiplier.compareTo(DEFAULT_LINESPACING_MULTIPLIER) != 0) {
        val lineHeight = getLineHeight(line)
        lineHeight - (lineHeight - lineSpacingExtra) / lineSpacingMultiplier
    } else {
        lineSpacingExtra
    }

    return (lineBottom - extra).toInt()
}

public fun Layout.getLineHeight(line: Int): Int {
    return getLineTop(line + 1) - getLineTop(line)
}

public fun Layout.getLineTopWithoutPadding(line: Int): Int {
    var lineTop = getLineTop(line)
    if (line == 0) {
        lineTop -= topPadding
    }
    return lineTop
}

public fun Layout.getLineBottomWithoutPadding(line: Int): Int {
    var lineBottom = getLineBottomWithoutSpacing(line)
    if (line == lineCount - 1) {
        lineBottom -= bottomPadding
    }
    return lineBottom
}
