package com.tabtin.mobile.features.doc.editor.holders

import android.content.Context
import android.graphics.Color
import android.graphics.Typeface
import android.text.Layout
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.TableLayout
import android.widget.TableRow
import android.widget.TextView
import android.widget.PopupMenu
import androidx.core.widget.TextViewCompat
import com.tabtin.mobile.R
import com.tabtin.mobile.databinding.DocBlockTableBinding
import com.tabtin.mobile.features.doc.editor.TableProjectionLocalization
import com.tabtin.mobile.features.doc.editor.core.BlockViewConverter
import com.tabtin.mobile.features.doc.editor.core.TabDocBlockView
import com.tabtin.mobile.features.doc.editor.core.TabDocMarkup
import com.tabtin.mobile.features.doc.editor.core.toSpannable
import com.tabtin.mobile.features.doc.model.DocTextAlignment
import com.tabtin.mobile.features.doc.model.TableData
import com.tabtin.mobile.ui.theme.TTFonts
import com.tabtin.mobile.ui.theme.TTSpacing
import kotlin.math.roundToInt

public class TableHolder(
    private val binding: DocBlockTableBinding,
    private val onBlockLongPress: (id: String) -> Unit = {},
    private val onCellClick: (
        blockId: String,
        row: Int,
        col: Int,
        tableData: TableData,
        isEditable: Boolean,
        canModifyStructure: Boolean,
    ) -> Unit = { _, _, _, _, _, _ -> },
    private val onCopyTable: (text: String) -> Unit = {},
    private val onAddTableRow: (blockId: String, afterRow: Int?) -> Unit = { _, _ -> },
    private val onAddTableColumn: (blockId: String, afterColumn: Int?) -> Unit = { _, _ -> },
    private val isSelectionModeProvider: () -> Boolean = { false },
) : DocBlockViewHolder(binding.root) {

    private var blockId: String = ""
    private var currentData: TableData = TableData()
    private var isReadOnly = false
    private var lastViewportWidth = 0
    private val viewportLayoutListener = View.OnLayoutChangeListener {
        _, left, _, right, _, oldLeft, _, oldRight, _ ->
        val width = right - left
        val oldWidth = oldRight - oldLeft
        if (width > 0 && width != oldWidth && width != lastViewportWidth && !currentData.isEmpty) {
            applyColumnWidths(currentData, width)
        }
    }

    internal var isObservingViewport: Boolean = false
        private set

    init {
        binding.root.setOnLongClickListener {
            onBlockLongPress(blockId)
            true
        }
        observeViewport()
    }

    override fun bind(item: TabDocBlockView) {
        val table = item as? TabDocBlockView.Table ?: return
        observeViewport()
        blockId = table.id
        currentData = table.tableData
        applySelectionState(table.isSelected)
        renderTable(currentData)
    }

    override fun processPayload(item: TabDocBlockView, payloads: Set<Int>) {
        if (item !is TabDocBlockView.Table) { bind(item); return }
        blockId = item.id
        if (DocBlockDiffUtil.Payload.SELECTION_CHANGED in payloads) {
            applySelectionState(item.isSelected)
            renderTable(currentData)
        }
        if (DocBlockDiffUtil.Payload.TEXT_CHANGED in payloads) {
            currentData = item.tableData
            renderTable(currentData)
        }
    }

    override fun onRecycled() {
        stopObservingViewport()
        binding.tableLayout.removeAllViews()
        binding.tableActionsButton.setOnClickListener(null)
        currentData = TableData()
        blockId = ""
        lastViewportWidth = 0
    }

    private fun renderTable(data: TableData) {
        val tableLayout = binding.tableLayout
        tableLayout.removeAllViews()
        val viewportWidth = resolveViewportWidth()
        val viewportWidthDp = pxToDp(viewportWidth)
        configureTableChrome(data, viewportWidthDp)

        if (data.isEmpty) return

        val ctx = tableLayout.context
        val cellPadH = dpToPx(TTSpacing.sm.value)
        val cellPadV = dpToPx(TTSpacing.sm.value)
        val cellWidth = dpToPx(
            TablePresentation.columnWidth(
                viewportWidth = viewportWidthDp,
                columnCount = data.columnCount,
            ),
        )
        val rowHeaderWidth = dpToPx(TablePresentation.ROW_HEADER_WIDTH)
        val coordinateHeaderHeight = dpToPx(TablePresentation.COORDINATE_HEADER_HEIGHT)
        val minimumCellHeight = dpToPx(TTSpacing.huge.value)
        val borderColor = resolveBorderColor()
        val surfaceColor = resolveSurfaceColor()
        val headerBgColor = resolveHeaderBgColor()
        val inSelection = isSelectionModeProvider()

        val coordinateRow = TableRow(ctx).apply {
            isBaselineAligned = false
            addView(
                coordinateCell("", rowHeaderWidth, coordinateHeaderHeight, headerBgColor),
                TableRow.LayoutParams(rowHeaderWidth, coordinateHeaderHeight),
            )
            repeat(data.columnCount) { columnIndex ->
                addView(
                    coordinateCell(
                        columnLabel(columnIndex),
                        cellWidth,
                        coordinateHeaderHeight,
                        headerBgColor,
                    ),
                    TableRow.LayoutParams(cellWidth, coordinateHeaderHeight).apply {
                        marginStart = TABLE_DIVIDER_WIDTH_PX
                    },
                )
            }
        }
        tableLayout.addView(coordinateRow)

        for ((rowIndex, row) in data.rows.withIndex()) {
            val tr = EqualHeightTableRow(ctx).apply {
                isBaselineAligned = false
                gravity = Gravity.TOP
            }
            tr.addView(
                coordinateCell(
                    (rowIndex + 1).toString(),
                    rowHeaderWidth,
                    minimumCellHeight,
                    headerBgColor,
                ),
                TableRow.LayoutParams(rowHeaderWidth, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
                    topMargin = 1
                },
            )
            for ((colIndex, cell) in row.cells.withIndex()) {
                val localizedText = TableProjectionLocalization.cellText(ctx, cell)
                val displayText = localizedText.ifEmpty {
                    ctx.getString(R.string.doc_table_cell_empty)
                }
                val visualWidth = TablePresentation.spannedColumnWidth(
                    columnWidth = cellWidth,
                    colspan = cell.colspan,
                    dividerWidth = TABLE_DIVIDER_WIDTH_PX,
                )
                val cellIsReadOnly = isReadOnly || cell.isReadOnlyProjection
                val cellView = TextView(ctx).apply {
                    val primaryColor = resolveTextPrimaryColor()
                    // 可编辑且带 marks 的格用 Spannable，网格里才能看见加粗。
                    text = if (!cellIsReadOnly && localizedText.isNotEmpty() &&
                        cell.spans.any { it.marks.isNotEmpty() }
                    ) {
                        val markup = object : TabDocMarkup {
                            override val body = localizedText
                            override val marks = BlockViewConverter.spansToMarks(
                                localizedText,
                                cell.spans,
                            )
                        }
                        markup.toSpannable(textColor = primaryColor)
                    } else {
                        displayText
                    }
                    isClickable = !inSelection
                    isFocusable = !inSelection
                    setTextColor(
                        if (localizedText.isEmpty()) resolveTextTertiaryColor()
                        else primaryColor,
                    )
                    contentDescription = ctx.getString(
                        R.string.doc_table_cell_a11y,
                        rowIndex + 1,
                        colIndex + 1,
                        displayText,
                    ) + ", " + ctx.getString(
                        if (cellIsReadOnly) R.string.doc_table_cell_complex_read_only
                        else R.string.doc_table_cell_editable,
                    )
                    if (!inSelection) {
                        setOnClickListener {
                            onCellClick(
                                blockId,
                                rowIndex,
                                colIndex,
                                data,
                                !cellIsReadOnly,
                                !isReadOnly,
                            )
                        }
                    }
                    setTextSize(TypedValue.COMPLEX_UNIT_SP, TTFonts.Role.BODY.size)
                    TextViewCompat.setLineHeight(this, spToPx(TTFonts.Role.BODY.lineHeight))
                    setPadding(cellPadH, cellPadV, cellPadH, cellPadV)
                    minWidth = visualWidth
                    maxWidth = visualWidth
                    minHeight = minimumCellHeight
                    applyTextAlignment(cell.alignment)
                    maxLines = Int.MAX_VALUE
                    ellipsize = null

                    setBackgroundColor(
                        if (cell.isHeader || cellIsReadOnly) headerBgColor else surfaceColor,
                    )
                    if (cell.isHeader) setTypeface(typeface, Typeface.BOLD)
                }

                val lp = TableRow.LayoutParams(
                    visualWidth,
                    ViewGroup.LayoutParams.WRAP_CONTENT,
                ).apply {
                    if (cell.colspan > 1) span = cell.colspan
                    marginStart = TABLE_DIVIDER_WIDTH_PX
                    topMargin = 1
                }

                tr.addView(cellView, lp)
            }
            tableLayout.addView(tr)
        }

        tableLayout.setBackgroundColor(borderColor)
    }

    /**
     * TableRow 本身是 wrap_content 时，子项使用 MATCH_PARENT 会在真机的有界
     * HorizontalScrollView 测量中形成循环高度并坍缩。先让每格自然测量，再把同一行
     * 的格子统一重测为最高格高度，既保留完整内容，也让背景与边框同行等高。
     */
    private class EqualHeightTableRow(context: Context) : TableRow(context) {
        override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
            super.onMeasure(widthMeasureSpec, heightMeasureSpec)
            val tallestCellHeight = (0 until childCount)
                .maxOfOrNull { getChildAt(it).measuredHeight }
                ?: return
            if (tallestCellHeight <= 0) return

            var requiredRowHeight = tallestCellHeight
            for (index in 0 until childCount) {
                val child = getChildAt(index)
                if (child.visibility == View.GONE) continue
                val margins = child.layoutParams as? ViewGroup.MarginLayoutParams
                child.measure(
                    View.MeasureSpec.makeMeasureSpec(child.measuredWidth, View.MeasureSpec.EXACTLY),
                    View.MeasureSpec.makeMeasureSpec(tallestCellHeight, View.MeasureSpec.EXACTLY),
                )
                requiredRowHeight = maxOf(
                    requiredRowHeight,
                    tallestCellHeight + (margins?.topMargin ?: 0) +
                        (margins?.bottomMargin ?: 0),
                )
            }
            setMeasuredDimension(measuredWidth, maxOf(measuredHeight, requiredRowHeight))
        }
    }

    private fun configureTableChrome(data: TableData, viewportWidth: Float) {
        val context = binding.root.context
        binding.tableMeta.apply {
            text = if (isReadOnly) {
                context.getString(
                    R.string.doc_table_summary_read_only,
                    data.rowCount,
                    data.columnCount,
                )
            } else if (data.hasProjectedCells) {
                context.getString(
                    R.string.doc_table_summary_projected,
                    data.rowCount,
                    data.columnCount,
                    data.projectedCellCount,
                )
            } else {
                context.getString(R.string.doc_table_summary, data.rowCount, data.columnCount)
            }
            setTextSize(TypedValue.COMPLEX_UNIT_SP, TTFonts.Role.META.size)
            setTextColor(resolveTextSecondaryColor())
        }
        binding.tableScrollHint.apply {
            visibility = if (
                TablePresentation.shouldShowHorizontalScrollHint(
                    viewportWidth = viewportWidth,
                    columnCount = data.columnCount,
                )
            ) {
                View.VISIBLE
            } else {
                View.GONE
            }
            setTextSize(TypedValue.COMPLEX_UNIT_SP, TTFonts.Role.CAPTION.size)
            setTextColor(resolveTextTertiaryColor())
        }
        binding.tableActionsButton.apply {
            visibility = if (data.isEmpty || isSelectionModeProvider()) View.GONE else View.VISIBLE
            setTextSize(TypedValue.COMPLEX_UNIT_SP, TTFonts.Role.BODY.size)
            setTextColor(resolveAccentColor())
            setOnClickListener { showTableActions(this, data) }
        }
    }

    private fun showTableActions(anchor: View, data: TableData) {
        val popup = PopupMenu(anchor.context, anchor)
        popup.menu.add(0, ACTION_COPY_TABLE, 0, R.string.doc_table_copy)
        val canModify = !isReadOnly && !isSelectionModeProvider()
        if (canModify) {
            popup.menu.add(0, ACTION_ADD_ROW, 1, R.string.doc_table_add_row).isEnabled = data.canAddRow
            popup.menu.add(0, ACTION_ADD_COLUMN, 2, R.string.doc_table_add_column).isEnabled =
                data.canAddColumn
        }
        popup.setOnMenuItemClickListener { item ->
            when (item.itemId) {
                ACTION_COPY_TABLE -> onCopyTable(
                    TableProjectionLocalization.tableText(anchor.context, data),
                )
                ACTION_ADD_ROW -> onAddTableRow(blockId, null)
                ACTION_ADD_COLUMN -> onAddTableColumn(blockId, null)
                else -> return@setOnMenuItemClickListener false
            }
            true
        }
        popup.show()
    }

    private fun applyColumnWidths(data: TableData, viewportWidth: Int) {
        lastViewportWidth = viewportWidth
        configureTableChrome(data, pxToDp(viewportWidth))
        val cellWidth = dpToPx(
            TablePresentation.columnWidth(
                viewportWidth = pxToDp(viewportWidth),
                columnCount = data.columnCount,
            ),
        )

        val coordinateHeader = binding.tableLayout.getChildAt(0) as? TableRow
        for (columnIndex in 0 until data.columnCount) {
            updateCellWidth(coordinateHeader?.getChildAt(columnIndex + 1), cellWidth)
        }
        coordinateHeader?.requestLayout()

        for ((rowIndex, rowData) in data.rows.withIndex()) {
            val row = binding.tableLayout.getChildAt(rowIndex + 1) as? TableRow ?: continue
            for ((columnIndex, cellData) in rowData.cells.withIndex()) {
                val visualWidth = TablePresentation.spannedColumnWidth(
                    columnWidth = cellWidth,
                    colspan = cellData.colspan,
                    dividerWidth = TABLE_DIVIDER_WIDTH_PX,
                )
                updateCellWidth(row.getChildAt(columnIndex + 1), visualWidth)
            }
            row.requestLayout()
        }
        binding.tableLayout.requestLayout()
    }

    private fun updateCellWidth(view: View?, width: Int) {
        val cell = view as? TextView ?: return
        cell.minWidth = width
        cell.maxWidth = width
        (cell.layoutParams as? TableRow.LayoutParams)?.let { params ->
            params.width = width
            cell.layoutParams = params
        }
    }

    private fun coordinateCell(
        text: String,
        width: Int,
        height: Int,
        backgroundColor: Int,
    ): TextView = TextView(binding.root.context).apply {
        this.text = text
        gravity = Gravity.CENTER
        minWidth = width
        maxWidth = width
        minHeight = height
        maxLines = 1
        setTextSize(TypedValue.COMPLEX_UNIT_SP, TTFonts.Role.CAPTION.size)
        setTextColor(resolveTextTertiaryColor())
        setBackgroundColor(backgroundColor)
        importantForAccessibility = if (text.isEmpty()) {
            View.IMPORTANT_FOR_ACCESSIBILITY_NO
        } else {
            View.IMPORTANT_FOR_ACCESSIBILITY_YES
        }
    }

    private fun columnLabel(index: Int): String = ('A'.code + index).toChar().toString()

    private fun TextView.applyTextAlignment(alignment: DocTextAlignment?) {
        justificationMode = Layout.JUSTIFICATION_MODE_NONE
        gravity = Gravity.TOP or when (alignment) {
            DocTextAlignment.LEFT -> Gravity.LEFT
            DocTextAlignment.CENTER -> Gravity.CENTER_HORIZONTAL
            DocTextAlignment.RIGHT -> Gravity.RIGHT
            DocTextAlignment.JUSTIFY, null -> Gravity.START
        }
        if (alignment == DocTextAlignment.JUSTIFY) {
            justificationMode = Layout.JUSTIFICATION_MODE_INTER_WORD
        }
    }

    override fun setReadOnly(readOnly: Boolean) {
        if (isReadOnly == readOnly) return
        isReadOnly = readOnly
        renderTable(currentData)
    }

    private fun resolveViewportWidth(): Int {
        val measuredWidth = binding.tableScroller.width.takeIf { it > 0 }
            ?: binding.root.width.takeIf { it > 0 }
            ?: binding.root.resources.displayMetrics.widthPixels
        return measuredWidth.coerceAtLeast(0).also { lastViewportWidth = it }
    }

    private fun observeViewport() {
        if (isObservingViewport) return
        binding.tableScroller.addOnLayoutChangeListener(viewportLayoutListener)
        isObservingViewport = true
    }

    private fun stopObservingViewport() {
        if (!isObservingViewport) return
        binding.tableScroller.removeOnLayoutChangeListener(viewportLayoutListener)
        isObservingViewport = false
    }

    private fun dpToPx(dp: Float): Int =
        (dp * binding.root.resources.displayMetrics.density).roundToInt()

    private fun pxToDp(px: Int): Float = px / binding.root.resources.displayMetrics.density

    private fun spToPx(sp: Float): Int = TypedValue.applyDimension(
        TypedValue.COMPLEX_UNIT_SP,
        sp,
        binding.root.resources.displayMetrics,
    ).toInt()

    private fun resolveBorderColor(): Int {
        return resolveThemeColor(android.R.attr.textColorHint, Color.parseColor("#E0E0E0"))
            .let { Color.argb(60, Color.red(it), Color.green(it), Color.blue(it)) }
    }

    private fun resolveSurfaceColor(): Int {
        return resolveThemeColor(android.R.attr.colorBackground, Color.WHITE)
    }

    private fun resolveTextPrimaryColor(): Int =
        resolveThemeColor(android.R.attr.textColorPrimary, Color.BLACK)

    private fun resolveTextSecondaryColor(): Int =
        resolveThemeColor(android.R.attr.textColorSecondary, Color.DKGRAY)

    private fun resolveTextTertiaryColor(): Int =
        resolveThemeColor(android.R.attr.textColorHint, Color.GRAY)

    private fun resolveAccentColor(): Int =
        resolveThemeColor(android.R.attr.colorAccent, Color.rgb(235, 119, 23))

    private fun resolveHeaderBgColor(): Int {
        val bg = resolveSurfaceColor()
        val hint = resolveThemeColor(android.R.attr.textColorHint, Color.GRAY)
        return Color.argb(20, Color.red(hint), Color.green(hint), Color.blue(hint))
            .let { overlay ->
                blendColors(bg, overlay)
            }
    }

    private fun resolveThemeColor(attr: Int, fallback: Int): Int {
        val tv = TypedValue()
        val theme = binding.root.context.theme
        return if (theme.resolveAttribute(attr, tv, true)) {
            try { binding.root.context.getColor(tv.resourceId) } catch (_: Exception) { fallback }
        } else fallback
    }

    private fun blendColors(base: Int, overlay: Int): Int {
        val a = Color.alpha(overlay) / 255f
        return Color.rgb(
            (Color.red(base) * (1 - a) + Color.red(overlay) * a).toInt(),
            (Color.green(base) * (1 - a) + Color.green(overlay) * a).toInt(),
            (Color.blue(base) * (1 - a) + Color.blue(overlay) * a).toInt(),
        )
    }
    private companion object {
        const val TABLE_DIVIDER_WIDTH_PX: Int = 1
        const val ACTION_COPY_TABLE: Int = 1
        const val ACTION_ADD_ROW: Int = 2
        const val ACTION_ADD_COLUMN: Int = 3
    }
}
