import SwiftUI

/// 主导航的一等工作域。
///
/// `recent` 与 `profile` 仅供历史概念夹具 / 程序化目的地使用，不进入系统 Tab。
/// `automation` 已收进任务域右上角入口，不再占一级 Tab。
/// 消息与项目是两个互不依赖的工作面：消息看人与会话，项目看协作场景与任务，
/// 不再共用一个「协作」壳和二级分段。
///
/// 项目入口暂时不上线——保留 `projects` case 与实现，只从 ``primaryTabs`` 拿掉；
/// 恢复时把 `.projects` 加回即可。其余一级入口由 iOS 18 `TabView` 同时适配
/// iPhone 底栏与 iPad 侧栏。
enum MainNavTab: String, Hashable, Identifiable, CaseIterable, Sendable {
    case tasks
    case cloudDocs
    case automation
    case agents
    case messages
    case projects

    /// 非一级入口，不出现在系统 Tab。
    case recent
    case profile

    var id: String { rawValue }

    static let primaryTabs: [MainNavTab] = [
        .tasks,
        .cloudDocs,
        .agents,
        .messages,
        // `.projects` 暂时屏蔽，功能未上线。
    ]
    static let hiddenTabs: [MainNavTab] = [.recent, .profile, .projects]

    var isPrimary: Bool {
        Self.primaryTabs.contains(self)
    }

    var title: String {
        switch self {
        case .tasks: return L10n.Common.tabHome
        case .cloudDocs: return L10n.Common.tabCloudDocs
        case .automation: return L10n.Common.tabAutomation
        case .agents: return L10n.Common.tabAgents
        case .messages: return L10n.Common.tabMessages
        case .projects: return L10n.Common.tabProjects
        case .recent: return L10n.Common.tabRecent
        case .profile: return L10n.Profile.title
        }
    }

    /// 系统图标用于非一级入口和占位视图。
    var icon: String {
        switch self {
        case .tasks: return "checklist"
        case .cloudDocs: return "icloud"
        case .automation: return "clock.arrow.circlepath"
        case .agents: return "person.crop.circle.badge.checkmark"
        case .messages: return "bubble.left.and.bubble.right"
        case .projects: return "folder"
        case .recent: return "bubble.left.and.bubble.right"
        case .profile: return "person.crop.circle"
        }
    }

    /// 一级导航的品牌模板图标。
    ///
    /// 图形由产品语义决定，但仍以 template image 交给系统 Tab：
    /// iPhone 的 Liquid Glass 选中态、iPad 侧栏、深色模式与辅助功能颜色
    /// 继续由系统统一处理。
    var iconAsset: String {
        switch self {
        case .tasks: return "MainNavTasks"
        case .cloudDocs: return "MainNavCloudDocs"
        case .automation: return "MainNavAutomation"
        case .agents: return "MainNavAgents"
        case .messages: return "MainNavMessages"
        case .projects: return "MainNavProjects"
        case .recent: return "LucideMessageSquare"
        case .profile: return "LucideContactRound"
        }
    }

    /// 恢复 iOS 18 Scene 时只接受一级入口，并迁移旧版本保存过的 raw value。
    ///
    /// 云文档入口先后以 `cloud`、`apps` 两个 raw value 发布过，两者都要落到
    /// `.cloudDocs`，否则升级用户冷启会掉回任务页。
    ///
    /// `collaboration` 是消息 / 项目合并期的壳：它本身不再是工作面，必须结合当时
    /// 保存的二级分段还原成对应的一级 Tab，用户才会回到自己上次真正停留的页面。
    /// 项目入口暂时屏蔽时，存过 `projects` / collaboration→projects 的用户落到消息，
    /// 避免冷启落到一个已从底栏消失的 Tab。
    static func restoration(
        forStoredRawValue rawValue: String,
        legacyCollaborationSectionRawValue: String = ""
    ) -> MainNavTab? {
        if let tab = MainNavTab(rawValue: rawValue), tab.isPrimary {
            return tab
        }
        switch rawValue {
        case "home":
            return .tasks
        case "cloud", "apps":
            return .cloudDocs
        case "projects":
            return Self.primaryTabs.contains(.projects) ? .projects : .messages
        case "collaboration":
            if legacyCollaborationSectionRawValue == "projects" {
                return Self.primaryTabs.contains(.projects) ? .projects : .messages
            }
            return .messages
        case "agent":
            return .agents
        case "automation":
            return .tasks
        default: return nil
        }
    }

    static func primaryTab(restoring rawValue: String) -> MainNavTab? {
        restoration(forStoredRawValue: rawValue)
    }
}

/// SceneStorage 只在没有更高优先级导航意图时恢复。
/// 返回 nil 表示保留 Router 当前状态，避免 pending 已被子根消费后又被旧 Scene 覆盖。
enum MainNavigationRestorePolicy {
    static func restoration(
        storedTabRawValue: String,
        storedCollaborationSectionRawValue: String,
        currentTab: MainNavTab,
        hasPendingNavigation: Bool,
        programmaticNavigationRevision: UInt64
    ) -> MainNavTab? {
        guard !hasPendingNavigation,
              programmaticNavigationRevision == 0,
              currentTab == .tasks else {
            return nil
        }

        return MainNavTab.restoration(
            forStoredRawValue: storedTabRawValue,
            legacyCollaborationSectionRawValue: storedCollaborationSectionRawValue
        ) ?? .tasks
    }
}
