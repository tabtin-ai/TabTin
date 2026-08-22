package com.tabtin.mobile.data.model

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.assertNull
import org.junit.Test
import kotlinx.serialization.json.Json

class SessionReadStateTest {

    @Test
    fun `only an unread completed run produces a read acknowledgment`() {
        val unread = SessionReadState(
            lastReadRunSequence = 3,
            lastReadTerminalRevision = 4L,
            latestCompletedRunId = "run-4",
            latestCompletedRunSequence = 4,
            latestCompletedTerminalRevision = 1L,
        )

        assertEquals(
            PendingSessionReadAck(
                sessionId = "session-1",
                throughRunId = "run-4",
                throughSequence = 4,
                throughRevision = 1L,
                mutationId = "mutation-1",
            ),
            unread.pendingAck(sessionId = "session-1", mutationId = "mutation-1"),
        )

        val alreadyRead = unread.copy(
            lastReadRunSequence = 4,
            lastReadTerminalRevision = 1L,
        )

        assertNull(alreadyRead.pendingAck(sessionId = "session-1", mutationId = "mutation-2"))
    }

    @Test
    fun `session snapshot carries server reading state`() {
        val session = Json { ignoreUnknownKeys = true }.decodeFromString<ChatSession>(
            """
            {
              "id": "session-1",
              "status": "active",
              "has_unread_reply": true,
              "read_state": {
                "last_read_run_sequence": 1,
                "last_read_terminal_revision": 2,
                "latest_completed_run_id": "run-2",
                "latest_completed_run_sequence": 2,
                "latest_completed_terminal_revision": 1
              }
            }
            """.trimIndent(),
        )

        assertTrue(session.hasUnreadReply)
        assertEquals("run-2", session.readState?.latestCompletedRunId)
    }

    @Test
    fun `read acknowledgment uses the server cursor field names`() {
        val request = SessionReadAckRequest(
            throughRunId = "run-2",
            throughRevision = 7L,
            mutationId = "mutation-2",
        )

        val encoded = Json.encodeToString(SessionReadAckRequest.serializer(), request)

        assertTrue(encoded.contains("\"through_run_id\":\"run-2\""))
        assertTrue(encoded.contains("\"through_revision\":7"))
        assertTrue(encoded.contains("\"mutation_id\":\"mutation-2\""))
    }
}
