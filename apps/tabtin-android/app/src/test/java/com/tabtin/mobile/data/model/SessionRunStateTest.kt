package com.tabtin.mobile.data.model

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlinx.serialization.json.Json

class SessionRunStateTest {

    @Test
    fun `newer sequence replaces a completed older run`() {
        val completed = runState(runId = "run-1", sequence = 4, revision = 9, status = "completed")
        val nextRun = runState(runId = "run-2", sequence = 5, revision = 0, status = "queued")

        assertTrue(shouldAcceptSessionRunState(completed, nextRun))
        assertEquals(nextRun, selectNewerSessionRunState(completed, nextRun))
    }

    @Test
    fun `higher revision authoritative active update replaces terminal state from the same run`() {
        val terminal = runState(runId = "run-1", sequence = 4, revision = 3, status = "cancelled")
        val delayedRunning = runState(runId = "run-1", sequence = 4, revision = 4, status = "running")

        assertTrue(shouldAcceptSessionRunState(terminal, delayedRunning))
        assertEquals(delayedRunning, selectNewerSessionRunState(terminal, delayedRunning))
    }

    @Test
    fun `same run accepts only a strictly newer revision`() {
        val current = runState(runId = "run-1", sequence = 4, revision = 3, status = "running")
        val duplicate = runState(runId = "run-1", sequence = 4, revision = 3, status = "running")
        val terminal = runState(runId = "run-1", sequence = 4, revision = 4, status = "completed")

        assertFalse(shouldAcceptSessionRunState(current, duplicate))
        assertTrue(shouldAcceptSessionRunState(current, terminal))
    }

    @Test
    fun `malformed state is rejected before it reaches the projection`() {
        assertFalse(
            SessionRunState(
                runId = "",
                sequence = -1,
                revision = 0L,
                status = "unknown",
                queueDepth = -1,
                stateChangedAt = "",
            ).isValid,
        )
    }

    @Test
    fun `session snapshot decodes authoritative run state`() {
        val session = Json { ignoreUnknownKeys = true }.decodeFromString<ChatSession>(
            """
            {
              "id": "session-1",
              "status": "active",
              "agent_id": "agent-1",
              "run_state": {
                "run_id": "run-1",
                "sequence": 2,
                "revision": 3,
                "status": "waiting_user",
                "queue_depth": 0,
                "state_changed_at": "2026-07-30T00:00:00Z"
              }
            }
            """.trimIndent(),
        )

        assertNotNull(session.runState)
        assertEquals("waiting_user", session.runState?.status)
        assertTrue(session.runState?.isActive == true)
    }

    @Test
    fun `microsecond revision beyond Int32 decodes into Long`() {
        val session = Json { ignoreUnknownKeys = true }.decodeFromString<ChatSession>(
            """
            {
              "id": "session-1",
              "status": "active",
              "agent_id": "agent-1",
              "run_state": {
                "run_id": "run-1",
                "sequence": 1,
                "revision": 1785755188977003,
                "status": "completed",
                "queue_depth": 0,
                "state_changed_at": "2026-08-01T00:00:00Z",
                "ended_at": "2026-08-01T00:00:01Z"
              },
              "read_state": {
                "last_read_run_sequence": 0,
                "last_read_terminal_revision": 1785746801239002,
                "latest_completed_run_id": "run-1",
                "latest_completed_run_sequence": 1,
                "latest_completed_terminal_revision": 1785755188977003
              }
            }
            """.trimIndent(),
        )

        assertEquals(1785755188977003L, session.runState?.revision)
        assertEquals(1785746801239002L, session.readState?.lastReadTerminalRevision)
        assertEquals(1785755188977003L, session.readState?.latestCompletedTerminalRevision)
        assertTrue(session.readState?.hasUnreadReply == true)
    }

    private fun runState(
        runId: String,
        sequence: Int,
        revision: Int,
        status: String,
    ): SessionRunState = SessionRunState(
        runId = runId,
        sequence = sequence,
        revision = revision.toLong(),
        status = status,
        queueDepth = 0,
        stateChangedAt = "2026-07-30T00:00:00Z",
    )
}
