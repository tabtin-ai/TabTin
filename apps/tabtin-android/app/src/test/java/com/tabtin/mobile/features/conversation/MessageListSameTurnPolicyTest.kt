package com.tabtin.mobile.features.conversation

import com.tabtin.mobile.data.model.ChatMessage
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class MessageListSameTurnPolicyTest {
    @Test
    fun hidesIdentityOnConsecutiveAssistantBubblesInSameTurn() {
        val messages = listOf(
            ChatMessage(id = "u1", role = "user", content = "hi"),
            ChatMessage(id = "a1", role = "assistant", content = "step1", agentId = "agent-1"),
            ChatMessage(id = "a2", role = "assistant", content = "step2", agentId = "agent-1"),
        )

        assertFalse(MessageListSameTurnPolicy.shouldHideAgentIdentity(messages, 1))
        assertTrue(MessageListSameTurnPolicy.shouldHideAgentIdentity(messages, 2))
    }

    @Test
    fun showsIdentityAgainAfterUserMessage() {
        val messages = listOf(
            ChatMessage(id = "a1", role = "assistant", content = "one", agentId = "agent-1"),
            ChatMessage(id = "u2", role = "user", content = "again"),
            ChatMessage(id = "a3", role = "assistant", content = "two", agentId = "agent-1"),
        )

        assertFalse(MessageListSameTurnPolicy.shouldHideAgentIdentity(messages, 2))
    }

    @Test
    fun showsIdentityWhenAgentChanges() {
        val messages = listOf(
            ChatMessage(id = "a1", role = "assistant", content = "one", agentId = "agent-1"),
            ChatMessage(id = "a2", role = "assistant", content = "two", agentId = "agent-2"),
        )

        assertFalse(MessageListSameTurnPolicy.shouldHideAgentIdentity(messages, 1))
    }
}
