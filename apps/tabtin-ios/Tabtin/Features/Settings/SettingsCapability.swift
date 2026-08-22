import Foundation

/// 设置能力归属域。
enum SettingsCapabilityOwnership: String, CaseIterable, Sendable {
    case profile
    case organization
    case device
    case me
}

/// 设置首页可见性。
enum SettingsCapabilityVisibility: Equatable, Hashable, Sendable {
    case visible(platform: SettingsPlatformScope)
    case excluded(reason: String)

    var isExcluded: Bool {
        if case .excluded = self { return true }
        return false
    }
}

enum SettingsPlatformScope: String, Sendable {
    case ios
    case android
    case both
}

/// 旧 ProfileScreen 可辨识条目（阶段 0 迁移真值表键）。
enum LegacyProfileCapability: String, CaseIterable, Sendable {
    case profileHeader
    case contactVerification
    case appearance
    case language
    case notificationPermission
    case notificationCategories
    case voiceHabits
    case organizationSwitcher
    case organizationSettings
    case organizationInvitationsInbox
    case accountStats
    case privacyAndData
    case accountDeletion
    case about
    case deviceInfo
    case debugEnvironment
    case logout
    case publicProfileShare
    case changePassword
    case rebindPhoneEmail
    case personalRules
    case defaultResourceOpenMode
    case uiFontSize
    case createOrganization
    case walletEntry
}

struct SettingsCapability: Identifiable, Hashable, Sendable {
    let id: String
    let ownership: SettingsCapabilityOwnership
    let destination: SettingsDestination?
    let visibility: SettingsCapabilityVisibility
    /// 可观测实现锚点（源码路径 / Store 类型），禁止仅用文案判断「已实现」。
    let implementationEvidence: [String]

    var idKey: String { id }
}

/// 移动端设置能力单一来源（阶段 0）。
enum SettingsCapabilityRegistry {
    static let all: [SettingsCapability] = [
        // MARK: - 「我的」
        capability(
            id: "me.profileHeader",
            ownership: .me,
            destination: .meProfileHeader,
            visibility: .visible(platform: .both),
            evidence: ["MeScreen.swift:profileHeader", "AuthService.currentUser"]
        ),
        capability(
            id: "me.organizationIdentityCard",
            ownership: .me,
            destination: .meOrganizationIdentityCard,
            visibility: .visible(platform: .both),
            evidence: ["WorkspaceStore.currentOrganization", "MeScreen.swift:organizationIdentityCard"]
        ),
        capability(
            id: "me.bioHiddenPassphrase",
            ownership: .me,
            destination: .meBioHiddenPassphrase,
            visibility: .excluded(reason: "隐藏口令已移除，Debug 页从设置与登录页直接进入。"),
            evidence: ["SettingsHomeScreen.swift", "LoginView.swift"]
        ),

        // MARK: - 设置 · 个人
        capability(
            id: "settings.personal.accountInfo",
            ownership: .profile,
            destination: .settingsPersonalAccountInfo,
            visibility: .visible(platform: .both),
            evidence: ["AuthService.currentUser", "ProfileScreen.swift:contactSection", "ProfileScreen.swift:accountStatsSection"]
        ),
        capability(
            id: "settings.personal.changePassword",
            ownership: .profile,
            destination: .settingsPersonalChangePassword,
            visibility: .visible(platform: .both),
            evidence: ["AuthService.changePassword", "ChangePasswordScreen.swift", "PasswordPolicy.swift"]
        ),
        capability(
            id: "settings.personal.appearance.ios",
            ownership: .profile,
            destination: .settingsPersonalAppearance,
            visibility: .visible(platform: .ios),
            evidence: ["ThemeManager.shared", "ColorSchemeStore", "LanguageManager.shared", "ProfileScreen.swift:appearance", "ProfileScreen.swift:language"]
        ),
        capability(
            id: "settings.personal.appearance.android",
            ownership: .profile,
            destination: .settingsPersonalAppearance,
            visibility: .visible(platform: .android),
            evidence: ["ThemeMode in ProfileViewModel", "ProfileScreen.kt:ThemeDropdownRow", "ProfileScreen.kt:LanguageDropdownRow", "AppLanguage preference"]
        ),
        capability(
            id: "settings.personal.systemPermissions",
            ownership: .profile,
            destination: .settingsPersonalSystemPermissions,
            visibility: .visible(platform: .both),
            evidence: ["NotificationSettingsScreen.swift", "ProfileScreen.kt notification intent"]
        ),
        capability(
            id: "settings.personal.voiceHabits",
            ownership: .profile,
            destination: .settingsPersonalVoiceHabits,
            visibility: .visible(platform: .ios),
            evidence: ["VoiceSettingsScreen.swift"]
        ),
        capability(
            id: "settings.personal.privacyAndData",
            ownership: .profile,
            destination: .settingsPersonalPrivacyAndData,
            visibility: .visible(platform: .both),
            evidence: ["PrivacySettingsScreen.swift", "AIDataSharingConsentStore (Android)"]
        ),

        // MARK: - 设置 · 组织
        capability(
            id: "settings.organization.summary",
            ownership: .organization,
            destination: .settingsOrganizationSummary,
            visibility: .visible(platform: .both),
            evidence: ["WorkspaceStore.currentOrganization"]
        ),
        capability(
            id: "settings.organization.settingsEntry",
            ownership: .organization,
            destination: .settingsOrganizationSettingsEntry,
            visibility: .visible(platform: .both),
            evidence: ["WorkspaceSettingsExtras.swift", "WorkspaceSettingsScreen.kt"]
        ),

        // MARK: - 设置 · 设备
        capability(
            id: "settings.device.info",
            ownership: .device,
            destination: .settingsDeviceInfo,
            visibility: .visible(platform: .both),
            evidence: ["ProfileScreen.swift:deviceInfoRow", "ProfileScreen.kt:DeviceInfoSection"]
        ),
        capability(
            id: "settings.device.diagnostics",
            ownership: .device,
            destination: .settingsDeviceDiagnostics,
            visibility: .visible(platform: .both),
            evidence: ["DiagnosticRecorder.swift", "SettingsDiagnosticsScreen.swift"]
        ),
        capability(
            id: "settings.device.about",
            ownership: .device,
            destination: .settingsDeviceAbout,
            visibility: .visible(platform: .both),
            evidence: ["AboutScreen.swift", "ProfileScreen.kt onNavigateToAbout"]
        ),
        capability(
            id: "settings.device.debugEnvironment",
            ownership: .device,
            destination: .settingsDeviceDebugEnvironment,
            visibility: .visible(platform: .both),
            evidence: ["DebugEnvironmentSettings.swift", "ProfileViewModel.debugEnvironment"]
        ),
        capability(
            id: "settings.device.logout",
            ownership: .device,
            destination: .settingsDeviceLogout,
            visibility: .visible(platform: .both),
            evidence: ["AuthService.logout", "ProfileScreen logoutButton"]
        ),

        // MARK: - 明确排除
        excluded(id: "excluded.publicProfileShare", reason: "移动端无公开主页/分享入口；桌面专属。"),
        excluded(id: "excluded.accountDeletion", reason: "账号注销不在设置首页展示；保留深链/合规入口。"),
        excluded(id: "excluded.rebindPhoneEmail", reason: "换绑手机/邮箱无移动端自助流程。"),
        excluded(id: "excluded.notificationCategories", reason: "无通知分类开关；仅系统授权。"),
        excluded(id: "excluded.androidVoiceHabits", reason: "Android 不展示语音习惯。"),
        excluded(id: "excluded.personalRules", reason: "个人通用规则为桌面 Agent 配置。"),
        excluded(id: "excluded.defaultResourceOpenMode", reason: "资源默认打开方式为桌面专属。"),
        excluded(id: "excluded.uiFontSize", reason: "UI 字号为桌面专属。"),
        excluded(id: "excluded.desktopOnly", reason: "凭据/存储/性能/MCP 等为桌面专属。"),
        excluded(id: "excluded.createOrganization", reason: "新建 Organization 位于账户侧栏，不在设置首页。"),
        excluded(id: "excluded.walletEntry", reason: "钱包位于组织设置，不在设置首页。"),
    ]

    static let legacyProfileMigration: [LegacyProfileCapability: LegacyProfileMigration] = [
        .profileHeader: .init(destination: .meProfileHeader, globalDestination: .me),
        .contactVerification: .init(destination: .settingsPersonalAccountInfo, globalDestination: .settings),
        .appearance: .init(destination: .settingsPersonalAppearance, globalDestination: .settings),
        .language: .init(destination: .settingsPersonalAppearance, globalDestination: .settings),
        .notificationPermission: .init(destination: .settingsPersonalSystemPermissions, globalDestination: .settings),
        .notificationCategories: .init(destination: nil, globalDestination: .settings, excludedReason: "excluded.notificationCategories"),
        .voiceHabits: .init(destination: .settingsPersonalVoiceHabits, globalDestination: .settings),
        .organizationSwitcher: .init(destination: nil, globalDestination: .accountDrawerOrganizationSwitcher),
        .organizationSettings: .init(destination: .settingsOrganizationSettingsEntry, globalDestination: .settings),
        .organizationInvitationsInbox: .init(destination: nil, globalDestination: .organizationInvitation),
        .accountStats: .init(destination: .settingsPersonalAccountInfo, globalDestination: .settings),
        .privacyAndData: .init(destination: .settingsPersonalPrivacyAndData, globalDestination: .settings),
        .accountDeletion: .init(destination: nil, globalDestination: .settings, excludedReason: "excluded.accountDeletion"),
        .about: .init(destination: .settingsDeviceAbout, globalDestination: .settings),
        .deviceInfo: .init(destination: .settingsDeviceInfo, globalDestination: .settings),
        .debugEnvironment: .init(destination: .settingsDeviceDebugEnvironment, globalDestination: .settings),
        .logout: .init(destination: .settingsDeviceLogout, globalDestination: .settings),
        .publicProfileShare: .init(destination: nil, globalDestination: nil, excludedReason: "excluded.publicProfileShare"),
        .changePassword: .init(destination: .settingsPersonalChangePassword, globalDestination: .settings),
        .rebindPhoneEmail: .init(destination: nil, globalDestination: nil, excludedReason: "excluded.rebindPhoneEmail"),
        .personalRules: .init(destination: nil, globalDestination: nil, excludedReason: "excluded.personalRules"),
        .defaultResourceOpenMode: .init(destination: nil, globalDestination: nil, excludedReason: "excluded.defaultResourceOpenMode"),
        .uiFontSize: .init(destination: nil, globalDestination: nil, excludedReason: "excluded.uiFontSize"),
        .createOrganization: .init(destination: nil, globalDestination: nil, excludedReason: "excluded.createOrganization"),
        .walletEntry: .init(destination: nil, globalDestination: nil, excludedReason: "excluded.walletEntry"),
    ]

    static func capability(id: String) -> SettingsCapability? {
        all.first { $0.id == id }
    }

    static var visibleHomeCapabilities: [SettingsCapability] {
        all.filter { !$0.visibility.isExcluded && $0.ownership != .me }
    }

    static var visibleMeCapabilities: [SettingsCapability] {
        all.filter { !$0.visibility.isExcluded && $0.ownership == .me }
    }

    static var excludedCapabilities: [SettingsCapability] {
        all.filter(\.visibility.isExcluded)
    }

    static func visible(on platform: SettingsPlatformScope) -> [SettingsCapability] {
        filterVisible(all.filter { !$0.visibility.isExcluded }, on: platform)
    }

    static func visibleSettingsHome(on platform: SettingsPlatformScope) -> [SettingsCapability] {
        filterVisible(visibleHomeCapabilities, on: platform)
    }

    static func visibleMe(on platform: SettingsPlatformScope) -> [SettingsCapability] {
        filterVisible(visibleMeCapabilities, on: platform)
    }

    static func visible(ownership: SettingsCapabilityOwnership, on platform: SettingsPlatformScope) -> [SettingsCapability] {
        filterVisible(
            all.filter { !$0.visibility.isExcluded && $0.ownership == ownership },
            on: platform
        )
    }

    private static func filterVisible(_ capabilities: [SettingsCapability], on platform: SettingsPlatformScope) -> [SettingsCapability] {
        capabilities.filter { capability in
            guard case let .visible(scope) = capability.visibility else { return false }
            return scope == .both || scope == platform
        }
    }

    private static func capability(
        id: String,
        ownership: SettingsCapabilityOwnership,
        destination: SettingsDestination,
        visibility: SettingsCapabilityVisibility,
        evidence: [String]
    ) -> SettingsCapability {
        SettingsCapability(
            id: id,
            ownership: ownership,
            destination: destination,
            visibility: visibility,
            implementationEvidence: evidence
        )
    }

    private static func excluded(id: String, reason: String) -> SettingsCapability {
        SettingsCapability(
            id: id,
            ownership: .profile,
            destination: nil,
            visibility: .excluded(reason: reason),
            implementationEvidence: ["SettingsCapabilityRegistry"]
        )
    }
}

struct LegacyProfileMigration: Hashable, Sendable {
    let destination: SettingsDestination?
    let globalDestination: AccountGlobalDestination?
    let excludedReason: String?

    init(
        destination: SettingsDestination?,
        globalDestination: AccountGlobalDestination?,
        excludedReason: String? = nil
    ) {
        self.destination = destination
        self.globalDestination = globalDestination
        self.excludedReason = excludedReason
    }

    var isExcludedFromSettingsHome: Bool {
        destination == nil && excludedReason != nil
    }
}

/// Organization 设置可见性 / 可写性矩阵（与 Electron owner-only 管理门对齐）。
enum OrganizationSettingsAccessMatrix {
    static func canViewOrganizationSummary(role: OrganizationRole) -> Bool {
        role != .unknown
    }

    static func canOpenOrganizationSettings(role: OrganizationRole) -> Bool {
        role != .unknown
    }

    static func canManageOrganization(role: OrganizationRole) -> Bool {
        role.canManage
    }

    static func canEditOrganizationContent(role: OrganizationRole) -> Bool {
        role.canEdit
    }

    static func canInviteMembers(role: OrganizationRole, isPersonalOrganization: Bool) -> Bool {
        canManageOrganization(role: role) && !isPersonalOrganization
    }
}
