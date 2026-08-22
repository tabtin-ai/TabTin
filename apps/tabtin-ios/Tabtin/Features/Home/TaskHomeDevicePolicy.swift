import Foundation

/// 任务页设备状态条的数据策略。
///
/// 会话只按 Workspace 过滤；设备状态条不可交互，只把当前组织可执行 Workspace
/// 所依赖的设备聚合成一份简短状态。没有被任何 Workspace 使用的设备不展示。
enum TaskHomeDevicePolicy {
    static let maxNameWidth: Double = 8
    private static let latinCharWidth: Double = 0.55

    struct DeviceItem: Identifiable, Equatable, Hashable {
        let id: String
        let fullName: String
        let shortName: String
        let isOffline: Bool
    }

    static func items(
        workspaceDeviceIds: [String?],
        devices: [(id: String, name: String?, isOffline: Bool)],
        fallbackName: String
    ) -> [DeviceItem] {
        let usedDeviceIds = Set(workspaceDeviceIds.compactMap(normalized))
        return devices.compactMap { device in
            guard usedDeviceIds.contains(device.id) else { return nil }
            let fullName = normalized(device.name) ?? fallbackName
            return DeviceItem(
                id: device.id,
                fullName: fullName,
                shortName: shortName(fullName),
                isOffline: device.isOffline
            )
        }
        .sorted {
            if $0.isOffline != $1.isOffline { return !$0.isOffline }
            if $0.fullName != $1.fullName { return $0.fullName < $1.fullName }
            return $0.id < $1.id
        }
    }

    /// 单设备在线时没有需要常驻展示的信息；多设备或任一离线时才占一行。
    static func shouldShowRail(items: [DeviceItem]) -> Bool {
        items.count > 1 || items.contains { $0.isOffline }
    }

    static func shortName(_ name: String) -> String {
        guard displayWidth(name) > maxNameWidth else { return name }
        let budget = maxNameWidth - latinCharWidth
        var used: Double = 0
        var kept = ""
        for character in name {
            let width = characterWidth(character)
            guard used + width <= budget else { break }
            used += width
            kept.append(character)
        }
        return kept.isEmpty ? "…" : kept + "…"
    }

    private static func displayWidth(_ text: String) -> Double {
        text.reduce(0) { $0 + characterWidth($1) }
    }

    private static func characterWidth(_ character: Character) -> Double {
        guard let scalar = character.unicodeScalars.first else { return latinCharWidth }
        return scalar.value >= 0x2E80 ? 1 : latinCharWidth
    }

    private static func normalized(_ value: String?) -> String? {
        let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return trimmed.isEmpty ? nil : trimmed
    }
}
