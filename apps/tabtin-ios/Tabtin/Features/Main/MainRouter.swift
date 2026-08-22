import Foundation
import SwiftUI

/// 资源导航目标。
///
/// 通知等可信入口可仅凭 Organization + resource 定位内容，host 只是可选展示上下文。
/// 外部链接仍由 `ResourceDeepLinkParser` 强制校验 Organization + legacy Space，避免
/// 在当前登录账号的默认上下文里误开另一个租户的资源。
struct ResourceDeepLinkTarget: Identifiable, Hashable, Sendable {
    let resourceType: String
    let resourceId: String
    let title: String?
    let locationHint: String?
    let organizationId: String
    let spaceId: String?

    var id: String {
        "\(organizationId):\(spaceId ?? ""):\(resourceType):\(resourceId)"
    }
}

/// 自动化通知 / 深链解析后的完整导航目标。
///
/// Tracker 属于具体 Organization + Workspace；缺少上下文时调用方应留在通知页
/// 给出恢复提示，而不是用当前默认 Workspace 猜测目标。
struct AutomationDeepLinkTarget: Identifiable, Hashable, Sendable {
    let organizationId: String
    let spaceId: String
    let trackerId: String
    let runId: String?

    var id: String {
        "\(organizationId):\(spaceId):\(trackerId):\(runId ?? "")"
    }
}

enum ResourceDeepLinkParseResult: Equatable, Sendable {
    case target(ResourceDeepLinkTarget)
    case missingContext
}

/// 每个顶层 Tab 各自持有 NavigationStack；个人页作为可压入这些栈的统一目的地。
enum ProfileRoute: Hashable {
    case profile
}

/// 已由一级页面 push 的通知中心目的地。
enum NotificationCenterRoute: Hashable {
    case center
}

enum ResourceDeepLinkParser {
    static func parse(_ url: URL) -> ResourceDeepLinkParseResult? {
        let pathSegments: [String]
        switch url.scheme?.lowercased() {
        case "tabtin":
            guard let host = url.host else { return nil }
            pathSegments = [host] + url.pathComponents.dropFirst()
        case "https", "http":
            guard let host = url.host?.lowercased(),
                  host == "example.com" || host.hasSuffix(".example.com") else { return nil }
            pathSegments = Array(url.pathComponents.dropFirst())
        default:
            return nil
        }

        guard pathSegments.first == "resource",
              pathSegments.count >= 3,
              let rawType = nonEmpty(pathSegments[1]),
              let resourceId = nonEmpty(pathSegments[2].removingPercentEncoding ?? pathSegments[2]) else {
            return nil
        }

        let components = URLComponents(url: url, resolvingAgainstBaseURL: false)
        let query = Dictionary(
            components?.queryItems?.compactMap { item in
                item.value.map { (item.name, $0) }
            } ?? [],
            uniquingKeysWith: { first, _ in first }
        )
        let organizationId = firstNonEmpty(query, keys: [
            "organization_id", "organizationId", "workspace_id", "workspaceId",
        ])
        let spaceId = firstNonEmpty(query, keys: ["space_id", "spaceId"])
        guard let organizationId, let spaceId else { return .missingContext }

        let hint = nonEmpty(query["hint"] ?? nil)?.lowercased()
        let hintedTypes: Set<String> = [
            "tabdoc", "tabdata", "tabslide", "tabsite", "tabmemo", "tabfiles",
        ]
        let resourceType: String
        if let hint, hintedTypes.contains(hint) {
            resourceType = hint
        } else {
            switch rawType.lowercased() {
            case "doc_selection", "document_selection": resourceType = "tabdoc"
            default: resourceType = SpaceResource.normalizedType(rawType.lowercased())
            }
        }

        return .target(ResourceDeepLinkTarget(
            resourceType: resourceType,
            resourceId: resourceId,
            title: firstNonEmpty(query, keys: ["title", "resource_name", "label"]),
            locationHint: firstNonEmpty(query, keys: ["location_hint", "locationHint"]),
            organizationId: organizationId,
            spaceId: spaceId
        ))
    }

    private static func firstNonEmpty(_ query: [String: String], keys: [String]) -> String? {
        keys.lazy.compactMap { nonEmpty(query[$0] ?? nil) }.first
    }

    private static func nonEmpty(_ value: String?) -> String? {
        guard let value = value?.trimmingCharacters(in: .whitespacesAndNewlines),
              !value.isEmpty else { return nil }
        return value
    }
}

/// 主界面级路由：tab 选择 + 跨 tab 打开会话的待办目标。
/// ComposeSheet 发送对话后，经此切到任务首页并打开新会话。
@MainActor @Observable
final class MainRouter {
    static let shared = MainRouter()

    var selectedTab: MainNavTab = .tasks
    /// 每次用户进入（含再次点按）消息域时递增。消息根页面据此刷新会话列表，
    /// 不能只依赖 selectedTab 的值变化，因为重复点按当前 Tab 不会触发值变化。
    private(set) var messagesTabActivationID = 0
    /// 每次跨域程序化导航递增。SceneStorage 恢复只能在该值仍为初始值时生效，
    /// 避免子根先消费 pending、父根随后用旧 Scene 覆盖新导航意图。
    private(set) var programmaticNavigationRevision: UInt64 = 0
    /// 待首页 / 工作 tab 消费的会话目标（来自新建入口 / 程序化跳转）。消费后置空。
    var pendingConversation: ConversationTarget?
    /// 待消息页消费的 IM 会话目标；通知等跨 tab 入口使用，消费后置空。
    var pendingIMConversation: IMConversationTarget?
    /// Workspace 卡的 `space_id` 待 AI 分身根消费；它不是 Agent ID。
    var pendingWorkspaceId: String?
    /// 外部链接目标必须跨登录、Organization 初始化保留，直到云端页成功消费。
    var pendingResource: ResourceDeepLinkTarget?
    /// 每次收到外部资源链接都递增。即使用户再次打开的是同一条链接，也要重新
    /// 触发处理，以便从临时的组织列表加载失败中恢复。
    private(set) var resourceNavigationRevision: UInt64 = 0
    /// 待自动化一级入口消费的 Tracker / Run 目标；消费成功后置空。
    var pendingAutomation: AutomationDeepLinkTarget?
    /// 根界面统一承载跨 Tab 导航反馈，避免目标页尚未挂载时提示丢失。
    var navigationNotice: String?
    /// 各一级根上报的 NavigationStack 深度快照。
    /// 系统 Tab 自己负责呈现；这里保留跨根导航状态与诊断契约。
    private(set) var tabsWithPushedChild: Set<MainNavTab> = []

    private init() {}

    var selectedTabHasPushedChild: Bool {
        tabsWithPushedChild.contains(selectedTab)
    }

    func setTabPushed(_ tab: MainNavTab, pushed: Bool) {
        // 必须整体赋值：对 Set 原地 insert/remove 不会走 @Observable 的属性写路径，
        // MainTabView 读 selectedTabHasPushedChild 时就不会刷新，对话页底栏会常驻。
        var next = tabsWithPushedChild
        if pushed {
            next.insert(tab)
        } else {
            next.remove(tab)
        }
        guard next != tabsWithPushedChild else { return }
        tabsWithPushedChild = next
    }

    /// 统一处理系统 Tab 选择；消息即使已处于选中状态，也视为一次重新进入。
    func selectTab(_ tab: MainNavTab) {
        guard tab.isPrimary else { return }
        selectedTab = tab
        if tab == .messages {
            messagesTabActivationID &+= 1
        }
    }

    /// 切到指定 tab 并打开会话（默认任务首页）。
    func openConversation(_ target: ConversationTarget, tab: MainNavTab = .tasks) {
        guard tab.isPrimary else { return }
        recordProgrammaticNavigation()
        pendingConversation = target
        selectTab(tab)
    }

    /// 切到消息 Tab 并打开指定 IM 会话。
    func openIMConversation(_ target: IMConversationTarget) {
        recordProgrammaticNavigation()
        pendingIMConversation = target
        // 无论此前是否已停在消息页，都按一次重新进入处理，列表和未读随之刷新。
        selectTab(.messages)
    }

    func openWorkspace(_ spaceId: String) {
        let normalized = spaceId.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalized.isEmpty else { return }
        recordProgrammaticNavigation()
        pendingWorkspaceId = normalized
        selectTab(.agents)
    }

    func consumeWorkspace(_ spaceId: String) {
        if pendingWorkspaceId == spaceId {
            pendingWorkspaceId = nil
        }
    }

    func openResource(_ target: ResourceDeepLinkTarget) {
        recordProgrammaticNavigation()
        resourceNavigationRevision &+= 1
        pendingResource = target
        selectTab(.cloudDocs)
    }

    func consumeResource(_ target: ResourceDeepLinkTarget) {
        if pendingResource == target {
            pendingResource = nil
        }
    }

    func openAutomation(_ target: AutomationDeepLinkTarget) {
        recordProgrammaticNavigation()
        pendingAutomation = target
        selectTab(.tasks)
    }

    func consumeAutomation(_ target: AutomationDeepLinkTarget) {
        if pendingAutomation == target {
            pendingAutomation = nil
        }
    }

    func presentNavigationNotice(_ message: String) {
        navigationNotice = message
    }

    private func recordProgrammaticNavigation() {
        programmaticNavigationRevision &+= 1
    }
}
