package com.tabtin.mobile.data.repository

import com.tabtin.mobile.data.api.ContextApi
import com.tabtin.mobile.data.model.Agent
import com.tabtin.mobile.data.model.AgentTemplate
import com.tabtin.mobile.data.model.ApprovalMemoSnapshot
import com.tabtin.mobile.data.model.CreateAgentRequest
import com.tabtin.mobile.data.model.CreateBotSpaceRequest
import com.tabtin.mobile.data.model.CreateSpaceRequest
import com.tabtin.mobile.data.model.DeactivatedAgent
import com.tabtin.mobile.data.model.RuntimeDevice
import com.tabtin.mobile.data.model.Space
import com.tabtin.mobile.data.model.ProjectMembership
import com.tabtin.mobile.data.model.UpdateAgentRequest
import com.tabtin.mobile.data.model.UpdateSpaceRequest
import com.tabtin.mobile.data.model.UpdateWorkspaceRequest
import com.tabtin.mobile.data.model.toSpace
import com.tabtin.mobile.util.TokenManager
import javax.inject.Inject
import javax.inject.Singleton

@Singleton
public class SpaceRepository @Inject constructor(
    private val contextApi: ContextApi,
    private val tokenManager: TokenManager,
) {
    private fun requireOrganizationId(): String =
        tokenManager.organizationId ?: throw IllegalStateException("No organization selected")

    /**
     * 个人执行现场列表。
     *
     *  后 `GET /context/spaces` 已退役（410 SPACE_RETIRED），
     * 移动端只走 `/context/workspaces`；团队房间走 [ProjectRepository]。
     */
    public suspend fun getSpaces(): List<Space> {
        val organizationId = requireOrganizationId()
        return contextApi.getWorkspaces(organizationId).unwrap().workspaces.map { it.toSpace() }
    }

    public suspend fun getSpace(spaceId: String): Space =
        getSpaces().firstOrNull { it.id == spaceId }
            ?: throw NoSuchElementException("Workspace not found: $spaceId")

    public suspend fun getSpaceMemberships(spaceId: String): List<ProjectMembership> =
        contextApi.getSpaceMemberships(spaceId).unwrap().memberships.filter { it.isActive }

    public suspend fun getDevices(organizationId: String = requireOrganizationId()): List<RuntimeDevice> =
        contextApi.getDevices(organizationId).unwrap().devices

    public suspend fun createSpace(
        name: String,
        description: String? = null,
        icon: String? = null,
        agentId: String? = null,
    ): Space {
        val wsId = requireOrganizationId()
        return contextApi.createSpace(
            CreateSpaceRequest(name, description, icon, wsId, agentId),
        ).unwrap()
    }

    public suspend fun updateSpace(spaceId: String, name: String? = null, description: String? = null, icon: String? = null): Space =
        contextApi.updateSpace(spaceId, UpdateSpaceRequest(name, description, icon)).unwrap()

    // ── Bot Space (atomic Agent + Space) ───────────────────

    public suspend fun createBotSpace(
        organizationId: String,
        name: String,
        description: String? = null,
    ): Space = contextApi.createBotSpace(
        CreateBotSpaceRequest(organizationId = organizationId, name = name, description = description),
    ).unwrap()

    // ── Agent CRUD ───────────────────────────────────────

    public suspend fun createAgent(request: CreateAgentRequest): Agent =
        contextApi.createAgent(request).unwrap()

    public suspend fun getAgent(agentId: String): Agent =
        contextApi.getAgent(agentId).unwrap()

    public suspend fun getAgents(): List<Agent> =
        contextApi.getAgents(requireOrganizationId()).unwrap().agents

    public suspend fun getDeactivatedAgents(): List<DeactivatedAgent> =
        contextApi.getDeactivatedAgents(requireOrganizationId()).unwrap().items

    public suspend fun getAgentTemplates(): List<AgentTemplate> =
        contextApi.getAgentTemplates().unwrap().templates

    public suspend fun updateAgent(agentId: String, request: UpdateAgentRequest): Agent =
        contextApi.updateAgent(agentId, request).unwrap()

    public suspend fun updateWorkspace(
        workspaceId: String,
        request: UpdateWorkspaceRequest,
    ): Space = contextApi.updateWorkspace(workspaceId, request).unwrap().toSpace()

    public suspend fun getWorkspace(workspaceId: String): Space =
        contextApi.getWorkspace(workspaceId).unwrap().toSpace()

    public suspend fun deleteSpace(spaceId: String) {
        contextApi.deleteSpace(spaceId).unwrap()
    }

    public suspend fun deleteWorkspace(workspaceId: String, deviceId: String?) {
        contextApi.deleteWorkspace(workspaceId, deviceId).unwrap()
    }

    public suspend fun deleteAgent(agentId: String) {
        contextApi.deleteAgent(agentId).requireSuccess()
    }

    public suspend fun permanentlyDeleteAgent(agentId: String) {
        contextApi.permanentlyDeleteAgent(agentId).requireSuccess()
    }

    public suspend fun reactivateAgent(agentId: String): Agent =
        contextApi.reactivateAgent(agentId).unwrap()

    public suspend fun getApprovalMemo(workspaceId: String): ApprovalMemoSnapshot {
        return contextApi.getApprovalMemo(workspaceId).unwrap()
    }

    public suspend fun revokeApprovalMemo(
        workspaceId: String,
        entryKey: String,
        generation: Int,
    ): ApprovalMemoSnapshot {
        return contextApi.deleteApprovalMemoEntry(
            workspaceId,
            entryKey,
            generation.toString(),
        ).unwrap()
    }

    public suspend fun revokeAllApprovalMemos(workspaceId: String): ApprovalMemoSnapshot {
        return contextApi.revokeAllApprovalMemos(workspaceId).unwrap()
    }
}
