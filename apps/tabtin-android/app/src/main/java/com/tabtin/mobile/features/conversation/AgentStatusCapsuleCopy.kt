package com.tabtin.mobile.features.conversation

import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import com.tabtin.mobile.R
import com.tabtin.mobile.ui.theme.TTColors
import com.tabtin.mobile.ui.theme.ttColor

/** 胶囊副文案上下文（对齐 iOS `AgentRunPresentationState` 投影字段）。 */
public data class AgentStatusCapsuleContext(
    val currentAction: String? = null,
    val failureReason: String? = null,
    val pendingHitlCount: Int = 0,
)

public enum class CapsuleStatusColor {
    WARNING,
    ACCENT,
    SUCCESS,
    CRITICAL,
    SECONDARY,
}

/**
 * 胶囊文案与色相。完整态 / mini 均以色点表达状态（对齐 Electron `AgentChatCapsule`，
 * 无 Psychology / Build 等状态字形）。
 */
public data class AgentStatusCapsuleCopy(
    val titleResId: Int,
    val titleFormatArg: Int? = null,
    /** 本地化副文案资源（如「查看完整结果」「N 项待处理」）。 */
    val subtitleResId: Int? = null,
    val subtitleFormatArg: Int? = null,
    /** 运行时动态副文案（工具名 / 失败原因）；优先于 [subtitleResId]。 */
    val subtitleText: String? = null,
    val colorRole: CapsuleStatusColor,
    val emphasizesUserAttention: Boolean,
    val isBusy: Boolean,
) {
    public companion object {
        public fun resolve(
            status: TaskCapsuleStatus,
            queuedCount: Int = 0,
            unreadCount: Int = 0,
            context: AgentStatusCapsuleContext = AgentStatusCapsuleContext(),
        ): AgentStatusCapsuleCopy {
            val titleResId = titleResFor(status)
            val titleFormatArg = when (status) {
                TaskCapsuleStatus.QUEUED -> queuedCount.coerceAtLeast(1)
                TaskCapsuleStatus.COMPLETE -> unreadCount.coerceAtLeast(1)
                else -> null
            }
            return when (status) {
                TaskCapsuleStatus.NEEDS_APPROVAL,
                TaskCapsuleStatus.NEEDS_ANSWER,
                -> AgentStatusCapsuleCopy(
                    titleResId = titleResId,
                    subtitleResId = context.pendingHitlCount.takeIf { it > 0 }
                        ?.let { R.string.agent_capsule_pending_items },
                    subtitleFormatArg = context.pendingHitlCount.takeIf { it > 0 },
                    colorRole = CapsuleStatusColor.WARNING,
                    emphasizesUserAttention = true,
                    isBusy = false,
                )
                TaskCapsuleStatus.RECOVERING -> AgentStatusCapsuleCopy(
                    titleResId = titleResId,
                    colorRole = CapsuleStatusColor.WARNING,
                    emphasizesUserAttention = false,
                    isBusy = true,
                )
                TaskCapsuleStatus.THINKING,
                TaskCapsuleStatus.PREPARING,
                TaskCapsuleStatus.PLANNING_NEXT,
                -> AgentStatusCapsuleCopy(
                    titleResId = titleResId,
                    colorRole = CapsuleStatusColor.ACCENT,
                    emphasizesUserAttention = false,
                    isBusy = true,
                )
                TaskCapsuleStatus.WORKING -> AgentStatusCapsuleCopy(
                    titleResId = titleResId,
                    subtitleText = context.currentAction?.takeIf { it.isNotBlank() },
                    colorRole = CapsuleStatusColor.ACCENT,
                    emphasizesUserAttention = false,
                    isBusy = true,
                )
                TaskCapsuleStatus.FINISHING -> AgentStatusCapsuleCopy(
                    titleResId = titleResId,
                    colorRole = CapsuleStatusColor.ACCENT,
                    emphasizesUserAttention = false,
                    isBusy = true,
                )
                TaskCapsuleStatus.QUEUED -> AgentStatusCapsuleCopy(
                    titleResId = titleResId,
                    titleFormatArg = titleFormatArg,
                    colorRole = CapsuleStatusColor.ACCENT,
                    emphasizesUserAttention = false,
                    isBusy = true,
                )
                TaskCapsuleStatus.PAUSED -> AgentStatusCapsuleCopy(
                    titleResId = titleResId,
                    subtitleText = context.currentAction?.takeIf { it.isNotBlank() },
                    colorRole = CapsuleStatusColor.WARNING,
                    emphasizesUserAttention = false,
                    isBusy = false,
                )
                TaskCapsuleStatus.COMPLETE -> AgentStatusCapsuleCopy(
                    titleResId = titleResId,
                    titleFormatArg = titleFormatArg,
                    subtitleResId = R.string.agent_capsule_view_full_result,
                    colorRole = CapsuleStatusColor.SUCCESS,
                    emphasizesUserAttention = false,
                    isBusy = false,
                )
                TaskCapsuleStatus.ERROR -> AgentStatusCapsuleCopy(
                    titleResId = titleResId,
                    subtitleText = context.failureReason?.takeIf { it.isNotBlank() },
                    colorRole = CapsuleStatusColor.CRITICAL,
                    emphasizesUserAttention = true,
                    isBusy = false,
                )
                TaskCapsuleStatus.STOPPED -> AgentStatusCapsuleCopy(
                    titleResId = titleResId,
                    colorRole = CapsuleStatusColor.SECONDARY,
                    emphasizesUserAttention = false,
                    isBusy = false,
                )
                TaskCapsuleStatus.READY -> AgentStatusCapsuleCopy(
                    titleResId = titleResId,
                    colorRole = CapsuleStatusColor.SECONDARY,
                    emphasizesUserAttention = false,
                    isBusy = false,
                )
            }
        }

        private fun titleResFor(status: TaskCapsuleStatus): Int = when (status) {
            TaskCapsuleStatus.READY -> R.string.agent_capsule_ready
            TaskCapsuleStatus.PREPARING -> R.string.agent_capsule_preparing
            TaskCapsuleStatus.QUEUED -> R.string.agent_capsule_queued_count
            TaskCapsuleStatus.THINKING -> R.string.agent_capsule_thinking
            TaskCapsuleStatus.PLANNING_NEXT -> R.string.agent_capsule_planning_next
            TaskCapsuleStatus.WORKING -> R.string.agent_capsule_working
            TaskCapsuleStatus.FINISHING -> R.string.agent_capsule_finishing
            TaskCapsuleStatus.NEEDS_APPROVAL -> R.string.agent_capsule_needs_approval
            TaskCapsuleStatus.NEEDS_ANSWER -> R.string.agent_capsule_needs_answer
            TaskCapsuleStatus.PAUSED -> R.string.agent_capsule_paused
            TaskCapsuleStatus.RECOVERING -> R.string.agent_capsule_recovering
            TaskCapsuleStatus.COMPLETE -> R.string.agent_capsule_complete_count
            TaskCapsuleStatus.STOPPED -> R.string.agent_capsule_stopped
            TaskCapsuleStatus.ERROR -> R.string.agent_capsule_error
        }
    }
}

@Composable
public fun CapsuleStatusColor.toComposeColor(): Color = when (this) {
    CapsuleStatusColor.WARNING -> ttColor(TTColors.BgWarning, TTColors.Dark.BgWarning)
    CapsuleStatusColor.ACCENT -> ttColor(TTColors.TextAccent, TTColors.Dark.TextAccent)
    CapsuleStatusColor.SUCCESS -> ttColor(TTColors.TextSuccess, TTColors.Dark.TextSuccess)
    CapsuleStatusColor.CRITICAL -> ttColor(TTColors.TextCritical, TTColors.Dark.TextCritical)
    CapsuleStatusColor.SECONDARY -> ttColor(TTColors.TextSecondary, TTColors.Dark.TextSecondary)
}
