package com.tabtin.mobile.features.doc.editor.core.highlight

import android.content.Context
import android.graphics.drawable.Drawable
import android.util.AttributeSet
import androidx.core.content.res.getDrawableOrThrow
import com.tabtin.mobile.R

/**
 * Derived from anytype-kotlin core-ui HighlightAttributeReader.
 * Reads custom XML attributes for highlight rendering configuration.
 */
public class HighlightAttributeReader(context: Context, attrs: AttributeSet?) {

    public val horizontalPadding: Int
    public val verticalPadding: Int
    public val drawable: Drawable
    public val drawableLeft: Drawable
    public val drawableMid: Drawable
    public val drawableRight: Drawable

    init {
        val typedArray = context.obtainStyledAttributes(
            attrs,
            R.styleable.HighlightDrawer,
            0,
            R.style.DocRoundedBgTextView
        )
        horizontalPadding = typedArray.getDimensionPixelSize(
            R.styleable.HighlightDrawer_roundedTextHorizontalPadding, 0
        )
        verticalPadding = typedArray.getDimensionPixelSize(
            R.styleable.HighlightDrawer_roundedTextVerticalPadding, 0
        )
        drawable = typedArray.getDrawableOrThrow(R.styleable.HighlightDrawer_roundedTextDrawable)
        drawableLeft = typedArray.getDrawableOrThrow(R.styleable.HighlightDrawer_roundedTextDrawableLeft)
        drawableMid = typedArray.getDrawableOrThrow(R.styleable.HighlightDrawer_roundedTextDrawableMid)
        drawableRight = typedArray.getDrawableOrThrow(R.styleable.HighlightDrawer_roundedTextDrawableRight)
        typedArray.recycle()
    }
}
