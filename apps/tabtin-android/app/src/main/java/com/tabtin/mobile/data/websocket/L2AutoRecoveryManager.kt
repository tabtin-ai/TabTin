package com.tabtin.mobile.data.websocket

import android.os.SystemClock
import android.util.Log
import com.tabtin.mobile.data.adb.AdbConnectionManager
import com.tabtin.mobile.data.adb.ReconnectOutcome
import com.tabtin.mobile.data.privileged.PrivilegedProcessManager
import com.tabtin.mobile.data.privileged.PrivilegedProcessState
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

/**
 * Manages automatic L2 (ADB + Privileged Process) recovery when the
 * WebSocket connection is established but the privileged process is
 * not running.
 *
 * Extracted from [WebSocketService] to reduce its responsibility scope.
 */
public class L2AutoRecoveryManager(
    private val adbConnectionManager: dagger.Lazy<AdbConnectionManager>,
    private val privilegedProcessManager: dagger.Lazy<PrivilegedProcessManager>,
    private val scope: CoroutineScope,
    private val onCapabilitiesChanged: () -> Unit,
) {
    public companion object {
        private const val TAG = "L2AutoRecovery"
        private const val MAX_AUTO_RECOVER_ATTEMPTS = 2
        private const val AUTO_RECOVER_COOLDOWN_MS = 30_000L
        private const val AUTO_RECOVER_RETRY_DELAY_MS = 5_000L
        private const val SUCCESS_DISPLAY_DURATION_MS = 3_000L
        public const val RECOVER_REASON_WIRELESS_NOT_ENABLED: String = "wireless_not_enabled"
        public const val RECOVER_REASON_MAX_ATTEMPTS: String = "max_attempts_exhausted"
    }

    private val _autoRecoverState = MutableStateFlow<AutoRecoverState>(AutoRecoverState.Idle)
    public val autoRecoverState: StateFlow<AutoRecoverState> = _autoRecoverState.asStateFlow()

    @Volatile
    private var lastAutoRecoverAttemptMs = 0L
    private var autoRecoverJob: Job? = null
    private var privilegedObserverJob: Job? = null

    public fun tryAutoRecover() {
        if (privilegedProcessManager.get().isReady) return
        if (!adbConnectionManager.get().hasPreviouslyPaired) return

        val now = SystemClock.elapsedRealtime()
        if (now - lastAutoRecoverAttemptMs < AUTO_RECOVER_COOLDOWN_MS) {
            Log.d(TAG, "L2 auto-recovery skipped: cooldown period active")
            return
        }
        lastAutoRecoverAttemptMs = now

        autoRecoverJob?.cancel()
        _autoRecoverState.value = AutoRecoverState.Recovering(1, MAX_AUTO_RECOVER_ATTEMPTS)
        autoRecoverJob = scope.launch(Dispatchers.IO) {
            for (attempt in 1..MAX_AUTO_RECOVER_ATTEMPTS) {
                _autoRecoverState.value = AutoRecoverState.Recovering(attempt, MAX_AUTO_RECOVER_ATTEMPTS)
                try {
                    val outcome = adbConnectionManager.get().tryAutoReconnect()
                    when (outcome) {
                        is ReconnectOutcome.ServiceNotFound -> {
                            Log.w(TAG, "Attempt $attempt: wireless debugging not enabled, aborting")
                            _autoRecoverState.value = AutoRecoverState.Failed(RECOVER_REASON_WIRELESS_NOT_ENABLED)
                            return@launch
                        }
                        is ReconnectOutcome.NeverPaired,
                        is ReconnectOutcome.Unsupported -> {
                            Log.d(TAG, "Preconditions not met ($outcome)")
                            _autoRecoverState.value = AutoRecoverState.Idle
                            return@launch
                        }
                        else -> {}
                    }
                    if (outcome.isConnected) {
                        val started = privilegedProcessManager.get().start()
                        Log.i(TAG, "Attempt $attempt: ADB reconnected, privileged process started=$started")
                        if (started) {
                            _autoRecoverState.value = AutoRecoverState.Succeeded
                            delay(SUCCESS_DISPLAY_DURATION_MS)
                            _autoRecoverState.value = AutoRecoverState.Idle
                            return@launch
                        }
                    } else {
                        Log.w(TAG, "Attempt $attempt: ADB connect failed ($outcome)")
                    }
                } catch (e: Exception) {
                    Log.w(TAG, "Attempt $attempt failed: ${e.message}")
                }
                if (attempt < MAX_AUTO_RECOVER_ATTEMPTS) {
                    delay(AUTO_RECOVER_RETRY_DELAY_MS * attempt)
                }
            }
            Log.w(TAG, "All $MAX_AUTO_RECOVER_ATTEMPTS attempts exhausted")
            _autoRecoverState.value = AutoRecoverState.Failed(RECOVER_REASON_MAX_ATTEMPTS)
        }
    }

    public fun observeAndReportStateChanges() {
        privilegedObserverJob?.cancel()
        privilegedObserverJob = scope.launch {
            var previousReady: Boolean? = null
            privilegedProcessManager.get().state.collect { state ->
                val nowReady = (state == PrivilegedProcessState.RUNNING)
                if (previousReady != null && previousReady != nowReady) {
                    Log.i(TAG, "Privileged process state changed: ready=$nowReady, re-reporting capabilities")
                    onCapabilitiesChanged()
                }
                previousReady = nowReady
            }
        }
    }

    public fun cancelAll() {
        autoRecoverJob?.cancel()
        autoRecoverJob = null
        privilegedObserverJob?.cancel()
        privilegedObserverJob = null
    }

    public fun resetState() {
        cancelAll()
        lastAutoRecoverAttemptMs = 0L
        _autoRecoverState.value = AutoRecoverState.Idle
    }
}
