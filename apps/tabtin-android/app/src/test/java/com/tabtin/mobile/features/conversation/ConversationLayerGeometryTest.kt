package com.tabtin.mobile.features.conversation

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class ConversationLayerGeometryTest {

    @Test
    fun `ime expands only an already visible sheet`() {
        assertEquals(
            ConversationLayerDetent.EXPANDED,
            ConversationLayerImePolicy.target(
                imeVisible = true,
                detent = ConversationLayerDetent.SHEET,
                expandedForIme = false,
            ),
        )
        assertNull(
            ConversationLayerImePolicy.target(
                imeVisible = true,
                detent = ConversationLayerDetent.COLLAPSED,
                expandedForIme = false,
            ),
        )
    }

    @Test
    fun `ime dismissal restores only an automatically expanded sheet`() {
        assertEquals(
            ConversationLayerDetent.SHEET,
            ConversationLayerImePolicy.target(
                imeVisible = false,
                detent = ConversationLayerDetent.EXPANDED,
                expandedForIme = true,
            ),
        )
        assertNull(
            ConversationLayerImePolicy.target(
                imeVisible = false,
                detent = ConversationLayerDetent.EXPANDED,
                expandedForIme = false,
            ),
        )
    }

    @Test
    fun `grabber touch target is at least 48dp`() {
        assertEquals(48, ConversationLayerGeometry.MIN_GRABBER_TOUCH_TARGET_DP)
    }

    @Test
    fun `overlay detent ratios are ordered from collapsed to expanded`() {
        val collapsed = ConversationLayerGeometry.topRatio(ConversationLayerDetent.COLLAPSED)
        val sheet = ConversationLayerGeometry.topRatio(ConversationLayerDetent.SHEET)
        val expanded = ConversationLayerGeometry.topRatio(ConversationLayerDetent.EXPANDED)
        assertEquals(1f, collapsed, 0f)
        assertEquals(0.52f, sheet, 0f)
        assertEquals(0.09f, expanded, 0f)
    }

    @Test
    fun `slow release snaps to nearest detent`() {
        // 贴近收起
        assertEquals(
            ConversationLayerDetent.COLLAPSED,
            ConversationLayerGeometry.settle(topRatio = 0.92f, velocityDpPerMs = 0f),
        )
        // 贴近半屏
        assertEquals(
            ConversationLayerDetent.SHEET,
            ConversationLayerGeometry.settle(topRatio = 0.50f, velocityDpPerMs = 0f),
        )
        // 贴近扩展卡片
        assertEquals(
            ConversationLayerDetent.EXPANDED,
            ConversationLayerGeometry.settle(topRatio = 0.14f, velocityDpPerMs = 0f),
        )
    }

    @Test
    fun `fast flick up from collapsed goes to sheet not expanded`() {
        // 从接近收起处快速上滑：只跨一档，避免一甩到底
        assertEquals(
            ConversationLayerDetent.SHEET,
            ConversationLayerGeometry.settle(topRatio = 0.95f, velocityDpPerMs = -0.9f),
        )
    }

    @Test
    fun `fast flick up from above sheet goes to expanded`() {
        assertEquals(
            ConversationLayerDetent.EXPANDED,
            ConversationLayerGeometry.settle(topRatio = 0.40f, velocityDpPerMs = -0.9f),
        )
    }

    @Test
    fun `fast flick down from expanded goes to sheet not collapsed`() {
        assertEquals(
            ConversationLayerDetent.SHEET,
            ConversationLayerGeometry.settle(topRatio = 0.12f, velocityDpPerMs = 0.9f),
        )
    }

    @Test
    fun `fast flick down from below sheet collapses`() {
        assertEquals(
            ConversationLayerDetent.COLLAPSED,
            ConversationLayerGeometry.settle(topRatio = 0.70f, velocityDpPerMs = 0.9f),
        )
    }

    @Test
    fun `velocity below fling threshold falls back to nearest`() {
        // 0.5 < 0.55：不算 fling，就近吸附回扩展卡片
        assertEquals(
            ConversationLayerDetent.EXPANDED,
            ConversationLayerGeometry.settle(topRatio = 0.12f, velocityDpPerMs = 0.5f),
        )
    }

    @Test
    fun `top ratio is clamped into layer range`() {
        assertEquals(
            ConversationLayerDetent.EXPANDED,
            ConversationLayerGeometry.settle(topRatio = -0.4f, velocityDpPerMs = 0f),
        )
        assertEquals(
            ConversationLayerDetent.COLLAPSED,
            ConversationLayerGeometry.settle(topRatio = 1.6f, velocityDpPerMs = 0f),
        )
    }

    @Test
    fun `fast flick from exact sheet moves one detent`() {
        // 停在半屏再甩：必须跨一档，不能空操作
        assertEquals(
            ConversationLayerDetent.EXPANDED,
            ConversationLayerGeometry.settle(topRatio = 0.52f, velocityDpPerMs = -0.9f),
        )
        assertEquals(
            ConversationLayerDetent.COLLAPSED,
            ConversationLayerGeometry.settle(topRatio = 0.52f, velocityDpPerMs = 0.9f),
        )
    }

    @Test
    fun `velocity equal to fling threshold falls back to nearest`() {
        // abs == 0.55 不算「超」阈值，走就近
        assertEquals(
            ConversationLayerDetent.EXPANDED,
            ConversationLayerGeometry.settle(topRatio = 0.12f, velocityDpPerMs = -0.55f),
        )
        assertEquals(
            ConversationLayerDetent.EXPANDED,
            ConversationLayerGeometry.settle(topRatio = 0.12f, velocityDpPerMs = 0.55f),
        )
    }

    @Test
    fun `midpoint between detents ties break to earlier enum entry`() {
        // (1 + 0.52) / 2 = 0.76：距 COLLAPSED / SHEET 均为 0.24，minBy 取 entries 先者 COLLAPSED
        assertEquals(
            ConversationLayerDetent.COLLAPSED,
            ConversationLayerGeometry.settle(topRatio = 0.76f, velocityDpPerMs = 0f),
        )
        // (0.52 + 0.09) / 2 = 0.305：距 SHEET / EXPANDED 相同，minBy 取先者 SHEET
        assertEquals(
            ConversationLayerDetent.SHEET,
            ConversationLayerGeometry.settle(topRatio = 0.305f, velocityDpPerMs = 0f),
        )
    }

    @Test
    fun `clampTopRatio pins endpoints`() {
        assertEquals(0.09f, ConversationLayerGeometry.clampTopRatio(0f), 0f)
        assertEquals(1f, ConversationLayerGeometry.clampTopRatio(1f), 0f)
        assertEquals(0.09f, ConversationLayerGeometry.clampTopRatio(-1f), 0f)
        assertEquals(1f, ConversationLayerGeometry.clampTopRatio(2f), 0f)
    }
}
