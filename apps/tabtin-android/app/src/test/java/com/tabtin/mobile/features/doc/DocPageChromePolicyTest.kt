package com.tabtin.mobile.features.doc

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class DocPageChromePolicyTest {

    @Test
    fun `inline edit chrome stays hidden until the block is focused or selected`() {
        assertFalse(
            DocPageChromePolicy.showsInlineEditChrome(
                canEdit = true,
                isFocused = false,
                isSelected = false,
            ),
        )
        assertTrue(
            DocPageChromePolicy.showsInlineEditChrome(
                canEdit = true,
                isFocused = true,
                isSelected = false,
            ),
        )
        assertTrue(
            DocPageChromePolicy.showsInlineEditChrome(
                canEdit = true,
                isFocused = false,
                isSelected = true,
            ),
        )
        assertFalse(
            DocPageChromePolicy.showsInlineEditChrome(
                canEdit = false,
                isFocused = true,
                isSelected = true,
            ),
        )
    }

    @Test
    fun `save indicator occupies the title bar only while active or actionable`() {
        assertFalse(DocPageChromePolicy.showsSaveIndicator(SaveState.IDLE))
        assertTrue(DocPageChromePolicy.showsSaveIndicator(SaveState.DIRTY))
        assertTrue(DocPageChromePolicy.showsSaveIndicator(SaveState.SAVING))
        assertTrue(DocPageChromePolicy.showsSaveIndicator(SaveState.SAVED))
        assertTrue(DocPageChromePolicy.showsSaveIndicator(SaveState.FAILED))
        assertTrue(DocPageChromePolicy.showsSaveIndicator(SaveState.CONFLICT))
        assertTrue(DocPageChromePolicy.showsSaveIndicator(SaveState.PERMISSION_DENIED))
    }

    @Test
    fun `retry is offered only after a failed autosave`() {
        assertFalse(DocPageChromePolicy.showsSaveRetry(SaveState.IDLE))
        assertFalse(DocPageChromePolicy.showsSaveRetry(SaveState.DIRTY))
        assertFalse(DocPageChromePolicy.showsSaveRetry(SaveState.SAVING))
        assertFalse(DocPageChromePolicy.showsSaveRetry(SaveState.SAVED))
        assertFalse(DocPageChromePolicy.showsSaveRetry(SaveState.CONFLICT))
        assertFalse(DocPageChromePolicy.showsSaveRetry(SaveState.PERMISSION_DENIED))
        assertTrue(DocPageChromePolicy.showsSaveRetry(SaveState.FAILED))
    }

    @Test
    fun `editor more menu always keeps share history and full editor slots`() {
        val menu = DocPageChromePolicy.moreMenu(
            canShareLink = true,
            canSendDirectMessage = true,
            canOpenFullEditor = true,
            canSave = true,
        )
        assertTrue(menu.showShareLink)
        assertTrue(menu.showVersionHistory)
        assertTrue(menu.showFullEditor)
    }

    @Test
    fun `list markers keep a compact visual column and expand only the hit target`() {
        assertEquals(24f, DocPageChromePolicy.LIST_MARKER_VISUAL_COLUMN_DP)
        assertEquals(48f, DocPageChromePolicy.LIST_MARKER_HIT_TARGET_DP)
        assertTrue(
            DocPageChromePolicy.LIST_MARKER_HIT_TARGET_DP >
                DocPageChromePolicy.LIST_MARKER_VISUAL_COLUMN_DP,
        )
    }
}
