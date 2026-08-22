package com.tabtin.mobile.data.model

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class ConversationExecutionScopeTest {

    @Test
    fun `server workspace and project override a mismatched route entry`() {
        val scope = ConversationExecutionScope.resolvingFrozenSession(
            session = ChatSession(
                id = "session",
                organizationId = "server-org",
                workspaceId = "server-workspace",
                projectId = "server-project",
            ),
            fallbackOrganizationId = "route-org",
            fallbackWorkspaceId = "route-workspace",
        )

        assertEquals("server-org", scope.organizationId)
        assertEquals("server-workspace", scope.workspaceId)
        assertEquals("server-project", scope.projectId)
    }

    @Test
    fun `personal session does not inherit a project from its entry route`() {
        val scope = ConversationExecutionScope.resolvingFrozenSession(
            session = ChatSession(
                id = "session",
                organizationId = "org",
                workspaceId = "workspace",
                projectId = null,
            ),
            fallbackOrganizationId = "route-org",
            fallbackWorkspaceId = "route-workspace",
        )

        assertNull(scope.projectId)
    }
}
