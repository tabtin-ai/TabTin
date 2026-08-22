package com.tabtin.mobile.features.conversation

import com.tabtin.mobile.data.model.AgentPhase
import com.tabtin.mobile.data.model.ChatMessage
import com.tabtin.mobile.data.model.SessionRunState
import com.tabtin.mobile.data.model.SessionRunStatus
import com.tabtin.mobile.data.model.StepStatus
import com.tabtin.mobile.data.model.StepType

/**
 * TaskCapsule 状态投影 —— 对齐 `@tabtin/contracts` resolveTaskCapsuleStatus / Visual
 * 与 `task-capsule-status-v1.json` fixture。
 *
 * 后端不下发颜色/尺寸；视觉态由本端纯函数给出（仅 ready → mini）。
 */
public enum class TaskCapsuleStatus {
    READY,
    PREPARING,
    QUEUED,
    THINKING,
    PLANNING_NEXT,
    WORKING,
    FINISHING,
    NEEDS_APPROVAL,
    NEEDS_ANSWER,
    PAUSED,
    RECOVERING,
    COMPLETE,
    STOPPED,
    ERROR,
    ;

    public val wireKey: String
        get() = when (this) {
            READY -> "ready"
            PREPARING -> "preparing"
            QUEUED -> "queued"
            THINKING -> "thinking"
            PLANNING_NEXT -> "planningNext"
            WORKING -> "working"
            FINISHING -> "finishing"
            NEEDS_APPROVAL -> "needsApproval"
            NEEDS_ANSWER -> "needsAnswer"
            PAUSED -> "paused"
            RECOVERING -> "recovering"
            COMPLETE -> "complete"
            STOPPED -> "stopped"
            ERROR -> "error"
        }
}

public enum class TaskCapsuleVisual {
    FULL,
    MINI,
    HIDDEN,
}

public enum class TaskCapsuleRunPhase {
    PLANNING,
    TOOL_CALLS,
    SYNTHESIZING,
    DONE,
    ERROR,
    CANCELLED,
}

public data class TaskCapsuleStatusInput(
    val busy: Boolean,
    val runPhase: TaskCapsuleRunPhase? = null,
    val completedToolCalls: Int = 0,
    val queuedCount: Int = 0,
    val pendingApproval: Boolean = false,
    val pendingAnswer: Boolean = false,
    val paused: Boolean = false,
    val suspended: Boolean = false,
    val unreadCount: Int = 0,
)

/**
 * Adapter 输入：权威 SessionRunState + 本地 AgentPhase / 消息投影。
 */
public data class TaskCapsuleAdapterInput(
    val runState: SessionRunState? = null,
    val currentPhase: AgentPhase = AgentPhase.IDLE,
    val isStreaming: Boolean = false,
    val isSending: Boolean = false,
    val messages: List<ChatMessage> = emptyList(),
    val queuedCount: Int = 0,
    val pendingApproval: Boolean = false,
    val pendingAnswer: Boolean = false,
    val paused: Boolean = false,
    val suspended: Boolean = false,
    val hasUnreadReply: Boolean = false,
    val seenUntilTs: Long = 0L,
)

public object TaskCapsuleModel {
    public fun resolveStatus(input: TaskCapsuleStatusInput): TaskCapsuleStatus {
        if (input.pendingApproval) return TaskCapsuleStatus.NEEDS_APPROVAL
        if (input.pendingAnswer) return TaskCapsuleStatus.NEEDS_ANSWER
        if (input.paused) return TaskCapsuleStatus.PAUSED
        if (input.suspended) return TaskCapsuleStatus.RECOVERING

        if (input.busy) return resolveBusyStatus(input)

        if (input.runPhase == TaskCapsuleRunPhase.ERROR) return TaskCapsuleStatus.ERROR
        if (input.runPhase == TaskCapsuleRunPhase.CANCELLED) return TaskCapsuleStatus.STOPPED
        if (input.unreadCount > 0) return TaskCapsuleStatus.COMPLETE
        return TaskCapsuleStatus.READY
    }

    public fun resolveVisual(status: TaskCapsuleStatus): TaskCapsuleVisual =
        if (status == TaskCapsuleStatus.READY) TaskCapsuleVisual.MINI else TaskCapsuleVisual.FULL

    /** 从权威 RunState + 本地相位投影胶囊输入（planningNext 等可达）。 */
    public fun adapt(input: TaskCapsuleAdapterInput): TaskCapsuleStatusInput {
        val completedTools = countCompletedToolCalls(input.messages)
        val runPhase = resolveRunPhase(input, completedTools)
        val busy = input.runState?.isActive == true ||
            input.isStreaming ||
            input.isSending ||
            input.currentPhase == AgentPhase.PLANNING ||
            input.currentPhase == AgentPhase.EXECUTING
        val paused = input.paused || input.runState?.status == SessionRunStatus.PAUSED
        val unread = resolveUnreadCount(
            messages = input.messages,
            seenUntilTs = input.seenUntilTs,
            hasUnreadReply = input.hasUnreadReply,
        )
        val queueDepth = maxOf(input.queuedCount, input.runState?.queueDepth ?: 0)
        return TaskCapsuleStatusInput(
            busy = busy && !paused,
            runPhase = runPhase,
            completedToolCalls = completedTools,
            queuedCount = queueDepth,
            pendingApproval = input.pendingApproval,
            pendingAnswer = input.pendingAnswer,
            paused = paused,
            suspended = input.suspended,
            unreadCount = unread,
        )
    }

    /**
     * 未读计数：seenUntilTs 之后的 assistant 消息数（对齐 Electron resolveCapsuleActivity）。
     * hasUnreadReply 为真但消息投影为 0 时至少记 1。
     */
    public fun resolveUnreadCount(
        messages: List<ChatMessage>,
        seenUntilTs: Long,
        hasUnreadReply: Boolean,
    ): Int {
        var count = 0
        for (message in messages) {
            if (!message.isAssistant) continue
            if (messageTimestampMs(message) > seenUntilTs) count += 1
        }
        if (hasUnreadReply && count == 0) return 1
        if (!hasUnreadReply) return 0
        return count
    }

    public fun countCompletedToolCalls(messages: List<ChatMessage>): Int {
        val streaming = messages.lastOrNull { it.isAssistant && it.isStreaming }
            ?: messages.lastOrNull { it.isAssistant }
            ?: return 0
        return streaming.agentSteps.orEmpty().count { step ->
            step.type == StepType.TOOL_CALL &&
                (step.status == StepStatus.COMPLETED || step.status == StepStatus.FAILED)
        }
    }

    public fun messageTimestampMs(message: ChatMessage): Long {
        val raw = message.createdAt ?: return 0L
        raw.toLongOrNull()?.let { numeric ->
            return if (numeric < 1_000_000_000_000L) numeric * 1000L else numeric
        }
        return runCatching { java.time.Instant.parse(raw).toEpochMilli() }.getOrDefault(0L)
    }

    public fun parseSeenUntilTs(readAt: String?): Long {
        if (readAt.isNullOrBlank()) return 0L
        readAt.toLongOrNull()?.let { numeric ->
            return if (numeric < 1_000_000_000_000L) numeric * 1000L else numeric
        }
        return runCatching { java.time.Instant.parse(readAt).toEpochMilli() }.getOrDefault(0L)
    }

    private fun resolveRunPhase(
        input: TaskCapsuleAdapterInput,
        completedTools: Int,
    ): TaskCapsuleRunPhase? {
        val status = input.runState?.status
        when (status) {
            SessionRunStatus.FAILED -> return TaskCapsuleRunPhase.ERROR
            SessionRunStatus.CANCELLED -> return TaskCapsuleRunPhase.CANCELLED
            SessionRunStatus.COMPLETED -> return TaskCapsuleRunPhase.DONE
            SessionRunStatus.QUEUED -> return null // busy + queuedCount → QUEUED
            else -> Unit
        }
        return when (input.currentPhase) {
            AgentPhase.PLANNING -> TaskCapsuleRunPhase.PLANNING
            AgentPhase.EXECUTING -> {
                // 工具已完成后若仍在「规划」感，靠 completedTools + PLANNING；
                // EXECUTING 映射 tool_calls；流式收尾无工具名时近似 synthesizing
                if (!input.isStreaming && completedTools > 0) {
                    TaskCapsuleRunPhase.SYNTHESIZING
                } else {
                    TaskCapsuleRunPhase.TOOL_CALLS
                }
            }
            AgentPhase.DONE -> TaskCapsuleRunPhase.DONE
            AgentPhase.ERROR -> TaskCapsuleRunPhase.ERROR
            AgentPhase.IDLE -> {
                if (status == SessionRunStatus.RUNNING && completedTools > 0) {
                    TaskCapsuleRunPhase.PLANNING // 可达 planningNext
                } else {
                    null
                }
            }
        }
    }

    private fun resolveBusyStatus(input: TaskCapsuleStatusInput): TaskCapsuleStatus = when (input.runPhase) {
        TaskCapsuleRunPhase.PLANNING ->
            if (input.completedToolCalls > 0) TaskCapsuleStatus.PLANNING_NEXT else TaskCapsuleStatus.THINKING
        TaskCapsuleRunPhase.TOOL_CALLS -> TaskCapsuleStatus.WORKING
        TaskCapsuleRunPhase.SYNTHESIZING -> TaskCapsuleStatus.FINISHING
        else -> if (input.queuedCount > 0) TaskCapsuleStatus.QUEUED else TaskCapsuleStatus.PREPARING
    }
}
