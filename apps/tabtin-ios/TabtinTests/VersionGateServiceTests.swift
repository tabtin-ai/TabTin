import XCTest
@testable import Tabtin

/// 回归：强更绝不因缓存 / 网络失败把 App 变砖。
/// 强更（不可关闭全屏拦截）只认本次会话实时拿到的 force 决策；缓存里的 force 不得拦人。
@MainActor
final class VersionGateServiceTests: XCTestCase {
    private let cacheKey = "version_gate_last_decision"
    private let dismissedKey = "version_gate_dismissed_soft_build"

    private func makeDefaults() -> UserDefaults {
        let suite = "vgtest.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defaults.removePersistentDomain(forName: suite)
        return defaults
    }

    private func seedCache(_ defaults: UserDefaults, _ decision: VersionGateDecision) {
        let data = try! JSONEncoder().encode(decision)
        defaults.set(data, forKey: cacheKey)
    }

    /// 核心回归：缓存里是 force 时，未经实时确认不得触发强更拦截。
    /// 否则服务端停用策略 / 用户离线时，曾拿过一次 force 的旧客户端会永久变砖。
    func testCachedForceDoesNotBlockBeforeLiveConfirmation() {
        let defaults = makeDefaults()
        seedCache(defaults, VersionGateDecision(action: "force", title: "必须更新", latestBuild: 200))

        let service = VersionGateService(defaults: defaults)

        XCTAssertFalse(service.isDecisionLive, "缓存决策不是实时的")
        XCTAssertFalse(service.shouldForceUpdate, "缓存 force 不应拦人（否则离线/停用后变砖）")
    }

    /// 软提示可关闭、无变砖风险：允许用缓存决策展示以保持连续性。
    func testCachedSoftStillPromptsFromCache() {
        let defaults = makeDefaults()
        seedCache(defaults, VersionGateDecision(action: "soft", latestBuild: 200))

        let service = VersionGateService(defaults: defaults)

        XCTAssertTrue(service.shouldSoftPrompt, "缓存 soft 应可展示（可关闭）")
        XCTAssertFalse(service.shouldForceUpdate)
    }

    /// 「稍后」去重：关过的 latestBuild 不再弹；后端下发更高 latestBuild 才重弹。
    func testDismissedSoftBuildSuppressesSameVersion() {
        let defaults = makeDefaults()
        defaults.set(200, forKey: dismissedKey)
        seedCache(defaults, VersionGateDecision(action: "soft", latestBuild: 200))

        let service = VersionGateService(defaults: defaults)
        XCTAssertFalse(service.shouldSoftPrompt, "同一 latestBuild 关过后不再弹")

        // 更高版本应重新提示。
        seedCache(defaults, VersionGateDecision(action: "soft", latestBuild: 300))
        let newer = VersionGateService(defaults: defaults)
        XCTAssertTrue(newer.shouldSoftPrompt, "更高 latestBuild 应重新提示")
    }

    /// 无缓存 + 未刷新（等价冷启动断网）：一律放行，不拦。
    func testNoCacheNoDecisionMeansNoGate() {
        let service = VersionGateService(defaults: makeDefaults())
        XCTAssertNil(service.decision)
        XCTAssertFalse(service.shouldForceUpdate)
        XCTAssertFalse(service.shouldSoftPrompt)
    }
}
