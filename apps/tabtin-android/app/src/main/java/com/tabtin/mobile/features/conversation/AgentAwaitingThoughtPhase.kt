package com.tabtin.mobile.features.conversation

import com.tabtin.mobile.data.model.AgentStep
import com.tabtin.mobile.data.model.StepStatus
import com.tabtin.mobile.data.model.StepType

/**
 * 对齐 Electron `agentAwaitingThoughtPhase.ts` / iOS `AgentAwaitingThoughtPhase.swift`：
 * 回合尾部同一时刻只允许一个活动等待行。
 */
public enum class AgentAwaitingThoughtPhase {
    HIDDEN,
    PENDING,
    PLANNING_NEXT,
}

public enum class AgentTurnTailActivity {
    NONE,
    THINKING,
    TEXT,
    SETTLED_TOOL,
    UNSETTLED_TOOL,
    OTHER,
}

internal object AgentAwaitingThoughtPresentation {
    public fun hasVisibleThinkingBody(content: String): Boolean =
        content.trim().isNotEmpty()

    public fun isInertWhitespaceText(content: String): Boolean =
        content.trim().isEmpty()

    public fun resolveTailActivity(items: List<AssistantTimelineItem>): AgentTurnTailActivity {
        for (item in items.asReversed()) {
            when (item) {
                is AssistantTimelineItem.Thinking -> {
                    if (!hasVisibleThinkingBody(item.content)) continue
                    return AgentTurnTailActivity.THINKING
                }
                is AssistantTimelineItem.Text -> {
                    if (isInertWhitespaceText(item.content)) continue
                    return AgentTurnTailActivity.TEXT
                }
                is AssistantTimelineItem.Tool -> {
                    return resolveToolTailActivity(item.step)
                }
                is AssistantTimelineItem.Rich,
                is AssistantTimelineItem.Attachment,
                -> return AgentTurnTailActivity.OTHER
            }
        }
        return AgentTurnTailActivity.NONE
    }

    public fun resolvePhase(
        sessionPulseVisible: Boolean,
        isLastAssistantMessage: Boolean,
        tailActivity: AgentTurnTailActivity,
    ): AgentAwaitingThoughtPhase {
        if (!sessionPulseVisible || !isLastAssistantMessage) return AgentAwaitingThoughtPhase.HIDDEN
        return when (tailActivity) {
            AgentTurnTailActivity.SETTLED_TOOL -> AgentAwaitingThoughtPhase.PLANNING_NEXT
            AgentTurnTailActivity.NONE -> AgentAwaitingThoughtPhase.PENDING
            AgentTurnTailActivity.THINKING,
            AgentTurnTailActivity.TEXT,
            AgentTurnTailActivity.UNSETTLED_TOOL,
            AgentTurnTailActivity.OTHER,
            -> AgentAwaitingThoughtPhase.HIDDEN
        }
    }

    public fun resolvePhase(
        sessionPulseVisible: Boolean,
        isLastAssistantMessage: Boolean,
        timelineItems: List<AssistantTimelineItem>,
    ): AgentAwaitingThoughtPhase = resolvePhase(
        sessionPulseVisible = sessionPulseVisible,
        isLastAssistantMessage = isLastAssistantMessage,
        tailActivity = resolveTailActivity(timelineItems),
    )

    private fun resolveToolTailActivity(step: AgentStep): AgentTurnTailActivity {
        if (step.type != StepType.TOOL_CALL) return AgentTurnTailActivity.OTHER
        return when (step.status) {
            StepStatus.RUNNING -> AgentTurnTailActivity.UNSETTLED_TOOL
            StepStatus.COMPLETED,
            StepStatus.FAILED,
            -> AgentTurnTailActivity.SETTLED_TOOL
        }
    }
}
