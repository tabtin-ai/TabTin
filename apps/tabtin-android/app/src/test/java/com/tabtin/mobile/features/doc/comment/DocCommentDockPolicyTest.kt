package com.tabtin.mobile.features.doc.comment

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

public class DocCommentDockPolicyTest {
    @Test
    public fun `short document docks comments to the bottom of the viewport`() {
        assertEquals(
            420,
            DocCommentDockPolicy.extraTopPx(
                viewportHeightPx = 800,
                precedingHeightPx = 200,
                footerContentHeightPx = 180,
            ),
        )
    }

    @Test
    public fun `long document keeps comments immediately after the last block`() {
        assertEquals(
            0,
            DocCommentDockPolicy.extraTopPx(
                viewportHeightPx = 800,
                precedingHeightPx = 700,
                footerContentHeightPx = 180,
            ),
        )
    }

    @Test
    public fun `unknown preceding row heights skip this layout pass`() {
        assertNull(DocCommentDockPolicy.sumKnownHeightsOrNull(listOf(120, null, 80)))
        assertEquals(200, DocCommentDockPolicy.sumKnownHeightsOrNull(listOf(120, 80)))
    }
}
