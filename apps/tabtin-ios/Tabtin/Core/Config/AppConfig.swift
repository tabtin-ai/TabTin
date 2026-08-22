import Foundation

/// 运行时环境配置（API / WS / Web base URL）。
/// 取值优先级：Debug 环境组覆盖 → 编译期默认。自定义基础地址会为四条链路生成同源 URL，
/// 需要拆分主机时再由 Debug 页的高级覆盖逐项指定。
enum AppConfig {
    static let productionAPIBaseURL = "https://api.example.com/api"
    static let productionWSBaseURL = "wss://api.example.com/ws/v1/gateway"
    static let productionWebBaseURL = "https://web.example.com"
    static let testAPIBaseURL = "https://api-test.example.com/api"
    static let testWSBaseURL = "wss://api-test.example.com/ws/v1/gateway"
    static let testWebBaseURL = "https://web-test.example.com"
    /// 本地 dev 栈（对齐根 `.env`：Django 6060 / tabtin-web 5176 / Centrifugo 8100 由 API 推导）。
    static let localDevAPIBaseURL = "http://127.0.0.1:6060/api"
    static let localDevWebBaseURL = "http://127.0.0.1:5176"
    // Centrifugo（TabChat IM 实时）与 API/Gateway 不同主机，独立域名。
    static let productionCentrifugoWSURL = "wss://centrifugo.example.com/connection/websocket"
    static let testCentrifugoWSURL = "wss://centrifugo-test.example.com/connection/websocket"

    static var configuredAPIBaseURL: String {
        #if DEBUG
        return testAPIBaseURL
        #else
        return productionAPIBaseURL
        #endif
    }

    static var configuredWSBaseURL: String {
        #if DEBUG
        return testWSBaseURL
        #else
        return productionWSBaseURL
        #endif
    }

    static var configuredWebBaseURL: String {
        #if DEBUG
        return testWebBaseURL
        #else
        return productionWebBaseURL
        #endif
    }

    /// 当前 API 使用 HTTP（本地/LAN 联调）时允许 ws:// 与非 TLS REST。
    static var allowsLocalCleartextNetworking: Bool {
        URLComponents(string: apiBaseURL)?.scheme?.lowercased() == "http"
    }

    static var apiBaseURL: String {
        DebugEnvironmentStore.effectiveOverrideURL(for: .api) ?? configuredAPIBaseURL
    }

    /// 是否为编译期内建 API（test / production）。自定义（本地/LAN 联调）地址返回 false。
    private static func isBuiltInAPI(_ url: String) -> Bool {
        url == testAPIBaseURL || url == productionAPIBaseURL
    }

    /// 从 API base URL 推导同主机的 WS 地址：http→ws / https→wss；`port` 传 nil 沿用 API 端口。
    /// 用于自定义（本地/LAN）API 时，让网关 WS 与 Centrifugo 跟随同一后端主机，
    /// 避免回落到编译期 test 地址导致实时链路连错后端（本地签发 token 会被远程 proxy 拒绝）。
    private static func deriveWSURL(fromAPI api: String, port: Int?, path: String) -> String? {
        guard let comps = URLComponents(string: api), let host = comps.host else { return nil }
        let wsScheme = (comps.scheme == "https") ? "wss" : "ws"
        var result = "\(wsScheme)://\(host)"
        if let effectivePort = port ?? comps.port { result += ":\(effectivePort)" }
        result += path
        return result
    }

    static var wsBaseURL: String {
        if let override = DebugEnvironmentStore.effectiveOverrideURL(for: .websocket) {
            return override
        }
        let api = apiBaseURL
        // 自定义 API 且未单独设 WS 覆盖：网关 WS 跟随 API 同主机同端口。
        if !isBuiltInAPI(api), let derived = deriveWSURL(fromAPI: api, port: nil, path: "/ws/v1/gateway") {
            return derived
        }
        return configuredWSBaseURL
    }

    static var webBaseURL: String {
        DebugEnvironmentStore.effectiveOverrideURL(for: .web) ?? configuredWebBaseURL
    }

    static var configuredCentrifugoWSURL: String {
        #if DEBUG
        testCentrifugoWSURL
        #else
        productionCentrifugoWSURL
        #endif
    }

    /// TabChat IM 的 Centrifugo 连接地址。Centrifugo 与 API 是不同主机，
    /// 故跟随当前 API 环境推导：Debug 面板切 test/prod 时自动对应；
    /// custom API（自定义地址）时回落编译期默认。
    static var centrifugoWSURL: String {
        if let override = DebugEnvironmentStore.effectiveOverrideURL(for: .centrifugo) {
            return normalizedCentrifugoURL(override, forAPI: apiBaseURL)
        }
        switch apiBaseURL {
        case testAPIBaseURL: return testCentrifugoWSURL
        case productionAPIBaseURL: return productionCentrifugoWSURL
        default:
            // 自定义 API（本地/LAN）：Centrifugo 跟随同主机的固定 8100 端口；
            // 推导失败才回落编译期默认。修复此前自定义 API 下错连 test centrifugo 的问题。
            return deriveWSURL(fromAPI: apiBaseURL, port: 8100, path: "/connection/websocket")
                ?? configuredCentrifugoWSURL
        }
    }

    /// 早期本地二维码可能把 Django 6060 误写成 Centrifugo 端口。只迁移这一种
    /// 标准本地拓扑；其他自定义端口仍可继续承载同源反向代理。
    static func normalizedCentrifugoURL(_ rawURL: String, forAPI apiURL: String) -> String {
        guard let api = URLComponents(string: apiURL),
              api.port == 6060,
              var centrifugo = URLComponents(string: rawURL),
              centrifugo.port == 6060,
              api.host?.lowercased() == centrifugo.host?.lowercased(),
              centrifugo.path.hasSuffix("/connection/websocket") else {
            return rawURL
        }
        centrifugo.port = 8100
        return centrifugo.url?.absoluteString ?? rawURL
    }

    /// 健康检查 URL：API 主机根路径下的 /health（与后端 `curl /health → healthy` 对齐）。
    static var healthURL: String { apiBaseURL.replacingOccurrences(of: "/api", with: "/health") }

    static let appVersion = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "1.0.0"
    static let buildNumber = Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? "1"
}
