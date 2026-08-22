package com.tabtin.mobile.data.privileged

import android.util.Log
import com.tabtin.mobile.data.adb.AdbConnectionManager
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import javax.inject.Inject
import javax.inject.Singleton

public enum class AutomationLevel {
    /** All L2 capabilities available. */
    FULL,
    /** ADB connected but privileged process not running. */
    DEGRADED,
    /** No ADB connection. */
    UNAVAILABLE,
}

/**
 * Monitors the health of the L2 automation subsystem and exposes the
 * current [automationLevel].
 *
 * This class is a **pure status observer** — it does NOT perform recovery
 * itself. When degradation is detected, it invokes [onDegradedDetected]
 * so that [L2AutoRecoveryManager] (the single recovery entry-point) can
 * handle restart / reconnect logic, avoiding duplicate recovery attempts.
 */
@Singleton
public class ServiceHealthMonitor @Inject constructor(
    private val adbConnection: AdbConnectionManager,
    private val privilegedProcessManager: PrivilegedProcessManager,
) {
    public companion object {
        private const val TAG = "ServiceHealthMonitor"
        private const val MONITOR_INTERVAL_MS = 15_000L
    }

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    @Volatile private var monitorJob: Job? = null
    @Volatile private var stateObserverJob: Job? = null

    private val _automationLevel = MutableStateFlow(AutomationLevel.UNAVAILABLE)
    public val automationLevel: StateFlow<AutomationLevel> = _automationLevel

    /**
     * Called when the monitor detects a transition **to** [AutomationLevel.DEGRADED].
     * Set by [WebSocketService] to delegate recovery to [L2AutoRecoveryManager].
     */
    public var onDegradedDetected: (() -> Unit)? = null

    /**
     * Called on every automation level transition (not just DEGRADED).
     * Consumers that need to react to ALL level changes should register here.
     */
    public var onLevelChanged: ((old: AutomationLevel, new: AutomationLevel) -> Unit)? = null

    public fun startMonitoring() {
        if (monitorJob?.isActive == true) return
        checkHealth()
        monitorJob = scope.launch {
            Log.i(TAG, "Health monitoring started")
            while (isActive) {
                delay(MONITOR_INTERVAL_MS)
                checkHealth()
            }
        }
        if (stateObserverJob?.isActive != true) {
            stateObserverJob = scope.launch {
                launch { privilegedProcessManager.state.collect { checkHealth() } }
                launch { adbConnection.state.collect { checkHealth() } }
            }
        }
    }

    public fun stopMonitoring() {
        monitorJob?.cancel()
        monitorJob = null
        stateObserverJob?.cancel()
        stateObserverJob = null
    }

    /** Immediately evaluate and update the automation level. */
    public fun evaluateNow() {
        scope.launch { checkHealth() }
    }

    @Synchronized
    private fun checkHealth() {
        val adbConnected = adbConnection.isConnected
        val privilegedReady = privilegedProcessManager.isReady

        val newLevel = when {
            adbConnected && privilegedReady -> AutomationLevel.FULL
            adbConnected -> AutomationLevel.DEGRADED
            else -> AutomationLevel.UNAVAILABLE
        }

        val oldLevel = _automationLevel.value
        if (newLevel != oldLevel) {
            _automationLevel.value = newLevel
            Log.i(TAG, "Automation level changed: $oldLevel -> $newLevel")

            onLevelChanged?.invoke(oldLevel, newLevel)

            if (newLevel == AutomationLevel.DEGRADED || newLevel == AutomationLevel.UNAVAILABLE) {
                onDegradedDetected?.invoke()
            }
        }
    }
}
