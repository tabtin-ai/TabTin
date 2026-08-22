package com.tabtin.mobile.daemon

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import com.tabtin.mobile.BuildConfig
import com.tabtin.mobile.R
import com.tabtin.mobile.data.websocket.WebSocketService
import com.tabtin.mobile.util.TokenManager
import dagger.hilt.android.AndroidEntryPoint
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.File
import java.io.IOException
import java.net.URI
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import javax.inject.Inject
import kotlin.math.min
import kotlin.math.pow

/**
 * 轻量 daemon 前台服务。
 *
 * 桌面端通过 [DaemonReceiver] 将 install_token 注入后启动本服务：
 * 1. 调用后端 /activate 用 install_token 换取 daemon JWT
 * 2. 将 JWT 写入 [TokenManager]
 * 3. 启动 [WebSocketService] 连接后端，接收 Agent 指令
 *
 * 就绪标记写入应用内部存储，桌面端通过 `adb shell run-as` 读取。
 */
@AndroidEntryPoint
public class DaemonService : Service() {

    public companion object {
        private const val TAG = "DaemonService"
        private const val CHANNEL_ID = "tabtin_daemon"
        private const val NOTIFICATION_ID = 9001

        private const val EXTRA_INSTALL_TOKEN = "install_token"
        private const val EXTRA_API_URL = "api_url"
        private const val EXTRA_WS_URL = "ws_url"
        private const val EXTRA_ACTIVATION_NONCE = "activation_nonce"

        public const val READY_FLAG_FILENAME: String = ".daemon_ready"

        private const val MAX_ACTIVATE_RETRIES = 5
        private const val BASE_RETRY_DELAY_MS = 2_000L
        private const val MAX_RETRY_DELAY_MS = 30_000L

        private val LOCAL_DEV_HOSTS = setOf("localhost", "127.0.0.1", "10.0.2.2")

        /**
         * DD-002: 检查 URL 是否使用非安全 HTTP scheme 且目标非本地开发地址。
         * 本地地址（localhost / 127.0.0.1 / 10.0.2.2）视为安全例外。
         */
        internal fun isInsecureUrl(url: String): Boolean {
            if (!url.startsWith("http://")) return false
            val host = try { URI(url).host?.lowercase() } catch (_: Exception) { return true }
            return host !in LOCAL_DEV_HOSTS
        }

        @Volatile
        public var isRunning: Boolean = false
            private set

        public fun start(context: Context, installToken: String, apiUrl: String?, wsUrl: String?, activationNonce: String? = null) {
            val intent = Intent(context, DaemonService::class.java).apply {
                putExtra(EXTRA_INSTALL_TOKEN, installToken)
                apiUrl?.let { putExtra(EXTRA_API_URL, it) }
                wsUrl?.let { putExtra(EXTRA_WS_URL, it) }
                activationNonce?.let { putExtra(EXTRA_ACTIVATION_NONCE, it) }
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent)
            } else {
                context.startService(intent)
            }
        }
    }

    @Inject public lateinit var tokenManager: TokenManager
    @Inject public lateinit var webSocketService: WebSocketService
    @Inject public lateinit var privilegedProcessManager: dagger.Lazy<com.tabtin.mobile.data.privileged.PrivilegedProcessManager>

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val json = Json { ignoreUnknownKeys = true }
    private val activating = AtomicBoolean(false)
    private var activateJob: Job? = null

    private var activationInstallToken: String? = null
    private var activationApiUrl: String? = null
    private var activationWsUrl: String? = null
    private var activationNonce: String? = null

    private val httpClient by lazy {
        OkHttpClient.Builder()
            .connectTimeout(30, TimeUnit.SECONDS)
            .readTimeout(30, TimeUnit.SECONDS)
            .writeTimeout(30, TimeUnit.SECONDS)
            .build()
    }

    override fun onCreate() {
        super.onCreate()
        createNotificationChannel()
        ServiceCompat.startForeground(
            this,
            NOTIFICATION_ID,
            buildNotification("正在初始化..."),
            ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE,
        )
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val installToken = intent?.getStringExtra(EXTRA_INSTALL_TOKEN)
        if (installToken.isNullOrBlank()) {
            Log.w(TAG, "No install_token provided, stopping")
            stopSelf()
            return START_NOT_STICKY
        }

        if (!activating.compareAndSet(false, true)) {
            Log.w(TAG, "Activation already in progress, ignoring duplicate broadcast")
            return START_STICKY
        }

        val apiUrl = intent.getStringExtra(EXTRA_API_URL)
        val wsUrl = intent.getStringExtra(EXTRA_WS_URL)
        val nonce = intent.getStringExtra(EXTRA_ACTIVATION_NONCE)

        activateJob = scope.launch {
            try {
                activate(installToken, apiUrl, wsUrl, nonce)
            } catch (e: Exception) {
                Log.e(TAG, "Daemon activation failed", e)
                updateNotification("激活失败: ${e.message}")
                stopSelf()
            } finally {
                activating.set(false)
            }
        }

        return START_STICKY
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onDestroy() {
        isRunning = false
        activateJob?.cancel()
        scope.cancel()
        webSocketService.onAuthFailed = null
        webSocketService.fullDisconnect()
        removeReadyFlag()
        super.onDestroy()
    }

    private suspend fun activate(installToken: String, apiUrl: String?, wsUrl: String?, nonce: String? = null) {
        activationInstallToken = installToken
        activationApiUrl = apiUrl
        activationWsUrl = wsUrl
        activationNonce = nonce

        updateNotification("正在激活设备...")

        val baseUrl = apiUrl ?: BuildConfig.API_BASE_URL

        if (isInsecureUrl(baseUrl)) {
            Log.w(TAG, "apiUrl uses insecure HTTP scheme: $baseUrl — JWT may be exposed in transit. Use HTTPS for production.")
        }

        val activateUrl = "$baseUrl/context/devices/activate"

        val fingerprint = tokenManager.deviceId
        val capabilities = listOf(
            "device_info", "battery_info", "network_info", "automation_status",
            "read_contacts", "search_contacts", "read_sms", "send_sms",
            "read_call_log", "make_call", "read_calendar", "read_notifications",
            "list_installed_apps", "get_location", "read_media",
            "screen_capture", "screen_snapshot", "screen_ui_tree",
            "screen_tap", "screen_tap_area", "screen_swipe", "screen_long_press",
            "screen_type_text", "screen_key_event", "screen_wait_for_idle",
            "screen_tap_element", "screen_long_press_element", "screen_type_in_element",
            "screen_find_element", "screen_get_context", "screen_wait_for_element",
            "screen_launch_app", "screen_open_app", "screen_force_stop_app",
            "set_system_setting", "get_system_setting", "set_stealth_mode",
            "launch_with_intent", "save_to_device",
        )

        val requestBody = json.encodeToString(
            JsonObject.serializer(),
            kotlinx.serialization.json.buildJsonObject {
                put("token", kotlinx.serialization.json.JsonPrimitive(installToken))
                put("fingerprint", kotlinx.serialization.json.JsonPrimitive(fingerprint))
                put("device_type", kotlinx.serialization.json.JsonPrimitive("daemon"))
                put("device_name", kotlinx.serialization.json.JsonPrimitive("TabPhone Emulator"))
                put("capabilities", kotlinx.serialization.json.JsonArray(
                    capabilities.map { kotlinx.serialization.json.JsonPrimitive(it) }
                ))
            },
        )

        Log.i(TAG, "Activating device at $activateUrl (fingerprint=$fingerprint)")

        val request = Request.Builder()
            .url(activateUrl)
            .post(requestBody.toRequestBody("application/json".toMediaType()))
            .build()

        val responseBody = executeActivateWithRetry(request)

        val parsed = json.parseToJsonElement(responseBody).jsonObject
        val data = parsed["data"]?.jsonObject ?: parsed

        val accessToken = data["access_token"]?.jsonPrimitive?.contentOrNull
            ?: throw Exception("No access_token in activate response")
        val organizationId = data["organization_id"]?.jsonPrimitive?.contentOrNull
        val deviceId = data["device_id"]?.jsonPrimitive?.contentOrNull

        Log.i(TAG, "Activation successful (deviceId=$deviceId, organizationId=$organizationId)")

        tokenManager.setDaemonCredentials(
            accessToken = accessToken,
            organizationId = organizationId,
            apiBaseUrl = apiUrl,
            wsBaseUrl = wsUrl,
        )

        updateNotification("正在连接服务器...")
        webSocketService.onAuthFailed = { scope.launch { handleAuthFailure() } }
        webSocketService.connect()

        isRunning = true
        writeReadyFlag(nonce)
        updateNotification("受控端运行中")
        Log.i(TAG, "Daemon fully activated and connected")

        tryConnectL2()
    }

    /**
     * HTTP 激活请求指数退避重试。
     * 4xx 错误（客户端侧问题，如 token 无效）不重试；
     * 5xx 和网络 IO 异常会重试最多 [MAX_ACTIVATE_RETRIES] 次。
     */
    private suspend fun executeActivateWithRetry(request: Request): String {
        var lastException: Exception? = null
        for (attempt in 1..MAX_ACTIVATE_RETRIES) {
            try {
                val response = httpClient.newCall(request).execute()
                val body = response.body.string()
                if (body.isEmpty()) throw IOException("Empty response from activate")
                if (response.isSuccessful) return body
                if (response.code in 400..499) {
                    throw Exception("Activate rejected (${response.code}): $body")
                }
                throw IOException("Activate server error (${response.code}): $body")
            } catch (e: IOException) {
                lastException = e
                if (attempt < MAX_ACTIVATE_RETRIES) {
                    val delayMs = min(
                        (BASE_RETRY_DELAY_MS * 2.0.pow(attempt - 1.0)).toLong(),
                        MAX_RETRY_DELAY_MS,
                    )
                    Log.w(TAG, "Activate attempt $attempt/$MAX_ACTIVATE_RETRIES failed: ${e.message}, retrying in ${delayMs}ms")
                    updateNotification("连接失败，${delayMs / 1000}s 后重试 ($attempt/$MAX_ACTIVATE_RETRIES)")
                    kotlinx.coroutines.delay(delayMs)
                }
            }
        }
        throw lastException ?: IOException("Activate failed after $MAX_ACTIVATE_RETRIES retries")
    }

    /**
     * WebSocket 认证失败回调 — JWT 过期后尝试用存储的 install_token 重新激活。
     * CM-008: 入口检查 activating 锁，防止并发 auth failure 回调导致重入。
     */
    private suspend fun handleAuthFailure() {
        Log.w(TAG, "JWT auth failed in daemon mode, attempting re-activation")

        if (!activating.compareAndSet(false, true)) {
            Log.w(TAG, "Re-activation skipped: another activation already in progress")
            return
        }

        val token = activationInstallToken
        if (token == null) {
            Log.e(TAG, "Cannot re-activate: no stored install_token")
            updateNotification("认证失败，无法恢复")
            activating.set(false)
            return
        }
        try {
            updateNotification("令牌过期，正在重新激活...")
            activate(token, activationApiUrl, activationWsUrl, activationNonce)
        } catch (e: Exception) {
            Log.e(TAG, "Re-activation failed, stopping daemon", e)
            updateNotification("重新激活失败，请重新连接桌面端")
            stopSelf()
        } finally {
            activating.set(false)
        }
    }

    /**
     * 尝试连接桌面端通过外部 ADB 启动的 L2 特权进程。
     * 多次重试，因为桌面端可能在 daemon 激活后才启动 L2 服务器。
     * 连接失败后上报能力变更，让后端知道 L2 action 不可用。
     */
    private fun tryConnectL2() {
        scope.launch {
            for (attempt in 1..10) {
                kotlinx.coroutines.delay(2000L)
                val connected = privilegedProcessManager.get().connectToExistingServer()
                if (connected) {
                    Log.i(TAG, "L2 privileged process connected (attempt $attempt)")
                    return@launch
                }
            }
            Log.w(TAG, "L2 privileged process not available after 10 attempts, L2 actions disabled")
            webSocketService.reportCapabilitiesChanged()
        }
    }

    private fun writeReadyFlag(nonce: String? = null) {
        try {
            // CM-003: 写入 nonce（桌面端传入的时间戳）代替固定 "ready"，
            // 桌面端通过比对 nonce 判断是本次激活成功还是残留旧标记
            File(filesDir, READY_FLAG_FILENAME).writeText(nonce ?: "ready")
        } catch (e: Exception) {
            Log.w(TAG, "Failed to write ready flag: ${e.message}")
        }
    }

    private fun removeReadyFlag() {
        try {
            File(filesDir, READY_FLAG_FILENAME).delete()
        } catch (_: Exception) {}
    }

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                "TabTin 受控端",
                NotificationManager.IMPORTANCE_LOW,
            ).apply {
                description = "TabTin 受控端后台运行通知"
            }
            val nm = getSystemService(NotificationManager::class.java)
            nm.createNotificationChannel(channel)
        }
    }

    private fun buildNotification(text: String): Notification {
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("TabTin 受控端")
            .setContentText(text)
            .setSmallIcon(R.mipmap.ic_launcher)
            .setOngoing(true)
            .build()
    }

    private fun updateNotification(text: String) {
        val nm = getSystemService(NotificationManager::class.java)
        nm.notify(NOTIFICATION_ID, buildNotification(text))
    }
}
