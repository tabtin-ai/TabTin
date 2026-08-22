import SwiftUI
import UserNotifications

/// 设置首页：capability registry 决定功能是否存在，本文件只负责面向用户的信息架构与呈现。
struct SettingsHomeScreen: View {
    @Environment(\.scenePhase) private var scenePhase

    @State private var auth = AuthService.shared
    @State private var debugSettings = DebugEnvironmentSettings.shared
    @State private var theme = ThemeManager.shared
    @State private var colorScheme = ColorSchemeStore.shared
    @State private var workspace = WorkspaceStore.shared
    @State private var showLogoutConfirm = false
    @State private var notificationAuthorizationStatus: UNAuthorizationStatus?

    private var capabilities: [SettingsCapability] {
        SettingsHomeCapabilityResolver.visibleCapabilities()
    }

    private var capabilitiesByDestination: [SettingsDestination: SettingsCapability] {
        Dictionary(
            capabilities.compactMap { capability in
                capability.destination.map { ($0, capability) }
            },
            uniquingKeysWith: { first, _ in first }
        )
    }

    private var groups: [SettingsHomeResolvedGroup] {
        let available = capabilitiesByDestination
        return SettingsHomePresentation.groups.compactMap { group in
            let capabilities = group.destinations.compactMap { available[$0] }
            guard !capabilities.isEmpty else { return nil }
            return SettingsHomeResolvedGroup(presentation: group, capabilities: capabilities)
        }
    }

    private var verifiedContactCount: Int {
        guard let user = auth.currentUser else { return 0 }
        return [user.isVerifiedPhone, user.isVerifiedEmail]
            .compactMap { $0 }
            .filter { $0 }
            .count
    }

    var body: some View {
        List {
            ForEach(groups) { group in
                Section {
                    ForEach(group.capabilities) { capability in
                        if
                            let destination = capability.destination,
                            let presentation = SettingsHomePresentation.item(for: destination)
                        {
                            SettingsHomeRow(
                                capabilityID: capability.id,
                                destination: destination,
                                presentation: presentation,
                                title: rowTitle(for: destination, fallback: presentation.title),
                                trailing: rowTrailing(for: destination),
                                iconTone: rowIconTone(for: destination, fallback: presentation.iconTone)
                            )
                            .listRowInsets(EdgeInsets())
                            .listRowSeparatorTint(Color.tt.borderLight)
                            .alignmentGuide(.listRowSeparatorLeading) { _ in
                                SettingsHomeRow.separatorLeadingInset
                            }
                        }
                    }
                } header: {
                    Text(group.presentation.title)
                        .font(.tt.captionSemibold)
                        .foregroundStyle(.tt.textSecondary)
                        .textCase(nil)
                        .padding(.leading, TTSpacing.xs)
                }
            }

            if capabilitiesByDestination[.settingsDeviceLogout] != nil {
                Section {
                    Button(role: .destructive) {
                        showLogoutConfirm = true
                    } label: {
                        Label(L10n.Profile.logout, systemImage: "rectangle.portrait.and.arrow.right")
                            .font(.tt.subtitleSemibold)
                            .foregroundStyle(.tt.textCritical)
                            .frame(maxWidth: .infinity, minHeight: 46)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .listRowInsets(EdgeInsets())
                    .listRowBackground(Color.tt.bgCritical.opacity(0.08))
                    .accessibilityIdentifier("settings-home-row-settings.device.logout")
                }
            }
        }
        // insetGrouped 与 demo 的浅灰画布 + 圆角 surface 一致；不用 ttListStyle()，避免再次挤掉 large title。
        .listStyle(.insetGrouped)
        .listSectionSpacing(TTSpacing.lg)
        .scrollContentBackground(.hidden)
        .contentMargins(.horizontal, TTSpacing.lg, for: .scrollContent)
        .background(.tt.bgCanvasDefault, ignoresSafeAreaEdges: .all)
        .navigationTitle(L10n.Common.settings)
        .navigationBarTitleDisplayMode(.large)
        .toolbarTitleDisplayMode(.large)
        .task { await refreshNotificationAuthorizationStatus() }
        .onChange(of: scenePhase) { _, phase in
            guard phase == .active else { return }
            Task { await refreshNotificationAuthorizationStatus() }
        }
        .alert(L10n.Profile.logoutConfirmTitle, isPresented: $showLogoutConfirm) {
            Button(L10n.Profile.logout, role: .destructive) { auth.logout() }
            Button(L10n.Common.cancel, role: .cancel) {}
        } message: {
            Text(L10n.Profile.logoutConfirmMessage)
        }
    }

    private func rowTitle(for destination: SettingsDestination, fallback: String) -> String {
        guard destination == .settingsOrganizationSummary else { return fallback }
        return workspace.selectedOrganization?.name ?? fallback
    }

    private func rowTrailing(for destination: SettingsDestination) -> SettingsHomeTrailing? {
        switch destination {
        case .settingsPersonalAccountInfo:
            guard verifiedContactCount > 0 else { return nil }
            return .badge(L10n.Settings.verifiedCount(verifiedContactCount), tone: .success)
        case .settingsPersonalAppearance:
            return .colorSwatch(
                SettingsAppearancePresentation.accentColor(for: colorScheme.schemeId),
                value: theme.mode.displayName,
                accessibilityLabel: "\(SettingsColorSchemeLabels.name(for: colorScheme.schemeId)), \(theme.mode.displayName)"
            )
        case .settingsPersonalSystemPermissions:
            switch notificationAuthorizationStatus {
            case .authorized, .provisional, .ephemeral:
                return .badge(L10n.Settings.notificationsEnabled, tone: .success)
            case .denied:
                return .badge(L10n.Settings.notificationsDisabled, tone: .warning)
            case .notDetermined:
                return .text(L10n.Settings.notificationsNotSet)
            case nil:
                return nil
            @unknown default:
                return nil
            }
        case .settingsOrganizationSummary:
            guard let role = workspace.currentUserRole, role != .unknown else { return nil }
            return .badge(role.title, tone: .accent)
        case .settingsDeviceInfo:
            let id = KeychainService.shared.getOrCreateDeviceId()
            return .text(String(id.prefix(8)) + "…")
        case .settingsDeviceAbout:
            return .text("v\(AppConfig.appVersion)")
        case .settingsDeviceDebugEnvironment:
            return .text(debugPresetTitle)
        default:
            return nil
        }
    }

    private func rowIconTone(
        for destination: SettingsDestination,
        fallback: SettingsHomeIconTone
    ) -> SettingsHomeIconTone {
        switch destination {
        case .settingsPersonalAccountInfo where verifiedContactCount > 0:
            return .success
        case .settingsPersonalSystemPermissions:
            switch notificationAuthorizationStatus {
            case .authorized, .provisional, .ephemeral: return .success
            case .denied: return .warning
            default: return fallback
            }
        default:
            return fallback
        }
    }

    private var debugPresetTitle: String {
        switch debugSettings.preset {
        case .production: return L10n.Settings.debugEnvironmentProduction
        case .development: return L10n.Settings.debugEnvironmentDevelopment
        case .custom: return L10n.Settings.debugEnvironmentCustom
        }
    }

    @MainActor
    private func refreshNotificationAuthorizationStatus() async {
        let settings = await UNUserNotificationCenter.current().notificationSettings()
        notificationAuthorizationStatus = settings.authorizationStatus
    }
}

/// 首页最终可见能力的单一入口。
enum SettingsHomeCapabilityResolver {
    static func visibleCapabilities() -> [SettingsCapability] {
        SettingsCapabilityRegistry.visibleSettingsHome(on: .ios)
    }
}

/// 首页展示元数据与 capability registry 分离：前者可重排视觉分组，后者仍是功能真值。
enum SettingsHomePresentation {
    static let homeOrder: [SettingsDestination] = [
        .settingsPersonalAccountInfo,
        .settingsPersonalChangePassword,
        .settingsPersonalPrivacyAndData,
        .settingsPersonalAppearance,
        .settingsPersonalSystemPermissions,
        .settingsPersonalVoiceHabits,
        .settingsOrganizationSummary,
        .settingsOrganizationSettingsEntry,
        .settingsDeviceInfo,
        .settingsDeviceDiagnostics,
        .settingsDeviceDebugEnvironment,
        .settingsDeviceAbout,
        .settingsDeviceLogout,
    ]

    static func supports(_ destination: SettingsDestination) -> Bool {
        guard homeOrder.contains(destination) else { return false }
        if destination == .settingsDeviceLogout { return true }
        return item(for: destination) != nil
            && groups.contains(where: { $0.destinations.contains(destination) })
    }

    static var hasConsistentOrder: Bool {
        groups.flatMap(\.destinations) + [.settingsDeviceLogout] == homeOrder
    }

    fileprivate static var groups: [SettingsHomeGroupPresentation] {
        [
            SettingsHomeGroupPresentation(
                id: "account-security",
                title: L10n.Settings.sectionAccountSecurity,
                destinations: [.settingsPersonalAccountInfo, .settingsPersonalChangePassword, .settingsPersonalPrivacyAndData]
            ),
            SettingsHomeGroupPresentation(
                id: "preferences",
                title: L10n.Settings.sectionPreferences,
                destinations: [
                    .settingsPersonalAppearance,
                    .settingsPersonalSystemPermissions,
                    .settingsPersonalVoiceHabits,
                ]
            ),
            SettingsHomeGroupPresentation(
                id: "organization",
                title: L10n.Settings.sectionOrganization,
                destinations: [.settingsOrganizationSummary, .settingsOrganizationSettingsEntry]
            ),
            SettingsHomeGroupPresentation(
                id: "device",
                title: L10n.Settings.sectionDevice,
                destinations: [.settingsDeviceInfo, .settingsDeviceDiagnostics, .settingsDeviceDebugEnvironment]
            ),
            SettingsHomeGroupPresentation(
                id: "about-support",
                title: L10n.Settings.sectionAboutSupport,
                destinations: [.settingsDeviceAbout]
            ),
        ]
    }

    fileprivate static func item(for destination: SettingsDestination) -> SettingsHomeItemPresentation? {
        switch destination {
        case .settingsPersonalAccountInfo:
            return SettingsHomeItemPresentation(
                title: L10n.Settings.accountAndVerification,
                subtitle: L10n.Settings.accountInfoSubtitle,
                systemImage: "checkmark.shield.fill",
                iconTone: .accent
            )
        case .settingsPersonalChangePassword:
            return SettingsHomeItemPresentation(
                title: L10n.Profile.changePassword,
                subtitle: L10n.Profile.changePasswordSubtitle,
                systemImage: "key.fill",
                iconTone: .accent
            )
        case .settingsPersonalPrivacyAndData:
            return SettingsHomeItemPresentation(
                title: L10n.Profile.privacyAndData,
                subtitle: L10n.Settings.privacyAndDataSubtitle,
                systemImage: "lock.shield.fill",
                iconTone: .accent
            )
        case .settingsPersonalAppearance:
            return SettingsHomeItemPresentation(
                title: L10n.Settings.appearanceAndLanguage,
                subtitle: L10n.Settings.appearanceAndLanguageSubtitle,
                systemImage: "paintpalette.fill",
                iconTone: .accent
            )
        case .settingsPersonalSystemPermissions:
            return SettingsHomeItemPresentation(
                title: L10n.Profile.notificationsTitle,
                subtitle: L10n.Settings.notificationsSubtitle,
                systemImage: "bell.fill",
                iconTone: .accent
            )
        case .settingsPersonalVoiceHabits:
            return SettingsHomeItemPresentation(
                title: L10n.Profile.voiceTitle,
                subtitle: L10n.Settings.voiceHabitsSubtitle,
                systemImage: "waveform",
                iconTone: .accent
            )
        case .settingsOrganizationSummary:
            return SettingsHomeItemPresentation(
                title: L10n.Settings.organizationSummary,
                subtitle: L10n.Settings.organizationSummarySubtitle,
                systemImage: "building.2.fill",
                iconTone: .accent
            )
        case .settingsOrganizationSettingsEntry:
            return SettingsHomeItemPresentation(
                title: L10n.Settings.organizationSettings,
                subtitle: L10n.Settings.organizationSettingsSubtitle,
                systemImage: "slider.horizontal.3",
                iconTone: .accent
            )
        case .settingsDeviceInfo:
            return SettingsHomeItemPresentation(
                title: L10n.Settings.thisDevice,
                subtitle: L10n.Settings.deviceInfoSubtitle,
                systemImage: "iphone",
                iconTone: .neutral
            )
        case .settingsDeviceDiagnostics:
            return SettingsHomeItemPresentation(
                title: L10n.Settings.diagnosticsTitle,
                subtitle: L10n.Settings.diagnosticsSubtitle,
                systemImage: "square.and.arrow.up.fill",
                iconTone: .accent
            )
        case .settingsDeviceAbout:
            return SettingsHomeItemPresentation(
                title: L10n.Profile.aboutTitle,
                subtitle: L10n.Settings.aboutSubtitle,
                systemImage: "info.circle.fill",
                iconTone: .neutral
            )
        case .settingsDeviceDebugEnvironment:
            return SettingsHomeItemPresentation(
                title: L10n.Debug.entry,
                subtitle: L10n.Settings.debugEnvironmentSubtitle,
                systemImage: "ladybug.fill",
                iconTone: .warning
            )
        default:
            return nil
        }
    }
}

private struct SettingsHomeResolvedGroup: Identifiable {
    let presentation: SettingsHomeGroupPresentation
    let capabilities: [SettingsCapability]

    var id: String { presentation.id }
}

private struct SettingsHomeGroupPresentation {
    let id: String
    let title: String
    let destinations: [SettingsDestination]
}

private struct SettingsHomeItemPresentation {
    let title: String
    let subtitle: String
    let systemImage: String
    let iconTone: SettingsHomeIconTone
}

private struct SettingsHomeRow: View {
    nonisolated static let separatorLeadingInset = TTSpacing.md + 32 + TTSpacing.md

    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    let capabilityID: String
    let destination: SettingsDestination
    let presentation: SettingsHomeItemPresentation
    let title: String
    let trailing: SettingsHomeTrailing?
    let iconTone: SettingsHomeIconTone

    var body: some View {
        NavigationLink {
            SettingsDestinationScreen(destination: destination)
        } label: {
            rowContent
                .padding(.horizontal, TTSpacing.md)
                .padding(.vertical, TTSpacing.sm)
                .frame(minHeight: 56)
                .contentShape(Rectangle())
        }
        .accessibilityIdentifier("settings-home-row-\(capabilityID)")
    }

    @ViewBuilder
    private var rowContent: some View {
        if dynamicTypeSize.isAccessibilitySize {
            HStack(alignment: .top, spacing: TTSpacing.md) {
                icon
                VStack(alignment: .leading, spacing: TTSpacing.sm) {
                    labels
                    if let trailing {
                        SettingsHomeTrailingView(trailing: trailing)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        } else {
            HStack(spacing: TTSpacing.md) {
                icon
                labels
                    .layoutPriority(1)
                Spacer(minLength: TTSpacing.sm)
                if let trailing {
                    SettingsHomeTrailingView(trailing: trailing)
                }
            }
        }
    }

    private var icon: some View {
        Image(systemName: presentation.systemImage)
            .font(.system(size: 16, weight: .semibold))
            .symbolRenderingMode(.hierarchical)
            .foregroundStyle(iconTone.foregroundColor)
            .frame(width: 32, height: 32)
            .background(
                iconTone.backgroundColor,
                in: RoundedRectangle(cornerRadius: 9, style: .continuous)
            )
            .accessibilityHidden(true)
    }

    private var labels: some View {
        VStack(alignment: .leading, spacing: TTSpacing.xxs) {
            Text(title)
                .font(.tt.bodySemibold)
                .foregroundStyle(.tt.textPrimary)
                .lineLimit(dynamicTypeSize.isAccessibilitySize ? nil : 2)
            Text(presentation.subtitle)
                .font(.tt.caption)
                .foregroundStyle(.tt.textSecondary)
                .lineLimit(dynamicTypeSize.isAccessibilitySize ? nil : 2)
        }
    }
}

private enum SettingsHomeIconTone {
    case accent
    case neutral
    case success
    case warning

    var foregroundColor: Color {
        switch self {
        case .accent: return .tt.iconAccent
        case .neutral: return .tt.iconSecondary
        case .success: return .tt.iconSuccess
        case .warning: return .tt.iconWarning
        }
    }

    var backgroundColor: Color {
        switch self {
        case .accent: return .tt.bgAccent.opacity(0.11)
        case .neutral: return .tt.bgSubtleSecondary
        case .success: return .tt.bgSuccess.opacity(0.11)
        case .warning: return .tt.bgWarning.opacity(0.11)
        }
    }
}

private struct SettingsHomeTrailing {
    enum Style {
        case text
        case badge(SettingsHomeIconTone)
        case colorSwatch(Color)
    }

    let value: String
    let style: Style
    let accessibilityLabel: String?

    static func text(_ value: String) -> Self {
        Self(value: value, style: .text, accessibilityLabel: nil)
    }

    static func badge(_ value: String, tone: SettingsHomeIconTone) -> Self {
        Self(value: value, style: .badge(tone), accessibilityLabel: nil)
    }

    static func colorSwatch(_ color: Color, value: String, accessibilityLabel: String) -> Self {
        Self(value: value, style: .colorSwatch(color), accessibilityLabel: accessibilityLabel)
    }
}

private struct SettingsHomeTrailingView: View {
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    let trailing: SettingsHomeTrailing

    var body: some View {
        switch trailing.style {
        case .text:
            Text(trailing.value)
                .font(.tt.meta)
                .foregroundStyle(.tt.textSecondary)
                .lineLimit(dynamicTypeSize.isAccessibilitySize ? nil : 1)
        case .badge(let tone):
            Text(trailing.value)
                .font(.tt.captionSemibold)
                .foregroundStyle(.tt.textPrimary)
                .padding(.horizontal, 7)
                .padding(.vertical, 3)
                .background(tone.backgroundColor, in: Capsule())
                .lineLimit(dynamicTypeSize.isAccessibilitySize ? nil : 1)
        case .colorSwatch(let color):
            HStack(spacing: TTSpacing.xs) {
                Circle()
                    .fill(color)
                    .frame(width: 12, height: 12)
                    .overlay {
                        Circle().stroke(.white.opacity(0.7), lineWidth: 1)
                    }
                    .accessibilityHidden(true)
                Text(trailing.value)
                    .font(.tt.meta)
                    .foregroundStyle(.tt.textSecondary)
                    .lineLimit(dynamicTypeSize.isAccessibilitySize ? nil : 1)
            }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(trailing.accessibilityLabel ?? trailing.value)
        }
    }
}
