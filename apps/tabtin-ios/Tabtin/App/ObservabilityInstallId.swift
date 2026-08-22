import Foundation

/// 仅用于客户端观测的安装实例 ID。
///
/// UserDefaults 随 App 卸载清除，而正常升级会保留，因此它表达“当前安装实例”，
/// 不复用可能跨卸载保留的 Keychain 业务 device ID。
enum ObservabilityInstallId {
    private static let storageKey = "observability.client_install_id.v1"

    static func current(defaults: UserDefaults = .standard) -> String {
        if let existing = defaults.string(forKey: storageKey), !existing.isEmpty {
            return existing
        }
        let value = "ios-install-\(UUID().uuidString.lowercased())"
        defaults.set(value, forKey: storageKey)
        return value
    }
}

enum ObservabilityBuildMetadata {
    static var appVersion: String {
        Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "unknown"
    }

    static var buildNumber: String {
        Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "unknown"
    }

    static var gitSha: String? {
        let value = Bundle.main.object(forInfoDictionaryKey: "TABTINGitSHA") as? String
        return value?.isEmpty == false ? value : nil
    }
}
