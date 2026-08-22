package com.tabtin.mobile.features.conversation

import com.tabtin.mobile.data.model.AgentTodoItem
import com.tabtin.mobile.data.model.ChatMessage
import com.tabtin.mobile.data.model.SubagentRunSnapshot
import com.tabtin.mobile.data.model.TodoStatus

/** 对齐 Electron `createTodoStripView`：收起条只报当前任务和 `done/total`，不写百分比。 */
internal object TodoStripPresentation {
    enum class LabelKind { ALL_DONE, AWAITING_SUBAGENTS, PAUSED_CURRENT, CURRENT }

    enum class IconKind { COMPLETE, PAUSED, IN_PROGRESS, IDLE }

    data class View(
        val done: Int,
        val total: Int,
        val labelKind: LabelKind,
        val currentContent: String?,
        val iconKind: IconKind,
        val isRunning: Boolean,
        val progressScale: Float,
    ) {
        val progressText: String = "$done/$total"
    }

    fun make(
        todos: List<AgentTodoItem>,
        paused: Boolean,
        awaitingSubagents: Boolean,
    ): View? {
        if (todos.isEmpty()) return null
        val active = todos.filter { it.status != TodoStatus.CANCELLED }
        val done = active.count { it.status == TodoStatus.COMPLETED }
        val current = active.firstOrNull { it.status == TodoStatus.IN_PROGRESS }
            ?: active.firstOrNull { it.status == TodoStatus.PAUSED }
            ?: active.firstOrNull { it.status == TodoStatus.PENDING }
            ?: active.lastOrNull()
        val total = active.size
        val isComplete = total > 0 && done == total
        val isInProgress = current?.status == TodoStatus.IN_PROGRESS
        val isAwaiting = awaitingSubagents && isInProgress
        val isPausedCurrent = current?.status == TodoStatus.PAUSED ||
            (paused && isInProgress && !isAwaiting)
        val isRunning = isInProgress && !paused && !isAwaiting && !isComplete
        val labelKind = when {
            isComplete -> LabelKind.ALL_DONE
            isAwaiting -> LabelKind.AWAITING_SUBAGENTS
            isPausedCurrent -> LabelKind.PAUSED_CURRENT
            else -> LabelKind.CURRENT
        }
        val iconKind = when {
            isComplete -> IconKind.COMPLETE
            isPausedCurrent -> IconKind.PAUSED
            isInProgress -> IconKind.IN_PROGRESS
            else -> IconKind.IDLE
        }
        return View(
            done = done,
            total = total,
            labelKind = labelKind,
            currentContent = current?.content,
            iconKind = iconKind,
            isRunning = isRunning,
            progressScale = if (total > 0) done.toFloat() / total.toFloat() else 0f,
        )
    }

    fun awaitingSubagents(messages: List<ChatMessage>): Boolean =
        CanvasAggregator.subagentRuns(messages).any { run ->
            run.status == SubagentRunSnapshot.Status.PENDING ||
                run.status == SubagentRunSnapshot.Status.QUEUED ||
                run.status == SubagentRunSnapshot.Status.RUNNING
        }
}
