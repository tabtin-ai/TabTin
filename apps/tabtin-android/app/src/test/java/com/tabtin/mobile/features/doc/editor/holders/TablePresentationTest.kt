package com.tabtin.mobile.features.doc.editor.holders

import com.tabtin.mobile.features.doc.model.TableCell
import com.tabtin.mobile.features.doc.model.TableData
import com.tabtin.mobile.features.doc.model.TableRow
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class TablePresentationTest {

    @Test
    fun `column width uses viewport after reserving the coordinate header`() {
        // 与 iOS NativeTabDocTableColumnWidthPolicy 共用同一组输入与预期：
        // available = max(viewport - rowHeader, 0); column = max(available / n, 120)
        assertEquals(
            142f,
            TablePresentation.columnWidth(viewportWidth = 320f, columnCount = 2),
            0f,
        )
        assertEquals(
            366f,
            TablePresentation.columnWidth(viewportWidth = 768f, columnCount = 2),
            0f,
        )
        assertEquals(
            120f,
            TablePresentation.columnWidth(viewportWidth = 320f, columnCount = 3),
            0f,
        )
        assertEquals(
            0f,
            TablePresentation.columnWidth(viewportWidth = 320f, columnCount = 0),
            0f,
        )
        assertEquals(
            120f,
            TablePresentation.columnWidth(viewportWidth = 0f, columnCount = 2),
            0f,
        )
    }

    @Test
    fun `tsv export preserves cell text including leading trailing and empty whitespace`() {
        val table = TableData(
            rows = listOf(
                TableRow(listOf(TableCell(" name "), TableCell(""))),
                TableRow(listOf(TableCell("  kept  "), TableCell("tail "))),
            ),
        )

        assertEquals(" name \t\n  kept  \ttail ", TablePresentation.toTsv(table))
    }

    @Test
    fun `spanned cell width includes the dividers between covered columns`() {
        assertEquals(136, TablePresentation.spannedColumnWidth(columnWidth = 136, colspan = 1))
        assertEquals(273, TablePresentation.spannedColumnWidth(columnWidth = 136, colspan = 2))
        assertEquals(410, TablePresentation.spannedColumnWidth(columnWidth = 136, colspan = 3))
    }

    @Test
    fun `horizontal scrolling hint follows minimum table width instead of column count alone`() {
        // 2 列最小总宽 = 36 + 120 * 2 = 276；3 列 = 36 + 360 = 396
        assertFalse(
            TablePresentation.shouldShowHorizontalScrollHint(
                viewportWidth = 320f,
                columnCount = 2,
            ),
        )
        assertTrue(
            TablePresentation.shouldShowHorizontalScrollHint(
                viewportWidth = 275f,
                columnCount = 2,
            ),
        )
        assertFalse(
            TablePresentation.shouldShowHorizontalScrollHint(
                viewportWidth = 276f,
                columnCount = 2,
            ),
        )
        assertTrue(
            TablePresentation.shouldShowHorizontalScrollHint(
                viewportWidth = 320f,
                columnCount = 3,
            ),
        )
        assertFalse(
            TablePresentation.shouldShowHorizontalScrollHint(
                viewportWidth = 0f,
                columnCount = 3,
            ),
        )
    }

    @Test
    fun `readonly cell coordinates use one based row and column values`() {
        assertEquals(1 to 1, TablePresentation.readOnlyCellCoordinate(rowIndex = 0, columnIndex = 0))
        assertEquals(2 to 3, TablePresentation.readOnlyCellCoordinate(rowIndex = 1, columnIndex = 2))
    }
}
