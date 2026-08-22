package com.tabtin.mobile.features.conversation

import com.tabtin.mobile.data.model.ChatMessage
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class MessageQuoteTest {
    @Test
    fun `assistant reply can be quoted into composer`() {
        val message = ChatMessage(id = "a1", role = "assistant", content = "第一行\n第二行")
        assertEquals("> Agent：\n> 第一行\n> 第二行\n\n", MessageQuote.payload(message))
    }

    @Test
    fun `composer quote is parsed separately from editable reply`() {
        val draft = "> Agent：\n> 第一行\n> 第二行\n\n我的回复"

        val quote = MessageQuote.parseComposerDraft(draft)

        assertEquals("Agent", quote?.author)
        assertEquals("第一行\n第二行", quote?.content)
        assertEquals("我的回复", quote?.reply)
    }

    @Test
    fun `quoting another message replaces the current composer quote`() {
        val current = "> Agent：\n> 旧内容\n\n已有回复"
        val message = ChatMessage(id = "u1", role = "user", content = "新内容")

        assertEquals("> 我：\n> 新内容\n\n已有回复", MessageQuote.replacingComposerQuote(current, message))
    }

    @Test
    fun `composer quote can be removed without changing the reply`() {
        val current = "> Agent：\n> 引用内容\n\n已有回复"

        assertEquals("已有回复", MessageQuote.removingComposerQuote(current))
    }

    @Test
    fun `empty and streaming replies cannot be quoted`() {
        assertNull(MessageQuote.payload(ChatMessage(id = "a1", role = "assistant", content = "  ")))
        assertNull(MessageQuote.payload(ChatMessage(id = "a2", role = "assistant", content = "未完成", isStreaming = true)))
    }
}
