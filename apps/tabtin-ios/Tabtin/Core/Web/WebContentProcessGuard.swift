import Foundation
import Sentry
import os

/// WKWebView 的 Web 内容进程终止（`WKNavigationDelegate.webViewWebContentProcessDidTerminate`）
/// 的统一兜底。
///
/// **为什么每个 WKWebView 宿主都必须接**：iOS 内存紧张时会杀掉 WKWebView 的 Web 内容进程。
/// 和 Android 不同，系统**不会**连带杀掉 App——代价换成了另一种：那个 WKWebView 就地变成
/// 一张永久空白的视图，不抛错、不回调任何 `didFail*`、也不会自己恢复。宿主不接这个回调，
/// 用户侧就是「页面突然全白，没有任何提示，退出重进才好」。前台可见的 WebView 一样会中招。
///
/// **处理口径（三步，缺一不可）**：
///  1. 上报（本文件）：Sentry 事件带 `handled_by=ios_web_content_process_terminated`，
///     宿主名走 fingerprint 分组；同宿主 60s 限频一条，防止内存持续紧张时刷屏；
///  2. 宿主切降级 UI：给出「内容加载失败 + 重试」的可见出口（文案用
///     [terminatedMessage]），不留白屏；
///  3. 重试必须**重建实例**（见 [WebContentProcessRecovery]）：内容进程没了之后
///     `reload()` 常常什么都不做——back-forward list 已经空了，`loadHTMLString` 起家的
///     宿主更是连 URL 都没有。要么重新 `load(...)`，最稳的是让 SwiftUI 丢掉旧
///     `WKWebView` 整个重建（`.id(recovery.instanceId)`）。
///
/// **有意不自动重建**：内存压力常常持续几秒到几十秒，终止后立刻重建大概率再被杀，
/// 变成「白屏 → 重建 → 白屏」的抖动，还反过来加剧内存压力。默认等用户点重试；聊天流里
/// 没地方放重试按钮的内嵌小组件（mermaid）只给一次自愈机会，之后落到内容回退视图。
///
/// **Sentry 字段口径**遵循 `docs/agent/error-context-schema.md` 白名单：只用已登记的
/// `handled_by` 键（本文件即契约里说的「兜底层 handler」），宿主名走 fingerprint 分组而不
/// 新造 tag 键；领域字段（user / organization_id / space_id）由 `SentryContextProvider`
/// 统一写 scope。
@MainActor
enum WebContentProcessGuard {

    /// 宿主标识：只进日志 / Sentry fingerprint，不含任何用户内容。
    enum Host: String {
        case tabsiteViewer = "tabsite_viewer"
        case workbenchResource = "workbench_resource"
        case mermaidBlock = "mermaid_block"
        case formulaBlock = "formula_block"
        case loginMotion = "login_motion"
    }

    /// 宿主共用的降级文案。说清「是系统回收，不是你的网络坏了」，并指向重试入口。
    ///
    /// 走 `L10n` 而不是字面量：这句和 [WebHostLoadErrorView] 的标题、按钮同处一屏，
    /// 按钮已经是本地化的，正文再硬编码中文，英文环境下会拼出「中文正文 + Retry 按钮」的
    /// 混搭——比全中文更糟。
    static var terminatedMessage: String { L10n.ErrorRecovery.webContentProcessTerminated }

    /// Sentry 分组根：同一根 + 宿主名，保证不同宿主分开聚合、同一宿主不炸开。
    private static let fingerprintRoot = "ios-web-content-process-terminated"

    private static let logger = Logger(subsystem: "com.tabtin.mobile", category: "WebContentProcess")

    /// 同宿主上报最小间隔：内存紧张时多个 WebView 会被连着回收，不限频会把 Sentry 刷满。
    private static let reportInterval: TimeInterval = 60
    private static var lastReportedAt: [Host: Date] = [:]

    /// 在 `webViewWebContentProcessDidTerminate(_:)` 里调用。
    ///
    /// 只负责日志 + 上报：降级 UI 与重建时机是宿主的 `@State`，由宿主自己接
    /// （配 [WebContentProcessRecovery]）。
    static func handleTermination(host: Host) {
        logger.warning("web content process terminated: host=\(host.rawValue, privacy: .public)")
        report(host: host)
    }

    /// 限频判定（有副作用：判定通过即记为「已报」）。
    ///
    /// 抽出来是因为这层是内存持续紧张时防止 Sentry 被刷屏的唯一闸门，值得单测钉住：
    /// 一次内存尖峰可能连着回收好几个 WebView，宿主又会各自重试。
    static func shouldReport(host: Host, now: Date = Date()) -> Bool {
        if let last = lastReportedAt[host], now.timeIntervalSince(last) < reportInterval {
            return false
        }
        lastReportedAt[host] = now
        return true
    }

    private static func report(host: Host) {
        guard shouldReport(host: host) else { return }

        // 内容进程死在另一个进程里，Swift 侧没有真堆栈可抓，用固定 message + fingerprint
        // 给一个稳定可读的事件标题（真正的分组靠 fingerprint）。
        // level=warning：用户有降级 UI 和重试出口，不是崩溃，但需要能被搜到、能看趋势。
        let event = Sentry.Event(level: .warning)
        event.message = SentryMessage(
            formatted: "WKWebView web content process terminated (host=\(host.rawValue))"
        )
        event.fingerprint = [fingerprintRoot, host.rawValue]
        let bundleId = IOSDiagnosticRuntime.capture(
            category: "WEBVIEW_CRASH",
            code: "IOS_WEB_CONTENT_PROCESS_TERMINATED",
            handledBy: "ios_web_content_process_terminated"
        )
        event.tags = [
            "handled_by": "ios_web_content_process_terminated",
            "error_category": "WEBVIEW_CRASH",
            "error_code": "IOS_WEB_CONTENT_PROCESS_TERMINATED",
            "severity": "actionable",
            "recoverability": "degraded",
        ]
        event.context = ["tabtin": ["diagnostic_bundle_id": bundleId]]
        SentrySDK.capture(event: event)
    }

    #if DEBUG
    /// 单测用：清掉限频窗口，避免用例之间互相影响。
    static func resetReportThrottleForTesting() {
        lastReportedAt.removeAll()
    }
    #endif
}

/// 宿主侧的「内容进程终止」恢复状态，三处 WKWebView 宿主共用同一套口径。
///
/// 用法：宿主 `@State private var recovery = WebContentProcessRecovery()`，把
/// [instanceId] 挂到承载 WKWebView 的 `UIViewRepresentable` 上（`.id(recovery.instanceId)`）——
/// id 一变 SwiftUI 就 dismantle 旧实例、走一遍 `makeUIView` 重新 load，这是内容进程终止后
/// 唯一可靠的恢复路径。
struct WebContentProcessRecovery {

    /// 给 SwiftUI 的实例 id：变化即代表「丢掉旧 WKWebView，重建一个新的」。
    private(set) var instanceId = UUID()

    /// 当前实例是否已因内容进程终止而失效。宿主据此决定重试走重建还是普通重载。
    private(set) var isTerminated = false

    /// 自动自愈只给一次，见 [recoverAutomaticallyIfPossible]。
    private var autoRecoveryUsed = false

    /// 收到 `webViewWebContentProcessDidTerminate` 时记一笔。
    mutating func markTerminated() {
        isTerminated = true
    }

    /// 用户点「重试」时调用：换 id 触发重建，并解除终止态。
    mutating func recreate() {
        instanceId = UUID()
        isTerminated = false
    }

    /// 给没有重试按钮位置的宿主（聊天流内嵌小组件）用：第一次终止静默重建一次，
    /// 之后不再重试，交给宿主落到内容回退视图——避免内存持续紧张时反复重建打转。
    ///
    /// - Returns: `true` 表示这次已经触发重建，宿主可以继续等渲染结果。
    mutating func recoverAutomaticallyIfPossible() -> Bool {
        guard !autoRecoveryUsed else { return false }
        autoRecoveryUsed = true
        recreate()
        return true
    }
}
