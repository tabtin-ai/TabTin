package com.tabtin.mobile.features.conversation

import androidx.compose.animation.core.CubicBezierEasing
import kotlin.math.max
import kotlin.math.min

/** 对齐 Electron `chatCapsuleMorph.ts`。 */
public object TaskSurfaceMorphTiming {
    public const val DURATION_MS: Int = 420
    public const val GHOST_FADE_MS: Int = 140
    public const val PENDING_TTL_MS: Int = 1000
    public const val PHONE_CAPSULE_MORPH_MS: Int = 260
    public const val EASING_X1: Float = 0.77f
    public const val EASING_Y1: Float = 0f
    public const val EASING_X2: Float = 0.175f
    public const val EASING_Y2: Float = 1f
    public const val RAIL_CORNER_RADIUS_DP: Float = 12f

    public val Easing: CubicBezierEasing =
        CubicBezierEasing(EASING_X1, EASING_Y1, EASING_X2, EASING_Y2)
}

public enum class TaskSurfaceMorphDirection {
    TO_CAPSULE,
    TO_RAIL,
}

public data class MorphRect(
    val left: Float,
    val top: Float,
    val width: Float,
    val height: Float,
) {
    public val right: Float get() = left + width
    public val bottom: Float get() = top + height
}

/**
 * Split ⇄ App-focus 几何 ghost 状态机。
 * 不复制真实对话内容；只管理 pending / 播放 / 中途反向 / Reduce Motion。
 *
 * Reduce Motion：[beginTransition] 在 `reduceMotion=true` 时清场并返回 null（不播 ghost）；
 * 宿主应立即应用目标几何，焦点随 [TaskSurfaceMode]。验收见 [TaskSurfaceMorphTest]。
 */
public class TaskSurfaceMorphCoordinator {
    private data class Pending(
        val direction: TaskSurfaceMorphDirection,
        val from: MorphRect,
        val capturedAtMs: Long,
        val generation: Long,
    )

    private data class Active(
        val direction: TaskSurfaceMorphDirection,
        val from: MorphRect,
        val to: MorphRect,
        val startedAtMs: Long,
        val generation: Long,
    )

    private var pending: Pending? = null
    private var active: Active? = null
    private var capsuleRevealUntilMs: Long = 0L
    private var railRevealUntilMs: Long = 0L
    /** R2-动效：快速第三态切换时递增，旧动画回调不得再写 hide/ghost。 */
    private var transitionGeneration: Long = 0L

    public val hasActiveGhost: Boolean get() = active != null
    public val pendingFromRect: MorphRect? get() = pending?.from
    public val currentGeneration: Long get() = transitionGeneration

    public fun beginTransition(
        previous: TaskSurfaceMode,
        next: TaskSurfaceMode,
        railRect: MorphRect?,
        capsuleRect: MorphRect?,
        reduceMotion: Boolean,
        nowMs: Long,
    ): TaskSurfaceMorphDirection? {
        val interrupted = cancelActiveMorph(nowMs)
        // 任意模式切换（含快速切到第三态）都推进 generation，清 active/pending/hide
        transitionGeneration += 1L
        val gen = transitionGeneration
        if (reduceMotion) {
            clearAllVisualState()
            return null
        }
        if (previous == next) {
            clearAllVisualState()
            return null
        }

        // split ⇄ app-focus 以外的第三态（如 chat-focus）只清场，不播 ghost
        if (previous == TaskSurfaceMode.SPLIT && next == TaskSurfaceMode.APP_FOCUS) {
            val from = interrupted ?: railRect
            if (from == null || from.width < 1f || from.height < 1f) {
                clearAllVisualState()
                return null
            }
            pending = Pending(TaskSurfaceMorphDirection.TO_CAPSULE, from, nowMs, gen)
            capsuleRevealUntilMs = nowMs + TaskSurfaceMorphTiming.DURATION_MS
            return TaskSurfaceMorphDirection.TO_CAPSULE
        }
        if (previous == TaskSurfaceMode.APP_FOCUS && next == TaskSurfaceMode.SPLIT) {
            val from = interrupted ?: capsuleRect
            if (from == null || from.width < 1f || from.height < 1f) {
                clearAllVisualState()
                return null
            }
            pending = Pending(TaskSurfaceMorphDirection.TO_RAIL, from, nowMs, gen)
            railRevealUntilMs = nowMs + TaskSurfaceMorphTiming.DURATION_MS
            return TaskSurfaceMorphDirection.TO_RAIL
        }
        clearAllVisualState()
        return null
    }

    /** 快速第三态 / 协程取消：清 active、pending、hide 窗口。 */
    public fun clearAllVisualState() {
        pending = null
        active = null
        capsuleRevealUntilMs = 0L
        railRevealUntilMs = 0L
    }

    public fun isCurrentGeneration(generation: Long): Boolean =
        generation == transitionGeneration

    public fun hasPending(direction: TaskSurfaceMorphDirection, nowMs: Long): Boolean {
        val p = pending ?: return false
        if (p.direction != direction) return false
        return nowMs - p.capturedAtMs <= TaskSurfaceMorphTiming.PENDING_TTL_MS
    }

    public fun shouldHideCapsule(nowMs: Long): Boolean {
        if (hasPending(TaskSurfaceMorphDirection.TO_CAPSULE, nowMs)) return true
        return nowMs < capsuleRevealUntilMs
    }

    public fun shouldHideRail(nowMs: Long): Boolean {
        if (hasPending(TaskSurfaceMorphDirection.TO_RAIL, nowMs)) return true
        return nowMs < railRevealUntilMs
    }

    public fun consume(
        direction: TaskSurfaceMorphDirection,
        targetRect: MorphRect,
        nowMs: Long,
    ): Boolean {
        val p = pending ?: return false
        if (p.direction != direction) return false
        if (p.generation != transitionGeneration) {
            pending = null
            return false
        }
        pending = null
        if (nowMs - p.capturedAtMs > TaskSurfaceMorphTiming.PENDING_TTL_MS) return false
        val safeTo = if (targetRect.width >= 1f && targetRect.height >= 1f) targetRect else p.from
        val revealUntil = nowMs + TaskSurfaceMorphTiming.DURATION_MS
        when (direction) {
            TaskSurfaceMorphDirection.TO_CAPSULE ->
                capsuleRevealUntilMs = max(capsuleRevealUntilMs, revealUntil)
            TaskSurfaceMorphDirection.TO_RAIL ->
                railRevealUntilMs = max(railRevealUntilMs, revealUntil)
        }
        active = Active(direction, p.from, safeTo, nowMs, p.generation)
        return true
    }

    public fun cancelActiveMorph(nowMs: Long): MorphRect? {
        val a = active ?: return null
        val linear = min(
            1f,
            max(0f, (nowMs - a.startedAtMs).toFloat() / TaskSurfaceMorphTiming.DURATION_MS),
        )
        val t = TaskSurfaceMorphTiming.Easing.transform(linear)
        val current = lerp(a.from, a.to, t)
        active = null
        return current
    }

    public fun completeGhost(@Suppress("UNUSED_PARAMETER") nowMs: Long, generation: Long? = null) {
        if (generation != null && generation != transitionGeneration) return
        active = null
        capsuleRevealUntilMs = 0L
        railRevealUntilMs = 0L
    }

    public fun activeSnapshot(): Pair<MorphRect, MorphRect>? {
        val a = active ?: return null
        return a.from to a.to
    }

    public fun activeGeneration(): Long? = active?.generation

    public companion object {
        public fun lerp(from: MorphRect, to: MorphRect, t: Float): MorphRect =
            MorphRect(
                left = from.left + (to.left - from.left) * t,
                top = from.top + (to.top - from.top) * t,
                width = from.width + (to.width - from.width) * t,
                height = from.height + (to.height - from.height) * t,
            )
    }
}

/** 右缘固定、左缘伸缩的稳定双栏几何。 */
public object TaskSurfaceStableLayout {
    public data class PaneGeometry(
        val conversationWidthDp: Float,
        val workbenchWidthDp: Float,
        val conversationAlpha: Float,
        val workbenchAlpha: Float,
        val conversationHitTest: Boolean,
        val workbenchHitTest: Boolean,
        val showsDivider: Boolean,
        val workbenchTrailingInsetDp: Float = 0f,
        val conversationLeadingInsetDp: Float = 0f,
    )

    public const val DIVIDER_HIT_DP: Float = 16f
    public const val MIN_WORKBENCH_DP: Float = 320f
    public const val MAX_WORKBENCH_DP: Float = 480f
    public const val MIN_FRACTION: Float = 0.25f
    public const val MAX_FRACTION: Float = 0.55f

    public fun geometry(
        mode: TaskSurfaceMode,
        availableWidthDp: Float,
        workbenchFraction: Float,
    ): PaneGeometry {
        val width = max(0f, availableWidthDp)
        return when (mode) {
            TaskSurfaceMode.CHAT_FOCUS -> PaneGeometry(
                conversationWidthDp = width,
                workbenchWidthDp = 0f,
                conversationAlpha = 1f,
                workbenchAlpha = 0f,
                conversationHitTest = true,
                workbenchHitTest = false,
                showsDivider = false,
            )
            TaskSurfaceMode.APP_FOCUS -> PaneGeometry(
                conversationWidthDp = 0f,
                workbenchWidthDp = width,
                conversationAlpha = 0f,
                workbenchAlpha = 1f,
                conversationHitTest = false,
                workbenchHitTest = true,
                showsDivider = false,
            )
            TaskSurfaceMode.SPLIT -> {
                val fraction = workbenchFraction.coerceIn(MIN_FRACTION, MAX_FRACTION)
                val ideal = width * fraction
                val upper = min(MAX_WORKBENCH_DP, width * MAX_FRACTION)
                val workbench = min(upper, max(MIN_WORKBENCH_DP, ideal))
                val conversation = max(0f, width - workbench - DIVIDER_HIT_DP)
                PaneGeometry(
                    conversationWidthDp = conversation,
                    workbenchWidthDp = workbench,
                    conversationAlpha = 1f,
                    workbenchAlpha = 1f,
                    conversationHitTest = true,
                    workbenchHitTest = true,
                    showsDivider = true,
                )
            }
        }
    }

    public fun splitConversationTarget(
        containerLeft: Float,
        containerTop: Float,
        containerWidth: Float,
        containerHeight: Float,
        workbenchFraction: Float,
    ): MorphRect {
        val geo = geometry(TaskSurfaceMode.SPLIT, containerWidth, workbenchFraction)
        return MorphRect(
            left = containerLeft + geo.conversationLeadingInsetDp,
            top = containerTop,
            width = geo.conversationWidthDp,
            height = containerHeight,
        )
    }
}
