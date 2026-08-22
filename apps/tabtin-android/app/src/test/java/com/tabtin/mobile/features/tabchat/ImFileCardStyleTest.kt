package com.tabtin.mobile.features.tabchat

import androidx.compose.ui.graphics.Color
import org.junit.Assert.assertEquals
import org.junit.Test

class ImFileCardStyleTest {
    @Test
    fun extensionOf_readsLastSegment() {
        assertEquals("pdf", ImFileCardStyles.extensionOf("Q3-roadmap.pdf"))
        assertEquals("xlsx", ImFileCardStyles.extensionOf("竞品调研-汇总.xlsx"))
        assertEquals("", ImFileCardStyles.extensionOf("noext"))
        assertEquals("", ImFileCardStyles.extensionOf(".hidden"))
    }

    @Test
    fun styleFor_matchesElectronPalette() {
        assertEquals(Color(0xFFEF4444), ImFileCardStyles.styleFor("a.pdf").background)
        assertEquals("PDF", ImFileCardStyles.styleFor("a.pdf").badge)
        assertEquals(Color(0xFF3B82F6), ImFileCardStyles.styleFor("a.docx").background)
        assertEquals("DOCX", ImFileCardStyles.styleFor("a.docx").badge)
        assertEquals(Color(0xFF059669), ImFileCardStyles.styleFor("a.xlsx").background)
        assertEquals(Color(0xFFF97316), ImFileCardStyles.styleFor("a.pptx").background)
        assertEquals(Color(0xFF475569), ImFileCardStyles.styleFor("a.md").background)
        assertEquals(Color(0xFFF59E0B), ImFileCardStyles.styleFor("a.json").background)
        assertEquals(Color(0xFF9CA3AF), ImFileCardStyles.styleFor("a.zip").background)
        assertEquals("ZIP", ImFileCardStyles.styleFor("a.zip").badge)
    }

    @Test
    fun styleFor_unavailableUsesGray() {
        val style = ImFileCardStyles.styleFor("report.pdf", unavailable = true)
        assertEquals(ImFileCardStyles.Unavailable, style.background)
        assertEquals("PDF", style.badge)
    }

    @Test
    fun compactMetrics_areStable() {
        assertEquals(252, ImFileCardStyles.CardMaxWidthDp)
        assertEquals(64, ImFileCardStyles.CardMinHeightDp)
        assertEquals(14, ImFileCardStyles.CardCornerRadiusDp)
        assertEquals(28, ImFileCardStyles.ActionSizeDp)
    }
}
