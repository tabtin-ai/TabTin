package com.tabtin.mobile.data.websocket

import com.tabtin.mobile.data.api.TokenRefreshResult
import org.junit.Assert.assertEquals
import org.junit.Test

class WsAuthInvalidPolicyTest {
    @Test
    fun `first auth invalid asks for a token refresh instead of logout`() {
        assertEquals(
            WsAuthInvalidAction.ATTEMPT_REFRESH,
            WsAuthInvalidPolicy.decide(WsAuthInvalidStep.NeedRefresh),
        )
    }

    @Test
    fun `refresh success reconnects and keeps the session`() {
        assertEquals(
            WsAuthInvalidAction.RECONNECT,
            WsAuthInvalidPolicy.decide(
                WsAuthInvalidStep.AfterRefresh(TokenRefreshResult.Success("new-token")),
            ),
        )
    }

    @Test
    fun `only an invalid refresh token logs the user out`() {
        assertEquals(
            WsAuthInvalidAction.LOGOUT,
            WsAuthInvalidPolicy.decide(WsAuthInvalidStep.AfterRefresh(TokenRefreshResult.Invalid)),
        )
    }

    @Test
    fun `temporary refresh failures never force logout`() {
        assertEquals(
            WsAuthInvalidAction.STAY_DISCONNECTED,
            WsAuthInvalidPolicy.decide(WsAuthInvalidStep.AfterRefresh(TokenRefreshResult.Conflict)),
        )
        assertEquals(
            WsAuthInvalidAction.STAY_DISCONNECTED,
            WsAuthInvalidPolicy.decide(
                WsAuthInvalidStep.AfterRefresh(TokenRefreshResult.TemporarilyUnavailable),
            ),
        )
    }

    @Test
    fun `gateway still rejecting a freshly refreshed token does not kick the session`() {
        assertEquals(
            WsAuthInvalidAction.STAY_DISCONNECTED,
            WsAuthInvalidPolicy.decide(WsAuthInvalidStep.AfterSuccessfulRefreshStillRejected),
        )
    }
}
