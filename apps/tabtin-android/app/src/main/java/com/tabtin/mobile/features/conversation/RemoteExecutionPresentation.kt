package com.tabtin.mobile.features.conversation

import androidx.annotation.StringRes
import com.tabtin.mobile.R

/**
 * 远程执行现场的环境态（由设备/绑定轮询驱动，不是单次发送 ACK）。
 *
 * 对齐 iOS [RemoteExecutionState]：非 [READY] 时 Composer 硬门闩禁发，
 * 提示收在输入井内，不再外挂「可先发送」软横幅。
 */
public enum class RemoteExecutionState {
    READY,
    WORKSPACE_NEEDS_DEVICE,
    DEVICE_UNAVAILABLE,
    ;

    public val blocksComposer: Boolean
        get() = this != READY
}

/** 会话标题圆点：仅 WS 已连接且绑定执行设备就绪时为绿，其余一律灰。 */
public object SessionReadyIndicatorPolicy {
    public fun showsReady(
        wsConnected: Boolean,
        remoteExecutionState: RemoteExecutionState,
    ): Boolean = wsConnected && remoteExecutionState == RemoteExecutionState.READY
}

public object RemoteExecutionPresentation {
    @StringRes
    public fun composerDisabledReasonRes(state: RemoteExecutionState): Int? = when (state) {
        RemoteExecutionState.READY -> null
        RemoteExecutionState.WORKSPACE_NEEDS_DEVICE -> R.string.chat_composer_device_unbound
        RemoteExecutionState.DEVICE_UNAVAILABLE -> R.string.chat_composer_device_offline
    }
}
