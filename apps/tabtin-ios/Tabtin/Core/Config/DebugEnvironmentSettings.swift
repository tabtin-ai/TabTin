import Darwin
import Foundation

enum DebugURLKind: CaseIterable {
    case api
    case websocket
    case web
    case centrifugo
}

/// 快速环境切换总是同时切换 REST、任务网关、内嵌 Web 与 IM 实时通道，避免跨环境混用。
enum DebugEnvironmentPreset: String, CaseIterable, Identifiable {
    case production
    case development
    case custom

    var id: String { rawValue }

    var title: String {
        switch self {
        case .production: return "正式环境"
        case .development: return "开发环境"
        case .custom: return "自定义基础地址"
        }
    }
}

private struct DebugEnvironmentEndpoints: Equatable {
    let api: String
    let websocket: String
    let web: String
    let centrifugo: String

    subscript(_ kind: DebugURLKind) -> String {
        switch kind {
        case .api: return api
        case .websocket: return websocket
        case .web: return web
        case .centrifugo: return centrifugo
        }
    }

    func replacing(_ kind: DebugURLKind, with value: String) -> Self {
        switch kind {
        case .api: return Self(api: value, websocket: websocket, web: web, centrifugo: centrifugo)
        case .websocket: return Self(api: api, websocket: value, web: web, centrifugo: centrifugo)
        case .web: return Self(api: api, websocket: websocket, web: value, centrifugo: centrifugo)
        case .centrifugo: return Self(api: api, websocket: websocket, web: web, centrifugo: value)
        }
    }
}

enum DebugEnvironmentStore {
    private static let presetKey = "tt_debug_environment_preset"
    private static let customBaseURLKey = "tt_debug_environment_custom_base_url"
    private static let advancedEnabledKey = "tt_debug_environment_advanced_enabled"
    private static let advancedAPIURLKey = "tt_debug_environment_advanced_api_url"
    private static let advancedWSURLKey = "tt_debug_environment_advanced_ws_url"
    private static let advancedWebURLKey = "tt_debug_environment_advanced_web_url"
    private static let advancedCentrifugoURLKey = "tt_debug_environment_advanced_centrifugo_url"
    // 兼容已安装 Debug 包中旧的 API/WS 单独覆盖；首次打开新版面板前不改变旧行为。
    private static let legacyAPIPresetKey = "tt_debug_api_url_preset"
    private static let legacyWSPresetKey = "tt_debug_ws_url_preset"
    private static let legacyCustomAPIURLKey = "tt_debug_custom_api_url"
    private static let legacyCustomWSURLKey = "tt_debug_custom_ws_url"
    private static let debugSwiftVisibleKey = "tt_debug_swift_visible"

    static var isDebugSwiftVisible: Bool {
        get {
            // 调试悬浮球会遮挡真实界面并污染视觉验收；默认关闭，需要抓包或看
            // FPS 时再由开发者从 Debug 设置中显式开启。
            guard UserDefaults.standard.object(forKey: debugSwiftVisibleKey) != nil else { return false }
            return UserDefaults.standard.bool(forKey: debugSwiftVisibleKey)
        }
        set { UserDefaults.standard.set(newValue, forKey: debugSwiftVisibleKey) }
    }

    static var preset: DebugEnvironmentPreset {
        get {
            guard let raw = UserDefaults.standard.string(forKey: presetKey),
                  let preset = DebugEnvironmentPreset(rawValue: raw) else {
                return inferredLegacyPreset
            }
            return preset
        }
        set { UserDefaults.standard.set(newValue.rawValue, forKey: presetKey) }
    }

    static var customBaseURL: String {
        get { UserDefaults.standard.string(forKey: customBaseURLKey) ?? "" }
        set { UserDefaults.standard.set(newValue, forKey: customBaseURLKey) }
    }

    static var advancedEnabled: Bool {
        get { UserDefaults.standard.bool(forKey: advancedEnabledKey) }
        set { UserDefaults.standard.set(newValue, forKey: advancedEnabledKey) }
    }

    static func advancedURL(for kind: DebugURLKind) -> String {
        UserDefaults.standard.string(forKey: advancedKey(for: kind)) ?? ""
    }

    static func setAdvancedURL(_ value: String, for kind: DebugURLKind) {
        UserDefaults.standard.set(value, forKey: advancedKey(for: kind))
    }

    static func flush() { UserDefaults.standard.synchronize() }

    /// 仅当已保存新的一组环境配置时生效；否则继续读取旧版 API / WS 覆盖，防止升级后悄然改环境。
    static func effectiveOverrideURL(for kind: DebugURLKind) -> String? {
        guard UserDefaults.standard.object(forKey: presetKey) != nil else {
            return legacyOverrideURL(for: kind)
        }
        return resolvedEndpoints?[kind]
    }

    private static var resolvedEndpoints: DebugEnvironmentEndpoints? {
        let base: DebugEnvironmentEndpoints
        switch preset {
        case .production:
            base = productionEndpoints
        case .development:
            base = developmentEndpoints
        case .custom:
            guard let endpoints = endpoints(fromCustomBaseURL: customBaseURL) else { return nil }
            base = endpoints
        }
        guard advancedEnabled else { return base }
        return DebugURLKind.allCases.reduce(base) { endpoints, kind in
            let override = advancedURL(for: kind).trimmingCharacters(in: .whitespacesAndNewlines)
            return override.isEmpty ? endpoints : endpoints.replacing(kind, with: override)
        }
    }

    static func reset() {
        [presetKey, customBaseURLKey, advancedEnabledKey,
         advancedAPIURLKey, advancedWSURLKey, advancedWebURLKey, advancedCentrifugoURLKey,
         legacyAPIPresetKey, legacyWSPresetKey, legacyCustomAPIURLKey, legacyCustomWSURLKey]
            .forEach(UserDefaults.standard.removeObject(forKey:))
    }

    private static let productionEndpoints = DebugEnvironmentEndpoints(
        api: AppConfig.productionAPIBaseURL,
        websocket: AppConfig.productionWSBaseURL,
        web: AppConfig.productionWebBaseURL,
        centrifugo: AppConfig.productionCentrifugoWSURL
    )
    private static let developmentEndpoints = DebugEnvironmentEndpoints(
        api: AppConfig.testAPIBaseURL,
        websocket: AppConfig.testWSBaseURL,
        web: AppConfig.testWebBaseURL,
        centrifugo: AppConfig.testCentrifugoWSURL
    )

    private static func endpoints(fromCustomBaseURL raw: String) -> DebugEnvironmentEndpoints? {
        var trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        // 只收掉末尾的路径分隔符，不能对整个字符串 trim `/`：那会把
        // `http://` 误裁成 `http:`，导致自定义地址永远无法解析。
        while trimmed.count > 1, trimmed.hasSuffix("/") {
            trimmed.removeLast()
        }
        guard var components = URLComponents(string: trimmed),
              let scheme = components.scheme?.lowercased(), ["http", "https"].contains(scheme),
              components.host != nil else { return nil }
        components.query = nil
        components.fragment = nil
        let web = components.url?.absoluteString.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        guard let web, !web.isEmpty else { return nil }
        let api = web + "/api"
        components.scheme = scheme == "https" ? "wss" : "ws"
        let basePath = components.path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        components.path = basePath.isEmpty ? "/ws/v1/gateway" : "/\(basePath)/ws/v1/gateway"
        let websocket = components.url?.absoluteString
        components.path = basePath.isEmpty ? "/connection/websocket" : "/\(basePath)/connection/websocket"
        let centrifugo = components.url?.absoluteString
        guard let websocket, let centrifugo else { return nil }
        return DebugEnvironmentEndpoints(api: api, websocket: websocket, web: web, centrifugo: centrifugo)
    }

    private static func advancedKey(for kind: DebugURLKind) -> String {
        switch kind {
        case .api: return advancedAPIURLKey
        case .websocket: return advancedWSURLKey
        case .web: return advancedWebURLKey
        case .centrifugo: return advancedCentrifugoURLKey
        }
    }

    private static var inferredLegacyPreset: DebugEnvironmentPreset {
        let api = legacyOverrideURL(for: .api) ?? AppConfig.configuredAPIBaseURL
        let ws = legacyOverrideURL(for: .websocket) ?? AppConfig.configuredWSBaseURL
        if api == productionEndpoints.api && ws == productionEndpoints.websocket { return .production }
        if api == developmentEndpoints.api && ws == developmentEndpoints.websocket { return .development }
        return .custom
    }

    private static func legacyOverrideURL(for kind: DebugURLKind) -> String? {
        guard kind == .api || kind == .websocket else { return nil }
        let presetKey = kind == .api ? legacyAPIPresetKey : legacyWSPresetKey
        let customKey = kind == .api ? legacyCustomAPIURLKey : legacyCustomWSURLKey
        guard let raw = UserDefaults.standard.string(forKey: presetKey) else { return nil }
        switch raw {
        case "production": return kind == .api ? productionEndpoints.api : productionEndpoints.websocket
        case "test": return kind == .api ? developmentEndpoints.api : developmentEndpoints.websocket
        case "custom":
            let value = UserDefaults.standard.string(forKey: customKey)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            return value.isEmpty ? nil : value
        default: return nil
        }
    }
}

@MainActor @Observable
final class DebugEnvironmentSettings {
    static let shared = DebugEnvironmentSettings()

    var preset: DebugEnvironmentPreset { didSet { DebugEnvironmentStore.preset = preset } }
    var customBaseURL: String { didSet { DebugEnvironmentStore.customBaseURL = customBaseURL } }
    var advancedEnabled: Bool { didSet { DebugEnvironmentStore.advancedEnabled = advancedEnabled } }
    var advancedAPIURL: String { didSet { DebugEnvironmentStore.setAdvancedURL(advancedAPIURL, for: .api) } }
    var advancedWSURL: String { didSet { DebugEnvironmentStore.setAdvancedURL(advancedWSURL, for: .websocket) } }
    var advancedWebURL: String { didSet { DebugEnvironmentStore.setAdvancedURL(advancedWebURL, for: .web) } }
    var advancedCentrifugoURL: String { didSet { DebugEnvironmentStore.setAdvancedURL(advancedCentrifugoURL, for: .centrifugo) } }
    var isDebugSwiftVisible: Bool {
        didSet {
            DebugEnvironmentStore.isDebugSwiftVisible = isDebugSwiftVisible
            DebugTools.setFloatingWindowVisible(isDebugSwiftVisible)
        }
    }

    private init() {
        preset = DebugEnvironmentStore.preset
        customBaseURL = DebugEnvironmentStore.customBaseURL
        advancedEnabled = DebugEnvironmentStore.advancedEnabled
        advancedAPIURL = DebugEnvironmentStore.advancedURL(for: .api)
        advancedWSURL = DebugEnvironmentStore.advancedURL(for: .websocket)
        advancedWebURL = DebugEnvironmentStore.advancedURL(for: .web)
        advancedCentrifugoURL = DebugEnvironmentStore.advancedURL(for: .centrifugo)
        isDebugSwiftVisible = DebugEnvironmentStore.isDebugSwiftVisible
    }

    var effectiveAPIBaseURL: String { AppConfig.apiBaseURL }
    var effectiveWSBaseURL: String { AppConfig.wsBaseURL }
    var effectiveWebBaseURL: String { AppConfig.webBaseURL }
    var effectiveCentrifugoURL: String { AppConfig.centrifugoWSURL }

    func applyNetworkingAndQuit() { terminateAppAfterSaving() }

    func resetNetworkingAndQuit() {
        DebugEnvironmentStore.reset()
        SentryDSN.stored = ""
        SentryReporter.apply(dsn: "", persist: false)
        preset = DebugEnvironmentStore.preset
        customBaseURL = ""
        advancedEnabled = false
        advancedAPIURL = ""
        advancedWSURL = ""
        advancedWebURL = ""
        advancedCentrifugoURL = ""
        terminateAppAfterSaving()
    }

    private func terminateAppAfterSaving() {
        DebugEnvironmentStore.flush()
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) { Darwin.exit(0) }
    }
}
