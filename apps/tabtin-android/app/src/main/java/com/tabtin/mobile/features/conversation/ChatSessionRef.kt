package com.tabtin.mobile.features.conversation

import com.tabtin.mobile.data.model.ConversationExecutionScope
import kotlinx.serialization.Serializable

/**
 * Compose Navigation type-safe route，用于从 AgentSessionsScreen /
 * AllConversationsScreen / fork 通知 /「新建任务」草稿 push 到聊天页。
 *
 * 对齐 iOS `ConversationTarget`：`sessionId` 空串 = 草稿入口（尚未在后端建会话）；
 * `startsNewSession=true` 强制走新建草稿；`agentId` 可选预选分身。
 */
@Serializable
public data class ChatSessionRoute(
    /** 空 = 草稿（首发前不拉 getSession）。 */
    val sessionId: String = "",
    val spaceId: String,
    val spaceName: String = "",
    val organizationId: String = "",
    /** 入口携带的 Project 上下文；既有会话详情返回后以服务端字段为准。 */
    val projectId: String = "",
    val messageId: String = "",
    /** true = 新建会话草稿；正式会话保持默认 false。 */
    val startsNewSession: Boolean = false,
    /** 可选预选分身；草稿首发前可再切换。 */
    val agentId: String = "",
    /** 外部动作已明确确认发送时，进入既有会话后自动发出的首条正文。 */
    val initialMessage: String = "",
)

internal fun chatSessionEntryExecutionScope(
    organizationId: String,
    workspaceId: String,
    projectId: String,
): ConversationExecutionScope = ConversationExecutionScope(
    organizationId = organizationId,
    workspaceId = workspaceId.trim().takeIf(String::isNotEmpty),
    projectId = projectId.trim().takeIf(String::isNotEmpty),
)
