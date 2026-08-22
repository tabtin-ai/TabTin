package com.tabtin.mobile.features.conversation

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class TaskHomeDevicePolicyTest {
    @Test
    fun `items only include devices used by execution workspaces`() {
        val items = TaskHomeDevicePolicy.items(
            workspaceDeviceIds = listOf("device-a", "device-a"),
            devices = listOf(
                TaskHomeDevicePolicy.DeviceInput("device-a", "Mac", false),
                TaskHomeDevicePolicy.DeviceInput("unused", "Unused", true),
            ),
            fallbackName = "Unnamed",
        )

        assertEquals(listOf("device-a"), items.map { it.id })
    }

    @Test
    fun `offline devices sort after online devices`() {
        val items = TaskHomeDevicePolicy.items(
            workspaceDeviceIds = listOf("offline", "online"),
            devices = listOf(
                TaskHomeDevicePolicy.DeviceInput("offline", "A", true),
                TaskHomeDevicePolicy.DeviceInput("online", "Z", false),
            ),
            fallbackName = "Unnamed",
        )

        assertEquals(listOf("online", "offline"), items.map { it.id })
    }

    @Test
    fun `single online device does not consume a status row`() {
        val online = TaskHomeDevicePolicy.DeviceItem("online", "Mac", "Mac", false)
        val offline = TaskHomeDevicePolicy.DeviceItem("offline", "PC", "PC", true)

        assertFalse(TaskHomeDevicePolicy.shouldShowRail(listOf(online)))
        assertTrue(TaskHomeDevicePolicy.shouldShowRail(listOf(offline)))
        assertTrue(TaskHomeDevicePolicy.shouldShowRail(listOf(online, offline)))
    }
}
