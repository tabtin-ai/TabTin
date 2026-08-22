package com.tabtin.mobile.data.repository

import com.tabtin.mobile.data.model.ChatMessage
import org.junit.Assert.assertEquals
import org.junit.Assert.assertSame
import org.junit.Test

class ChatMessageMergeTest {

    @Test
    fun `assistant delta updates existing message without duplicating timeline item`() {
        val existing = listOf(
            message(
                id = "u1",
                role = "user",
                content = "帮我总结一下",
                createdAt = "2026-06-25T10:00:00Z",
            ),
            message(
                id = "a1",
                role = "assistant",
                content = "处理中",
                createdAt = "2026-06-25T10:00:01Z",
                updatedAt = "2026-06-25T10:00:02Z",
            ),
        )
        val finalAssistant = message(
            id = "a1",
            role = "assistant",
            content = "这是最终总结",
            createdAt = "2026-06-25T10:00:01Z",
            updatedAt = "2026-06-25T10:00:10Z",
        )

        val merged = ChatMessageMerge.mergeByIdentity(existing, listOf(finalAssistant))

        assertEquals(listOf("u1", "a1"), merged.map { it.id })
        assertEquals("这是最终总结", merged[1].content)
        assertEquals("2026-06-25T10:00:10Z", merged[1].updatedAt)
    }

    @Test
    fun `server user message replaces optimistic user by client event id`() {
        val optimistic = message(
            id = "client-u1",
            role = "user",
            content = "从手机发一条消息",
            createdAt = "2026-06-25T10:00:00Z",
        )
        val server = message(
            id = "db-u1",
            role = "user",
            content = "从手机发一条消息",
            createdAt = "2026-06-25T10:00:01Z",
            clientEventId = "client-u1",
        )

        val merged = ChatMessageMerge.mergeByIdentity(listOf(optimistic), listOf(server))

        assertEquals(1, merged.size)
        assertEquals("db-u1", merged.single().id)
        assertEquals("client-u1", merged.single().clientEventId)
    }

    @Test
    fun `legacy user duplicate merges by same text inside time window`() {
        val optimistic = message(
            id = "local-user",
            role = "user",
            content = "旧端没有 client event id",
            createdAt = "2026-06-25T10:00:00Z",
        )
        val server = message(
            id = "server-user",
            role = "user",
            content = "旧端没有 client event id",
            createdAt = "2026-06-25T10:00:04Z",
        )

        val merged = ChatMessageMerge.mergeByIdentity(listOf(optimistic), listOf(server))

        assertEquals(1, merged.size)
        assertEquals("server-user", merged.single().id)
    }

    @Test
    fun `empty delta keeps existing list instance`() {
        val existing = listOf(
            message(
                id = "a1",
                role = "assistant",
                content = "已有历史",
                createdAt = "2026-06-25T10:00:00Z",
            ),
        )

        val merged = ChatMessageMerge.mergeByIdentity(existing, emptyList())

        assertSame(existing, merged)
    }

    private fun message(
        id: String,
        role: String,
        content: String,
        createdAt: String,
        updatedAt: String? = null,
        clientEventId: String? = null,
    ): ChatMessage = ChatMessage(
        id = id,
        role = role,
        content = content,
        createdAt = createdAt,
        updatedAt = updatedAt,
        clientEventId = clientEventId,
    )
}
