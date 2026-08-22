import Foundation
import os

/// 后端 `/client/version-gate` 返回的门禁决策（`{success,data}` 解包后的 data）。
/// action 保留为 String，未知取值按放行（none）处理，避免解码失败把门禁误触发。
struct VersionGateDecision: Codable, Sendable, Equatable {
    let action: String
    let storeURL: String
    let title: String
    let message: String
    let latestVersion: String
    /// 最新 build 号；作为软提示「稍后」去重键：同一 latestBuild 关一次后不再弹。
    let latestBuild: Int

    enum CodingKeys: String, CodingKey {
        case action
        case storeURL = "store_url"
        case title
        case message
        case latestVersion = "latest_version"
        case latestBuild = "latest_build"
    }

    init(
        action: String,
        storeURL: String = "",
        title: String = "",
        message: String = "",
        latestVersion: String = "",
        latestBuild: Int = 0
    ) {
        self.action = action
        self.storeURL = storeURL
        self.title = title
        self.message = message
        self.latestVersion = latestVersion
        self.latestBuild = latestBuild
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        action = try container.decodeIfPresent(String.self, forKey: .action) ?? "none"
        storeURL = try container.decodeIfPresent(String.self, forKey: .storeURL) ?? ""
        title = try container.decodeIfPresent(String.self, forKey: .title) ?? ""
        message = try container.decodeIfPresent(String.self, forKey: .message) ?? ""
        latestVersion = try container.decodeIfPresent(String.self, forKey: .latestVersion) ?? ""
        latestBuild = try container.decodeIfPresent(Int.self, forKey: .latestBuild) ?? 0
    }

    var isForce: Bool { action == "force" }
    var isSoft: Bool { action == "soft" }

    /// iOS 默认更新地址（App Store 页）。后端 store_url 留空时回退到此，
    /// 保证「去更新」始终可点，绝不因漏配置把用户卡死。
    static let defaultStoreURL = "https://apps.apple.com/app/id6788277571"

    /// 实际跳转地址：优先用后端下发的 store_url，为空则回退本地默认。
    var resolvedStoreURL: String {
        storeURL.isEmpty ? Self.defaultStoreURL : storeURL
    }
}

/// 移动端版本门禁：冷启动查询后端，按 build 号决定是否强制/推荐更新。
///
/// 设计要点：
/// - 匿名请求（`authentication: .none`），登录前就能拦；
/// - **失败放行 / 绝不因网络问题变砖**：强更（不可关闭全屏拦截）**只认本次会话实时
///   拿到的服务端决策**，缓存里的 force 一律不用于拦截。冷启动断网/超时 → 没有实时
///   决策 → 直接放行进入 App；后端一旦停用策略，用户在线时即可被救援，不会被旧的
///   force 缓存永久卡死；
/// - **缓存仅服务软提示连续性**：成功决策持久化到 UserDefaults，离线时可沿用上次的
///   soft 提示（可关闭，无变砖风险），并保留「稍后」去重记忆；
/// - 由后端算出 action，客户端只执行不自比版本。
@MainActor
@Observable
final class VersionGateService {
    static let shared = VersionGateService()

    private(set) var decision: VersionGateDecision?
    /// 当前 `decision` 是否来自本次会话的实时成功请求（而非缓存）。
    /// 强更拦截严格要求实时决策：缓存的 force 不得拦人，避免离线/后端已停用时变砖。
    private(set) var isDecisionLive = false
    /// 已被用户点「稍后」关闭过的软提示 latestBuild；持久化，跨冷启动生效。
    /// 后端下发更高的 latestBuild（更新的版本）时才会再次提示。
    private var dismissedSoftBuild: Int

    private var hasCheckedOnColdLaunch = false
    private let logger = Logger(subsystem: "com.tabtin.mobile", category: "VersionGate")
    private let cacheKey = "version_gate_last_decision"
    private let dismissedSoftBuildKey = "version_gate_dismissed_soft_build"
    private let defaults: UserDefaults

    /// 生产用单例走 `.standard`；测试可注入独立 `UserDefaults` 以隔离缓存。
    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        dismissedSoftBuild = defaults.integer(forKey: dismissedSoftBuildKey)
        decision = Self.loadCachedDecision(from: defaults, key: cacheKey)
        // 缓存决策不是实时的：即便缓存里是 force 也不拦人。
        isDecisionLive = false
    }

    func checkOnColdLaunch() async {
        guard !hasCheckedOnColdLaunch else { return }
        hasCheckedOnColdLaunch = true
        await refresh()
    }

    func refresh() async {
        let build = Int(AppConfig.buildNumber) ?? 0
        do {
            let result: VersionGateDecision = try await APIClient.shared.request(
                "GET",
                path: Endpoints.Client.versionGate,
                query: ["platform": "ios", "build": String(build)],
                authentication: .none
            )
            decision = result
            isDecisionLive = true
            cacheDecision(result)
        } catch {
            // 失败放行：不把缓存决策升级为实时；强更绝不因接口不可用触发。
            logger.warning("version gate check failed: \(error.localizedDescription)")
        }
    }

    /// 强更仅在「本次会话实时拿到 force」时成立；缓存 force 一律不拦。
    var shouldForceUpdate: Bool { isDecisionLive && decision?.isForce == true }

    /// 软提示是否应展示：action=soft，且这个 latestBuild 还没被用户关过。
    /// 软提示可关闭、无变砖风险，允许用缓存决策展示以保持连续性。
    var shouldSoftPrompt: Bool {
        guard let decision, decision.isSoft else { return false }
        return decision.latestBuild > dismissedSoftBuild
    }

    /// 用户对当前软提示点了「稍后」/「去更新」：记住这个 latestBuild，不再重复弹。
    func dismissSoftPrompt() {
        guard let decision, decision.isSoft else { return }
        dismissedSoftBuild = max(dismissedSoftBuild, decision.latestBuild)
        defaults.set(dismissedSoftBuild, forKey: dismissedSoftBuildKey)
    }

    // MARK: - 持久化缓存

    private static func loadCachedDecision(from defaults: UserDefaults, key: String) -> VersionGateDecision? {
        guard let data = defaults.data(forKey: key) else { return nil }
        return try? JSONDecoder().decode(VersionGateDecision.self, from: data)
    }

    private func cacheDecision(_ decision: VersionGateDecision) {
        guard let data = try? JSONEncoder().encode(decision) else { return }
        defaults.set(data, forKey: cacheKey)
    }
}
