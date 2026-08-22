package com.tabtin.mobile.features.conversation

import com.tabtin.mobile.data.model.Space

/**
 * 新任务入口解析执行 Workspace，对齐 iOS `NewTaskWorkspacePolicy`。
 * 调用方指定 / 当前筛选 / 最近使用 / 组织默认 / 列表首项；无可用时返回 null。
 */
internal object NewTaskWorkspacePolicy {
    fun resolve(
        workspaces: List<Space>,
        selectedWorkspaceId: String?,
        recentWorkspaceId: String?,
    ): Space? {
        for (candidateId in listOfNotNull(selectedWorkspaceId, recentWorkspaceId)) {
            workspaces.firstOrNull { it.id == candidateId }?.let { return it }
        }
        return workspaces.firstOrNull { it.isDefault == true } ?: workspaces.firstOrNull()
    }

    fun dispatchLaunch(
        requestedWorkspace: Space?,
        workspaces: List<Space>,
        onResolved: (Space) -> Unit,
        onUnavailable: () -> Unit,
    ) {
        val target = requestedWorkspace ?: resolve(
            workspaces = workspaces,
            selectedWorkspaceId = null,
            recentWorkspaceId = null,
        )
        if (target == null) {
            onUnavailable()
        } else {
            onResolved(target)
        }
    }
}
