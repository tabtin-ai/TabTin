package com.tabtin.mobile.features.conversation

import com.tabtin.mobile.data.model.AllChatSession
import com.tabtin.mobile.data.repository.SessionListActivityUpdate

/**
 * 任务首页会话目录对 `chat.session.activity.updated` 的纯函数投影。
 *
 * - 未知 id：插入一行（仅有事件携带字段）
 * - 已知 id：覆盖时间戳 / title / status / 作用域字段，保留 run/read 等本地投影
 * - 按 `lastMessageAt ?: updatedAt ?: createdAt` 降序，同键再按 id
 * - `status == archived`：从当前活跃列表移除
 */
internal object AllConversationsActivityPolicy {
    fun activitySortKey(session: AllChatSession): String =
        session.lastMessageAt ?: session.updatedAt ?: session.createdAt ?: ""

    fun upsertAndReorder(
        existing: List<AllChatSession>,
        activity: SessionListActivityUpdate,
    ): List<AllChatSession> {
        val sessionId = activity.sessionId
        if (sessionId.isBlank()) return existing

        if (activity.status == "archived") {
            return existing.filterNot { it.id == sessionId }
        }

        val index = existing.indexOfFirst { it.id == sessionId }
        val updated = if (index < 0) {
            AllChatSession(
                id = sessionId,
                title = activity.title,
                status = activity.status,
                organizationId = activity.organizationId,
                workspaceId = activity.workspaceId,
                projectId = activity.projectId,
                agentId = activity.agentId,
                lastMessageAt = activity.lastMessageAt,
                updatedAt = activity.updatedAt,
                createdAt = activity.createdAt,
                // 事件桶键优先 workspace；列表分组依赖 spaceId，缺省时用 workspace 兜底。
                spaceId = activity.workspaceId ?: activity.projectId,
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
                lastMessageAt = activity.lastMessageAt ?: current.lastMessageAt,
                updatedAt = activity.updatedAt ?: current.updatedAt,
                createdAt = activity.createdAt ?: current.createdAt,
                spaceId = current.spaceId
                    ?: activity.workspaceId
                    ?: activity.projectId,
            )
        }

        val without = if (index < 0) existing else existing.filterIndexed { i, _ -> i != index }
        return (without + updated).sortedWith(
            compareByDescending(AllConversationsActivityPolicy::activitySortKey)
                .thenBy { it.id },
        )
    }
}
