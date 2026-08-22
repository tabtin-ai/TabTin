package com.tabtin.mobile.data.websocket

import android.os.SystemClock
import android.util.Log
import com.tabtin.mobile.data.automation.ActionRouter
import com.tabtin.mobile.data.automation.DeviceActionResult
import com.tabtin.mobile.data.automation.DeviceSecurityConfirm
import com.tabtin.mobile.data.automation.SecurityConfirmDecision
import com.tabtin.mobile.data.automation.SessionPermissionApprovalCache
import com.tabtin.mobile.data.model.WSEnvelope
import io.mockk.coEvery
import io.mockk.coVerify
import io.mockk.every
import io.mockk.mockk
import io.mockk.mockkStatic
import io.mockk.unmockkStatic
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.delay
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicInteger

/**
 * MDP-004 / MDP-005 回归测试 + 会话级审批缓存：
 * - MDP-004: securityConfirm 未注入时返回 CONFIRM_UNAVAILABLE 而非静默拒绝
 * - MDP-005: confirm 协程超时后返回 CONFIRM_TIMEOUT
 * - Session cache: ALLOW_SESSION / DENY 按 permission key 短路；cancelAll 清空
 *
 * Wave A0.2（2026-05-04）：去掉 `@RunWith(RobolectricTestRunner::class)` 改为纯
 * JUnit4 + mockk + mockkStatic。原因：DeviceActionDispatcher 生产代码 0 KeyStore
 * 调用，但 Robolectric 4.14 默认拉起 TabTinApp（@HiltAndroidApp）→ Hilt 注入
 * AppLifecycleManager → TokenManager（EncryptedSharedPreferences）→ AndroidKeyStore
 * shadow 失效 → KeyStoreException → NoSuchAlgorithmException。详见 W A0.2 反思 §3。
 */
@OptIn(ExperimentalCoroutinesApi::class)
class DeviceActionDispatcherTest {

    private val testDispatcher = StandardTestDispatcher()
    private val sentEnvelopes = CopyOnWriteArrayList<WSEnvelope>()

    private val fakeRouter = mockk<ActionRouter> {
        coEvery { execute(any(), any()) } returns DeviceActionResult(success = true)
        every { getTimeoutMs(any()) } returns 30_000L
    }

    @Before
    fun setUp() {
        // 纯 JUnit4 模式下 android.jar 是 stub jar，static 调用默认抛
        // RuntimeException("Stub!")。DeviceActionDispatcher 用到：
        //   - SystemClock.elapsedRealtime() （sendResult 算 executionTimeMs）
        //   - Log.e / Log.w （错误日志）
        // 用 mockkStatic 重定向到默认返回值，业务断言不依赖时间戳/日志。
        mockkStatic(SystemClock::class)
        every { SystemClock.elapsedRealtime() } returns 0L
        mockkStatic(Log::class)
        every { Log.e(any(), any<String>()) } returns 0
        every { Log.e(any(), any<String>(), any<Throwable>()) } returns 0
        every { Log.w(any<String>(), any<String>()) } returns 0

        Dispatchers.setMain(testDispatcher)
        sentEnvelopes.clear()
        DeviceSecurityConfirm.clearForTest()
    }

    @After
    fun tearDown() {
        Dispatchers.resetMain()
        unmockkStatic(SystemClock::class)
        unmockkStatic(Log::class)
        DeviceSecurityConfirm.clearForTest()
    }

    private fun buildDispatcher(
        scope: TestScope,
        securityConfirm: SecurityConfirmCallback? = null,
        sessionApprovals: SessionPermissionApprovalCache = SessionPermissionApprovalCache(),
    ): DeviceActionDispatcher = DeviceActionDispatcher(
        actionRouter = fakeRouter,
        scope = scope,
        deviceId = { "test-device" },
        organizationId = { "ws-1" },
        sendEnvelope = { sentEnvelopes.add(it) },
        securityConfirm = securityConfirm,
        sessionApprovals = sessionApprovals,
    )

    private fun confirmEnvelope(
        taskId: String = "task-1",
        action: String = "read_contacts",
        permissionKey: String = "read_contacts",
    ): WSEnvelope = WSEnvelope(
        type = "agent.action.request",
        payload = buildJsonObject {
            put("task_id", taskId)
            put("action", action)
            put("thread_id", "thread-1")
            put("sandbox_policy", buildJsonObject {
                put("device_permissions", buildJsonObject {
                    put(permissionKey, "confirm")
                })
            })
        },
        threadId = "thread-1",
        organizationId = "ws-1",
    )

    private fun extractErrorCode(envelope: WSEnvelope): String? =
        envelope.payloadString("error_code")

    private fun extractError(envelope: WSEnvelope): String? =
        envelope.payloadString("error")

    // ── MDP-004 ────────────────────────────────────────────────

    @Test
    fun `MDP-004 securityConfirm null returns CONFIRM_UNAVAILABLE`() = runTest {
        val dispatcher = buildDispatcher(scope = this, securityConfirm = null)
        dispatcher.handleRequest(confirmEnvelope())
        advanceUntilIdle()

        assertEquals("应发送一条结果", 1, sentEnvelopes.size)
        assertEquals("CONFIRM_UNAVAILABLE", extractErrorCode(sentEnvelopes[0]))
        assertTrue(
            "错误消息应说明 confirm 不可用",
            extractError(sentEnvelopes[0])!!.contains("not available"),
        )
    }

    @Test
    fun `MDP-004 securityConfirm null must NOT return APPROVAL_DENIED`() = runTest {
        val dispatcher = buildDispatcher(scope = this, securityConfirm = null)
        dispatcher.handleRequest(confirmEnvelope())
        advanceUntilIdle()

        assertEquals(1, sentEnvelopes.size)
        assertNotEquals(
            "APPROVAL_DENIED 仅用于用户主动拒绝",
            "APPROVAL_DENIED",
            extractErrorCode(sentEnvelopes[0]),
        )
    }

    @Test
    fun `MDP-004 user denies via injected callback returns APPROVAL_DENIED`() = runTest {
        val callback = SecurityConfirmCallback { _, _ -> SecurityConfirmDecision.DENY }
        val dispatcher = buildDispatcher(scope = this, securityConfirm = callback)
        dispatcher.handleRequest(confirmEnvelope())
        advanceUntilIdle()

        assertEquals(1, sentEnvelopes.size)
        assertEquals("APPROVAL_DENIED", extractErrorCode(sentEnvelopes[0]))
        assertEquals("User denied the action", extractError(sentEnvelopes[0]))
    }

    @Test
    fun `MDP-004 user approves via injected callback executes action`() = runTest {
        val callback = SecurityConfirmCallback { _, _ -> SecurityConfirmDecision.ALLOW_ONCE }
        val dispatcher = buildDispatcher(scope = this, securityConfirm = callback)
        dispatcher.handleRequest(confirmEnvelope())
        advanceUntilIdle()

        assertEquals(1, sentEnvelopes.size)
        assertEquals(
            "true",
            sentEnvelopes[0].payload["success"]?.jsonPrimitive?.contentOrNull,
        )
    }

    // ── MDP-005 ────────────────────────────────────────────────

    @Test
    fun `MDP-005 confirm timeout returns CONFIRM_TIMEOUT after 5 minutes`() = runTest {
        val neverResponds = SecurityConfirmCallback { _, _ ->
            delay(Long.MAX_VALUE / 2)
            SecurityConfirmDecision.ALLOW_ONCE
        }
        val dispatcher = buildDispatcher(scope = this, securityConfirm = neverResponds)
        dispatcher.handleRequest(confirmEnvelope())

        advanceTimeBy(DeviceActionDispatcher.CONFIRM_TIMEOUT_MS + 1)
        advanceUntilIdle()

        assertEquals("超时后应发送结果", 1, sentEnvelopes.size)
        assertEquals("CONFIRM_TIMEOUT", extractErrorCode(sentEnvelopes[0]))
        // commit 1a1578084 改 CONFIRM_TIMEOUT_MS 60_000L → 300_000L（commit message 未具体
        // 说明该字段动机；🔵 推断为给用户更长响应窗口，但需 product spec 补足）。
        // error msg 由 sendResult 拼接为 "User did not respond within ${CONFIRM_TIMEOUT_MS / 1000}s"。
        assertTrue(
            "错误消息应包含超时秒数（CONFIRM_TIMEOUT_MS / 1000 = 300）",
            extractError(sentEnvelopes[0])!!.contains("300"),
        )
    }

    @Test
    fun `MDP-005 prompt response within timeout does NOT trigger timeout`() = runTest {
        val quickApprove = SecurityConfirmCallback { _, _ ->
            delay(1_000L)
            SecurityConfirmDecision.ALLOW_ONCE
        }
        val dispatcher = buildDispatcher(scope = this, securityConfirm = quickApprove)
        dispatcher.handleRequest(confirmEnvelope())
        advanceUntilIdle()

        assertEquals(1, sentEnvelopes.size)
        assertNotEquals("CONFIRM_TIMEOUT", extractErrorCode(sentEnvelopes[0]))
        assertEquals(
            "true",
            sentEnvelopes[0].payload["success"]?.jsonPrimitive?.contentOrNull,
        )
    }

    @Test
    fun `MDP-005 CONFIRM_TIMEOUT_MS equals 5 minutes`() {
        // 🟢 严格事实：commit 1a1578084 (feat: 计费护栏与编排硬化、多端账单通知...) 把
        // CONFIRM_TIMEOUT_MS 从 60_000L → 300_000L，但漏改测试断言；W A0.2 顺手对齐生产
        // 当前事实（commit message 未具体说明该字段动机；🔵 推断为给用户更长响应窗口）。
        // 详见 W A0.2 反思 §3.5。
        assertEquals(300_000L, DeviceActionDispatcher.CONFIRM_TIMEOUT_MS)
    }

    // ── Session approval cache ─────────────────────────────────

    @Test
    fun `session allow skips confirm for same permission key including aliases`() = runTest {
        val confirmCount = AtomicInteger(0)
        val callback = SecurityConfirmCallback { _, _ ->
            confirmCount.incrementAndGet()
            SecurityConfirmDecision.ALLOW_SESSION
        }
        val dispatcher = buildDispatcher(scope = this, securityConfirm = callback)

        dispatcher.handleRequest(
            confirmEnvelope(taskId = "t1", action = "screen_tap", permissionKey = "screen_tap"),
        )
        advanceUntilIdle()
        dispatcher.handleRequest(
            confirmEnvelope(taskId = "t2", action = "screen_swipe", permissionKey = "screen_tap"),
        )
        advanceUntilIdle()

        assertEquals("第二次应走会话缓存，不再弹窗", 1, confirmCount.get())
        assertEquals(2, sentEnvelopes.size)
        assertEquals(
            "true",
            sentEnvelopes[1].payload["success"]?.jsonPrimitive?.contentOrNull,
        )
        coVerify(exactly = 2) { fakeRouter.execute(any(), any()) }
    }

    @Test
    fun `session deny caches and skips confirm with APPROVAL_DENIED`() = runTest {
        val confirmCount = AtomicInteger(0)
        val callback = SecurityConfirmCallback { _, _ ->
            confirmCount.incrementAndGet()
            SecurityConfirmDecision.DENY
        }
        val dispatcher = buildDispatcher(scope = this, securityConfirm = callback)

        dispatcher.handleRequest(confirmEnvelope(taskId = "t1"))
        advanceUntilIdle()
        dispatcher.handleRequest(confirmEnvelope(taskId = "t2"))
        advanceUntilIdle()

        assertEquals(1, confirmCount.get())
        assertEquals(2, sentEnvelopes.size)
        assertEquals("APPROVAL_DENIED", extractErrorCode(sentEnvelopes[0]))
        assertEquals("APPROVAL_DENIED", extractErrorCode(sentEnvelopes[1]))
        coVerify(exactly = 0) { fakeRouter.execute(any(), any()) }
    }

    @Test
    fun `allow once does not cache and asks again`() = runTest {
        val confirmCount = AtomicInteger(0)
        val callback = SecurityConfirmCallback { _, _ ->
            confirmCount.incrementAndGet()
            SecurityConfirmDecision.ALLOW_ONCE
        }
        val dispatcher = buildDispatcher(scope = this, securityConfirm = callback)

        dispatcher.handleRequest(confirmEnvelope(taskId = "t1"))
        advanceUntilIdle()
        dispatcher.handleRequest(confirmEnvelope(taskId = "t2"))
        advanceUntilIdle()

        assertEquals(2, confirmCount.get())
        assertEquals(2, sentEnvelopes.size)
    }

    @Test
    fun `cancelAll clears session cache so confirm returns`() = runTest {
        val confirmCount = AtomicInteger(0)
        val callback = SecurityConfirmCallback { _, _ ->
            confirmCount.incrementAndGet()
            SecurityConfirmDecision.ALLOW_SESSION
        }
        val dispatcher = buildDispatcher(scope = this, securityConfirm = callback)

        dispatcher.handleRequest(confirmEnvelope(taskId = "t1"))
        advanceUntilIdle()
        dispatcher.cancelAll()
        dispatcher.handleRequest(confirmEnvelope(taskId = "t2"))
        advanceUntilIdle()

        assertEquals("清空后应重新询问", 2, confirmCount.get())
    }

    @Test
    fun `uncached path still returns CONFIRM_UNAVAILABLE when callback missing`() = runTest {
        val cache = SessionPermissionApprovalCache()
        val dispatcher = buildDispatcher(
            scope = this,
            securityConfirm = null,
            sessionApprovals = cache,
        )
        dispatcher.handleRequest(confirmEnvelope())
        advanceUntilIdle()

        assertEquals("CONFIRM_UNAVAILABLE", extractErrorCode(sentEnvelopes[0]))
        assertEquals(0, cache.size())
    }
}
