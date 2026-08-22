package com.tabtin.mobile.features.tabchat

import com.tabtin.mobile.data.model.Space
import com.tabtin.mobile.data.im.ImConversationAgentBinding
import com.tabtin.mobile.data.im.ImConversationDetail
import com.tabtin.mobile.data.im.ImConversationType
import com.tabtin.mobile.data.im.ImMember
import com.tabtin.mobile.data.im.ImMemberType
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/** 回归：群聊设置必须像桌面端一样提供独立的 Agent 成员入口。 */
class ImConversationSettingsAgentMembershipSourceTest {
    private val source = File(
        "src/main/java/com/tabtin/mobile/features/tabchat/ImConversationSettingsSheet.kt",
    ).readText()
    private val memberSheetSource = File(
        "src/main/java/com/tabtin/mobile/features/tabchat/ImConversationMembersSheet.kt",
    ).readText()
    private val conversationSource = File(
        "src/main/java/com/tabtin/mobile/features/tabchat/ImConversationScreen.kt",
    ).readText()

    @Test
    fun `group settings wires searchable Agent membership flow`() {
        assertTrue(source.contains("onSearchAgents = viewModel::searchAgents"))
        assertTrue(source.contains("onLoadAgentWorkspaces = viewModel::loadAgentWorkspaces"))
        assertTrue(source.contains("onAddAgent = viewModel::addAgentToConversation"))
        assertTrue(source.contains("R.string.im_settings_add_agent"))
        assertTrue(source.contains("SettingsRow(addAgentLabel, onAddAgent)"))
        assertTrue(source.contains("AgentMembershipPickerSheet("))
        assertTrue(memberSheetSource.contains("onAddAgent: (() -> Unit)?"))
        assertTrue(memberSheetSource.contains("R.string.im_settings_add_agent"))
        assertTrue(conversationSource.contains("ImGroupAgentMembershipPolicy.canAddAgent("))
        assertTrue(conversationSource.contains("showAgentMembershipPicker = true"))
    }

    @Test
    fun `workspace picker only exposes device backed execution workspaces`() {
        val eligible = Space(
            id = "workspace",
            organizationId = "org",
            name = "可执行",
            type = "workspace",
            controlDeviceId = "device",
        )
        val project = Space(
            id = "project",
            organizationId = "org",
            name = "项目",
            type = "team_space",
            controlDeviceId = "device",
        )
        val deviceLess = Space(
            id = "device-less",
            organizationId = "org",
            name = "未绑定设备",
            type = "workspace",
        )

        assertEquals(listOf("workspace"), selectableAgentWorkspaces(listOf(eligible, project, deviceLess)).map { it.id })
    }

    @Test
    fun `existing Agent can only be mentioned when binding is executable`() {
        val stale = ImConversationAgentBinding(
            agentId = "agent",
            workspaceId = "workspace",
            canRebind = true,
            isExecutable = false,
        )
        val executable = stale.copy(isExecutable = true)

        assertTrue(!canMentionAgentDirectly("agent", setOf("agent"), emptyList()))
        assertTrue(!canMentionAgentDirectly("agent", setOf("agent"), listOf(stale)))
        assertTrue(canMentionAgentDirectly("agent", setOf("agent"), listOf(executable)))
    }

    @Test
    fun `member management follows conversation role and Agent ownership`() {
        val admin = ImMember(userId = "admin", role = 2)
        val owner = ImMember(userId = "owner", role = 3)
        val member = ImMember(userId = "member", role = 1)
        val agent = ImMember(memberType = ImMemberType.AGENT, agentId = "agent", role = 1)
        val detail = ImConversationDetail(
            id = "group",
            type = ImConversationType.GROUP,
            members = listOf(admin, owner, member, agent),
        )

        assertTrue(ImConversationMemberManagementPolicy.canRemove(detail, "admin", member, null))
        assertFalse(ImConversationMemberManagementPolicy.canRemove(detail, "admin", owner, null))
        assertFalse(ImConversationMemberManagementPolicy.canRemove(detail, "member", admin, null))
        assertFalse(ImConversationMemberManagementPolicy.canRemove(detail, "admin", admin, null))
        assertTrue(ImConversationMemberManagementPolicy.canRemove(detail, "admin", agent, null))
        assertTrue(
            ImConversationMemberManagementPolicy.canRemove(
                detail,
                "member",
                agent,
                ImConversationAgentBinding(agentId = "agent", workspaceId = "workspace", canRebind = true),
            ),
        )
        assertFalse(
            ImConversationMemberManagementPolicy.canRemove(
                detail.copy(isTeamSpaceChannel = true),
                "admin",
                member,
                null,
            ),
        )
    }
}
