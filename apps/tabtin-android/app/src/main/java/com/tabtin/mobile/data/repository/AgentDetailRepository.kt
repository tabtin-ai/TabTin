package com.tabtin.mobile.data.repository

import com.tabtin.mobile.data.api.ChatApi
import com.tabtin.mobile.data.api.ContextApi
import com.tabtin.mobile.data.api.SkillsApi
import com.tabtin.mobile.data.model.Agent
import com.tabtin.mobile.data.model.AgentMemoryCorrectRequest
import com.tabtin.mobile.data.model.AgentMemoryLifecycleRequest
import com.tabtin.mobile.data.model.AgentMemoryRecord
import com.tabtin.mobile.data.model.AgentProjectTask
import com.tabtin.mobile.data.model.AgentSkillAttachRequest
import com.tabtin.mobile.data.model.AgentSkillEnabledRequest
import com.tabtin.mobile.data.model.AgentSkillLink
import com.tabtin.mobile.data.model.AllChatSession
import com.tabtin.mobile.data.model.OrgMcpConnection
import com.tabtin.mobile.data.model.VisibleSkillEntry
import javax.inject.Inject
import javax.inject.Singleton

/**
 * AI分身详情的按需数据源。
 *
 * 与列表用的 SpaceRepository 分开，避免列表摘要在进入详情后被高体积的记忆/任务数据污染。
 */
@Singleton
public class AgentDetailRepository @Inject constructor(
    private val contextApi: ContextApi,
    private val chatApi: ChatApi,
    private val skillsApi: SkillsApi,
) {
    public suspend fun getAgent(agentId: String): Agent = contextApi.getAgent(agentId).unwrap()

    public suspend fun getSkills(agentId: String): List<AgentSkillLink> =
        contextApi.getAgentSkills(agentId).unwrap().skills

    public suspend fun getOrgMcpConnections(organizationId: String): List<OrgMcpConnection> =
        contextApi.getOrgMcpConnections(organizationId).unwrap().connections

    public suspend fun getVisibleSkills(organizationId: String): List<VisibleSkillEntry> =
        skillsApi.getVisibleSkills(organizationId = organizationId).unwrap().skills

    public suspend fun attachSkill(agentId: String, skillKey: String): AgentSkillLink =
        contextApi.attachAgentSkill(
            agentId = agentId,
            body = AgentSkillAttachRequest(skillCanonicalKey = skillKey),
        ).unwrap()

    public suspend fun updateSkill(agentId: String, skillKey: String, enabled: Boolean): AgentSkillLink =
        contextApi.updateAgentSkill(agentId, skillKey, AgentSkillEnabledRequest(enabled)).unwrap()

    public suspend fun removeSkill(agentId: String, skillKey: String): Unit {
        contextApi.removeAgentSkill(agentId, skillKey).unwrap()
    }

    public suspend fun getMemories(organizationId: String, agentId: String): List<AgentMemoryRecord> =
        contextApi.getAgentMemories(organizationId = organizationId, agentId = agentId).unwrap().items

    public suspend fun forgetMemory(organizationId: String, agentId: String, memoryId: String): Unit {
        contextApi.forgetAgentMemory(
            memoryId = memoryId,
            body = AgentMemoryLifecycleRequest(organizationId = organizationId, agentId = agentId),
        ).unwrap()
    }

    public suspend fun correctMemory(
        organizationId: String,
        agentId: String,
        memory: AgentMemoryRecord,
        content: String,
    ): AgentMemoryRecord =
        contextApi.correctAgentMemory(
            memoryId = memory.id,
            body = AgentMemoryCorrectRequest(
                organizationId = organizationId,
                agentId = agentId,
                content = content,
                memoryType = memory.memoryType.ifBlank { null },
            ),
        ).unwrap()

    public suspend fun getSessions(organizationId: String, agentId: String): List<AllChatSession> =
        chatApi.getAllSessions(
            organizationId = organizationId,
            limit = 10,
            status = "active",
            agentId = agentId,
        ).unwrap().sessions

    public suspend fun getProjectTasks(organizationId: String, agentId: String): List<AgentProjectTask> =
        contextApi.getAgentProjectTasks(organizationId, agentId).unwrap().tasks
}
