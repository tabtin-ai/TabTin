import Foundation
import Security
import os

enum KeychainSaveError: LocalizedError {
    /// `detail` 描述写入失败原因；`rollbackReport` 描述各 key 的回滚结果（best-effort）。
    case partialWriteFailure(String, rollbackReport: String)

    /// 面向用户：Keychain 写不进去时用户能做的只有重启，不要把 OSStatus 甩到弹窗里。
    var errorDescription: String? {
        switch self {
        case .partialWriteFailure:
            return "登录信息保存失败：系统钥匙串当前不可用，请重启 App 后重试"
        }
    }

    /// 面向排查：完整技术细节，只进日志 / 诊断包，不进 UI。
    var technicalDetail: String {
        switch self {
        case .partialWriteFailure(let detail, let rollbackReport):
            return "Keychain partial write failure: \(detail) | rollback: \(rollbackReport)"
        }
    }
}

final class KeychainService: @unchecked Sendable {
    static let shared = KeychainService()

    private let keychain = Keychain(service: "com.tabtin.mobile")
        .accessibility(.afterFirstUnlockThisDeviceOnly)
    private let lock = NSLock()
    private let logger = Logger(subsystem: "com.tabtin.mobile", category: "Keychain")

    private let accessTokenKey = "access_token"
    private let refreshTokenKey = "refresh_token"
    private let expiresAtKey = "access_token_expires_at"
    private let deviceIdKey = "device_id"

    private init() {}

    private var cachedDeviceId: String?

    private static let keychainBlockedStatuses: Set<OSStatus> = [
        errSecInteractionNotAllowed,
    ]

    /// 设备锁屏或 App 处于不允许 Keychain UI 交互的状态（常见 OSStatus -25308）。
    /// 此时读 Keychain 会失败，**不能**当成「token 不存在」。
    func isAccessible() -> Bool {
        lock.lock()
        defer { lock.unlock() }
        do {
            _ = try keychain.get(accessTokenKey)
            return true
        } catch KeychainError.unexpectedStatus(let status) {
            return !Self.keychainBlockedStatuses.contains(status)
        } catch {
            return false
        }
    }

    // MARK: - Access Token

    func getAccessToken() -> String? {
        lock.lock()
        defer { lock.unlock() }
        return readString(accessTokenKey)
    }

    func setAccessToken(_ token: String) {
        lock.lock()
        defer { lock.unlock() }
        do {
            try keychain.set(token, key: accessTokenKey)
        } catch {
            logger.error("Failed to save access token: \(error.localizedDescription)")
        }
    }

    // MARK: - Refresh Token

    func getRefreshToken() -> String? {
        lock.lock()
        defer { lock.unlock() }
        return readString(refreshTokenKey)
    }

    func setRefreshToken(_ token: String) {
        lock.lock()
        defer { lock.unlock() }
        do {
            try keychain.set(token, key: refreshTokenKey)
        } catch {
            logger.error("Failed to save refresh token: \(error.localizedDescription)")
        }
    }

    // MARK: - Expiration

    func getExpiresAt() -> Date? {
        lock.lock()
        defer { lock.unlock() }
        guard let str = readString(expiresAtKey),
              let interval = TimeInterval(str) else { return nil }
        return Date(timeIntervalSince1970: interval)
    }

    /// 读 Keychain 字符串；锁屏/后台不可交互时返回 nil 并打日志（区别于「key 不存在」）。
    private func readString(_ key: String) -> String? {
        do {
            return try keychain.get(key)
        } catch KeychainError.unexpectedStatus(let status)
            where Self.keychainBlockedStatuses.contains(status) {
            logger.warning("Keychain read blocked for \(key, privacy: .public) (device locked or background)")
            return nil
        } catch {
            logger.error("Keychain read failed for \(key, privacy: .public): \(error.localizedDescription)")
            return nil
        }
    }

    func setExpiresAt(_ date: Date) {
        lock.lock()
        defer { lock.unlock() }
        do {
            try keychain.set(String(date.timeIntervalSince1970), key: expiresAtKey)
        } catch {
            logger.error("Failed to save expiresAt: \(error.localizedDescription)")
        }
    }

    // MARK: - Convenience: save full token pair (原子性保证)

    /// 写入失败时回滚到之前的值并抛出 `KeychainSaveError`，避免部分写入导致不一致状态。
    /// 回滚也是 best-effort（系统级 Keychain 不可用时无法保证一致）。回滚结果会记录到日志和
    /// `KeychainSaveError.partialWriteFailure.rollbackReport`，便于排查"半新半旧 token"问题。
    func saveTokenPair(accessToken: String, refreshToken: String?, expiresIn: Int?) throws {
        lock.lock()
        defer { lock.unlock() }

        let oldAccessToken = try? keychain.get(accessTokenKey)
        let oldRefreshToken = try? keychain.get(refreshTokenKey)
        let oldExpiresAt = try? keychain.get(expiresAtKey)

        do {
            try keychain.set(accessToken, key: accessTokenKey)

            if let rt = refreshToken {
                try keychain.set(rt, key: refreshTokenKey)
            }

            let seconds = TimeInterval(expiresIn ?? 86400)
            let expiresAt = Date().addingTimeInterval(seconds)
            try keychain.set(String(expiresAt.timeIntervalSince1970), key: expiresAtKey)
        } catch {
            logger.error("saveTokenPair failed, rolling back: \(error.localizedDescription)")
            let report = [
                rollbackKey(accessTokenKey, to: oldAccessToken),
                rollbackKey(refreshTokenKey, to: oldRefreshToken),
                rollbackKey(expiresAtKey, to: oldExpiresAt),
            ].joined(separator: "; ")
            let saveError = KeychainSaveError.partialWriteFailure(
                error.localizedDescription,
                rollbackReport: report
            )
            logger.error("\(saveError.technicalDetail, privacy: .public)")
            throw saveError
        }
    }

    /// 回滚单 key 到旧值；返回一段可读描述，便于聚合到 `partialWriteFailure.rollbackReport`。
    @discardableResult
    private func rollbackKey(_ key: String, to value: String?) -> String {
        do {
            if let value {
                try keychain.set(value, key: key)
                return "\(key)=restored"
            } else {
                try keychain.remove(key)
                return "\(key)=cleared"
            }
        } catch {
            logger.error("rollbackKey \(key, privacy: .public) failed: \(error.localizedDescription)")
            return "\(key)=ROLLBACK_FAILED(\(error.localizedDescription))"
        }
    }

    // MARK: - Device ID (原子性保证)

    func getOrCreateDeviceId() -> String {
        lock.lock()
        defer { lock.unlock() }
        if let cachedDeviceId {
            return cachedDeviceId
        }
        if let existing = readString(deviceIdKey) {
            cachedDeviceId = existing
            return existing
        }
        let newId = UUID().uuidString.lowercased().prefix(12)
        let deviceId = "ios-\(newId)"
        cachedDeviceId = deviceId
        do {
            try keychain.set(deviceId, key: deviceIdKey)
        } catch KeychainError.unexpectedStatus(let status)
            where Self.keychainBlockedStatuses.contains(status) {
            logger.warning("Device ID save deferred (device locked or background)")
        } catch {
            logger.error("Failed to save device ID: \(error.localizedDescription)")
        }
        return deviceId
    }

    // MARK: - Clear

    func clearAll() {
        lock.lock()
        defer { lock.unlock() }
        try? keychain.remove(accessTokenKey)
        try? keychain.remove(refreshTokenKey)
        try? keychain.remove(expiresAtKey)
    }
}
