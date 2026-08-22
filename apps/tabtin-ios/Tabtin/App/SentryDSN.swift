import Foundation

enum SentryDSN {
    static let storageKey = "tt_sentry_dsn"

    static func normalize(_ raw: String) -> String {
        raw.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// 空字符串表示关闭上报；非空时必须是带公钥的 http(s) DSN。
    static func isValid(_ raw: String) -> Bool {
        let value = normalize(raw)
        if value.isEmpty { return true }
        guard let components = URLComponents(string: value) else { return false }
        let scheme = components.scheme?.lowercased()
        guard scheme == "http" || scheme == "https" else { return false }
        guard let host = components.host, !host.isEmpty else { return false }
        return components.user?.isEmpty == false
    }

    static var stored: String {
        get { UserDefaults.standard.string(forKey: storageKey) ?? "" }
        set { UserDefaults.standard.set(normalize(newValue), forKey: storageKey) }
    }
}
