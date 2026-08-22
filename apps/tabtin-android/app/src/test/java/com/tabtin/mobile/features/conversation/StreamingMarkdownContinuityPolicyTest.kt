package com.tabtin.mobile.features.conversation

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class StreamingMarkdownContinuityPolicyTest {
    private val head = "H".repeat(120)

    @Test
    fun `long streaming keeps stable identity and plain tail`() {
        val content = "$head\n\n尾巴还在增长${"t".repeat(80)}"
        val streaming = StreamingMarkdownContinuityPolicy.layout(content, isStreaming = true)

        assertTrue(streaming.hasStable)
        assertEquals(StreamingMarkdownContinuityPolicy.TailRenderer.PlainText, streaming.tailRenderer)
        assertEquals(content, streaming.stable + streaming.tail)
    }

    @Test
    fun `settled content is never split even when long or table-like`() {
        val prose = "$head\n\n尾巴还在增长${"t".repeat(80)}"
        val table = """
            | a | b |
            | --- | --- |
            | 1 | 2 |

            | c | d |
            | --- | --- |
            | 3 | 4 |
        """.trimIndent()

        for (content in listOf(prose, table)) {
            val settled = StreamingMarkdownContinuityPolicy.layout(content, isStreaming = false)
            assertEquals("", settled.stable)
            assertEquals(content, settled.tail)
            assertEquals(StreamingMarkdownContinuityPolicy.TailRenderer.Markdown, settled.tailRenderer)
        }
    }

    @Test
    fun `growing tail does not change streaming stable identity`() {
        val first = StreamingMarkdownContinuityPolicy.layout(
            "$head\n\nPara two is streaming ${"t".repeat(60)}",
            isStreaming = true,
        )
        val second = StreamingMarkdownContinuityPolicy.layout(
            "$head\n\nPara two is streaming ${"t".repeat(60)} further",
            isStreaming = true,
        )

        assertEquals(first.stableIdentity, second.stableIdentity)
        assertEquals(StreamingMarkdownContinuityPolicy.TailRenderer.PlainText, second.tailRenderer)
    }

    @Test
    fun `settle reuses streaming stable identity and only promotes the tail`() {
        val content = "$head\n\n尾巴还在增长${"t".repeat(80)}"
        val streaming = StreamingMarkdownContinuityPolicy.layout(content, isStreaming = true)
        val settled = StreamingMarkdownContinuityPolicy.layout(
            content,
            isStreaming = false,
            lastStreamingStable = streaming.stable,
        )

        assertTrue(streaming.hasStable)
        assertEquals(streaming.stableIdentity, settled.stableIdentity)
        assertEquals(streaming.stable, settled.stable)
        assertEquals(content.removePrefix(streaming.stable), settled.tail)
        assertEquals(StreamingMarkdownContinuityPolicy.TailRenderer.Markdown, settled.tailRenderer)
        assertEquals(content, settled.stable + settled.tail)
    }

    @Test
    fun `short streaming stays plain text until settle`() {
        val content = "很短的一段回复"
        val streaming = StreamingMarkdownContinuityPolicy.layout(content, isStreaming = true)
        val settled = StreamingMarkdownContinuityPolicy.layout(content, isStreaming = false)

        assertEquals("", streaming.stable)
        assertEquals(content, streaming.tail)
        assertEquals(StreamingMarkdownContinuityPolicy.TailRenderer.PlainText, streaming.tailRenderer)
        assertEquals(StreamingMarkdownContinuityPolicy.TailRenderer.Markdown, settled.tailRenderer)
    }
}
