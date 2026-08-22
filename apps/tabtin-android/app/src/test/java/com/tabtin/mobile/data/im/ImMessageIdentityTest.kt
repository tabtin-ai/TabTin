package com.tabtin.mobile.data.im

import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Test

class ImMessageIdentityTest {
    @Test
    fun `realtime deduplicates matching positive id when message refs differ`() = runTest {
        val store = ImMessageStore("conv-1", NoopTransport, this)
        store.ingestRealtimeMessage(
            ImMessage(
                id = 20,
                seq = 20,
                conversationId = "conv-1",
                content = "原消息",
                metadata = ImMessageMetadata(messageRef = "11111111-1111-4111-8111-111111111111"),
            ),
        )
        store.ingestRealtimeMessage(
            ImMessage(
                id = 20,
                seq = 20,
                conversationId = "conv-1",
                content = "刷新后的消息",
                metadata = ImMessageMetadata(messageRef = "22222222-2222-4222-8222-222222222222"),
            ),
        )

        assertEquals(listOf(20), store.messages.value.map { it.id })
        assertEquals("刷新后的消息", store.messages.value.single().content)
    }

    private object NoopTransport : ImMessageTransport {
        override suspend fun fetchMessages(
            conversationId: String,
            before: Int?,
            limit: Int,
        ): List<ImMessage> = emptyList()

        override suspend fun sendMessage(
            conversationId: String,
            content: String,
            messageType: Int,
            replyToId: Int?,
            mentionedUserIds: List<String>,
            mentionedAgentIds: List<String>,
            mentionAll: Boolean,
            attachment: ImOutgoingAttachment?,
            clientRequestId: String,
        ): ImSendMessageResult = error("not used")

        override suspend fun editMessage(
            conversationId: String,
            messageId: Int,
            content: String,
        ): ImMessage = error("not used")

        override suspend fun recallMessage(conversationId: String, messageId: Int): Unit = error("not used")

        override suspend fun addReaction(
            conversationId: String,
            messageId: Int,
            emoji: String,
        ): Unit = error("not used")

        override suspend fun removeReaction(
            conversationId: String,
            messageId: Int,
            emoji: String,
        ): Unit = error("not used")

        override suspend fun markRead(conversationId: String, lastMessageId: Int): Unit = error("not used")
    }
}
