package com.tabtin.mobile.data.automation

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject

public data class DeviceActionResult(
    val success: Boolean,
    val data: JsonObject? = null,
    val error: String? = null,
    val errorCode: String? = null,
)

public interface ActionHandler {
    public val actionName: String

    /** L0/L1 默认 30s，L2 覆盖为 120s */
    public val timeoutMs: Long get() = 30_000L

    public suspend fun execute(params: JsonObject = buildJsonObject {}): DeviceActionResult
}
