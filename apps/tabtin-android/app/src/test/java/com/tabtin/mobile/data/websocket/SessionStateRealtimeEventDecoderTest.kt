package com.tabtin.mobile.data.websocket

import com.tabtin.mobile.data.model.WSEnvelope
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class SessionStateRealtimeEventDecoderTest {

    @Test
    fun `accepts legacy state events without an organization but rejects an explicit foreign organization`() {
        assertEquals(
            true,
            shouldApplySessionStateForOrganization(
                eventOrganizationId = null,
                selectedOrganizationId = "org-current",
            ),
        )
        assertEquals(
            true,
            shouldApplySessionStateForOrganization(
                eventOrganizationId = "org-current",
                selectedOrganizationId = "org-current",
            ),
        )
        assertEquals(
            false,
            shouldApplySessionStateForOrganization(
                eventOrganizationId = "org-other",
                selectedOrganizationId = "org-current",
            ),
        )
        assertEquals(
            false,
            shouldApplySessionStateForOrganization(
                eventOrganizationId = null,
                selectedOrganizationId = null,
            ),
        )
    }

    @Test
    fun `decodes the exact server run-state event name`() {
        val event = SessionStateRealtimeEventDecoder.decode(
            WSEnvelope(
                type = "chat.session.run_state.updated",
                payload = buildJsonObject {
                    put("session_id", "session-1")
                    put("organization_id", "org-1")
                    put("run_state", buildJsonObject {
                        put("run_id", "run-1")
                        put("sequence", 2)
                        put("revision", 3)
                        put("status", "running")
                        put("queue_depth", 0)
                        put("state_changed_at", "2026-07-30T00:00:00Z")
                    })
                },
            ),
        ) as SessionStateRealtimeEvent.RunStateUpdated

        assertEquals("session-1", event.sessionId)
        assertEquals("org-1", event.organizationId)
        assertEquals("running", event.runState.status)
    }

    @Test
    fun `does not misclassify an impossible legacy-prefixed state event`() {
        assertNull(
            SessionStateRealtimeEventDecoder.decode(
                WSEnvelope(type = "agent.user.session.run_state.updated"),
            ),
        )
    }

    @Test
    fun `decodes chat session activity updated for list sync`() {
        val event = SessionStateRealtimeEventDecoder.decode(
            WSEnvelope(
                type = SessionStateRealtimeEventDecoder.ACTIVITY_EVENT,
                payload = buildJsonObject {
                    put("session_id", "session-act")
                    put("organization_id", "org-1")
                    put("reason", "created")
                    put("title", "新会话")
                    put("status", "active")
                    put("workspace_id", "ws-1")
                    put("project_id", "proj-1")
                    put("agent_id", "agent-1")
                    put("last_message_at", "2026-08-01T12:00:00Z")
                    put("updated_at", "2026-08-01T11:00:00Z")
                    put("created_at", "2026-08-01T10:00:00Z")
                    put("thread_id", "chat-session-session-act")
                },
            ),
        ) as SessionStateRealtimeEvent.ActivityUpdated

        assertEquals("session-act", event.sessionId)
        assertEquals("org-1", event.organizationId)
        assertEquals("created", event.reason)
        assertEquals("新会话", event.title)
        assertEquals("active", event.status)
        assertEquals("ws-1", event.workspaceId)
        assertEquals("proj-1", event.projectId)
        assertEquals("agent-1", event.agentId)
        assertEquals("2026-08-01T12:00:00Z", event.lastMessageAt)
        assertEquals("2026-08-01T11:00:00Z", event.updatedAt)
        assertEquals("2026-08-01T10:00:00Z", event.createdAt)
        assertEquals("chat-session-session-act", event.threadId)
    }

    @Test
    fun `activity event still requires session_id`() {
        assertNull(
            SessionStateRealtimeEventDecoder.decode(
                WSEnvelope(
                    type = SessionStateRealtimeEventDecoder.ACTIVITY_EVENT,
                    payload = buildJsonObject {
                        put("organization_id", "org-1")
                        put("reason", "created")
                    },
                ),
            ),
        )
    }
}
