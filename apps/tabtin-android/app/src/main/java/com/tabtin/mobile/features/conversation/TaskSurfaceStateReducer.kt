package com.tabtin.mobile.features.conversation

import com.tabtin.mobile.features.workbench.WorkbenchFocusTarget
import com.tabtin.mobile.features.workbench.WorkbenchNavigationPane
import com.tabtin.mobile.features.workbench.WorkbenchResourceOpenRequest

/** 工作面切换涉及的一组 state，抽出来是为了让「收起对话时 focus 该不该清」可被单测断言。 */
internal data class TaskSurfaceStateSnapshot(
    val workbenchOpen: Boolean = false,
    val preferAppFocus: Boolean = false,
    val everOpened: Boolean = false,
    val pendingOpenRequest: WorkbenchResourceOpenRequest? = null,
    val focus: WorkbenchFocusTarget = WorkbenchFocusTarget.fromPane(WorkbenchNavigationPane.Overview),
)

/**
 * 工作面模式切换的 state 变换。
 *
 * 关键契约：[TaskSurfaceMode.CHAT_FOCUS] **不清 [TaskSurfaceStateSnapshot.focus]**——
 * direct 对话面只切换 presentation，工作台仍 keep-alive，Agent 应一直知道用户停在哪一页。
 * 而 [TaskSurfaceStateSnapshot.pendingOpenRequest] 是 deep link 的一次性请求，必须清掉，
 * 否则下次打开工作台会重放上一次的跳转。
 */
internal object TaskSurfaceStateReducer {
    fun openResource(
        state: TaskSurfaceStateSnapshot,
        request: WorkbenchResourceOpenRequest,
        switcherEnabled: Boolean = ConversationWorkbenchUIPolicy.showsSurfaceSwitcher,
    ): TaskSurfaceStateSnapshot {
        if (!switcherEnabled) return state
        return state.copy(
            workbenchOpen = true,
            preferAppFocus = true,
            everOpened = true,
            pendingOpenRequest = request,
        )
    }

    fun apply(
        state: TaskSurfaceStateSnapshot,
        mode: TaskSurfaceMode,
        switcherEnabled: Boolean = ConversationWorkbenchUIPolicy.showsSurfaceSwitcher,
    ): TaskSurfaceStateSnapshot {
        if (!switcherEnabled && mode != TaskSurfaceMode.CHAT_FOCUS) return state
        return when (mode) {
            TaskSurfaceMode.CHAT_FOCUS -> state.copy(
                workbenchOpen = false,
                preferAppFocus = false,
                pendingOpenRequest = null,
            )
            TaskSurfaceMode.SPLIT -> state.copy(
                workbenchOpen = true,
                preferAppFocus = false,
                everOpened = true,
            )
            TaskSurfaceMode.APP_FOCUS -> state.copy(
                workbenchOpen = true,
                preferAppFocus = true,
                everOpened = true,
            )
        }
    }
}
