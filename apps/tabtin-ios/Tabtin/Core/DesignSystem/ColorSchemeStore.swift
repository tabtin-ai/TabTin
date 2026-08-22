import Foundation
import os

/// 账号级配色偏好：本地持久化 + `/auth/profile/ui-settings` 的 `colorScheme` namespace 同步。
///
/// 合并语义对齐 Electron `useUIStore.syncFromServer` / `uiSettingsSync.reconcileNamespace`：
/// per-namespace `updatedAt` last-write-wins；本地较新则推回服务器。
/// 登出重置为 `ColorSchemeId.default`，且**不**写穿后端（避免串账号）。
@MainActor @Observable
final class ColorSchemeStore {
    static let shared = ColorSchemeStore()

    private static let schemeStorageKey = "tt_color_scheme_id"
    private static let updatedAtStorageKey = "tt_color_scheme_updated_at"
    private static let wsListenerKey = "color-scheme-ui-settings"

    private(set) var schemeId: ColorSchemeId {
        didSet {
            guard oldValue != schemeId else { return }
            ColorSchemeCurrent.id = schemeId
            UserDefaults.standard.set(schemeId.rawValue, forKey: Self.schemeStorageKey)
            NotificationCenter.default.post(name: .ttColorSchemeDidChange, object: schemeId.rawValue)
        }
    }

    private var localUpdatedAt: Int64 {
        didSet {
            UserDefaults.standard.set(localUpdatedAt, forKey: Self.updatedAtStorageKey)
        }
    }

    private var saveTask: Task<Void, Never>?
    private var didRegisterHooks = false
    private let logger = Logger(subsystem: "com.tabtin.mobile", category: "ColorScheme")

    private init() {
        if let raw = UserDefaults.standard.string(forKey: Self.schemeStorageKey) {
            schemeId = ColorSchemeId.resolve(raw)
        } else {
            schemeId = .default
        }
        let stored = UserDefaults.standard.object(forKey: Self.updatedAtStorageKey) as? NSNumber
        localUpdatedAt = stored?.int64Value ?? 0
        ColorSchemeCurrent.id = schemeId
        // 尽早挂登出 / WS；已登录则拉一次云端偏好。
        Task { @MainActor [weak self] in
            self?.bootstrap()
        }
    }

    /// 由 App / RootView 在冷启动与登录成功后调用；可重复调用。
    /// `shared` 首次访问时也会自动触发一次。
    func bootstrap() {
        registerHooksIfNeeded()
        guard AuthService.shared.isAuthenticated else { return }
        Task { await syncFromServer() }
    }

    /// 登录成功瞬间调用（`onChange(of: auth.isAuthenticated)`），避免只依赖 init 时的冷启动窗口。
    func onAuthenticated() {
        bootstrap()
    }

    /// 用户主动切换配色：更新本地并防抖写穿。
    func setScheme(_ id: ColorSchemeId) {
        let resolved = ColorSchemeId.resolve(id.rawValue)
        let changed = schemeId != resolved
        schemeId = resolved
        localUpdatedAt = Int64(Date().timeIntervalSince1970 * 1000)
        if changed || AuthService.shared.isAuthenticated {
            scheduleSave()
        }
    }

    /// 登出 / 换账号：拉回默认，清本地时间戳，不写后端。
    func resetToDefaultWithoutSave() {
        saveTask?.cancel()
        saveTask = nil
        localUpdatedAt = 0
        UserDefaults.standard.removeObject(forKey: Self.updatedAtStorageKey)
        UserDefaults.standard.removeObject(forKey: Self.schemeStorageKey)
        schemeId = .default
        ColorSchemeCurrent.id = .default
    }

    func syncFromServer() async {
        guard AuthService.shared.isAuthenticated else { return }
        do {
            let response: UISettingsGETResponse = try await APIClient.shared.get(
                path: UISettingsSync.uiSettingsPath
            )
            let settings = response.settings.mapValues(\.dictionary)
            applyRemoteSettings(settings)
        } catch {
            logger.warning("GET ui-settings 失败，保留本地 scheme=\(self.schemeId.rawValue): \(error.localizedDescription)")
        }
    }

    func applyRemoteSettings(_ settings: [String: [String: Any]]) {
        let remote = UISettingsSync.parseColorSchemeEnvelope(from: settings)
        UISettingsSync.reconcile(
            localValue: schemeId,
            localUpdatedAt: localUpdatedAt,
            remote: remote,
            applyRemote: { [weak self] value, updatedAt in
                guard let self else { return }
                self.localUpdatedAt = updatedAt
                self.schemeId = value
            },
            pushLocal: { [weak self] value, updatedAt in
                guard let self else { return }
                self.localUpdatedAt = updatedAt
                self.schemeId = value
                self.scheduleSave()
            }
        )
    }

    // MARK: - Private

    private func registerHooksIfNeeded() {
        guard !didRegisterHooks else { return }
        didRegisterHooks = true

        AuthService.shared.registerLogoutHook { [weak self] in
            self?.resetToDefaultWithoutSave()
        }

        RealtimeGateway.shared.addEnvelopeListener(key: Self.wsListenerKey) { [weak self] envelope in
            guard envelope.type == "ui_settings_changed" else { return }
            self?.handleUISettingsChanged(envelope)
        }
    }

    private func handleUISettingsChanged(_ envelope: WSEnvelope) {
        let payload = envelope.payloadDict
        let settings = UISettingsSync.extractSettingsMap(from: payload)
        guard !settings.isEmpty else { return }
        applyRemoteSettings(settings)
    }

    private func scheduleSave() {
        guard AuthService.shared.isAuthenticated else { return }
        saveTask?.cancel()
        let snapshotScheme = schemeId
        let snapshotUpdatedAt = localUpdatedAt > 0
            ? localUpdatedAt
            : Int64(Date().timeIntervalSince1970 * 1000)
        localUpdatedAt = snapshotUpdatedAt
        saveTask = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(600))
            guard !Task.isCancelled else { return }
            await self?.flushSave(scheme: snapshotScheme, updatedAt: snapshotUpdatedAt)
        }
    }

    private func flushSave(scheme: ColorSchemeId, updatedAt: Int64) async {
        guard AuthService.shared.isAuthenticated else { return }
        let body: [String: Any] = [
            "settings": [
                UISettingsSync.colorSchemeNamespace: [
                    "value": scheme.rawValue,
                    "updatedAt": updatedAt,
                ],
            ],
        ]
        do {
            let _: MessageResponse = try await APIClient.shared.put(
                path: UISettingsSync.uiSettingsPath,
                body: body
            )
        } catch {
            logger.warning("PUT ui-settings 失败，稍后本地改动会重试: \(error.localizedDescription)")
        }
    }
}

// MARK: - Wire types（仅 colorScheme 消费；其它 namespace 忽略）

private struct UISettingsGETResponse: Decodable, Sendable {
    let settings: [String: UISettingEnvelopeDTO]
}

private struct UISettingEnvelopeDTO: Decodable, Sendable {
    let value: UISettingJSONValue
    let updatedAt: Double?

    var dictionary: [String: Any] {
        var dict: [String: Any] = ["value": value.foundationValue]
        if let updatedAt {
            dict["updatedAt"] = updatedAt
        }
        return dict
    }
}

/// 宽松解码后端任意 JSON value。
private enum UISettingJSONValue: Decodable, Sendable {
    case string(String)
    case number(Double)
    case bool(Bool)
    case object
    case array
    case null

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            self = .null
        } else if let value = try? container.decode(String.self) {
            self = .string(value)
        } else if let value = try? container.decode(Double.self) {
            self = .number(value)
        } else if let value = try? container.decode(Bool.self) {
            self = .bool(value)
        } else if let _ = try? container.decode([String: UISettingJSONValue].self) {
            self = .object
        } else if let _ = try? container.decode([UISettingJSONValue].self) {
            self = .array
        } else {
            self = .null
        }
    }

    var foundationValue: Any {
        switch self {
        case .string(let value): return value
        case .number(let value): return value
        case .bool(let value): return value
        case .object, .array, .null: return NSNull()
        }
    }
}
