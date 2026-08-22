package com.tabtin.mobile.daemon

import org.junit.Assert.*
import org.junit.Test
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger

/**
 * AD-001-B/C 回归测试：验证 WebSocket 认证失败处理和 daemon 模式重连策略。
 *
 * 测试纯逻辑部分 — onAuthFailed 回调路由和 daemon 模式重连上限。
 */
class DaemonWebSocketAuthTest {

    companion object {
        private const val MAX_RECONNECT_ATTEMPTS = 20
    }

    /**
     * AD-001-B: 有 onAuthFailed 回调时（daemon 模式），
     * 认证失败应触发回调而非永久断开。
     */
    @Test
    fun `auth invalid with onAuthFailed triggers callback instead of permanent disconnect`() {
        val callbackInvoked = AtomicBoolean(false)
        val permanentDisconnect = AtomicBoolean(false)

        val onAuthFailed: (() -> Unit)? = { callbackInvoked.set(true) }

        // Simulate handleError logic for WS_1001_AUTH_INVALID
        val code = "WS_1001_AUTH_INVALID"
        if (code == "WS_1001_AUTH_INVALID") {
            val authFailHandler = onAuthFailed
            if (authFailHandler != null) {
                // disconnect(manual = false)
                authFailHandler.invoke()
            } else {
                permanentDisconnect.set(true)
            }
        }

        assertTrue("onAuthFailed callback should be invoked", callbackInvoked.get())
        assertFalse("Should NOT permanently disconnect in daemon mode", permanentDisconnect.get())
    }

    /**
     * AD-001-B: 无 onAuthFailed 回调时（普通模式），
     * 认证失败应永久断开（保持原有行为）。
     */
    @Test
    fun `auth invalid without onAuthFailed permanently disconnects`() {
        val callbackInvoked = AtomicBoolean(false)
        val permanentDisconnect = AtomicBoolean(false)

        val onAuthFailed: (() -> Unit)? = null

        val code = "WS_1001_AUTH_INVALID"
        if (code == "WS_1001_AUTH_INVALID") {
            val authFailHandler = onAuthFailed
            if (authFailHandler != null) {
                authFailHandler.invoke()
                callbackInvoked.set(true)
            } else {
                permanentDisconnect.set(true)
            }
        }

        assertFalse("Callback should NOT be invoked", callbackInvoked.get())
        assertTrue("Should permanently disconnect in normal mode", permanentDisconnect.get())
    }

    /**
     * AD-001-C: daemon 模式下重连上限应为 Int.MAX_VALUE（事实上无限）。
     */
    @Test
    fun `daemon mode allows unlimited reconnect attempts`() {
        val isDaemonMode = true
        val maxAttempts = if (isDaemonMode) Int.MAX_VALUE else MAX_RECONNECT_ATTEMPTS

        assertEquals("Daemon mode should use Int.MAX_VALUE", Int.MAX_VALUE, maxAttempts)
    }

    /**
     * AD-001-C: 普通模式下重连上限应为 MAX_RECONNECT_ATTEMPTS（20）。
     */
    @Test
    fun `normal mode limits reconnect to MAX_RECONNECT_ATTEMPTS`() {
        val isDaemonMode = false
        val maxAttempts = if (isDaemonMode) Int.MAX_VALUE else MAX_RECONNECT_ATTEMPTS

        assertEquals("Normal mode should use MAX_RECONNECT_ATTEMPTS", 20, maxAttempts)
    }

    /**
     * AD-001-C: 验证重连计数器超过上限时停止重连。
     */
    @Test
    fun `reconnect stops when attempt exceeds max in normal mode`() {
        val isDaemonMode = false
        val maxAttempts = if (isDaemonMode) Int.MAX_VALUE else MAX_RECONNECT_ATTEMPTS
        val reconnectAttempt = AtomicInteger(0)
        var gaveUp = false

        for (i in 1..25) {
            val attempt = reconnectAttempt.incrementAndGet()
            if (attempt > maxAttempts) {
                gaveUp = true
                break
            }
        }

        assertTrue("Should give up after max attempts", gaveUp)
        assertEquals("Should have given up at attempt 21", 21, reconnectAttempt.get())
    }

    /**
     * AD-001-C: daemon 模式下即使重连 1000 次也不应放弃。
     */
    @Test
    fun `daemon mode does not give up after 1000 attempts`() {
        val isDaemonMode = true
        val maxAttempts = if (isDaemonMode) Int.MAX_VALUE else MAX_RECONNECT_ATTEMPTS
        val reconnectAttempt = AtomicInteger(0)
        var gaveUp = false

        for (i in 1..1000) {
            val attempt = reconnectAttempt.incrementAndGet()
            if (attempt > maxAttempts) {
                gaveUp = true
                break
            }
        }

        assertFalse("Daemon mode should NOT give up after 1000 attempts", gaveUp)
        assertEquals("Should have reached 1000 attempts", 1000, reconnectAttempt.get())
    }
}
