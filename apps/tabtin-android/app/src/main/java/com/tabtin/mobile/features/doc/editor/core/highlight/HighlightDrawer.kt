package com.tabtin.mobile.features.doc.editor.core.highlight

import android.content.res.Resources
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.drawable.Drawable
import android.text.Annotation
import android.text.Layout
import android.text.Spanned
import android.util.Log
import androidx.core.graphics.drawable.DrawableCompat
import com.tabtin.mobile.R
import com.tabtin.mobile.features.doc.editor.core.DocSpan

/**
 * Derived from anytype-kotlin core-ui HighlightDrawer.
 * Draws rounded background highlights for code (Keyboard) and color (Highlight) annotations.
 */
public class HighlightDrawer(
    public val horizontalPadding: Int,
    verticalPadding: Int,
    drawable: Drawable,
    drawableLeft: Drawable,
    public val drawableMid: Drawable,
    drawableRight: Drawable
) {

    private val defaultSingleLineRenderer: TextRoundedBgRenderer by lazy {
        SingleLineRenderer(horizontalPadding = 0, verticalPadding = verticalPadding, drawable = drawableMid)
    }

    private val defaultMultiLineRenderer: TextRoundedBgRenderer by lazy {
        MultiLineRenderer(horizontalPadding = 0, verticalPadding = verticalPadding, drawableLeft = drawableMid, drawableMid = drawableMid, drawableRight = drawableMid)
    }

    private val singleLineHighlightCodeRenderer: TextRoundedBgRenderer by lazy {
        SingleLineRenderer(horizontalPadding = horizontalPadding, verticalPadding = verticalPadding, drawable = drawable)
    }

    private val multiLineHighlightCodeRenderer: TextRoundedBgRenderer by lazy {
        MultiLineRenderer(horizontalPadding = horizontalPadding, verticalPadding = verticalPadding, drawableLeft = drawableLeft, drawableMid = drawableMid, drawableRight = drawableRight)
    }

    private fun isSpanPositionValid(spanStart: Int, spanEnd: Int, textLength: Int): Boolean {
        return spanStart >= 0 && spanEnd >= 0 && spanStart <= textLength && spanEnd <= textLength && spanStart <= spanEnd
    }

    public fun draw(canvas: Canvas, text: Spanned, layout: Layout, resources: Resources) {
        text.getSpans(0, text.length, Annotation::class.java).forEach { span ->
            when (span.key) {
                DocSpan.Keyboard.KEYBOARD_KEY -> drawCodeHighlight(span = span, text = text, layout = layout, canvas = canvas)
                DocSpan.Highlight.HIGHLIGHT_KEY -> drawBackgroundHighlight(span = span, text = text, layout = layout, canvas = canvas, resources = resources)
                else -> Log.w(TAG, "Unexpected annotation span: ${span.key}")
            }
        }
    }

    private fun drawBackgroundHighlight(
        span: Annotation, text: Spanned, layout: Layout, canvas: Canvas, resources: Resources
    ) {
        val fallback = resources.getColor(R.color.doc_editor_bg_primary, null)
        val tintColor = parseHighlightColor(span.value) ?: fallback
        DrawableCompat.wrap(drawableMid.mutate()).setTint(tintColor)

        val spanStart = text.getSpanStart(span)
        val spanEnd = text.getSpanEnd(span)
        if (!isSpanPositionValid(spanStart, spanEnd, text.length)) return

        val startLine = layout.getLineForOffset(spanStart)
        val endLine = layout.getLineForOffset(spanEnd)
        val startOffset = layout.getPrimaryHorizontal(spanStart).toInt()
        val endOffset = layout.getPrimaryHorizontal(spanEnd).toInt()

        if (startLine == endLine) {
            defaultSingleLineRenderer.draw(canvas, layout, startLine, endLine, startOffset, endOffset)
        } else {
            defaultMultiLineRenderer.draw(canvas, layout, startLine, endLine, startOffset, endOffset)
        }
    }

    private fun parseHighlightColor(value: String?): Int? {
        if (value.isNullOrBlank()) return null
        return try { Color.parseColor(value) } catch (_: IllegalArgumentException) { null }
    }

    private fun drawCodeHighlight(
        text: Spanned, span: Annotation, layout: Layout, canvas: Canvas
    ) {
        val spanStart = text.getSpanStart(span)
        val spanEnd = text.getSpanEnd(span)
        if (!isSpanPositionValid(spanStart, spanEnd, text.length)) return

        val startLine = layout.getLineForOffset(spanStart)
        val endLine = layout.getLineForOffset(spanEnd)
        val startOffset = (layout.getPrimaryHorizontal(spanStart) + -1 * layout.getParagraphDirection(startLine) * horizontalPadding).toInt()
        val endOffset = (layout.getPrimaryHorizontal(spanEnd) + layout.getParagraphDirection(endLine) * horizontalPadding).toInt()

        if (startLine == endLine) {
            singleLineHighlightCodeRenderer.draw(canvas, layout, startLine, endLine, startOffset, endOffset)
        } else {
            multiLineHighlightCodeRenderer.draw(canvas, layout, startLine, endLine, startOffset, endOffset)
        }
    }

    public companion object {
        private const val TAG = "HighlightDrawer"
    }
}
