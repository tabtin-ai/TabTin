import Foundation

/// 后端 `GET/PUT /auth/profile/ui-settings` 的 namespace 信封。
struct UISettingEnvelope<Value: Equatable & Sendable>: Equatable, Sendable {
    var value: Value
    var updatedAt: Int64
}

/// per-namespace last-write-wins 合并内核，对齐 Electron `uiSettingsSync.reconcileNamespace`：
/// - 远端存在且 `updatedAt >= 本地` → 远端胜（值有差异才 apply）
/// - 否则本地胜 → 调度写回服务器
enum UISettingsSync {
    /// 与后端 `_UI_SETTINGS_NAMESPACES` / Electron 契约一致。
    static let colorSchemeNamespace = "colorScheme"

    static let uiSettingsPath = Endpoints.Auth.profileUISettings

    static func reconcile<Value: Equatable & Sendable>(
        localValue: Value,
        localUpdatedAt: Int64,
        remote: UISettingEnvelope<Value>?,
        applyRemote: (Value, Int64) -> Void,
        pushLocal: (Value, Int64) -> Void
    ) {
        if let remote, remote.updatedAt >= localUpdatedAt {
            applyRemote(remote.value, remote.updatedAt)
            return
        }

        let ts = localUpdatedAt > 0 ? localUpdatedAt : Int64(Date().timeIntervalSince1970 * 1000)
        pushLocal(localValue, ts)
    }

    /// 从 GET / WS payload 的多种嵌套形态抽出 `settings` map。
    static func extractSettingsMap(from input: Any?) -> [String: [String: Any]] {
        guard let input else { return [:] }
        if let root = input as? [String: Any] {
            if let settings = root["settings"] as? [String: [String: Any]] {
                return settings
            }
            if let data = root["data"] as? [String: Any] {
                if let settings = data["settings"] as? [String: [String: Any]] {
                    return settings
                }
                if let nested = data["data"] as? [String: Any],
                   let settings = nested["settings"] as? [String: [String: Any]] {
                    return settings
                }
            }
            if root.values.contains(where: { $0 is [String: Any] }),
               root.keys.contains(where: { $0 == colorSchemeNamespace || $0 == "theme" }) {
                return root.compactMapValues { $0 as? [String: Any] }
            }
        }
        return [:]
    }

    static func parseColorSchemeEnvelope(
        from settings: [String: [String: Any]]
    ) -> UISettingEnvelope<ColorSchemeId>? {
        guard let entry = settings[colorSchemeNamespace] else { return nil }
        let rawValue: String?
        if let string = entry["value"] as? String {
            rawValue = string
        } else {
            rawValue = nil
        }
        guard let rawValue else { return nil }
        let updatedAt: Int64
        if let number = entry["updatedAt"] as? Int64 {
            updatedAt = number
        } else if let number = entry["updatedAt"] as? Int {
            updatedAt = Int64(number)
        } else if let number = entry["updatedAt"] as? Double {
            updatedAt = Int64(number)
        } else {
            updatedAt = 0
        }
        return UISettingEnvelope(value: ColorSchemeId.resolve(rawValue), updatedAt: updatedAt)
    }
}

extension Notification.Name {
    /// scheme 变更后通知 UIKit appearance / 需要强制刷新的根视图。
    static let ttColorSchemeDidChange = Notification.Name("ttColorSchemeDidChange")
}
