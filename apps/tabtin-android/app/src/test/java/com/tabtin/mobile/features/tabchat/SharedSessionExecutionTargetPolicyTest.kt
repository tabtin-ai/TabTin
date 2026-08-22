package com.tabtin.mobile.features.tabchat

import com.tabtin.mobile.data.model.Agent
import com.tabtin.mobile.data.model.Space
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class SharedSessionExecutionTargetPolicyTest {
    private fun workspace(
        id: String,
        organizationId: String = "organization-1",
        type: String? = "workspace",
        isArchived: Boolean? = false,
        isDefault: Boolean? = null,
        agentId: String? = null,
    ) = Space(
        id = id,
        organizationId = organizationId,
        type = type,
        name = id,
        isArchived = isArchived,
        isDefault = isDefault,
        agentId = agentId,
    )

    private fun agent(
        id: String,
        isActive: Boolean = true,
        isDefault: Boolean? = null,
    ) = Agent(
        id = id,
        organizationId = "organization-1",
        name = id,
        isActive = isActive,
        isDefault = isDefault,
    )

    @Test
    fun `unbound default workspace remains available for fork`() {
        val candidates = SharedSessionExecutionTargetPolicy.workspaces(
            spaces = listOf(
                workspace(id = "default", isDefault = true),
                workspace(id = "archived", isArchived = true),
                workspace(id = "project", type = "team_space"),
                workspace(id = "other-org", organizationId = "organization-2"),
            ),
            organizationId = "organization-1",
        )

        assertEquals(listOf("default"), candidates.map(Space::id))
        assertNull(candidates.single().primaryAgentId)
        assertEquals("default", SharedSessionExecutionTargetPolicy.defaultWorkspace(candidates)?.id)
    }

    @Test
    fun `default active agent is preselected`() {
        val candidates = SharedSessionExecutionTargetPolicy.agents(
            agents = listOf(
                agent(id = "inactive", isActive = false),
                agent(id = "first"),
                agent(id = "default", isDefault = true),
            ),
            organizationId = "organization-1",
        )

        assertEquals(listOf("first", "default"), candidates.map(Agent::id))
        assertEquals("default", SharedSessionExecutionTargetPolicy.defaultAgent(candidates)?.id)
    }
}
