package com.tabtin.mobile.data.local

import com.tabtin.mobile.data.model.ChatMessage
import org.junit.Assert.assertEquals
import org.junit.Test

class MessageEntityTest {
    @Test
    fun cacheRoundTripPreservesMessageLevelAgentIdentity() {
        val message = ChatMessage(
            id = "assistant-identity",
            role = "assistant",
            agentId = "agent-executor",
        )

        val restored = MessageEntity.from("session-1", message).toChatMessage()

        assertEquals("agent-executor", restored.agentId)
    }
}
