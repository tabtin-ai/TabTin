package com.tabtin.mobile.data.websocket

import android.util.Log
import com.tabtin.mobile.data.repository.SpaceRepository
import com.tabtin.mobile.data.repository.OrganizationRepository
import com.tabtin.mobile.data.repository.DeviceRuntimeRepository
import com.tabtin.mobile.util.TokenManager
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.drop
import kotlinx.coroutines.flow.filter
import kotlinx.coroutines.launch
import java.util.concurrent.atomic.AtomicBoolean
import javax.inject.Inject
import javax.inject.Singleton

/**
 * WS 认证成功后的业务数据对账。
 * 参考 Electron useConnectionRecovery：重连后刷新 organizations/spaces/devices。
 */
@Singleton
public class ConnectionRecoveryManager @Inject constructor(
    private val webSocketService: WebSocketService,
    private val organizationRepository: OrganizationRepository,
    private val spaceRepository: dagger.Lazy<SpaceRepository>,
    private val deviceRuntimeRepository: DeviceRuntimeRepository,
    private val tokenManager: TokenManager,
) {
    public companion object {
        private const val TAG = "ConnectionRecovery"
        private val RETRY_DELAYS_MS = longArrayOf(2_000, 5_000, 10_000)
    }

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private val recoveryInFlight = AtomicBoolean(false)

    public fun initialize() {
        scope.launch {
            var previousState: WSConnectionState = WSConnectionState.Disconnected
            webSocketService.connectionState
                .drop(1)
                .collect { currentState ->
                    val prev = previousState
                    previousState = currentState

                    if (currentState != WSConnectionState.Connected) return@collect
                    if (prev == WSConnectionState.Connected || prev == WSConnectionState.Disconnected) return@collect

                    val organizationId = tokenManager.organizationId
                    if (organizationId.isNullOrBlank()) return@collect
                    if (!recoveryInFlight.compareAndSet(false, true)) return@collect

                    Log.i(TAG, "WS recovered ($prev → connected), starting recovery")
                    try {
                        executeRecovery(organizationId)
                    } finally {
                        recoveryInFlight.set(false)
                    }
                }
        }
    }

    private suspend fun executeRecovery(organizationId: String) {
        data class RecoveryTask(val name: String, val action: suspend () -> Unit)

        val tasks = listOf(
            RecoveryTask("organizations") { organizationRepository.loadOrganizations() },
            RecoveryTask("device") { deviceRuntimeRepository.ensureSelectedOrganizationDeviceRegistered(organizationId) },
        )

        val failed = mutableListOf<RecoveryTask>()
        for (task in tasks) {
            try {
                task.action()
            } catch (e: Exception) {
                Log.w(TAG, "${task.name} failed: ${e.message}")
                failed.add(task)
            }
        }

        if (failed.isEmpty()) {
            Log.i(TAG, "All recovery tasks succeeded")
            return
        }

        for (retryDelay in RETRY_DELAYS_MS) {
            if (webSocketService.connectionState.value != WSConnectionState.Connected) {
                Log.w(TAG, "WS disconnected during retry, aborting")
                return
            }

            kotlinx.coroutines.delay(retryDelay)

            val stillFailed = mutableListOf<RecoveryTask>()
            for (task in failed) {
                try {
                    task.action()
                } catch (e: Exception) {
                    Log.w(TAG, "${task.name} retry failed: ${e.message}")
                    stillFailed.add(task)
                }
            }

            if (stillFailed.isEmpty()) {
                Log.i(TAG, "All recovery tasks succeeded after retry")
                return
            }
            failed.clear()
            failed.addAll(stillFailed)
        }

        Log.e(TAG, "Recovery tasks still failed after all retries: ${failed.map { it.name }}")
    }
}
