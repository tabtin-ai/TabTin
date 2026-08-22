package com.tabtin.mobile.features.profile

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class MobileEnvironmentQrTest {
    @Test
    fun `parses versioned desktop payload`() {
        val payload = "tabtin://mobile-environment?v=1&api=https%3A%2F%2Fapi.example.com%2Fapi&ws=wss%3A%2F%2Fapi.example.com%2Fws%2Fv1%2Fgateway&web=https%3A%2F%2Fapp.example.com&centrifugo=wss%3A%2F%2Fapi.example.com%2Fconnection%2Fwebsocket"

        assertEquals(
            MobileEnvironmentConfiguration(
                apiUrl = "https://api.example.com/api",
                websocketUrl = "wss://api.example.com/ws/v1/gateway",
                webUrl = "https://app.example.com",
                centrifugoUrl = "wss://api.example.com/connection/websocket",
            ),
            MobileEnvironmentQr.parse(payload),
        )
    }

    @Test
    fun `rejects unsupported version`() {
        assertNull(
            MobileEnvironmentQr.parse(
                "tabtin://mobile-environment?v=2&api=https://api.example.com/api&ws=wss://api.example.com/ws&web=https://app.example.com&centrifugo=wss://api.example.com/connection/websocket",
            ),
        )
    }

    @Test
    fun `rejects incomplete payload`() {
        assertNull(
            MobileEnvironmentQr.parse(
                "tabtin://mobile-environment?v=1&api=https://api.example.com/api&ws=wss://api.example.com/ws&web=https://app.example.com",
            ),
        )
    }
}
