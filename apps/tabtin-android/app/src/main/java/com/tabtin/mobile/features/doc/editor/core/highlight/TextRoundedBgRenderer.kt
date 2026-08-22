package com.tabtin.mobile.features.doc.editor.core.highlight

import android.graphics.Canvas
import android.graphics.drawable.Drawable
import android.text.Layout
import com.tabtin.mobile.features.doc.editor.core.getLineBottomWithoutPadding
import com.tabtin.mobile.features.doc.editor.core.getLineTopWithoutPadding
import kotlin.math.max
import kotlin.math.min

/**
 * Derived from anytype-kotlin core-ui TextRoundedBgRenderer.
 * Base class for single/multi line rounded background renderers.
 */
internal abstract class TextRoundedBgRenderer(
    val horizontalPadding: Int,
    val verticalPadding: Int
) {
    abstract fun draw(
        canvas: Canvas,
        layout: Layout,
        startLine: Int,
        endLine: Int,
        startOffset: Int,
        endOffset: Int
    )

    protected fun getLineTop(layout: Layout, line: Int): Int {
        return layout.getLineTopWithoutPadding(line) - verticalPadding
    }

    protected fun getLineBottom(layout: Layout, line: Int): Int {
        return layout.getLineBottomWithoutPadding(line) + verticalPadding
    }
}

internal class SingleLineRenderer(
    horizontalPadding: Int,
    verticalPadding: Int,
    val drawable: Drawable
) : TextRoundedBgRenderer(horizontalPadding, verticalPadding) {

    override fun draw(
        canvas: Canvas,
        layout: Layout,
        startLine: Int,
        endLine: Int,
        startOffset: Int,
        endOffset: Int
    ) {
        val lineTop = getLineTop(layout, startLine)
        val lineBottom = getLineBottom(layout, startLine)
        val left = min(startOffset, endOffset)
        val right = max(startOffset, endOffset)
        drawable.setBounds(left, lineTop, right, lineBottom)
        drawable.draw(canvas)
    }
}

internal class MultiLineRenderer(
    horizontalPadding: Int,
    verticalPadding: Int,
    val drawableLeft: Drawable,
    val drawableMid: Drawable,
    val drawableRight: Drawable
) : TextRoundedBgRenderer(horizontalPadding, verticalPadding) {

    override fun draw(
        canvas: Canvas,
        layout: Layout,
        startLine: Int,
        endLine: Int,
        startOffset: Int,
        endOffset: Int
    ) {
        val paragDir = layout.getParagraphDirection(startLine)
        val lineEndOffset = if (paragDir == Layout.DIR_RIGHT_TO_LEFT) {
            layout.getLineLeft(startLine) - horizontalPadding
        } else {
            layout.getLineRight(startLine) + horizontalPadding
        }.toInt()

        var lineBottom = getLineBottom(layout, startLine)
        var lineTop = getLineTop(layout, startLine)
        drawStart(canvas, startOffset, lineTop, lineEndOffset, lineBottom)

        for (line in startLine + 1 until endLine) {
            lineTop = getLineTop(layout, line)
            lineBottom = getLineBottom(layout, line)
            drawableMid.setBounds(
                (layout.getLineLeft(line).toInt() - horizontalPadding),
                lineTop,
                (layout.getLineRight(line).toInt() + horizontalPadding),
                lineBottom
            )
            drawableMid.draw(canvas)
        }

        val lineStartOffset = if (paragDir == Layout.DIR_RIGHT_TO_LEFT) {
            layout.getLineRight(startLine) + horizontalPadding
        } else {
            layout.getLineLeft(startLine) - horizontalPadding
        }.toInt()

        lineBottom = getLineBottom(layout, endLine)
        lineTop = getLineTop(layout, endLine)
        drawEnd(canvas, lineStartOffset, lineTop, endOffset, lineBottom)
    }

    private fun drawStart(canvas: Canvas, start: Int, top: Int, end: Int, bottom: Int) {
        if (start > end) {
            drawableRight.setBounds(end, top, start, bottom)
            drawableRight.draw(canvas)
        } else {
            drawableLeft.setBounds(start, top, end, bottom)
            drawableLeft.draw(canvas)
        }
    }

    private fun drawEnd(canvas: Canvas, start: Int, top: Int, end: Int, bottom: Int) {
        if (start > end) {
            drawableLeft.setBounds(end, top, start, bottom)
            drawableLeft.draw(canvas)
        } else {
            drawableRight.setBounds(start, top, end, bottom)
            drawableRight.draw(canvas)
        }
    }
}
