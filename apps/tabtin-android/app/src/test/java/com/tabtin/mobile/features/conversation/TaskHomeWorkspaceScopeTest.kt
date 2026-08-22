package com.tabtin.mobile.features.conversation

import com.tabtin.mobile.data.model.AllChatSession
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class TaskHomeWorkspaceScopeTest {

    @Test
    fun `task session uses execution workspace instead of project scope`() {
        val session = AllChatSession(
            id = "session-1",
            workspaceId = "workspace-1",
            spaceId = "project-1",
        )

        assertEquals("workspace-1", session.taskExecutionWorkspaceId)
    }

    @Test
    fun `task session without execution workspace is not routed through project scope`() {
        val session = AllChatSession(
            id = "session-1",
            workspaceId = null,
            spaceId = "project-1",
        )

        assertNull(session.taskExecutionWorkspaceId)
        assertEquals(UNKNOWN_TASK_WORKSPACE_SECTION_ID, taskWorkspaceSectionId(session))
    }
}
