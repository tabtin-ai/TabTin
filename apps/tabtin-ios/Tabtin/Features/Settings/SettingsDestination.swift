import Foundation

/// 设置 redesign 后的导航目的地（阶段 0 纯数据；UI 接线留给后续阶段）。
enum SettingsDestination: String, CaseIterable, Hashable, Sendable {
    // MARK: - 「我的」
    case meProfileHeader
    case meOrganizationIdentityCard
    case meBioHiddenPassphrase

    // MARK: - 设置首页 · 个人
    case settingsPersonalAccountInfo
    case settingsPersonalChangePassword
    case settingsPersonalAppearance
    case settingsPersonalSystemPermissions
    case settingsPersonalVoiceHabits
    case settingsPersonalPrivacyAndData

    // MARK: - 设置首页 · 组织
    case settingsOrganizationSummary
    case settingsOrganizationSettingsEntry

    // MARK: - 设置首页 · 设备
    case settingsDeviceInfo
    case settingsDeviceDiagnostics
    case settingsDeviceAbout
    case settingsDeviceDebugEnvironment
    case settingsDeviceLogout
}

/// 账号级全局导航目的地（通知深链、旧 Profile 路由迁移）。
enum AccountGlobalDestination: String, CaseIterable, Hashable, Sendable {
    case me
    case settings
    /// 账户侧栏打开并聚焦组织切换（全局动作，非 Settings 组织摘要）。
    case accountDrawerOrganizationSwitcher
    case organizationInvitation
    case projectInvitationPassthrough
}

/// 旧 Profile / 通知 target → 新全局目的地。
enum AccountGlobalDestinationResolver {
    enum LegacyRoute: String, CaseIterable, Sendable {
        case legacyProfile
        case profileSettings
        case settings
        case organizationInvitation
        case projectInvitation
    }

    static func resolve(legacyRoute: LegacyRoute) -> AccountGlobalDestination {
        switch legacyRoute {
        case .legacyProfile:
            return .me
        case .profileSettings, .settings:
            return .settings
        case .organizationInvitation:
            return .organizationInvitation
        case .projectInvitation:
            return .projectInvitationPassthrough
        }
    }

    static func resolve(notificationTarget: MobileNotificationTarget) -> AccountGlobalDestination? {
        switch notificationTarget {
        case .invitation:
            return .organizationInvitation
        case .profileSettings:
            return .settings
        case .chatSession, .imConversation, .tracker, .app, .sharedResource, .resourceAccessRequest,
             .notificationPanel, .unsupported:
            return nil
        }
    }
}
