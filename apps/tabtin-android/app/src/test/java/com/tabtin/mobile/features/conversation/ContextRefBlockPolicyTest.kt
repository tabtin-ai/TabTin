package com.tabtin.mobile.features.conversation

import com.tabtin.mobile.data.model.BlockItem
import com.tabtin.mobile.data.model.MessageBlock
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ContextRefBlockPolicyTest {

    @Test
    fun `extracts doc and table selections and skips text and uploaded files`() {
        val blocks = listOf(
            BlockItem(type = "text", text = "请看这份文档"),
            BlockItem(type = "doc_selection", docId = "doc-1", preview = "需求文档"),
            BlockItem(type = "table_selection", tableId = "table-1", preview = "发布清单"),
            BlockItem(type = "file", url = "https://cdn.example/a.png", filename = "shot.png"),
            BlockItem(type = "file", fileId = "fr-9", filename = "spec.pdf", preview = "spec.pdf"),
        )

        val refs = ContextRefBlockPolicy.extract(blocks)
        assertEquals(
            listOf("doc_selection", "table_selection", "file"),
            refs.map { it.type },
        )
    }

    @Test
    fun `presents optimistic send blocks with title and openable id`() {
        val doc = ContextRefBlockPolicy.present(
            BlockItem(type = "doc_selection", docId = "doc-1", preview = "需求文档"),
        )
        assertEquals(ContextRefKind.DOC, doc.kind)
        assertEquals("需求文档", doc.title)
        assertEquals("tabdoc", doc.resourceType)
        assertEquals("doc-1", doc.resourceId)
        assertTrue(doc.canNavigate)
        assertEquals("需求文档", doc.openRequest(null)?.title)

        val memo = ContextRefBlockPolicy.present(
            BlockItem(type = "memo", memoId = "memo-1", preview = "会议纪要"),
        )
        assertEquals(ContextRefKind.MEMO, memo.kind)
        assertEquals("memo-1", memo.resourceId)
        assertEquals("tabmemo", memo.resourceType)
    }

    @Test
    fun `file without url is a context ref not an attachment`() {
        val block = BlockItem(type = "file", fileId = "fr-1", filename = "brief.pdf")
        assertTrue(ContextRefBlockPolicy.isContextRef(block))
        val presented = ContextRefBlockPolicy.present(block)
        assertEquals(ContextRefKind.FILE, presented.kind)
        assertEquals("brief.pdf", presented.title)
        assertEquals("tabfiles", presented.resourceType)
        assertEquals("fr-1", presented.resourceId)
    }

    @Test
    fun `file with url is not a context ref`() {
        assertFalse(
            ContextRefBlockPolicy.isContextRef(
                BlockItem(type = "file", url = "https://cdn.example/a.pdf", filename = "a.pdf"),
            ),
        )
    }

    @Test
    fun `history label wins over preview and duplicate preview is hidden`() {
        val presented = ContextRefBlockPolicy.present(
            BlockItem(
                type = "doc_selection",
                docId = "doc-2",
                label = "需求文档",
                preview = "需求文档",
            ),
        )
        assertEquals("需求文档", presented.title)
        assertNull(presented.displayPreview())
    }

    @Test
    fun `projector maps outbound context blocks onto renderable items`() {
        val projector = ConversationProjector()
        val message = projector.appendUserMessage(
            id = "client-ref-1",
            content = "请分析",
            blocks = listOf(
                MessageBlock(type = "text", content = "请分析"),
                MessageBlock(type = "doc_selection", docId = "doc-9", preview = "需求文档"),
                MessageBlock(type = "memo", memoId = "memo-9", preview = "纪要"),
            ),
        )
        val refs = ContextRefBlockPolicy.extract(message.blocksJson)
        assertEquals(listOf("doc_selection", "memo"), refs.map { it.type })
        assertEquals("doc-9", ContextRefBlockPolicy.present(refs[0]).resourceId)
        assertEquals("需求文档", ContextRefBlockPolicy.present(refs[0]).title)
        assertEquals("memo-9", ContextRefBlockPolicy.present(refs[1]).resourceId)
    }
}
