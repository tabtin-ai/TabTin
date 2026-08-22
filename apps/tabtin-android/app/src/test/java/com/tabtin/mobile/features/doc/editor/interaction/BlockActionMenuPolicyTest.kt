package com.tabtin.mobile.features.doc.editor.interaction

import com.tabtin.mobile.features.doc.model.BlockKind
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class BlockActionMenuPolicyTest {

    @Test
    fun `whole block delete capability exposes delete and select without content editing actions`() {
        val visibility = blockActionMenuVisibility(
            blockKind = BlockKind.IMAGE,
            isBlockEditable = false,
            canDeleteWholeBlock = true,
        )

        assertTrue(visibility.showDelete)
        assertTrue(visibility.showSelect)
        assertFalse(visibility.showDuplicate)
        assertFalse(visibility.showCopyText)
        assertFalse(visibility.showTurnInto)
    }

    @Test
    fun `opaque read only block cannot enter an empty destructive selection`() {
        val visibility = blockActionMenuVisibility(
            blockKind = BlockKind.UNSUPPORTED,
            isBlockEditable = false,
            canDeleteWholeBlock = false,
        )

        assertFalse(visibility.showDelete)
        assertFalse(visibility.showSelect)
        assertFalse(visibility.showDuplicate)
        assertFalse(visibility.showCopyText)
        assertFalse(visibility.showTurnInto)
    }

    @Test
    fun `editable text block keeps all existing content actions`() {
        val visibility = blockActionMenuVisibility(
            blockKind = BlockKind.PARAGRAPH,
            isBlockEditable = true,
            canDeleteWholeBlock = true,
        )

        assertTrue(visibility.showDelete)
        assertTrue(visibility.showSelect)
        assertTrue(visibility.showDuplicate)
        assertTrue(visibility.showCopyText)
        assertTrue(visibility.showTurnInto)
        assertFalse(visibility.showAddComment)
    }

    @Test
    fun `add comment is independent of table or content editing actions`() {
        val visibility = blockActionMenuVisibility(
            blockKind = BlockKind.IMAGE,
            isBlockEditable = false,
            canDeleteWholeBlock = true,
            canAddComment = true,
        )

        assertTrue(visibility.showAddComment)
        assertFalse(visibility.showDuplicate)
        assertFalse(visibility.showTurnInto)
    }
}
