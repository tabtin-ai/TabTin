package com.tabtin.mobile.data.websocket

import android.util.Log
import com.tabtin.mobile.data.model.WSEnvelope
import com.tabtin.mobile.util.DeviceRuntimeDescriptor
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/**
 * Manages device capability reporting over the WebSocket channel,
 * including debounced change notifications and server-initiated
 * refresh requests.
 *
 * Extracted from [WebSocketService] to isolate capability reporting logic.
 */
public class CapabilityReporter(
    private val deviceRuntimeDescriptor: DeviceRuntimeDescriptor,
    private val scope: CoroutineScope,
    private val deviceId: () -> String,
    private val organizationId: () -> String?,
    private val isConnected: () -> Boolean,
    private val sendEnvelope: (WSEnvelope) -> Unit,
) {
    public companion object {
        private const val TAG = "CapabilityReporter"
        private const val DEBOUNCE_MS = 500L
        private const val WS_ROLE_DEVICE_RUNTIME = "device_runtime"
    }

    private var reportJob: Job? = null

    public fun reportChanged() {
        scope.launch {
            if (!isConnected()) return@launch
            reportJob?.cancel()
            reportJob = launch {
                delay(DEBOUNCE_MS)
                if (isConnected()) sendReport()
            }
        }
    }

    public fun sendReport(status: String = "online") {
        val wsId = organizationId() ?: return
        val payload = buildJsonObject {
            put("status", status)
            put(
                "capabilities",
                buildJsonArray {
                    deviceRuntimeDescriptor.capabilities().forEach { add(JsonPrimitive(it)) }
                },
            )
            put("system_info", deviceRuntimeDescriptor.heartbeatSystemInfo())
        }
        sendEnvelope(WSEnvelope.build("device.capabilities.report", deviceId(), payload, wsId, role = WS_ROLE_DEVICE_RUNTIME))
    }

    public fun handleRefreshRequest(envelope: WSEnvelope) {
        val refreshRequestId = envelope.payloadString("refresh_request_id") ?: envelope.requestId
        try {
            sendAck(refreshRequestId)
            sendReport()
            sendResult(refreshRequestId, "accepted")
        } catch (e: Exception) {
            Log.w(TAG, "Capability refresh request failed: ${e.message}")
            runCatching { sendResult(refreshRequestId, "failed", e.message) }
        }
    }

    public fun cancelAll() {
        reportJob?.cancel()
        reportJob = null
    }

    private fun sendAck(refreshRequestId: String) {
        val wsId = organizationId() ?: return
        val payload = buildJsonObject {
            put("refresh_request_id", refreshRequestId)
            put("status", "accepted")
        }
        sendEnvelope(WSEnvelope.build("device.capabilities.refresh.ack", deviceId(), payload, wsId, role = WS_ROLE_DEVICE_RUNTIME))
    }

    private fun sendResult(refreshRequestId: String, status: String, error: String? = null) {
        val wsId = organizationId() ?: return
        val payload = buildJsonObject {
            put("refresh_request_id", refreshRequestId)
            put("status", status)
            put("reported_at", java.time.Instant.now().toString())
            error?.let { put("error", it) }
        }
        sendEnvelope(WSEnvelope.build("device.capabilities.refresh.result", deviceId(), payload, wsId, role = WS_ROLE_DEVICE_RUNTIME))
    }
}
