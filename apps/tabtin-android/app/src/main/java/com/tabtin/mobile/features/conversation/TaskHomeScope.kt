package com.tabtin.mobile.features.conversation

import androidx.annotation.StringRes
import com.tabtin.mobile.R
import com.tabtin.mobile.data.model.AllChatSession
import com.tabtin.mobile.data.model.SessionRunStatus

/**
 * 任务首页运行范围，对齐 iOS `TaskHomeScope`。
 * UI 入口已下线，列表固定用 [ALL]；枚举仍承载服务端 wire 参数与单测。
 */
internal enum class TaskHomeScope(
    @StringRes val titleRes: Int,
    val wireStatus: String?,
    val wireRunStatus: String?,
) {
    ALL(R.string.task_home_scope_all, "active", null),
    NEEDS_YOU(R.string.task_home_scope_needs_you, "active", SessionRunStatus.WAITING_USER),
    RUNNING(R.string.task_home_scope_running, "active", SessionRunStatus.RUNNING),
    ARCHIVED(R.string.task_home_scope_archived, "archived", null),
    ;

    fun matches(session: AllChatSession): Boolean {
        val archived = session.isArchivedSession
        return when (this) {
            ALL -> !archived
            ARCHIVED -> archived
            NEEDS_YOU -> !archived && session.runState?.status == SessionRunStatus.WAITING_USER
            RUNNING -> !archived && session.isRunningSession
        }
    }
}

internal val AllChatSession.isArchivedSession: Boolean
    get() = status?.trim()?.lowercase() == "archived"

internal val AllChatSession.isRunningSession: Boolean
    get() {
        val runStatus = runState?.status
        if (runStatus == SessionRunStatus.RUNNING || runStatus == SessionRunStatus.QUEUED) return true
        return hasActiveTask
    }
