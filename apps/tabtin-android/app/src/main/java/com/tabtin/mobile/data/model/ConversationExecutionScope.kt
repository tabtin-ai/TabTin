package com.tabtin.mobile.data.model

/**
 * 已有 Agent 会话的冻结执行范围。
 *
 * 路由入口只能为旧会话快照提供 Workspace 回退；一旦服务端返回 workspace_id / project_id，
 * 它们就是唯一事实，客户端不得拿当前页面所在 Space 反向覆盖。
 */
public data class ConversationExecutionScope(
    val organizationId: String,
    val workspaceId: String?,
    val projectId: String?,
) {
    public companion object {
        public fun resolvingFrozenSession(
            session: ChatSession,
            fallbackOrganizationId: String,
            fallbackWorkspaceId: String?,
        ): ConversationExecutionScope = ConversationExecutionScope(
            organizationId = session.organizationId?.takeIf { it.isNotBlank() }
                ?: fallbackOrganizationId,
            workspaceId = session.workspaceId?.takeIf { it.isNotBlank() }
                ?: fallbackWorkspaceId?.takeIf { it.isNotBlank() },
            // `null` 是个人会话的有效服务端事实，不能用入口的 Project 猜测补回。
            projectId = session.projectId?.takeIf { it.isNotBlank() },
        )
    }
}
