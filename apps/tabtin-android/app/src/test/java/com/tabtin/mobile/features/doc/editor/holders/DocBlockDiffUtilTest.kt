package com.tabtin.mobile.features.doc.editor.holders

import com.tabtin.mobile.features.doc.editor.core.BlockViewConverter
import com.tabtin.mobile.features.doc.editor.core.TabDocBlockView
import com.tabtin.mobile.features.doc.model.BlockKind
import com.tabtin.mobile.features.doc.model.DocBlock
import com.tabtin.mobile.features.doc.model.InlineSpan
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.*
import org.junit.Test

/**
 * Regression tests for DocBlockDiffUtil (EIP-019 supporting test).
 * Validates correctness of diff callbacks used by the async diff path.
 */
class DocBlockDiffUtilTest {

    @Test
    fun `areItemsTheSame returns true for same id`() {
        val old = listOf(paragraph("a", "hello"))
        val new = listOf(paragraph("a", "world"))
        val diff = DocBlockDiffUtil(old, new)

        assertTrue(diff.areItemsTheSame(0, 0))
    }

    @Test
    fun `areItemsTheSame returns false for different id`() {
        val old = listOf(paragraph("a", "hello"))
        val new = listOf(paragraph("b", "hello"))
        val diff = DocBlockDiffUtil(old, new)

        assertFalse(diff.areItemsTheSame(0, 0))
    }

    @Test
    fun `areContentsTheSame returns false when text changes`() {
        val old = listOf(paragraph("a", "hello"))
        val new = listOf(paragraph("a", "world"))
        val diff = DocBlockDiffUtil(old, new)

        assertFalse(diff.areContentsTheSame(0, 0))
    }

    @Test
    fun `areContentsTheSame returns true for identical items`() {
        val old = listOf(paragraph("a", "hello"))
        val new = listOf(paragraph("a", "hello"))
        val diff = DocBlockDiffUtil(old, new)

        assertTrue(diff.areContentsTheSame(0, 0))
    }

    @Test
    fun `payload detects text change`() {
        val old = listOf(paragraph("a", "hello"))
        val new = listOf(paragraph("a", "world"))
        val diff = DocBlockDiffUtil(old, new)

        val payload = diff.getChangePayload(0, 0) as? Set<*>
        assertNotNull(payload)
        assertTrue(payload!!.contains(DocBlockDiffUtil.Payload.TEXT_CHANGED))
    }

    @Test
    fun `payload detects focus change`() {
        val old = listOf(paragraph("a", "hello", isFocused = false))
        val new = listOf(paragraph("a", "hello", isFocused = true))
        val diff = DocBlockDiffUtil(old, new)

        val payload = diff.getChangePayload(0, 0) as? Set<*>
        assertNotNull(payload)
        assertTrue(payload!!.contains(DocBlockDiffUtil.Payload.FOCUS_CHANGED))
    }

    @Test
    fun `alignment-only changes produce a narrow payload without rebinding text`() {
        val right = alignedParagraph("right")
        val justify = alignedParagraph("justify")
        val natural = BlockViewConverter.toBlockViews(
            listOf(
                DocBlock(
                    id = "aligned",
                    kind = BlockKind.PARAGRAPH,
                    spans = listOf(InlineSpan("same body")),
                    sourceAttributes = buildJsonObject { put("textAlign", JsonNull) },
                ),
            ),
        ).single()

        listOf(right to justify, justify to natural).forEach { (old, new) ->
            val diff = DocBlockDiffUtil(listOf(old), listOf(new))
            assertFalse("对齐变化必须进入 RecyclerView 更新", diff.areContentsTheSame(0, 0))

            val payload = diff.getChangePayload(0, 0) as? Set<*>
            assertNotNull("对齐变化应使用窄 payload，避免全文本重绑和光标扰动", payload)
            assertEquals(
                "只改变对齐时应只投递 alignment payload",
                setOf(DocBlockDiffUtil.Payload.ALIGNMENT_CHANGED),
                payload,
            )
        }
    }

    @Test
    fun `large list diff computes correctly`() {
        val old = (1..500).map { paragraph("id-$it", "text-$it") }
        val new = old.toMutableList().also {
            it.add(250, paragraph("new-item", "inserted"))
            it.removeAt(100)
        }
        val diff = DocBlockDiffUtil(old, new)

        assertEquals(500, diff.oldListSize)
        assertEquals(500, diff.newListSize)
        // W A0.3.续4 修复：原断言 assertFalse 写错，详 W A0.3.续3 反思 §3.3 + §9.5。
        // also { add(250, "new-item"); removeAt(100) } 顺序：先 add 让 list 长度 501，
        // 再 removeAt(100) 让 index 100..500 全下移 1 → new[249]=new-item, new[250]=id-251；
        // old[250]=id-251 → areItemsTheSame(250, 250) 比较 id 相同 → true。
        assertTrue(diff.areItemsTheSame(250, 250))
        // 真正不同的 index 是 249（new[249]=new-item vs old[249]=id-250），加测验证
        // diff 实现按 id 比较（不是位置）—— 防回归 areItemsTheSame 误改为位置比较。
        assertFalse(diff.areItemsTheSame(249, 249))
    }

    private fun paragraph(
        id: String,
        body: String,
        isFocused: Boolean = false,
    ): TabDocBlockView.Text.Paragraph =
        TabDocBlockView.Text.Paragraph(id = id, body = body, isFocused = isFocused)

    private fun alignedParagraph(alignment: String): TabDocBlockView =
        BlockViewConverter.toBlockViews(
            listOf(
                DocBlock(
                    id = "aligned",
                    kind = BlockKind.PARAGRAPH,
                    spans = listOf(InlineSpan("same body")),
                    sourceAttributes = buildJsonObject { put("textAlign", alignment) },
                ),
            ),
        ).single()
}
