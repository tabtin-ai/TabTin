package com.tabtin.mobile.features.conversation

import com.tabtin.mobile.data.model.RuntimeDevice
import com.tabtin.mobile.data.model.WSEnvelope

/**
 * `device.status` 实时事件如何落到本地设备缓存。对齐 iOS `DeviceStatusEventPolicy`。
 *
 * 事件从 `/ws/v1/gateway`（Django Channels）来：设备 WS 连上即 `online`，断开后
 * 服务端等 30 秒宽限、复核期间没有重连和新心跳才广播 `offline`。网关的 scope 过滤
 * 只挡 `agent.action.*`，`device.status` 直达移动端——Android 本来就在收，只是过去
 * 没有消费方。
 *
 * **只更新已知设备**：`devicesById` 是当前组织拉回来的设备表，本身已是组织范围内
 * 的集合。事件里的设备不在其中就忽略——这天然挡掉了跨组织的串扰。
 */
internal object DeviceStatusEventPolicy {
    const val EVENT_TYPE: String = "device.status"

    internal data class Update(
        val deviceId: String,
        val status: String,
        /** 服务端可能连带改名（重命名后重连），一并同步。 */
        val name: String?,
    )

    /** 从 envelope 解析出可应用的更新；不是设备事件或缺字段时返回 null。 */
    fun update(envelope: WSEnvelope): Update? {
        if (envelope.type != EVENT_TYPE) return null
        val deviceId = nonEmpty(envelope.payloadString("device_id")) ?: return null
        val status = nonEmpty(envelope.payloadString("status")) ?: return null
        return Update(
            deviceId = deviceId,
            status = status.lowercase(),
            name = nonEmpty(envelope.payloadString("name")),
        )
    }

    /**
     * 应用到设备缓存。
     *
     * @return 变化后的新表；没有任何变化时返回 null——避免无谓的 StateFlow 发射。
     */
    fun apply(
        update: Update,
        devicesById: Map<String, RuntimeDevice>,
    ): Map<String, RuntimeDevice>? {
        val existing = devicesById[update.deviceId] ?: return null
        val newName = update.name ?: existing.name
        if (existing.status?.lowercase() == update.status && existing.name == newName) return null

        return devicesById + (
            update.deviceId to existing.copy(
                name = newName,
                status = update.status,
                // 心跳时间不在事件里；保留旧值，别拿事件到达时间冒充心跳。
            )
            )
    }

    /**
     * 不要在这里定义 `WSEnvelope.payloadString` 扩展：`WSEnvelope` 已有同名**成员**，
     * Kotlin 里成员优先于扩展，同名扩展会被静默忽略——空白值就会一路漏进 Update。
     */
    private fun nonEmpty(value: String?): String? =
        value?.trim()?.takeIf { it.isNotEmpty() }
}
