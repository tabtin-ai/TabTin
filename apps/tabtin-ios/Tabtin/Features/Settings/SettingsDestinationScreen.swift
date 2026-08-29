import SwiftUI
import UIKit

/// 设置叶子页路由：阶段 1 复用 Profile 内已有屏幕与组件。
struct SettingsDestinationScreen: View {
    let destination: SettingsDestination

    @State private var workspace = WorkspaceStore.shared
    @State private var colorScheme = ColorSchemeStore.shared

    var body: some View {
        let activeScheme = colorScheme.schemeId

        Group {
            switch destination {
            case .settingsPersonalAccountInfo:
                SettingsAccountInfoScreen()
            case .settingsPersonalChangePassword:
                ChangePasswordScreen()
            case .settingsPersonalAppearance:
                SettingsAppearanceScreen()
            case .settingsPersonalSystemPermissions:
                NotificationSettingsScreen()
            case .settingsPersonalVoiceHabits:
                VoiceSettingsScreen()
            case .settingsPersonalPrivacyAndData:
                PrivacySettingsScreen()
            case .settingsOrganizationSummary:
                SettingsOrganizationSummaryScreen()
            case .settingsOrganizationSettingsEntry:
                if let organization = workspace.selectedOrganization {
                    WorkspaceSettingsScreen(organization: organization)
                } else {
                    ContentUnavailableView(
                        L10n.Settings.organizationUnavailable,
                        systemImage: "building.2"
                    )
                }
            case .settingsDeviceInfo:
                SettingsDeviceInfoScreen()
            case .settingsDeviceDiagnostics:
                SettingsDiagnosticsScreen()
            case .settingsDeviceAbout:
                AboutScreen()
            case .settingsDeviceDebugEnvironment:
                DebugSettingsScreen()
            default:
                ContentUnavailableView(
                    L10n.Settings.unavailable,
                    systemImage: "exclamationmark.triangle"
                )
            }
        }
        // 设置由独立 fullScreenCover 承载，显式传播当前 tint；保持页面身份稳定，
        // 避免实时配色变化丢失表单输入、滚动位置或 VoiceOver 焦点。
        .tint(SettingsAppearancePresentation.accentColor(for: activeScheme))
    }
}

struct SettingsColorSchemeChoice: Identifiable, Equatable, Sendable {
    let id: ColorSchemeId
    let lightAccent: UInt
    let darkAccent: UInt

    var color: Color {
        Color(TTColors.dynamicUIColor(light: lightAccent, dark: darkAccent))
    }
}

enum SettingsAppearancePresentation {
    static let colorSchemeChoices: [SettingsColorSchemeChoice] = ColorSchemeId.allCases.map { id in
        let accent = ColorSchemePalette.tokens(for: id).bgAccent
        return SettingsColorSchemeChoice(
            id: id,
            lightAccent: accent.light,
            darkAccent: accent.dark
        )
    }

    static func accentColor(for id: ColorSchemeId) -> Color {
        let accent = ColorSchemePalette.tokens(for: id).bgAccent
        return Color(TTColors.dynamicUIColor(light: accent.light, dark: accent.dark))
    }
}

enum TTSettingsDetailIconTone {
    case accent
    case neutral
    case success
    case warning
    case critical

    var foreground: Color {
        switch self {
        case .accent: return .tt.iconAccent
        case .neutral: return .tt.iconSecondary
        case .success: return .tt.iconSuccess
        case .warning: return .tt.iconWarning
        case .critical: return .tt.textCritical
        }
    }

    var background: Color {
        switch self {
        case .accent: return .tt.bgAccent.opacity(0.11)
        case .neutral: return .tt.bgSubtleSecondary
        case .success: return .tt.bgSuccess.opacity(0.11)
        case .warning: return .tt.bgWarning.opacity(0.11)
        case .critical: return .tt.bgCritical.opacity(0.09)
        }
    }
}

struct TTSettingsDetailIcon: View {
    let systemImage: String
    var tone: TTSettingsDetailIconTone = .accent

    var body: some View {
        Image(systemName: systemImage)
            .font(.system(size: 15, weight: .semibold))
            .symbolRenderingMode(.hierarchical)
            .foregroundStyle(tone.foreground)
            .frame(width: 30, height: 30)
            .background(tone.background, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
            .accessibilityHidden(true)
    }
}

struct TTSettingsDetailLabel: View {
    let title: String
    var subtitle: String? = nil
    let systemImage: String
    var tone: TTSettingsDetailIconTone = .accent

    var body: some View {
        HStack(spacing: TTSpacing.md) {
            TTSettingsDetailIcon(systemImage: systemImage, tone: tone)
            VStack(alignment: .leading, spacing: TTSpacing.xxs) {
                Text(title)
                    .font(.tt.body)
                    .foregroundStyle(tone == .critical ? .tt.textCritical : .tt.textPrimary)
                if let subtitle {
                    Text(subtitle)
                        .font(.tt.caption)
                        .foregroundStyle(.tt.textSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
    }
}

extension View {
    /// 设置域专用外壳：与设置首页保持同一 grouped surface，不影响其它历史列表。
    func ttSettingsDetailListStyle() -> some View {
        self
            .listStyle(.insetGrouped)
            .listSectionSpacing(TTSpacing.lg)
            .textCase(nil)
            .scrollContentBackground(.hidden)
            .contentMargins(.horizontal, TTSpacing.lg, for: .scrollContent)
            .background(.tt.bgCanvasDefault, ignoresSafeAreaEdges: .all)
    }

    func ttSettingsDetailFormStyle() -> some View {
        self
            .listStyle(.insetGrouped)
            .listSectionSpacing(TTSpacing.lg)
            .textCase(nil)
            .scrollContentBackground(.hidden)
            .contentMargins(.horizontal, TTSpacing.lg, for: .scrollContent)
            .background(.tt.bgCanvasDefault, ignoresSafeAreaEdges: .all)
    }
}

private struct SettingsAccountInfoScreen: View {
    private enum VerificationTarget {
        case email
        case phone
    }

    @State private var auth = AuthService.shared
    @State private var verificationError: String?
    @State private var sendingVerification: VerificationTarget?
    @State private var verificationCountdown: [VerificationTarget: Int] = [:]
    @State private var countdownTasks: [VerificationTarget: Task<Void, Never>] = [:]
    @State private var userIdCopied = false

    var body: some View {
        List {
            if let user = auth.currentUser {
                let phone = user.phone ?? ""
                let email = user.email ?? ""
                if !phone.isEmpty || !email.isEmpty {
                    Section(L10n.Profile.basicInfoHeader) {
                        if !phone.isEmpty {
                            contactRow(
                                title: L10n.Settings.accountInfoPhone,
                                value: maskPhone(phone),
                                isVerified: user.isVerifiedPhone ?? false,
                                target: .phone
                            )
                        }
                        if !email.isEmpty {
                            contactRow(
                                title: L10n.Settings.accountInfoEmail,
                                value: maskEmail(email),
                                isVerified: user.isVerifiedEmail ?? false,
                                target: .email
                            )
                        }
                    }
                }

                Section {
                    NavigationLink {
                        SettingsDestinationScreen(destination: .settingsPersonalChangePassword)
                    } label: {
                        TTSettingsDetailLabel(
                            title: L10n.Profile.changePassword,
                            systemImage: "key.fill"
                        )
                    }
                }

                if !user.id.isEmpty {
                    Section {
                        Button {
                            copyUserId(user.id)
                        } label: {
                            HStack(spacing: TTSpacing.md) {
                                TTSettingsDetailIcon(
                                    systemImage: "person.text.rectangle.fill",
                                    tone: .neutral
                                )
                                Text(user.id)
                                    .font(.system(.body, design: .monospaced))
                                    .foregroundStyle(.tt.textPrimary)
                                    .lineLimit(1)
                                    .truncationMode(.middle)
                                Spacer()
                                if userIdCopied {
                                    Label(L10n.Settings.userIdCopied, systemImage: "checkmark")
                                        .font(.tt.meta)
                                        .foregroundStyle(.tt.textSuccess)
                                } else {
                                    Image(systemName: "doc.on.doc")
                                        .foregroundStyle(.tt.textTertiary)
                                }
                            }
                        }
                        .buttonStyle(.plain)
                    } header: {
                        Text(L10n.Settings.accountInfoUserId)
                    } footer: {
                        Text(L10n.Settings.accountInfoUserIdFooter)
                    }
                }

                if user.dateJoined != nil || user.loginCount != nil || user.lastLogin != nil {
                    Section {
                        if let dateJoined = user.dateJoined {
                            statRow(
                                title: L10n.Profile.registeredAt,
                                value: formatDateString(dateJoined),
                                systemImage: "calendar"
                            )
                        }
                        if let loginCount = user.loginCount {
                            statRow(
                                title: L10n.Profile.loginCount,
                                value: "\(loginCount)",
                                systemImage: "number.circle.fill"
                            )
                        }
                        if let lastLogin = user.lastLogin {
                            statRow(
                                title: L10n.Profile.lastLogin,
                                value: formatDateString(lastLogin),
                                systemImage: "clock.fill"
                            )
                        }
                    }
                }
            }

            if let verificationError {
                Section {
                    Label(verificationError, systemImage: "exclamationmark.triangle")
                        .foregroundStyle(.tt.textCritical)
                }
            }
        }
        .ttSettingsDetailListStyle()
        .navigationTitle(L10n.Settings.accountAndVerification)
        .navigationBarTitleDisplayMode(.inline)
        .onDisappear {
            countdownTasks.values.forEach { $0.cancel() }
            countdownTasks.removeAll()
        }
    }

    private func contactRow(
        title: String,
        value: String,
        isVerified: Bool,
        target: VerificationTarget
    ) -> some View {
        LabeledContent(content: {
            HStack(spacing: TTSpacing.sm) {
                Text(value)
                    .foregroundStyle(.tt.textPrimary)
                Spacer(minLength: TTSpacing.sm)
                if isVerified {
                    Label(L10n.Profile.verified, systemImage: "checkmark.seal.fill")
                        .font(.tt.caption)
                        .foregroundStyle(.tt.textSuccess)
                } else {
                    let countdown = verificationCountdown[target] ?? 0
                    let isSending = sendingVerification == target
                    Button {
                        Task { await sendVerification(target) }
                    } label: {
                        if isSending {
                            ProgressView().controlSize(.small)
                        } else if countdown > 0 {
                            Text("\(countdown)s")
                                .font(.tt.meta)
                                .foregroundStyle(.tt.textTertiary)
                        } else {
                            Text(L10n.Profile.verify)
                                .font(.tt.meta)
                                .foregroundStyle(.tt.textAccent)
                        }
                    }
                    .disabled(isSending || countdown > 0)
                }
            }
        }, label: {
            TTSettingsDetailLabel(
                title: title,
                systemImage: target == .phone ? "phone.fill" : "envelope.fill",
                tone: isVerified ? .success : .accent
            )
        })
    }

    private func statRow(title: String, value: String, systemImage: String) -> some View {
        LabeledContent {
            Text(value)
                .font(.tt.meta)
                .foregroundStyle(.tt.textSecondary)
        } label: {
            TTSettingsDetailLabel(
                title: title,
                systemImage: systemImage,
                tone: .neutral
            )
        }
    }

    private func copyUserId(_ userId: String) {
        UIPasteboard.general.string = userId
        userIdCopied = true
        Task {
            try? await Task.sleep(for: .seconds(1.8))
            userIdCopied = false
        }
    }

    private func sendVerification(_ target: VerificationTarget) async {
        sendingVerification = target
        verificationError = nil
        do {
            switch target {
            case .email: try await auth.sendEmailVerification()
            case .phone: try await auth.sendPhoneVerification()
            }
            startCountdown(for: target)
        } catch {
            verificationError = error.localizedDescription
        }
        sendingVerification = nil
    }

    private func startCountdown(for target: VerificationTarget) {
        countdownTasks[target]?.cancel()
        countdownTasks[target] = Task { @MainActor in
            for remaining in (1...60).reversed() {
                verificationCountdown[target] = remaining
                try? await Task.sleep(for: .seconds(1))
                if Task.isCancelled { return }
            }
            verificationCountdown[target] = 0
            countdownTasks[target] = nil
        }
    }

    private func maskPhone(_ phone: String) -> String {
        guard phone.count >= 7 else { return phone }
        return "\(phone.prefix(3))****\(phone.suffix(4))"
    }

    private func maskEmail(_ email: String) -> String {
        guard let at = email.firstIndex(of: "@") else { return email }
        let name = String(email[..<at])
        let domain = String(email[at...])
        guard name.count > 3 else { return email }
        return "\(name.prefix(2))***\(domain)"
    }

    private func formatDateString(_ raw: String) -> String {
        if let date = ISO8601DateFormatter().date(from: raw) {
            return date.formatted(date: .abbreviated, time: .omitted)
        }
        return raw
    }
}

private struct SettingsAppearanceScreen: View {
    @State private var theme = ThemeManager.shared
    @State private var language = LanguageManager.shared
    @State private var colorScheme = ColorSchemeStore.shared
    @State private var showCapsuleGuideResetConfirmation = false

    var body: some View {
        let selectedScheme = colorScheme.schemeId

        List {
            Section(L10n.Profile.appearance) {
                ForEach(ThemeMode.allCases) { mode in
                    selectionRow(
                        title: mode.displayName,
                        systemImage: themeIcon(for: mode),
                        isSelected: theme.mode == mode
                    ) {
                        theme.mode = mode
                    }
                    .accessibilityIdentifier("settings-appearance-theme-\(mode.rawValue)")
                }
            }
            Section(L10n.Settings.colorScheme) {
                ForEach(SettingsAppearancePresentation.colorSchemeChoices) { choice in
                    Button {
                        colorScheme.setScheme(choice.id)
                    } label: {
                        HStack(spacing: TTSpacing.md) {
                            Circle()
                                .fill(choice.color)
                                .frame(width: 28, height: 28)
                                .overlay {
                                    Circle()
                                        .stroke(.white.opacity(0.72), lineWidth: 2)
                                        .padding(2)
                                }
                                .shadow(color: .black.opacity(0.08), radius: 1, y: 1)
                                .accessibilityHidden(true)
                            Text(SettingsColorSchemeLabels.name(for: choice.id))
                                .font(.tt.body)
                                .foregroundStyle(.tt.textPrimary)
                            Spacer()
                            if selectedScheme == choice.id {
                                Image(systemName: "checkmark.circle.fill")
                                    .font(.system(size: 18, weight: .semibold))
                                    .foregroundStyle(choice.color)
                                    .accessibilityHidden(true)
                            }
                        }
                        .frame(minHeight: 44)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier("settings-appearance-scheme-\(choice.id.rawValue)")
                    .accessibilityAddTraits(selectedScheme == choice.id ? .isSelected : [])
                }
            }
            Section(L10n.Profile.language) {
                ForEach(AppLanguage.allCases) { appLanguage in
                    selectionRow(
                        title: appLanguage.displayName,
                        systemImage: languageIcon(for: appLanguage),
                        isSelected: language.language == appLanguage
                    ) {
                        language.language = appLanguage
                    }
                    .accessibilityIdentifier("settings-appearance-language-\(appLanguage.rawValue)")
                }
            }
            Section(L10n.Agent.capsuleOnboardingSettingsSection) {
                Button {
                    CapsuleOnboardingStore.reset()
                    showCapsuleGuideResetConfirmation = true
                } label: {
                    HStack(spacing: TTSpacing.md) {
                        TTSettingsDetailIcon(systemImage: "hand.tap", tone: .accent)
                        VStack(alignment: .leading, spacing: TTSpacing.xxs) {
                            Text(L10n.Agent.capsuleOnboardingReplayTitle)
                                .font(.tt.body)
                                .foregroundStyle(.tt.textPrimary)
                            Text(L10n.Agent.capsuleOnboardingReplayDetail)
                                .font(.tt.meta)
                                .foregroundStyle(.tt.textSecondary)
                        }
                        Spacer()
                    }
                    .frame(minHeight: 44)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("settings-appearance-capsule-onboarding-replay")
            }
        }
        .ttSettingsDetailListStyle()
        .navigationTitle(L10n.Profile.appearance)
        .navigationBarTitleDisplayMode(.inline)
        .alert(
            L10n.Agent.capsuleOnboardingReplayDone,
            isPresented: $showCapsuleGuideResetConfirmation
        ) {
            Button(L10n.Common.confirm) {}
        }
    }

    private func selectionRow(
        title: String,
        systemImage: String,
        isSelected: Bool,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            HStack(spacing: TTSpacing.md) {
                TTSettingsDetailIcon(
                    systemImage: systemImage,
                    tone: isSelected ? .accent : .neutral
                )
                Text(title)
                    .font(.tt.body)
                    .foregroundStyle(.tt.textPrimary)
                Spacer()
                if isSelected {
                    Image(systemName: "checkmark")
                        .font(.system(size: 14, weight: .semibold))
                        .foregroundStyle(.tt.iconAccent)
                        .accessibilityHidden(true)
                }
            }
            .frame(minHeight: 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(isSelected ? .isSelected : [])
    }

    private func themeIcon(for mode: ThemeMode) -> String {
        switch mode {
        case .system: return "circle.lefthalf.filled"
        case .light: return "sun.max.fill"
        case .dark: return "moon.fill"
        }
    }

    private func languageIcon(for language: AppLanguage) -> String {
        switch language {
        case .system: return "globe"
        case .zhHans: return "character.book.closed.fill"
        case .en: return "textformat"
        }
    }
}

enum SettingsColorSchemeLabels {
    static func name(for scheme: ColorSchemeId) -> String {
        switch scheme {
        case .blue: return L10n.Settings.colorSchemeBlue
        case .teal: return L10n.Settings.colorSchemeTeal
        case .orange: return L10n.Settings.colorSchemeOrange
        case .rose: return L10n.Settings.colorSchemeRose
        case .slate: return L10n.Settings.colorSchemeSlate
        case .violet: return L10n.Settings.colorSchemeViolet
        case .sky: return L10n.Settings.colorSchemeSky
        }
    }
}

private struct SettingsOrganizationSummaryScreen: View {
    @State private var workspace = WorkspaceStore.shared

    var body: some View {
        List {
            if let organization = workspace.selectedOrganization {
                Section {
                    LabeledContent {
                        Text(organization.name)
                            .foregroundStyle(.tt.textSecondary)
                    } label: {
                        TTSettingsDetailLabel(
                            title: L10n.Settings.organizationName,
                            systemImage: "building.2.fill"
                        )
                    }
                    if let role = workspace.currentUserRole, role != .unknown {
                        LabeledContent {
                            Text(role.title)
                                .font(.tt.captionSemibold)
                                .foregroundStyle(.tt.textAccent)
                                .padding(.horizontal, 8)
                                .padding(.vertical, 4)
                                .background(.tt.bgAccent.opacity(0.11), in: Capsule())
                        } label: {
                            TTSettingsDetailLabel(
                                title: L10n.Settings.organizationRole,
                                systemImage: "person.text.rectangle.fill"
                            )
                        }
                    }
                }
            }
        }
        .ttSettingsDetailListStyle()
        .navigationTitle(L10n.Settings.organizationSummary)
        .navigationBarTitleDisplayMode(.inline)
    }
}

private struct SettingsDeviceInfoScreen: View {
    @State private var deviceIdCopied = false

    var body: some View {
        List {
            Section {
                Button {
                    copyDeviceId()
                } label: {
                    HStack(spacing: TTSpacing.md) {
                        TTSettingsDetailLabel(
                            title: L10n.Profile.deviceId,
                            systemImage: "doc.on.doc",
                            tone: .neutral
                        )
                        Spacer()
                        if deviceIdCopied {
                            Label(L10n.Settings.userIdCopied, systemImage: "checkmark")
                                .font(.tt.meta)
                                .foregroundStyle(.tt.textSuccess)
                        } else {
                            Text(shortDeviceId)
                                .font(.system(.body, design: .monospaced))
                                .foregroundStyle(.tt.textSecondary)
                                .lineLimit(1)
                        }
                    }
                }
                .buttonStyle(.plain)
            }
        }
        .ttSettingsDetailListStyle()
        .navigationTitle(L10n.Profile.deviceId)
        .navigationBarTitleDisplayMode(.inline)
    }

    private var deviceId: String {
        KeychainService.shared.getOrCreateDeviceId()
    }

    private var shortDeviceId: String {
        String(deviceId.prefix(8)) + "…"
    }

    private func copyDeviceId() {
        UIPasteboard.general.string = deviceId
        deviceIdCopied = true
        Task {
            try? await Task.sleep(nanoseconds: 1_500_000_000)
            guard !Task.isCancelled else { return }
            await MainActor.run {
                deviceIdCopied = false
            }
        }
    }
}
