package com.tabtin.mobile.data.api

import com.tabtin.mobile.data.model.AddMemberRequest
import com.tabtin.mobile.data.model.ApiEnvelope
import com.tabtin.mobile.data.model.CreateDirectInvitationRequest
import com.tabtin.mobile.data.model.CreateEmailInvitationRequest
import com.tabtin.mobile.data.model.CreatePhoneInvitationRequest
import com.tabtin.mobile.data.model.CreateLinkInvitationRequest
import com.tabtin.mobile.data.model.Agent
import com.tabtin.mobile.data.model.AgentMemoryCorrectRequest
import com.tabtin.mobile.data.model.AgentMemoryLifecycleRequest
import com.tabtin.mobile.data.model.AgentMemoryMutationResult
import com.tabtin.mobile.data.model.AgentMemoryRecord
import com.tabtin.mobile.data.model.AgentMemoryRecordListResponse
import com.tabtin.mobile.data.model.AgentProjectTaskListResponse
import com.tabtin.mobile.data.model.AgentSkillEnabledRequest
import com.tabtin.mobile.data.model.AgentSkillAttachRequest
import com.tabtin.mobile.data.model.AgentSkillLink
import com.tabtin.mobile.data.model.AgentSkillLinkListResponse
import com.tabtin.mobile.data.model.AgentSkillRemovalResult
import com.tabtin.mobile.data.model.AgentSkillUpdateRequest
import com.tabtin.mobile.data.model.OrgMcpConnectionListResponse
import com.tabtin.mobile.data.model.AgentListResponse
import com.tabtin.mobile.data.model.AgentTemplateListResponse
import com.tabtin.mobile.data.model.ApprovalMemoSnapshot
import com.tabtin.mobile.data.model.CreateAgentRequest
import com.tabtin.mobile.data.model.CreateBotSpaceRequest
import com.tabtin.mobile.data.model.CreateSpaceRequest
import com.tabtin.mobile.data.model.CreateOrganizationRequest
import com.tabtin.mobile.data.model.DeactivatedAgentListResponse
import com.tabtin.mobile.data.model.DeviceHeartbeatRequest
import com.tabtin.mobile.data.model.DeviceOfflineRequest
import com.tabtin.mobile.data.model.DevicePushTokenRegisterRequest
import com.tabtin.mobile.data.model.DevicePushTokenRevokeRequest
import com.tabtin.mobile.data.model.DeviceRegisterRequest
import com.tabtin.mobile.data.model.RuntimeDeviceListResponse
import com.tabtin.mobile.data.model.InvitationListResponse
import com.tabtin.mobile.data.model.InvitationRespondResponse
import com.tabtin.mobile.data.model.PendingInvitationListResponse
import com.tabtin.mobile.data.model.PendingProjectInvitationListResponse
import com.tabtin.mobile.data.model.Project
import com.tabtin.mobile.data.model.ProjectActivityListResponse
import com.tabtin.mobile.data.model.ProjectDiscussion
import com.tabtin.mobile.data.model.ProjectListResponse
import com.tabtin.mobile.data.model.ProjectMembershipListResponse
import com.tabtin.mobile.data.model.SetProjectPrimaryAgentRequest
import com.tabtin.mobile.data.model.RespondToInvitationRequest
import com.tabtin.mobile.data.model.MemberIdentitySnapshotListResponse
import com.tabtin.mobile.data.model.MemberListResponse
import com.tabtin.mobile.data.model.OrganizationMemberSearchResponse
import com.tabtin.mobile.data.model.OrganizationMemberProfile
import com.tabtin.mobile.data.model.OrganizationMemberProfilesRequest
import com.tabtin.mobile.data.model.Space
import com.tabtin.mobile.data.model.PreferredModelUpdateRequest
import com.tabtin.mobile.data.model.PreferredModelUpdateResponse
import com.tabtin.mobile.data.model.UpdateAgentRequest
import com.tabtin.mobile.data.model.SpaceListResponse
import com.tabtin.mobile.data.model.KnowledgeTreeChildrenResponse
import com.tabtin.mobile.data.model.KnowledgeTreeResponse
import com.tabtin.mobile.data.model.SpaceResourceListResponse
import com.tabtin.mobile.data.model.files.CloudDriveCollectionListResponse
import com.tabtin.mobile.data.model.files.CloudDriveSearchResponse
import com.tabtin.mobile.data.model.files.CloudDriveSharedFeedResponse
import com.tabtin.mobile.data.model.TransferOwnershipRequest
import com.tabtin.mobile.data.model.UpdateMemberRoleRequest
import com.tabtin.mobile.data.model.UpdateSpaceRequest
import com.tabtin.mobile.data.model.UpdateWorkspaceRequest
import com.tabtin.mobile.data.model.WorkspaceSummary
import com.tabtin.mobile.data.model.UpdateOrganizationRequest
import com.tabtin.mobile.data.model.WorkspaceListResponse
import com.tabtin.mobile.data.model.Organization
import com.tabtin.mobile.data.model.OrganizationListResponse
import com.tabtin.mobile.data.model.OrganizationInvitation
import com.tabtin.mobile.data.model.InvitationInfo
import com.tabtin.mobile.data.model.AcceptInvitationResponse
import com.tabtin.mobile.data.model.SearchUsersResponse
import kotlinx.serialization.json.JsonObject
import retrofit2.http.Body
import retrofit2.http.DELETE
import retrofit2.http.GET
import retrofit2.http.Header
import retrofit2.http.PATCH
import retrofit2.http.POST
import retrofit2.http.PUT
import retrofit2.http.Path
import retrofit2.http.Query
import retrofit2.http.Url

public interface ContextApi {

    // ── Organization CRUD ───────────────────────────────────

    @GET("context/organizations")
    public suspend fun getOrganizations(): ApiEnvelope<OrganizationListResponse>

    @GET("context/organizations/{id}")
    public suspend fun getOrganization(@Path("id") id: String): ApiEnvelope<Organization>

    @POST("context/organizations")
    public suspend fun createOrganization(@Body body: CreateOrganizationRequest): ApiEnvelope<Organization>

    @PUT("context/organizations/{id}")
    public suspend fun updateOrganization(
        @Path("id") id: String,
        @Body body: UpdateOrganizationRequest,
    ): ApiEnvelope<Organization>

    @DELETE("context/organizations/{id}")
    public suspend fun deleteOrganization(@Path("id") id: String): ApiEnvelope<JsonObject>

    @POST("context/organizations/{id}/leave")
    public suspend fun leaveOrganization(@Path("id") id: String): ApiEnvelope<JsonObject>

    @POST("context/organizations/{id}/transfer-ownership")
    public suspend fun transferOwnership(
        @Path("id") id: String,
        @Body body: TransferOwnershipRequest,
    ): ApiEnvelope<JsonObject>

    @GET("context/organizations/{id}/app-catalog")
    public suspend fun getOrganizationAppCatalog(
        @Path("id") organizationId: String,
    ): ApiEnvelope<com.tabtin.mobile.features.workbench.TaskWorkbenchCatalogResponse>

    @GET("context/workspaces/{id}/apps")
    public suspend fun getWorkspaceApps(
        @Path("id") workspaceId: String,
    ): ApiEnvelope<com.tabtin.mobile.features.workbench.TaskWorkbenchWorkspaceAppsResponse>

    // ── Runtime Devices ─────────────────────────────────

    @GET("context/devices/")
    public suspend fun getDevices(
        @Query("organization_id") organizationId: String,
    ): ApiEnvelope<RuntimeDeviceListResponse>

    /** 当前登录用户指定设备上的 MCP 连接器；移动市场只读展示。 */
    @GET("context/devices/{deviceId}/mcp-connections")
    public suspend fun getDeviceMcpConnections(
        @Path("deviceId") deviceId: String,
    ): ApiEnvelope<OrgMcpConnectionListResponse>

    // ── Organization Members ────────────────────────────────

    @GET("context/organizations/{id}/members")
    public suspend fun getMembers(
        @Path("id") organizationId: String,
        @Query("search") search: String? = null,
        @Query("search_mode") searchMode: String? = null,
    ): ApiEnvelope<MemberListResponse>

    /**
     * 人员选择器专用：与 [getMembers] 同路径，补齐 offset / limit / role。
     * 不改既有 [getMembers] 签名，避免成员管理页被拖进分页契约。
     */
    @GET("context/organizations/{id}/members")
    public suspend fun searchOrganizationMembers(
        @Path("id") organizationId: String,
        @Query("search") search: String? = null,
        @Query("search_mode") searchMode: String? = null,
        @Query("role") role: String? = null,
        @Query("offset") offset: Int? = null,
        @Query("limit") limit: Int? = null,
    ): ApiEnvelope<OrganizationMemberSearchResponse>

    @GET("context/organizations/{id}/members/identity-snapshots")
    public suspend fun getMemberIdentitySnapshots(
        @Path("id") organizationId: String,
    ): ApiEnvelope<MemberIdentitySnapshotListResponse>

    @POST("context/organizations/{id}/members/batch-profiles")
    public suspend fun batchMemberProfiles(
        @Path("id") organizationId: String,
        @Body body: OrganizationMemberProfilesRequest,
    ): ApiEnvelope<List<OrganizationMemberProfile>>

    @POST("context/organizations/{id}/members")
    public suspend fun addMember(
        @Path("id") organizationId: String,
        @Body body: AddMemberRequest,
    ): ApiEnvelope<JsonObject>

    @PUT("context/organizations/{wsId}/members/{userId}")
    public suspend fun updateMemberRole(
        @Path("wsId") organizationId: String,
        @Path("userId") userId: String,
        @Body body: UpdateMemberRoleRequest,
    ): ApiEnvelope<JsonObject>

    @DELETE("context/organizations/{wsId}/members/{userId}")
    public suspend fun removeMember(
        @Path("wsId") organizationId: String,
        @Path("userId") userId: String,
    ): ApiEnvelope<JsonObject>

    @GET("context/organizations/{id}/search-users")
    public suspend fun searchUsersForOrganization(
        @Path("id") organizationId: String,
        @Query("q") query: String,
    ): ApiEnvelope<SearchUsersResponse>

    // ── Invitations ──────────────────────────────────────

    @POST("context/organizations/{id}/invitations/email")
    public suspend fun createEmailInvitation(
        @Path("id") organizationId: String,
        @Body body: CreateEmailInvitationRequest,
    ): ApiEnvelope<OrganizationInvitation>

    @POST("context/organizations/{id}/invitations/phone")
    public suspend fun createPhoneInvitation(
        @Path("id") organizationId: String,
        @Body body: CreatePhoneInvitationRequest,
    ): ApiEnvelope<OrganizationInvitation>

    @POST("context/organizations/{id}/invitations/link")
    public suspend fun createLinkInvitation(
        @Path("id") organizationId: String,
        @Body body: CreateLinkInvitationRequest,
    ): ApiEnvelope<OrganizationInvitation>

    @GET("context/organizations/{id}/invitations")
    public suspend fun getInvitations(
        @Path("id") organizationId: String,
    ): ApiEnvelope<InvitationListResponse>

    @DELETE("context/organizations/{wsId}/invitations/{invId}")
    public suspend fun cancelInvitation(
        @Path("wsId") organizationId: String,
        @Path("invId") invitationId: String,
    ): ApiEnvelope<JsonObject>

    @GET("context/invitations/{token}")
    public suspend fun getInvitationInfo(
        @Path("token") token: String,
    ): ApiEnvelope<InvitationInfo>

    @POST("context/invitations/{token}/accept")
    public suspend fun acceptInvitation(
        @Path("token") token: String,
    ): ApiEnvelope<AcceptInvitationResponse>

    @POST("context/organizations/{id}/invitations/direct")
    public suspend fun createDirectInvitation(
        @Path("id") organizationId: String,
        @Body body: CreateDirectInvitationRequest,
    ): ApiEnvelope<OrganizationInvitation>

    @GET("context/invitations/my-pending")
    public suspend fun getMyPendingInvitations(): ApiEnvelope<PendingInvitationListResponse>

    @POST("context/invitations/{id}/respond")
    public suspend fun respondToInvitation(
        @Path("id") invitationId: String,
        @Body body: RespondToInvitationRequest,
    ): ApiEnvelope<InvitationRespondResponse>

    // ── Agent CRUD（/api/agents，与 Space/Workspace 的 /api/context 分离，）──

    @POST("agents")
    public suspend fun createAgent(@Body body: CreateAgentRequest): ApiEnvelope<Agent>

    @GET("agents")
    public suspend fun getAgents(
        @Query("organization_id") organizationId: String,
        @Query("page_size") pageSize: Int = 100,
    ): ApiEnvelope<AgentListResponse>

    @GET("agents/deactivated")
    public suspend fun getDeactivatedAgents(
        @Query("organization_id") organizationId: String,
    ): ApiEnvelope<DeactivatedAgentListResponse>

    @GET("agents/templates")
    public suspend fun getAgentTemplates(): ApiEnvelope<AgentTemplateListResponse>

    @GET("context/workspaces/{id}")
    public suspend fun getWorkspace(
        @Path("id") workspaceId: String,
    ): ApiEnvelope<WorkspaceSummary>

    @GET("agents/{id}")
    public suspend fun getAgent(@Path("id") id: String): ApiEnvelope<Agent>

    @PUT("agents/{id}")
    public suspend fun updateAgent(
        @Path("id") id: String,
        @Body body: UpdateAgentRequest,
    ): ApiEnvelope<Agent>

    @PATCH("agents/{id}/preferred-model")
    public suspend fun updatePreferredModel(
        @Path("id") id: String,
        @Body body: PreferredModelUpdateRequest,
    ): ApiEnvelope<PreferredModelUpdateResponse>

    @DELETE("agents/{id}")
    public suspend fun deleteAgent(@Path("id") agentId: String): ApiEnvelope<JsonObject>

    @DELETE("agents/{id}/permanent")
    public suspend fun permanentlyDeleteAgent(@Path("id") agentId: String): ApiEnvelope<JsonObject>

    @POST("agents/{id}/reactivate")
    public suspend fun reactivateAgent(@Path("id") agentId: String): ApiEnvelope<Agent>

    @GET("agents/{id}/skills")
    public suspend fun getAgentSkills(@Path("id") agentId: String): ApiEnvelope<AgentSkillLinkListResponse>

    @POST("agents/{id}/skills")
    public suspend fun attachAgentSkill(
        @Path("id") agentId: String,
        @Body body: AgentSkillAttachRequest,
    ): ApiEnvelope<AgentSkillLink>

    @PATCH("agents/{id}/skills/{skillKey}")
    public suspend fun updateAgentSkill(
        @Path("id") agentId: String,
        @Path("skillKey") skillKey: String,
        @Body body: AgentSkillEnabledRequest,
    ): ApiEnvelope<AgentSkillLink>

    @PATCH("agents/{id}/skills/{skillKey}")
    public suspend fun updateAgentSkillConfig(
        @Path("id") agentId: String,
        @Path("skillKey") skillKey: String,
        @Body body: AgentSkillUpdateRequest,
    ): ApiEnvelope<AgentSkillLink>

    @DELETE("agents/{id}/skills/{skillKey}")
    public suspend fun removeAgentSkill(
        @Path("id") agentId: String,
        @Path("skillKey") skillKey: String,
    ): ApiEnvelope<AgentSkillRemovalResult>

    @GET("agent-memory/memories/")
    public suspend fun getAgentMemories(
        @Query("organization_id") organizationId: String,
        @Query("agent_id") agentId: String,
        @Query("limit") limit: Int = 20,
        @Query("governance_view") governanceView: Boolean = true,
    ): ApiEnvelope<AgentMemoryRecordListResponse>

    @POST("agent-memory/memories/{memoryId}/forget/")
    public suspend fun forgetAgentMemory(
        @Path("memoryId") memoryId: String,
        @Body body: AgentMemoryLifecycleRequest,
    ): ApiEnvelope<AgentMemoryMutationResult>

    @POST("agent-memory/memories/{memoryId}/correct/")
    public suspend fun correctAgentMemory(
        @Path("memoryId") memoryId: String,
        @Body body: AgentMemoryCorrectRequest,
    ): ApiEnvelope<AgentMemoryRecord>

    // ── Bot Space (atomic Agent + Space creation) ─────────

    @POST("context/bot-spaces")
    public suspend fun createBotSpace(@Body body: CreateBotSpaceRequest): ApiEnvelope<Space>

    // ── Space CRUD ───────────────────────────────────────

    @GET("context/spaces")
    public suspend fun getSpaces(
        @Query("organization_id") organizationId: String,
        // 移动端 Space 页只请求个人执行现场；Project 走独立的 projects 端点。
        @Query("type") type: String = "workspace",
        @Query("is_archived") isArchived: String = "false",
    ): ApiEnvelope<SpaceListResponse>

    @GET("context/workspaces")
    public suspend fun getWorkspaces(
        @Query("organization_id") organizationId: String,
    ): ApiEnvelope<WorkspaceListResponse>

    @PATCH("context/workspaces/{id}")
    public suspend fun updateWorkspace(
        @Path("id") workspaceId: String,
        @Body body: UpdateWorkspaceRequest,
    ): ApiEnvelope<WorkspaceSummary>

    @DELETE("context/workspaces/{id}")
    public suspend fun deleteWorkspace(
        @Path("id") workspaceId: String,
        @Query("device_id") deviceId: String?,
    ): ApiEnvelope<JsonObject>

    @GET("context/spaces/{id}")
    public suspend fun getSpace(@Path("id") spaceId: String): ApiEnvelope<Space>

    @POST("context/spaces")
    public suspend fun createSpace(@Body body: CreateSpaceRequest): ApiEnvelope<Space>

    @PUT("context/spaces/{id}")
    public suspend fun updateSpace(
        @Path("id") spaceId: String,
        @Body body: UpdateSpaceRequest,
    ): ApiEnvelope<Space>

    @DELETE("context/spaces/{id}")
    public suspend fun deleteSpace(@Path("id") spaceId: String): ApiEnvelope<JsonObject>

    // ── Project（云端协作场；不承载移动端本地执行环境） ────────

    @GET("context/projects")
    public suspend fun getProjects(
        @Query("organization_id") organizationId: String,
        @Query("page") page: Int = 1,
        @Query("page_size") pageSize: Int = 100,
    ): ApiEnvelope<ProjectListResponse>

    @GET("context/projects/{id}")
    public suspend fun getProject(@Path("id") projectId: String): ApiEnvelope<Project>

    @GET("context/organizations/{organizationId}/agents/{agentId}/tasks")
    public suspend fun getAgentProjectTasks(
        @Path("organizationId") organizationId: String,
        @Path("agentId") agentId: String,
        @Query("limit") limit: Int = 10,
    ): ApiEnvelope<AgentProjectTaskListResponse>

    /** 组织级远程 MCP；挂载态不在此 API（见 LocalMcpService / ）。 */
    @GET("context/organizations/{organizationId}/mcp-connections")
    public suspend fun getOrgMcpConnections(
        @Path("organizationId") organizationId: String,
    ): ApiEnvelope<OrgMcpConnectionListResponse>

    @GET("context/projects/invitations/pending")
    public suspend fun getPendingProjectInvitations(): ApiEnvelope<PendingProjectInvitationListResponse>

    @PUT("context/projects/{id}/primary-agent")
    public suspend fun setProjectPrimaryAgent(
        @Path("id") projectId: String,
        @Body body: SetProjectPrimaryAgentRequest,
    ): ApiEnvelope<JsonObject>

    @POST("context/projects/{id}/invitations/reject")
    public suspend fun rejectProjectInvitation(@Path("id") projectId: String): ApiEnvelope<JsonObject>

    @GET("context/spaces/{id}/activities")
    public suspend fun getSpaceActivities(
        @Path("id") spaceId: String,
        @Query("page") page: Int = 1,
        @Query("limit") limit: Int = 50,
    ): ApiEnvelope<ProjectActivityListResponse>

    @GET("context/spaces/{id}/memberships")
    public suspend fun getSpaceMemberships(
        @Path("id") spaceId: String,
    ): ApiEnvelope<ProjectMembershipListResponse>

    @GET("im/conversations")
    public suspend fun getImConversations(
        @Query("organization_id") organizationId: String,
    ): ApiEnvelope<List<ProjectDiscussion>>

    // ── Space Resources ──────────────────────────────────

    @GET("context/spaces/{spaceId}/context-items")
    public suspend fun getContextItems(
        @Path("spaceId") spaceId: String,
        @Query("is_archived") isArchived: String = "false",
        @Query("page_size") pageSize: Int = 200,
        @Query("scope") scope: String = "space",
    ): ApiEnvelope<SpaceResourceListResponse>

    /**
     * 组织级云端资源列表。
     *
     * 云文档、表格和文件可以只归属于 Organization，此时服务端会返回
     * `space_id: null`；不能再用任意 Space 作为列表锚点。
     *
     * 云盘首页扩展参数（Task 5/7）：
     * - [itemTypes]：分页前白名单，如 `tabdoc,tabdata,tabfiles`
     * - [collectionId]：`root` / UUID；不传则不过滤文件夹
     * - [visitedOnly] + [sort]：最近访问（服务端排序分页）
     */
    @GET("context/organizations/{organizationId}/context-items")
    public suspend fun getOrganizationContextItems(
        @Path("organizationId") organizationId: String,
        @Query("is_archived") isArchived: String = "false",
        @Query("page") page: Int = 1,
        @Query("page_size") pageSize: Int = 100,
        @Query("item_types") itemTypes: String? = null,
        @Query("collection_id") collectionId: String? = null,
        @Query("visited_only") visitedOnly: String? = null,
        @Query("sort") sort: String? = null,
    ): ApiEnvelope<SpaceResourceListResponse>

    /** 组织级云盘搜索（标题 / 安全 preview；不承诺 PDF/Office 全文）。 */
    @GET("context/organizations/{organizationId}/search")
    public suspend fun searchOrganizationCloudDrive(
        @Path("organizationId") organizationId: String,
        @Query("q") query: String,
        @Query("types") types: String = "tabdoc,tabdata,tabfiles",
        @Query("page") page: Int = 1,
        @Query("page_size") pageSize: Int = 30,
    ): ApiEnvelope<CloudDriveSearchResponse>

    /**
     * 云盘「分享给我」统一 feed。
     * 服务端分页前聚合 tabdoc/tabdata/tabfiles；勿用无分页 shared-with-me 客户端 merge。
     */
    @GET("context/organizations/{organizationId}/cloud-drive/shared-feed")
    public suspend fun getCloudDriveSharedFeed(
        @Path("organizationId") organizationId: String,
        @Query("item_types") itemTypes: String = "tabdoc,tabdata,tabfiles",
        @Query("cursor") cursor: String? = null,
        @Query("limit") limit: Int = 30,
    ): ApiEnvelope<CloudDriveSharedFeedResponse>

    /** 当前用户在组织下的个人 Collection 文件夹树。 */
    @GET("context/organizations/{organizationId}/collections")
    public suspend fun getOrganizationCollections(
        @Path("organizationId") organizationId: String,
    ): ApiEnvelope<CloudDriveCollectionListResponse>

    /** 在 Organization 级文件夹树下新建文件夹。 */
    @POST("context/organizations/{organizationId}/collections")
    public suspend fun createOrganizationCollection(
        @Path("organizationId") organizationId: String,
        @Body body: com.tabtin.mobile.data.model.files.CloudDriveCollectionCreateRequest,
    ): ApiEnvelope<com.tabtin.mobile.data.model.files.CloudDriveCollection>

    /**
     * 重命名 / 移动文件夹。
     * body 用 JsonObject：移到根时必须显式 `"parent_id": null`（省略则保持原父级）。
     */
    @PATCH("context/collections/{collectionId}")
    public suspend fun updateCollection(
        @Path("collectionId") collectionId: String,
        @Body body: JsonObject,
    ): ApiEnvelope<com.tabtin.mobile.data.model.files.CloudDriveCollection>

    /**
     * 删除文件夹：递归删除子文件夹，内容进入回收站（强确认文案必须说清）。
     */
    @DELETE("context/collections/{collectionId}")
    public suspend fun deleteCollection(
        @Path("collectionId") collectionId: String,
    ): ApiEnvelope<JsonObject>

    /**
     * 将资源移入 / 移出 Organization 级文件夹。
     * [CloudDriveMoveItemsRequest.itemIds] 必须是 ContextItemID；
     * 共享资源移动由服务端收紧为 owner-only。
     */
    @POST("context/organizations/{organizationId}/collections/move-items")
    public suspend fun moveOrganizationCollectionItems(
        @Path("organizationId") organizationId: String,
        @Body body: com.tabtin.mobile.data.model.files.CloudDriveMoveItemsRequest,
    ): ApiEnvelope<com.tabtin.mobile.data.model.files.CloudDriveMoveItemsResponse>

    /**
     * 组织级知识树整树（Notion 式 parent 层级；与云盘 Collection 解耦）。
     * 默认只收 tabdoc / tabdata，depth 默认 2。
     */
    @GET("context/organizations/{organizationId}/knowledge-tree")
    public suspend fun getOrganizationKnowledgeTree(
        @Path("organizationId") organizationId: String,
        @Query("item_types") itemTypes: String = "tabdoc,tabdata",
        @Query("depth") depth: Int = 2,
    ): ApiEnvelope<KnowledgeTreeResponse>

    /** 懒加载知识树某节点的直接子节点；[nodeType] 必须为 tabdoc 或 tabdata。 */
    @GET("context/organizations/{organizationId}/knowledge-tree/nodes/{nodeId}/children")
    public suspend fun getOrganizationKnowledgeTreeChildren(
        @Path("organizationId") organizationId: String,
        @Path("nodeId") nodeId: String,
        @Query("node_type") nodeType: String,
        @Query("item_types") itemTypes: String = "tabdoc,tabdata",
    ): ApiEnvelope<KnowledgeTreeChildrenResponse>

    @PATCH("context/context-items/{itemId}")
    public suspend fun patchContextItem(
        @Path("itemId") itemId: String,
        @Body body: JsonObject,
    ): ApiEnvelope<JsonObject>

    /** 记录当前用户最近一次打开该资源（upsert last_visited_at）。 */
    @POST("context/context-items/{itemId}/access")
    public suspend fun recordContextItemAccess(
        @Path("itemId") itemId: String,
    ): ApiEnvelope<JsonObject>

    /** 归档 / 删除 context-item（后端 archive）。 */
    @DELETE("context/context-items/{itemId}")
    public suspend fun deleteContextItem(
        @Path("itemId") itemId: String,
    ): ApiEnvelope<JsonObject>

    // ── Devices ──────────────────────────────────────────

    @POST("context/devices/register")
    public suspend fun registerDevice(
        @Body body: DeviceRegisterRequest,
    ): ApiEnvelope<JsonObject>

    @POST("context/devices/heartbeat")
    public suspend fun heartbeatDevice(
        @Body body: DeviceHeartbeatRequest,
    ): ApiEnvelope<JsonObject>

    @POST("context/devices/offline")
    public suspend fun reportDeviceOffline(
        @Body body: DeviceOfflineRequest,
    ): ApiEnvelope<JsonObject>

    // ── Push Token（ 远程推送）────────────────────────

    @POST("context/devices/push-token")
    public suspend fun registerPushToken(
        @Body body: DevicePushTokenRegisterRequest,
    ): ApiEnvelope<JsonObject>

    @POST("context/devices/push-token/revoke")
    public suspend fun revokePushToken(
        @Body body: DevicePushTokenRevokeRequest,
        @Header("Authorization") authorization: String? = null,
    ): ApiEnvelope<JsonObject>

    // ── Trash ──────────────────────────────────────────

    @GET("context/organizations/{organizationId}/trash")
    public suspend fun getOrganizationTrashItems(
        @Path("organizationId") organizationId: String,
        @Query("page_size") pageSize: Int = 200,
    ): ApiEnvelope<com.tabtin.mobile.features.space.TrashedItemsResponse>

    /** 资源恢复/永久删除由资源模块处理；组织回收站仅负责汇总列表。 */
    @POST
    public suspend fun postTrashResourceAction(@Url path: String): ApiEnvelope<Unit>

    @DELETE
    public suspend fun deleteTrashResourceAction(@Url path: String): ApiEnvelope<Unit>

    @POST("context/organizations/{organizationId}/trash/empty")
    public suspend fun emptyOrganizationTrash(
        @Path("organizationId") organizationId: String,
    ): ApiEnvelope<Unit>

    // ── Approval Memo ────────────────────────────────────

    @GET("context/workspaces/{workspaceId}/approval-memo")
    public suspend fun getApprovalMemo(
        @Path("workspaceId") workspaceId: String,
    ): ApiEnvelope<ApprovalMemoSnapshot>

    @DELETE("context/workspaces/{workspaceId}/approval-memo/{entryKey}")
    public suspend fun deleteApprovalMemoEntry(
        @Path("workspaceId") workspaceId: String,
        @Path("entryKey") entryKey: String,
        @Header("If-Match") generation: String,
    ): ApiEnvelope<ApprovalMemoSnapshot>

    @POST("context/workspaces/{workspaceId}/approval-memo/_revoke_all")
    public suspend fun revokeAllApprovalMemos(
        @Path("workspaceId") workspaceId: String,
    ): ApiEnvelope<ApprovalMemoSnapshot>
}
