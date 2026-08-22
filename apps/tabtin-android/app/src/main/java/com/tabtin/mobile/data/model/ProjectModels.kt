package com.tabtin.mobile.data.model

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonObject

/**
 * Project 是云端团队协作场；后端物理实现仍是 Space(type=team_space)。
 * Project 自身不拥有本地目录或移动端设备，执行发生在成员自己的 companion Workspace。
 */
@Serializable
public data class Project(
    val id: String,
    @SerialName("organization_id") val organizationId: String,
    val type: String? = null,
    val name: String,
    val description: String? = null,
    val avatar: String? = null,
    val color: String? = null,
    val status: String? = null,
    @SerialName("is_archived") val isArchived: Boolean? = null,
    val visibility: String? = null,
    @SerialName("member_count") val memberCount: Int? = null,
    @SerialName("primary_agent_id") val primaryAgentId: String? = null,
    @SerialName("can_manage") val canManage: Boolean = false,
    @SerialName("last_activity_at") val lastActivityAt: String? = null,
    @SerialName("created_at") val createdAt: String? = null,
    @SerialName("updated_at") val updatedAt: String? = null,
    @SerialName("my_workspace") val myWorkspace: ProjectCompanionWorkspace? = null,
) {
    public val displayDescription: String?
        get() = description?.trim()?.takeIf { it.isNotEmpty() }
}

@Serializable
public data class ProjectCompanionWorkspace(
    val id: String,
    val name: String? = null,
    @SerialName("agent_id") val agentId: String? = null,
    @SerialName("execution_agent_id") val executionAgentId: String? = null,
    @SerialName("working_dir") val workingDir: String? = null,
    @SerialName("control_device_id") val controlDeviceId: String? = null,
    @SerialName("control_device_status") val controlDeviceStatus: String? = null,
    @SerialName("is_companion") val isCompanion: Boolean? = null,
)

@Serializable
public data class ProjectListResponse(
    val projects: List<Project> = emptyList(),
    val total: Int = 0,
)

@Serializable
public data class PendingProjectInvitation(
    @SerialName("project_id") val projectId: String,
    @SerialName("project_name") val projectName: String,
    @SerialName("organization_id") val organizationId: String,
    val role: String,
    @SerialName("inviter_name") val inviterName: String,
    @SerialName("invited_at") val invitedAt: String? = null,
)

@Serializable
public data class PendingProjectInvitationListResponse(
    val invitations: List<PendingProjectInvitation> = emptyList(),
    val total: Int = 0,
)

@Serializable
public data class ProjectDiscussion(
    val id: String,
    @SerialName("organization_id") val organizationId: String,
    @SerialName("space_id") val spaceId: String? = null,
    @SerialName("space_name") val spaceName: String? = null,
    @SerialName("is_team_space_channel") val isTeamSpaceChannel: Boolean = false,
    val name: String = "",
    @SerialName("member_count") val memberCount: Int? = null,
    @SerialName("is_archived") val isArchived: Boolean = false,
    @SerialName("last_message_at") val lastMessageAt: String? = null,
    @SerialName("last_message_preview") val lastMessagePreview: String? = null,
    @SerialName("unread_count") val unreadCount: Int = 0,
)

@Serializable
public data class ProjectActivityEvent(
    val id: String,
    @SerialName("event_type") val eventType: String,
    @SerialName("actor_user_id") val actorUserId: String? = null,
    @SerialName("actor_name") val actorName: String? = null,
    @SerialName("target_type") val targetType: String? = null,
    @SerialName("target_id") val targetId: String? = null,
    @SerialName("target_name") val targetName: String? = null,
    val metadata: JsonObject? = null,
    @SerialName("created_at") val createdAt: String,
)

@Serializable
public data class ProjectActivityListResponse(
    val items: List<ProjectActivityEvent> = emptyList(),
    val total: Int = 0,
    val page: Int = 1,
    val limit: Int = 50,
)

@Serializable
public data class ProjectMembership(
    val id: String,
    @SerialName("space_id") val spaceId: String,
    @SerialName("agent_id") val agentId: String? = null,
    @SerialName("user_id") val userId: String? = null,
    val role: String,
    @SerialName("is_active") val isActive: Boolean = true,
    @SerialName("role_label") val roleLabel: String? = null,
    val responsibility: String? = null,
    @SerialName("persona_override") val personaOverride: String? = null,
    @SerialName("is_primary") val isPrimary: Boolean = false,
    @SerialName("joined_at") val joinedAt: String? = null,
    @SerialName("updated_at") val updatedAt: String? = null,
)

@Serializable
public data class ProjectMembershipListResponse(
    val memberships: List<ProjectMembership> = emptyList(),
    val total: Int = 0,
)

public enum class ProjectParticipantKind { MEMBER, AGENT }

public data class ProjectParticipant(
    val id: String,
    val name: String,
    val kind: ProjectParticipantKind,
    val role: String,
    val roleLabel: String? = null,
    val responsibility: String? = null,
    /** 人类成员用户 id；Agent 行为 null。点成员行开私信用。 */
    val userId: String? = null,
    val agentId: String? = null,
    val ownedByCurrentUser: Boolean = false,
    val isPrimary: Boolean = false,
)

@Serializable
public data class SetProjectPrimaryAgentRequest(
    @SerialName("agent_id") val agentId: String?,
)

public data class ProjectDetailData(
    val project: Project,
    val discussions: List<ProjectDiscussion> = emptyList(),
    val assets: List<SpaceResource> = emptyList(),
    val activities: List<ProjectActivityEvent> = emptyList(),
    val participants: List<ProjectParticipant> = emptyList(),
    val hasPartialFailure: Boolean = false,
    /**
     * 详情（getProject，my_workspace 的唯一来源）本身是否加载失败。
     * 与 hasPartialFailure 区分：其它分段失败不应把「执行环境」误判为「未准备」。
     */
    val detailFailed: Boolean = false,
)
