package com.tabtin.mobile.data.api

import android.content.Context
import android.util.Log
import com.chuckerteam.chucker.api.ChuckerInterceptor
import com.jakewharton.retrofit2.converter.kotlinx.serialization.asConverterFactory
import com.tabtin.mobile.BuildConfig
import com.tabtin.mobile.data.model.RefreshTokenRequest
import com.tabtin.mobile.diagnostics.DiagnosticHttpInterceptor
import com.tabtin.mobile.diagnostics.DiagnosticRecorder
import com.tabtin.mobile.util.TokenManager
import dagger.Lazy
import dagger.Module
import dagger.Provides
import dagger.hilt.android.qualifiers.ApplicationContext
import dagger.hilt.InstallIn
import dagger.hilt.components.SingletonComponent
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.Authenticator
import okhttp3.Interceptor
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.Route
import okhttp3.logging.HttpLoggingInterceptor
import retrofit2.Retrofit
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import javax.inject.Singleton

internal val json: Json = Json {
    ignoreUnknownKeys = true
    coerceInputValues = true
    isLenient = true
}

/**
 * 全局认证失败事件流。
 * 当 refresh token 也失效时发射事件，UI 层订阅后跳转到登录页。
 */
internal object AuthEventBus {
    private val _logoutRequired = MutableSharedFlow<Unit>(extraBufferCapacity = 1)
    public val logoutRequired: SharedFlow<Unit> = _logoutRequired.asSharedFlow()
    private val logoutPending = AtomicBoolean(false)

    public fun emitLogoutRequired(): Boolean {
        if (!logoutPending.compareAndSet(false, true)) return false
        if (_logoutRequired.tryEmit(Unit)) return true
        logoutPending.set(false)
        return false
    }

    public fun markSessionActive() {
        logoutPending.set(false)
    }
}

public sealed interface TokenRefreshResult {
    public data class Success(public val accessToken: String) : TokenRefreshResult
    public data object Invalid : TokenRefreshResult
    public data object Conflict : TokenRefreshResult
    public data object TemporarilyUnavailable : TokenRefreshResult
}

internal fun isTokenRefreshPath(path: String): Boolean =
    path.endsWith("/auth/refresh-token") || path.endsWith("/auth/refresh")

/**
 * 不依赖既有登录态的认证入口。
 *
 * 这些请求返回 401 时表达的是“本次登录凭据不正确”，不是“已有会话已过期”。
 * 因此不能注入旧 access token、不能触发 refresh，也不能发射全局退登事件。
 */
internal fun isSessionIndependentAuthPath(path: String): Boolean =
    SESSION_INDEPENDENT_AUTH_PATHS.any(path::endsWith)

private val SESSION_INDEPENDENT_AUTH_PATHS: Set<String> = setOf(
    "/auth/login",
    "/auth/login/verification-code",
    "/auth/send-verification-code",
    "/auth/register",
    "/auth/forgot-password",
    "/auth/reset-password",
)

internal fun retrofitBaseUrl(raw: String): String = raw.trimEnd('/') + "/"

/** 从后端标准错误信封提取可安全展示给用户的提示。 */
internal fun apiErrorMessage(rawErrorBody: String?): String? = try {
    rawErrorBody
        ?.let(json::parseToJsonElement)
        ?.jsonObject
        ?.let { payload ->
            payload["message"]?.jsonPrimitive?.contentOrNull
                ?: payload["detail"]?.jsonPrimitive?.contentOrNull
        }
        ?.takeIf { it.isNotBlank() }
} catch (_: Exception) {
    null
}

internal fun apiErrorCode(rawErrorBody: String?): String? = try {
    rawErrorBody
        ?.let(json::parseToJsonElement)
        ?.jsonObject
        ?.get("code")
        ?.jsonPrimitive
        ?.contentOrNull
} catch (_: Exception) {
    null
}

@Deprecated("Use apiErrorCode() for standard API error envelopes")
internal fun refreshErrorCode(rawErrorBody: String?): String? = apiErrorCode(rawErrorBody)

/**
 * 集中管理 Token 刷新逻辑。
 *
 * 被 TokenAuthenticator（401 触发）和 proactiveRefreshInterceptor（过期前主动触发）共用，
 * 保证同一时刻最多只执行一次刷新。其余调用方等待刷新完成后取新 token。
 */
public class TokenRefreshCoordinator internal constructor(
    private val tokenManager: TokenManager,
    private val authApiLazy: Lazy<AuthApi>,
    private val waitTimeoutMs: Long = DEFAULT_WAIT_TIMEOUT_MS,
) {
    public companion object {
        private const val TAG = "TokenRefreshCoordinator"
        internal const val DEFAULT_WAIT_TIMEOUT_MS = 10_000L
    }

    @Volatile
    private var refreshInFlight = false

    @Volatile
    private var lastRefreshResult: TokenRefreshResult = TokenRefreshResult.TemporarilyUnavailable

    /**
     * 执行刷新。并发安全：同一时刻只有一个线程真正调用后端，其余等待。
     * @return 刷新后的 accessToken，失败或超时返回 null
     */
    public fun refreshBlocking(): String? {
        val result = refreshBlockingResult()
        if (result is TokenRefreshResult.Success) return result.accessToken

        // Legacy callers only consume a nullable token. They may reuse a token
        // written by another process, but semantic callers must keep the real
        // refresh failure instead of converting a transient failure to Success.
        return tokenManager.accessToken
            ?.takeIf { it.isNotBlank() && !tokenManager.isAccessTokenExpiringSoon }
    }

    /** Same single-flight operation with failure semantics preserved. */
    public fun refreshBlockingResult(): TokenRefreshResult {
        synchronized(this) {
            if (refreshInFlight) {
                val deadlineNanos = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(waitTimeoutMs)
                while (refreshInFlight) {
                    val remainingMs = TimeUnit.NANOSECONDS.toMillis(deadlineNanos - System.nanoTime())
                    if (remainingMs <= 0) break
                    @Suppress("PLATFORM_CLASS_MAPPED_TO_KOTLIN")
                    (this as java.lang.Object).wait(remainingMs)
                }

                if (!refreshInFlight && lastRefreshResult is TokenRefreshResult.Success) {
                    return lastRefreshResult
                }

                Log.w(TAG, "Waited for refresh but ${if (refreshInFlight) "timed out" else "refresh failed"}")
                return lastRefreshResult
            }
            refreshInFlight = true
            lastRefreshResult = TokenRefreshResult.TemporarilyUnavailable
        }

        val result = try {
            val rt = tokenManager.refreshToken
            if (rt.isNullOrBlank()) {
                Log.w(TAG, "No refresh token, cannot refresh")
                TokenRefreshResult.Invalid
            } else {
                val resp = authApiLazy.get().refreshTokenSync(RefreshTokenRequest(rt)).execute()
                val envelope = resp.body()
                val body = envelope?.data
                if (resp.isSuccessful && envelope != null && envelope.success && body != null &&
                    !body.refreshToken.isNullOrBlank()
                ) {
                    tokenManager.saveTokenPair(body.accessToken, body.refreshToken, body.expiresIn)
                    Log.i(TAG, "Token refreshed successfully")
                    TokenRefreshResult.Success(body.accessToken)
                } else {
                    Log.w(TAG, "Refresh failed: ${resp.code()}")
                    val errorCode = envelope?.code ?: apiErrorCode(resp.errorBody()?.string())
                    classifyFailure(resp.code(), errorCode)
                }
            }
        } catch (e: Exception) {
            Log.e(TAG, "Refresh exception: ${e.message}")
            TokenRefreshResult.TemporarilyUnavailable
        }
        synchronized(this) {
            lastRefreshResult = result
            refreshInFlight = false
            @Suppress("PLATFORM_CLASS_MAPPED_TO_KOTLIN")
            (this as java.lang.Object).notifyAll()
        }
        return result
    }

    internal fun classifyFailure(statusCode: Int, errorCode: String? = null): TokenRefreshResult = when {
        errorCode == "RATE_LIMITED" -> TokenRefreshResult.TemporarilyUnavailable
        statusCode in setOf(401, 403) -> TokenRefreshResult.Invalid
        statusCode == 404 && errorCode == "NOT_FOUND" -> TokenRefreshResult.Invalid
        statusCode == 409 -> TokenRefreshResult.Conflict
        else -> TokenRefreshResult.TemporarilyUnavailable
    }
}

/**
 * 处理 401 的 OkHttp Authenticator。
 * 委托 TokenRefreshCoordinator 执行刷新，保证与 proactiveRefreshInterceptor 互斥。
 */
internal class TokenAuthenticator(
    private val tokenManager: TokenManager,
    private val refreshCoordinator: TokenRefreshCoordinator,
) : Authenticator {

    public companion object {
        private const val TAG = "TokenAuth"
    }

    override fun authenticate(route: Route?, response: Response): Request? {
        val path = response.request.url.encodedPath
        if (isTokenRefreshPath(path) || isSessionIndependentAuthPath(path)) {
            return null
        }

        val staleToken = response.request.header("Authorization")?.removePrefix("Bearer ")
        val currentToken = tokenManager.accessToken
        if (staleToken.isNullOrBlank() && currentToken.isNullOrBlank() && tokenManager.refreshToken.isNullOrBlank()) {
            Log.d(TAG, "Unauthenticated request returned 401; no session to refresh or expire")
            return null
        }

        if (hasPriorUnauthorized(response)) {
            Log.w(TAG, "Request remained unauthorized after token replay")
            tokenManager.clear()
            AuthEventBus.emitLogoutRequired()
            return null
        }

        if (currentToken != null && currentToken != staleToken) {
            return response.request.newBuilder()
                .header("Authorization", "Bearer $currentToken")
                .build()
        }

        when (val result = refreshCoordinator.refreshBlockingResult()) {
            is TokenRefreshResult.Success -> {
                return response.request.newBuilder()
                    .header("Authorization", "Bearer ${result.accessToken}")
                    .build()
            }
            TokenRefreshResult.Invalid -> {
                tokenManager.clear()
                AuthEventBus.emitLogoutRequired()
                return null
            }
            TokenRefreshResult.Conflict,
            TokenRefreshResult.TemporarilyUnavailable -> Unit
        }

        val fallbackToken = tokenManager.accessToken
        if (!fallbackToken.isNullOrBlank() && fallbackToken != staleToken) {
            Log.d(TAG, "refreshBlocking returned null but found a different token in store, retrying")
            return response.request.newBuilder()
                .header("Authorization", "Bearer $fallbackToken")
                .build()
        }

        // A conflict or network/server failure is not proof that credentials
        // were revoked. Preserve the session and surface the original 401.
        return null
    }

    private fun hasPriorUnauthorized(response: Response): Boolean {
        var r: Response? = response.priorResponse
        while (r != null) {
            if (r.code == 401) return true
            r = r.priorResponse
        }
        return false
    }
}

@Module
@InstallIn(SingletonComponent::class)
internal object ApiModule {

    @Provides
    @Singleton
    public fun provideOkHttpClient(
        @ApplicationContext context: Context,
        tokenManager: TokenManager,
        refreshCoordinator: TokenRefreshCoordinator,
        diagnosticRecorder: DiagnosticRecorder,
    ): OkHttpClient {

        val authInterceptor = Interceptor { chain ->
            val originalRequest = chain.request()
            val requestBuilder = originalRequest.newBuilder().apply {
                addHeader("Content-Type", "application/json")
                header("X-Client-Type", "android")
                header("X-Client-Version", BuildConfig.VERSION_NAME)
                if (BuildConfig.TABTIN_GIT_SHA.isNotEmpty()) {
                    header("X-Client-Source-Sha", BuildConfig.TABTIN_GIT_SHA)
                }
            }

            if (!isSessionIndependentAuthPath(originalRequest.url.encodedPath)) {
                val token = tokenManager.accessToken
                if (!token.isNullOrBlank()) {
                    requestBuilder.header("Authorization", "Bearer $token")
                }
            }

            chain.proceed(requestBuilder.build())
        }

        val proactiveRefreshInterceptor = Interceptor { chain ->
            val path = chain.request().url.encodedPath
            val isRefreshRequest = isTokenRefreshPath(path)
            val isSessionIndependentRequest = isSessionIndependentAuthPath(path)
            if (!isRefreshRequest && !isSessionIndependentRequest &&
                tokenManager.isAccessTokenExpiringSoon && !tokenManager.refreshToken.isNullOrBlank()
            ) {
                if (refreshCoordinator.refreshBlockingResult() == TokenRefreshResult.Invalid) {
                    tokenManager.clear()
                    AuthEventBus.emitLogoutRequired()
                }
            }
            chain.proceed(chain.request())
        }

        val logging = HttpLoggingInterceptor().apply {
            level = if (BuildConfig.DEBUG)
                // 登录、换取验证码等请求体包含口令；Debug logcat 也不能记录明文。
                HttpLoggingInterceptor.Level.BASIC
            else
                HttpLoggingInterceptor.Level.NONE
            redactHeader("Authorization")
            redactHeader("Cookie")
            redactHeader("Set-Cookie")
        }

        return OkHttpClient.Builder()
            .addInterceptor(DiagnosticHttpInterceptor(diagnosticRecorder))
            .addInterceptor(authInterceptor)
            .addInterceptor(proactiveRefreshInterceptor)
            .addInterceptor(
                ChuckerInterceptor.Builder(context)
                    .redactHeaders("Authorization", "Cookie", "Set-Cookie")
                    .alwaysReadResponseBody(true)
                    .createShortcut(true)
                    .build(),
            )
            .addInterceptor(logging)
            .authenticator(TokenAuthenticator(tokenManager, refreshCoordinator))
            .connectTimeout(30, TimeUnit.SECONDS)
            .readTimeout(30, TimeUnit.SECONDS)
            .writeTimeout(30, TimeUnit.SECONDS)
            .build()
    }

    @Provides
    @Singleton
    public fun provideTokenRefreshCoordinator(
        tokenManager: TokenManager,
        authApiLazy: Lazy<AuthApi>,
    ): TokenRefreshCoordinator = TokenRefreshCoordinator(tokenManager, authApiLazy)

    @Provides
    @Singleton
    public fun provideRetrofit(client: OkHttpClient, tokenManager: TokenManager): Retrofit {
        return Retrofit.Builder()
            .baseUrl(retrofitBaseUrl(resolveEffectiveApiBaseUrl(tokenManager)))
            .client(client)
            .addConverterFactory(json.asConverterFactory("application/json".toMediaType()))
            .build()
    }

    @Provides
    @Singleton
    public fun provideAuthApi(retrofit: Retrofit): AuthApi = retrofit.create(AuthApi::class.java)

    @Provides
    @Singleton
    public fun provideVersionApi(retrofit: Retrofit): VersionApi = retrofit.create(VersionApi::class.java)

    @Provides
    @Singleton
    public fun providePlanApi(retrofit: Retrofit): PlanApi = retrofit.create(PlanApi::class.java)

    @Provides
    @Singleton
    public fun provideContextApi(retrofit: Retrofit): ContextApi = retrofit.create(ContextApi::class.java)

    @Provides
    @Singleton
    public fun provideChatApi(retrofit: Retrofit): ChatApi = retrofit.create(ChatApi::class.java)

    @Provides
    @Singleton
    public fun provideDocApi(retrofit: Retrofit): DocApi = retrofit.create(DocApi::class.java)

    @Provides
    @Singleton
    public fun provideTabDataApi(retrofit: Retrofit): TabDataApi = retrofit.create(TabDataApi::class.java)

    @Provides
    @Singleton
    public fun provideTabMemoApi(retrofit: Retrofit): TabMemoApi = retrofit.create(TabMemoApi::class.java)

    @Provides
    @Singleton
    public fun provideWorkspaceMemoryApi(retrofit: Retrofit): WorkspaceMemoryApi =
        retrofit.create(WorkspaceMemoryApi::class.java)

    @Provides
    @Singleton
    public fun provideTabFilesApi(retrofit: Retrofit): TabFilesApi = retrofit.create(TabFilesApi::class.java)

    @Provides
    @Singleton
    public fun provideTabSlideApi(retrofit: Retrofit): TabSlideApi = retrofit.create(TabSlideApi::class.java)

    @Provides
    @Singleton
    public fun provideSkillsApi(retrofit: Retrofit): SkillsApi = retrofit.create(SkillsApi::class.java)

    @Provides
    @Singleton
    public fun provideOrchestrationApi(retrofit: Retrofit): OrchestrationApi = retrofit.create(OrchestrationApi::class.java)

    @Provides
    @Singleton
    public fun provideTrackerApi(retrofit: Retrofit): TrackerApi = retrofit.create(TrackerApi::class.java)

    @Provides
    @Singleton
    public fun provideLlmApi(retrofit: Retrofit): LlmApi = retrofit.create(LlmApi::class.java)

    @Provides
    @Singleton
    public fun provideWalletApi(retrofit: Retrofit): WalletApi = retrofit.create(WalletApi::class.java)

    @Provides
    @Singleton
    public fun provideBillingApi(retrofit: Retrofit): BillingApi = retrofit.create(BillingApi::class.java)

    @Provides
    @Singleton
    public fun provideChatCheckpointApi(retrofit: Retrofit): ChatCheckpointApi = retrofit.create(ChatCheckpointApi::class.java)

    @Provides
    @Singleton
    public fun provideUserPortraitApi(retrofit: Retrofit): UserPortraitApi = retrofit.create(UserPortraitApi::class.java)

    @Provides
    @Singleton
    public fun provideNotificationApi(retrofit: Retrofit): NotificationApi = retrofit.create(NotificationApi::class.java)

    @Provides
    @Singleton
    public fun provideImApi(retrofit: Retrofit): com.tabtin.mobile.data.im.ImApi =
        retrofit.create(com.tabtin.mobile.data.im.ImApi::class.java)

    @Provides
    @Singleton
    public fun provideImConversationDataPlane(
        adapter: com.tabtin.mobile.data.im.DjangoImAdapter,
    ): com.tabtin.mobile.data.im.ImConversationDataPlane = adapter

    @Provides
    @Singleton
    public fun provideImMessageTransport(
        adapter: com.tabtin.mobile.data.im.DjangoImAdapter,
    ): com.tabtin.mobile.data.im.ImMessageTransport = adapter

    @Provides
    @Singleton
    public fun provideImPersonalRealtimeSource(
        client: com.tabtin.mobile.data.im.CentrifugoClient,
    ): com.tabtin.mobile.data.im.ImPersonalRealtimeSource = client
}
