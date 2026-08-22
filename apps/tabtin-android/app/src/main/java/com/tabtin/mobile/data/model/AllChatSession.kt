package com.tabtin.mobile.data.model

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

/**
 * 跨 Space 对话列表条目（`GET /chat/sessions/all` 响应里的 sessions 数组元素）。
 *
 * 与 [ChatSession] 的关系：ChatSession 是 per-space 视角下载的会话；AllChatSession
 * 是 drawer "全部对话" 视角下载的会话——后者附带 agent / space 元信息，便于在
 * 跨 agent 列表里直接渲染条目而无需第二次查询。两个 model 不可互相转换：
 * AllChatSession 缺 rollback_state / fork_count 等高级字段，ChatSession 缺
 * agent 元信息。
 *
 * 字段对齐后端 `ChatSessionWithAgentSchema`（apps/tabtin_django/.../schemas.py:157-189）。
 * 与 iOS 端 `AllChatSession.swift` 保持等价。
 */
@Serializable
public data class AllChatSession(
    val id: String,
    val title: String? = null,
    val status: String? = null,
    @SerialName("is_pinned") val isPinned: Boolean = false,
    @SerialName("pinned_at") val pinnedAt: String? = null,
    @SerialName("organization_id") val organizationId: String? = null,
    @SerialName("space_id") val spaceId: String? = null,
    @SerialName("workspace_id") val workspaceId: String? = null,
    @SerialName("created_at") val createdAt: String? = null,
    @SerialName("updated_at") val updatedAt: String? = null,
    @SerialName("last_message_at") val lastMessageAt: String? = null,
    @SerialName("message_count") val messageCount: Int? = null,
    @SerialName("last_message_preview") val lastMessagePreview: String? = null,
    @SerialName("space_name") val spaceName: String? = null,
    @SerialName("project_id") val projectId: String? = null,
    @SerialName("project_name") val projectName: String? = null,
    @SerialName("agent_id") val agentId: String? = null,
    @SerialName("agent_name") val agentName: String? = null,
    @SerialName("agent_icon") val agentIcon: String? = null,
    @SerialName("agent_avatar") val agentAvatar: String? = null,
    @SerialName("agent_type") val agentType: String? = null,
    /** 任务主工作面（chat/doc/browser/code）；缺省或非法时列表锚点按 chat。 */
    @SerialName("primary_surface") val primarySurface: String? = null,
    @SerialName("has_active_task") val hasActiveTask: Boolean = false,
    @SerialName("has_unread_reply") val hasUnreadReply: Boolean = false,
    @SerialName("last_run_failed") val lastRunFailed: Boolean = false,
    @SerialName("run_state") val runState: SessionRunState? = null,
    @SerialName("read_state") val readState: SessionReadState? = null,
    @SerialName("search_match_context") val searchMatchContext: String? = null,
) {
    val displayTitle: String get() = title.takeIf { !it.isNullOrBlank() } ?: ""
}

@Serializable
public data class AllSessionListResponse(
    val sessions: List<AllChatSession>,
    val total: Int,
    @SerialName("has_more") val hasMore: Boolean = false,
)
