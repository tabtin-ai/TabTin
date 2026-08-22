package com.tabtin.mobile.features.doc.editor.holders

import android.app.Application
import android.text.Layout
import android.view.Gravity
import android.view.ContextThemeWrapper
import android.view.LayoutInflater
import android.view.View
import android.widget.TableRow
import android.widget.TextView
import com.tabtin.mobile.R
import com.tabtin.mobile.databinding.DocBlockTableBinding
import com.tabtin.mobile.features.doc.editor.core.TabDocBlockView
import com.tabtin.mobile.features.doc.model.ProseMirrorParser
import com.tabtin.mobile.features.doc.model.TableCell
import com.tabtin.mobile.features.doc.model.TableData
import com.tabtin.mobile.features.doc.model.TableRow as DocTableRow
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.robolectric.shadows.ShadowPopupMenu

@RunWith(RobolectricTestRunner::class)
@Config(application = Application::class)
class TableHolderTest {

    private val context = ContextThemeWrapper(
        RuntimeEnvironment.getApplication(),
        R.style.Theme_TabTin,
    )

    @Test
    fun `read-only cells show the complete text without ellipsis or line cap`() {
        val binding = binding()
        val completeText = (1..8).joinToString("\n") { "第 $it 行完整内容" }
        val holder = TableHolder(binding)

        holder.setReadOnly(true)
        holder.bind(tableView(TableData(listOf(DocTableRow(listOf(TableCell(completeText)))))))

        val cell = firstCell(binding)
        assertEquals(completeText, cell.text.toString())
        assertEquals(Int.MAX_VALUE, cell.maxLines)
        assertNull(cell.ellipsize)
        assertTrue(cell.compoundDrawablesRelative.all { it == null })
    }

    @Test
    fun `editable cells keep all lines instead of limiting the saved value preview`() {
        val binding = binding()
        val completeText = (1..8).joinToString("\n") { "editable-$it" }
        val holder = TableHolder(binding)

        holder.bind(tableView(TableData(listOf(DocTableRow(listOf(TableCell(completeText)))))))

        val cell = firstCell(binding)
        assertEquals(completeText, cell.text.toString())
        assertEquals(Int.MAX_VALUE, cell.maxLines)
        assertNull(cell.ellipsize)
    }

    @Test
    fun `canonical table paragraph alignment renders and resets across holder reuse`() {
        val binding = binding()
        val holder = TableHolder(binding)

        fun bindAlignment(alignment: JsonElement?): TextView {
            holder.bind(tableView(tableDataWithParagraphAlignment(alignment)))
            return firstCell(binding)
        }

        val left = bindAlignment(JsonPrimitive("left"))
        assertEquals(Gravity.LEFT, left.gravity and Gravity.HORIZONTAL_GRAVITY_MASK)
        assertEquals(0, left.gravity and Gravity.RELATIVE_LAYOUT_DIRECTION)
        assertEquals(Layout.JUSTIFICATION_MODE_NONE, left.justificationMode)

        val center = bindAlignment(JsonPrimitive("center"))
        assertEquals(Gravity.CENTER_HORIZONTAL, center.gravity and Gravity.HORIZONTAL_GRAVITY_MASK)
        assertEquals(Layout.JUSTIFICATION_MODE_NONE, center.justificationMode)

        val right = bindAlignment(JsonPrimitive("right"))
        assertEquals(Gravity.RIGHT, right.gravity and Gravity.HORIZONTAL_GRAVITY_MASK)
        assertEquals(0, right.gravity and Gravity.RELATIVE_LAYOUT_DIRECTION)
        assertEquals(Layout.JUSTIFICATION_MODE_NONE, right.justificationMode)

        val justify = bindAlignment(JsonPrimitive("justify"))
        assertEquals(Layout.JUSTIFICATION_MODE_INTER_WORD, justify.justificationMode)

        val natural = bindAlignment(JsonNull)
        assertEquals(
            "null 对齐必须恢复自然起点，不能继承上一格的 justify/right",
            Gravity.START,
            natural.gravity and Gravity.RELATIVE_HORIZONTAL_GRAVITY_MASK,
        )
        assertEquals(Layout.JUSTIFICATION_MODE_NONE, natural.justificationMode)
    }

    @Test
    fun `noncanonical table paragraph attributes stay cell-local read only and serialize unchanged`() {
        val unsafeAttributes = listOf(
            buildJsonObject { put("textAlign", "start") },
            buildJsonObject { put("textAlign", 7) },
            buildJsonObject {
                put("textAlign", "center")
                put("future", "must-preserve")
            },
        )

        unsafeAttributes.forEach { attributes ->
            val source = tableDocument(attributes)
            val block = ProseMirrorParser.parseBlocks(source).single()
            val cell = requireNotNull(block.tableData).rows.single().cells.single()

            assertTrue("非法或额外 attrs 的格子必须逐格只读", cell.isReadOnlyProjection)
            assertEquals(
                "只读格子必须连同未知 attrs 原样写回",
                source,
                ProseMirrorParser.serializeBlocks(listOf(block)),
            )
        }
    }

    @Test
    fun `cells in one row share the tallest background height without clipping margins`() {
        val binding = binding()
        val holder = TableHolder(binding)
        holder.setReadOnly(true)
        holder.bind(
            tableView(
                TableData(
                    listOf(
                        DocTableRow(
                            listOf(
                                TableCell((1..8).joinToString("\n") { "long-$it" }),
                                TableCell("short"),
                            ),
                        ),
                    ),
                ),
            ),
        )

        val row = firstDataRow(binding)
        val cellWithBottomMargin = row.getChildAt(1)
        cellWithBottomMargin.layoutParams =
            (cellWithBottomMargin.layoutParams as TableRow.LayoutParams).apply {
                bottomMargin = 2
            }
        row.measure(unspecified(), unspecified())
        row.layout(0, 0, row.measuredWidth, row.measuredHeight)

        val backgroundHeight = row.getChildAt(0).height
        val requiredRowHeight = (0 until row.childCount).maxOf { index ->
            val child = row.getChildAt(index)
            val params = child.layoutParams as TableRow.LayoutParams
            child.height + params.topMargin + params.bottomMargin
        }
        assertEquals(
            "row height must include the largest top and bottom margin budget",
            requiredRowHeight,
            row.height,
        )
        for (index in 0 until row.childCount) {
            val child = row.getChildAt(index)
            val params = child.layoutParams as TableRow.LayoutParams
            assertEquals(
                "coordinate and data cell backgrounds must share the tallest height",
                backgroundHeight,
                child.height,
            )
            assertTrue(
                "cell background and margins must remain inside the row bounds",
                child.bottom + params.bottomMargin <= row.height,
            )
        }
    }

    @Test
    fun `bounded horizontal viewport keeps table cells visible`() {
        val binding = binding()
        val holder = TableHolder(binding)
        holder.setReadOnly(true)
        holder.bind(
            tableView(
                TableData(
                    listOf(
                        DocTableRow(listOf(TableCell("A"), TableCell("B"))),
                        DocTableRow(listOf(TableCell("C"), TableCell("D"))),
                    ),
                ),
            ),
        )

        binding.root.measure(
            View.MeasureSpec.makeMeasureSpec(1080, View.MeasureSpec.EXACTLY),
            View.MeasureSpec.makeMeasureSpec(1800, View.MeasureSpec.AT_MOST),
        )
        binding.root.layout(0, 0, binding.root.measuredWidth, binding.root.measuredHeight)

        val firstRow = firstDataRow(binding)
        val firstCell = firstRow.getChildAt(1)
        assertTrue(
            "row must have a visible height in a bounded viewport " +
                "(root=${binding.root.measuredHeight}, table=${binding.tableLayout.measuredHeight}, " +
                "row=${firstRow.measuredHeight}, cell=${firstCell.measuredHeight}, " +
                "cellWidth=${firstCell.layoutParams.width})",
            firstRow.measuredHeight > 0,
        )
        assertTrue(
            "cell must have a visible height in a bounded viewport",
            firstCell.measuredHeight > 0,
        )
        assertEquals("A", (firstCell as TextView).text.toString())
    }

    @Test
    fun `cell click keeps editable and structure permissions aligned with the safety model`() {
        val binding = binding()
        data class Click(val row: Int, val column: Int, val editable: Boolean, val canModify: Boolean)
        val clicks = mutableListOf<Click>()
        val holder = TableHolder(
            binding = binding,
            onCellClick = { _, row, column, _, editable, canModify ->
                clicks += Click(row, column, editable, canModify)
            },
        )
        holder.bind(
            tableView(
                TableData(
                    listOf(
                        DocTableRow(
                            listOf(
                                TableCell("editable"),
                                TableCell("projected", isReadOnlyProjection = true),
                            ),
                        ),
                    ),
                ),
            ),
        )

        firstCell(binding).performClick()
        firstDataRow(binding).getChildAt(2).performClick()
        holder.setReadOnly(true)
        firstCell(binding).performClick()

        assertEquals(
            listOf(
                Click(row = 0, column = 0, editable = true, canModify = true),
                Click(row = 0, column = 1, editable = false, canModify = true),
                Click(row = 0, column = 0, editable = false, canModify = false),
            ),
            clicks,
        )
    }

    @Test
    fun `read-only inspection keeps exact empty text and data coordinates behind headers`() {
        val binding = binding()
        data class Inspection(val row: Int, val column: Int, val text: String)
        var inspection: Inspection? = null
        val holder = TableHolder(
            binding = binding,
            onCellClick = { _, row, column, table, _, _ ->
                inspection = Inspection(row, column, table.rows[row].cells[column].text)
            },
        )
        holder.setReadOnly(true)
        holder.bind(
            tableView(
                TableData(
                    listOf(
                        DocTableRow(listOf(TableCell("A"), TableCell("B"))),
                        DocTableRow(listOf(TableCell("C"), TableCell(""))),
                    ),
                ),
            ),
        )

        val secondDataRow = binding.tableLayout.getChildAt(2) as TableRow
        secondDataRow.getChildAt(2).performClick()

        assertEquals(Inspection(row = 1, column = 1, text = ""), inspection)
        assertEquals(
            2 to 2,
            TablePresentation.readOnlyCellCoordinate(rowIndex = 1, columnIndex = 1),
        )
    }

    @Test
    fun `phone and tablet columns follow the shared width contract behind coordinate headers`() {
        val binding = binding()
        val holder = TableHolder(binding)
        holder.bind(
            tableView(
                TableData(
                    listOf(DocTableRow(listOf(TableCell("left"), TableCell("right")))),
                ),
            ),
        )

        layoutViewport(binding, widthDp = 320)
        assertEquals(dp(binding, 142f), firstCell(binding).layoutParams.width)
        assertEquals(dp(binding, 142f), firstColumnHeader(binding).layoutParams.width)
        assertEquals(View.GONE, binding.tableScrollHint.visibility)

        layoutViewport(binding, widthDp = 768)
        assertEquals(dp(binding, 366f), firstCell(binding).layoutParams.width)
        assertEquals(dp(binding, 366f), firstColumnHeader(binding).layoutParams.width)
        assertEquals(View.GONE, binding.tableScrollHint.visibility)

        holder.bind(
            tableView(
                TableData(
                    listOf(DocTableRow(listOf(TableCell("A"), TableCell("B"), TableCell("C")))),
                ),
            ),
        )
        layoutViewport(binding, widthDp = 320)
        assertEquals(dp(binding, 120f), firstCell(binding).layoutParams.width)
        assertEquals(View.VISIBLE, binding.tableScrollHint.visibility)
    }

    @Test
    fun `table body shares the recycler gutter instead of adding a second horizontal margin`() {
        val binding = binding()
        val params = binding.tableScroller.layoutParams as android.view.ViewGroup.MarginLayoutParams
        assertEquals(0, params.leftMargin)
        assertEquals(0, params.rightMargin)
        assertEquals(0, params.marginStart)
        assertEquals(0, params.marginEnd)
    }

    @Test
    fun `coordinate headers and data columns follow every viewport width change without rebuilding`() {
        val binding = binding()
        val holder = TableHolder(binding)
        holder.bind(
            tableView(
                TableData(
                    listOf(DocTableRow(listOf(TableCell("A"), TableCell("B"), TableCell("C")))),
                ),
            ),
        )

        layoutViewport(binding, widthDp = 320)
        val originalCell = firstCell(binding)
        val phoneCellWidth = firstCell(binding).layoutParams.width
        val phoneHeaderWidth = firstColumnHeader(binding).layoutParams.width
        assertEquals(phoneCellWidth, phoneHeaderWidth)
        assertEquals(View.VISIBLE, binding.tableScrollHint.visibility)
        layoutViewport(binding, widthDp = 768)
        val tabletCellWidth = firstCell(binding).layoutParams.width
        val tabletHeaderWidth = firstColumnHeader(binding).layoutParams.width

        assertTrue("tablet viewport must produce wider columns", tabletCellWidth > phoneCellWidth)
        assertEquals(tabletCellWidth, tabletHeaderWidth)
        assertSame("viewport resize must update the existing cell view", originalCell, firstCell(binding))
        assertEquals(View.GONE, binding.tableScrollHint.visibility)
    }

    @Test
    fun `model cell update refreshes copy source and survives viewport resize`() {
        val binding = binding()
        var copied: String? = null
        val holder = TableHolder(binding, onCopyTable = { copied = it })
        holder.bind(
            tableView(
                TableData(listOf(DocTableRow(listOf(TableCell("before"), TableCell("B"))))),
            ),
        )
        layoutViewport(binding, widthDp = 320)

        val updated = TableData(
            listOf(DocTableRow(listOf(TableCell("after"), TableCell("B")))),
        )
        holder.processPayload(
            tableView(updated),
            setOf(DocBlockDiffUtil.Payload.TEXT_CHANGED),
        )

        assertEquals("after", firstCell(binding).text.toString())
        layoutViewport(binding, widthDp = 768)
        assertEquals("after", firstCell(binding).text.toString())
        holder.setReadOnly(true)
        assertEquals("after", firstCell(binding).text.toString())

        binding.tableActionsButton.performClick()
        val popup = ShadowPopupMenu.getLatestPopupMenu()
        val copyAction = popup.menu.getItem(0)
        popup.menu.performIdentifierAction(copyAction.itemId, 0)

        assertEquals("after\tB", copied)
    }

    @Test
    fun `viewport listener is detached on recycle and restored on rebind`() {
        val binding = binding()
        val holder = TableHolder(binding)

        assertTrue(holder.isObservingViewport)
        holder.onRecycled()
        assertFalse(holder.isObservingViewport)

        holder.bind(tableView(TableData(listOf(DocTableRow(listOf(TableCell("reused")))))))
        assertTrue(holder.isObservingViewport)
    }

    private fun binding(): DocBlockTableBinding =
        DocBlockTableBinding.inflate(LayoutInflater.from(context))

    private fun tableView(data: TableData): TabDocBlockView.Table =
        TabDocBlockView.Table(id = "table", tableData = data)

    private fun tableDataWithParagraphAlignment(alignment: JsonElement?): TableData {
        val attributes = buildJsonObject {
            if (alignment != null) put("textAlign", alignment)
        }
        return requireNotNull(
            ProseMirrorParser.parseBlocks(tableDocument(attributes)).single().tableData,
        )
    }

    private fun tableDocument(paragraphAttributes: JsonElement) = buildJsonObject {
        put("type", "doc")
        put("content", buildJsonArray {
            add(buildJsonObject {
                put("type", "table")
                put("content", buildJsonArray {
                    add(buildJsonObject {
                        put("type", "tableRow")
                        put("content", buildJsonArray {
                            add(buildJsonObject {
                                put("type", "tableCell")
                                put("content", buildJsonArray {
                                    add(buildJsonObject {
                                        put("type", "paragraph")
                                        put("attrs", paragraphAttributes)
                                        put("content", buildJsonArray {
                                            add(buildJsonObject {
                                                put("type", "text")
                                                put("text", "aligned cell")
                                            })
                                        })
                                    })
                                })
                            })
                        })
                    })
                })
            })
        })
    }

    private fun firstCell(binding: DocBlockTableBinding): TextView =
        (firstDataRow(binding).getChildAt(1) as TextView)

    private fun firstColumnHeader(binding: DocBlockTableBinding): TextView =
        ((binding.tableLayout.getChildAt(0) as TableRow).getChildAt(1) as TextView)

    private fun firstDataRow(binding: DocBlockTableBinding): TableRow =
        binding.tableLayout.getChildAt(1) as TableRow

    private fun layoutViewport(binding: DocBlockTableBinding, widthDp: Int) {
        val widthPx = (widthDp * binding.root.resources.displayMetrics.density).toInt()
        binding.tableScroller.layout(0, 0, widthPx, 200)
    }

    private fun dp(binding: DocBlockTableBinding, value: Float): Int =
        (value * binding.root.resources.displayMetrics.density).toInt()

    private fun unspecified(): Int = View.MeasureSpec.makeMeasureSpec(0, View.MeasureSpec.UNSPECIFIED)
}
