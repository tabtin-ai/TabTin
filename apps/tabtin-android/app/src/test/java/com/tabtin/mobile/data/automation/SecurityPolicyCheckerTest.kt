package com.tabtin.mobile.data.automation

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import org.junit.Assert.*
import org.junit.Test

/**
 * Regression tests for SecurityPolicyChecker — covers:
 *   Wave-1: DEV-001 / DEV-002 / DEV-003 / DEV-004 / DEV-008 (alias mappings)
 *   Wave-2: DEV-006 / DEV-007 / DEV-009 / DEV-010 / DEV-011 / DEV-012
 *           (fallback-to-block, full mapping coverage)
 *
 * 注：测试覆盖目标是与"3 端 mapping 共识"对齐（W A0.4.续 v1.1 概念精度修订）：
 * TS `packages/security-policy/src/rules/device-rules.ts` 是权威端，iOS
 * WebSocketService.swift + Android SecurityPolicyChecker 同步追随。
 *
 * 已收敛：
 *   - W A0.1：force_stop_app 拆分独立权限键（W A0.4 完整对齐 4 端 + Django 4 预设）
 *   - W A0.4-续2：3 处分叉按 Option B 收口（2026-05-04 user 拍板）
 *     - get_system_setting → device_info（#L55(c1) bug fix）
 *     - screen_wait_for_idle / screen_wait_for_element → screen_capture（#L55(c2) Option B）
 *
 * 跨语言契约 SSOT：`packages/security-policy/tests/cross-language-contract.test.ts`
 * AUTHORITATIVE_MAPPING（4 entries）+ Django 4 预设值（独立维度，sandbox_policy.py）。
 * 详见 W A0.1 反思 §6.1 + W A0.4 反思 §3 + W A0.4-续2 反思 + L55c 调研报告。
 */
class SecurityPolicyCheckerTest {

    // -----------------------------------------------------------------------
    // Helpers
    // -----------------------------------------------------------------------

    private fun buildPolicy(vararg entries: Pair<String, String>): JsonObject =
        buildJsonObject {
            put("device_permissions", buildJsonObject {
                entries.forEach { (k, v) -> put(k, JsonPrimitive(v)) }
            })
        }

    // blockAllPolicy 必须覆盖 ACTION_TO_PERMISSION 全部权限键集合，
    // 否则 assertBlocked 在缺失键的 action 上会走默认 confirm（false negative）。
    // 详见 W A0.1 反思 §3.1。
    private val blockAllPolicy = buildPolicy(
        "read_contacts" to "block",
        "read_sms" to "block",
        "send_sms" to "block",
        "read_calendar" to "block",
        "get_location" to "block",
        "read_media" to "block",
        "screen_capture" to "block",
        "screen_tap" to "block",
        "launch_app" to "block",
        "force_stop_app" to "block",
        "set_system" to "block",
        "read_call_log" to "block",
        "make_call" to "block",
        "read_notifications" to "block",
        "list_installed_apps" to "block",
        "device_info" to "block",
    )

    private fun assertBlocked(action: String, policy: JsonObject = blockAllPolicy) {
        val result = SecurityPolicyChecker.check(action, policy)
        assertFalse("$action should be blocked (allowed=${ result.allowed })", result.allowed)
        assertFalse("$action should not need confirm", result.needsConfirm)
    }

    private fun assertAllowed(action: String, policy: JsonObject) {
        val result = SecurityPolicyChecker.check(action, policy)
        assertTrue("$action should be allowed", result.allowed)
        assertFalse("$action should not need confirm", result.needsConfirm)
    }

    private fun assertConfirm(action: String, policy: JsonObject) {
        val result = SecurityPolicyChecker.check(action, policy)
        assertTrue("$action should be allowed (with confirm)", result.allowed)
        assertTrue("$action should need confirm", result.needsConfirm)
    }

    // =======================================================================
    // Wave-1: Alias mapping regression (DEV-001 ~ DEV-004, DEV-008)
    // =======================================================================

    // -- DEV-001: get_contacts / get_sms / get_calendar / get_media ---------

    @Test
    fun `DEV-001 get_contacts maps to read_contacts and is blocked`() = assertBlocked("get_contacts")

    @Test
    fun `DEV-001 get_sms maps to read_sms and is blocked`() = assertBlocked("get_sms")

    @Test
    fun `DEV-001 get_calendar maps to read_calendar and is blocked`() = assertBlocked("get_calendar")

    @Test
    fun `DEV-001 get_media maps to read_media and is blocked`() = assertBlocked("get_media")

    // -- DEV-002: screen_input → screen_tap --------------------------------

    @Test
    fun `DEV-002 screen_input maps to screen_tap and is blocked`() = assertBlocked("screen_input")

    // -- DEV-003: launch_with_intent → launch_app --------------------------

    @Test
    fun `DEV-003 launch_with_intent maps to launch_app and is blocked`() = assertBlocked("launch_with_intent")

    // -- DEV-004: take_screenshot → screen_capture -------------------------

    @Test
    fun `DEV-004 take_screenshot maps to screen_capture and is blocked`() = assertBlocked("take_screenshot")

    // -- DEV-008: set_system → set_system ----------------------------------

    @Test
    fun `DEV-008 set_system maps to set_system permission and is blocked`() = assertBlocked("set_system")

    // =======================================================================
    // Wave-2: Fallback-to-block (DEV-006 / DEV-012)
    // =======================================================================

    // -- DEV-006: Unknown action must be blocked, not confirm ---------------

    @Test
    fun `DEV-006 unknown action is blocked not confirmed`() {
        val result = SecurityPolicyChecker.check("totally_unknown_action", blockAllPolicy)
        assertFalse("unknown action must be blocked", result.allowed)
        assertFalse("unknown action must not need confirm", result.needsConfirm)
        assertTrue(result.reason?.contains("unmapped") == true)
    }

    // -- DEV-012: No policy → block; malformed policy → block ---------------

    @Test
    fun `DEV-012 null sandboxPolicy results in block`() {
        val result = SecurityPolicyChecker.check("screen_tap", null)
        assertFalse("null policy must block", result.allowed)
        assertFalse(result.needsConfirm)
    }

    @Test
    fun `DEV-012 missing device_permissions key results in block`() {
        val policy = buildJsonObject { put("other_key", JsonPrimitive("value")) }
        val result = SecurityPolicyChecker.check("screen_tap", policy)
        assertFalse("missing device_permissions must block", result.allowed)
    }

    @Test
    fun `DEV-012 device_permissions is wrong type results in block`() {
        val policy = buildJsonObject {
            put("device_permissions", JsonArray(listOf(JsonPrimitive("not_an_object"))))
        }
        val result = SecurityPolicyChecker.check("screen_tap", policy)
        assertFalse("array device_permissions must block", result.allowed)
    }

    @Test
    fun `DEV-012 permission key missing from policy defaults to confirm`() {
        val policy = buildPolicy("read_contacts" to "allow")
        val result = SecurityPolicyChecker.check("screen_tap", policy)
        assertTrue("missing perm key should allow with confirm", result.allowed)
        assertTrue("missing perm key should need confirm", result.needsConfirm)
    }

    @Test
    fun `DEV-012 unknown permValue results in block`() {
        val policy = buildPolicy("screen_tap" to "bypass")
        val result = SecurityPolicyChecker.check("screen_tap", policy)
        assertFalse("unknown perm value 'bypass' must block", result.allowed)
        assertFalse(result.needsConfirm)
    }

    // =======================================================================
    // Wave-2: New action mappings (DEV-007 / DEV-009 / DEV-010 / DEV-011)
    // =======================================================================

    // -- DEV-007: 8 registered Android actions now have mappings -------------

    @Test
    fun `DEV-007 read_call_log is mapped and blocked`() = assertBlocked("read_call_log")

    @Test
    fun `DEV-007 make_call is mapped and blocked`() = assertBlocked("make_call")

    @Test
    fun `DEV-007 read_notifications is mapped and blocked`() = assertBlocked("read_notifications")

    @Test
    fun `DEV-007 list_installed_apps is mapped and blocked`() = assertBlocked("list_installed_apps")

    @Test
    fun `DEV-007 search_contacts is mapped and blocked`() = assertBlocked("search_contacts")

    @Test
    fun `DEV-007 save_to_device is mapped and blocked`() = assertBlocked("save_to_device")

    @Test
    fun `DEV-007 set_stealth_mode is mapped and blocked`() = assertBlocked("set_stealth_mode")

    // W A0.4-续2 #L55(c1) bug fix: get_system_setting → device_info (was set_system).
    // blockAllPolicy 已含 device_info=block，所以 assertBlocked 仍通过（值漂前后 block 结果不变）；
    // 真正的行为变化由 testGetSystemSettingMapsToDeviceInfo + 行为差异 case 验证。
    @Test
    fun `DEV-007 get_system_setting is mapped and blocked`() = assertBlocked("get_system_setting")

    // -- DEV-009 / DEV-010: device info actions require policy check ---------

    @Test
    fun `DEV-009 get_device_info is no longer safe and is blocked`() = assertBlocked("get_device_info")

    @Test
    fun `DEV-009 get_device_info allowed when policy allows`() =
        assertAllowed("get_device_info", buildPolicy("device_info" to "allow"))

    @Test
    fun `DEV-010 get_automation_status is no longer safe and is blocked`() = assertBlocked("get_automation_status")

    @Test
    fun `DEV-010 get_automation_status allowed when policy allows`() =
        assertAllowed("get_automation_status", buildPolicy("device_info" to "allow"))

    // -- DEV-011: L2 screen interaction variants ----------------------------

    @Test
    fun `DEV-011 screen_tap_area maps to screen_tap`() = assertBlocked("screen_tap_area")

    @Test
    fun `DEV-011 screen_type_text maps to screen_tap`() = assertBlocked("screen_type_text")

    @Test
    fun `DEV-011 screen_key_event maps to screen_tap`() = assertBlocked("screen_key_event")

    @Test
    fun `DEV-011 screen_long_press maps to screen_tap`() = assertBlocked("screen_long_press")

    @Test
    fun `DEV-011 screen_tap_element maps to screen_tap`() = assertBlocked("screen_tap_element")

    @Test
    fun `DEV-011 screen_long_press_element maps to screen_tap`() = assertBlocked("screen_long_press_element")

    @Test
    fun `DEV-011 screen_type_in_element maps to screen_tap`() = assertBlocked("screen_type_in_element")

    // W A0.4-续2 #L55(c2) Option B: wait_for_* mapping 从 screen_tap 改为 screen_capture
    // （read 语义对齐 TS）；blockAllPolicy 已含 screen_capture=block + screen_tap=block，
    // 所以 assertBlocked 通过。真正的行为变化由 testScreenWaitMapsToScreenCapture +
    // 行为差异 case 验证。
    @Test
    fun `DEV-011 screen_wait_for_idle maps to screen_capture`() = assertBlocked("screen_wait_for_idle")

    @Test
    fun `DEV-011 screen_wait_for_element maps to screen_capture`() = assertBlocked("screen_wait_for_element")

    // -- DEV-011: L2 screen capture variants --------------------------------

    @Test
    fun `DEV-011 screen_ui_tree maps to screen_capture`() = assertBlocked("screen_ui_tree")

    @Test
    fun `DEV-011 screen_get_context maps to screen_capture`() = assertBlocked("screen_get_context")

    @Test
    fun `DEV-011 screen_find_element maps to screen_capture`() = assertBlocked("screen_find_element")

    // -- W A0.4-续2 #L55(c1)+(c2) mapping 直接验证 --------------------------
    // 直接断言新 mapping 走对了 permission key（避开 blockAllPolicy 双重 block 兜底）。

    @Test
    fun `LL55-c1 get_system_setting maps to device_info`() {
        // 仅 device_info=block；set_system=allow → 若 mapping 还走 set_system，会 allow
        val policy = buildPolicy(
            "device_info" to "block",
            "set_system" to "allow",
        )
        val result = SecurityPolicyChecker.check("get_system_setting", policy)
        assertFalse("get_system_setting should map to device_info (#L55(c1) bug fix)", result.allowed)
        assertFalse(result.needsConfirm)
    }

    @Test
    fun `LL55-c2 screen_wait_for_idle maps to screen_capture`() {
        // 仅 screen_capture=block；screen_tap=allow → 若 mapping 还走 screen_tap，会 allow
        val policy = buildPolicy(
            "screen_capture" to "block",
            "screen_tap" to "allow",
        )
        val result = SecurityPolicyChecker.check("screen_wait_for_idle", policy)
        assertFalse("screen_wait_for_idle should map to screen_capture (#L55(c2) Option B)", result.allowed)
        assertFalse(result.needsConfirm)
    }

    @Test
    fun `LL55-c2 screen_wait_for_element maps to screen_capture`() {
        val policy = buildPolicy(
            "screen_capture" to "block",
            "screen_tap" to "allow",
        )
        val result = SecurityPolicyChecker.check("screen_wait_for_element", policy)
        assertFalse("screen_wait_for_element should map to screen_capture (#L55(c2) Option B)", result.allowed)
        assertFalse(result.needsConfirm)
    }

    // -- W A0.4-续2 行为变化 case（同款 W A0.4 force_stop_app 模式）-----------
    //
    // 验证 mobile mapping 改后，3 处分叉在 Django 4 预设下与 TS Electron 端行为一致。
    // 详 W A0.4-续2 行为变化登记。

    /// #L55(c1) bug fix 验证：collaborative 默认预设下 (device_info=allow)，
    /// get_system_setting 直接放行（修复前走 set_system=block 被拒）。
    /// 这是默认预设下 mobile 客户的真实功能恢复。
    @Test
    fun `LL55-c1 get_system_setting allowed under collaborative default`() {
        val policy = buildPolicy(
            "device_info" to "allow",
            "set_system" to "block",
        )
        val result = SecurityPolicyChecker.check("get_system_setting", policy)
        assertTrue("get_system_setting under collaborative-like preset should be allowed (#L55(c1) bug fix)",
                   result.allowed)
        assertFalse(result.needsConfirm)
    }

    /// #L55(c2) Option B 验证：full_auto 预设下 (screen_capture=allow)，
    /// screen_wait_for_* 直接放行（修复前走 screen_tap=confirm 弹窗）。
    /// 与 TS Electron 客户端 full_auto 行为统一。
    @Test
    fun `LL55-c2 screen_wait_for_idle allowed under full_auto preset`() {
        val policy = buildPolicy(
            "screen_capture" to "allow",
            "screen_tap" to "confirm",
        )
        val result = SecurityPolicyChecker.check("screen_wait_for_idle", policy)
        assertTrue("screen_wait_for_idle under full_auto-like preset should be allowed (#L55(c2) Option B)",
                   result.allowed)
        assertFalse("should not need confirm (read 语义对齐 screen_capture)", result.needsConfirm)
    }

    @Test
    fun `LL55-c2 screen_wait_for_element allowed under full_auto preset`() {
        val policy = buildPolicy(
            "screen_capture" to "allow",
            "screen_tap" to "confirm",
        )
        val result = SecurityPolicyChecker.check("screen_wait_for_element", policy)
        assertTrue("screen_wait_for_element under full_auto-like preset should be allowed (#L55(c2) Option B)",
                   result.allowed)
        assertFalse(result.needsConfirm)
    }

    /// confirm 路径仍可走：collaborative 预设下 screen_capture=confirm
    /// → screen_wait_for_* 走 confirm（与 TS Electron 一致）。
    @Test
    fun `LL55-c2 screen_wait_for_idle needs confirm under screen_capture=confirm`() =
        assertConfirm("screen_wait_for_idle", buildPolicy("screen_capture" to "confirm"))

    // -- DEV-011: L2 app management variants --------------------------------

    @Test
    fun `DEV-011 screen_launch_app maps to launch_app`() = assertBlocked("screen_launch_app")

    @Test
    fun `DEV-011 screen_open_app maps to launch_app`() = assertBlocked("screen_open_app")

    // screen_force_stop_app 走独立的 force_stop_app 权限键
    // （非 launch_app 子集，与移动端实现 + Django 预设一致）。
    @Test
    fun `DEV-011 screen_force_stop_app maps to force_stop_app`() = assertBlocked("screen_force_stop_app")

    // collaborative / full_auto / server_auto 三个 Django 预设里
    // force_stop_app 都是 confirm；本 case 验证 confirm 路径
    // （Wave A0.1 自修复：原 W A0.1 v1.0 只测了 block + allow 两种 case）。
    @Test
    fun `DEV-011 screen_force_stop_app needs confirm when force_stop_app is confirm`() =
        assertConfirm("screen_force_stop_app", buildPolicy("force_stop_app" to "confirm"))

    // =======================================================================
    // Direction tests: allow / confirm still work correctly
    // =======================================================================

    @Test
    fun `alias action allowed when permission is allow`() =
        assertAllowed("get_contacts", buildPolicy("read_contacts" to "allow"))

    @Test
    fun `alias action confirm when permission is confirm`() =
        assertConfirm("screen_input", buildPolicy("screen_tap" to "confirm"))

    @Test
    fun `screen_swipe maps to screen_tap and is blocked`() = assertBlocked("screen_swipe")

    // =======================================================================
    // Existing mappings still work
    // =======================================================================

    @Test
    fun `existing read_contacts mapping still works`() = assertBlocked("read_contacts")

    @Test
    fun `existing screen_capture mapping still works`() = assertBlocked("screen_capture")

    @Test
    fun `existing set_system_setting mapping still works`() = assertBlocked("set_system_setting")

    // =======================================================================
    // Safe actions remain allowed regardless of policy
    // =======================================================================

    @Test
    fun `safe actions remain allowed regardless of policy`() {
        for (action in listOf("get_battery_info", "get_network_info")) {
            val result = SecurityPolicyChecker.check(action, blockAllPolicy)
            assertTrue("$action should always be allowed", result.allowed)
            assertFalse("$action should not need confirm", result.needsConfirm)
        }
    }

    @Test
    fun `safe actions allowed even with null policy`() {
        for (action in listOf("get_battery_info", "get_network_info")) {
            val result = SecurityPolicyChecker.check(action, null)
            assertTrue("$action should be allowed even without policy", result.allowed)
            assertFalse(result.needsConfirm)
        }
    }

    // =======================================================================
    // Full parity: every entry in ACTION_TO_PERMISSION resolves correctly
    // =======================================================================

    @Test
    fun `every mapped action resolves to block with blockAllPolicy`() {
        val allMappedActions = listOf(
            "read_contacts", "get_contacts", "search_contacts",
            "read_sms", "get_sms", "send_sms",
            "read_call_log", "make_call",
            "read_notifications",
            "read_calendar", "get_calendar", "get_location",
            "read_media", "get_media", "save_to_device",
            "list_installed_apps",
            "screen_capture", "screen_snapshot", "take_screenshot",
            "screen_ui_tree", "screen_get_context", "screen_find_element",
            "screen_tap", "screen_swipe", "screen_input",
            "screen_tap_area", "screen_type_text", "screen_key_event",
            "screen_long_press", "screen_tap_element", "screen_long_press_element",
            "screen_type_in_element", "screen_wait_for_idle", "screen_wait_for_element",
            "launch_app", "launch_with_intent",
            "screen_launch_app", "screen_open_app", "screen_force_stop_app",
            "set_system_setting", "set_system", "get_system_setting", "set_stealth_mode",
            "get_device_info", "get_automation_status",
        )
        for (action in allMappedActions) {
            val result = SecurityPolicyChecker.check(action, blockAllPolicy)
            assertFalse("$action should be blocked with blockAllPolicy", result.allowed)
        }
    }
}
