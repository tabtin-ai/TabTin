package com.tabtin.mobile.data.api

import com.tabtin.mobile.BuildConfig
import com.tabtin.mobile.util.TokenManager
import io.mockk.every
import io.mockk.mockk
import org.junit.Assert.assertEquals
import org.junit.Test

class AndroidImEnvironmentConfigTest {

    @Test
    fun `debug build defaults API and TabChat REST to api test`() {
        assertEquals("https://api-test.example.com/api", BuildConfig.API_BASE_URL)
        assertEquals(BuildConfig.API_BASE_URL, BuildConfig.IM_API_BASE_URL)
    }

    @Test
    fun `TabChat REST follows debug API override`() {
        val tokenManager = mockk<TokenManager>(relaxed = true)
        every { tokenManager.isDaemonMode } returns false
        every { tokenManager.debugApiBaseUrl } returns "https://api-test.example.com/api"

        assertEquals(
            "https://api-test.example.com/api",
            resolveEffectiveApiBaseUrl(tokenManager),
        )
    }

    @Test
    fun `legacy local API value does not override explicit debug API for TabChat`() {
        val tokenManager = mockk<TokenManager>(relaxed = true)
        every { tokenManager.isDaemonMode } returns false
        every { tokenManager.debugApiBaseUrl } returns "https://api-test.example.com/api"
        every { tokenManager.apiBaseUrl } returns "http://10.0.2.2:9099/api"

        assertEquals(
            "https://api-test.example.com/api",
            resolveEffectiveApiBaseUrl(tokenManager),
        )
    }

    @Test
    fun `legacy scanned environment preserves dedicated Web and Centrifugo endpoints`() {
        val tokenManager = mockk<TokenManager>(relaxed = true)
        every { tokenManager.isDaemonMode } returns false
        every { tokenManager.debugApiBaseUrl } returns "http://192.168.31.100:6060/api"
        every { tokenManager.debugWsBaseUrl } returns
            "ws://192.168.31.100:6060/ws/v1/gateway"
        every { tokenManager.webBaseUrl } returns "http://192.168.31.100:5176"
        every { tokenManager.centrifugoWsUrl } returns
            "ws://192.168.31.100:8100/connection/websocket"
        every { tokenManager.debugAdvancedEnabled } returns false

        assertEquals(
            NetworkEnvironment(
                apiBaseUrl = "http://192.168.31.100:6060/api",
                wsBaseUrl = "ws://192.168.31.100:6060/ws/v1/gateway",
                webBaseUrl = "http://192.168.31.100:5176",
                centrifugoWsUrl = "ws://192.168.31.100:8100/connection/websocket",
            ),
            resolveEffectiveNetworkEnvironment(tokenManager),
        )
    }

    @Test
    fun `legacy scanned local environment repairs API port used for Centrifugo`() {
        val tokenManager = mockk<TokenManager>(relaxed = true)
        every { tokenManager.isDaemonMode } returns false
        every { tokenManager.debugApiBaseUrl } returns "http://192.168.31.100:6060/api"
        every { tokenManager.debugWsBaseUrl } returns
            "ws://192.168.31.100:6060/ws/v1/gateway"
        every { tokenManager.webBaseUrl } returns "http://192.168.31.100:5176"
        every { tokenManager.centrifugoWsUrl } returns
            "ws://192.168.31.100:6060/connection/websocket"
        every { tokenManager.debugEnvironmentPreset } returns "custom"
        every { tokenManager.debugCustomBaseUrl } returns "http://192.168.31.100:5176"
        every { tokenManager.debugAdvancedEnabled } returns true
        every { tokenManager.debugAdvancedApiUrl } returns
            "http://192.168.31.100:6060/api"
        every { tokenManager.debugAdvancedWsUrl } returns
            "ws://192.168.31.100:6060/ws/v1/gateway"
        every { tokenManager.debugAdvancedWebUrl } returns
            "http://192.168.31.100:5176"
        every { tokenManager.debugAdvancedCentrifugoUrl } returns
            "ws://192.168.31.100:6060/connection/websocket"

        assertEquals(
            "ws://192.168.31.100:8100/connection/websocket",
            resolveEffectiveCentrifugoWsUrl(tokenManager),
        )
    }

    @Test
    fun `unlocked release build applies the complete debug environment`() {
        val tokenManager = mockk<TokenManager>(relaxed = true)
        every { tokenManager.isDaemonMode } returns false
        every { tokenManager.isDebugEntryUnlocked } returns true
        every { tokenManager.debugApiBaseUrl } returns "https://api-test.example.com/api"
        every { tokenManager.debugWsBaseUrl } returns "wss://api-test.example.com/ws/v1/gateway"
        every { tokenManager.webBaseUrl } returns "https://web-test.example.com"
        every { tokenManager.centrifugoWsUrl } returns
            "wss://centrifugo-test.example.com/connection/websocket"

        assertEquals(
            "https://api-test.example.com/api",
            resolveEffectiveApiBaseUrl(tokenManager, isDebugBuild = false),
        )
        assertEquals(
            "wss://api-test.example.com/ws/v1/gateway",
            resolveEffectiveWsBaseUrl(tokenManager, isDebugBuild = false),
        )
        assertEquals(
            "https://web-test.example.com",
            resolveEffectiveWebBaseUrl(tokenManager, isDebugBuild = false),
        )
        assertEquals(
            "wss://centrifugo-test.example.com/connection/websocket",
            resolveEffectiveCentrifugoWsUrl(tokenManager, isDebugBuild = false),
        )
    }

    @Test
    fun `legacy test API override keeps every network client on test`() {
        val tokenManager = mockk<TokenManager>(relaxed = true)
        every { tokenManager.isDaemonMode } returns false
        every { tokenManager.isDebugEntryUnlocked } returns true
        every { tokenManager.debugApiBaseUrl } returns null
        every { tokenManager.apiBaseUrl } returns "https://api-test.example.com/api"
        every { tokenManager.debugWsBaseUrl } returns null
        every { tokenManager.wsBaseUrl } returns null
        every { tokenManager.webBaseUrl } returns null
        every { tokenManager.centrifugoWsUrl } returns null

        assertEquals(
            "https://api-test.example.com/api",
            resolveEffectiveApiBaseUrl(tokenManager, isDebugBuild = false),
        )
        assertEquals(
            "wss://api-test.example.com/ws/v1/gateway",
            resolveEffectiveWsBaseUrl(tokenManager, isDebugBuild = false),
        )
        assertEquals(
            "https://web-test.example.com",
            resolveEffectiveWebBaseUrl(tokenManager, isDebugBuild = false),
        )
        assertEquals(
            "wss://centrifugo-test.example.com/connection/websocket",
            resolveEffectiveCentrifugoWsUrl(tokenManager, isDebugBuild = false),
        )
    }

    @Test
    fun `daemon API without WS derives one coherent custom environment`() {
        val tokenManager = mockk<TokenManager>(relaxed = true)
        every { tokenManager.isDaemonMode } returns true
        every { tokenManager.apiBaseUrl } returns "http://192.168.1.9:6060/api"
        every { tokenManager.wsBaseUrl } returns null

        assertEquals(
            NetworkEnvironment(
                apiBaseUrl = "http://192.168.1.9:6060/api",
                wsBaseUrl = "ws://192.168.1.9:6060/ws/v1/gateway",
                webBaseUrl = "http://192.168.1.9:6060",
                centrifugoWsUrl = "ws://192.168.1.9:6060/connection/websocket",
            ),
            resolveEffectiveNetworkEnvironment(tokenManager),
        )
    }

    @Test
    fun `release build applies saved debug environment without an unlock key`() {
        val tokenManager = mockk<TokenManager>(relaxed = true)
        every { tokenManager.isDaemonMode } returns false
        every { tokenManager.isDebugEntryUnlocked } returns false
        every { tokenManager.debugEnvironmentPreset } returns "custom"
        every { tokenManager.debugCustomBaseUrl } returns "https://web-override.example"
        every { tokenManager.debugAdvancedEnabled } returns true
        every { tokenManager.debugAdvancedApiUrl } returns "https://api-override.example/api"
        every { tokenManager.debugAdvancedWsUrl } returns "wss://api-override.example/ws/v1/gateway"
        every { tokenManager.debugAdvancedWebUrl } returns "https://web-override.example"
        every { tokenManager.debugAdvancedCentrifugoUrl } returns
            "wss://centrifugo-override.example/connection/websocket"

        assertEquals(
            "https://api-override.example/api",
            resolveEffectiveApiBaseUrl(tokenManager, isDebugBuild = false),
        )
        assertEquals(
            "wss://api-override.example/ws/v1/gateway",
            resolveEffectiveWsBaseUrl(tokenManager, isDebugBuild = false),
        )
        assertEquals(
            "https://web-override.example",
            resolveEffectiveWebBaseUrl(tokenManager, isDebugBuild = false),
        )
        assertEquals(
            "wss://centrifugo-override.example/connection/websocket",
            resolveEffectiveCentrifugoWsUrl(tokenManager, isDebugBuild = false),
        )
    }
}
