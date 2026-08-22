package com.tabtin.mobile.features.doc.comment

import org.junit.Assert.assertEquals
import org.junit.Test

public class DocCommentImePolicyTest {
    @Test
    public fun `keyboard room is reserved on the document list while IME is visible`() {
        assertEquals(
            336,
            DocCommentImePolicy.recyclerViewBottomPaddingPx(
                imeVisible = true,
                imeBottomPx = 320,
                showFormatToolbar = false,
                restingPx = 16,
                formatRoomPx = 120,
            ),
        )
    }

    @Test
    public fun `format toolbar still keeps its own room above the keyboard`() {
        assertEquals(
            336,
            DocCommentImePolicy.recyclerViewBottomPaddingPx(
                imeVisible = true,
                imeBottomPx = 320,
                showFormatToolbar = true,
                restingPx = 16,
                formatRoomPx = 120,
            ),
        )
    }

    @Test
    public fun `hidden keyboard restores the resting list inset`() {
        assertEquals(
            16,
            DocCommentImePolicy.recyclerViewBottomPaddingPx(
                imeVisible = false,
                imeBottomPx = 0,
                showFormatToolbar = true,
                restingPx = 16,
                formatRoomPx = 120,
            ),
        )
    }

    @Test
    public fun `unfocused input does not lift even when keyboard is visible`() {
        assertEquals(0, DocCommentImePolicy.liftBottomPx(inputFocused = false, imeBottomPx = 320))
    }

    @Test
    public fun `focused input stays put when keyboard is hidden`() {
        assertEquals(0, DocCommentImePolicy.liftBottomPx(inputFocused = true, imeBottomPx = 0))
    }

    @Test
    public fun `focused input lifts by the keyboard height`() {
        assertEquals(320, DocCommentImePolicy.liftBottomPx(inputFocused = true, imeBottomPx = 320))
    }
}
