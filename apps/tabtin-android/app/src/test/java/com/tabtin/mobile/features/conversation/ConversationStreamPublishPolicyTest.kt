package com.tabtin.mobile.features.conversation

import com.tabtin.mobile.data.model.ChatMessage
import org.junit.Assert.assertNotSame
import org.junit.Assert.assertSame
import org.junit.Assert.assertEquals
import org.junit.Test

class ConversationStreamPublishPolicyTest {
    @Test
    fun `streaming reuses prefix instances and only replaces the tip`() {
        val prefix = listOf(message("u1", "user", "问"), message("a0", "assistant", "旧"))
        val previous = prefix + message("a1", "assistant", "hello", streaming = true)
        val next = listOf(prefix[0], prefix[1], message("a1", "assistant", "hello world", streaming = true))

        val published = ConversationStreamPublishPolicy.publishedMessages(
            previous = previous,
            next = next,
            isStreaming = true,
        )

        assertEquals(3, published.size)
        assertSame(previous[0], published[0])
        assertSame(previous[1], published[1])
        assertSame(next.last(), published.last())
        assertNotSame(previous.last(), published.last())
    }

    @Test
    fun `streaming append reuses the previous list as prefix`() {
        val previous = listOf(message("u1", "user", "问"))
        val next = listOf(previous[0], message("a1", "assistant", "", streaming = true))

        val published = ConversationStreamPublishPolicy.publishedMessages(
            previous = previous,
            next = next,
            isStreaming = true,
        )

        assertEquals(2, published.size)
        assertSame(previous[0], published[0])
        assertSame(next.last(), published.last())
    }

    @Test
    fun `changed prefix instance forces a full publish`() {
        val previous = listOf(message("u1", "user", "问"), message("a1", "assistant", "hello", streaming = true))
        val next = listOf(message("u1", "user", "问（已落库）"), previous[1].copy(content = "hello world"))

        val published = ConversationStreamPublishPolicy.publishedMessages(
            previous = previous,
            next = next,
            isStreaming = true,
        )

        assertSame(next, published)
    }

    @Test
    fun `settled timeline always publishes the next snapshot`() {
        val previous = listOf(message("u1", "user", "问"), message("a1", "assistant", "hello", streaming = true))
        val next = listOf(previous[0], previous[1].copy(content = "hello", isStreaming = false))

        val published = ConversationStreamPublishPolicy.publishedMessages(
            previous = previous,
            next = next,
            isStreaming = false,
        )

        assertSame(next, published)
    }

    private fun message(
        id: String,
        role: String,
        content: String,
        streaming: Boolean = false,
    ): ChatMessage = ChatMessage(
        id = id,
        role = role,
        content = content,
        isStreaming = streaming,
    )
}
