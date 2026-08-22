package com.tabtin.mobile.data.websocket

import com.tabtin.mobile.data.api.TokenRefreshResult

public enum class WsAuthInvalidAction {
    ATTEMPT_REFRESH,
    RECONNECT,
    LOGOUT,
    STAY_DISCONNECTED,
}

public sealed interface WsAuthInvalidStep {
    public data object NeedRefresh : WsAuthInvalidStep
    public data class AfterRefresh(val result: TokenRefreshResult) : WsAuthInvalidStep
    public data object AfterSuccessfulRefreshStillRejected : WsAuthInvalidStep
}

/**
 * WS `WS_1001_AUTH_INVALID` 的处置口径，对齐 HTTP [TokenRefreshCoordinator]：
 * 先刷新票，只有 refresh 明确作废才踢登录。环境错配或瞬时拒绝不毁会话。
 */
public object WsAuthInvalidPolicy {
    public fun decide(step: WsAuthInvalidStep): WsAuthInvalidAction = when (step) {
        WsAuthInvalidStep.NeedRefresh -> WsAuthInvalidAction.ATTEMPT_REFRESH
        is WsAuthInvalidStep.AfterRefresh -> when (step.result) {
            is TokenRefreshResult.Success -> WsAuthInvalidAction.RECONNECT
            TokenRefreshResult.Invalid -> WsAuthInvalidAction.LOGOUT
            TokenRefreshResult.Conflict,
            TokenRefreshResult.TemporarilyUnavailable -> WsAuthInvalidAction.STAY_DISCONNECTED
        }
        WsAuthInvalidStep.AfterSuccessfulRefreshStillRejected ->
            WsAuthInvalidAction.STAY_DISCONNECTED
    }
}
