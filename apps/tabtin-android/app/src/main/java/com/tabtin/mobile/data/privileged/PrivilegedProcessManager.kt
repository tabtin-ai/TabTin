package com.tabtin.mobile.data.privileged

import android.content.Context
import android.os.Build
import android.util.Log
import com.tabtin.mobile.data.adb.AdbConnectionManager
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.withTimeout
import kotlin.coroutines.cancellation.CancellationException
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.put
import android.net.LocalSocket
import android.net.LocalSocketAddress
import java.io.BufferedInputStream
import java.io.BufferedOutputStream
import java.io.EOFException
import java.io.IOException
import java.util.concurrent.atomic.AtomicInteger
import javax.inject.Inject
import javax.inject.Singleton
import kotlin.math.min
import kotlin.math.pow

private fun JsonElement?.asBoolean(): Boolean {
    val prim = this as? JsonPrimitive ?: return false
    return prim.booleanOrNull ?: (prim.content == "true")
}

private fun JsonElement?.asStringOrNull(): String? =
    (this as? JsonPrimitive)?.content

/** ADB shell 安全转义：用单引号包裹值，防止 ~、=、空格等被 shell 展开 */
private fun shellEscape(value: String): String =
    "'" + value.replace("'", "'\\''") + "'"

public enum class PrivilegedProcessState {
    STOPPED,
    STARTING,
    RUNNING,
    ERROR,
}

@Singleton
public class PrivilegedProcessManager @Inject constructor(
    @ApplicationContext private val context: Context,
    private val adbConnection: AdbConnectionManager,
) {
    public companion object {
        private const val TAG = "PrivilegedProcMgr"
        private const val SOCKET_NAME = "tabtin_privileged"
        private const val HEARTBEAT_INTERVAL_MS = 10_000L
        private const val SOCKET_TIMEOUT_MS = 120_000
        private const val SERVER_CLASS = "com.tabtin.mobile.privileged.Server"
        private const val MAX_RECONNECT_ATTEMPTS = 5
        private const val BASE_RECONNECT_DELAY_MS = 2_000L
        private const val MAX_RECONNECT_DELAY_MS = 30_000L
        private const val RECONNECT_FACTOR = 2.0
        private const val HEARTBEAT_FAIL_THRESHOLD = 2
        private const val CONNECT_RETRY_INTERVAL_MS = 300L
        private const val CONNECT_MAX_RETRIES = 20
        private const val START_TIMEOUT_MS = 15_000L
        private const val KILL_SETTLE_DELAY_MS = 200L
        private const val EXECUTE_TIMEOUT_MS = 90_000L
        private const val MIN_START_INTERVAL_MS = 5_000L
    }

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val startMutex = Mutex()
    @Volatile private var heartbeatJob: Job? = null
    @Volatile private var socket: LocalSocket? = null
    @Volatile private var socketInput: BufferedInputStream? = null
    @Volatile private var socketOutput: BufferedOutputStream? = null
    @Volatile private var lastStartAttemptMs = 0L

    private val _state = MutableStateFlow(PrivilegedProcessState.STOPPED)
    public val state: StateFlow<PrivilegedProcessState> = _state
    private val _lastError = MutableStateFlow<String?>(null)
    public val lastError: StateFlow<String?> = _lastError

    public val isReady: Boolean get() = _state.value == PrivilegedProcessState.RUNNING

    /**
     * 仅连接已运行的 L2 特权进程（不启动新进程）。
     * Daemon 模式下由桌面端通过外部 ADB 启动 L2 服务器，
     * DaemonService 调此方法连接 LocalSocket。
     */
    public suspend fun connectToExistingServer(): Boolean = startMutex.withLock {
        withContext(Dispatchers.IO) {
            if (_state.value == PrivilegedProcessState.RUNNING) return@withContext true

            _state.value = PrivilegedProcessState.STARTING
            _lastError.value = null

            try {
                withTimeout(START_TIMEOUT_MS) {
                    connectWithRetry()
                }
                startHeartbeat()
                _state.value = PrivilegedProcessState.RUNNING
                reconnectAttempt.set(0)
                Log.i(TAG, "Connected to existing privileged process")
                true
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                Log.w(TAG, "Failed to connect to existing privileged process: ${e.message}")
                _lastError.value = e.message
                _state.value = PrivilegedProcessState.STOPPED
                false
            }
        }
    }

    public suspend fun start(): Boolean = startMutex.withLock {
        withContext(Dispatchers.IO) {
            if (_state.value == PrivilegedProcessState.RUNNING) return@withContext true

            // [INF-010] 不在入口重置 reconnectAttempt。原来的 set(0) 导致 scheduleReconnect→start()
            // 循环中计数器每轮归零，MAX_RECONNECT_ATTEMPTS 永远不会触发。
            // 计数器仅在成功启动后和 stop() 时归零。

            // 重启风暴防护：强制最小间隔
            val now = System.currentTimeMillis()
            val elapsed = now - lastStartAttemptMs
            if (elapsed in 1 until MIN_START_INTERVAL_MS) {
                val waitMs = MIN_START_INTERVAL_MS - elapsed
                Log.d(TAG, "Start throttled: waiting ${waitMs}ms to prevent restart storm")
                delay(waitMs)
            }
            lastStartAttemptMs = System.currentTimeMillis()

            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) {
                _lastError.value = "Requires Android 11+"
                _state.value = PrivilegedProcessState.ERROR
                return@withContext false
            }

            _state.value = PrivilegedProcessState.STARTING
            _lastError.value = null

            try {
                withTimeout(START_TIMEOUT_MS) {
                    killExistingProcess()
                    launchServerViaAdb()
                    connectWithRetry()
                }
                startHeartbeat()
                _state.value = PrivilegedProcessState.RUNNING
                reconnectAttempt.set(0)
                Log.i(TAG, "Privileged process started and connected")
                true
            } catch (e: TimeoutCancellationException) {
                Log.e(TAG, "Start timed out after ${START_TIMEOUT_MS}ms", e)
                _lastError.value = "Start timed out"
                _state.value = PrivilegedProcessState.ERROR
                false
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                Log.e(TAG, "Failed to start privileged process", e)
                _lastError.value = e.message
                _state.value = PrivilegedProcessState.ERROR
                false
            }
        }
    }

    private val executeMutex = Mutex()

    internal suspend fun execute(action: String, params: JsonObject = buildJsonObject {}): PrivilegedResult =
        withContext(Dispatchers.IO) {
            val request = buildJsonObject {
                put("action", action)
                put("params", params)
                put("id", System.nanoTime().toString())
            }

            try {
                executeMutex.withLock {
                    val sock = socket ?: return@withLock PrivilegedResult(
                        success = false,
                        error = "Not connected to privileged process",
                        errorCode = "PRIVILEGED_NOT_CONNECTED",
                    )
                    val input = socketInput ?: return@withLock PrivilegedResult(
                        success = false,
                        error = "Not connected to privileged process",
                        errorCode = "PRIVILEGED_NOT_CONNECTED",
                    )
                    val output = socketOutput ?: return@withLock PrivilegedResult(
                        success = false,
                        error = "Not connected to privileged process",
                        errorCode = "PRIVILEGED_NOT_CONNECTED",
                    )

                    // [TRP-018 / INF-005] 阻塞 Java IO 无法被协程取消打断。
                    // watchdog 在超时时关闭 socket 强制解除阻塞，防止 executeMutex 被长期持有。
                    // 这同时解决写操作无超时（INF-005）的问题。
                    val watchdog = scope.launch {
                        delay(EXECUTE_TIMEOUT_MS)
                        Log.w(TAG, "Execute watchdog timeout (${EXECUTE_TIMEOUT_MS}ms) for [$action], closing socket")
                        try { sock.close() } catch (_: Exception) {}
                    }

                    try {
                        FrameProtocol.writeFrame(
                            output,
                            FrameProtocol.TYPE_JSON,
                            request.toString().toByteArray(Charsets.UTF_8),
                        )

                        val responseFrame = FrameProtocol.readFrame(input)
                        // [TRP-009] 非 JSON 响应帧意味着流错位，必须断开重连
                        if (!responseFrame.isJson) {
                            throw IOException(
                                "Expected JSON response but got frame type 0x${responseFrame.type.toString(16)}, stream corrupted"
                            )
                        }

                        // [INF-023] JSON 解析失败单独捕获，返回 INVALID_RESPONSE 而不触发重连循环
                        val response = try {
                            Json.parseToJsonElement(
                                String(responseFrame.payload, Charsets.UTF_8)
                            ).jsonObject
                        } catch (e: Exception) {
                            Log.e(TAG, "Failed to parse response JSON from privileged process", e)
                            return@withLock PrivilegedResult(
                                success = false,
                                error = "Invalid response from privileged process: ${e.message}",
                                errorCode = "INVALID_RESPONSE",
                            )
                        }

                        val succeeded = response["success"].asBoolean()
                        val responseData = response["data"] as? JsonObject

                        var binaryData: ByteArray? = null
                        if (response["has_binary"].asBoolean()) {
                            val binaryFrame = FrameProtocol.readFrame(input)
                            // [INF-008 / TRP-030] 二进制帧类型不符时流已错位，必须断开重连
                            if (binaryFrame.isBinary) {
                                binaryData = binaryFrame.payload
                            } else {
                                Log.e(
                                    TAG,
                                    "Expected binary frame (0x02) but got 0x${binaryFrame.type.toString(16)}, stream corrupted"
                                )
                                throw IOException("Binary frame type mismatch — stream corrupted, must reconnect")
                            }
                        }

                        PrivilegedResult(
                            success = succeeded,
                            data = responseData,
                            binaryData = binaryData,
                            error = response["error"].asStringOrNull(),
                            errorCode = response["error_code"].asStringOrNull(),
                        )
                    } finally {
                        watchdog.cancel()
                    }
                }
            } catch (e: java.net.SocketTimeoutException) {
                Log.e(TAG, "Socket timeout during [$action]", e)
                _state.value = PrivilegedProcessState.ERROR
                _lastError.value = "Privileged process response timed out"
                scheduleReconnect()
                PrivilegedResult(
                    success = false,
                    error = "Privileged process response timed out",
                    errorCode = "PRIVILEGED_TIMEOUT",
                )
            } catch (e: IOException) {
                val diagnosis = when {
                    e is EOFException -> "Server process exited (EOF)"
                    e is FrameProtocol.FrameProtocolException -> "Protocol error: ${e.message}"
                    e.message?.contains("Connection reset") == true -> "Server process crashed (connection reset)"
                    e.message?.contains("Broken pipe") == true -> "Server process terminated (broken pipe)"
                    else -> "Communication error: ${e.message}"
                }
                Log.e(TAG, "IO error during [$action]: $diagnosis", e)
                _state.value = PrivilegedProcessState.ERROR
                _lastError.value = diagnosis
                scheduleReconnect()
                PrivilegedResult(
                    success = false,
                    error = diagnosis,
                    errorCode = "PRIVILEGED_IO_ERROR",
                )
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                Log.e(TAG, "Unexpected error during [$action]", e)
                PrivilegedResult(
                    success = false,
                    error = "Unexpected error: ${e.message}",
                    errorCode = "PRIVILEGED_INTERNAL_ERROR",
                )
            }
        }

    /**
     * 在 [startMutex] 内重置 [reconnectAttempt]：若 reconnectJob 正持有 startMutex
     * 等待 start()，stop() 会排队等其完成后再执行清理，确保重置不会与正在进行的
     * 重连竞争。
     */
    public suspend fun stop(): Unit = startMutex.withLock {
        reconnectJob?.cancel()
        reconnectJob = null
        reconnectAttempt.set(0)
        cleanupForReconnect()
        killExistingProcess()
    }

    /**
     * 有意不持有 [executeMutex]：允许并发的 execute() 因 IOException 立即降级失败，
     * 避免 cleanup 等待长达 SOCKET_TIMEOUT_MS 的读操作完成。Server 端通过 EOF 检测
     * 来清理对应连接资源。
     */
    private fun cleanupForReconnect() {
        heartbeatJob?.cancel()
        heartbeatJob = null
        socketInput = null
        socketOutput = null
        try { socket?.close() } catch (e: Exception) {
            Log.w(TAG, "Socket close failed during cleanup: ${e.message}")
        }
        socket = null
        _state.value = PrivilegedProcessState.STOPPED
    }

    private suspend fun killExistingProcess() {
        try {
            adbConnection.executeShellCommand("pkill -f tabtin_privileged")
            delay(KILL_SETTLE_DELAY_MS)
        } catch (e: Exception) {
            Log.d(TAG, "Kill existing process (best-effort): ${e.message}")
        }
    }

    private suspend fun connectWithRetry() {
        var lastException: Exception? = null
        for (attempt in 1..CONNECT_MAX_RETRIES) {
            try {
                connectToServer()
                return
            } catch (e: Exception) {
                lastException = e
                if (attempt < CONNECT_MAX_RETRIES) {
                    delay(CONNECT_RETRY_INTERVAL_MS)
                }
            }
        }
        throw lastException ?: IOException("Failed to connect to privileged process after $CONNECT_MAX_RETRIES retries")
    }

    private suspend fun launchServerViaAdb() {
        val apkPath = context.applicationInfo.sourceDir
        val nativeLibDir = context.applicationInfo.nativeLibraryDir

        val cmd = buildString {
            append("CLASSPATH=${shellEscape(apkPath)} ")
            append("app_process ")
            append("-Dtabtin.library.path=${shellEscape(nativeLibDir)} ")
            append("/system/bin ")
            append("--nice-name=tabtin_privileged ")
            append(SERVER_CLASS)
        }

        Log.d(TAG, "Launching privileged process: $cmd")
        val output = adbConnection.executeShellCommand("nohup $cmd > /dev/null 2>&1 &")
            ?: throw IOException("ADB disconnected — cannot launch privileged process")
        Log.d(TAG, "Launch output: $output")
    }

    private fun connectToServer() {
        val sock = LocalSocket()
        try {
            sock.connect(LocalSocketAddress(SOCKET_NAME, LocalSocketAddress.Namespace.ABSTRACT))
            sock.setSoTimeout(SOCKET_TIMEOUT_MS)

            // [INF-032] 用 Buffered 流包装，减少系统调用次数（与 Server 端对称）
            val bufferedIn = BufferedInputStream(sock.inputStream)
            val bufferedOut = BufferedOutputStream(sock.outputStream)

            val handshake = buildJsonObject {
                put("action", "handshake")
                put("version", 1)
                put("package", context.packageName)
            }
            // [TRP-015] 显式 UTF-8 编码，消除对平台默认 charset 的隐式依赖
            FrameProtocol.writeFrame(
                bufferedOut,
                FrameProtocol.TYPE_JSON,
                handshake.toString().toByteArray(Charsets.UTF_8),
            )

            val response = FrameProtocol.readFrame(bufferedIn)
            if (!response.isJson) {
                throw IOException("Bad handshake response: frame type 0x${response.type.toString(16)}")
            }

            val json = try {
                Json.parseToJsonElement(String(response.payload, Charsets.UTF_8)).jsonObject
            } catch (e: Exception) {
                throw IOException("Invalid handshake response JSON: ${e.message}")
            }
            if (!json["success"].asBoolean()) {
                throw IOException("Handshake rejected: ${json["error"].asStringOrNull()}")
            }

            socket = sock
            socketInput = bufferedIn
            socketOutput = bufferedOut
            Log.i(TAG, "Handshake successful with privileged process")
        } catch (e: Exception) {
            try { sock.close() } catch (ce: Exception) {
                Log.w(TAG, "Socket close failed during handshake error recovery: ${ce.message}")
            }
            throw e
        }
    }

    /**
     * [INF-007] 心跳检测跳过 executeMutex 被业务操作持有的情况——
     * 如果业务操作正在执行，说明 Server 仍然存活，无需额外心跳探测。
     * 这避免了截图等长操作（5~10s）期间心跳被阻塞导致误判超时。
     */
    private fun startHeartbeat() {
        heartbeatJob?.cancel()
        heartbeatJob = scope.launch {
            var consecutiveFailures = 0
            while (isActive) {
                delay(HEARTBEAT_INTERVAL_MS)
                if (executeMutex.isLocked) {
                    consecutiveFailures = 0
                    continue
                }
                try {
                    val result = execute("heartbeat")
                    if (result.success) {
                        consecutiveFailures = 0
                    } else {
                        consecutiveFailures++
                        if (consecutiveFailures >= HEARTBEAT_FAIL_THRESHOLD) {
                            Log.w(TAG, "Heartbeat failed $consecutiveFailures consecutive times, scheduling reconnect")
                            scheduleReconnect()
                            return@launch
                        }
                        Log.w(TAG, "Heartbeat failed ($consecutiveFailures/$HEARTBEAT_FAIL_THRESHOLD), will retry")
                    }
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Exception) {
                    consecutiveFailures++
                    if (consecutiveFailures >= HEARTBEAT_FAIL_THRESHOLD) {
                        Log.e(TAG, "Heartbeat error ($consecutiveFailures consecutive), scheduling reconnect", e)
                        scheduleReconnect()
                        return@launch
                    }
                    Log.w(TAG, "Heartbeat error ($consecutiveFailures/$HEARTBEAT_FAIL_THRESHOLD), will retry: ${e.message}")
                }
            }
        }
    }

    private val reconnectAttempt = AtomicInteger(0)
    @Volatile private var reconnectJob: Job? = null
    private val reconnectMutex = Mutex()

    private suspend fun scheduleReconnect() = reconnectMutex.withLock {
        if (_state.value == PrivilegedProcessState.STOPPED) {
            Log.d(TAG, "scheduleReconnect: state is STOPPED, skipping")
            return@withLock
        }
        if (reconnectJob?.isActive == true) {
            Log.d(TAG, "scheduleReconnect: already has active reconnect job, skipping")
            return@withLock
        }
        reconnectJob?.cancel()
        reconnectJob = scope.launch {
            cleanupForReconnect()

            if (!adbConnection.isConnected) {
                Log.w(TAG, "scheduleReconnect: ADB disconnected, deferring to L2AutoRecoveryManager")
                _state.value = PrivilegedProcessState.ERROR
                _lastError.value = "ADB disconnected"
                return@launch
            }

            val attempt = reconnectAttempt.incrementAndGet()
            if (attempt > MAX_RECONNECT_ATTEMPTS) {
                Log.e(TAG, "Max privileged process reconnect attempts ($MAX_RECONNECT_ATTEMPTS) reached, giving up")
                _state.value = PrivilegedProcessState.ERROR
                _lastError.value = "Max reconnect attempts exceeded"
                return@launch
            }
            val delayMs = min(
                (BASE_RECONNECT_DELAY_MS * RECONNECT_FACTOR.pow(attempt - 1.0)).toLong(),
                MAX_RECONNECT_DELAY_MS,
            )
            Log.i(TAG, "Scheduling privileged process reconnect in ${delayMs}ms (attempt $attempt/$MAX_RECONNECT_ATTEMPTS)")
            delay(delayMs)
            val ok = start()
            if (ok) reconnectAttempt.set(0)
        }
    }
}

internal data class PrivilegedResult(
    val success: Boolean,
    val data: JsonObject? = null,
    val binaryData: ByteArray? = null,
    val error: String? = null,
    val errorCode: String? = null,
) {
    override fun equals(other: Any?): Boolean {
        if (this === other) return true
        if (other !is PrivilegedResult) return false
        if (success != other.success || data != other.data || error != other.error || errorCode != other.errorCode) return false
        return when {
            binaryData == null && other.binaryData == null -> true
            binaryData != null && other.binaryData != null -> binaryData.contentEquals(other.binaryData)
            else -> false
        }
    }

    override fun hashCode(): Int {
        var result = success.hashCode()
        result = 31 * result + (data?.hashCode() ?: 0)
        result = 31 * result + (binaryData?.contentHashCode() ?: 0)
        result = 31 * result + (error?.hashCode() ?: 0)
        result = 31 * result + (errorCode?.hashCode() ?: 0)
        return result
    }
}
