package com.tabtin.mobile.data.websocket

import android.os.SystemClock
import android.util.Log
import com.tabtin.mobile.data.api.resolveEffectiveWsBaseUrl
import com.tabtin.mobile.data.adb.AdbConnectionManager
import com.tabtin.mobile.data.automation.ActionRouter
import com.tabtin.mobile.data.model.WSEnvelope
import com.tabtin.mobile.diagnostics.DiagnosticHttpInterceptor
import com.tabtin.mobile.diagnostics.DiagnosticRecorder
import com.tabtin.mobile.data.privileged.PrivilegedProcessManager
import com.tabtin.mobile.data.privileged.ServiceHealthMonitor
import com.tabtin.mobile.features.conversation.ConversationReconnectPolicy
import com.tabtin.mobile.util.DeviceRuntimeDescriptor
import com.tabtin.mobile.util.TokenManager
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.drop
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.TimeUnit
import javax.inject.Inject
import javax.inject.Singleton
import kotlin.math.min
import kotlin.math.pow

public sealed class WSConnectionState {
    public data object Disconnected : WSConnectionState()
    public data object Connecting : WSConnectionState()
    public data object Authenticating : WSConnectionState()
    public data object Connected : WSConnectionState()
    public data class Reconnecting(val attempt: Int) : WSConnectionState()
    public data object AuthFailed : WSConnectionState()
    public data object ReconnectGaveUp : WSConnectionState()
}

/**
 * `sendAndWaitAck` 的统一返回类型。覆盖 5 类业务场景，对外只暴露 4 个 case：
 *   1. okType envelope                              → `Ok`
 *   2. nakType envelope                             → `Nak`
 *   3. type == "error" 且 request_id 命中            → `Nak`（归一）
 *   4. timeout 内无任何匹配回包                       → `Timeout`
 *   5. 等待中 WS 断连 / 发包前未连接 / send 调用失败 → `Disconnected`
 */
public sealed class AckResult {
    public data class Ok(val payload: JsonObject) : AckResult()
    public data class Nak(
        val errorCode: String,
        val errorMessage: String,
        val errorCategory: String?,
        val errorClass: String? = null,
        val suggestedAction: String? = null,
        val retryable: Boolean,
        val delivery: String? = null,
        val executionState: String? = null,
        val messageId: String? = null,
        val clientEventId: String? = null,
    ) : AckResult()
    public data object Timeout : AckResult()
    public data object Disconnected : AckResult()
}

public data class ResumeResult(val syncCount: Int, val timestampMs: Long)

public sealed class AutoRecoverState {
    public data object Idle : AutoRecoverState()
    public data class Recovering(val attempt: Int, val maxAttempts: Int) : AutoRecoverState()
    public data object Succeeded : AutoRecoverState()
    public data class Failed(val reason: String?) : AutoRecoverState()
}

@Singleton
public class WebSocketService @Inject constructor(
    private val tokenManager: TokenManager,
    private val deviceRuntimeDescriptor: DeviceRuntimeDescriptor,
    private val actionRouter: ActionRouter,
    private val privilegedProcessManager: dagger.Lazy<PrivilegedProcessManager>,
    private val adbConnectionManager: dagger.Lazy<AdbConnectionManager>,
    private val serviceHealthMonitor: dagger.Lazy<ServiceHealthMonitor>,
    private val userEventHandler: dagger.Lazy<UserEventHandler>,
    private val diagnosticRecorder: DiagnosticRecorder,
) {
    public companion object {
        private const val TAG = "WebSocketService"
        private const val MAX_RECONNECT_DELAY_MS = 15_000L
        private const val BASE_RECONNECT_DELAY_MS = 1_000L
        private const val RECONNECT_FACTOR = 1.5
        private const val AUTH_TIMEOUT_MS = 14_000L

        /** GUI 登录态的 WS auth 角色。网关 role-token 绑定（auth.py CD-001/G-009）：
         * 用户 access token 只能以 GUI 角色（mobile/electron/web/admin）认证；
         * device_runtime 角色只收 daemon token——拿 access token 配 device_runtime
         * 会在 auth 即被拒 `invalid token type`（MB-3，见 mobile-issues-overview）。 */
        private const val WS_ROLE_MOBILE = "mobile"
        private const val WS_ROLE_DEVICE_RUNTIME = "device_runtime"

        /** GUI 登录态 auth 声明的 capability：必须 ⊆ 服务端 ROLE_CAPABILITY_WHITELIST['mobile']
         * 且只声明实际订阅用到的（agent.stream=聊天流/session 事件，billing.events=计费事件，
         * tracker.events=Tracker 运行进度，table.events=TabData 记录增删改）。
         * ⚠️ 不要加 agent.action——mobile 角色声明它会被 auth 硬拒（WS_1005）。
         * 设备硬件能力走 REST 注册/心跳上报，与 WS auth 无关。 */
        private val GUI_AUTH_CAPABILITIES = listOf(
            "agent.stream",
            "billing.events",
            "tracker.events",
            "table.events",
        )
        private const val HEALTH_CHECK_INTERVAL_MS = 10_000L
        private const val OUTBOUND_PING_INTERVAL_MS = 50_000L
        private const val TOKEN_REVALIDATE_INTERVAL_MS = 60_000L
        private const val MAX_SUBSCRIPTIONS = 50
        private const val MAX_RECONNECT_ATTEMPTS = 20
        private const val RECENT_EVENT_ID_LIMIT = 500
        private const val DEFAULT_DEFERRED_UNSUBSCRIBE_MS: Long = 90_000L
    }

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)

    private val _connectionState = MutableStateFlow<WSConnectionState>(WSConnectionState.Disconnected)
    public val connectionState: StateFlow<WSConnectionState> = _connectionState.asStateFlow()

    private val _lastResumeResult = MutableStateFlow<ResumeResult?>(null)
    public val lastResumeResult: StateFlow<ResumeResult?> = _lastResumeResult.asStateFlow()

    private val capabilityReporter = CapabilityReporter(
        deviceRuntimeDescriptor = deviceRuntimeDescriptor,
        scope = scope,
        deviceId = { deviceId },
        organizationId = { tokenManager.organizationId },
        isConnected = { _connectionState.value == WSConnectionState.Connected },
        sendEnvelope = ::sendEnvelope,
    )

    init {
        // capability 上报只在 daemon 模式有意义（mobile role 发 report 会被 role 闸门拒）
        actionRouter.onCapabilitiesStale = {
            if (tokenManager.isDaemonMode) capabilityReporter.reportChanged()
        }
    }

    private val l2Recovery = L2AutoRecoveryManager(
        adbConnectionManager = adbConnectionManager,
        privilegedProcessManager = privilegedProcessManager,
        scope = scope,
        onCapabilitiesChanged = {
            if (tokenManager.isDaemonMode) capabilityReporter.reportChanged()
        },
    )
    public val autoRecoverState: StateFlow<AutoRecoverState> = l2Recovery.autoRecoverState

    private val actionDispatcher = DeviceActionDispatcher(
        actionRouter = actionRouter,
        scope = scope,
        deviceId = { deviceId },
        organizationId = { tokenManager.organizationId },
        sendEnvelope = ::sendEnvelope,
    )

    @Volatile private var webSocket: WebSocket? = null
    @Volatile private var isAuthenticated = false
    @Volatile
    private var isManuallyDisconnected = false
    private val desiredTopics: MutableSet<String> = ConcurrentHashMap.newKeySet()
    private val desiredTopicContexts: MutableMap<String, JsonObject> = ConcurrentHashMap()
    private val subscribedTopics: MutableSet<String> = ConcurrentHashMap.newKeySet()
    private val deferredUnsubscribeJobs = ConcurrentHashMap<String, Job>()
    @Volatile private var lastEventId: String? = null
    private val lastEventIdPerTopic = ConcurrentHashMap<String, String>()
    private val recentEventIds = LinkedHashSet<String>()
    private val reconnectAttempt = AtomicInteger(0)

    @Volatile private var lastOutboundAtMs = 0L
    private var heartbeatJob: Job? = null
    private var reconnectJob: Job? = null
    private var authTimeoutJob: Job? = null
    private var healthMonitorObserveJob: Job? = null
    private var tokenRevalidationJob: Job? = null
    private var resumePaginationCount = 0
    private val maxResumePaginationRounds = 10

    private val deviceId: String get() = tokenManager.deviceId

    private val wsClient: OkHttpClient by lazy {
        OkHttpClient.Builder()
            .addInterceptor(DiagnosticHttpInterceptor(diagnosticRecorder))
            .connectTimeout(30, TimeUnit.SECONDS)
            .readTimeout(0, TimeUnit.MINUTES)
            .writeTimeout(30, TimeUnit.SECONDS)
            .build()
    }

    private val envelopeHandlers = ConcurrentHashMap<String, (WSEnvelope) -> Unit>()
    private val subscriptionAttempts = SubscriptionAttemptRegistry()
    private val deviceActionTopic: String get() = "agent.action.device.$deviceId"

    /**
     * 等待 ACK 的请求登记表（key=request_id）。single-fire 语义：由 ok/nak/error/
     * timeout/disconnect 中先到的一方 `remove` 抢占归属，再 complete。
     */
    private data class PendingAck(
        val okType: String,
        val nakType: String,
        val deferred: CompletableDeferred<AckResult>,
        val timeoutJob: Job,
    )
    private val pendingAcks = ConcurrentHashMap<String, PendingAck>()

    // MARK: - Public API

    public fun connect() {
        if (_connectionState.value != WSConnectionState.Disconnected) return
        isManuallyDisconnected = false
        reconnectAttempt.set(0)
        performConnect()
    }

    /** 前台恢复/网络恢复时调用：断开时重连，重连中时重置计数器加速恢复 */
    public fun reconnectIfNeeded() {
        if (tokenManager.accessToken.isNullOrBlank()) return

        when (val state = _connectionState.value) {
            WSConnectionState.Disconnected,
            WSConnectionState.ReconnectGaveUp -> {
                Log.i(TAG, "Reconnecting (triggered by lifecycle/network)")
                reconnectAttempt.set(0)
                performConnect()
            }
            is WSConnectionState.Reconnecting -> {
                Log.i(TAG, "Already reconnecting (attempt ${state.attempt}), resetting counter")
                reconnectAttempt.set(0)
            }
            else -> {}
        }
    }

    /**
     * 票已刷新、会话仍有效时从 [WSConnectionState.AuthFailed] 拉起新连接。
     * [ensureDeviceRuntimeReady] 会跳过 AuthFailed，避免在尚未换票时空转。
     */
    public fun reconnectAfterRecoveredAuth() {
        if (tokenManager.accessToken.isNullOrBlank()) return
        isManuallyDisconnected = false
        scope.launch {
            when (val state = _connectionState.value) {
                WSConnectionState.AuthFailed,
                WSConnectionState.Disconnected,
                WSConnectionState.ReconnectGaveUp -> {
                    Log.i(TAG, "Reconnecting after recovered auth (was $state)")
                    reconnectAttempt.set(0)
                    performConnect()
                }
                is WSConnectionState.Reconnecting -> {
                    Log.i(TAG, "Auth recovered while reconnecting (attempt ${state.attempt})")
                    reconnectAttempt.set(0)
                }
                WSConnectionState.Connecting,
                WSConnectionState.Authenticating,
                WSConnectionState.Connected -> {
                    Log.i(TAG, "Auth recovered while WS already $state")
                }
            }
        }
    }

    /**
     * 设备注册成功后调用：
     * - 未连接时负责拉起 WS
     * - 已连接时负责补订阅 device action topic，修复先连后注册的时序
     */
    public fun ensureDeviceRuntimeReady() {
        if (tokenManager.accessToken.isNullOrBlank()) return

        scope.launch {
            if (isManuallyDisconnected) {
                Log.d(TAG, "ensureDeviceRuntimeReady skipped: manually disconnected")
                return@launch
            }
            // 同 handleAuthOk 的角色白名单分流（MB-3）：GUI 登录不订 action topic
            if (tokenManager.isDaemonMode) {
                desiredTopics.add(deviceActionTopic)
            } else {
                billingTopic?.let { desiredTopics.add(it) }
            }
            when (val state = _connectionState.value) {
                WSConnectionState.Disconnected,
                WSConnectionState.ReconnectGaveUp -> {
                    Log.i(TAG, "Device runtime ready, establishing WS connection")
                    reconnectAttempt.set(0)
                    performConnect()
                }
                WSConnectionState.Connected -> {
                    Log.i(TAG, "Device runtime ready, syncing action topic subscription")
                    syncSubscriptions()
                }
                is WSConnectionState.Reconnecting -> {
                    Log.i(TAG, "Device runtime ready while reconnecting (attempt ${state.attempt})")
                    reconnectAttempt.set(0)
                }
                WSConnectionState.Connecting,
                WSConnectionState.Authenticating -> {
                    Log.i(TAG, "Device runtime ready while WS is establishing")
                }
                WSConnectionState.AuthFailed -> {
                    Log.i(TAG, "Device runtime ready while auth failed, skipping")
                }
            }
        }
    }

    public fun disconnect(manual: Boolean = true) {
        if (manual) isManuallyDisconnected = true
        cancelAllJobs()
        webSocket?.close(1000, "Client disconnect")
        webSocket = null
        isAuthenticated = false
        subscribedTopics.clear()
        subscriptionAttempts.completeAll(SubscriptionResult.Disconnected)
        failPendingAcks()
        l2Recovery.resetState()
        _connectionState.value = WSConnectionState.Disconnected
        Log.i(TAG, "Disconnected")
    }

    /**
     * 完全断开并重置会话状态（清空 lastEventId + desiredTopics）。
     * 仅用于：用户登出、Token 永久失效、切换 organization。
     */
    public fun fullDisconnect() {
        disconnect()
        lastEventId = null
        lastEventIdPerTopic.clear()
        desiredTopics.clear()
        desiredTopicContexts.clear()
        cancelDeferredUnsubscribe()
        clearRecentEventIds()
    }

    public fun subscribe(topics: List<String>, topicContexts: Map<String, JsonObject> = emptyMap()) {
        requestSubscription(topics, topicContexts)
    }

    public fun unsubscribe(topics: List<String>) {
        scope.launch {
            cancelDeferredUnsubscribe(topics)
            desiredTopics.removeAll(topics.toSet())
            topics.forEach(desiredTopicContexts::remove)
            for (topic in topics) {
                lastEventIdPerTopic.remove(topic)
            }
            lastEventId = computeMinEventId()
            val toRemove = topics.filter { it in subscribedTopics }
            if (toRemove.isNotEmpty() && isAuthenticated) {
                sendUnsubscribe(toRemove)
            }
        }
    }

    public fun unsubscribeAfterDelay(
        topics: List<String>,
        delayMs: Long = DEFAULT_DEFERRED_UNSUBSCRIBE_MS,
    ) {
        for (topic in topics.filter { it.isNotBlank() }) {
            deferredUnsubscribeJobs.remove(topic)?.cancel()
            var job: Job? = null
            job = scope.launch {
                delay(delayMs)
                if (deferredUnsubscribeJobs.remove(topic) === job) {
                    unsubscribe(listOf(topic))
                }
            }
            deferredUnsubscribeJobs[topic] = job
        }
    }

    public fun onEnvelope(key: String, handler: (WSEnvelope) -> Unit) {
        envelopeHandlers[key] = handler
    }

    public fun removeHandler(key: String) {
        envelopeHandlers.remove(key)
    }

    public suspend fun connectAndWait(timeoutMs: Long = 15_000L): Boolean {
        if (_connectionState.value == WSConnectionState.Connected) return true
        if (_connectionState.value == WSConnectionState.Disconnected) connect()
        return withTimeoutOrNull(timeoutMs) {
            _connectionState.first { it == WSConnectionState.Connected }
            true
        } ?: false
    }

    public fun sendASR(envelope: WSEnvelope) {
        if (!envelope.type.startsWith("asr.stream.")) {
            Log.w(TAG, "sendASR rejected non-ASR envelope type: ${envelope.type}")
            return
        }
        sendEnvelope(envelope)
    }

    public suspend fun subscribeAndWait(
        topics: List<String>,
        topicContexts: Map<String, JsonObject> = emptyMap(),
        timeoutMs: Long = 10_000L,
    ): SubscriptionResult {
        val normalizedTopics = topics.filter { it.isNotBlank() }.distinct()
        if (normalizedTopics.isEmpty()) return SubscriptionResult.Success
        val contextsChanged = normalizedTopics.any { topic ->
            topicContexts[topic]?.let { it != desiredTopicContexts[topic] } == true
        }
        normalizedTopics.forEach { topic -> topicContexts[topic]?.let { desiredTopicContexts[topic] = it } }
        if (contextsChanged) subscribedTopics.removeAll(normalizedTopics.toSet())
        if (isAuthenticated && normalizedTopics.all { it in subscribedTopics }) return SubscriptionResult.Success

        val attempt = subscriptionAttempts.acquire(normalizedTopics)
        if (attempt.shouldSend) requestSubscription(normalizedTopics, topicContexts)
        return withTimeoutOrNull(timeoutMs) { attempt.waiter.deferred.await() }
            ?: subscriptionAttempts.timeout(attempt.waiter)
    }

    /**
     * 发一个上行请求并等待对应的 ACK envelope（按 `request_id` 匹配）。
     *
     * 返回路径（4 种，互斥）：
     *   - `AckResult.Ok(payload)` 收到 envelope.type == okType
     *   - `AckResult.Nak(...)`    收到 envelope.type == nakType，或 type == "error" 且 request_id 命中
     *   - `AckResult.Timeout`     超时未收到任何匹配回包
     *   - `AckResult.Disconnected` 发包前未连接 / 等待中 WS 断连或重连
     *
     * 实现要点（参考 iOS [WebSocketService.swift] sendAndWaitAck）：
     * - request_id 用完整 UUID（不依赖默认 build 的短 ID），避免并发碰撞；
     * - single-fire 守卫：`pendingAcks.remove` 抢占成功的一方才负责 complete，避免
     *   timeout 与 ACK 同时触发产生重复 complete；
     * - 路由优先级：[handleMessage] 在解码完 envelope 后、走 [routeEnvelope] 之前
     *   先检查 pendingAcks，命中且 type 在 (okType / nakType / error) 中就吞掉，
     *   不再下沉到通用 envelopeHandlers，防止 chat.send_message.ok 这类回包污染 stream。
     * - 重连/断连：[scheduleReconnect] 与 [failPendingAcks] 同步把所有 pending ack
     *   以 Disconnected 结束，并 cancel 对应 timeout job。
     */
    public suspend fun sendAndWaitAck(
        type: String,
        payload: JsonObject,
        okType: String,
        nakType: String,
        threadId: String? = null,
        timeoutMs: Long = 30_000L,
    ): AckResult {
        if (!isAuthenticated || webSocket == null) {
            Log.w(TAG, "sendAndWaitAck '$type' rejected: not connected/authenticated")
            return AckResult.Disconnected
        }

        val requestId = java.util.UUID.randomUUID().toString()
        val envelope = WSEnvelope.build(
            type = type,
            deviceId = deviceId,
            payload = payload,
            organizationId = tokenManager.organizationId,
            threadId = threadId,
            requestId = requestId,
        )

        val deferred = CompletableDeferred<AckResult>()

        // 显式启动 timeout job 并登记，便于 timeout / ack / disconnect 之间靠 remove 互斥。
        val timeoutJob = scope.launch {
            delay(timeoutMs)
            val pending = pendingAcks.remove(requestId) ?: return@launch
            Log.w(TAG, "sendAndWaitAck '$type' timeout (${timeoutMs}ms)")
            pending.deferred.complete(AckResult.Timeout)
        }
        pendingAcks[requestId] = PendingAck(okType, nakType, deferred, timeoutJob)

        // sendEnvelope 失败（webSocket 已断 / send 返回 false）也走 single-fire 收尾，
        // 让用户在弱网立刻拿到 Disconnected，而不是白等到超时。
        val ws = webSocket
        val serializedEnvelope = envelope.toJson()
        val sent = if (ws != null) ws.send(serializedEnvelope) else false
        if (sent) markOutbound()
        diagnosticRecorder.recordWebSocket(
            channel = "gateway",
            phase = "send",
            messageType = envelope.type,
            payloadBytes = serializedEnvelope.toByteArray(Charsets.UTF_8).size.toLong(),
            result = if (sent) "queued" else "disconnected",
        )
        if (!sent) {
            val pending = pendingAcks.remove(requestId)
            if (pending != null) {
                pending.timeoutJob.cancel()
                Log.w(TAG, "sendAndWaitAck '$type' send failed: ws not connected")
                pending.deferred.complete(AckResult.Disconnected)
            }
        }

        return deferred.await()
    }

    /**
     * Fire-and-forget upstream notification. Used for best-effort control events
     * such as `chat.cancel`, where the stream itself will deliver final state.
     */
    public fun notify(
        type: String,
        payload: JsonObject,
        threadId: String? = null,
    ) {
        if (!isAuthenticated || webSocket == null) {
            Log.w(TAG, "notify '$type' dropped: not connected/authenticated")
            return
        }
        sendEnvelope(
            WSEnvelope.build(
                type = type,
                deviceId = deviceId,
                payload = payload,
                organizationId = tokenManager.organizationId,
                threadId = threadId,
            )
        )
    }

    /** Returns true 如果 envelope 被某个 pendingAck 吞掉，调用方应停止后续路由。 */
    private fun matchPendingAck(envelope: WSEnvelope): Boolean {
        val requestKey = envelope.ackCorrelationKeys().firstOrNull { pendingAcks.containsKey(it) }
            ?: return false
        val pending = pendingAcks[requestKey] ?: return false
        val isError = envelope.type == "error"
        val isOk = envelope.type == pending.okType
        val isNak = envelope.type == pending.nakType
        if (!isOk && !isNak && !isError) return false

        // single-fire: remove 抢占归属，timeout job 同时尝试时只有先到的一方拿到 pending。
        val claimed = pendingAcks.remove(requestKey) ?: return false
        claimed.timeoutJob.cancel()
        Log.d(
            TAG,
            "ack matched type=${envelope.type} request=${requestKey.redactedId()} status=${if (isOk) "ok" else "nak"}",
        )

        when {
            isOk -> {
                diagnosticRecorder.recordWebSocket(
                    channel = "gateway",
                    phase = "ack",
                    messageType = envelope.type,
                    result = "ok",
                )
                claimed.deferred.complete(AckResult.Ok(envelope.payload))
            }
            isNak -> {
                diagnosticRecorder.recordWebSocket(
                    channel = "gateway",
                    phase = "ack",
                    messageType = envelope.type,
                    result = "nak",
                )
                claimed.deferred.complete(AckResult.Nak(
                errorCode = envelope.payloadString("error_code") ?: envelope.payloadString("code") ?: "unknown",
                errorMessage = envelope.payloadString("error_message") ?: envelope.payloadString("message") ?: "",
                errorCategory = envelope.payloadString("error_category"),
                errorClass = envelope.payloadString("error_class"),
                suggestedAction = envelope.payloadString("suggested_action"),
                retryable = envelope.payloadBool("retryable") ?: false,
                delivery = envelope.payloadString("delivery"),
                executionState = envelope.payloadString("execution_state"),
                messageId = envelope.payloadString("message_id"),
                clientEventId = envelope.payloadString("client_event_id"),
                ))
            }
            else -> {
                diagnosticRecorder.recordWebSocket(
                    channel = "gateway",
                    phase = "ack",
                    messageType = envelope.type,
                    result = "error",
                )
                claimed.deferred.complete(AckResult.Nak(
                errorCode = envelope.payloadString("code") ?: "unknown",
                errorMessage = envelope.payloadString("message") ?: "",
                errorCategory = envelope.payloadString("error_category"),
                errorClass = envelope.payloadString("error_class"),
                suggestedAction = envelope.payloadString("suggested_action"),
                retryable = envelope.payloadBool("retryable") ?: false,
                delivery = envelope.payloadString("delivery"),
                executionState = envelope.payloadString("execution_state"),
                messageId = envelope.payloadString("message_id"),
                clientEventId = envelope.payloadString("client_event_id"),
                ))
            }
        }
        return true
    }

    private fun WSEnvelope.ackCorrelationKeys(): List<String> = buildList {
        add(requestId)
        replyTo?.let { add(it) }
        payloadString("request_id")?.let { add(it) }
        payloadString("reply_to")?.let { add(it) }
    }.filter { it.isNotBlank() }.distinct()

    private fun failPendingAcks() {
        val snapshot = pendingAcks.toMap()
        pendingAcks.clear()
        for ((_, pending) in snapshot) {
            pending.timeoutJob.cancel()
            pending.deferred.complete(AckResult.Disconnected)
        }
    }

    // MARK: - Connection

    private fun performConnect() {
        cancelAllJobs()

        val configuredWsBaseUrl = resolveEffectiveWsBaseUrl(tokenManager)
        val wsUrl = gatewayUrl(configuredWsBaseUrl)
        val attempt = reconnectAttempt.get()
        diagnosticRecorder.recordWebSocket(
            channel = "gateway",
            phase = "connect",
            attempt = attempt,
        )
        _connectionState.value = if (attempt > 0)
            WSConnectionState.Reconnecting(attempt)
        else
            WSConnectionState.Connecting

        val request = Request.Builder().url(wsUrl).build()
        isAuthenticated = false
        subscribedTopics.clear()

        webSocket = wsClient.newWebSocket(request, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                diagnosticRecorder.recordWebSocket(
                    channel = "gateway",
                    phase = "open",
                    result = "succeeded",
                )
                scope.launch {
                    Log.i(TAG, "Connected to $wsUrl")
                    sendAuth()
                    startAuthTimeout()
                }
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                scope.launch { handleMessage(text) }
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                diagnosticRecorder.recordWebSocket(
                    channel = "gateway",
                    phase = "failure",
                    closeCode = response?.code,
                    result = "failed",
                    error = t,
                )
                scope.launch {
                    if (this@WebSocketService.webSocket != null &&
                        this@WebSocketService.webSocket !== webSocket
                    ) {
                        Log.i(TAG, "Ignoring stale failure from superseded socket: ${t.message}")
                        return@launch
                    }
                    Log.e(TAG, "WebSocket failure: ${t.message}")
                    scheduleReconnect()
                }
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                diagnosticRecorder.recordWebSocket(
                    channel = "gateway",
                    phase = "close",
                    closeCode = code,
                    result = if (code == 1000) "normal" else "unexpected",
                )
                scope.launch {
                    if (this@WebSocketService.webSocket != null &&
                        this@WebSocketService.webSocket !== webSocket
                    ) {
                        Log.i(TAG, "Ignoring stale close from superseded socket: $code $reason")
                        return@launch
                    }
                    Log.i(TAG, "WebSocket closed: $code $reason")
                    if (code != 1000) scheduleReconnect()
                    else _connectionState.value = WSConnectionState.Disconnected
                }
            }
        })

        Log.i(TAG, "Connecting to $wsUrl")
    }

    private fun gatewayUrl(wsBaseUrl: String): String {
        val normalized = wsBaseUrl.trimEnd('/')
        return if (normalized.endsWith("/ws/v1/gateway")) normalized else "$normalized/v1/gateway"
    }

    // MARK: - Auth

    private fun sendAuth() {
        _connectionState.value = WSConnectionState.Authenticating

        val token = tokenManager.accessToken
        if (token.isNullOrBlank()) {
            Log.e(TAG, "No access token for WS auth")
            disconnect()
            return
        }

        val wsId = tokenManager.organizationId ?: ""
        // 按运行模式分流（MB-3）：daemon 激活模式持 daemon token → device_runtime；
        // 普通登录持用户 access token → 必须以 mobile 角色认证（capability 同步收敛）。
        val role: String
        val capabilities: List<String>
        if (tokenManager.isDaemonMode) {
            role = WS_ROLE_DEVICE_RUNTIME
            capabilities = deviceRuntimeDescriptor.authCapabilities()
        } else {
            role = WS_ROLE_MOBILE
            capabilities = GUI_AUTH_CAPABILITIES
        }
        val payload = WSEnvelope.buildPayload(
            "access_token" to token,
            "organization_id" to wsId,
            "capabilities" to capabilities,
        )
        sendEnvelope(WSEnvelope.build("auth", deviceId, payload, wsId, role = role))
    }

    private fun startAuthTimeout() {
        authTimeoutJob?.cancel()
        authTimeoutJob = scope.launch {
            delay(AUTH_TIMEOUT_MS)
            if (!isAuthenticated) {
                Log.w(TAG, "Auth timeout, reconnecting")
                scheduleReconnect()
            }
        }
    }

    // MARK: - Subscribe / Unsubscribe

    private fun requestSubscription(
        topics: List<String>,
        topicContexts: Map<String, JsonObject> = emptyMap(),
    ) {
        scope.launch {
            cancelDeferredUnsubscribe(topics)
            desiredTopics.addAll(topics)
            topics.forEach { topic -> topicContexts[topic]?.let { desiredTopicContexts[topic] = it } }
            val topicsToSend = topics.filter { topic ->
                topic !in subscribedTopics && !subscriptionAttempts.hasInFlightRequest(topic)
            }
            if (topicsToSend.isNotEmpty() && isAuthenticated) sendSubscribe(topicsToSend)
        }
    }

    private fun sendSubscribe(topics: List<String>) {
        val total = subscribedTopics.size + topics.size
        if (total > MAX_SUBSCRIPTIONS) {
            Log.w(TAG, "Subscription limit exceeded ($total/$MAX_SUBSCRIPTIONS)")
            subscriptionAttempts.completeRejectedForTopics(
                topics = topics,
                errorCode = "WS_1012_SUBSCRIPTION_LIMIT",
                serverMessage = "too many subscriptions (max $MAX_SUBSCRIPTIONS)",
            )
            return
        }
        val payload = buildJsonObject {
            put("topics", buildJsonArray { topics.forEach { add(JsonPrimitive(it)) } })
            val contexts = buildJsonObject {
                topics.forEach { topic -> desiredTopicContexts[topic]?.let { put(topic, it) } }
            }
            if (contexts.isNotEmpty()) put("topic_contexts", contexts)
        }
        val envelope = WSEnvelope.build("subscribe", deviceId, payload)
        val requestedTopics = topics.toSet()
        val waiterCount = subscriptionAttempts.attachRequest(envelope.requestId, requestedTopics)
        Log.d(
            TAG,
            "subscribe send request=${envelope.requestId.redactedId()} " +
                "topic_prefixes=${subscriptionAttempts.topicPrefixes(topics).joinToString()} " +
                "waiters=$waiterCount",
        )
        sendEnvelope(envelope)
    }

    private fun sendUnsubscribe(topics: List<String>) {
        val payload = WSEnvelope.buildPayload("topics" to topics)
        sendEnvelope(WSEnvelope.build("unsubscribe", deviceId, payload))
        subscribedTopics.removeAll(topics.toSet())
    }

    private fun syncSubscriptions() {
        val needed = desiredTopics.filter {
            it !in subscribedTopics && !subscriptionAttempts.hasInFlightRequest(it)
        }
        if (needed.isNotEmpty()) sendSubscribe(needed)
    }

    // MARK: - Resume

    private fun sendResume() {
        val lastId = lastEventId ?: return
        resumePaginationCount = 0
        val payload = WSEnvelope.buildPayload("last_event_id" to lastId)
        sendEnvelope(WSEnvelope.build("resume", deviceId, payload))
        Log.i(TAG, "Sent resume from $lastId")
    }

    // MARK: - Heartbeat

    private fun startHeartbeat() {
        heartbeatJob?.cancel()
        markOutbound()
        heartbeatJob = scope.launch {
            while (true) {
                delay(HEALTH_CHECK_INTERVAL_MS)
                if (!isAuthenticated) break
                // 对齐 Electron / iOS：只在出站空闲时发应用层 ping，避免高峰空转。
                if (SystemClock.elapsedRealtime() - lastOutboundAtMs >= OUTBOUND_PING_INTERVAL_MS) {
                    sendEnvelope(WSEnvelope.build("ping", deviceId, WSEnvelope.buildPayload()))
                }
            }
        }
    }

    private fun markOutbound() {
        lastOutboundAtMs = SystemClock.elapsedRealtime()
    }

    public fun reportCapabilitiesChanged() {
        capabilityReporter.reportChanged()
    }

    /**
     * Token 刷新回调。由外部（DI 层）设置，返回 true 表示刷新成功。
     * 在 IO 线程调用，需阻塞式执行刷新。
     */
    @Volatile public var tokenRefresher: (() -> Boolean)? = null

    // MARK: - Token Revalidation

    private fun startTokenRevalidation() {
        tokenRevalidationJob?.cancel()
        tokenRevalidationJob = scope.launch {
            while (true) {
                delay(TOKEN_REVALIDATE_INTERVAL_MS)
                if (!isAuthenticated) break
                if (tokenManager.isAccessTokenExpiringSoon) {
                    Log.i(TAG, "Token expiring soon, attempting refresh")
                    val refresher = tokenRefresher
                    if (refresher == null) {
                        Log.w(TAG, "No tokenRefresher set, cannot refresh")
                        handleTokenRevalidationFailure()
                        break
                    }
                    val refreshed = kotlinx.coroutines.withContext(Dispatchers.IO) {
                        try {
                            refresher.invoke()
                        } catch (e: Exception) {
                            Log.w(TAG, "Token refresh threw: ${e.message}")
                            false
                        }
                    }
                    if (!refreshed) {
                        Log.w(TAG, "Token revalidation failed")
                        handleTokenRevalidationFailure()
                        break
                    }
                    Log.i(TAG, "Token refreshed successfully via periodic revalidation")
                }
            }
        }
    }

    private fun handleTokenRevalidationFailure() {
        val authFailHandler = onAuthFailed
        if (authFailHandler != null) {
            disconnect(manual = false)
            authFailHandler.invoke()
        } else {
            fullDisconnect()
        }
    }

    private fun stopTokenRevalidation() {
        tokenRevalidationJob?.cancel()
        tokenRevalidationJob = null
    }

    // MARK: - Message Handling

    private fun handleMessage(text: String) {
        val envelope = WSEnvelope.parse(text) ?: run {
            diagnosticRecorder.recordWebSocket(
                channel = "gateway",
                phase = "receive",
                messageType = "invalid_envelope",
                payloadBytes = text.toByteArray(Charsets.UTF_8).size.toLong(),
                result = "decode_failed",
            )
            Log.w(TAG, "Failed to decode WS envelope")
            return
        }
        diagnosticRecorder.recordWebSocket(
            channel = "gateway",
            phase = "receive",
            messageType = envelope.type,
            payloadBytes = text.toByteArray(Charsets.UTF_8).size.toLong(),
            result = "succeeded",
        )

        val effectiveEventId = envelope.eventId
            ?: envelope.requestId.takeIf { it.startsWith("evt_") }

        if (effectiveEventId != null) {
            if (!trackRecentEventId(effectiveEventId)) return
            envelope.topic?.let { topic -> lastEventIdPerTopic[topic] = effectiveEventId }
            lastEventId = computeMinEventId() ?: effectiveEventId
        }

        routeEnvelope(envelope)
    }

    @Synchronized
    private fun trackRecentEventId(eventId: String): Boolean {
        if (eventId in recentEventIds) return false
        recentEventIds.add(eventId)
        if (recentEventIds.size > RECENT_EVENT_ID_LIMIT) {
            recentEventIds.remove(recentEventIds.first())
        }
        return true
    }

    @Synchronized
    private fun clearRecentEventIds() {
        recentEventIds.clear()
    }

    /**
     * Redis Stream ID 格式 `{timestamp}-{seq}`，字符串比较等价于时间顺序比较。
     * 取所有 topic 中最小的 event_id 作为 resume 起点。
     */
    private fun computeMinEventId(): String? {
        if (lastEventIdPerTopic.isEmpty()) return null
        return lastEventIdPerTopic.values.minOrNull()
    }

    private fun routeEnvelope(envelope: WSEnvelope) {
        // sendAndWaitAck 优先匹配。命中 okType/nakType/error → 吞掉，不下沉到通用路由，
        // 防止 chat.send_message.ok 这类回包污染 stream 流的 envelopeHandlers。
        if (matchPendingAck(envelope)) return

        when (envelope.type) {
            "auth.ok" -> handleAuthOk()
            "auth.revoke" -> handleAuthRevoke(envelope)
            "error" -> handleError(envelope)
            "subscribe.ok" -> handleSubscribeOk(envelope)
            "unsubscribe.ok" -> handleUnsubscribeOk(envelope)
            "resume.ok" -> handleResumeOk(envelope)
            "agent.action.request" -> actionDispatcher.handleRequest(envelope)
            "device.capabilities.refresh.request" -> capabilityReporter.handleRefreshRequest(envelope)
            "connection.resume_hint" -> handleResumeHint()
            "tick", "pong" -> { /* ignore */ }
            else -> envelopeHandlers.values.forEach { it(envelope) }
        }
        releaseDeferredSubscriptionIfTerminal(envelope)
    }

    @Volatile public var onReconnected: (() -> Unit)? = null
    @Volatile public var onAuthFailed: (() -> Unit)? = null

    private val billingTopic: String?
        get() = tokenManager.organizationId?.let { BillingEvents.topicForOrganization(it) }

    private fun handleAuthOk() {
        val wasReconnect = reconnectAttempt.get() > 0
        isAuthenticated = true
        reconnectAttempt.set(0)
        _connectionState.value = WSConnectionState.Connected
        authTimeoutJob?.cancel()
        Log.i(TAG, "Authenticated")
        userEventHandler.get().start()
        // 订阅按角色白名单分流（订阅是整批原子校验，混入被拒 topic 会连坐同批全失败）：
        // - mobile（GUI 登录）：billing.events ✓；agent.action.device.* 会被校验器拒（只放
        //   daemon/device_runtime/electron）
        // - device_runtime（daemon 激活）：agent.action.device.* ✓；billing.events 不在其白名单
        if (tokenManager.isDaemonMode) {
            desiredTopics.add(deviceActionTopic)
        } else {
            billingTopic?.let { desiredTopics.add(it) }
        }
        if (
            ConversationReconnectPolicy.shouldWaitForSubscribeBeforeResume(
                wasReconnect = wasReconnect,
                hasDesiredTopics = desiredTopics.isNotEmpty(),
            )
        ) {
            scope.launch {
                val topics = desiredTopics.filter { it.isNotBlank() }.distinct()
                when (subscribeAndWait(topics)) {
                    SubscriptionResult.Success -> sendResume()
                    else -> {
                        Log.w(TAG, "reconnect subscribe failed; resume anyway for HTTP fallback")
                        sendResume()
                    }
                }
            }
        } else {
            syncSubscriptions()
            sendResume()
        }
        startHeartbeat()
        startTokenRevalidation()
        if (tokenManager.isDaemonMode) {
            // 设备 runtime 专属链路：device.capabilities.report 的 role 闸门只放
            // daemon/device_runtime；L2 自动恢复 / 健康监控的状态上报也走同一上报链。
            capabilityReporter.sendReport()
            l2Recovery.observeAndReportStateChanges()
            l2Recovery.tryAutoRecover()
            serviceHealthMonitor.get().also { monitor ->
                monitor.onDegradedDetected = { l2Recovery.tryAutoRecover() }
                monitor.startMonitoring()
            }
            if (healthMonitorObserveJob?.isActive != true) {
                healthMonitorObserveJob = scope.launch {
                    serviceHealthMonitor.get().automationLevel
                        .drop(1) // skip initial value; StateFlow is already distinct
                        .collect { capabilityReporter.reportChanged() }
                }
            }
        }
        if (wasReconnect) {
            onReconnected?.invoke()
        }
    }

    private fun handleResumeOk(envelope: WSEnvelope) {
        val replayed = envelope.payloadInt("replayed") ?: 0
        val nextCursor = envelope.payloadString("next_cursor")
        Log.i(TAG, "Resume ok, replayed $replayed events, nextCursor=$nextCursor")

        if (replayed > 0) {
            _lastResumeResult.value = ResumeResult(replayed, System.currentTimeMillis())
        }

        if (nextCursor != null && resumePaginationCount < maxResumePaginationRounds) {
            resumePaginationCount++
            val round = resumePaginationCount
            scope.launch {
                delay(100)
                if (!isAuthenticated) return@launch
                val payload = WSEnvelope.buildPayload("last_event_id" to nextCursor)
                sendEnvelope(WSEnvelope.build("resume", deviceId, payload))
                Log.i(TAG, "Resume pagination round $round from $nextCursor")
            }
        } else {
            if (resumePaginationCount >= maxResumePaginationRounds) {
                Log.w(TAG, "Resume pagination limit reached ($maxResumePaginationRounds rounds)")
            }
            resumePaginationCount = 0
        }
    }

    private fun handleResumeHint() {
        val lastId = lastEventId
        if (lastId == null) {
            Log.d(TAG, "Received resume_hint but no lastEventId, ignoring")
            return
        }
        val jitterMs = (Math.random() * 2000).toLong()
        scope.launch {
            delay(jitterMs)
            if (isAuthenticated) {
                Log.i(TAG, "Triggering resume after resume_hint (jitter=${jitterMs}ms)")
                sendResume()
            }
        }
    }

    private fun handleAuthRevoke(envelope: WSEnvelope) {
        val code = envelope.payloadString("code") ?: "WS_AUTH_REVOKED"
        val message = envelope.payloadString("message") ?: "Authentication revoked by server"
        Log.w(TAG, "Auth revoked: $code - $message")
        stopTokenRevalidation()
        val authFailHandler = onAuthFailed
        if (authFailHandler != null) {
            disconnect(manual = false)
            authFailHandler.invoke()
        } else {
            fullDisconnect()
        }
    }

    private fun handleError(envelope: WSEnvelope) {
        val code = envelope.payloadString("code") ?: "unknown"
        val prefixes = subscriptionAttempts.completeRejected(
            requestId = envelope.correlationId(),
            errorCode = code,
            serverMessage = envelope.payloadString("message"),
            rejectedTopic = envelope.payloadDict("details")
                ?.get("topic")
                ?.jsonPrimitive
                ?.contentOrNull,
        )
        Log.e(
            TAG,
            "ws error code=$code request=${envelope.correlationId().redactedId()} " +
                "subscription_prefixes=${prefixes.joinToString().ifBlank { "none" }}",
        )
        if (code == "WS_1001_AUTH_INVALID") {
            cancelAllJobs()
            webSocket?.close(1000, "Auth failed")
            webSocket = null
            isAuthenticated = false
            subscribedTopics.clear()
            subscriptionAttempts.completeAll(SubscriptionResult.Disconnected)
            failPendingAcks()
            _connectionState.value = WSConnectionState.AuthFailed

            onAuthFailed?.let { handler ->
                Log.w(TAG, "Auth invalid, triggering auth failed handler")
                handler.invoke()
            }
        }
    }

    private fun handleSubscribeOk(envelope: WSEnvelope) {
        val topicsArr = envelope.payload["topics"]
        val confirmedTopics = mutableListOf<String>()
        if (topicsArr is JsonArray) {
            for (elem in topicsArr) {
                val topic = elem.jsonPrimitive.contentOrNull ?: continue
                subscribedTopics.add(topic)
                confirmedTopics.add(topic)
            }
            Log.i(TAG, "Subscribed to ${topicsArr.size} topics")
        }
        val resolved = subscriptionAttempts.completeSuccess(envelope.correlationId(), confirmedTopics)
        Log.i(TAG, "subscribe ok request=${envelope.correlationId().redactedId()} resolved=$resolved")
    }

    private fun WSEnvelope.correlationId(): String? = sequenceOf(
        replyTo,
        payloadString("reply_to"),
        payloadString("request_id"),
        requestId,
    ).firstOrNull { !it.isNullOrBlank() }

    private fun String?.redactedId(): String = this?.takeIf { it.isNotBlank() }?.take(8) ?: "none"

    private fun handleUnsubscribeOk(envelope: WSEnvelope) {
        val topicsArr = envelope.payload["topics"]
        if (topicsArr is JsonArray) {
            for (elem in topicsArr) {
                val topic = elem.jsonPrimitive.contentOrNull ?: continue
                subscribedTopics.remove(topic)
            }
        }
        Log.d(TAG, "Unsubscribed ok")
    }

    private fun cancelDeferredUnsubscribe(topics: List<String>? = null) {
        if (topics == null) {
            deferredUnsubscribeJobs.values.forEach { it.cancel() }
            deferredUnsubscribeJobs.clear()
            return
        }
        for (topic in topics) {
            deferredUnsubscribeJobs.remove(topic)?.cancel()
        }
    }

    private fun releaseDeferredSubscriptionIfTerminal(envelope: WSEnvelope) {
        val topic = envelope.topic ?: return
        if (!deferredUnsubscribeJobs.containsKey(topic)) return
        if (!isTerminalStreamEnvelope(envelope)) return
        deferredUnsubscribeJobs.remove(topic)?.cancel()
        unsubscribe(listOf(topic))
    }

    private fun isTerminalStreamEnvelope(envelope: WSEnvelope): Boolean = when (envelope.type) {
        AgentStreamEvent.fullType(AgentStreamEvent.DONE),
        AgentStreamEvent.fullType(AgentStreamEvent.PERSIST_ERROR) -> true
        AgentStreamEvent.fullType(AgentStreamEvent.LIFECYCLE) -> {
            when (envelope.payloadString("phase")?.lowercase()) {
                "done", "end", "completed", "failed", "error" -> true
                else -> false
            }
        }
        else -> false
    }

    // MARK: - Send

    private fun sendEnvelope(envelope: WSEnvelope) {
        val json = envelope.toJson()
        val sent = webSocket?.send(json) ?: false
        if (sent) markOutbound()
        diagnosticRecorder.recordWebSocket(
            channel = "gateway",
            phase = "send",
            messageType = envelope.type,
            payloadBytes = json.toByteArray(Charsets.UTF_8).size.toLong(),
            result = if (sent) "queued" else "disconnected",
        )
        if (!sent) Log.w(TAG, "WebSocket not connected, cannot send")
    }

    // MARK: - Reconnect

    private fun scheduleReconnect() {
        cancelAllJobs()
        webSocket?.cancel()
        webSocket = null
        isAuthenticated = false
        subscribedTopics.clear()
        subscriptionAttempts.completeAll(SubscriptionResult.Disconnected)
        failPendingAcks()

        val attempt = reconnectAttempt.incrementAndGet()
        diagnosticRecorder.recordWebSocket(
            channel = "gateway",
            phase = "reconnect_scheduled",
            attempt = attempt,
        )
        val maxAttempts = if (tokenManager.isDaemonMode) Int.MAX_VALUE else MAX_RECONNECT_ATTEMPTS
        if (attempt > maxAttempts) {
            Log.e(TAG, "Max reconnect attempts ($MAX_RECONNECT_ATTEMPTS) reached, giving up")
            _connectionState.value = WSConnectionState.ReconnectGaveUp
            return
        }
        val baseDelay = min(
            (BASE_RECONNECT_DELAY_MS * RECONNECT_FACTOR.pow(attempt - 1.0)).toLong(),
            MAX_RECONNECT_DELAY_MS,
        )
        val delay = (baseDelay * (0.5 + kotlin.random.Random.nextDouble())).toLong()
        _connectionState.value = WSConnectionState.Reconnecting(attempt)
        Log.i(TAG, "Reconnecting in ${delay}ms (attempt $attempt)")

        reconnectJob = scope.launch {
            delay(delay)
            performConnect()
        }
    }

    // MARK: - Cleanup

    private fun cancelAllJobs() {
        heartbeatJob?.cancel()
        reconnectJob?.cancel()
        authTimeoutJob?.cancel()
        healthMonitorObserveJob?.cancel()
        healthMonitorObserveJob = null
        stopTokenRevalidation()
        serviceHealthMonitor.get().stopMonitoring()
        l2Recovery.cancelAll()
        capabilityReporter.cancelAll()
        actionDispatcher.cancelAll()
    }
}
