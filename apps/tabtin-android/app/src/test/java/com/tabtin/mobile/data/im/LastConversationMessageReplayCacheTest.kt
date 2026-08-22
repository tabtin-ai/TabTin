package com.tabtin.mobile.data.im

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class LastConversationMessageReplayCacheTest {
    @Test
    fun `remember makes latest message available for replay`() {
        val cache = LastConversationMessageReplayCache<String>()

        cache.remember("message-1", conversationId = "conversation-1")

        assertEquals("message-1", cache.replay("conversation-1"))
    }

    @Test
    fun `clear removes replay for target conversation`() {
        val cache = LastConversationMessageReplayCache<String>()
        cache.remember("message-1", conversationId = "conversation-1")

        cache.clear(conversationId = "conversation-1")

        assertNull(cache.replay("conversation-1"))
    }

    @Test
    fun `clear keeps replay for other conversations`() {
        val cache = LastConversationMessageReplayCache<String>()
        cache.remember("message-1", conversationId = "conversation-1")
        cache.remember("message-2", conversationId = "conversation-2")

        cache.clear(conversationId = "conversation-1")

        assertEquals("message-2", cache.replay("conversation-2"))
    }

    @Test
    fun `clearAll removes every replay`() {
        val cache = LastConversationMessageReplayCache<String>()
        cache.remember("message-1", conversationId = "conversation-1")
        cache.remember("message-2", conversationId = "conversation-2")

        cache.clearAll()

        assertNull(cache.replay("conversation-1"))
        assertNull(cache.replay("conversation-2"))
    }

    @Test
    fun `remember replaces previous message for the same conversation`() {
        val cache = LastConversationMessageReplayCache<String>()
        cache.remember("message-1", conversationId = "conversation-1")

        cache.remember("message-2", conversationId = "conversation-1")

        assertEquals("message-2", cache.replay("conversation-1"))
    }
}
