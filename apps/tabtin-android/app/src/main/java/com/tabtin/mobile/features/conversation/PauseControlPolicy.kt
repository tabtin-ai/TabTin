package com.tabtin.mobile.features.conversation

import com.tabtin.mobile.data.model.SessionRunStatus

/**
 * ：暂停 ACK 只表示服务端已转发，runtime 要到下一轮迭代边界才真正挂起。
 * 「已暂停」只认权威 `run_state.status=paused`。
 */
internal data class PauseControlPresentation(
    val isPaused: Boolean,
    val isPauseControlPending: Boolean,
)

internal fun pauseControlAfterAck(
    requestedPause: Boolean,
    ackSucceeded: Boolean,
    currentlyPaused: Boolean,
    currentlyPending: Boolean,
): PauseControlPresentation {
    if (!ackSucceeded) {
        return PauseControlPresentation(
            isPaused = currentlyPaused,
            isPauseControlPending = false,
        )
    }
    return if (requestedPause) {
        PauseControlPresentation(isPaused = false, isPauseControlPending = true)
    } else {
        PauseControlPresentation(isPaused = false, isPauseControlPending = false)
    }
}

internal fun pauseControlAfterRunState(
    runStatus: String,
    currentlyPending: Boolean,
    sessionRequestedPause: Boolean = false,
): PauseControlPresentation {
    val reached = runStatus == SessionRunStatus.PAUSED
    val terminal = runStatus in SessionRunStatus.TERMINAL
    return PauseControlPresentation(
        isPaused = reached,
        isPauseControlPending = when {
            reached || terminal -> false
            currentlyPending || sessionRequestedPause -> true
            else -> false
        },
    )
}

/** 正在暂停不得锁死停止 / 撤回；pending 本身也说明这一轮还活着。 */
internal fun pauseControlAllowsStop(
    hasActiveRun: Boolean,
    isPaused: Boolean,
    pausePending: Boolean,
): Boolean = hasActiveRun || isPaused || pausePending
