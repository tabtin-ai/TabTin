package com.tabtin.mobile.features.tabdata

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * 与 iOS `NativeTabDataNumberFormatPolicy`、Web `formatPercentCellValue` 同一组输入与期望。
 *
 * Web 依据：
 * - packages/table-ui/src/controller/cellValueUtils.ts:65
 * - apps/tabtin-web/src/components/table/mobile/mobileTablePrimitives.ts:127
 * 算法：`(ratio * 100).toFixed(2).replace(/\.?0+$/, '') + '%'`
 * 官方单测：packages/table-ui/src/controller/__tests__/formatPercentCellValue.test.ts
 */
public class TabDataNumberFormatTest {
    @Test
    public fun `percent matches web canon cases`() {
        val cases = listOf(
            "0.85" to "85%",
            "0.12" to "12%",
            "1" to "100%",
            "0" to "0%",
            "0.123" to "12.3%",
            "0.1234" to "12.34%",
            "0.12345" to "12.35%",
            "0.1" to "10%",
            "0.125" to "12.5%",
            "1.5" to "150%",
            "-0.25" to "-25%",
            "0.001" to "0.1%",
            "0.0001" to "0.01%",
            "0.00001" to "0%",
            "-0.00001" to "-0%",
            " 0.85 " to "85%",
        )
        for ((raw, expected) in cases) {
            assertEquals("input=$raw", expected, TabDataNumberFormat.formatPercent(raw))
        }
    }

    @Test
    public fun `percent empty and dirty data fall back`() {
        assertNull(TabDataNumberFormat.formatPercent(null))
        assertNull(TabDataNumberFormat.formatPercent(""))
        assertNull(TabDataNumberFormat.formatPercent("   "))
        assertNull(TabDataNumberFormat.formatPercent("n/a"))
        assertNull(TabDataNumberFormat.formatPercent("abc"))
        assertNull(TabDataNumberFormat.formatPercent("85%"))
        assertNull(TabDataNumberFormat.formatPercent("Infinity"))
        assertNull(TabDataNumberFormat.formatPercent("NaN"))
    }

    @Test
    public fun `percent editor points match web display without percent sign`() {
        val cases = listOf(
            "0.85" to "85",
            "0.12" to "12",
            "1" to "100",
            "0" to "0",
            "0.123" to "12.3",
            "0.1234" to "12.34",
            "0.12345" to "12.35",
            "0.1" to "10",
            "0.125" to "12.5",
            "1.5" to "150",
            "-0.25" to "-25",
            "0.001" to "0.1",
            "0.0001" to "0.01",
            "0.00001" to "0",
            "-0.00001" to "-0",
            " 0.85 " to "85",
        )
        for ((raw, expected) in cases) {
            assertEquals("input=$raw", expected, TabDataNumberFormat.formatPercentEditorPoints(raw))
        }
        assertNull(TabDataNumberFormat.formatPercentEditorPoints(null))
        assertNull(TabDataNumberFormat.formatPercentEditorPoints(""))
        assertNull(TabDataNumberFormat.formatPercentEditorPoints("n/a"))
    }

    @Test
    public fun `percent editor commit does not drift when user does not edit`() {
        val keepStored = listOf(
            "0.85" to "85",
            "0.123" to "12.3",
            "0.12345" to "12.35",
            "0.12" to "12",
            "1" to "100",
            "0" to "0",
            "-0.25" to "-25",
            "0.123456" to "12.35",
        )
        for ((stored, points) in keepStored) {
            assertEquals(
                "unchanged $stored",
                TabDataNumberFormat.PercentEditorCommit.Ratio(stored),
                TabDataNumberFormat.commitPercentEditor(points, stored),
            )
        }
        assertEquals(
            TabDataNumberFormat.PercentEditorCommit.Ratio("0.85"),
            TabDataNumberFormat.commitPercentEditor("85%", "0.85"),
        )
        assertEquals(
            TabDataNumberFormat.PercentEditorCommit.Ratio("0.85"),
            TabDataNumberFormat.commitPercentEditor(" 85 ", " 0.85 "),
        )
    }

    @Test
    public fun `percent editor commit parses points locally and clears to null`() {
        assertEquals(
            TabDataNumberFormat.PercentEditorCommit.Ratio("0.9"),
            TabDataNumberFormat.commitPercentEditor("90", "0.85"),
        )
        assertEquals(
            TabDataNumberFormat.PercentEditorCommit.Ratio("0.85"),
            TabDataNumberFormat.commitPercentEditor("85", ""),
        )
        assertEquals(
            TabDataNumberFormat.PercentEditorCommit.Ratio("0.85"),
            TabDataNumberFormat.commitPercentEditor("85%", ""),
        )
        assertEquals(
            TabDataNumberFormat.PercentEditorCommit.Empty,
            TabDataNumberFormat.commitPercentEditor("", "0.85"),
        )
        assertEquals(
            TabDataNumberFormat.PercentEditorCommit.Empty,
            TabDataNumberFormat.commitPercentEditor("   ", "0.85"),
        )
        assertEquals(
            TabDataNumberFormat.PercentEditorCommit.Empty,
            TabDataNumberFormat.commitPercentEditor("%", "0.85"),
        )
        assertEquals(
            TabDataNumberFormat.PercentEditorCommit.Ratio("0.005"),
            TabDataNumberFormat.commitPercentEditor(".5", "0.85"),
        )
        assertEquals(0.85, TabDataNumberFormat.parsePercentPointsToRatio("85"))
        assertEquals(0.85, TabDataNumberFormat.parsePercentPointsToRatio("85%"))
        assertEquals(0.85, TabDataNumberFormat.parsePercentPointsToRatio(" 85 "))
        assertNull(TabDataNumberFormat.parsePercentPointsToRatio(""))
        assertNull(TabDataNumberFormat.parsePercentPointsToRatio("   "))
    }

    @Test
    public fun `percent editor keeps intermediate typed text`() {
        val intermediates = listOf("-", "+", ".", "-.", "+.", "8.", "12.")
        for (typed in intermediates) {
            assertEquals(
                "typed=$typed",
                TabDataNumberFormat.PercentEditorCommit.Intermediate,
                TabDataNumberFormat.commitPercentEditor(typed, "0.85"),
            )
            assertEquals("typed=$typed", true, TabDataNumberFormat.isPercentEditorIntermediate(typed))
        }
        assertEquals(false, TabDataNumberFormat.isPercentEditorIntermediate(""))
        assertEquals(false, TabDataNumberFormat.isPercentEditorIntermediate("85"))
        assertEquals(false, TabDataNumberFormat.isPercentEditorIntermediate("8"))
    }

    @Test
    public fun `currency matches web grid formatter`() {
        assertEquals("¥12.30", TabDataNumberFormat.formatCurrency("12.3", symbol = "¥", precision = 2))
        assertEquals("$12.3", TabDataNumberFormat.formatCurrency("12.3", symbol = "$", precision = 1))
        assertEquals("€0.00", TabDataNumberFormat.formatCurrency("0", symbol = "€", precision = 2))
        assertNull(TabDataNumberFormat.formatCurrency(null, symbol = "¥", precision = 2))
        assertNull(TabDataNumberFormat.formatCurrency("abc", symbol = "¥", precision = 2))
    }

    @Test
    public fun `rating clamps to integer range`() {
        assertEquals(0, TabDataNumberFormat.clampRating("0", max = 5))
        assertEquals(5, TabDataNumberFormat.clampRating("5", max = 5))
        assertEquals(5, TabDataNumberFormat.clampRating("9", max = 5))
        assertEquals(0, TabDataNumberFormat.clampRating("-1", max = 5))
        assertNull(TabDataNumberFormat.clampRating("1.5", max = 5))
        assertNull(TabDataNumberFormat.clampRating("n/a", max = 5))
    }

    @Test
    public fun `currency and rating options read number and string`() {
        val dollar = mapOf("symbol" to "$", "precision" to 1)
        assertEquals("$", TabDataNumberFormat.currencySymbol(dollar))
        assertEquals(1, TabDataNumberFormat.currencyPrecision(dollar))
        assertEquals(
            "$12.3",
            TabDataNumberFormat.formatCurrency(
                "12.3",
                symbol = TabDataNumberFormat.currencySymbol(dollar),
                precision = TabDataNumberFormat.currencyPrecision(dollar),
            ),
        )
        assertEquals("¥", TabDataNumberFormat.currencySymbol(mapOf("symbol" to "")))
        assertEquals("¥", TabDataNumberFormat.currencySymbol(null))
        assertEquals(2, TabDataNumberFormat.currencyPrecision(null))

        assertEquals(10, TabDataNumberFormat.ratingMax(mapOf("max" to "10")))
        assertEquals(10, TabDataNumberFormat.ratingMax(mapOf("max" to 10)))
        assertEquals(5, TabDataNumberFormat.ratingMax(null))
        assertEquals(5, TabDataNumberFormat.ratingMax(emptyMap<String, Any>()))
        assertEquals("★★★☆☆", TabDataNumberFormat.formatRatingStars("3", max = 5))
    }
}
