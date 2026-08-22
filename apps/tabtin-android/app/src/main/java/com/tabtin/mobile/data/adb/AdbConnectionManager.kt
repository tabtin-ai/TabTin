package com.tabtin.mobile.data.adb

import android.os.Build
import android.util.Log
import androidx.annotation.RequiresApi
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import java.net.InetSocketAddress
import java.net.Socket
import javax.inject.Inject
import javax.inject.Singleton

public enum class AdbConnectionState {
    DISCONNECTED,
    PAIRING,
    DISCOVERING,
    CONNECTING,
    AWAITING_APPROVAL,
    CONNECTED,
    ERROR,
}

public enum class AdbErrorCode {
    SERVICE_NOT_FOUND,
    INVALID_PAIRING_CODE,
    PAIRING_CODE_EXPIRED,
    PAIRING_FAILED,
    PAIRING_UNSUPPORTED,
    CONNECTION_FAILED,
    SHELL_COMMAND_FAILED,
}

public sealed class ReconnectOutcome {
    public data object Connected : ReconnectOutcome()
    public data object AlreadyConnected : ReconnectOutcome()
    public data object Unsupported : ReconnectOutcome()
    public data object NeverPaired : ReconnectOutcome()
    public data object ServiceNotFound : ReconnectOutcome()
    public data class ConnectionFailed(val message: String?) : ReconnectOutcome()

    public val isConnected: Boolean get() = this is Connected || this is AlreadyConnected
}

@Singleton
public class AdbConnectionManager @Inject constructor(
    private val keyManager: AdbKeyManager,
    private val mdns: AdbMdns,
) {
    public companion object {
        private const val TAG = "AdbConnManager"
        private const val SHELL_COMMAND_TIMEOUT_MS = 35_000L
        private const val MDNS_TIMEOUT_MS = 12_000L
        private const val MDNS_SAFETY_MARGIN_MS = 2_000L
        private const val PAIRING_OVERALL_TIMEOUT_MS = 55_000L
        private const val PORT_PROBE_TIMEOUT_MS = 150
        private const val PORT_SCAN_TOTAL_TIMEOUT_MS = 15_000L
        private const val PORT_SCAN_BATCH_SIZE = 150
        private val FALLBACK_PORT_RANGE = 37000..44000
        private const val FALLBACK_WELL_KNOWN_PORT = 5555
        private const val HEARTBEAT_INTERVAL_MS = 20_000L
        private const val HEARTBEAT_TIMEOUT_MS = 10_000L
        private const val LOCALHOST = "127.0.0.1"
    }

    private val _state = MutableStateFlow(AdbConnectionState.DISCONNECTED)
    public val state: StateFlow<AdbConnectionState> = _state

    private val connectMutex = Mutex()
    private val shellMutex = Mutex()
    @Volatile private var currentClient: AdbClient? = null
    private val _lastError = MutableStateFlow<String?>(null)
    public val lastError: StateFlow<String?> = _lastError
    @Volatile private var lastErrorCode: AdbErrorCode? = null

    private val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())
    private var heartbeatJob: Job? = null

    public val isConnected: Boolean get() = _state.value == AdbConnectionState.CONNECTED

    @RequiresApi(Build.VERSION_CODES.R)
    public suspend fun pair(pairingCode: String, hintPort: Int? = null): Boolean = connectMutex.withLock {
        withContext(Dispatchers.IO) {
            _state.value = AdbConnectionState.PAIRING
            clearError()

            val result = withTimeoutOrNull(PAIRING_OVERALL_TIMEOUT_MS) {
                doPair(pairingCode, hintPort)
            }
            if (result == null) {
                setError("Pairing code may have expired (>55s). Please generate a new code and retry", AdbErrorCode.PAIRING_CODE_EXPIRED)
                _state.value = AdbConnectionState.ERROR
                return@withContext false
            }
            result
        }
    }

    @RequiresApi(Build.VERSION_CODES.R)
    private suspend fun doPair(pairingCode: String, hintPort: Int?): Boolean {
        val port = discoverService(AdbMdns.TLS_PAIRING) ?: hintPort
        if (port == null) {
            setError("Could not discover ADB pairing service. Is Wireless Debugging enabled?", AdbErrorCode.SERVICE_NOT_FOUND)
            _state.value = AdbConnectionState.ERROR
            return false
        }

        try {
            AdbPairingClient(LOCALHOST, port, pairingCode, keyManager).use { client ->
                val success = client.start()
                if (!success) {
                    setError("Pairing failed", AdbErrorCode.PAIRING_FAILED)
                    _state.value = AdbConnectionState.ERROR
                    return false
                }
            }
            Log.i(TAG, "Pairing succeeded")
            _state.value = AdbConnectionState.DISCONNECTED
            return true
        } catch (e: AdbInvalidPairingCodeException) {
            setError("Invalid pairing code", AdbErrorCode.INVALID_PAIRING_CODE)
            _state.value = AdbConnectionState.ERROR
            return false
        } catch (e: AdbPairingUnsupportedException) {
            Log.e(TAG, "Pairing unsupported on this device", e)
            setError("Pairing not supported on this device: ${e.message}", AdbErrorCode.PAIRING_UNSUPPORTED)
            _state.value = AdbConnectionState.ERROR
            return false
        } catch (e: Exception) {
            Log.e(TAG, "Pairing failed", e)
            setError("Pairing failed: ${e.message}", AdbErrorCode.PAIRING_FAILED)
            _state.value = AdbConnectionState.ERROR
            return false
        }
    }

    @RequiresApi(Build.VERSION_CODES.R)
    public suspend fun connect(): Boolean = connectMutex.withLock {
        withContext(Dispatchers.IO) {
            if (_state.value == AdbConnectionState.CONNECTED) return@withContext true
            _state.value = AdbConnectionState.DISCOVERING
            clearError()

            val port = discoverService(AdbMdns.TLS_CONNECT)
            if (port == null) {
                setError("Could not discover ADB connect service", AdbErrorCode.SERVICE_NOT_FOUND)
                _state.value = AdbConnectionState.ERROR
                return@withContext false
            }

            _state.value = AdbConnectionState.CONNECTING
            val client = AdbClient(LOCALHOST, port, keyManager)
            try {
                client.connect {
                    _state.value = AdbConnectionState.AWAITING_APPROVAL
                }
                currentClient = client
                _state.value = AdbConnectionState.CONNECTED
                startHeartbeat()
                Log.i(TAG, "ADB connected on port $port")
                true
            } catch (e: Exception) {
                runCatching { client.close() }
                Log.e(TAG, "Connection failed", e)
                setError("Connection failed: ${e.message}", AdbErrorCode.CONNECTION_FAILED)
                _state.value = AdbConnectionState.ERROR
                false
            }
        }
    }

    public suspend fun executeShellCommand(command: String): String? = withContext(Dispatchers.IO) {
        val client = currentClient ?: run {
            Log.e(TAG, "Not connected")
            return@withContext null
        }
        withTimeoutOrNull(SHELL_COMMAND_TIMEOUT_MS) {
            shellMutex.withLock {
                val output = StringBuilder()
                try {
                    client.shellCommand(command) { data ->
                        output.append(String(data))
                    }
                    output.toString()
                } catch (e: Exception) {
                    if (_state.value == AdbConnectionState.DISCONNECTED) {
                        Log.d(TAG, "Shell command interrupted by disconnect: $command")
                    } else {
                        Log.e(TAG, "Shell command failed: $command", e)
                        setError("Shell command failed: ${e.message}", AdbErrorCode.SHELL_COMMAND_FAILED)
                        _state.value = AdbConnectionState.ERROR
                    }
                    null
                }
            }
        } ?: run {
            Log.e(TAG, "Shell command timed out after ${SHELL_COMMAND_TIMEOUT_MS}ms: $command")
            null
        }
    }

    public val hasPreviouslyPaired: Boolean get() = keyManager.hasPreviouslyPaired

    public suspend fun tryAutoReconnect(): ReconnectOutcome {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return ReconnectOutcome.Unsupported
        if (!keyManager.hasPreviouslyPaired) return ReconnectOutcome.NeverPaired
        if (_state.value == AdbConnectionState.CONNECTED) return ReconnectOutcome.AlreadyConnected
        Log.i(TAG, "Attempting auto-reconnect (previously paired)")
        val success = connect()
        return if (success) {
            ReconnectOutcome.Connected
        } else {
            if (lastErrorCode == AdbErrorCode.SERVICE_NOT_FOUND) {
                ReconnectOutcome.ServiceNotFound
            } else {
                ReconnectOutcome.ConnectionFailed(_lastError.value)
            }
        }
    }

    public suspend fun disconnect(): Unit = connectMutex.withLock {
        stopHeartbeat()
        shellMutex.withLock {
            _state.value = AdbConnectionState.DISCONNECTED
            runCatching { currentClient?.close() }
            currentClient = null
        }
        clearError()
    }

    private fun startHeartbeat() {
        stopHeartbeat()
        heartbeatJob = scope.launch {
            delay(HEARTBEAT_INTERVAL_MS)
            while (isActive && _state.value == AdbConnectionState.CONNECTED) {
                val alive = try {
                    if (!shellMutex.tryLock()) {
                        // Mutex held → a command is actively running → connection is alive
                        true
                    } else {
                        try {
                            withTimeoutOrNull(HEARTBEAT_TIMEOUT_MS) {
                                val client = currentClient ?: return@withTimeoutOrNull false
                                client.shellCommand("echo __hb__") {}
                                true
                            } ?: false
                        } finally {
                            shellMutex.unlock()
                        }
                    }
                } catch (_: Exception) {
                    false
                }
                if (!alive) {
                    if (_state.value == AdbConnectionState.CONNECTED) {
                        Log.w(TAG, "Heartbeat failed — connection lost")
                        _state.value = AdbConnectionState.DISCONNECTED
                        runCatching { currentClient?.close() }
                        currentClient = null
                    }
                    break
                }
                delay(HEARTBEAT_INTERVAL_MS)
            }
        }
    }

    private fun stopHeartbeat() {
        heartbeatJob?.cancel()
        heartbeatJob = null
    }

    private fun setError(message: String, code: AdbErrorCode) {
        _lastError.value = message
        lastErrorCode = code
    }

    private fun clearError() {
        _lastError.value = null
        lastErrorCode = null
    }

    @RequiresApi(Build.VERSION_CODES.R)
    private suspend fun discoverService(serviceType: String): Int? {
        val mdnsPort = withTimeoutOrNull(MDNS_TIMEOUT_MS) {
            mdns.discoverOnce(serviceType, timeout = maxOf(MDNS_TIMEOUT_MS - MDNS_SAFETY_MARGIN_MS, 1_000))
        }
        if (mdnsPort != null) return mdnsPort

        if (serviceType == AdbMdns.TLS_CONNECT) {
            Log.i(TAG, "mDNS discovery failed, trying port scan fallback")
            return scanForAdbPort()
        }
        return null
    }

    private suspend fun scanForAdbPort(): Int? = withContext(Dispatchers.IO) {
        withTimeoutOrNull(PORT_SCAN_TOTAL_TIMEOUT_MS) {
            if (probePort(FALLBACK_WELL_KNOWN_PORT)) {
                Log.i(TAG, "ADB found on well-known port $FALLBACK_WELL_KNOWN_PORT")
                return@withTimeoutOrNull FALLBACK_WELL_KNOWN_PORT
            }

            for (batch in FALLBACK_PORT_RANGE.chunked(PORT_SCAN_BATCH_SIZE)) {
                ensureActive()
                val found = coroutineScope {
                    batch.map { port ->
                        async { port.takeIf { probePort(it) } }
                    }.awaitAll()
                }.filterNotNull().firstOrNull()
                if (found != null) {
                    Log.i(TAG, "ADB found via port scan on port $found")
                    return@withTimeoutOrNull found
                }
            }
            Log.w(TAG, "Port scan fallback found no ADB service")
            null
        } ?: run {
            Log.w(TAG, "Port scan fallback timed out after ${PORT_SCAN_TOTAL_TIMEOUT_MS}ms")
            null
        }
    }

    private fun probePort(port: Int): Boolean = try {
        Socket().use { sock ->
            sock.connect(InetSocketAddress(LOCALHOST, port), PORT_PROBE_TIMEOUT_MS)
            true
        }
    } catch (_: Exception) {
        false
    }
}
