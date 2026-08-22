package com.tabtin.mobile.data.automation

import com.tabtin.mobile.data.websocket.SecurityConfirmCallback

/**
 * Process-wide fallback [SecurityConfirmCallback] used when
 * [com.tabtin.mobile.data.websocket.DeviceActionDispatcher] was constructed
 * without an explicit callback (current [com.tabtin.mobile.data.websocket.WebSocketService]
 * wiring). Installed by [AndroidSecurityConfirmCallback] via Hilt.
 */
public object DeviceSecurityConfirm {
    @Volatile
    private var installed: SecurityConfirmCallback? = null

    public fun install(callback: SecurityConfirmCallback) {
        installed = callback
    }

    public fun callback(): SecurityConfirmCallback? = installed

    /** Test-only: drop the installed callback. */
    internal fun clearForTest() {
        installed = null
    }
}
