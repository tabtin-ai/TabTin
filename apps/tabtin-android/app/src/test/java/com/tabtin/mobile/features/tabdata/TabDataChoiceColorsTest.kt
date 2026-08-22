package com.tabtin.mobile.features.tabdata

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 与 iOS `NativeTabDataChoiceColorPolicy`、Web `resolveSelectChipColors` 同一组输入与期望。
 * Web 依据：`packages/smartsheet-ui/src/utils/choice-colors.ts`；hash 必须落到同一预设色。
 */
class TabDataChoiceColorsTest {
    @Test
    fun `choice colors match web canon and ios`() {
        val cases = listOf(
            Case("gray", "待处理", "#808080", "#FFFFFF"),
            Case("blueBright", "进行中", "#007BFF", "#FFFFFF"),
            Case("purpleLight2", "aaa", "#E5CCFF", "#000000"),
            Case("yellowLight2", "light", "#FFF3BF", "#000000"),
            Case("red", "dark", "#D90A19", "#FFFFFF"),
            Case("#ED8936", "5327-live-opt-A", "#ED8936", "#000000"),
            Case("#ed8936", "x", "#ED8936", "#000000"),
            Case("#abc", "x", "#AABBCC", "#000000"),
            Case("#ABC", "x", "#AABBCC", "#000000"),
            Case("  #00ff00  ", "x", "#00FF00", "#FFFFFF"),
            Case("#FFFFFF", "w", "#FFFFFF", "#000000"),
            Case("#000000", "b", "#000000", "#FFFFFF"),
            Case("#808080", "g", "#808080", "#FFFFFF"),
            Case(null, "untitled", "#FFD43B", "#000000"),
            Case("", "untitled", "#FFD43B", "#000000"),
            Case("not-a-color", "untitled", "#FFD43B", "#000000"),
            Case(null, "P1", "#FA8000", "#FFFFFF"),
            Case(null, "Done", "#0066CC", "#FFFFFF"),
            Case(null, "高优先级", "#F15646", "#FFFFFF"),
        )
        for (item in cases) {
            val (background, foreground) = TabDataChoiceColors.resolveHex(item.color, item.value)
            assertEquals("bg color=${item.color} value=${item.value}", item.background, background)
            assertEquals("fg color=${item.color} value=${item.value}", item.foreground, foreground)
        }
        assertEquals("#AABBCC", TabDataChoiceColors.normalizeHexColor("#abc"))
        assertEquals("#ED8936", TabDataChoiceColors.normalizeHexColor("#Ed8936"))
        assertEquals(13_050_085L, TabDataChoiceColors.stableHash("untitled"))
        assertEquals(2529L, TabDataChoiceColors.stableHash("P1"))
        assertTrue(TabDataChoiceColors.isLightHexColor("#ED8936"))
        assertFalse(TabDataChoiceColors.isLightHexColor("#808080"))
        assertTrue(TabDataChoiceColors.isLightHexColor("#FFF3BF"))
        assertFalse(TabDataChoiceColors.isLightHexColor("#D90A19"))
    }

    @Test
    fun `choice overflow visible count is width driven not a magic cap`() {
        assertEquals(3, TabDataChoiceOverflow.visibleCount(listOf(40, 40, 40), 20, 8, 200))
        assertEquals(2, TabDataChoiceOverflow.visibleCount(listOf(80, 80, 80, 80), 24, 8, 200))
        assertEquals(1, TabDataChoiceOverflow.visibleCount(listOf(50, 50, 50), 20, 4, 74))
        assertEquals(0, TabDataChoiceOverflow.visibleCount(listOf(180), 30, 8, 100))
        assertEquals(0, TabDataChoiceOverflow.visibleCount(emptyList(), 20, 8, 200))
        assertEquals(4, TabDataChoiceOverflow.visibleCount(listOf(10, 10, 10, 10), 24, 4, 1000))
    }

    private data class Case(
        val color: String?,
        val value: String,
        val background: String,
        val foreground: String,
    )
}
