package com.tabtin.mobile.features.conversation

/**
 * 任务页只读设备状态条的数据策略。
 *
 * 会话只按 Workspace 过滤；这里只聚合当前可执行 Workspace 所依赖的设备。
 */
internal object TaskHomeDevicePolicy {
    private const val MAX_NAME_WIDTH: Double = 8.0
    private const val LATIN_CHAR_WIDTH: Double = 0.55

    data class DeviceItem(
        val id: String,
        val fullName: String,
        val shortName: String,
        val isOffline: Boolean,
    )

    data class DeviceInput(
        val id: String,
        val name: String?,
        val isOffline: Boolean,
    )

    fun items(
        workspaceDeviceIds: List<String?>,
        devices: List<DeviceInput>,
        fallbackName: String,
    ): List<DeviceItem> {
        val usedDeviceIds = workspaceDeviceIds.mapNotNull { it?.trim()?.takeIf(String::isNotEmpty) }.toSet()
        return devices.mapNotNull { device ->
            if (device.id !in usedDeviceIds) return@mapNotNull null
            val fullName = device.name?.trim()?.takeIf(String::isNotEmpty) ?: fallbackName
            DeviceItem(
                id = device.id,
                fullName = fullName,
                shortName = shortName(fullName),
                isOffline = device.isOffline,
            )
        }.sortedWith(compareBy({ it.isOffline }, { it.fullName }, { it.id }))
    }

    /** 单设备在线时不占一行；多设备或任一离线时才展示。 */
    fun shouldShowRail(items: List<DeviceItem>): Boolean =
        items.size > 1 || items.any { it.isOffline }

    private fun shortName(name: String): String {
        if (displayWidth(name) <= MAX_NAME_WIDTH) return name
        val budget = MAX_NAME_WIDTH - LATIN_CHAR_WIDTH
        var used = 0.0
        val kept = StringBuilder()
        for (char in name) {
            val width = charWidth(char)
            if (used + width > budget) break
            used += width
            kept.append(char)
        }
        return if (kept.isEmpty()) "…" else "$kept…"
    }

    private fun displayWidth(text: String): Double = text.sumOf(::charWidth)

    private fun charWidth(char: Char): Double =
        if (char.code >= 0x2E80) 1.0 else LATIN_CHAR_WIDTH
}
