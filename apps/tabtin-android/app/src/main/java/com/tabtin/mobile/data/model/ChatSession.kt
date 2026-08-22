package com.tabtin.mobile.data.model

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonObject

@Serializable
public data class ChatSession(
    val id: String,
    val title: String? = null,
    val status: String? = null,
    @SerialName("is_paused") val isPaused: Boolean = false,
    @SerialName("organization_id") val organizationId: String? = null,
    @SerialName("workspace_id") val workspaceId: String? = null,
    @SerialName("project_id") val projectId: String? = null,
    @SerialName("space_id") val spaceId: String? = null,
    @SerialName("agent_id") val agentId: String? = null,
    @SerialName("agent_mode") val agentMode: String? = null,
    @SerialName("approval_mode") val approvalMode: String? = null,
    @SerialName("thread_id") val threadId: String? = null,
    @SerialName("current_model_id") val currentModelId: String? = null,
    @SerialName("current_model_name") val currentModelName: String? = null,
    @SerialName("default_model_id") val defaultModelId: String? = null,
    @SerialName("default_model_name") val defaultModelName: String? = null,
    /** 会话当前上下文档位；null / 缺省 = Catalog 默认档。 */
    @SerialName("context_tier_id") val contextTierId: String? = null,
    /**
     * 会话级模型参数意图（v2 只读 `thinking_mode`）。
     * 用 JsonObject 保留未知键，避免旧客户端丢字段。
     */
    @SerialName("model_param_overrides") val modelParamOverrides: JsonObject? = null,
    @SerialName("created_at") val createdAt: String? = null,
    @SerialName("updated_at") val updatedAt: String? = null,
    @SerialName("last_message_at") val lastMessageAt: String? = null,
    @SerialName("message_count") val messageCount: Int? = 0,
    @SerialName("forked_from_id") val forkedFromId: String? = null,
    @SerialName("fork_point_message_id") val forkPointMessageId: String? = null,
    @SerialName("fork_count") val forkCount: Int? = 0,
    @SerialName("has_active_task") val hasActiveTask: Boolean = false,
    @SerialName("has_unread_reply") val hasUnreadReply: Boolean = false,
    @SerialName("last_run_failed") val lastRunFailed: Boolean = false,
    @SerialName("run_state") val runState: SessionRunState? = null,
    @SerialName("read_state") val readState: SessionReadState? = null,
    @SerialName("rollback_state") val rollbackState: SessionRollbackState? = null,
) {
    val isActive: Boolean get() = status == "active"
    val displayTitle: String get() = title.takeIf { !it.isNullOrBlank() } ?: ""
}

@Serializable
public data class ChatSessionListResponse(
    val sessions: List<ChatSession>,
    val total: Int,
)

@Serializable
public data class ForkSessionRequest(
    @SerialName("message_id") val messageId: String? = null,
)

@Serializable
public data class CreateSessionRequest(
    /** 客户端生成的 UUID；首发重试复用它，作为服务端创建幂等键。 */
    @SerialName("session_id") val sessionId: String? = null,
    @SerialName("agent_id") val agentId: String,
    @SerialName("workspace_id") val workspaceId: String? = null,
    @SerialName("project_id") val projectId: String? = null,
    @SerialName("organization_id") val organizationId: String,
    @SerialName("model_id") val modelId: String? = null,
    @SerialName("agent_mode") val agentMode: String? = null,
    @SerialName("approval_mode") val approvalMode: String? = null,
)

@Serializable
public data class CreateSessionResponse(
    val id: String,
)

@Serializable
public data class SwitchSessionModelRequest(
    @SerialName("model_id") val modelId: String,
    /** 同时切换上下文档位；缺省时后端按新模型能力保留或清空。 */
    @SerialName("context_tier_id") val contextTierId: String? = null,
)

@Serializable
public data class SwitchSessionModelResponse(
    val success: Boolean,
    @SerialName("session_id") val sessionId: String,
    @SerialName("previous_model_id") val previousModelId: String? = null,
    @SerialName("previous_model_name") val previousModelName: String? = null,
    @SerialName("current_model_id") val currentModelId: String,
    @SerialName("current_model_name") val currentModelName: String,
    @SerialName("context_tier_id") val contextTierId: String? = null,
)

@Serializable
public data class SwitchContextTierRequest(
    /** 目标档位；null / 空字符串 = 重置为默认档。 */
    @SerialName("context_tier_id") val contextTierId: String? = null,
)

@Serializable
public data class SwitchContextTierResponse(
    val success: Boolean = true,
    @SerialName("session_id") val sessionId: String? = null,
    @SerialName("previous_tier_id") val previousTierId: String? = null,
    @SerialName("current_tier_id") val currentTierId: String? = null,
    val message: String? = null,
)

/**
 * 写入会话 `model_param_overrides`。
 *
 * 普通 UI 只改 `thinking_mode`，但后端 PUT 是整表替换，因此运输层须保留桌面端已写的
 * `performance_profile`（对齐 iOS `ChatModelParamOverrides`）。勿写 `reasoning_effort`。
 */
@Serializable
public data class ModelParamOverridesWrite(
    /** 必须显式编码（勿给默认值，否则 kotlinx 在 encodeDefaults=false 时会丢 `v`）。 */
    val v: Int,
    @SerialName("thinking_mode") val thinkingMode: String,
    /** 会话已有响应策略时原样带回，避免整表替换擦除。 */
    @SerialName("performance_profile") val performanceProfile: String? = null,
)

@Serializable
public data class UpdateModelParamsRequest(
    @SerialName("model_param_overrides") val modelParamOverrides: ModelParamOverridesWrite,
)

@Serializable
public data class UpdateModelParamsResponse(
    val success: Boolean = true,
    @SerialName("session_id") val sessionId: String? = null,
    @SerialName("model_param_overrides") val modelParamOverrides: JsonObject? = null,
)

@Serializable
public data class SessionReadAckRequest(
    @SerialName("through_run_id") val throughRunId: String,
    @SerialName("through_revision") val throughRevision: Long,
    @SerialName("mutation_id") val mutationId: String? = null,
)

@Serializable
public data class SessionReadAckResponse(
    val outcome: String? = null,
    @SerialName("has_unread_reply") val hasUnreadReply: Boolean = false,
    @SerialName("read_state") val readState: SessionReadState? = null,
)
