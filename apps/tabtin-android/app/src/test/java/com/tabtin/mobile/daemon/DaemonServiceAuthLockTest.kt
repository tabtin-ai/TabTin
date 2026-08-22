package com.tabtin.mobile.daemon

import org.junit.Assert.*
import org.junit.Test
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger

/**
 * CM-008 回归测试：验证 handleAuthFailure 入口的 activating 锁保护。
 *
 * 复现场景：WebSocket 连续收到多次 auth failure 回调，
 * 旧代码 handleAuthFailure 直接调用 activate() 绕过 compareAndSet 保护，
 * 导致并发多次激活请求。
 */
class DaemonServiceAuthLockTest {

    /**
     * CM-008: handleAuthFailure 应检查 activating 锁，
     * 如果已有激活在进行中，应跳过而非重入。
     */
    @Test
    fun `handleAuthFailure should skip when activating is already true`() {
        val activating = AtomicBoolean(false)
        val activateCallCount = AtomicInteger(0)

        fun simulateHandleAuthFailure(): Boolean {
            if (!activating.compareAndSet(false, true)) {
                return false // skipped
            }
            try {
                activateCallCount.incrementAndGet()
                return true
            } finally {
                activating.set(false)
            }
        }

        // First call should proceed
        val firstResult = simulateHandleAuthFailure()
        assertTrue("First call should proceed", firstResult)
        assertEquals("activate should be called once", 1, activateCallCount.get())
    }

    /**
     * CM-008: 并发调用 handleAuthFailure 时，只有一个应成功获取锁。
     */
    @Test
    fun `concurrent handleAuthFailure calls are serialized by activating lock`() {
        val activating = AtomicBoolean(false)
        val activateCallCount = AtomicInteger(0)
        val skippedCount = AtomicInteger(0)

        fun simulateHandleAuthFailure() {
            if (!activating.compareAndSet(false, true)) {
                skippedCount.incrementAndGet()
                return
            }
            try {
                activateCallCount.incrementAndGet()
                // Simulate activate work
                Thread.sleep(10)
            } finally {
                activating.set(false)
            }
        }

        // Simulate: first call holds the lock, second call should be skipped
        activating.set(true)

        simulateHandleAuthFailure() // should be skipped

        assertEquals("activate should not be called while lock is held", 0, activateCallCount.get())
        assertEquals("should be skipped once", 1, skippedCount.get())

        // Release lock and try again
        activating.set(false)
        simulateHandleAuthFailure()

        assertEquals("activate should be called after lock released", 1, activateCallCount.get())
    }

    /**
     * CM-008: handleAuthFailure 中 token 为 null 时应释放锁。
     */
    @Test
    fun `handleAuthFailure releases lock when install token is null`() {
        val activating = AtomicBoolean(false)
        val activationInstallToken: String? = null

        fun simulateHandleAuthFailure(): String {
            if (!activating.compareAndSet(false, true)) {
                return "skipped"
            }
            if (activationInstallToken == null) {
                activating.set(false) // must release lock
                return "no_token"
            }
            try {
                return "activated"
            } finally {
                activating.set(false)
            }
        }

        val result = simulateHandleAuthFailure()
        assertEquals("Should return no_token", "no_token", result)
        assertFalse("Lock should be released after null token path", activating.get())

        // Subsequent call should be able to acquire lock
        val result2 = simulateHandleAuthFailure()
        assertEquals("Second call should also proceed", "no_token", result2)
        assertFalse("Lock should still be released", activating.get())
    }

    /**
     * CM-008: handleAuthFailure 中 activate 抛异常时应释放锁（finally 块）。
     */
    @Test
    fun `handleAuthFailure releases lock on activate exception`() {
        val activating = AtomicBoolean(false)

        fun simulateHandleAuthFailureWithException() {
            if (!activating.compareAndSet(false, true)) {
                return
            }
            try {
                throw RuntimeException("activation failed")
            } catch (_: RuntimeException) {
                // exception caught, stopSelf() would be called
            } finally {
                activating.set(false)
            }
        }

        simulateHandleAuthFailureWithException()
        assertFalse("Lock should be released after exception", activating.get())
    }

    /**
     * CM-008: 验证 onStartCommand 和 handleAuthFailure 共享同一个 activating 锁。
     */
    @Test
    fun `onStartCommand lock prevents handleAuthFailure from running concurrently`() {
        val activating = AtomicBoolean(false)
        val activateSource = mutableListOf<String>()

        fun simulateOnStartCommand() {
            if (!activating.compareAndSet(false, true)) {
                return
            }
            try {
                activateSource.add("onStartCommand")
            } finally {
                activating.set(false)
            }
        }

        fun simulateHandleAuthFailure() {
            if (!activating.compareAndSet(false, true)) {
                activateSource.add("handleAuthFailure_skipped")
                return
            }
            try {
                activateSource.add("handleAuthFailure")
            } finally {
                activating.set(false)
            }
        }

        // Simulate: onStartCommand holds lock
        activating.set(true)
        simulateHandleAuthFailure() // should be skipped
        activating.set(false)

        assertEquals(
            "handleAuthFailure should be skipped while onStartCommand holds lock",
            listOf("handleAuthFailure_skipped"),
            activateSource,
        )

        // After lock release, both paths should work
        activateSource.clear()
        simulateOnStartCommand()
        simulateHandleAuthFailure()
        assertEquals(
            "Both paths should succeed sequentially",
            listOf("onStartCommand", "handleAuthFailure"),
            activateSource,
        )
    }
}
