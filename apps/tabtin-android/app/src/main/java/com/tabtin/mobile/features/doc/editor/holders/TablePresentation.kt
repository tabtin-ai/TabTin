package com.tabtin.mobile.features.doc.editor.holders

import com.tabtin.mobile.features.doc.model.TableData
import kotlin.math.max

/**
 * TabDoc 表格的纯呈现策略。
 *
 * ViewHolder 只负责把结果换算为像素并渲染；列宽、提示、坐标与复制语义在这里
 * 与 iOS 保持同一份行为契约。
 */
internal object TablePresentation {
    internal const val MINIMUM_COLUMN_WIDTH = 120f
    internal const val ROW_HEADER_WIDTH = 36f
    internal const val COORDINATE_HEADER_HEIGHT = 32f

    /**
     * 共享列宽：先扣行号栏，再均分剩余视口，且不低于 120。
     *
     * available = max(viewportWidth - rowHeaderWidth, 0)
     * columnWidth = max(available / columnCount, 120)
     */
    fun columnWidth(
        viewportWidth: Float,
        columnCount: Int,
        rowHeaderWidth: Float = ROW_HEADER_WIDTH,
    ): Float {
        if (columnCount <= 0) return 0f
        val available = max(viewportWidth - rowHeaderWidth, 0f)
        return max(available / columnCount, MINIMUM_COLUMN_WIDTH)
    }

    fun toTsv(table: TableData): String = table.rows.joinToString("\n") { row ->
        row.cells.joinToString("\t") { cell -> cell.text }
    }

    fun spannedColumnWidth(
        columnWidth: Int,
        colspan: Int,
        dividerWidth: Int = 1,
    ): Int {
        val span = colspan.coerceAtLeast(1)
        return columnWidth * span + dividerWidth * (span - 1)
    }

    fun shouldShowHorizontalScrollHint(
        viewportWidth: Float,
        columnCount: Int,
        rowHeaderWidth: Float = ROW_HEADER_WIDTH,
    ): Boolean {
        if (viewportWidth <= 0f || columnCount <= 0) return false
        val minimumTableWidth = rowHeaderWidth + columnCount * MINIMUM_COLUMN_WIDTH
        return minimumTableWidth > viewportWidth
    }

    fun readOnlyCellCoordinate(rowIndex: Int, columnIndex: Int): Pair<Int, Int> =
        rowIndex + 1 to columnIndex + 1
}
