package com.tabtin.mobile.features.conversation

/**
 * 胶囊 PTT 手势纯状态机。阈值对齐 iOS CapsuleHoldToTalkReducer：
 * 520ms 长按起录、12dp 水平抖动容差、56dp 上滑取消。
 *
 * 指落只进入 PRESSING，不启动 ASR；≥520ms 才 RECORDING。
 * 系统 cancellation **不等于** 长按成立（Adapter 须区分 timeout 与 cancel）。
 */
public enum class TaskPttPhase {
    IDLE,
    PRESSING,
    PREPARING,
    RECORDING,
    CANCEL_ARMED,
    FINISHED,
    CANCELLED,
}

public data class TaskPttState(
    val phase: TaskPttPhase = TaskPttPhase.IDLE,
    val pressElapsedMs: Long = 0L,
    val dragX: Float = 0f,
    val dragY: Float = 0f,
)

/** 松手瞬间按松手前相位决定：轻点回对话 / 提交 / 取消 / 忽略（含同意中）。 */
public enum class TaskPttPointerOutcome {
    TAP,
    SUBMIT_RECORDING,
    CANCEL,
    IGNORE,
    ;

    public companion object {
        public fun resolve(phaseBeforeEnd: TaskPttPhase): TaskPttPointerOutcome = when (phaseBeforeEnd) {
            TaskPttPhase.PRESSING -> TAP
            TaskPttPhase.RECORDING -> SUBMIT_RECORDING
            TaskPttPhase.CANCEL_ARMED -> CANCEL
            TaskPttPhase.PREPARING,
            TaskPttPhase.IDLE,
            TaskPttPhase.FINISHED,
            TaskPttPhase.CANCELLED,
            -> IGNORE
        }
    }
}

public object TaskPttGesture {
    public const val HOLD_THRESHOLD_MS: Long = 520L
    public const val JITTER_TOLERANCE_DP: Float = 12f
    public const val CANCEL_DISTANCE_DP: Float = 56f

    public fun onPressStart(): TaskPttState = TaskPttState(phase = TaskPttPhase.PRESSING)

    public fun onTick(state: TaskPttState, elapsedMs: Long, privacyGranted: Boolean): TaskPttState {
        if (state.phase != TaskPttPhase.PRESSING) return state
        val next = state.copy(pressElapsedMs = elapsedMs)
        if (elapsedMs < HOLD_THRESHOLD_MS) return next
        return if (!privacyGranted) {
            next.copy(phase = TaskPttPhase.PREPARING)
        } else {
            next.copy(phase = TaskPttPhase.RECORDING)
        }
    }

    /**
     * 对齐 iOS：仅当 |dx| ≤ 12dp 且 dy ≤ -56dp 才进入取消武装。
     * 水平超出抖动容差的上滑不视为取消。
     */
    public fun onDrag(state: TaskPttState, dragXDp: Float, dragYDp: Float): TaskPttState {
        if (state.phase != TaskPttPhase.RECORDING && state.phase != TaskPttPhase.CANCEL_ARMED) {
            return state
        }
        val cancelArmed = isCancelArmed(dragXDp, dragYDp)
        return state.copy(
            dragX = dragXDp,
            dragY = dragYDp,
            phase = if (cancelArmed) TaskPttPhase.CANCEL_ARMED else TaskPttPhase.RECORDING,
        )
    }

    /** @deprecated 请用 [onDrag] 双轴版本；保留给旧调用方。 */
    public fun onDrag(state: TaskPttState, dragYDp: Float): TaskPttState =
        onDrag(state, dragXDp = 0f, dragYDp = dragYDp)

    public fun onRelease(state: TaskPttState): TaskPttState = when (state.phase) {
        TaskPttPhase.PRESSING, TaskPttPhase.PREPARING ->
            state.copy(phase = TaskPttPhase.CANCELLED)
        TaskPttPhase.CANCEL_ARMED ->
            state.copy(phase = TaskPttPhase.CANCELLED)
        TaskPttPhase.RECORDING ->
            state.copy(phase = TaskPttPhase.FINISHED)
        else -> state
    }

    public fun onSystemCancel(state: TaskPttState): TaskPttState =
        state.copy(phase = TaskPttPhase.CANCELLED)

    /** 仅 RECORDING 才允许 startAsr；阈值前 / PREPARING 禁止。 */
    public fun shouldStartAsr(state: TaskPttState, privacyGranted: Boolean): Boolean =
        privacyGranted && state.phase == TaskPttPhase.RECORDING

    public fun isWithinJitter(deltaXDp: Float, deltaYDp: Float): Boolean =
        kotlin.math.abs(deltaXDp) <= JITTER_TOLERANCE_DP &&
            kotlin.math.abs(deltaYDp) <= JITTER_TOLERANCE_DP

    /** 取消武装：水平在抖动内且上滑超过取消距离。 */
    public fun isCancelArmed(dragXDp: Float, dragYDp: Float): Boolean =
        kotlin.math.abs(dragXDp) <= JITTER_TOLERANCE_DP &&
            dragYDp <= -CANCEL_DISTANCE_DP
}
