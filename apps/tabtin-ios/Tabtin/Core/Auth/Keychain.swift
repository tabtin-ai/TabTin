import Foundation
import Security
import os

enum KeychainError: LocalizedError {
    case unexpectedStatus(OSStatus)
    case utf8EncodeFailed

    var errorDescription: String? {
        switch self {
        case .unexpectedStatus(let status):
            let message = SecCopyErrorMessageString(status, nil) as String? ?? "unknown"
            return "Keychain OSStatus \(status) (\(message))"
        case .utf8EncodeFailed:
            return "Keychain: could not encode string as UTF-8"
        }
    }
}

#if targetEnvironment(simulator)
/// **仅模拟器**：构建产物没带 entitlements 时（典型原因是 `xcodebuild … CODE_SIGNING_ALLOWED=NO`），
/// 模拟器 securityd 对所有 `SecItem*` 一律返回 -34018 errSecMissingEntitlement，
/// 登录写 token 会整条挂掉，症状像「验证码输完登录失败」（见 support/mobile/PITFALLS.md #24）。
///
/// 真机 / 上架构建编译期就不包含这段代码（`targetEnvironment(simulator)` 是编译条件），
/// 所以真实用户的凭证只会落在 Keychain，不存在降级路径。
private enum SimulatorKeychainFallback {
    private static let logger = Logger(subsystem: "com.tabtin.mobile", category: "Keychain")
    private static let namespace = "sim-keychain-fallback"
    private static let warnOnce: Void = {
        logger.warning("""
        ⚠️ 当前模拟器构建没有 entitlements，Keychain 不可用（-34018），已降级到 UserDefaults 存凭证。
        这是开发期兜底，不代表构建正确：模拟器构建不要传 CODE_SIGNING_ALLOWED=NO。
        """)
    }()

    private static func storageKey(service: String, account: String) -> String {
        "\(namespace).\(service).\(account)"
    }

    static func get(service: String, account: String) -> String? {
        _ = warnOnce
        return UserDefaults.standard.string(forKey: storageKey(service: service, account: account))
    }

    static func set(_ value: String, service: String, account: String) {
        _ = warnOnce
        UserDefaults.standard.set(value, forKey: storageKey(service: service, account: account))
    }

    static func remove(service: String, account: String) {
        _ = warnOnce
        UserDefaults.standard.removeObject(forKey: storageKey(service: service, account: account))
    }
}
#endif

/// 轻量 Security.framework 封装，对齐原 KeychainAccess 在本项目中的用法（generic password + service + account）。
final class Keychain: Sendable {
    enum Accessibility: Sendable {
        case whenUnlockedThisDeviceOnly
        case afterFirstUnlockThisDeviceOnly

        fileprivate var secAttrAccessible: CFString {
            switch self {
            case .whenUnlockedThisDeviceOnly:
                return kSecAttrAccessibleWhenUnlockedThisDeviceOnly
            case .afterFirstUnlockThisDeviceOnly:
                return kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
            }
        }
    }

    private let service: String
    private let accessibility: Accessibility

    init(service: String) {
        self.service = service
        // ：锁屏后仍可读；旧 whenUnlocked 会在解锁窗口把读失败误当成无 token。
        self.accessibility = .afterFirstUnlockThisDeviceOnly
    }

    private init(service: String, accessibility: Accessibility) {
        self.service = service
        self.accessibility = accessibility
    }

    func accessibility(_ option: Accessibility) -> Keychain {
        Keychain(service: service, accessibility: option)
    }

    func get(_ key: String) throws -> String? {
        var query = baseQuery(account: key)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne

        var result: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &result)

        if status == errSecItemNotFound {
            return nil
        }
        #if targetEnvironment(simulator)
        if status == errSecMissingEntitlement {
            return SimulatorKeychainFallback.get(service: service, account: key)
        }
        #endif
        guard status == errSecSuccess else {
            throw KeychainError.unexpectedStatus(status)
        }
        guard let data = result as? Data else {
            return nil
        }
        return String(data: data, encoding: .utf8)
    }

    func set(_ value: String, key: String) throws {
        guard let data = value.data(using: .utf8) else {
            throw KeychainError.utf8EncodeFailed
        }

        let query = baseQuery(account: key)
        let update: [String: Any] = [
            kSecValueData as String: data,
            kSecAttrAccessible as String: accessibility.secAttrAccessible,
        ]

        var status = SecItemUpdate(query as CFDictionary, update as CFDictionary)
        if status == errSecSuccess {
            return
        }
        #if targetEnvironment(simulator)
        if status == errSecMissingEntitlement {
            SimulatorKeychainFallback.set(value, service: service, account: key)
            return
        }
        #endif
        if status != errSecItemNotFound {
            throw KeychainError.unexpectedStatus(status)
        }

        var add = query
        add[kSecValueData as String] = data
        add[kSecAttrAccessible as String] = accessibility.secAttrAccessible

        status = SecItemAdd(add as CFDictionary, nil)
        #if targetEnvironment(simulator)
        if status == errSecMissingEntitlement {
            SimulatorKeychainFallback.set(value, service: service, account: key)
            return
        }
        #endif
        guard status == errSecSuccess else {
            throw KeychainError.unexpectedStatus(status)
        }
    }

    func remove(_ key: String) throws {
        let query = baseQuery(account: key)
        let status = SecItemDelete(query as CFDictionary)
        if status == errSecItemNotFound || status == errSecSuccess {
            return
        }
        #if targetEnvironment(simulator)
        if status == errSecMissingEntitlement {
            SimulatorKeychainFallback.remove(service: service, account: key)
            return
        }
        #endif
        throw KeychainError.unexpectedStatus(status)
    }

    private func baseQuery(account: String) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
    }
}
