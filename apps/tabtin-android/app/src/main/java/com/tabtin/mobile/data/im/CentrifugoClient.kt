package com.tabtin.mobile.data.im

import android.util.Log
import com.tabtin.mobile.data.api.TokenRefreshCoordinator
import com.tabtin.mobile.data.api.TokenRefreshResult
import com.tabtin.mobile.data.api.resolveEffectiveCentrifugoWsUrl
import com.tabtin.mobile.diagnostics.DiagnosticRecorder
import com.tabtin.mobile.util.TokenManager
import io.github.centrifugal.centrifuge.Client
import io.github.centrifugal.centrifuge.ConnectedEvent
import io.github.centrifugal.centrifuge.ConnectingEvent
import io.github.centrifugal.centrifuge.DisconnectedEvent
import io.github.centrifugal.centrifuge.DuplicateSubscriptionException
import io.github.centrifugal.centrifuge.ErrorEvent
import io.github.centrifugal.centrifuge.EventListener
import io.github.centrifugal.centrifuge.Options
import io.github.centrifugal.centrifuge.PublicationEvent
import io.github.centrifugal.centrifuge.Subscription
import io.github.centrifugal.centrifuge.SubscriptionEventListener
import io.github.centrifugal.centrifuge.SubscriptionOptions
import io.github.centrifugal.centrifuge.SubscribedEvent
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import javax.inject.Inject
import javax.inject.Singleton
import kotlin.math.min
import kotlin.math.pow

/** 用户级 IM 实时事件源；Store 不感知 Centrifugo 或其他具体 SDK。 */
public interface ImPersonalRealtimeSource {
    public fun setPersonalPublicationListener(listener: ((ByteArray) -> Unit)?)
    /** personal subscription 确认可用后触发；调用方可在无订阅空窗的前提下补拉权威目录。 */
    public fun setConnectionAvailableListener(listener: (() -> Unit)?)
}

internal object NoopImPersonalRealtimeSource : ImPersonalRealtimeSource {
    override fun setPersonalPublicationListener(listener: ((ByteArray) -> Unit)?) = Unit
    override fun setConnectionAvailableListener(listener: (() -> Unit)?) = Unit
}

/**
 * TabChat IM 实时通道客户端（Phase A），对齐 iOS `CentrifugoClient.swift`。
 *
 * 封装 `centrifuge-java`，但**完全接管连接生命周期**（不依赖 SDK 的自动重连语义）：
 * 后端 Connect Proxy 只从连接请求的 `data.token` 读凭据（见
 * `apps/tabtin_django/apps/tabchat/centrifugo_proxy.py`），且对 token/session 失效返回
 * `4001-4009` 段 disconnect code——Centrifugo 把这些码标为 `reconnect=true`，SDK 会拿着
 * 首连时那份**静态**的 `Options.data` 无限自动重连（token 过期后必然循环失败）。而
 * `centrifuge-java` 的 `Options.setData` 一旦设定即固定，`ConnectionTokenGetter` 只刷新
 * protocol token（后端不读）。
 *
 * 因此策略是：每次（重）连接都**重新取 token → 构造新 data → 重建 Client**；SDK 一旦想自己
 * 重连（`onConnecting`，非我方 connect 触发）或 terminal 断开（`onDisconnected`），立即打断并
 * 由本类持续退避自管重连，token 类断开强制刷新 token。
 *
 * 命名注意：本类 `CentrifugoClient` 对应产品侧 Centrifugo；SDK 类型为 `Client`。
 * 全部状态在单线程 [scope]（Main.immediate）上串行读写，SDK 回调（在 SDK 线程）统一 hop 进来，
 * 无需额外加锁；用 [connectionGeneration] 挡掉已废弃 client 的迟到回调。
 */
@Singleton
public class CentrifugoClient @Inject constructor(
    private val tokenManager: TokenManager,
    private val refreshCoordinator: TokenRefreshCoordinator,
    private val diagnosticRecorder: DiagnosticRecorder,
) : ImPersonalRealtimeSource {
    public enum class ConnectionState { DISCONNECTED, CONNECTING, CONNECTED }

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)

    private val _state = MutableStateFlow(ConnectionState.DISCONNECTED)
    public val state: StateFlow<ConnectionState> = _state.asStateFlow()

    /** personal 频道收到的原始发布负载（用 [ImEventDecoder] 解析）。 */
    private var personalPublicationListener: ((ByteArray) -> Unit)? = null
    private var connectionAvailableListener: (() -> Unit)? = null

    override fun setPersonalPublicationListener(listener: ((ByteArray) -> Unit)?) {
        personalPublicationListener = listener
    }

    override fun setConnectionAvailableListener(listener: (() -> Unit)?) {
        connectionAvailableListener = listener
    }

    /** `chat:{conversationId}` 频道收到的原始发布负载（conversationId, 原始 JSON bytes）。 */
    public var onChatPublication: ((conversationId: String, data: ByteArray) -> Unit)? = null

    /** 会话级监听：允许导航栈中的父会话与新 push 的私信同时保留各自 realtime 状态。 */
    private val chatPublicationListeners: MutableMap<String, (ByteArray) -> Unit> = mutableMapOf()
    private val chatConnectionAvailableListeners: MutableMap<String, () -> Unit> = mutableMapOf()

    private var client: Client? = null
    private var personalSubscription: Subscription? = null

    /** 期望订阅的会话频道——跨重连保留，(重)连时逐个重新订阅。 */
    private val desiredChatConversationIds: MutableSet<String> = mutableSetOf()

    /** 绑定当前 client 的会话频道订阅；teardown 随 client 作废，desired 集合不变。 */
    private val chatSubscriptions: MutableMap<String, Subscription> = mutableMapOf()

    private var connectJob: Job? = null
    private var reconnectJob: Job? = null

    private var isManualDisconnect = false
    /** 标记本类刚发起的这次连接，用于区分我方 connect 触发的首个 onConnecting 与 SDK 自发重连。 */
    private var managedConnectInFlight = false
    /** 连接代次：区分当前 client 与已废弃 client 的迟到回调。 */
    private var connectionGeneration = 0
    private var reconnectAttempt = 0

    // MARK: - 生命周期

    /** 连接并订阅**当前登录用户**的个人频道。重复调用（已在连接/重连/已连）直接忽略。 */
    public fun connect() {
        diagnosticRecorder.recordWebSocket(channel = "centrifugo", phase = "connect")
        scope.launch {
            if (connectJob != null || reconnectJob != null || client != null) return@launch
            isManualDisconnect = false
            reconnectAttempt = 0
            connectJob = scope.launch {
                establishConnection(forceRefresh = false)
                connectJob = null
            }
        }
    }

    public fun disconnect() {
        diagnosticRecorder.recordWebSocket(channel = "centrifugo", phase = "disconnect", result = "manual")
        scope.launch {
            isManualDisconnect = true
            connectJob?.cancel(); connectJob = null
            reconnectJob?.cancel(); reconnectJob = null
            teardownClient()
            desiredChatConversationIds.clear()
            chatPublicationListeners.clear()
            chatConnectionAvailableListeners.clear()
            _state.value = ConnectionState.DISCONNECTED
        }
    }

    /** 注册/移除单会话 publication 监听；同 conversationId 后注册者替换前者。 */
    public fun setChatPublicationListener(conversationId: String, listener: ((ByteArray) -> Unit)?) {
        if (conversationId.isBlank()) return
        if (listener == null) {
            chatPublicationListeners.remove(conversationId)
        } else {
            chatPublicationListeners[conversationId] = listener
        }
    }

    public fun setChatConnectionAvailableListener(conversationId: String, listener: (() -> Unit)?) {
        if (conversationId.isBlank()) return
        if (listener == null) {
            chatConnectionAvailableListeners.remove(conversationId)
        } else {
            chatConnectionAvailableListeners[conversationId] = listener
        }
    }

    /** 进入会话详情：订阅该会话的 `chat:{conv}` 频道（幂等，跨重连恢复）。 */
    public fun subscribeChat(conversationId: String) {
        if (conversationId.isEmpty()) return
        diagnosticRecorder.recordWebSocket(channel = "centrifugo", phase = "subscribe", messageType = "chat")
        scope.launch {
            desiredChatConversationIds.add(conversationId)
            installChatSubscription(conversationId)
        }
    }

    /** 退出会话详情：退订并移除该会话频道（保留连接与 personal 订阅）。 */
    public fun unsubscribeChat(conversationId: String) {
        diagnosticRecorder.recordWebSocket(channel = "centrifugo", phase = "unsubscribe", messageType = "chat")
        scope.launch {
            desiredChatConversationIds.remove(conversationId)
            val sub = chatSubscriptions.remove(conversationId) ?: return@launch
            runCatching { sub.unsubscribe() }
            runCatching { client?.removeSubscription(sub) }
        }
    }

    /**
     * 向 `chat:{conv}` publish 一条负载（typing 用）。后端 publish proxy 白名单只放行
     * `im.typing`；未订阅该会话 / 未连接则静默丢弃（typing 尽力而为，丢了无副作用）。
     */
    public fun publishToChat(conversationId: String, payloadJson: String) {
        diagnosticRecorder.recordWebSocket(
            channel = "centrifugo",
            phase = "send",
            messageType = "im.typing",
            payloadBytes = payloadJson.toByteArray(Charsets.UTF_8).size.toLong(),
        )
        scope.launch {
            val sub = chatSubscriptions[conversationId] ?: return@launch
            runCatching {
                sub.publish(payloadJson.toByteArray(Charsets.UTF_8)) { err, _ ->
                    if (err != null) Log.d(TAG, "chat publish failed conv=$conversationId: $err")
                }
            }
        }
    }

    // MARK: - 内部

    private suspend fun establishConnection(forceRefresh: Boolean) {
        if (isManualDisconnect) return
        _state.value = ConnectionState.CONNECTING

        // personal 频道只订阅当前登录用户——每次（重）连都重取，用户切换后自然指向新用户。
        val userId = tokenManager.userId?.takeIf { it.isNotBlank() }
        if (userId == null) {
            Log.w(TAG, "no authenticated user; scheduling reconnect")
            scheduleCredentialRetry(forceRefresh = false)
            return
        }
        val token = fetchToken(forceRefresh)
        if (isManualDisconnect) return
        if (token == null) {
            Log.w(TAG, "no access token available; scheduling reconnect")
            scheduleCredentialRetry(forceRefresh = true)
            return
        }

        teardownClient() // 换 client 前拆旧的；旧 client 的迟到事件由 generation 挡掉

        connectionGeneration += 1
        val generation = connectionGeneration
        val eventListener = buildEventListener(generation)
        val subListener = buildSubscriptionListener(generation)

        // 不设 token/tokenGetter：后端不读 protocol token，凭据只走 data。
        val opts = Options().apply {
            data = connectData(token)
        }
        val centrifuge = Client(resolveEndpoint(), opts, eventListener)
        client = centrifuge

        runCatching {
            val sub = centrifuge.newSubscription(personalChannel(userId), SubscriptionOptions(), subListener)
            personalSubscription = sub
            sub.subscribe()
        }.onFailure { Log.e(TAG, "personal subscription failed", it) }

        // 重新订阅进入过、尚未退出的会话频道（跨重连恢复）。
        for (conversationId in desiredChatConversationIds) {
            installChatSubscription(conversationId)
        }

        managedConnectInFlight = true
        runCatching { centrifuge.connect() }
            .onFailure { Log.e(TAG, "centrifuge connect failed", it) }
    }

    /**
     * 登录恢复与 token 单飞存在短暂窗口时，凭据可能暂时取不到。这不是手动断开，不能
     * 把连接永久留在 DISCONNECTED；继续走同一套有上限退避，凭据恢复后自动追平目录。
     */
    private fun scheduleCredentialRetry(forceRefresh: Boolean) {
        _state.value = ConnectionState.DISCONNECTED
        diagnosticRecorder.recordWebSocket(
            channel = "centrifugo",
            phase = "reconnect_scheduled",
            result = "credential_unavailable",
            attempt = reconnectAttempt + 1,
        )
        scheduleReconnect(forceRefresh = forceRefresh)
    }

    /** 在当前 client 上创建并订阅一个会话频道（幂等：无 client / 已存在则跳过）。 */
    private fun installChatSubscription(conversationId: String) {
        val centrifuge = client ?: return
        val listener = currentSubListener ?: return
        if (chatSubscriptions.containsKey(conversationId)) return
        try {
            val sub = centrifuge.newSubscription(chatChannel(conversationId), SubscriptionOptions(), listener)
            chatSubscriptions[conversationId] = sub
            sub.subscribe()
        } catch (e: DuplicateSubscriptionException) {
            Log.w(TAG, "chat subscription duplicate conv=$conversationId", e)
        } catch (e: Throwable) {
            Log.e(TAG, "chat subscription failed conv=$conversationId", e)
        }
    }

    /** 当前 client 的 subscription 监听器（供 installChatSubscription 复用同一 generation）。 */
    private var currentSubListener: SubscriptionEventListener? = null

    /** 拆掉当前 client 并使其后续回调失效（递增 generation）。幂等。 */
    private fun teardownClient() {
        connectionGeneration += 1
        personalSubscription = null
        chatSubscriptions.clear() // 订阅绑定旧 client；desired 集合保留供重连恢复
        currentSubListener = null
        val old = client
        client = null
        runCatching { old?.disconnect() } // 触发的 onDisconnected 带旧 generation，会被守卫挡掉
    }

    /** 持续自管重连；退避封顶后保持低频尝试，网络恢复时无需用户重启 App。 */
    private fun scheduleReconnect(forceRefresh: Boolean) {
        if (isManualDisconnect || reconnectJob != null) return
        teardownClient() // 打断 SDK 自身的自动重连（它会用旧静态 data）
        reconnectAttempt += 1
        val delayMs = centrifugoReconnectDelayMillis(reconnectAttempt)
        _state.value = ConnectionState.CONNECTING
        val attempt = reconnectAttempt
        reconnectJob = scope.launch {
            delay(delayMs)
            if (isManualDisconnect) return@launch
            reconnectJob = null
            Log.i(TAG, "Centrifugo reconnect attempt $attempt")
            establishConnection(forceRefresh)
        }
    }

    private suspend fun fetchToken(forceRefresh: Boolean): String? = withContext(Dispatchers.IO) {
        // 只依赖 TokenManager + TokenRefreshCoordinator（不反向依赖 features 包的
        // EmbeddedWebAuthCoordinator，避免 data→features 依赖）。
        if (forceRefresh || tokenManager.isAccessTokenExpiringSoon) {
            when (val result = refreshCoordinator.refreshBlockingResult()) {
                is TokenRefreshResult.Success -> result.accessToken
                else -> tokenManager.accessToken?.takeIf { it.isNotBlank() }
            }
        } else {
            tokenManager.accessToken?.takeIf { it.isNotBlank() }
        }
    }

    /** 连接请求携带的 data —— 后端 centrifugo_proxy 只从 `data.token` 读凭据。 */
    private fun connectData(token: String): ByteArray =
        buildJsonObject { put("token", token) }.toString().toByteArray(Charsets.UTF_8)

    private fun resolveEndpoint(): String = resolveEffectiveCentrifugoWsUrl(tokenManager)

    // MARK: - SDK 回调（全部 hop 到 scope，按 generation 守卫）

    private fun buildEventListener(generation: Int): EventListener = object : EventListener() {
        override fun onConnected(client: Client, event: ConnectedEvent) {
            scope.launch { handleConnected(generation) }
        }

        override fun onConnecting(client: Client, event: ConnectingEvent) {
            val code = event.code
            val reason = event.reason ?: ""
            scope.launch { handleConnecting(generation, code, reason) }
        }

        override fun onDisconnected(client: Client, event: DisconnectedEvent) {
            val code = event.code
            val reason = event.reason ?: ""
            scope.launch { handleDisconnected(generation, code, reason) }
        }

        override fun onError(client: Client, event: ErrorEvent) {
            val message = event.error?.message ?: event.error?.toString() ?: "unknown"
            scope.launch {
                if (generation == connectionGeneration) {
                    diagnosticRecorder.recordWebSocket(
                        channel = "centrifugo",
                        phase = "error",
                        result = "failed",
                        error = event.error,
                    )
                    Log.e(TAG, "Centrifugo error: $message")
                }
            }
        }
    }

    private fun buildSubscriptionListener(generation: Int): SubscriptionEventListener {
        val listener = object : SubscriptionEventListener() {
            override fun onSubscribed(sub: Subscription, event: SubscribedEvent) {
                scope.launch { handleSubscribed(generation, sub.channel) }
            }

            override fun onPublication(sub: Subscription, event: PublicationEvent) {
                val channel = sub.channel
                val data = event.data
                scope.launch { handlePublication(generation, channel, data) }
            }
        }
        currentSubListener = listener
        return listener
    }

    private fun handleConnected(generation: Int) {
        if (generation != connectionGeneration) return
        managedConnectInFlight = false
        reconnectAttempt = 0
        _state.value = ConnectionState.CONNECTED
        diagnosticRecorder.recordWebSocket(channel = "centrifugo", phase = "open", result = "succeeded")
        Log.i(TAG, "Centrifugo connected")
    }

    private fun handleSubscribed(generation: Int, channel: String) {
        if (generation != connectionGeneration) return
        val availability = centrifugoSubscriptionAvailability(channel) ?: return
        diagnosticRecorder.recordWebSocket(
            channel = channel,
            phase = "subscribed",
            messageType = if (availability is CentrifugoSubscriptionAvailability.Chat) "chat" else "personal",
            result = "succeeded",
        )
        when (availability) {
            CentrifugoSubscriptionAvailability.Personal -> connectionAvailableListener?.invoke()
            is CentrifugoSubscriptionAvailability.Chat ->
                chatConnectionAvailableListeners[availability.conversationId]?.invoke()
        }
    }

    private fun handleConnecting(generation: Int, code: Int, reason: String) {
        if (generation != connectionGeneration) return
        if (managedConnectInFlight) {
            // 本类刚发起的这次连接正常进入 connecting。
            managedConnectInFlight = false
            _state.value = ConnectionState.CONNECTING
            return
        }
        // 连过之后 SDK 想自己重连（会带旧静态 data）→ 完全接管。
        Log.i(TAG, "intercept SDK auto-reconnect code=$code reason=$reason")
        diagnosticRecorder.recordWebSocket(
            channel = "centrifugo",
            phase = "reconnect_scheduled",
            closeCode = code,
            attempt = reconnectAttempt + 1,
        )
        scheduleReconnect(forceRefresh = code in TOKEN_FAILURE_CODES)
    }

    private fun handleDisconnected(generation: Int, code: Int, reason: String) {
        if (generation != connectionGeneration) return
        Log.i(TAG, "Centrifugo disconnected code=$code reason=$reason")
        diagnosticRecorder.recordWebSocket(
            channel = "centrifugo",
            phase = "close",
            closeCode = code,
            result = if (isManualDisconnect) "manual" else "unexpected",
        )
        if (isManualDisconnect) {
            _state.value = ConnectionState.DISCONNECTED
            return
        }
        // server terminal 断开（reconnect=false）→ 自管重连。
        scheduleReconnect(forceRefresh = code in TOKEN_FAILURE_CODES)
    }

    /** 按频道路由 publication：`chat:{conv}` → 会话回调（带 conversationId）；其余 → personal 回调。 */
    private fun handlePublication(generation: Int, channel: String, data: ByteArray) {
        if (generation != connectionGeneration) return
        diagnosticRecorder.recordWebSocket(
            channel = "centrifugo",
            phase = "receive",
            messageType = if (channel.startsWith(CHAT_CHANNEL_PREFIX)) "chat_publication" else "personal_publication",
            payloadBytes = data.size.toLong(),
            result = "succeeded",
        )
        if (channel.startsWith(CHAT_CHANNEL_PREFIX)) {
            val conversationId = channel.removePrefix(CHAT_CHANNEL_PREFIX)
            chatPublicationListeners[conversationId]?.invoke(data)
            onChatPublication?.invoke(conversationId, data)
        } else {
            personalPublicationListener?.invoke(data)
        }
    }

    public companion object {
        private const val TAG = "CentrifugoClient"
        private const val CHAT_CHANNEL_PREFIX = "chat:"

        /** 后端 connect proxy 对 token/session 失效返回的 disconnect code（重连需强刷 token）。 */
        private val TOKEN_FAILURE_CODES: Set<Int> = setOf(4001, 4002, 4003, 4004, 4005, 4007, 4008, 4009)

        public fun personalChannel(userId: String): String = "personal:$userId"
        public fun chatChannel(conversationId: String): String = "chat:$conversationId"
    }
}

internal fun centrifugoReconnectDelayMillis(attempt: Int): Long = min(
    20_000L,
    (500L * 1.5.pow((attempt - 1).coerceAtLeast(0).toDouble())).toLong(),
)

internal fun centrifugoChatConversationId(channel: String): String? {
    if (!channel.startsWith("chat:")) return null
    return channel.removePrefix("chat:").takeIf { it.isNotBlank() }
}

internal sealed interface CentrifugoSubscriptionAvailability {
    data object Personal : CentrifugoSubscriptionAvailability
    data class Chat(val conversationId: String) : CentrifugoSubscriptionAvailability
}

internal fun centrifugoSubscriptionAvailability(channel: String): CentrifugoSubscriptionAvailability? {
    centrifugoChatConversationId(channel)?.let {
        return CentrifugoSubscriptionAvailability.Chat(it)
    }
    if (!channel.startsWith("personal:")) return null
    return channel.removePrefix("personal:")
        .takeIf { it.isNotBlank() }
        ?.let { CentrifugoSubscriptionAvailability.Personal }
}
