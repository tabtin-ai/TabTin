package com.tabtin.mobile.features.conversation

import com.tabtin.mobile.data.model.AllChatSession
import com.tabtin.mobile.data.repository.SessionListActivityUpdate
import org.junit.Assert.assertEquals
import org.junit.Test

class AllConversationsActivityPolicyTest {

    @Test
    fun `upserts unknown session and sorts by lastMessageAt`() {
        val existing = listOf(
            AllChatSession(
                id = "old",
                title = "旧",
                lastMessageAt = "2026-07-01T10:00:00Z",
            ),
        )
        val result = AllConversationsActivityPolicy.upsertAndReorder(
            existing,
            activity(
                sessionId = "new",
                title = "新",
                lastMessageAt = "2026-08-01T12:00:00Z",
                workspaceId = "ws-1",
            ),
        )
        assertEquals(listOf("new", "old"), result.map { it.id })
        assertEquals("新", result.first().title)
        assertEquals("ws-1", result.first().workspaceId)
        assertEquals("ws-1", result.first().spaceId)
    }

    @Test
    fun `bumps existing session to front without dropping run fields`() {
        val existing = listOf(
            AllChatSession(
                id = "a",
                title = "A",
                lastMessageAt = "2026-08-01T12:00:00Z",
                hasActiveTask = true,
            ),
            AllChatSession(
                id = "b",
                title = "B",
                lastMessageAt = "2026-07-01T10:00:00Z",
                hasActiveTask = false,
            ),
        )
        val result = AllConversationsActivityPolicy.upsertAndReorder(
            existing,
            activity(
                sessionId = "b",
                lastMessageAt = "2026-08-01T13:00:00Z",
                title = null,
            ),
        )
        assertEquals(listOf("b", "a"), result.map { it.id })
        assertEquals("B", result.first().title)
        assertEquals(false, result.first().hasActiveTask)
    }

    @Test
    fun `removes archived session from active list`() {
        val existing = listOf(
            AllChatSession(id = "keep", title = "Keep"),
            AllChatSession(id = "gone", title = "Gone"),
        )
        val result = AllConversationsActivityPolicy.upsertAndReorder(
            existing,
            activity(sessionId = "gone", status = "archived"),
        )
        assertEquals(listOf("keep"), result.map { it.id })
    }

    private fun activity(
        sessionId: String,
        title: String? = "t",
        status: String? = "active",
        lastMessageAt: String? = null,
        workspaceId: String? = null,
    ) = SessionListActivityUpdate(
        sessionId = sessionId,
        organizationId = "org-1",
        reason = "message",
        title = title,
        status = status,
        workspaceId = workspaceId,
        projectId = null,
        agentId = null,
        lastMessageAt = lastMessageAt,
        updatedAt = lastMessageAt,
        createdAt = null,
        threadId = null,
    )
}
