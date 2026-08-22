package com.tabtin.mobile.features.conversation

import androidx.annotation.StringRes
import com.tabtin.mobile.R
import com.tabtin.mobile.data.model.AllChatSession
import com.tabtin.mobile.data.model.SessionRunStatus

/**
 * 任务行状态：把 9 种运行态收敛成用户真正在意的几种「要不要现在管」。
 *
 * 收敛原则是紧迫度而非技术状态——用户不关心 queued 和 running 的区别，只关心
 * 「在跑 / 等我 / 崩了 / 完事了」。对齐 iOS `TaskRowStatusPresentation` 与
 * Electron 侧栏 `SessionStatusIcon`。
 */
internal enum class TaskRowStatus {
    /** 正在跑，不需要你动手 */
    RUNNING,
    /** 卡着等你确认 */
    WAITING_USER,
    /** Agent 自己停下了 */
    PAUSED,
    /** 这一轮失败了 */
    FAILED,
    /** 干完了，你还没看 */
    DONE_UNREAD,
    /** 干完了 / 静默——不用管 */
    DONE,
    ;

    /** 需要人介入的两种：视觉同为 warning，文案不同。 */
    val isAttention: Boolean get() = this == WAITING_USER || this == PAUSED
}

internal object TaskRowStatusPresentation {
    /**
     * 服务端 `run_state` 是权威事实，优先于本机聚合字段；缺失时（旧后端）才退回
     * has_active_task / last_run_failed / has_unread_reply 这组粗粒度布尔。
     */
    fun resolve(session: AllChatSession, hasPendingInteraction: Boolean): TaskRowStatus {
        val runStatus = session.runState?.takeIf { it.isValid }?.status
        if (runStatus != null) {
            return when (runStatus) {
                SessionRunStatus.QUEUED,
                SessionRunStatus.RUNNING,
                SessionRunStatus.CANCELLING,
                -> TaskRowStatus.RUNNING
                SessionRunStatus.WAITING_USER -> TaskRowStatus.WAITING_USER
                SessionRunStatus.PAUSED -> TaskRowStatus.PAUSED
                SessionRunStatus.FAILED -> TaskRowStatus.FAILED
                SessionRunStatus.COMPLETED ->
                    if (session.hasUnreadReply) TaskRowStatus.DONE_UNREAD else TaskRowStatus.DONE
                // cancelled / interrupted 不是 completed，但对读者的行动含义相同：不用管。
                else -> TaskRowStatus.DONE
            }
        }
        if (hasPendingInteraction) return TaskRowStatus.WAITING_USER
        if (session.hasActiveTask) return TaskRowStatus.RUNNING
        if (session.lastRunFailed) return TaskRowStatus.FAILED
        if (session.hasUnreadReply) return TaskRowStatus.DONE_UNREAD
        return TaskRowStatus.DONE
    }

    /**
     * 第二行状态文案。完成 / 静默返回 null——锚点已经把「不用管」说清楚了，
     * 第二行留给归属名。
     */
    @StringRes
    fun statusTextRes(status: TaskRowStatus): Int? = when (status) {
        TaskRowStatus.RUNNING -> R.string.task_row_status_running
        TaskRowStatus.WAITING_USER -> R.string.task_row_status_waiting_user
        TaskRowStatus.PAUSED -> R.string.task_row_status_paused
        TaskRowStatus.FAILED -> R.string.task_row_status_failed
        TaskRowStatus.DONE_UNREAD, TaskRowStatus.DONE -> null
    }

    /** 锚点无障碍播报：静默态也要有说法，否则读屏用户听到一个空图标。 */
    @StringRes
    fun accessibilityTextRes(status: TaskRowStatus): Int = when (status) {
        TaskRowStatus.RUNNING -> R.string.task_row_status_running
        TaskRowStatus.WAITING_USER -> R.string.task_row_status_waiting_user
        TaskRowStatus.PAUSED -> R.string.task_row_status_paused
        TaskRowStatus.FAILED -> R.string.task_row_status_failed
        TaskRowStatus.DONE_UNREAD -> R.string.task_row_status_unread
        TaskRowStatus.DONE -> R.string.task_row_status_completed
    }
}

/**
 * 归属只报一个名字：在 Project 里干活时用户认的是 Project，其余场景认 Workspace。
 * 对齐 iOS `TaskRowContentPolicy.locationName`。
 */
internal fun AllChatSession.taskRowLocationName(): String? {
    if (!projectId.isNullOrBlank()) {
        projectName?.takeIf { it.isNotBlank() }?.let { return it }
    }
    return spaceName?.takeIf { it.isNotBlank() }
}
