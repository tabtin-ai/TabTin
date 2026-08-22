package com.tabtin.mobile.data.automation

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonPrimitive

public data class PolicyCheckResult(
    val allowed: Boolean,
    val needsConfirm: Boolean,
    val reason: String? = null,
    /** Mapped permission key when known; used by session approval cache. */
    val permissionKey: String? = null,
)

/**
 * Evaluates device action permissions against the sandbox security policy
 * received in the action request payload (`sandbox_policy.device_permissions`).
 *
 * Mapping table mirrors TS `device-rules.ts` ACTION_PERMISSION_MAP.
 * Unknown / unmapped actions default to **block** (fail-closed).
 *
 * 会话级缓存已支持（见 DeviceActionDispatcher / SessionPermissionApprovalCache），
 * always/跨设备待 #20。
 */
public object SecurityPolicyChecker {

    // Only truly read-only, PII-free actions bypass policy entirely.
    // get_device_info / get_automation_status are NOT safe (may leak PII / capabilities).
    private val SAFE_ACTIONS: Set<String> = setOf(
        "get_battery_info",
        "get_network_info",
    )

    /**
     * Complete action → permission-key mapping, kept in sync with
     * TS `device-rules.ts` ACTION_PERMISSION_MAP.
     */
    private val ACTION_TO_PERMISSION: Map<String, String> = mapOf(
        // L1: Contacts
        "read_contacts" to "read_contacts",
        "get_contacts" to "read_contacts",
        "search_contacts" to "read_contacts",

        // L1: SMS
        "read_sms" to "read_sms",
        "get_sms" to "read_sms",
        "send_sms" to "send_sms",

        // L1: Calls
        "read_call_log" to "read_call_log",
        "make_call" to "make_call",

        // L1: Notifications
        "read_notifications" to "read_notifications",

        // L1: Calendar / Location
        "read_calendar" to "read_calendar",
        "get_calendar" to "read_calendar",
        "get_location" to "get_location",

        // L1: Media / Storage
        "read_media" to "read_media",
        "get_media" to "read_media",
        "save_to_device" to "read_media",

        // L1: App list
        "list_installed_apps" to "list_installed_apps",

        // L2: Screen capture / read-only
        "screen_capture" to "screen_capture",
        "screen_snapshot" to "screen_capture",
        "take_screenshot" to "screen_capture",
        "screen_ui_tree" to "screen_capture",
        "screen_get_context" to "screen_capture",
        "screen_find_element" to "screen_capture",

        // L2: Screen interaction
        "screen_tap" to "screen_tap",
        "screen_swipe" to "screen_tap",
        "screen_input" to "screen_tap",
        "screen_tap_area" to "screen_tap",
        "screen_type_text" to "screen_tap",
        "screen_key_event" to "screen_tap",
        "screen_long_press" to "screen_tap",
        "screen_tap_element" to "screen_tap",
        "screen_long_press_element" to "screen_tap",
        "screen_type_in_element" to "screen_tap",
        // #L55(c2) Option B (W A0.4-续2 landed 2026-05-04): wait_for_* are passive read of UI tree state
        // (read semantics); aligned to TS device-rules.ts → screen_capture. See L55c research report §4.1
        // and packages/security-policy/tests/cross-language-contract.test.ts AUTHORITATIVE_MAPPING.
        "screen_wait_for_idle" to "screen_capture",
        "screen_wait_for_element" to "screen_capture",

        // L2: App management
        "launch_app" to "launch_app",
        "launch_with_intent" to "launch_app",
        "screen_launch_app" to "launch_app",
        "screen_open_app" to "launch_app",
        "screen_force_stop_app" to "force_stop_app",

        // L2: System settings
        "set_system_setting" to "set_system",
        "set_system" to "set_system",
        // #L55(c1) bug fix (W A0.4-续2 landed 2026-05-04): get_system_setting is read semantics
        // (Django tool definition required_permission='read' + risk_level='safe'; vs set_system_setting
        // strict + admin). Old mapping to set_system was a historical bug — under collaborative default
        // preset mobile clients were blocked while Electron clients were allowed. Aligned to TS
        // device-rules.ts → device_info. See L55c research report §4.2.
        "get_system_setting" to "device_info",
        "set_stealth_mode" to "set_system",

        // Device info (moved out of SAFE_ACTIONS — may expose PII / capabilities)
        "get_device_info" to "device_info",
        "get_automation_status" to "device_info",
    )

    /** Permission key for [action], or null if unmapped / safe-bypass. */
    public fun permissionKeyFor(action: String): String? = ACTION_TO_PERMISSION[action]

    public fun check(action: String, sandboxPolicy: JsonObject?): PolicyCheckResult {
        if (action in SAFE_ACTIONS) {
            return PolicyCheckResult(allowed = true, needsConfirm = false)
        }

        val permissions = sandboxPolicy
            ?.get("device_permissions") as? JsonObject
            ?: return PolicyCheckResult(
                allowed = false,
                needsConfirm = false,
                reason = "No device permission policy — defaulting to block",
            )

        val permKey = ACTION_TO_PERMISSION[action]
            ?: return PolicyCheckResult(
                allowed = false,
                needsConfirm = false,
                reason = "Unknown action '$action' — blocked (unmapped)",
            )

        val permValue = try {
            permissions[permKey]?.jsonPrimitive?.contentOrNull
        } catch (_: IllegalArgumentException) {
            null
        }

        return when (permValue) {
            "allow" -> PolicyCheckResult(
                allowed = true,
                needsConfirm = false,
                permissionKey = permKey,
            )
            "confirm", null -> PolicyCheckResult(
                allowed = true,
                needsConfirm = true,
                reason = "Action '$action' requires user approval (permission: $permKey)",
                permissionKey = permKey,
            )
            "block" -> PolicyCheckResult(
                allowed = false,
                needsConfirm = false,
                reason = "Action '$action' is blocked by security policy",
                permissionKey = permKey,
            )
            else -> PolicyCheckResult(
                allowed = false,
                needsConfirm = false,
                reason = "Unknown permission value '$permValue' — defaulting to block",
                permissionKey = permKey,
            )
        }
    }
}
