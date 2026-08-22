package com.tabtin.mobile.features.doc.editor.holders

import java.io.File
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ListMarkerAlignmentSourceTest {
    @Test
    fun `bullet stays centered on first text line instead of whole multiline block`() {
        val source = File("src/main/res/layout/doc_block_bulleted.xml").readText()

        assertTrue(source.contains("android:layout_gravity=\"top\""))
        assertTrue(source.contains("@dimen/doc_editor_list_marker_vertical_offset"))
        assertFalse(source.contains("android:layout_gravity=\"center_vertical\""))
    }

    @Test
    fun `ordered marker explicitly participates in text baseline alignment`() {
        val source = File("src/main/res/layout/doc_block_numbered.xml").readText()

        assertTrue(source.contains("android:baselineAligned=\"true\""))
    }
}
