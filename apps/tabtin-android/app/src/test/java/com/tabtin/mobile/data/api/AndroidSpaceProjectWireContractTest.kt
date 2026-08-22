package com.tabtin.mobile.data.api

import com.tabtin.mobile.data.model.CreateSessionRequest
import com.tabtin.mobile.data.model.SubAgentTemplateListResponse
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class AndroidSpaceProjectWireContractTest {

    @Test
    fun subAgentTemplateListUsesTheRawOrchestrationResponseShape() {
        val response = Json.decodeFromString<SubAgentTemplateListResponse>(
            """{"items":[{"id":"template-1","name":"Researcher"}]}""",
        )

        assertEquals("template-1", response.items.single().id)
        assertEquals("Researcher", response.items.single().name)
    }

    @Test
    fun updateSessionRequestSerializesAgentId() {
        val payload = Json.encodeToString(UpdateSessionRequest(agentId = "agent-1"))

        assertEquals("{\"agent_id\":\"agent-1\"}", payload)
    }

    @Test
    fun updateSessionRequestSerializesAgentMode() {
        val payload = Json.encodeToString(UpdateSessionRequest(agentMode = "plan"))
        assertTrue(payload.contains("\"agent_mode\""))
        assertTrue(payload.contains("\"plan\""))
        assertFalse(payload.contains("\"agent_id\""))
    }

    @Test
    fun updateSessionRequestSerializesTheRestoreStatus() {
        val payload = Json.encodeToString(UpdateSessionRequest(status = "active"))

        assertEquals("{\"status\":\"active\"}", payload)
    }

    @Test
    fun projectSessionCarriesBothExecutionAndCollaborationScopes() {
        val payload = Json.encodeToString(
            CreateSessionRequest(
                agentId = "agent-1",
                workspaceId = "workspace-1",
                projectId = "project-1",
                organizationId = "organization-1",
            ),
        )

        assertTrue(payload.contains("\"workspace_id\":\"workspace-1\""))
        assertTrue(payload.contains("\"project_id\":\"project-1\""))
    }
}
