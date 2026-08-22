package com.tabtin.mobile.data.automation.handlers

import com.tabtin.mobile.data.automation.ActionHandler
import com.tabtin.mobile.data.automation.DeviceActionResult
import com.tabtin.mobile.util.DeviceRuntimeDescriptor
import kotlinx.serialization.json.JsonObject
import javax.inject.Inject
import javax.inject.Singleton

@Singleton
internal class DeviceInfoHandler @Inject constructor(
    private val descriptor: DeviceRuntimeDescriptor,
) : ActionHandler {
    override val actionName: String = "get_device_info"
    override suspend fun execute(params: JsonObject): DeviceActionResult =
        DeviceActionResult(success = true, data = descriptor.deviceInfoPayload())
}

@Singleton
internal class BatteryInfoHandler @Inject constructor(
    private val descriptor: DeviceRuntimeDescriptor,
) : ActionHandler {
    override val actionName: String = "get_battery_info"
    override suspend fun execute(params: JsonObject): DeviceActionResult =
        DeviceActionResult(success = true, data = descriptor.batteryInfoPayload())
}

@Singleton
internal class NetworkInfoHandler @Inject constructor(
    private val descriptor: DeviceRuntimeDescriptor,
) : ActionHandler {
    override val actionName: String = "get_network_info"
    override suspend fun execute(params: JsonObject): DeviceActionResult =
        DeviceActionResult(success = true, data = descriptor.networkInfoPayload())
}
