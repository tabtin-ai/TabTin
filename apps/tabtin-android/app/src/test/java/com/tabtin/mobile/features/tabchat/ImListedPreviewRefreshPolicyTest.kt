package com.tabtin.mobile.features.tabchat

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ImListedPreviewRefreshPolicyTest {
    @Test
    fun `refresh waits until initial history has started`() {
        assertFalse(
            imShouldRefreshLatestFromListedPreview(
                hasLoadedInitial = false,
                listedLastMessageSeq = 40,
                visibleLastMessageSeq = 10,
            ),
        )
    }

    @Test
    fun `refresh when listed preview is ahead of visible timeline`() {
        assertTrue(
            imShouldRefreshLatestFromListedPreview(
                hasLoadedInitial = true,
                listedLastMessageSeq = 40,
                visibleLastMessageSeq = 10,
            ),
        )
    }

    @Test
    fun `skip refresh when detail already matches listed preview`() {
        assertFalse(
            imShouldRefreshLatestFromListedPreview(
                hasLoadedInitial = true,
                listedLastMessageSeq = 40,
                visibleLastMessageSeq = 40,
            ),
        )
        assertFalse(
            imShouldRefreshLatestFromListedPreview(
                hasLoadedInitial = true,
                listedLastMessageSeq = 39,
                visibleLastMessageSeq = 40,
            ),
        )
    }

    @Test
    fun `c2c refresh when listed timestamp is newer even if seq looks behind`() {
        assertTrue(
            imShouldRefreshLatestFromListedPreview(
                hasLoadedInitial = true,
                listedLastMessageSeq = 5,
                visibleLastMessageSeq = 101,
                listedLastMessageAt = "2026-08-19T05:46:00Z",
                visibleLastMessageAt = "2026-08-18T12:27:30Z",
            ),
        )
    }

    @Test
    fun `skip c2c refresh when listed timestamp is not ahead`() {
        assertFalse(
            imShouldRefreshLatestFromListedPreview(
                hasLoadedInitial = true,
                listedLastMessageSeq = 5,
                visibleLastMessageSeq = 101,
                listedLastMessageAt = "2026-08-18T12:27:00Z",
                visibleLastMessageAt = "2026-08-18T12:27:30Z",
            ),
        )
    }
}
