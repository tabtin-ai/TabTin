package com.tabtin.mobile.data.automation.handlers.l2

import com.tabtin.mobile.data.automation.ActionHandler
import com.tabtin.mobile.data.automation.DeviceActionResult
import com.tabtin.mobile.data.privileged.PrivilegedProcessManager
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject

/**
 * Base class for L2 handlers that delegate to the privileged process.
 * Subclasses only specify the action name and optional pre-processing.
 */
internal abstract class L2Handler(
    protected val privilegedManager: PrivilegedProcessManager,
) : ActionHandler {

    override val timeoutMs: Long get() = 120_000L

    override suspend fun execute(params: JsonObject): DeviceActionResult {
        if (!privilegedManager.isReady) {
            return DeviceActionResult(
                success = false,
                error = "Privileged process not running. Enable Developer Mode and complete ADB pairing first.",
                errorCode = "PRIVILEGED_NOT_READY",
            )
        }
        return delegateToPrivileged(params)
    }

    protected open suspend fun delegateToPrivileged(params: JsonObject): DeviceActionResult {
        val result = privilegedManager.execute(actionName, params)
        return DeviceActionResult(
            success = result.success,
            data = result.data,
            error = result.error,
            errorCode = result.errorCode,
        )
    }
}
