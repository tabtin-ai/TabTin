package com.tabtin.mobile.data.automation

import android.util.Log
import com.tabtin.mobile.data.privileged.PrivilegedProcessManager
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import javax.inject.Inject
import javax.inject.Singleton

@Singleton
public class ActionRouter @Inject constructor(
    handlers: Set<@JvmSuppressWildcards ActionHandler>,
    private val privilegedProcessManager: PrivilegedProcessManager,
    /**
     * Eagerly constructs the default device-action confirm dialog so it can
     * self-register into [DeviceSecurityConfirm] before the first WS action.
     */
    @Suppress("UNUSED_PARAMETER")
    securityConfirmBootstrap: AndroidSecurityConfirmCallback,
) {
    public companion object {
        private const val TAG = "ActionRouter"
    }

    private val registry: Map<String, ActionHandler>

    init {
        val duplicates = handlers.groupBy { it.actionName }.filter { it.value.size > 1 }
        require(duplicates.isEmpty()) {
            "Duplicate ActionHandler actionNames detected: ${duplicates.keys}"
        }
        registry = handlers.associateBy { it.actionName }
        Log.i(TAG, "Registered ${registry.size} action handlers: ${registry.keys}")
    }

    /**
     * Invoked when a pre-flight or post-execution check reveals that the
     * device's actual capabilities differ from what was last reported.
     * Wire to [CapabilityReporter.reportChanged] for immediate re-report.
     */
    public var onCapabilitiesStale: (() -> Unit)? = null

    public val supportedActions: Set<String> get() = registry.keys

    private fun isPermissionError(errorCode: String?): Boolean =
        errorCode == "PERMISSION_NOT_GRANTED" || errorCode == "PERMISSION_DENIED"

    public fun getTimeoutMs(action: String): Long =
        registry[action]?.timeoutMs ?: 30_000L

    private fun requiresPrivilegedProcess(action: String): Boolean =
        action.startsWith("screen_") ||
            action == "set_system_setting" ||
            action == "get_system_setting" ||
            action == "set_stealth_mode" ||
            action == "launch_with_intent" ||
            action == "save_to_device"

    public suspend fun execute(
        action: String,
        params: JsonObject = buildJsonObject {},
    ): DeviceActionResult {
        val handler = registry[action]
        if (handler == null) {
            Log.w(TAG, "No handler for action: $action (registered: ${registry.keys})")
            return DeviceActionResult(
                success = false,
                error = "Unsupported Android device action: $action",
                errorCode = "ACTION_NOT_FOUND",
            )
        }

        if (requiresPrivilegedProcess(action) && !privilegedProcessManager.isReady) {
            Log.w(TAG, "L2 pre-flight failed for '$action': privileged process not ready")
            onCapabilitiesStale?.invoke()
            return DeviceActionResult(
                success = false,
                error = "Privileged process not connected — L2 action '$action' unavailable",
                errorCode = "PRIVILEGED_NOT_CONNECTED",
            )
        }

        return try {
            val result = handler.execute(params)
            if (!result.success && isPermissionError(result.errorCode)) {
                Log.i(TAG, "Permission revocation detected during '$action', signalling capabilities stale")
                onCapabilitiesStale?.invoke()
            }
            result
        } catch (e: SecurityException) {
            Log.w(TAG, "SecurityException during '$action', signalling capabilities stale", e)
            onCapabilitiesStale?.invoke()
            DeviceActionResult(
                success = false,
                error = "Permission revoked during $action: ${e.message}",
                errorCode = "PERMISSION_DENIED",
            )
        } catch (e: Exception) {
            Log.e(TAG, "Action $action failed", e)
            DeviceActionResult(
                success = false,
                error = "Action $action failed: ${e.message}",
                errorCode = "ACTION_EXECUTION_ERROR",
            )
        }
    }
}
