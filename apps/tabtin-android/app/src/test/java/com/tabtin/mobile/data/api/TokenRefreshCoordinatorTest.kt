package com.tabtin.mobile.data.api

import android.util.Log
import com.tabtin.mobile.data.model.ApiEnvelope
import com.tabtin.mobile.data.model.RefreshTokenResponse
import com.tabtin.mobile.util.TokenManager
import dagger.Lazy
import io.mockk.every
import io.mockk.mockk
import io.mockk.mockkStatic
import io.mockk.unmockkStatic
import io.mockk.verify
import okhttp3.Protocol
import okhttp3.Request
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import retrofit2.Call
import java.net.SocketTimeoutException
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

/**
 * CR-008 回归测试：验证 TokenRefreshCoordinator 的并发竞态修复。
 *
 * 覆盖场景：
 * 1. wait 超时后若 TokenManager 中存在有效 token，返回该 token 而非 null
 * 2. 超时后 token 无效或即将过期，返回 null
 * 3. TokenAuthenticator 在 refreshBlocking 返回 null 后检查 fallback token
 */
class TokenRefreshCoordinatorTest {

    private lateinit var tokenManager: TokenManager
    private lateinit var authApi: AuthApi
    private lateinit var authApiLazy: Lazy<AuthApi>

    @Before
    fun setUp() {
        mockkStatic(Log::class)
        every { Log.i(any(), any()) } returns 0
        every { Log.w(any(), any<String>()) } returns 0
        every { Log.e(any(), any<String>()) } returns 0
        every { Log.d(any(), any<String>()) } returns 0

        tokenManager = mockk(relaxed = true)
        authApi = mockk(relaxed = true)
        authApiLazy = Lazy { authApi }
    }

    @After
    fun tearDown() {
        unmockkStatic(Log::class)
    }

    private fun stubSlowRefreshCall(latch: CountDownLatch): Call<ApiEnvelope<RefreshTokenResponse>> {
        val slowCall = mockk<Call<ApiEnvelope<RefreshTokenResponse>>>()
        every { authApi.refreshTokenSync(any()) } returns slowCall
        every { slowCall.execute() } answers {
            latch.countDown()
            Thread.sleep(5_000)
            throw SocketTimeoutException("simulated slow network")
        }
        return slowCall
    }

    /**
     * CR-008 核心场景：等待线程超时，但 TokenManager 中已有有效 token，
     * 应返回该 token 而非 null（防止误触发 logout）。
     */
    @Test
    fun `waiter returns fallback token on timeout when valid token exists in store`() {
        every { tokenManager.refreshToken } returns "valid-rt"
        every { tokenManager.accessToken } returns "fresh-token"
        every { tokenManager.isAccessTokenExpiringSoon } returns false

        val refresherEntered = CountDownLatch(1)
        stubSlowRefreshCall(refresherEntered)

        val coordinator = TokenRefreshCoordinator(tokenManager, authApiLazy, waitTimeoutMs = 300L)
        val waiterResult = AtomicReference<String?>("SENTINEL")

        val refresher = Thread { coordinator.refreshBlocking() }
        refresher.start()
        assertTrue("Refresher should enter HTTP call", refresherEntered.await(2, TimeUnit.SECONDS))
        Thread.sleep(50)

        val waiter = Thread { waiterResult.set(coordinator.refreshBlocking()) }
        waiter.start()
        waiter.join(2_000)

        assertEquals("fresh-token", waiterResult.get())
        refresher.interrupt()
        refresher.join(1_000)
    }

    @Test
    fun `semantic waiters preserve transient failure instead of replaying stale token`() {
        every { tokenManager.refreshToken } returns "valid-rt"
        every { tokenManager.accessToken } returns "stale-but-locally-valid-token"
        every { tokenManager.isAccessTokenExpiringSoon } returns false

        val refresherEntered = CountDownLatch(1)
        val releaseRefresh = CountDownLatch(1)
        val failedCall = mockk<Call<ApiEnvelope<RefreshTokenResponse>>>()
        every { authApi.refreshTokenSync(any()) } returns failedCall
        every { failedCall.execute() } answers {
            refresherEntered.countDown()
            assertTrue(releaseRefresh.await(2, TimeUnit.SECONDS))
            retrofit2.Response.error(500, "{}".toResponseBody())
        }

        val coordinator = TokenRefreshCoordinator(tokenManager, authApiLazy)
        val refresherResult = AtomicReference<TokenRefreshResult>()
        val waiterResult = AtomicReference<TokenRefreshResult>()
        val refresher = Thread { refresherResult.set(coordinator.refreshBlockingResult()) }
        val waiter = Thread { waiterResult.set(coordinator.refreshBlockingResult()) }

        refresher.start()
        assertTrue(refresherEntered.await(2, TimeUnit.SECONDS))
        waiter.start()
        Thread.sleep(50)
        releaseRefresh.countDown()
        refresher.join(2_000)
        waiter.join(2_000)

        assertEquals(TokenRefreshResult.TemporarilyUnavailable, refresherResult.get())
        assertEquals(TokenRefreshResult.TemporarilyUnavailable, waiterResult.get())
        verify(exactly = 1) { authApi.refreshTokenSync(any()) }
    }

    /**
     * CR-008 场景：超时后 TokenManager 中无有效 token，应返回 null。
     */
    @Test
    fun `waiter returns null on timeout when no valid token in store`() {
        every { tokenManager.refreshToken } returns "rt"
        every { tokenManager.accessToken } returns null

        val refresherEntered = CountDownLatch(1)
        stubSlowRefreshCall(refresherEntered)

        val coordinator = TokenRefreshCoordinator(tokenManager, authApiLazy, waitTimeoutMs = 300L)
        val waiterResult = AtomicReference<String?>("SENTINEL")

        val refresher = Thread { coordinator.refreshBlocking() }
        refresher.start()
        assertTrue(refresherEntered.await(2, TimeUnit.SECONDS))
        Thread.sleep(50)

        val waiter = Thread { waiterResult.set(coordinator.refreshBlocking()) }
        waiter.start()
        waiter.join(2_000)

        assertNull("Should return null when no valid token", waiterResult.get())
        refresher.interrupt()
        refresher.join(1_000)
    }

    /**
     * CR-008 场景：超时后 token 存在但即将过期，不应作为 fallback 返回。
     */
    @Test
    fun `waiter returns null on timeout when token is expiring soon`() {
        every { tokenManager.refreshToken } returns "rt"
        every { tokenManager.accessToken } returns "almost-dead"
        every { tokenManager.isAccessTokenExpiringSoon } returns true

        val refresherEntered = CountDownLatch(1)
        stubSlowRefreshCall(refresherEntered)

        val coordinator = TokenRefreshCoordinator(tokenManager, authApiLazy, waitTimeoutMs = 300L)
        val waiterResult = AtomicReference<String?>("SENTINEL")

        val refresher = Thread { coordinator.refreshBlocking() }
        refresher.start()
        assertTrue(refresherEntered.await(2, TimeUnit.SECONDS))
        Thread.sleep(50)

        val waiter = Thread { waiterResult.set(coordinator.refreshBlocking()) }
        waiter.start()
        waiter.join(2_000)

        assertNull("Should return null when token expiring soon", waiterResult.get())
        refresher.interrupt()
        refresher.join(1_000)
    }

    /**
     * TokenAuthenticator 回归：刷新暂时失败但 store 中有新 token 时，
     * 应用该 token 重试而非触发 logout。
     */
    @Test
    fun `authenticator uses fallback token instead of logging out`() {
        val coordinator = mockk<TokenRefreshCoordinator>()
        every { coordinator.refreshBlockingResult() } returns TokenRefreshResult.TemporarilyUnavailable

        every { tokenManager.accessToken } returnsMany listOf(
            "stale-token",
            "new-token-from-elsewhere",
        )

        val authenticator = TokenAuthenticator(tokenManager, coordinator)

        val request = Request.Builder()
            .url("https://api.example.com/test")
            .header("Authorization", "Bearer stale-token")
            .build()
        val response = Response.Builder()
            .request(request)
            .protocol(Protocol.HTTP_2)
            .code(401)
            .message("Unauthorized")
            .build()

        val retried = authenticator.authenticate(null, response)

        assertNotNull("Should retry with fallback token", retried)
        assertEquals("Bearer new-token-from-elsewhere", retried!!.header("Authorization"))
        verify(exactly = 0) { tokenManager.clear() }
    }

    /**
     * TokenAuthenticator 回归：服务端确认 refresh token 失效时清理并退登。
     */
    @Test
    fun `authenticator triggers logout when no usable fallback token`() {
        val coordinator = mockk<TokenRefreshCoordinator>()
        every { coordinator.refreshBlockingResult() } returns TokenRefreshResult.Invalid

        every { tokenManager.accessToken } returns "stale-token"

        val authenticator = TokenAuthenticator(tokenManager, coordinator)

        val request = Request.Builder()
            .url("https://api.example.com/test")
            .header("Authorization", "Bearer stale-token")
            .build()
        val response = Response.Builder()
            .request(request)
            .protocol(Protocol.HTTP_2)
            .code(401)
            .message("Unauthorized")
            .build()

        val retried = authenticator.authenticate(null, response)

        assertNull("Should give up (return null)", retried)
        verify(exactly = 1) { tokenManager.clear() }
    }

    @Test
    fun `authenticator preserves session on transient refresh failure`() {
        val coordinator = mockk<TokenRefreshCoordinator>()
        every { coordinator.refreshBlockingResult() } returns TokenRefreshResult.TemporarilyUnavailable
        every { tokenManager.accessToken } returns "stale-token"

        val request = Request.Builder()
            .url("https://api.example.com/test")
            .header("Authorization", "Bearer stale-token")
            .build()
        val response = Response.Builder()
            .request(request)
            .protocol(Protocol.HTTP_2)
            .code(401)
            .message("Unauthorized")
            .build()

        assertNull(TokenAuthenticator(tokenManager, coordinator).authenticate(null, response))
        verify(exactly = 0) { tokenManager.clear() }
    }

    @Test
    fun `authenticator logs out when replay remains unauthorized`() {
        val coordinator = mockk<TokenRefreshCoordinator>(relaxed = true)
        every { tokenManager.accessToken } returns "fresh-token"
        val originalRequest = Request.Builder()
            .url("https://api.example.com/test")
            .header("Authorization", "Bearer stale-token")
            .build()
        val originalResponse = Response.Builder()
            .request(originalRequest)
            .protocol(Protocol.HTTP_2)
            .code(401)
            .message("Unauthorized")
            .build()
        val replayRequest = originalRequest.newBuilder()
            .header("Authorization", "Bearer fresh-token")
            .build()
        val replayResponse = Response.Builder()
            .request(replayRequest)
            .protocol(Protocol.HTTP_2)
            .code(401)
            .message("Unauthorized")
            .priorResponse(originalResponse)
            .build()

        assertNull(TokenAuthenticator(tokenManager, coordinator).authenticate(null, replayResponse))
        verify(exactly = 1) { tokenManager.clear() }
        verify(exactly = 0) { coordinator.refreshBlockingResult() }
    }

    @Test
    fun `redirect history does not masquerade as unauthorized replay`() {
        val coordinator = mockk<TokenRefreshCoordinator>()
        every { coordinator.refreshBlockingResult() } returns TokenRefreshResult.Success("fresh-token")
        every { tokenManager.accessToken } returns "stale-token"
        val request = Request.Builder()
            .url("https://api.example.com/test")
            .header("Authorization", "Bearer stale-token")
            .build()
        val redirectResponse = Response.Builder()
            .request(request)
            .protocol(Protocol.HTTP_2)
            .code(302)
            .message("Found")
            .build()
        val unauthorizedResponse = Response.Builder()
            .request(request)
            .protocol(Protocol.HTTP_2)
            .code(401)
            .message("Unauthorized")
            .priorResponse(redirectResponse)
            .build()

        val replay = TokenAuthenticator(tokenManager, coordinator).authenticate(null, unauthorizedResponse)

        assertEquals("Bearer fresh-token", replay?.header("Authorization"))
        verify(exactly = 0) { tokenManager.clear() }
    }

    @Test
    fun `refresh failure status classification distinguishes invalid conflict and transient`() {
        val coordinator = TokenRefreshCoordinator(tokenManager, authApiLazy)
        assertEquals(TokenRefreshResult.Invalid, coordinator.classifyFailure(401))
        assertEquals(TokenRefreshResult.Invalid, coordinator.classifyFailure(403))
        assertEquals(
            TokenRefreshResult.Invalid,
            coordinator.classifyFailure(404, "NOT_FOUND"),
        )
        assertEquals(
            TokenRefreshResult.TemporarilyUnavailable,
            coordinator.classifyFailure(404),
        )
        assertEquals(TokenRefreshResult.Conflict, coordinator.classifyFailure(409))
        assertEquals(TokenRefreshResult.TemporarilyUnavailable, coordinator.classifyFailure(500))
        assertEquals(
            TokenRefreshResult.TemporarilyUnavailable,
            coordinator.classifyFailure(401, "RATE_LIMITED"),
        )
    }

    @Test
    fun `logout event is emitted once until a new session becomes active`() {
        AuthEventBus.markSessionActive()

        assertTrue(AuthEventBus.emitLogoutRequired())
        assertFalse(AuthEventBus.emitLogoutRequired())

        AuthEventBus.markSessionActive()
        assertTrue(AuthEventBus.emitLogoutRequired())
        AuthEventBus.markSessionActive()
    }

    @Test
    fun `rate limited error code is read from non successful response body`() {
        val raw = """{"success":false,"message":"too many requests","code":"RATE_LIMITED"}"""
        assertEquals("RATE_LIMITED", refreshErrorCode(raw))
        assertNull(refreshErrorCode("not-json"))
    }

    @Test
    fun `refresh endpoint bypasses recursive authentication`() {
        assertTrue(isTokenRefreshPath("/api/auth/refresh-token"))
        assertTrue(isTokenRefreshPath("/api/auth/refresh"))
        assertFalse(isTokenRefreshPath("/api/auth/login"))

        val coordinator = mockk<TokenRefreshCoordinator>(relaxed = true)
        val request = Request.Builder()
            .url("https://api.example.com/api/auth/refresh-token")
            .header("Authorization", "Bearer stale-token")
            .build()
        val response = Response.Builder()
            .request(request)
            .protocol(Protocol.HTTP_2)
            .code(401)
            .message("Unauthorized")
            .build()

        assertNull(TokenAuthenticator(tokenManager, coordinator).authenticate(null, response))
        verify(exactly = 0) { coordinator.refreshBlockingResult() }
        verify(exactly = 0) { tokenManager.clear() }
    }

    @Test
    fun `session independent auth endpoints bypass refresh and logout`() {
        assertTrue(isSessionIndependentAuthPath("/api/auth/login"))
        assertTrue(isSessionIndependentAuthPath("/api/auth/login/verification-code"))
        assertTrue(isSessionIndependentAuthPath("/api/auth/send-verification-code"))
        assertFalse(isSessionIndependentAuthPath("/api/auth/profile"))

        val coordinator = mockk<TokenRefreshCoordinator>(relaxed = true)
        val request = Request.Builder()
            .url("https://api.example.com/api/auth/login")
            .build()
        val response = Response.Builder()
            .request(request)
            .protocol(Protocol.HTTP_2)
            .code(401)
            .message("Unauthorized")
            .build()

        assertNull(TokenAuthenticator(tokenManager, coordinator).authenticate(null, response))
        verify(exactly = 0) { coordinator.refreshBlockingResult() }
        verify(exactly = 0) { tokenManager.clear() }
    }

    @Test
    fun `fresh unauthenticated user does not emit session expiry on protected 401`() {
        every { tokenManager.accessToken } returns null
        every { tokenManager.refreshToken } returns null
        val coordinator = mockk<TokenRefreshCoordinator>(relaxed = true)
        val request = Request.Builder()
            .url("https://api.example.com/api/chat/pending-interactions")
            .build()
        val response = Response.Builder()
            .request(request)
            .protocol(Protocol.HTTP_2)
            .code(401)
            .message("Unauthorized")
            .build()

        assertNull(TokenAuthenticator(tokenManager, coordinator).authenticate(null, response))
        verify(exactly = 0) { coordinator.refreshBlockingResult() }
        verify(exactly = 0) { tokenManager.clear() }
    }

    @Test
    fun `api error message extracts backend login reason`() {
        assertEquals(
            "用户名或密码错误",
            apiErrorMessage("""{"success":false,"message":"用户名或密码错误","code":"AUTH_INVALID"}"""),
        )
        assertEquals("请求参数无效", apiErrorMessage("""{"detail":"请求参数无效"}"""))
        assertNull(apiErrorMessage("not-json"))
    }
}
