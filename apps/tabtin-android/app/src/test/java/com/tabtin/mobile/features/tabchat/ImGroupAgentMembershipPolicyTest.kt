package com.tabtin.mobile.features.tabchat

import com.tabtin.mobile.data.im.ImConversationDetail
import com.tabtin.mobile.data.im.ImConversationType
import com.tabtin.mobile.data.im.ImMember
import com.tabtin.mobile.data.im.ImMemberType
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ImGroupAgentMembershipPolicyTest {
    @Test
    fun `group members can add Agents`() {
        assertTrue(ImGroupAgentMembershipPolicy.canAddAgent(group(role = 3), "me", false))
        assertTrue(ImGroupAgentMembershipPolicy.canAddAgent(group(role = 2), "me", false))
        assertTrue(ImGroupAgentMembershipPolicy.canAddAgent(group(role = 1), "me", false))
    }

    @Test
    fun `Agent identities cannot add Agents`() {
        assertFalse(
            ImGroupAgentMembershipPolicy.canAddAgent(
                ImConversationDetail(
                    type = ImConversationType.GROUP,
                    members = listOf(
                        ImMember(
                            memberType = ImMemberType.AGENT,
                            agentId = "me",
                            role = 3,
                        ),
                    ),
                ),
                "me",
                false,
            ),
        )
    }

    @Test
    fun `external groups and direct messages never expose Agent addition`() {
        assertFalse(ImGroupAgentMembershipPolicy.canAddAgent(group(role = 3), "me", true))
        assertFalse(
            ImGroupAgentMembershipPolicy.canAddAgent(
                group(role = 3).copy(isExternal = true),
                "me",
                false,
            ),
        )
        assertFalse(
            ImGroupAgentMembershipPolicy.canAddAgent(
                group(role = 3).copy(type = ImConversationType.DM),
                "me",
                false,
            ),
        )
        assertFalse(
            ImGroupAgentMembershipPolicy.canAddAgent(
                group(role = 3).copy(isTeamSpaceChannel = true),
                "me",
                false,
            ),
        )
    }

    private fun group(role: Int): ImConversationDetail = ImConversationDetail(
        type = ImConversationType.GROUP,
        members = listOf(ImMember(userId = "me", role = role)),
    )
}
