package com.tabtin.mobile.data.automation.handlers

import com.tabtin.mobile.data.adb.AdbConnectionManager
import com.tabtin.mobile.data.automation.ActionHandler
import com.tabtin.mobile.data.automation.ActionRouter
import com.tabtin.mobile.data.automation.DeviceActionResult
import com.tabtin.mobile.data.privileged.PrivilegedProcessManager
import com.tabtin.mobile.data.privileged.AutomationLevel
import com.tabtin.mobile.data.privileged.ServiceHealthMonitor
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import javax.inject.Inject
import javax.inject.Provider
import javax.inject.Singleton

@Singleton
internal class AutomationStatusHandler @Inject constructor(
    private val healthMonitor: ServiceHealthMonitor,
    private val adbConnectionManager: AdbConnectionManager,
    private val privilegedProcessManager: PrivilegedProcessManager,
    private val actionRouterProvider: Provider<ActionRouter>,
) : ActionHandler {

    override val actionName: String = "get_automation_status"

    override suspend fun execute(params: JsonObject): DeviceActionResult {
        val level = healthMonitor.automationLevel.value

        val ready = level == AutomationLevel.FULL

        return DeviceActionResult(
            success = true,
            data = buildJsonObject {
                put("ready", ready)
                put("automation_level", level.name)
                put("adb_connected", adbConnectionManager.isConnected)
                put("privileged_server_alive", privilegedProcessManager.isReady)
                put("capabilities", buildJsonArray {
                    actionRouterProvider.get().supportedActions.sorted().forEach { add(JsonPrimitive(it)) }
                })
            },
        )
    }
}
