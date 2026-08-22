import Foundation
import os

struct MobilePushPreferences: Codable, Equatable, Sendable {
    var approval: Bool = true
    var taskCompleted: Bool = true
    var messages: Bool = true
    var mentions: Bool = true

    init(
        approval: Bool = true,
        taskCompleted: Bool = true,
        messages: Bool = true,
        mentions: Bool = true
    ) {
        self.approval = approval
        self.taskCompleted = taskCompleted
        self.messages = messages
        self.mentions = mentions
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        approval = try container.decodeIfPresent(Bool.self, forKey: .approval) ?? true
        taskCompleted = try container.decodeIfPresent(Bool.self, forKey: .taskCompleted) ?? true
        messages = try container.decodeIfPresent(Bool.self, forKey: .messages) ?? true
        mentions = try container.decodeIfPresent(Bool.self, forKey: .mentions) ?? true
    }
}

/// 移动端通知类型偏好：本地立即生效，并通过 ``mobilePushPrefs`` namespace 跨设备同步。
@MainActor @Observable
final class MobilePushPreferencesStore {
    static let shared = MobilePushPreferencesStore()
    static let namespace = "mobilePushPrefs"

    private static let valueStorageKey = "tt_mobile_push_preferences"
    private static let updatedAtStorageKey = "tt_mobile_push_preferences_updated_at"
    private static let wsListenerKey = "mobile-push-preferences-ui-settings"

    private(set) var value: MobilePushPreferences {
        didSet { persistValue() }
    }

    private var localUpdatedAt: Int64 {
        didSet { UserDefaults.standard.set(localUpdatedAt, forKey: Self.updatedAtStorageKey) }
    }

    private var saveTask: Task<Void, Never>?
    private var didRegisterHooks = false
    private let logger = Logger(subsystem: "com.tabtin.mobile", category: "MobilePushPreferences")

    private init() {
        if let data = UserDefaults.standard.data(forKey: Self.valueStorageKey),
           let stored = try? JSONDecoder().decode(MobilePushPreferences.self, from: data) {
            value = stored
        } else {
            value = MobilePushPreferences()
        }
        localUpdatedAt = (UserDefaults.standard.object(forKey: Self.updatedAtStorageKey) as? NSNumber)?.int64Value ?? 0
        Task { @MainActor [weak self] in self?.bootstrap() }
    }

    func bootstrap() {
        registerHooksIfNeeded()
        guard AuthService.shared.isAuthenticated else { return }
        Task { await syncFromServer() }
    }

    func setApproval(_ enabled: Bool) { update { $0.approval = enabled } }
    func setTaskCompleted(_ enabled: Bool) { update { $0.taskCompleted = enabled } }
    func setMessages(_ enabled: Bool) { update { $0.messages = enabled } }
    func setMentions(_ enabled: Bool) { update { $0.mentions = enabled } }

    func syncFromServer() async {
        guard AuthService.shared.isAuthenticated else { return }
        do {
            let response: MobilePushUISettingsResponse = try await APIClient.shared.get(
                path: UISettingsSync.uiSettingsPath
            )
            applyRemoteSettings(response.settings.mapValues(\.value))
        } catch {
            logger.warning("GET ui-settings 失败，保留本地通知偏好: \(error.localizedDescription)")
        }
    }

    func applyRemoteSettings(_ settings: [String: Any]) {
        guard let entry = settings[Self.namespace] as? [String: Any],
              let rawValue = entry["value"] as? [String: Any] else {
            if localUpdatedAt == 0 { localUpdatedAt = nowMilliseconds() }
            scheduleSave()
            return
        }
        let remote = MobilePushPreferences(
            approval: rawValue["approval"] as? Bool ?? true,
            taskCompleted: rawValue["taskCompleted"] as? Bool ?? true,
            messages: rawValue["messages"] as? Bool ?? true,
            mentions: rawValue["mentions"] as? Bool ?? true
        )
        let updatedAt = numberAsInt64(entry["updatedAt"])
        if updatedAt >= localUpdatedAt {
            localUpdatedAt = updatedAt
            value = remote
        } else {
            scheduleSave()
        }
    }

    private func update(_ mutation: (inout MobilePushPreferences) -> Void) {
        var next = value
        mutation(&next)
        guard next != value else { return }
        value = next
        localUpdatedAt = nowMilliseconds()
        scheduleSave()
    }

    private func registerHooksIfNeeded() {
        guard !didRegisterHooks else { return }
        didRegisterHooks = true
        AuthService.shared.registerLogoutHook { [weak self] in self?.resetWithoutSave() }
        RealtimeGateway.shared.addEnvelopeListener(key: Self.wsListenerKey) { [weak self] envelope in
            guard envelope.type == "ui_settings_changed" else { return }
            let settings = UISettingsSync.extractSettingsMap(from: envelope.payloadDict)
            self?.applyRemoteSettings(settings)
        }
    }

    private func resetWithoutSave() {
        saveTask?.cancel()
        saveTask = nil
        UserDefaults.standard.removeObject(forKey: Self.valueStorageKey)
        UserDefaults.standard.removeObject(forKey: Self.updatedAtStorageKey)
        localUpdatedAt = 0
        value = MobilePushPreferences()
    }

    private func scheduleSave() {
        guard AuthService.shared.isAuthenticated else { return }
        saveTask?.cancel()
        let snapshot = value
        let timestamp = localUpdatedAt > 0 ? localUpdatedAt : nowMilliseconds()
        localUpdatedAt = timestamp
        saveTask = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(500))
            guard !Task.isCancelled else { return }
            await self?.flushSave(snapshot, updatedAt: timestamp)
        }
    }

    private func flushSave(_ preferences: MobilePushPreferences, updatedAt: Int64) async {
        let encoded = (try? JSONEncoder().encode(preferences))
            .flatMap { try? JSONSerialization.jsonObject(with: $0) } as? [String: Any] ?? [:]
        do {
            let _: MessageResponse = try await APIClient.shared.put(
                path: UISettingsSync.uiSettingsPath,
                body: ["settings": [Self.namespace: ["value": encoded, "updatedAt": updatedAt]]]
            )
        } catch {
            logger.warning("PUT ui-settings 失败，保留本地通知偏好: \(error.localizedDescription)")
        }
    }

    private func persistValue() {
        if let data = try? JSONEncoder().encode(value) {
            UserDefaults.standard.set(data, forKey: Self.valueStorageKey)
        }
    }

    private func nowMilliseconds() -> Int64 {
        Int64(Date().timeIntervalSince1970 * 1000)
    }

    private func numberAsInt64(_ value: Any?) -> Int64 {
        if let value = value as? Int64 { return value }
        if let value = value as? Int { return Int64(value) }
        if let value = value as? Double { return Int64(value) }
        if let value = value as? NSNumber { return value.int64Value }
        return 0
    }
}

private struct MobilePushUISettingsResponse: Decodable, Sendable {
    let settings: [String: AnyCodable]
}
