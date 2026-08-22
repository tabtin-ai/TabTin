package com.tabtin.mobile.data.automation.handlers.l2

import com.tabtin.mobile.data.automation.DeviceActionResult
import com.tabtin.mobile.data.privileged.PrivilegedProcessManager
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonPrimitive
import javax.inject.Inject
import javax.inject.Singleton

@Singleton
internal class SaveToDeviceHandler @Inject constructor(
    privilegedManager: PrivilegedProcessManager,
) : L2Handler(privilegedManager) {

    override val actionName: String = "save_to_device"

    override suspend fun delegateToPrivileged(params: JsonObject): DeviceActionResult {
        val url = params["url"]?.jsonPrimitive?.contentOrNull?.trim()
        if (url.isNullOrEmpty()) {
            return DeviceActionResult(
                success = false,
                error = "Missing required parameter 'url'",
                errorCode = "MISSING_PARAM",
            )
        }

        return super.delegateToPrivileged(params)
    }
}
