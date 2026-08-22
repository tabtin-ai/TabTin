package com.tabtin.mobile.features.doc

import com.tabtin.mobile.features.doc.editor.core.TabDocBlockView
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class DocEditorContentPolicyTest {

    @Test
    fun `document title leads scroll content without changing document block indexes`() {
        val paragraph = TabDocBlockView.Text.Paragraph(
            id = "paragraph-1",
            body = "正文",
        )

        val items = DocEditorContentPolicy.adapterItems(
            title = "示例云文档",
            blocks = listOf(paragraph),
        )

        assertTrue(items.first() is TabDocBlockView.Title)
        assertEquals("示例云文档", (items.first() as TabDocBlockView.Title).body)
        assertEquals(paragraph, items[1])
        assertTrue(items.last() is TabDocBlockView.CommentsFooter)
        assertNull(DocEditorContentPolicy.documentBlockIndex(0, items.size))
        assertEquals(0, DocEditorContentPolicy.documentBlockIndex(1, items.size))
        assertNull(DocEditorContentPolicy.documentBlockIndex(items.lastIndex, items.size))
        assertEquals(3, DocEditorContentPolicy.documentBlockIndex(4))
    }
}
