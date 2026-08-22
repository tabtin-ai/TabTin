package com.tabtin.mobile.data.repository

import com.tabtin.mobile.data.api.ContextApi
import com.tabtin.mobile.data.model.Agent
import com.tabtin.mobile.data.model.OrganizationMember
import com.tabtin.mobile.data.model.PendingProjectInvitation
import com.tabtin.mobile.data.model.Project
import com.tabtin.mobile.data.model.ProjectDetailData
import com.tabtin.mobile.data.model.ProjectMembership
import com.tabtin.mobile.data.model.ProjectParticipant
import com.tabtin.mobile.data.model.ProjectParticipantKind
import com.tabtin.mobile.data.model.SpaceResource
import com.tabtin.mobile.data.model.SetProjectPrimaryAgentRequest
import com.tabtin.mobile.util.TokenManager
import javax.inject.Inject
import javax.inject.Singleton
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonPrimitive

/** Project 只读协作数据层。手机端不在这里创建目录、注册执行设备或接受邀请。 */
@Singleton
public class ProjectRepository @Inject constructor(
    private val contextApi: ContextApi,
    private val tokenManager: TokenManager,
) {
    public val currentOrganizationId: String?
        get() = tokenManager.organizationId

    public suspend fun getProjects(organizationId: String = requireOrganizationId()): List<Project> =
        contextApi.getProjects(organizationId).unwrap().projects

    public suspend fun getPendingInvitations(
        organizationId: String = requireOrganizationId(),
    ): List<PendingProjectInvitation> =
        contextApi.getPendingProjectInvitations().unwrap().invitations
            .filter { it.organizationId == organizationId }

    public suspend fun setPrimaryAgent(projectId: String, agentId: String): Unit {
        contextApi.setProjectPrimaryAgent(
            projectId,
            SetProjectPrimaryAgentRequest(agentId),
        ).unwrap()
    }

    public suspend fun getDetail(seed: Project): ProjectDetailData = coroutineScope {
        val detail = async { runCatching { contextApi.getProject(seed.id).unwrap() } }
        val discussions = async {
            runCatching {
                contextApi.getImConversations(seed.organizationId).unwrap()
                    .filter { it.spaceId == seed.id && it.isTeamSpaceChannel && !it.isArchived }
                    .sortedWith(compareBy({ channelOrder(it.name) }, { it.name }))
            }
        }
        val assets = async {
            runCatching {
                contextApi.getContextItems(seed.id, pageSize = 100).unwrap().items
                    .filter(::isProjectAsset)
                    .sortedByDescending { it.updatedAt ?: it.createdAt ?: "" }
            }
        }
        val activities = async {
            runCatching { contextApi.getSpaceActivities(seed.id).unwrap().items }
        }
        val memberships = async {
            runCatching {
                contextApi.getSpaceMemberships(seed.id).unwrap().memberships.filter { it.isActive }
            }
        }
        val organizationMembers = async {
            runCatching { contextApi.getMembers(seed.organizationId).unwrap().members }
        }

        val detailResult = detail.await()
        val discussionResult = discussions.await()
        val assetResult = assets.await()
        val activityResult = activities.await()
        val membershipResult = memberships.await()
        val memberResult = organizationMembers.await()

        val activeMemberships = membershipResult.getOrDefault(emptyList())
        val agentsById = loadAgents(activeMemberships.mapNotNull { it.agentId }.distinct())
        val participants = makeParticipants(
            memberships = activeMemberships,
            organizationMembers = memberResult.getOrDefault(emptyList()),
            agentsById = agentsById,
        )

        ProjectDetailData(
            project = detailResult.getOrDefault(seed),
            discussions = discussionResult.getOrDefault(emptyList()),
            assets = assetResult.getOrDefault(emptyList()),
            activities = activityResult.getOrDefault(emptyList()),
            participants = participants,
            hasPartialFailure = listOf(
                detailResult,
                discussionResult,
                assetResult,
                activityResult,
                membershipResult,
                memberResult,
            ).any { it.isFailure },
            detailFailed = detailResult.isFailure,
        )
    }

    private suspend fun loadAgents(ids: List<String>): Map<String, Agent> = coroutineScope {
        ids.map { id ->
            async { runCatching { contextApi.getAgent(id).unwrap() }.getOrNull() }
        }.awaitAll().filterNotNull().associateBy { it.id }
    }

    private fun makeParticipants(
        memberships: List<ProjectMembership>,
        organizationMembers: List<OrganizationMember>,
        agentsById: Map<String, Agent>,
    ): List<ProjectParticipant> {
        val membersByUserId = organizationMembers.associateBy { it.userId }
        return memberships.mapNotNull { membership ->
            when {
                membership.userId != null -> ProjectParticipant(
                    id = membership.id,
                    name = membersByUserId[membership.userId]?.displayName ?: membership.userId,
                    kind = ProjectParticipantKind.MEMBER,
                    role = membership.role,
                    roleLabel = membership.roleLabel,
                    responsibility = membership.responsibility,
                    userId = membership.userId,
                )
                membership.agentId != null -> ProjectParticipant(
                    id = membership.id,
                    name = agentsById[membership.agentId]?.name?.takeIf { it.isNotBlank() } ?: "Agent",
                    kind = ProjectParticipantKind.AGENT,
                    role = membership.role,
                    roleLabel = membership.roleLabel,
                    responsibility = membership.responsibility,
                    agentId = membership.agentId,
                    ownedByCurrentUser = agentsById[membership.agentId]?.let { agent ->
                        val currentUserId = tokenManager.userId
                        currentUserId != null && (agent.userId == currentUserId || agent.ownerUserId == currentUserId)
                    } == true,
                    isPrimary = membership.isPrimary,
                )
                else -> null
            }
        }.sortedWith(
            compareBy<ProjectParticipant> { it.kind != ProjectParticipantKind.MEMBER }
                .thenBy(String.CASE_INSENSITIVE_ORDER) { it.name },
        )
    }

    private fun isProjectAsset(item: SpaceResource): Boolean {
        if (item.isArchived == true) return false
        val assetKind = item.metadata?.get("asset_kind")?.jsonPrimitive?.contentOrNull.orEmpty()
        if (item.itemType == "ai_final_answer" || assetKind == "ai_final_answer") return false
        val sourceKind = (item.metadata?.get("asset_source") as? JsonObject)
            ?.get("kind")?.jsonPrimitive?.contentOrNull.orEmpty()
        return item.normalizedType == "tabfiles" ||
            (item.normalizedType == "tabdoc" && assetKind == "tabdoc") ||
            assetKind.isNotEmpty() ||
            sourceKind == "member_upload" ||
            sourceKind == "ai_deliverable"
    }

    private fun requireOrganizationId(): String =
        tokenManager.organizationId ?: throw IllegalStateException("No organization selected")

    private companion object {
        fun channelOrder(name: String): Int = when (name) {
            "#general" -> 0
            "#agent-updates" -> 1
            else -> 100
        }
    }
}
