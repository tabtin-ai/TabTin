package com.tabtin.mobile.data.model

import kotlinx.serialization.KSerializer
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.SerializationException
import kotlinx.serialization.Transient
import kotlinx.serialization.builtins.nullable
import kotlinx.serialization.builtins.serializer
import kotlinx.serialization.descriptors.SerialDescriptor
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder
import kotlinx.serialization.json.JsonDecoder
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull

// ── AgentConfig (security policy) ────────────────────────

@Serializable
public data class AgentBackendConfig(
    val type: String? = null,
    @SerialName("config_version") val configVersion: Int? = null,
)

// ── Capabilities (v2 形状, W2.1.0 决议 §2 / D2.2) ─────────
//
// agent_config v2 把 v1 顶层语义重叠字段重塑为 capabilities.overrides 7 分组：
// shell / filesystem / network / sql / cost / device / audit。
// 字段位置严格对齐 Django 端 agent_config_v2.py。

@Serializable
public data class ShellCapabilityOverride(
    @SerialName("terminal_mode") val terminalMode: String? = null,
    @SerialName("command_execution") val commandExecution: String? = null,
    @SerialName("operation_switches") val operationSwitches: Map<String, String>? = null,
    @SerialName("high_risk_requires_approval") val highRiskRequiresApproval: Boolean? = null,
)

@Serializable
public data class FilesystemCapabilityOverride(
    @SerialName("sandbox_level") val sandboxLevel: String? = null,
    @SerialName("file_access") val fileAccess: String? = null,
    @SerialName("custom_write_paths") val customWritePaths: List<String>? = null,
    @SerialName("deny_read_paths") val denyReadPaths: List<String>? = null,
    @SerialName("deny_write_paths") val denyWritePaths: List<String>? = null,
)

@Serializable
public data class NetworkCapabilityOverride(
    @SerialName("network_mode") val networkMode: String? = null,
    @SerialName("allowed_domains") val allowedDomains: List<String>? = null,
    @SerialName("denied_domains") val deniedDomains: List<String>? = null,
)

@Serializable
public data class SqlCapabilityOverride(
    @SerialName("sql_mode") val sqlMode: String? = null,
)

@Serializable
public data class CostCapabilityOverride(
    @SerialName("execution_limits") val executionLimits: ExecutionLimits? = null,
)

@Serializable
public data class DeviceCapabilityOverride(
    @SerialName("device_permissions") val devicePermissions: Map<String, String>? = null,
)

@Serializable
public data class AuditCapabilityOverride(
    @SerialName("authorization_rules") val authorizationRules: Map<String, String>? = null,
)

@Serializable
public data class CapabilityOverrides(
    val shell: ShellCapabilityOverride? = null,
    val filesystem: FilesystemCapabilityOverride? = null,
    val network: NetworkCapabilityOverride? = null,
    val sql: SqlCapabilityOverride? = null,
    val cost: CostCapabilityOverride? = null,
    val device: DeviceCapabilityOverride? = null,
    val audit: AuditCapabilityOverride? = null,
)

@Serializable
public data class CapabilitiesConfig(
    val preset: String? = null,
    val overrides: CapabilityOverrides? = null,
)

@Serializable
public data class ConversationConfig(
    @SerialName("cross_turn_memory") val crossTurnMemory: Boolean? = null,
    @SerialName("max_history_messages") val maxHistoryMessages: Int? = null,
)

/**
 * MemoryConfig v2.0：UI 只暴露两个开关
 * - enabled：总开关（控制整个 memory 系统启停）
 * - working_memory.strategy：自动摘要 Switch（auto_condense / prune_only）
 *
 * 其他子段（injection / observer / skill_evolution / maintenance / tools）走 Django defaults
 * hardcoded，UI 不暴露。透传保留以便兼容老 Electron 写入的 injection.* 字段。
 *
 * SYNC: docs/agent-runtime/memory-v2-roadmap-decision.md §4
 */
@Serializable
public data class MemoryConfig(
    val enabled: Boolean? = null,
    val version: String? = null,
    @SerialName("working_memory") val workingMemory: MemoryWorkingMemoryConfig? = null,
    val injection: MemoryInjectionConfig? = null,
)

@Serializable
public data class MemoryWorkingMemoryConfig(
    /** 'auto_condense' | 'prune_only' */
    val strategy: String? = null,
    @SerialName("pressure_threshold") val pressureThreshold: Double? = null,
    @SerialName("emergency_keep_messages") val emergencyKeepMessages: Int? = null,
    @SerialName("max_summary_tokens") val maxSummaryTokens: Int? = null,
)

@Serializable
public data class MemoryInjectionConfig(
    @SerialName("auto_inject") val autoInject: Boolean? = null,
    @SerialName("similarity_threshold") val similarityThreshold: Double? = null,
    @SerialName("max_memory_tokens") val maxMemoryTokens: Int? = null,
    @SerialName("pinned_max_ratio") val pinnedMaxRatio: Double? = null,
    @SerialName("today_session_max_ratio") val todaySessionMaxRatio: Double? = null,
    @SerialName("today_window_hours") val todayWindowHours: Int? = null,
    @SerialName("recency_half_life_days") val recencyHalfLifeDays: Int? = null,
    @SerialName("pressure_downgrade") val pressureDowngrade: Boolean? = null,
    @SerialName("error_pitfall_recall") val errorPitfallRecall: Boolean? = null,
)

// ── UserPortrait (per-Agent) ─────────────────────────────────
//
// SYNC: apps/tabtin-electron/src/renderer/src/services/userPortraitApi.ts

@Serializable
public enum class DistillStatus {
    @SerialName("idle") IDLE,
    @SerialName("pending") PENDING,
    @SerialName("failed") FAILED,
}

@Serializable
public data class UserPortrait(
    val id: String,
    @SerialName("user_id") val userId: String,
    @SerialName("organization_id") val organizationId: String,
    @SerialName("agent_id") val agentId: String = "",
    /** 5 段 markdown 叙事；空字符串表示未蒸馏 */
    @SerialName("content_md") val contentMd: String = "",
    val version: Int = 0,
    /** ISO 时间字符串；null 表示从未蒸馏 */
    @SerialName("last_distilled_at") val lastDistilledAt: String? = null,
    @SerialName("last_distill_status") val lastDistillStatus: DistillStatus = DistillStatus.IDLE,
    @SerialName("last_distill_error") val lastDistillError: String = "",
    @SerialName("pending_hints_count") val pendingHintsCount: Int = 0,
    @SerialName("memory_enabled") val memoryEnabled: Boolean = true,
    @SerialName("created_at") val createdAt: String = "",
    @SerialName("updated_at") val updatedAt: String = "",
    /** 仅 hint 端点会附带 */
    @SerialName("soft_warning") val softWarning: String? = null,
    /** 仅 hint / distill 端点会附带 */
    @SerialName("distill_dispatched") val distillDispatched: Boolean? = null,
    /** 仅 distill 端点会附带 */
    val accepted: Boolean? = null,
    /** 仅 distill 端点会附带 */
    val message: String? = null,
)

@Serializable
public data class PortraitSnapshot(
    val id: String,
    @SerialName("version_at_snapshot") val versionAtSnapshot: Int,
    @SerialName("content_md") val contentMd: String,
    @SerialName("trigger_reason") val triggerReason: String,
    @SerialName("input_summary") val inputSummary: kotlinx.serialization.json.JsonObject? = null,
    @SerialName("created_at") val createdAt: String,
)

@Serializable
public data class SnapshotListResponse(
    val items: List<PortraitSnapshot> = emptyList(),
    val count: Int = 0,
)

@Serializable
public data class SubmitHintRequest(
    val text: String,
)

@Serializable
public data class ExecutionLimits(
    @SerialName("max_iterations_per_run") val maxIterationsPerRun: Int? = null,
    @SerialName("max_credits_per_run")
    @Serializable(with = NullableStringOrNumberSerializer::class)
    val maxCreditsPerRun: String? = null,
)

/**
 * 兼容历史 Workspace JSON： 迁移可能保留 number 类型的 credits，
 * 新写入仍统一编码为 string，避免整个 Workspace 因单字段类型差异解码失败。
 */
internal object NullableStringOrNumberSerializer : KSerializer<String?> {
    override val descriptor: SerialDescriptor = String.serializer().nullable.descriptor

    override fun deserialize(decoder: Decoder): String? {
        if (decoder !is JsonDecoder) {
            return decoder.decodeSerializableValue(String.serializer().nullable)
        }
        val element = decoder.decodeJsonElement()
        return when {
            element is JsonNull -> null
            element is JsonPrimitive && (element.isString || element.booleanOrNull == null) -> element.content
            else -> throw SerializationException("Expected string, number, or null for max_credits_per_run")
        }
    }

    override fun serialize(encoder: Encoder, value: String?) {
        encoder.encodeSerializableValue(String.serializer().nullable, value)
    }
}

@Serializable
public data class AgentConfig(
    @SerialName("schema_version") val schemaVersion: Int? = null,
    @SerialName("runtime_plane") val runtimePlane: String? = null,
    val security: AgentSecurityConfig? = null,
    val capabilities: CapabilitiesConfig? = null,
    val conversation: ConversationConfig? = null,
    @SerialName("agent_backend") val agentBackend: AgentBackendConfig? = null,
    @SerialName("workspace_root") val workspaceRoot: String? = null,
    val memory: MemoryConfig? = null,
    @SerialName("approval_memo") val approvalMemo: ApprovalMemoSnapshot? = null,
)

public val AgentConfig.allowYoloMode: Boolean
    get() = security?.allowYoloMode ?: false

public val AgentConfig.executionLimits: ExecutionLimits?
    get() = capabilities?.overrides?.cost?.executionLimits

public val AgentConfig.crossTurnMemory: Boolean?
    get() = conversation?.crossTurnMemory

public val AgentConfig.maxHistoryMessages: Int?
    get() = conversation?.maxHistoryMessages

// ── Security (Hilt v3) ─────────────────

@Serializable
public data class AgentSecurityConfig(
    @SerialName("allow_yolo_mode") val allowYoloMode: Boolean? = null,
)

@Serializable
public data class ApprovalMemoEntry(
    val decision: String,
    @SerialName("created_at") val createdAt: Long? = null,
    @SerialName("updated_at") val updatedAt: Long? = null,
    @SerialName("approver_user_id") val approverUserId: String? = null,
    val reason: String? = null,
    @SerialName("scope_description") val scopeDescription: String? = null,
)

@Serializable
public data class ApprovalMemoSnapshot(
    val version: Int? = null,
    val entries: Map<String, ApprovalMemoEntry>? = null,
    val generation: Int? = null,
)

// ── Space ────────────────────────────────────────────────

@Serializable
public data class Space(
    val id: String,
    @SerialName("organization_id") val organizationId: String,
    @SerialName("agent_id") val agentId: String? = null,
    @SerialName("execution_agent_id") val executionAgentId: String? = null,
    @SerialName("execution_space_id") val executionSpaceId: String? = null,
    @SerialName("execution_binding_source") val executionBindingSource: String? = null,
    @SerialName("bound_device_id") val boundDeviceId: String? = null,
    @SerialName("control_device_id") val controlDeviceId: String? = null,
    @SerialName("working_dir") val workingDir: String = "",
    @SerialName("working_dir_type") val workingDirType: String = "",
    @SerialName("custom_rules") val customRules: String = "",
    @SerialName("execution_limits") val executionLimits: ExecutionLimits? = null,
    val name: String,
    val description: String? = null,
    val icon: String? = null,
    val avatar: String? = null,
    val color: String? = null,
    val type: String? = null,
    val status: String? = null,
    @SerialName("table_count") val tableCount: Int? = null,
    val order: Int? = null,
    @SerialName("is_archived") val isArchived: Boolean? = null,
    @SerialName("is_default") val isDefault: Boolean? = null,
    @SerialName("config_version") val configVersion: Int? = null,
    @SerialName("start_date") val startDate: String? = null,
    @SerialName("end_date") val endDate: String? = null,
    @SerialName("last_activity_at") val lastActivityAt: String? = null,
    @SerialName("created_at") val createdAt: String? = null,
    @SerialName("updated_at") val updatedAt: String? = null,
    @Transient val isWorkspaceRecord: Boolean = false,
) {
    val subtitle: String get() = description ?: ""
    /** 可执行现场。旧响应可能缺少 type，按 workspace 兼容。 */
    val isExecutionSpace: Boolean get() = type == null || type == "workspace"
    /** Project 的后端物理实现仍是 Space(type=team_space)。 */
    val isProject: Boolean get() = type == "team_space"
    /** Agent 是独立身份；这里只保存 Space 当前主要执行 Agent 的引用。 */
    val primaryAgentId: String? get() = executionAgentId ?: agentId
    /** Device 是独立执行环境；这里只保存 Space 当前执行设备的引用。 */
    val executionDeviceId: String? get() = controlDeviceId ?: boundDeviceId
}

@Serializable
public data class SpaceListResponse(
    @SerialName("spaces") val spaces: List<Space>,
    val total: Int,
)

@Serializable
public data class WorkspaceSummary(
    val id: String,
    @SerialName("organization_id") val organizationId: String,
    val name: String = "",
    @SerialName("working_dir") val workingDir: String,
    @SerialName("working_dir_type") val workingDirType: String? = null,
    @SerialName("custom_rules") val customRules: String = "",
    @SerialName("execution_limits") val executionLimits: ExecutionLimits? = null,
    @SerialName("device_id") val deviceId: String? = null,
    @SerialName("device_online") val deviceOnline: Boolean = false,
    @SerialName("is_home") val isHome: Boolean = false,
    @SerialName("agent_id") val agentId: String? = null,
    @SerialName("execution_agent_id") val executionAgentId: String? = null,
)

@Serializable
public data class WorkspaceListResponse(
    val workspaces: List<WorkspaceSummary>,
    val total: Int,
)

public fun WorkspaceSummary.toSpace(): Space = Space(
    id = id,
    organizationId = organizationId,
    name = name.ifBlank {
        workingDir.trimEnd('/', '\\')
            .substringAfterLast('/')
            .substringAfterLast('\\')
            .ifBlank { "Workspace" }
    },
    type = "workspace",
    status = "active",
    agentId = agentId,
    executionAgentId = executionAgentId,
    controlDeviceId = deviceId,
    boundDeviceId = deviceId,
    workingDir = workingDir,
    workingDirType = workingDirType.orEmpty(),
    customRules = customRules,
    executionLimits = executionLimits,
    isDefault = isHome,
    isWorkspaceRecord = true,
)

@Serializable
public data class CreateSpaceRequest(
    val name: String,
    val description: String? = null,
    val icon: String? = null,
    @SerialName("organization_id") val organizationId: String,
    @SerialName("agent_id") val agentId: String? = null,
)

@Serializable
public data class CreateBotSpaceRequest(
    @SerialName("organization_id") val organizationId: String,
    val name: String,
    val description: String? = null,
)

@Serializable
public data class UpdateSpaceRequest(
    val name: String? = null,
    val description: String? = null,
    val icon: String? = null,
)

@Serializable
public data class UpdateWorkspaceRequest(
    val name: String? = null,
    @SerialName("working_dir_type") val workingDirType: String? = null,
    @SerialName("custom_rules") val customRules: String? = null,
    @SerialName("execution_limits") val executionLimits: ExecutionLimits? = null,
)

// ── Agent ────────────────────────────────────────────────

@Serializable
public data class AgentSettings(
    @SerialName("avatar_url") val avatarUrl: String? = null,
    /** 与 iOS / Electron 共用的内置头像 key；缺失时使用 TabTin 品牌图标兜底。 */
    @SerialName("avatar_key") val avatarKey: String? = null,
)

@Serializable
public data class Agent(
    val id: String,
    @SerialName("organization_id") val organizationId: String,
    @SerialName("user_id") val userId: String? = null,
    @SerialName("owner_user_id") val ownerUserId: String? = null,
    val name: String,
    /** 展开模板占位符后的展示名；空则 UI 回退到 name。 */
    @SerialName("display_name") val displayName: String? = null,
    val type: String = "bot",
    @SerialName("is_active") val isActive: Boolean = true,
    @SerialName("is_default") val isDefault: Boolean? = null,
    @SerialName("custom_rules") val customRules: String = "",
    @SerialName("agent_config") val agentConfig: AgentConfig? = null,
    val goal: String = "",
    val keywords: List<String> = emptyList(),
    val tags: List<String> = emptyList(),
    /** 来自模板实例化时的模板 id；空表示自建。 */
    @SerialName("template_id") val templateId: String? = null,
    val icon: String? = null,
    val settings: AgentSettings? = null,
    @SerialName("bound_device_id") val boundDeviceId: String? = null,
    @SerialName("control_device_id") val controlDeviceId: String? = null,
    @SerialName("execution_agent_id") val executionAgentId: String? = null,
    @SerialName("execution_binding_source") val executionBindingSource: String? = null,
    /** Agent 在 control_device 上的工作目录绝对路径（只读展示；空串=未设置）。
     *  移动端选不了设备上的路径，仅做展示 + 决定 work_type 是否可编辑。 */
    @SerialName("working_dir") val workingDir: String = "",
    /** 运行目录类型 code/doc/mixed（驱动默认视图 + `<work_mode>` 默认执行策略）。
     *  与 working_dir 强绑定：working_dir 为空时后端不允许单独设 type。 */
    @SerialName("working_dir_type") val workingDirType: String = "",
    @SerialName("config_version") val configVersion: Int? = null,
    @SerialName("created_at") val createdAt: String = "",
    @SerialName("updated_at") val updatedAt: String = "",
)

@Serializable
public data class AgentListResponse(
    val agents: List<Agent>,
    val total: Int,
)

/** 已停用 Agent 的轻量列表项，供归档列表展示与恢复操作使用。 */
@Serializable
public data class DeactivatedAgent(
    val id: String,
    val name: String,
    val type: String = "bot",
    @SerialName("created_at") val createdAt: String? = null,
    @SerialName("deactivated_at") val deactivatedAt: String? = null,
)

@Serializable
public data class DeactivatedAgentListResponse(
    val items: List<DeactivatedAgent> = emptyList(),
    val total: Int = 0,
)

@Serializable
public data class CreateAgentRequest(
    @SerialName("organization_id") val organizationId: String,
    val name: String,
    val type: String = "bot",
    @SerialName("custom_rules") val customRules: String? = null,
    val goal: String? = null,
    @SerialName("template_id") val templateId: String? = null,
    @SerialName("avatar_key") val avatarKey: String? = null,
)

@Serializable
public data class AgentTemplate(
    val id: String,
    val version: String = "",
    val name: String,
    val icon: String = "",
    val tagline: String = "",
    val description: String = "",
    val skills: List<String> = emptyList(),
)

@Serializable
public data class AgentTemplateListResponse(
    val templates: List<AgentTemplate>,
    val total: Int,
)

@Serializable
public data class UpdateAgentRequest(
    val name: String? = null,
    @SerialName("custom_rules") val customRules: String? = null,
    val goal: String? = null,
    @SerialName("agent_config") val agentConfig: AgentConfig? = null,
    /** 仅当 Agent.working_dir 非空时可改（code/doc/mixed）。后端 AgentUpdate 接受。
     *  encodeDefaults=false → null 时不会被序列化发送。 */
    @SerialName("working_dir_type") val workingDirType: String? = null,
    @SerialName("avatar_key") val avatarKey: String? = null,
)

// ── Organization ────────────────────────────────────────────

@Serializable
public enum class OrganizationRole {
    @SerialName("viewer") VIEWER,
    @SerialName("editor") EDITOR,
    @SerialName("admin") ADMIN,
    @SerialName("owner") OWNER;

    public val canEdit: Boolean get() = this >= EDITOR
    public val canManage: Boolean get() = this >= ADMIN
    public val isOwner: Boolean get() = this == OWNER

    public val displayKey: String
        get() = when (this) {
            VIEWER -> "viewer"
            EDITOR -> "editor"
            ADMIN -> "admin"
            OWNER -> "owner"
        }
}

@Serializable
public data class OrganizationSettings(
    @SerialName("default_model") val defaultModel: String? = null,
    @SerialName("enable_tools") val enableTools: Boolean? = null,
    /** 组织准入天花板：是否允许成员在对话里使用 YOLO / 宽松审批档。缺失按未开放处理。 */
    @SerialName("allow_member_yolo") val allowMemberYolo: Boolean? = null,
    /** 组织头像的当前契约；legacy `Organization.icon` 仅保留兼容读写，不再用于头像展示。 */
    @SerialName("logo_url") val logoUrl: String? = null,
)

@Serializable
public data class Organization(
    val id: String,
    val name: String,
    val description: String? = null,
    val icon: String? = null,
    @SerialName("owner_id") val ownerId: String? = null,
    @SerialName("is_default") val isDefault: Boolean? = null,
    val type: String? = null,
    @SerialName("member_count") val memberCount: Int? = null,
    @SerialName("space_count") val spaceCount: Int? = null,
    val settings: OrganizationSettings? = null,
    @SerialName("created_at") val createdAt: String? = null,
    @SerialName("updated_at") val updatedAt: String? = null,
) {
    val isPersonal: Boolean get() = type == "personal"
    val logoUrl: String? get() = settings?.logoUrl?.trim()?.takeIf(String::isNotEmpty)
    val hasCustomLogo: Boolean get() = logoUrl != null
    /** 团队默认头像只显示名称的第一个完整字符，不复用用户头像的双首字母规则。 */
    val avatarFallbackText: String
        get() {
            val trimmed = name.trim()
            if (trimmed.isEmpty()) return "?"
            return String(Character.toChars(trimmed.codePointAt(0)))
        }
}

@Serializable
public data class OrganizationListResponse(
    val organizations: List<Organization>,
)

@Serializable
public data class MemberUser(
    val id: String? = null,
    val nickname: String? = null,
    val username: String? = null,
    val email: String? = null,
    val phone: String? = null,
    val avatar: String? = null,
)

@Serializable
public data class OrganizationMember(
    val id: String,
    @SerialName("organization_id") val organizationId: String? = null,
    @SerialName("user_id") val userId: String,
    val role: OrganizationRole,
    @SerialName("joined_at") val joinedAt: String? = null,
    val user: MemberUser? = null,
) {
    val displayName: String
        get() = user?.nickname?.takeIf { it.isNotBlank() }
            ?: user?.username?.takeIf { it.isNotBlank() }
            ?: user?.email?.takeIf { it.isNotBlank() }
            ?: userId.take(8)
}

@Serializable
public data class MemberListResponse(
    val members: List<OrganizationMember>,
)

@Serializable
public data class OrganizationMemberSearchResponse(
    val members: List<OrganizationMember> = emptyList(),
    val total: Int = 0,
)

@Serializable
public data class OrganizationMemberProfilesRequest(
    @SerialName("user_ids") val userIds: List<String>,
)

@Serializable
public data class OrganizationMemberProfile(
    val id: String,
    val nickname: String = "",
    val username: String = "",
    val avatar: String = "",
    @SerialName("avatar_version") val avatarVersion: String = "",
    val revision: Int = 0,
)

@Serializable
public data class MemberIdentitySnapshot(
    @SerialName("user_id") val userId: String,
    @SerialName("display_name") val displayName: String = "",
    @SerialName("left_at") val leftAt: String? = null,
)

@Serializable
public data class MemberIdentitySnapshotListResponse(
    val identities: List<MemberIdentitySnapshot> = emptyList(),
    val total: Int = 0,
)

@Serializable
public data class SearchUserItem(
    val id: String,
    val nickname: String = "",
    @SerialName("email_masked") val emailMasked: String = "",
    val avatar: String = "",
)

@Serializable
public data class SearchUsersResponse(
    val users: List<SearchUserItem>,
    val total: Int = 0,
)

@Serializable
public data class CreateOrganizationRequest(
    val name: String,
    val description: String? = null,
    val icon: String? = null,
)

@Serializable
public data class UpdateOrganizationRequest(
    val name: String? = null,
    val description: String? = null,
    val icon: String? = null,
    val settings: OrganizationSettings? = null,
)

@Serializable
public data class AddMemberRequest(
    @SerialName("user_id") val userId: String,
    val role: String,
)

@Serializable
public data class UpdateMemberRoleRequest(
    val role: String,
)

@Serializable
public data class TransferOwnershipRequest(
    @SerialName("new_owner_user_id") val newOwnerUserId: String,
)

// ── Invitation ───────────────────────────────────────────

@Serializable
public data class OrganizationInvitation(
    val id: String,
    @SerialName("organization_id") val organizationId: String? = null,
    @SerialName("invited_by") val invitedBy: String? = null,
    @SerialName("invite_type") val inviteType: String? = null,
    val email: String? = null,
    @SerialName("invited_user_id") val invitedUserId: String? = null,
    val role: String? = null,
    val token: String? = null,
    val status: String? = null,
    @SerialName("expires_at") val expiresAt: String? = null,
    @SerialName("max_uses") val maxUses: Int? = null,
    @SerialName("use_count") val useCount: Int? = null,
    @SerialName("created_at") val createdAt: String? = null,
)

@Serializable
public data class InvitationListResponse(
    val invitations: List<OrganizationInvitation>,
)

@Serializable
public data class CreateEmailInvitationRequest(
    val email: String,
    val role: String = "editor",
    @SerialName("expires_hours") val expiresHours: Int = 72,
)

@Serializable
public data class CreatePhoneInvitationRequest(
    val phone: String,
    val role: String = "editor",
    @SerialName("expires_hours") val expiresHours: Int = 72,
)

@Serializable
public data class CreateLinkInvitationRequest(
    val role: String = "editor",
    @SerialName("max_uses") val maxUses: Int = 10,
    @SerialName("expires_hours") val expiresHours: Int = 72,
)

@Serializable
public data class InvitationInfo(
    val valid: Boolean,
    val status: String? = null,
    //  起后端下发 organization_*；保留 workspace_* 作旧字段兜底（见 ）。
    @SerialName("organization_name") val organizationName: String? = null,
    @SerialName("organization_icon") val organizationIcon: String? = null,
    @SerialName("workspace_name") val legacyWorkspaceName: String? = null,
    @SerialName("workspace_icon") val legacyWorkspaceIcon: String? = null,
    val role: String? = null,
    @SerialName("invite_type") val inviteType: String? = null,
    @SerialName("expires_at") val expiresAt: String? = null,
) {
    val workspaceName: String? get() = organizationName ?: legacyWorkspaceName
    val workspaceIcon: String? get() = organizationIcon ?: legacyWorkspaceIcon
}

@Serializable
public data class AcceptInvitationResponse(
    //  起后端下发 organization_*；保留 workspace_* 作旧字段兜底（见 ）。
    @SerialName("organization_id") val organizationId: String? = null,
    @SerialName("workspace_id") val legacyWorkspaceId: String? = null,
    @SerialName("organization_name") val organizationName: String? = null,
    @SerialName("workspace_name") val legacyWorkspaceName: String? = null,
    val role: String? = null,
) {
    val workspaceId: String get() = organizationId ?: legacyWorkspaceId ?: ""
    val workspaceName: String? get() = organizationName ?: legacyWorkspaceName
}

@Serializable
public data class CreateDirectInvitationRequest(
    @SerialName("user_id") val userId: String,
    val role: String = "viewer",
    @SerialName("expires_hours") val expiresHours: Int = 72,
)

@Serializable
public data class PendingInvitation(
    val id: String,
    //  起后端下发 organization_*；保留 workspace_* 作旧字段兜底（见 ）。
    @SerialName("organization_id") val organizationId: String? = null,
    @SerialName("workspace_id") val legacyWorkspaceId: String? = null,
    @SerialName("organization_name") val organizationName: String? = null,
    @SerialName("workspace_name") val legacyWorkspaceName: String? = null,
    @SerialName("organization_icon") val organizationIcon: String? = null,
    @SerialName("workspace_icon") val legacyWorkspaceIcon: String? = null,
    @SerialName("invited_by") val invitedBy: String,
    @SerialName("invited_by_name") val invitedByName: String = "",
    val role: String,
    val status: String,
    @SerialName("expires_at") val expiresAt: String,
    @SerialName("created_at") val createdAt: String,
) {
    val workspaceId: String get() = organizationId ?: legacyWorkspaceId ?: ""
    val workspaceName: String get() = organizationName ?: legacyWorkspaceName ?: ""
    val workspaceIcon: String get() = organizationIcon ?: legacyWorkspaceIcon ?: ""
}

@Serializable
public data class PendingInvitationListResponse(
    val invitations: List<PendingInvitation>,
    val total: Int? = null,
)

@Serializable
public data class RespondToInvitationRequest(
    val accept: Boolean,
)

@Serializable
public data class InvitationRespondResponse(
    //  起后端下发 organization_*；保留 workspace_* 作旧字段兜底（见 ）。
    @SerialName("organization_id") val organizationId: String? = null,
    @SerialName("workspace_id") val legacyWorkspaceId: String? = null,
    @SerialName("organization_name") val organizationName: String? = null,
    @SerialName("workspace_name") val legacyWorkspaceName: String? = null,
    val status: String,
    val role: String? = null,
) {
    val workspaceId: String get() = organizationId ?: legacyWorkspaceId ?: ""
    val workspaceName: String get() = organizationName ?: legacyWorkspaceName ?: ""
}
