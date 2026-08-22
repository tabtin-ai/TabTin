package com.tabtin.mobile.data.model

import kotlinx.serialization.decodeFromString
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class WorkspaceUpdateRequestTest {

    @Test
    fun workspaceUpdatePayloadDoesNotContainTheRetiredDescriptionField() {
        val payload = Json.encodeToString(UpdateWorkspaceRequest(name = "Android Workspace"))

        assertFalse(payload.contains("\"description\""))
    }

    @Test
    fun workspaceUpdatePayloadCarriesWorkspaceOwnedRulesAndLimits() {
        val payload = Json.encodeToString(
            UpdateWorkspaceRequest(
                customRules = "仅在当前 Workspace 使用中文",
                executionLimits = ExecutionLimits(
                    maxIterationsPerRun = 24,
                    maxCreditsPerRun = "3.5",
                ),
            ),
        )
        val root = Json.parseToJsonElement(payload).jsonObject
        val limits = root.getValue("execution_limits").jsonObject

        assertEquals("仅在当前 Workspace 使用中文", root.getValue("custom_rules").jsonPrimitive.content)
        assertEquals(24, limits.getValue("max_iterations_per_run").jsonPrimitive.content.toInt())
        assertEquals("3.5", limits.getValue("max_credits_per_run").jsonPrimitive.content)
        assertTrue(limits.getValue("max_credits_per_run").jsonPrimitive.isString)
        assertFalse(root.containsKey("agent_config"))
    }

    @Test
    fun workspaceResponseAcceptsNumericCreditsFromHistoricalData() {
        val workspace = Json.decodeFromString<WorkspaceSummary>(
            """
            {
              "id": "workspace-1",
              "organization_id": "organization-1",
              "name": "历史 Workspace",
              "working_dir": "/Users/demo/history",
              "custom_rules": "保持兼容",
              "execution_limits": {
                "max_iterations_per_run": 20,
                "max_credits_per_run": 3.5
              }
            }
            """.trimIndent(),
        )

        assertEquals(20, workspace.executionLimits?.maxIterationsPerRun)
        assertEquals("3.5", workspace.executionLimits?.maxCreditsPerRun)
    }

    @Test
    fun templateCreationPayloadCarriesTemplateId() {
        val payload = Json.encodeToString(
            CreateAgentRequest(
                organizationId = "organization-1",
                name = "研究助手",
                templateId = "researcher",
                avatarKey = "web-researcher",
            ),
        )
        val root = Json.parseToJsonElement(payload).jsonObject

        assertEquals("researcher", root.getValue("template_id").jsonPrimitive.content)
        assertEquals("web-researcher", root.getValue("avatar_key").jsonPrimitive.content)
        assertTrue(root.getValue("organization_id").jsonPrimitive.content.isNotEmpty())
    }
}
