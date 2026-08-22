package com.tabtin.mobile.features.conversation

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class SessionReadyIndicatorPolicyTest {
    @Test
    fun showsReadyOnlyWhenWsConnectedAndExecutionDeviceReady() {
        assertTrue(
            SessionReadyIndicatorPolicy.showsReady(
                wsConnected = true,
                remoteExecutionState = RemoteExecutionState.READY,
            ),
        )
        assertFalse(
            SessionReadyIndicatorPolicy.showsReady(
                wsConnected = true,
                remoteExecutionState = RemoteExecutionState.DEVICE_UNAVAILABLE,
            ),
        )
        assertFalse(
            SessionReadyIndicatorPolicy.showsReady(
                wsConnected = true,
                remoteExecutionState = RemoteExecutionState.WORKSPACE_NEEDS_DEVICE,
            ),
        )
        assertFalse(
            SessionReadyIndicatorPolicy.showsReady(
                wsConnected = false,
                remoteExecutionState = RemoteExecutionState.READY,
            ),
        )
        assertFalse(
            SessionReadyIndicatorPolicy.showsReady(
                wsConnected = false,
                remoteExecutionState = RemoteExecutionState.DEVICE_UNAVAILABLE,
            ),
        )
    }
}
