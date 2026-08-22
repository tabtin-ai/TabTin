package com.tabtin.mobile.data.repository

import android.util.Log
import com.tabtin.mobile.data.api.ContextApi
import com.tabtin.mobile.data.model.DeviceHeartbeatRequest
import com.tabtin.mobile.data.model.DeviceOfflineRequest
import com.tabtin.mobile.data.model.DeviceRegisterRequest
import com.tabtin.mobile.util.DeviceRuntimeDescriptor
import com.tabtin.mobile.util.TokenManager
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import javax.inject.Inject
import javax.inject.Singleton

@Singleton
public class DeviceRuntimeRepository @Inject constructor(
    private val contextApi: ContextApi,
    private val tokenManager: TokenManager,
    private val deviceRuntimeDescriptor: DeviceRuntimeDescriptor,
) {
    public companion object {
        private const val TAG = "DeviceRuntimeRepo"
        private const val HEARTBEAT_INTERVAL_MS = 60_000L
    }

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private var heartbeatJob: Job? = null

    public suspend fun ensureSelectedOrganizationDeviceRegistered(
        organizationIdOverride: String? = tokenManager.organizationId,
    ): Boolean {
        val organizationId = organizationIdOverride
        if (!tokenManager.isLoggedIn || organizationId.isNullOrBlank()) return false

        return try {
            val response = contextApi.registerDevice(buildRegisterRequest(organizationId))
            if (!response.success) {
                Log.w(TAG, "Device registration rejected: ${response.message}")
                false
            } else {
                startHeartbeat()
                Log.i(TAG, "Device registered for organization $organizationId")
                true
            }
        } catch (t: Throwable) {
            Log.w(TAG, "Device registration failed: ${t.message}")
            false
        }
    }

    public fun syncSelectedOrganizationDevice() {
        scope.launch {
            ensureSelectedOrganizationDeviceRegistered()
        }
    }

    /** 组织权限撤销后先停掉旧组织心跳，避免在等待用户选择默认组织期间继续发旧上下文请求。 */
    public fun stopHeartbeatForOrganizationAccessRevoked() {
        stopHeartbeat()
    }

    public fun reportOffline(tokenOverride: String? = tokenManager.accessToken) {
        stopHeartbeat()
        if (tokenOverride.isNullOrBlank()) return

        scope.launch {
            try {
                val response = contextApi.reportDeviceOffline(
                    DeviceOfflineRequest(
                        fingerprint = tokenManager.deviceId,
                        token = tokenOverride,
                    ),
                )
                if (!response.success) {
                    Log.w(TAG, "Device offline rejected: ${response.message}")
                    return@launch
                }
                Log.i(TAG, "Device offline reported")
            } catch (t: Throwable) {
                Log.w(TAG, "Device offline report failed: ${t.message}")
            }
        }
    }

    private fun startHeartbeat() {
        heartbeatJob?.cancel()
        heartbeatJob = scope.launch {
            while (isActive) {
                delay(HEARTBEAT_INTERVAL_MS)
                sendHeartbeat()
            }
        }
    }

    private suspend fun sendHeartbeat() {
        if (!tokenManager.isLoggedIn) return

        try {
            val response = contextApi.heartbeatDevice(
                DeviceHeartbeatRequest(
                    fingerprint = tokenManager.deviceId,
                    capabilities = deviceRuntimeDescriptor.capabilities(),
                    systemInfo = deviceRuntimeDescriptor.heartbeatSystemInfo(),
                ),
            )
            if (!response.success) {
                Log.w(TAG, "Device heartbeat rejected: ${response.message}")
            }
        } catch (t: Throwable) {
            Log.w(TAG, "Device heartbeat failed: ${t.message}")
        }
    }

    private fun stopHeartbeat() {
        heartbeatJob?.cancel()
        heartbeatJob = null
    }

    private fun buildRegisterRequest(organizationId: String): DeviceRegisterRequest =
        DeviceRegisterRequest(
            organizationId = organizationId,
            fingerprint = tokenManager.deviceId,
            name = deviceRuntimeDescriptor.deviceName(),
            osInfo = deviceRuntimeDescriptor.osInfo(),
            capabilities = deviceRuntimeDescriptor.capabilities(),
        )
}
