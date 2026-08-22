package com.tabtin.mobile.features.doc.comment

import com.tabtin.mobile.data.model.doc.CommentAnchor
import com.tabtin.mobile.data.model.doc.CommentMessage
import com.tabtin.mobile.data.model.doc.CommentThread
import com.tabtin.mobile.features.doc.model.BlockKind
import com.tabtin.mobile.features.doc.model.DocBlock
import com.tabtin.mobile.features.doc.model.InlineSpan
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Test

public class DocCommentPresentationPolicyTest {
    private val labels = DocCommentPresentationLabels(
        documentTitle = "文档评论",
        blockTitle = "块评论",
        orphanedTitle = "失联评论",
        anonymousAuthor = "匿名",
    )

    @Test
    public fun `block thread attaches when block_ids match DocBlock blockId`() {
        val block = DocBlock(
            id = "runtime-uuid",
            blockId = "pm-block-1",
            kind = BlockKind.PARAGRAPH,
            spans = listOf(InlineSpan("第一段正文")),
        )
        val thread = commentThread(
            id = "thread-record-id",
            scope = "block",
            blockIds = listOf("pm-block-1"),
            body = "看一下这段",
            authorName = "Alice",
        )

        val presented = presentCommentThreads(listOf(thread), listOf(block), labels).single()

        assertEquals(DocCommentAnchorKind.BLOCK, presented.kind)
        assertEquals("pm-block-1", presented.matchedBlockId)
        assertEquals("第一段正文", presented.title)
        assertEquals("看一下这段", presented.body)
        assertEquals("Alice", presented.authorName)
        assertFalse(presented.title.contains(thread.id))
    }

    @Test
    public fun `block thread is orphaned when block_ids miss native blockId`() {
        val block = DocBlock(
            id = "runtime-uuid",
            blockId = "pm-block-1",
            kind = BlockKind.PARAGRAPH,
            spans = listOf(InlineSpan("第一段正文")),
        )
        val thread = commentThread(
            id = "orphaned-record-id",
            scope = "block",
            blockIds = listOf("deleted-block"),
            body = "旧锚点",
        )

        val presented = presentCommentThreads(listOf(thread), listOf(block), labels).single()

        assertEquals(DocCommentAnchorKind.ORPHANED, presented.kind)
        assertNull(presented.matchedBlockId)
        assertEquals("失联评论", presented.title)
        assertFalse(presented.title.contains(thread.id))
        assertFalse(presented.title.contains("deleted-block"))
    }

    @Test
    public fun `runtime history or record id is not treated as a native block match or title`() {
        val block = DocBlock(
            id = "history-record-id",
            blockId = "pm-block-1",
            kind = BlockKind.PARAGRAPH,
            spans = listOf(InlineSpan("可见标题")),
        )
        val thread = commentThread(
            id = "history-record-id",
            scope = "block",
            blockIds = listOf("history-record-id"),
            body = "不该挂到运行期 id",
        )

        val presented = presentCommentThreads(listOf(thread), listOf(block), labels).single()

        assertEquals(DocCommentAnchorKind.ORPHANED, presented.kind)
        assertEquals("失联评论", presented.title)
        assertFalse(presented.title.contains("history-record-id"))
        assertNull(presented.matchedBlockId)
    }

    @Test
    public fun `document thread uses product language instead of record id`() {
        val thread = commentThread(
            id = "internal-history-record-id",
            scope = "document",
            blockIds = emptyList(),
            body = "文末意见",
            authorName = "Bob",
            authorAvatar = "https://cdn.example.com/a.png",
        )

        val presented = presentCommentThreads(listOf(thread), emptyList(), labels).single()

        assertEquals(DocCommentAnchorKind.DOCUMENT, presented.kind)
        assertEquals("文档评论", presented.title)
        assertEquals("Bob", presented.authorName)
        assertEquals("https://cdn.example.com/a.png", presented.authorAvatarUrl)
        assertFalse(presented.title.contains(thread.id))
        assertFalse(presented.title.contains(thread.id.take(8)))
    }

    @Test
    public fun `unmatched text range is orphaned and does not rewrite title from ids`() {
        val thread = commentThread(
            id = "range-record-id",
            scope = "text_range",
            blockIds = listOf("missing"),
            body = "选区旧评",
        )

        val presented = presentCommentThreads(listOf(thread), emptyList(), labels).single()

        assertEquals(DocCommentAnchorKind.ORPHANED, presented.kind)
        assertEquals("失联评论", presented.title)
        assertFalse(presented.title.contains(thread.id))
    }

    private fun commentThread(
        id: String,
        scope: String,
        blockIds: List<String>,
        body: String,
        authorName: String = "",
        authorAvatar: String? = null,
    ): CommentThread = CommentThread(
        id = id,
        documentId = "doc-1",
        scope = scope,
        status = "open",
        anchor = CommentAnchor(version = 1, blockIds = blockIds),
        anchorStatus = if (scope == "document") "none" else "attached",
        messages = listOf(
            CommentMessage(
                id = "msg-$id",
                threadId = id,
                kind = "root",
                authorName = authorName,
                authorAvatar = authorAvatar,
                body = body,
            ),
        ),
    )
}
