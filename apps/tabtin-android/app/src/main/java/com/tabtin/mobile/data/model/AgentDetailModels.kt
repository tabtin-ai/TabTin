package com.tabtin.mobile.data.model

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonNames
import kotlinx.serialization.json.JsonObject

/** AI分身携带的一个技能；enabled 为用户总闸与该分身开关的合并结果。 */
@Serializable
public data class AgentSkillLink(
    @SerialName("skill_canonical_key") val skillCanonicalKey: String,
    val source: String? = null,
    val enabled: Boolean = true,
    @SerialName("agent_enabled") val agentEnabled: Boolean? = null,
    @SerialName("user_enabled") val userEnabled: Boolean? = null,
    val locked: Boolean = false,
    val name: String = "",
    val description: String? = null,
    val emoji: String? = null,
    @SerialName("config_json") val configJson: JsonObject? = null,
)

@Serializable
public data class AgentSkillLinkListResponse(
    val skills: List<AgentSkillLink> = emptyList(),
    val total: Int? = null,
)

@Serializable
public data class AgentSkillEnabledRequest(
    val enabled: Boolean,
)

/** 向某个 AI 分身添加现有目录 Skill。手机端不上传 SKILL.md 或写入密钥。 */
@Serializable
public data class AgentSkillAttachRequest(
    @SerialName("skill_canonical_key") val skillCanonicalKey: String,
    val enabled: Boolean = true,
)

/** Agent Skill 的局部变更；[configJson] 仅承载已有 credential_id 的绑定。 */
@Serializable
public data class AgentSkillUpdateRequest(
    val enabled: Boolean? = null,
    @SerialName("config_json") val configJson: JsonObject? = null,
)

@Serializable
public data class AgentSkillRemovalResult(
    @SerialName("skill_canonical_key") val skillCanonicalKey: String? = null,
    val found: Boolean? = null,
)

/**
 * 组织级远程 MCP 连接（Django LIST_ORG）。
 * 不含 Electron 本机 `attachedAgentIds`；手机端只能只读展示。
 */
@Serializable
public data class OrgMcpConnection(
    val id: String,
    val name: String = "",
    val description: String = "",
    val scope: String = "remote",
    val transport: String = "",
    val endpoint: String = "",
    val enabled: Boolean = true,
    @SerialName("organization_id") val organizationId: String? = null,
) {
    /** 组织列表仅含 remote；UI 层用 stringResource 映射展示文案。 */
    public val sourceKind: OrgMcpSourceKind
        get() = when (scope) {
            "local" -> OrgMcpSourceKind.LOCAL
            else -> OrgMcpSourceKind.ORGANIZATION
        }
}

public enum class OrgMcpSourceKind {
    ORGANIZATION,
    LOCAL,
}

@Serializable
public data class OrgMcpConnectionListResponse(
    val connections: List<OrgMcpConnection> = emptyList(),
    val total: Int? = null,
)

/** Electron 本机 MCP 来源摘要（只读）。 */
@Serializable
public data class AgentLocalMcpSource(
    val kind: String = "",
    val label: String = "",
    @SerialName("org_connection_id")
    @JsonNames("orgConnectionId")
    val orgConnectionId: String? = null,
) {
    public val isOrganization: Boolean
        get() = kind == "organization"
}

/**
 * Agent 在在线 Electron 上已挂载且启用的 MCP 摘要。
 * 字段兼容 camelCase / snake_case（Django 与 Electron 摘要可能混用）。
 */
@Serializable
public data class AgentLocalMcpAttachment(
    val id: String,
    val name: String = "",
    val description: String = "",
    @SerialName("transport_kind")
    @JsonNames("transportKind")
    val transportKind: String = "",
    val url: String? = null,
    val command: String? = null,
    val enabled: Boolean = true,
    val source: AgentLocalMcpSource? = null,
) {
    /** 品牌匹配用：HTTP 取 url。 */
    public val endpointForBrand: String?
        get() = url?.trim()?.takeIf { it.isNotEmpty() }

    public val sourceKind: OrgMcpSourceKind
        get() = if (source?.isOrganization == true) {
            OrgMcpSourceKind.ORGANIZATION
        } else {
            OrgMcpSourceKind.LOCAL
        }
}

@Serializable
public data class AgentLocalMcpAttachmentListResponse(
    val connections: List<AgentLocalMcpAttachment> = emptyList(),
)

/** AI分身作用域下的一条长期记忆。 */
@Serializable
public data class AgentMemoryRecord(
    val id: String,
    @SerialName("memory_type") val memoryType: String = "",
    val title: String = "",
    val content: String = "",
    val importance: Int? = null,
    val tags: List<String> = emptyList(),
    val state: String = "active",
    @SerialName("created_at") val createdAt: String? = null,
    @SerialName("updated_at") val updatedAt: String? = null,
)

@Serializable
public data class AgentMemoryRecordListResponse(
    val items: List<AgentMemoryRecord> = emptyList(),
    @SerialName("has_more") val hasMore: Boolean = false,
)

@Serializable
public data class AgentMemoryLifecycleRequest(
    @SerialName("organization_id") val organizationId: String,
    @SerialName("agent_id") val agentId: String,
)

@Serializable
public data class AgentMemoryCorrectRequest(
    @SerialName("organization_id") val organizationId: String,
    @SerialName("agent_id") val agentId: String,
    val content: String,
    @SerialName("memory_type") val memoryType: String? = null,
)

@Serializable
public data class AgentMemoryMutationResult(
    @SerialName("memory_id") val memoryId: String? = null,
    val forgotten: Boolean? = null,
)

@Serializable
public data class AgentProjectTaskProject(
    val id: String,
    val name: String,
)

/** Agent 跨 Project 的任务列表展示投影；其余后端字段由 JSON 忽略。 */
@Serializable
public data class AgentProjectTask(
    val id: String,
    val title: String = "",
    @SerialName("work_status") val workStatus: String? = null,
    @SerialName("assignment_status") val assignmentStatus: String? = null,
    @SerialName("updated_at") val updatedAt: String? = null,
    val project: AgentProjectTaskProject? = null,
)

@Serializable
public data class AgentProjectTaskListResponse(
    val tasks: List<AgentProjectTask> = emptyList(),
    @SerialName("has_more") val hasMore: Boolean = false,
)
