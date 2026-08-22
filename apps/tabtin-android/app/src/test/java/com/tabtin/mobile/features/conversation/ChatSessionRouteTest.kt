package com.tabtin.mobile.features.conversation

import com.tabtin.mobile.navigation.ConversationTarget
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class ChatSessionRouteTest {

    @Test
    fun `conversation push target keeps workspace and project separate`() {
        val target = ConversationTarget(
            workspaceId = "workspace-1",
            projectId = "project-1",
            organizationId = "org-1",
            sessionId = "session-1",
        )

        assertEquals("workspace-1", target.workspaceId)
        assertEquals("project-1", target.projectId)
    }

    @Test
    fun `chat route preserves project while old payload remains decodable`() {
        val route = ChatSessionRoute(
            sessionId = "session-1",
            spaceId = "workspace-1",
            projectId = "project-1",
            organizationId = "org-1",
        )

        assertEquals("project-1", route.projectId)
        assertEquals(
            "",
            Json.decodeFromString<ChatSessionRoute>(
                """{"sessionId":"session-1","spaceId":"workspace-1"}""",
            ).projectId,
        )
    }

    @Test
    fun `entry execution scope includes canonical project context`() {
        val scope = chatSessionEntryExecutionScope(
            organizationId = "org-1",
            workspaceId = "workspace-1",
            projectId = "project-1",
        )

        assertEquals("org-1", scope.organizationId)
        assertEquals("workspace-1", scope.workspaceId)
        assertEquals("project-1", scope.projectId)
        assertNull(
            chatSessionEntryExecutionScope(
                organizationId = "org-1",
                workspaceId = "workspace-1",
                projectId = "",
            ).projectId,
        )
    }
}
