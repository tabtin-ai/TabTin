import Foundation

/// `device.status` 实时事件如何落到本地设备缓存。
///
/// 事件从 `/ws/v1/gateway`（Django Channels）来：设备 WS 连上即 `online`，断开后
/// 服务端等 30 秒宽限、复核期间没有重连和新心跳才广播 `offline`。网关的 scope 过滤
/// 明确把 `device.status` 投给包括 mobile 在内的所有 scope——iOS 本来就在收，
/// 只是过去被解码器当未知事件丢了。
///
/// **只更新已知设备**：`devicesById` 是当前组织的 Workspace 元信息拉回来的，
/// 本身已是组织范围内的集合。事件里的设备不在其中就忽略——这天然挡掉了跨组织的
/// 串扰，不需要再比对 organization_id（RuntimeDevice 上也没有这个字段）。
enum DeviceStatusEventPolicy {
    static let eventType = "device.status"

    struct Update: Equatable {
        let deviceId: String
        let status: String
        /// 服务端可能连带改名（重命名后重连），一并同步。
        let name: String?
    }

    /// 从 envelope 解析出可应用的更新；不是设备事件或缺字段时返回 nil。
    static func update(from envelope: WSEnvelope) -> Update? {
        guard envelope.type == eventType else { return nil }
        guard let deviceId = nonEmpty(envelope.payloadString("device_id")),
              let status = nonEmpty(envelope.payloadString("status")) else { return nil }
        return Update(
            deviceId: deviceId,
            status: status.lowercased(),
            name: nonEmpty(envelope.payloadString("name"))
        )
    }

    /// 应用到设备缓存。
    /// - Returns: 是否真的改了——没变化就不写回，避免无谓的 @Observable 失效风暴。
    static func apply(
        _ update: Update,
        to devicesById: inout [String: RuntimeDevice]
    ) -> Bool {
        guard let existing = devicesById[update.deviceId] else { return false }

        let newName = update.name ?? existing.name
        guard existing.status?.lowercased() != update.status || existing.name != newName else {
            return false
        }

        devicesById[update.deviceId] = RuntimeDevice(
            id: existing.id,
            name: newName,
            deviceType: existing.deviceType,
            status: update.status,
            // 心跳时间不在事件里；保留旧值，别拿事件到达时间冒充心跳。
            lastHeartbeatAt: existing.lastHeartbeatAt
        )
        return true
    }

    private static func nonEmpty(_ value: String?) -> String? {
        let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return trimmed.isEmpty ? nil : trimmed
    }
}
