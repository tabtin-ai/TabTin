package com.tabtin.mobile.features.doc.editor.core

import android.graphics.Bitmap
import android.graphics.Color
import kotlin.math.max
import kotlin.math.min

/**
 * 离屏 WebView 常把公式画在一块大画布的左上角。行内附件必须裁到墨迹，
 * 否则会留下空白或只露出公式一角。全透明或裁切过小视为失败，调用方继续显示源码。
 */
internal object DocFormulaSnapshotCrop {
    private const val ALPHA_THRESHOLD = 12
    private const val PADDING_PX = 1
    private const val MIN_CROP_WIDTH_PX = 8
    private const val MIN_CROP_HEIGHT_PX = 8

    fun cropped(bitmap: Bitmap, alphaThreshold: Int = ALPHA_THRESHOLD): Bitmap? {
        val bounds = opaqueBounds(bitmap, alphaThreshold) ?: return null
        val width = bounds[2] - bounds[0] + 1
        val height = bounds[3] - bounds[1] + 1
        if (width < MIN_CROP_WIDTH_PX || height < MIN_CROP_HEIGHT_PX) return null
        return Bitmap.createBitmap(bitmap, bounds[0], bounds[1], width, height)
    }

    private fun opaqueBounds(bitmap: Bitmap, alphaThreshold: Int): IntArray? {
        val width = bitmap.width
        val height = bitmap.height
        if (width <= 0 || height <= 0) return null
        var minX = width
        var minY = height
        var maxX = -1
        var maxY = -1
        val row = IntArray(width)
        for (y in 0 until height) {
            bitmap.getPixels(row, 0, width, 0, y, width, 1)
            for (x in 0 until width) {
                if (Color.alpha(row[x]) > alphaThreshold) {
                    minX = min(minX, x)
                    minY = min(minY, y)
                    maxX = max(maxX, x)
                    maxY = max(maxY, y)
                }
            }
        }
        if (maxX < minX || maxY < minY) return null
        return intArrayOf(
            max(minX - PADDING_PX, 0),
            max(minY - PADDING_PX, 0),
            min(maxX + PADDING_PX, width - 1),
            min(maxY + PADDING_PX, height - 1),
        )
    }
}
