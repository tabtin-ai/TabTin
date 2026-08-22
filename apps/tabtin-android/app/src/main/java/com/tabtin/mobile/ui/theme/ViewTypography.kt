package com.tabtin.mobile.ui.theme

import android.graphics.Typeface
import android.util.TypedValue
import android.view.View
import android.widget.TextView
import androidx.compose.ui.unit.Dp
import androidx.core.widget.TextViewCompat
import kotlin.math.roundToInt

/** Android View 对共享排版 token 的薄适配；业务 View 只选择语义角色。 */
public enum class TTViewFontWeight {
    REGULAR,
    SEMIBOLD,
    BOLD,
}

public fun TextView.applyTTTypography(
    role: TTFonts.Role,
    weight: TTViewFontWeight = TTViewFontWeight.REGULAR,
) {
    setTextSize(TypedValue.COMPLEX_UNIT_SP, role.size)
    val lineHeight = TypedValue.applyDimension(
        TypedValue.COMPLEX_UNIT_SP,
        role.lineHeight,
        resources.displayMetrics,
    ).roundToInt()
    TextViewCompat.setLineHeight(this, lineHeight)
    typeface = when (weight) {
        TTViewFontWeight.REGULAR -> Typeface.create(typeface, Typeface.NORMAL)
        TTViewFontWeight.SEMIBOLD -> Typeface.create("sans-serif-medium", Typeface.NORMAL)
        TTViewFontWeight.BOLD -> Typeface.create("sans-serif", Typeface.BOLD)
    }
}

public fun View.applyTTPadding(
    start: Dp,
    top: Dp,
    end: Dp,
    bottom: Dp,
) {
    val density = resources.displayMetrics.density
    setPaddingRelative(
        (start.value * density).roundToInt(),
        (top.value * density).roundToInt(),
        (end.value * density).roundToInt(),
        (bottom.value * density).roundToInt(),
    )
}
