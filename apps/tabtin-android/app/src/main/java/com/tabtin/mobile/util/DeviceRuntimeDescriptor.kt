package com.tabtin.mobile.util

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.os.BatteryManager
import android.os.Build
import android.os.PowerManager
import androidx.core.content.ContextCompat
import com.tabtin.mobile.data.automation.handlers.l1.NotificationListenerUtils
import com.tabtin.mobile.data.privileged.PrivilegedProcessManager
import dagger.Lazy
import dagger.hilt.android.qualifiers.ApplicationContext
import javax.inject.Inject
import javax.inject.Singleton
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.time.Instant

@Singleton
public class DeviceRuntimeDescriptor @Inject constructor(
    @ApplicationContext private val context: Context,
    private val networkMonitor: NetworkMonitor,
    private val privilegedProcessManager: Lazy<PrivilegedProcessManager>,
) {
    public companion object {
        private const val SNAPSHOT_VERSION = 1

        private val L1_PERMISSION_CAPABILITIES = mapOf(
            Manifest.permission.READ_CONTACTS to "contacts",
            Manifest.permission.READ_SMS to "sms_read",
            Manifest.permission.SEND_SMS to "sms_send",
            Manifest.permission.READ_CALL_LOG to "call_log",
            Manifest.permission.CALL_PHONE to "phone_call",
            Manifest.permission.READ_CALENDAR to "calendar",
            Manifest.permission.ACCESS_FINE_LOCATION to "location",
        )

        /** Image media permission resolved at class-load time based on device API level. */
        @Suppress("InlinedApi")
        public val MEDIA_PERMISSION: String = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            Manifest.permission.READ_MEDIA_IMAGES
        } else {
            Manifest.permission.READ_EXTERNAL_STORAGE
        }

        /** Video media permission — separate from images on API 33+. */
        @Suppress("InlinedApi")
        public val VIDEO_MEDIA_PERMISSION: String = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            Manifest.permission.READ_MEDIA_VIDEO
        } else {
            Manifest.permission.READ_EXTERNAL_STORAGE
        }

        private val L2_CAPABILITIES = listOf(
            "screen_capture", "screen_ui_tree", "screen_input",
            "app_management", "system_settings",
            "intent_launch", "file_management",
        )
        private val L2_ACTIONS = listOf(
            "screen_capture", "screen_snapshot", "screen_ui_tree",
            "screen_tap", "screen_tap_area", "screen_swipe", "screen_long_press",
            "screen_tap_element", "screen_long_press_element",
            "screen_type_in_element", "screen_find_element", "screen_get_context",
            "screen_type_text", "screen_key_event",
            "screen_wait_for_idle", "screen_wait_for_element",
            "screen_launch_app", "screen_open_app", "screen_force_stop_app",
            "set_system_setting", "get_system_setting",
            "launch_with_intent", "save_to_device",
        )
    }

    public fun capabilities(): List<String> {
        val caps = mutableListOf("device_info", "battery", "network_info", "app_list")
        for ((permission, capability) in L1_PERMISSION_CAPABILITIES) {
            if (has(permission)) caps.add(capability)
        }
        if ("location" !in caps && has(Manifest.permission.ACCESS_COARSE_LOCATION)) {
            caps.add("location")
        }
        if (has(MEDIA_PERMISSION)) caps.add("media_read")
        if (has(VIDEO_MEDIA_PERMISSION)) caps.add("media_read_video")
        if (isNotificationListenerEnabled()) caps.add("notification")
        if (privilegedProcessManager.get().isReady) {
            caps.addAll(L2_CAPABILITIES)
        }
        return caps
    }

    // NT-009: 委托给 NotificationListenerUtils，消除与 NotificationStore 中的重复实现
    private fun isNotificationListenerEnabled(): Boolean =
        NotificationListenerUtils.isListenerEnabled(context)

    public fun authCapabilities(): List<String> = (capabilities() + listOf("agent.stream", "agent.action")).distinct()

    public fun runtimeToolActions(): List<String> {
        val actions = mutableListOf("get_device_info", "get_battery_info", "get_network_info", "list_installed_apps")
        if (has(Manifest.permission.READ_CONTACTS)) actions.addAll(listOf("read_contacts", "search_contacts"))
        if (has(Manifest.permission.READ_SMS)) actions.add("read_sms")
        if (has(Manifest.permission.SEND_SMS)) actions.add("send_sms")
        if (has(Manifest.permission.READ_CALL_LOG)) actions.add("read_call_log")
        if (has(Manifest.permission.CALL_PHONE)) actions.add("make_call")
        if (has(Manifest.permission.READ_CALENDAR)) actions.add("read_calendar")
        if (has(Manifest.permission.ACCESS_FINE_LOCATION) || has(Manifest.permission.ACCESS_COARSE_LOCATION)) actions.add("get_location")
        if (has(MEDIA_PERMISSION) || has(VIDEO_MEDIA_PERMISSION)) actions.add("read_media")
        if (isNotificationListenerEnabled()) actions.add("read_notifications")
        if (privilegedProcessManager.get().isReady) actions.addAll(L2_ACTIONS)
        return actions
    }

    private fun has(permission: String): Boolean =
        ContextCompat.checkSelfPermission(context, permission) == PackageManager.PERMISSION_GRANTED

    public fun deviceName(): String {
        val parts = listOf(Build.MANUFACTURER.trim(), Build.MODEL.trim())
            .filter { it.isNotEmpty() }
            .distinct()
        return parts.joinToString(" ").ifBlank { "Android Device" }
    }

    public fun osInfo(): JsonObject = buildJsonObject {
        put("os", "android")
        put("platform", "android")
        put("system_name", "Android")
        put("system_version", Build.VERSION.RELEASE ?: "unknown")
        put("sdk_int", Build.VERSION.SDK_INT)
        put("manufacturer", Build.MANUFACTURER)
        put("model", Build.MODEL)
        put("device", Build.DEVICE)
    }

    public fun deviceInfoPayload(): JsonObject = buildJsonObject {
        put("platform", "android")
        put("system_name", "Android")
        put("system_version", Build.VERSION.RELEASE ?: "unknown")
        put("model", Build.MODEL.ifBlank { "Android" })
        put("name", deviceName())
        put("manufacturer", Build.MANUFACTURER)
        put("device", Build.DEVICE)
        put("sdk_int", Build.VERSION.SDK_INT)
    }

    public fun batteryInfoPayload(): JsonObject = buildJsonObject {
        val batteryPercent = batteryPercentage()
        if (batteryPercent != null) {
            put("level_percent", batteryPercent)
            put("level_ratio", batteryPercent.toDouble() / 100.0)
        }
        put("state", batteryState())
        put("low_power_mode_enabled", isLowPowerModeEnabled())
    }

    public fun networkInfoPayload(): JsonObject = buildJsonObject {
        put("connected", networkMonitor.isConnected)
        put(
            "connection_type",
            networkMonitor.connectionTypeName ?: if (networkMonitor.isConnected) "unknown" else "offline",
        )
    }

    public fun runtimeSystemInfo(): JsonObject = buildJsonObject {
        put("device_info", deviceInfoPayload())
        put("battery", batteryInfoPayload())
        put("network", networkInfoPayload())
    }

    public fun hostRuntimeSnapshot(): JsonObject {
        val reportedAt = Instant.now().toString()
        return buildJsonObject {
            put("version", SNAPSHOT_VERSION)
            put("source", "android")
            put("reported_at", reportedAt)
            put(
                "runtime_tools",
                buildJsonArray {
                    runtimeToolActions().forEach { actionName ->
                        add(
                            buildJsonObject {
                                put("capability_id", "runtime_tool:$actionName")
                                put("name", actionName)
                                put("observed_at", reportedAt)
                            },
                        )
                    }
                },
            )
            put(
                "mcp_server",
                buildJsonObject {
                    put("running", false)
                    put("subtype", "unsupported")
                    put("tools", buildJsonArray { })
                    put("observed_at", reportedAt)
                    put(
                        "reason_codes",
                        buildJsonArray {
                            add(JsonPrimitive("mcp_not_running"))
                        },
                    )
                },
            )
        }
    }

    public fun heartbeatSystemInfo(): JsonObject = buildJsonObject {
        runtimeSystemInfo().forEach { (key, value) -> put(key, value) }
        put("host_runtime_snapshot", hostRuntimeSnapshot())
    }

    private fun batteryPercentage(): Int? {
        val batteryManager = context.getSystemService(Context.BATTERY_SERVICE) as? BatteryManager ?: return null
        val value = batteryManager.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY)
        return value.takeIf { it in 0..100 }
    }

    private fun batteryState(): String {
        val intent = context.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED)) ?: return "unknown"
        return when (intent.getIntExtra(BatteryManager.EXTRA_STATUS, -1)) {
            BatteryManager.BATTERY_STATUS_CHARGING -> "charging"
            BatteryManager.BATTERY_STATUS_FULL -> "full"
            BatteryManager.BATTERY_STATUS_DISCHARGING,
            BatteryManager.BATTERY_STATUS_NOT_CHARGING -> "unplugged"
            else -> "unknown"
        }
    }

    private fun isLowPowerModeEnabled(): Boolean {
        val powerManager = context.getSystemService(Context.POWER_SERVICE) as? PowerManager ?: return false
        return powerManager.isPowerSaveMode
    }
}
