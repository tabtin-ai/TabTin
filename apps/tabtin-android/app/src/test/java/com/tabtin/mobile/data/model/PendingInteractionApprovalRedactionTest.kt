package com.tabtin.mobile.data.model

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class PendingInteractionApprovalRedactionTest {
    @Test
    fun redactedTeamApprovalPayloadStillRendersWaitingState() {
        val interaction = PendingInteraction(
            id = "interaction-1",
            kind = "tool_approval",
            status = "pending",
            threadId = "chat-session-team",
            sessionId = "session-team",
            requestKey = "batch-team",
            source = "agent_stream",
            payload = JsonObject(
                mapOf(
                    "batch_id" to JsonPrimitive("batch-team"),
                    "approval_type" to JsonPrimitive("tool_permission"),
                    "runtime_mode" to JsonPrimitive("interactive"),
                    "schema_version" to JsonPrimitive(1),
                    "details_redacted" to JsonPrimitive(true),
                    "action_requests" to JsonArray(
                        listOf(
                            JsonObject(
                                mapOf(
                                    "request_id" to JsonPrimitive("req-team"),
                                    "tool_call_id" to JsonPrimitive("tc-team"),
                                    "tool_name" to JsonPrimitive("redacted_tool"),
                                )
                            )
                        )
                    ),
                )
            ),
            result = JsonObject(emptyMap()),
        )

        val event = interaction.toStreamEvent(activeSessionId = "session-team")

        assertTrue(event is StreamEvent.ApprovalRequested)
        val approval = event as StreamEvent.ApprovalRequested
        assertEquals("batch-team", approval.batchId)
        assertFalse(approval.resolutionAccess.canResolve)
        val action = approval.actionRequests.single()
        assertEquals("req-team", action.requestId)
        assertEquals("tc-team", action.toolCallId)
        assertEquals("redacted_tool", action.toolName)
        assertNull(action.toolInputJson)
        assertNull(action.decisionReasonType)
        assertNull(action.decisionReasonFields)
        assertEquals(listOf("once"), action.allowedScopes)
        assertEquals(listOf("allow", "deny"), action.allowedOutcomes)
    }
}
