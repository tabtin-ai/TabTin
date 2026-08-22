package com.tabtin.mobile.features.tabchat

import com.tabtin.mobile.data.im.ImAgentSummary
import org.junit.Assert.assertEquals
import org.junit.Test

class AgentMembershipPickerPolicyTest {
    @Test
    fun `membership picker excludes Agents that are already in the group`() {
        val candidates = addableAgentMembershipCandidates(
            agents = listOf(
                ImAgentSummary(id = "agent-existing", name = "已加入"),
                ImAgentSummary(id = "agent-new", name = "新 Agent"),
            ),
            existingAgentIds = setOf("agent-existing"),
        )

        assertEquals(listOf("agent-new"), candidates.map { it.id })
    }
}
