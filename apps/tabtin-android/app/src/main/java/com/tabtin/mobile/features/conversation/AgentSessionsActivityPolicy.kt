package com.tabtin.mobile.features.conversation

import com.tabtin.mobile.data.model.ChatSession
import com.tabtin.mobile.data.repository.SessionListActivityUpdate

/**
 * 单 Agent 会话列表对 `chat.session.activity.updated` 的纯函数投影。
 *
 * 仅接纳已在列表中的 session，或 `workspace_id` / `project_id` 命中当前 space 的新会话。
 */
internal object AgentSessionsActivityPolicy {
    fun activitySortKey(session: ChatSession): String =
        session.lastMessageAt ?: session.updatedAt ?: session.createdAt ?: ""

    fun matchesSpace(
        activity: SessionListActivityUpdate,
        spaceId: String,
    ): Boolean {
        if (spaceId.isBlank()) return false
        return activity.workspaceId == spaceId || activity.projectId == spaceId
    }

    /**
     * @return 更新后的列表；事件与本 space 无关时返回原列表。
     */
    fun upsertAndReorder(
        existing: List<ChatSession>,
        activity: SessionListActivityUpdate,
        spaceId: String,
    ): List<ChatSession> {
        val sessionId = activity.sessionId
        if (sessionId.isBlank()) return existing

        val index = existing.indexOfFirst { it.id == sessionId }
        if (index < 0 && !matchesSpace(activity, spaceId)) return existing

        if (activity.status == "archived") {
            return if (index < 0) existing else existing.filterNot { it.id == sessionId }
        }

        val updated = if (index < 0) {
            ChatSession(
                id = sessionId,
                title = activity.title,
                status = activity.status,
                organizationId = activity.organizationId,
                workspaceId = activity.workspaceId,
                projectId = activity.projectId,
                spaceId = activity.workspaceId ?: activity.projectId ?: spaceId,
                agentId = activity.agentId,
                threadId = activity.threadId,
                lastMessageAt = activity.lastMessageAt,
                updatedAt = activity.updatedAt,
                createdAt = activity.createdAt,
            )
        } else {
            val current = existing[index]
            current.copy(
                title = activity.title ?: current.title,
                status = activity.status ?: current.status,
                organizationId = activity.organizationId ?: current.organizationId,
                workspaceId = activity.workspaceId ?: current.workspaceId,
                projectId = activity.projectId ?: current.projectId,
                agentId = activity.agentId ?: current.agentId,
                threadId = activity.threadId ?: current.threadId,
                lastMessageAt = activity.lastMessageAt ?: current.lastMessageAt,
                updatedAt = activity.updatedAt ?: current.updatedAt,
                createdAt = activity.createdAt ?: current.createdAt,
            )
        }

        val without = if (index < 0) existing else existing.filterIndexed { i, _ -> i != index }
        return (without + updated).sortedWith(
            compareByDescending(AgentSessionsActivityPolicy::activitySortKey)
                .thenBy { it.id },
        )
    }
}
