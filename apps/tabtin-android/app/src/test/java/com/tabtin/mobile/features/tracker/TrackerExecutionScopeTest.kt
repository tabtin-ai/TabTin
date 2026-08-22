package com.tabtin.mobile.features.tracker

import com.tabtin.mobile.data.model.ChatSession
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class TrackerExecutionScopeTest {

    @Test
    fun `project session separates host project from execution workspace`() {
        val scope = resolveTrackerExecutionScope(
            session = ChatSession(
                id = "session-1",
                projectId = "project-1",
                spaceId = "project-1",
                workspaceId = "workspace-1",
                agentId = "agent-1",
            ),
            fallbackSpaceId = "project-fallback",
        )

        assertEquals("project-1", scope.hostSpaceId)
        assertEquals("workspace-1", scope.workspaceId)
        assertEquals("agent-1", scope.agentId)
    }

    @Test
    fun `personal session uses the same workspace for host and execution`() {
        val scope = resolveTrackerExecutionScope(
            session = ChatSession(
                id = "session-1",
                spaceId = "workspace-1",
                workspaceId = "workspace-1",
                agentId = "agent-1",
            ),
            fallbackSpaceId = "workspace-fallback",
        )

        assertEquals("workspace-1", scope.hostSpaceId)
        assertEquals("workspace-1", scope.workspaceId)
        assertEquals("agent-1", scope.agentId)
    }

    @Test
    fun `legacy personal route falls back without inventing an agent`() {
        val scope = resolveTrackerExecutionScope(
            session = null,
            fallbackSpaceId = "workspace-legacy",
        )

        assertEquals("workspace-legacy", scope.hostSpaceId)
        assertEquals("workspace-legacy", scope.workspaceId)
        assertNull(scope.agentId)
    }

    @Test
    fun `project session without execution workspace never reuses project id`() {
        val scope = resolveTrackerExecutionScope(
            session = ChatSession(
                id = "session-1",
                projectId = "project-1",
                spaceId = "project-1",
                agentId = "agent-1",
            ),
            fallbackSpaceId = "project-1",
        )

        assertEquals("project-1", scope.hostSpaceId)
        assertEquals("", scope.workspaceId)
    }
}
