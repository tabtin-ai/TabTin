package com.tabtin.mobile.features.conversation

import com.tabtin.mobile.data.model.AllChatSession
import com.tabtin.mobile.data.model.SessionRunStatus
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class TaskHomeScopeTest {

    @Test
    fun `wire params align with iOS TaskHomeScope`() {
        assertEquals("active", TaskHomeScope.ALL.wireStatus)
        assertEquals("active", TaskHomeScope.NEEDS_YOU.wireStatus)
        assertEquals("archived", TaskHomeScope.ARCHIVED.wireStatus)
        assertEquals(SessionRunStatus.WAITING_USER, TaskHomeScope.NEEDS_YOU.wireRunStatus)
        assertEquals(SessionRunStatus.RUNNING, TaskHomeScope.RUNNING.wireRunStatus)
    }

    @Test
    fun `scope filters archived and active sessions`() {
        val active = session(status = "active")
        val archived = session(status = "archived")

        assertTrue(TaskHomeScope.ALL.matches(active))
        assertFalse(TaskHomeScope.ALL.matches(archived))
        assertTrue(TaskHomeScope.ARCHIVED.matches(archived))
        assertFalse(TaskHomeScope.ARCHIVED.matches(active))
    }

    @Test
    fun `needs you scope only matches waiting user runs`() {
        val waiting = session(runStatus = SessionRunStatus.WAITING_USER)
        val running = session(runStatus = SessionRunStatus.RUNNING)

        assertTrue(TaskHomeScope.NEEDS_YOU.matches(waiting))
        assertFalse(TaskHomeScope.NEEDS_YOU.matches(running))
    }

    private fun session(
        status: String = "active",
        runStatus: String? = null,
        hasActiveTask: Boolean = false,
    ): AllChatSession = AllChatSession(
        id = "session-1",
        status = status,
        hasActiveTask = hasActiveTask,
        runState = runStatus?.let {
            com.tabtin.mobile.data.model.SessionRunState(
                runId = "run-1",
                sequence = 1,
                revision = 1L,
                status = it,
                queueDepth = 0,
                stateChangedAt = "2026-01-01T00:00:00Z",
            )
        },
    )
}

class TaskHomeListPolicyTest {

    @Test
    fun `sanitized workspace id drops stale selection`() {
        assertEquals("ws-1", TaskHomeListPolicy.sanitizedWorkspaceId("ws-1", setOf("ws-1", "ws-2")))
        assertEquals(null, TaskHomeListPolicy.sanitizedWorkspaceId("stale", setOf("ws-1")))
    }
}
