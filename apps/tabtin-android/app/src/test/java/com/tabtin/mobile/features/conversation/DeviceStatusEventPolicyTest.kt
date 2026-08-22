package com.tabtin.mobile.features.conversation

import com.tabtin.mobile.data.model.RuntimeDevice
import com.tabtin.mobile.data.model.WSEnvelope
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** `device.status` 实时事件落地：解析、范围过滤、幂等。对齐 iOS 同名单测。 */
class DeviceStatusEventPolicyTest {

    private fun envelope(type: String = "device.status", payload: Map<String, String>) = WSEnvelope(
        type = type,
        payload = JsonObject(payload.mapValues { JsonPrimitive(it.value) }),
    )

    private fun device(id: String, name: String? = "进宝的Mac", status: String? = "online") =
        RuntimeDevice(id = id, name = name, deviceType = "desktop", status = status, lastHeartbeatAt = "2026-08-02T10:00:00Z")

    @Test
    fun `parses device status event`() {
        val update = DeviceStatusEventPolicy.update(
            envelope(payload = mapOf("device_id" to "mac", "status" to "offline", "name" to "进宝的Mac")),
        )
        assertEquals(DeviceStatusEventPolicy.Update("mac", "offline", "进宝的Mac"), update)
    }

    @Test
    fun `ignores other event types`() {
        assertNull(
            DeviceStatusEventPolicy.update(
                envelope(type = "agent.stream.message_delta", payload = mapOf("device_id" to "mac", "status" to "offline")),
            ),
        )
    }

    @Test
    fun `ignores events missing required fields`() {
        assertNull(DeviceStatusEventPolicy.update(envelope(payload = mapOf("status" to "offline"))))
        assertNull(DeviceStatusEventPolicy.update(envelope(payload = mapOf("device_id" to "mac"))))
        assertNull(DeviceStatusEventPolicy.update(envelope(payload = mapOf("device_id" to "  ", "status" to "offline"))))
    }

    @Test
    fun `status is case insensitive`() {
        val update = DeviceStatusEventPolicy.update(
            envelope(payload = mapOf("device_id" to "mac", "status" to "OFFLINE")),
        )
        assertEquals("offline", update?.status)
    }

    @Test
    fun `applies status to known device`() {
        val devices = mapOf("mac" to device("mac", status = "online"))
        val next = DeviceStatusEventPolicy.apply(
            DeviceStatusEventPolicy.Update("mac", "offline", null), devices,
        )
        assertEquals("offline", next?.get("mac")?.status)
        assertEquals(false, next?.get("mac")?.isAvailableForExecution)
    }

    /** 只更新已知设备：devicesById 已是当前组织范围，陌生设备一律忽略。 */
    @Test
    fun `ignores unknown device`() {
        val devices = mapOf("mac" to device("mac"))
        assertNull(
            DeviceStatusEventPolicy.apply(
                DeviceStatusEventPolicy.Update("other-org-device", "offline", null), devices,
            ),
        )
    }

    /** 状态没变就不发射，避免无谓的 StateFlow 风暴。 */
    @Test
    fun `no op when nothing changed`() {
        val devices = mapOf("mac" to device("mac", status = "online"))
        assertNull(
            DeviceStatusEventPolicy.apply(
                DeviceStatusEventPolicy.Update("mac", "online", "进宝的Mac"), devices,
            ),
        )
    }

    @Test
    fun `rename arrives with status event`() {
        val devices = mapOf("mac" to device("mac", name = "旧名字", status = "online"))
        val next = DeviceStatusEventPolicy.apply(
            DeviceStatusEventPolicy.Update("mac", "online", "新名字"), devices,
        )
        assertEquals("新名字", next?.get("mac")?.name)
    }

    /** busy 仍算可执行，别把「在忙」画成「离线」。 */
    @Test
    fun `busy stays available for execution`() {
        val devices = mapOf("mac" to device("mac", status = "online"))
        val next = DeviceStatusEventPolicy.apply(
            DeviceStatusEventPolicy.Update("mac", "busy", null), devices,
        )
        assertTrue(next?.get("mac")?.isAvailableForExecution == true)
    }

    /** 心跳时间不在事件里，不能拿事件到达时间冒充。 */
    @Test
    fun `heartbeat timestamp is preserved`() {
        val devices = mapOf("mac" to device("mac", status = "online"))
        val next = DeviceStatusEventPolicy.apply(
            DeviceStatusEventPolicy.Update("mac", "offline", null), devices,
        )
        assertEquals("2026-08-02T10:00:00Z", next?.get("mac")?.lastHeartbeatAt)
    }
}
