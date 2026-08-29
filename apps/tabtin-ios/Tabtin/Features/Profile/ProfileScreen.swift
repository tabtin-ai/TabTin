import PhotosUI
import SwiftUI
import UserNotifications
import UIKit

/// 阶段 0 巨型 Profile 壳 — **死壳勿用**。主路径已迁移至 `MeScreen` + `SettingsHomeScreen`。
@available(*, deprecated, message: "死壳勿用 — 使用 MeScreen + SettingsHomeScreen")
struct ProfileScreen: View {
    private let hidesTabBarWhenPushed: Bool
    private let showsNavigationTitle: Bool

    @State private var auth = AuthService.shared
    @State private var workspace = WorkspaceStore.shared
    @State private var invitations = InvitationService.shared
    @State private var theme = ThemeManager.shared
    @State private var language = LanguageManager.shared
    @State private var showEditSheet = false
    @State private var showLogoutConfirm = false
    @State private var pendingInvitation: PendingInvitation?
    @State private var profileLoadError: String?
    @State private var isReloading = false
    @State private var verificationError: String?
    @State private var sendingVerification: VerificationTarget?
    @State private var verificationCountdown: [VerificationTarget: Int] = [:]
    @State private var countdownTasks: [VerificationTarget: Task<Void, Never>] = [:]
    init(hidesTabBarWhenPushed: Bool = true, showsNavigationTitle: Bool = true) {
        self.hidesTabBarWhenPushed = hidesTabBarWhenPushed
        self.showsNavigationTitle = showsNavigationTitle
    }

    private enum VerificationTarget {
        case email
        case phone
    }

    var body: some View {
        @Bindable var theme = theme
        @Bindable var language = language

        ScrollView {
            VStack(spacing: 0) {
                if let reloadError {
                    errorRetry(reloadError)
                        .padding(.horizontal, TTSpacing.lg)
                        .padding(.top, TTSpacing.md)
                }

                Spacer().frame(height: TTSpacing.xl)
                profileHeader
                Spacer().frame(height: TTSpacing.xxxl)
                contactSection

                if let verificationError {
                    Label(verificationError, systemImage: "exclamationmark.triangle")
                        .font(.tt.meta)
                        .foregroundStyle(.tt.textCritical)
                        .padding(.horizontal, TTSpacing.xl)
                        .padding(.top, TTSpacing.sm)
                }

                Spacer().frame(height: TTSpacing.xxxl)
                menuGroup {
                    menuRow(icon: "paintbrush.fill", title: L10n.Profile.appearance) {
                        Picker("", selection: $theme.mode) {
                            ForEach(ThemeMode.allCases) { mode in
                                Text(mode.displayName).tag(mode)
                            }
                        }
                        .labelsHidden()
                        .tint(.tt.textSecondary)
                    }
                    menuRow(icon: "globe", title: L10n.Profile.language) {
                        Picker("", selection: $language.language) {
                            ForEach(AppLanguage.allCases) { lang in
                                Text(lang.displayName).tag(lang)
                            }
                        }
                        .labelsHidden()
                        .tint(.tt.textSecondary)
                    }
                    NavigationLink {
                        NotificationSettingsScreen()
                    } label: {
                        chevronRow(icon: "bell.fill", title: L10n.Profile.notificationsTitle)
                    }
                    NavigationLink {
                        VoiceSettingsScreen()
                    } label: {
                        chevronRow(icon: "waveform", title: L10n.Profile.voiceTitle)
                    }
                }

                Spacer().frame(height: TTSpacing.xxxl)
                workspaceSection
                Spacer().frame(height: TTSpacing.xxxl)
                accountStatsSection
                Spacer().frame(height: TTSpacing.xxxl)

                menuGroup {
                    NavigationLink {
                        PrivacySettingsScreen()
                    } label: {
                        chevronRow(icon: "hand.raised.fill", title: L10n.Profile.privacyAndData)
                    }
                    NavigationLink {
                        AboutScreen()
                    } label: {
                        menuRow(icon: "info.circle", title: L10n.Profile.aboutTitle) {
                            HStack(spacing: TTSpacing.sm) {
                                Text("v\(AppConfig.appVersion)")
                                    .font(.tt.meta)
                                    .foregroundStyle(.tt.textTertiary)
                                chevron
                            }
                        }
                    }
                    deviceInfoRow
                    NavigationLink {
                        DebugSettingsScreen()
                    } label: {
                        chevronRow(icon: "ladybug.fill", title: L10n.Debug.entry)
                    }
                }

                Spacer().frame(height: TTSpacing.xxxl)
                logoutButton
                    .padding(.horizontal, TTSpacing.xl)
                Spacer().frame(height: TTSpacing.huge)
            }
        }
        .background(.tt.bgCanvasDefault, ignoresSafeAreaEdges: .all)
        .ttNavigationTitle(L10n.Profile.title, displayMode: .large, isVisible: showsNavigationTitle)
        .ttToolbarBackground(showsNavigationTitle)
        .ttNavigationBarHidden(!showsNavigationTitle)
        .ttTabBarHidden(hidesTabBarWhenPushed)
        .sheet(isPresented: $showEditSheet) {
            ProfileEditScreen()
        }
        .sheet(item: $pendingInvitation) { invitation in
            InvitationResponseSheet(invitation: invitation)
        }
        .alert(L10n.Profile.logoutConfirmTitle, isPresented: $showLogoutConfirm) {
            Button(L10n.Profile.logout, role: .destructive) { auth.logout() }
            Button(L10n.Common.cancel, role: .cancel) {}
        } message: {
            Text(L10n.Profile.logoutConfirmMessage)
        }
        .refreshable { await reload() }
        .task { await reload() }
        .onDisappear {
            countdownTasks.values.forEach { $0.cancel() }
            countdownTasks.removeAll()
        }
    }

    private var profileHeader: some View {
        VStack(alignment: .leading, spacing: TTSpacing.lg) {
            HStack {
                ProfileAvatarView(
                    name: auth.currentUser?.displayName ?? L10n.Profile.defaultName,
                    imageURL: auth.currentUser?.avatar.flatMap(URL.init(string:)),
                    size: 64,
                    seed: auth.currentUser?.id
                )
                Spacer()
                Button {
                    showEditSheet = true
                } label: {
                    Image(systemName: "pencil.circle.fill")
                        .font(.system(size: 28))
                        .foregroundStyle(.tt.textAccent)
                }
                .accessibilityLabel(L10n.Profile.editProfileAccessibility)
            }

            VStack(alignment: .leading, spacing: TTSpacing.xs) {
                HStack(spacing: TTSpacing.sm) {
                    Text(auth.currentUser?.displayName ?? L10n.Profile.defaultName)
                        .font(.system(size: 24, weight: .bold))
                        .foregroundStyle(.tt.textPrimary)
                    if let username = auth.currentUser?.username, !username.isEmpty {
                        Text("@\(username)")
                            .font(.tt.meta)
                            .foregroundStyle(.tt.textTertiary)
                    }
                }
                Text((auth.currentUser?.bio?.isEmpty == false) ? auth.currentUser?.bio ?? "" : L10n.Profile.bioEmpty)
                    .font(.tt.body)
                    .foregroundStyle((auth.currentUser?.bio?.isEmpty == false) ? .tt.textSecondary : .tt.textTertiary)
                    .lineLimit(2)
            }
        }
        .padding(.horizontal, TTSpacing.xl)
    }

    @ViewBuilder
    private var contactSection: some View {
        let phone = auth.currentUser?.phone ?? ""
        let email = auth.currentUser?.email ?? ""
        if !phone.isEmpty || !email.isEmpty {
            menuGroup {
                if !phone.isEmpty {
                    contactRow(
                        icon: "phone.fill",
                        value: maskPhone(phone),
                        isVerified: auth.currentUser?.isVerifiedPhone ?? false,
                        target: .phone
                    )
                }
                if !email.isEmpty {
                    contactRow(
                        icon: "envelope.fill",
                        value: maskEmail(email),
                        isVerified: auth.currentUser?.isVerifiedEmail ?? false,
                        target: .email
                    )
                }
            }
        }
    }

    private func contactRow(icon: String, value: String, isVerified: Bool, target: VerificationTarget) -> some View {
        menuRow(icon: icon, title: value) {
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
    }

    @ViewBuilder
    private var workspaceSection: some View {
        menuGroup {
            ForEach(workspace.organizations) { organization in
                if organization.id == workspace.selectedOrganizationId {
                    NavigationLink {
                        WorkspaceSettingsScreen(organization: organization)
                    } label: {
                        HStack(spacing: TTSpacing.md) {
                            workspaceIcon(organization, size: 28)
                            Text(organization.name)
                                .font(.tt.subtitle)
                                .foregroundStyle(.tt.textPrimary)
                                .lineLimit(1)
                            Spacer()
                            Image(systemName: "checkmark")
                                .font(.tt.bodySemibold)
                                .foregroundStyle(.tt.iconAccent)
                            chevron
                        }
                        .padding(.vertical, TTSpacing.lg)
                    }
                } else {
                    Button {
                        Task { await workspace.selectOrganization(organization) }
                    } label: {
                        HStack(spacing: TTSpacing.md) {
                            workspaceIcon(organization, size: 28)
                            Text(organization.name)
                                .font(.tt.subtitle)
                                .foregroundStyle(.tt.textPrimary)
                            Spacer()
                        }
                        .padding(.vertical, TTSpacing.lg)
                    }
                }
            }

            if !invitations.pendingInvitations.isEmpty {
                Divider().padding(.vertical, TTSpacing.xs)
                ForEach(invitations.pendingInvitations) { invitation in
                    Button {
                        pendingInvitation = invitation
                    } label: {
                        HStack(spacing: TTSpacing.md) {
                            Image(systemName: "envelope.badge")
                                .font(.system(size: 18))
                                .foregroundStyle(.tt.textAccent)
                                .frame(width: 28)
                            VStack(alignment: .leading, spacing: TTSpacing.xxs) {
                                Text(invitation.workspaceName)
                                    .font(.tt.subtitle)
                                    .foregroundStyle(.tt.textPrimary)
                                Text(invitation.invitedByName.isEmpty ? invitation.role.title : "\(invitation.invitedByName) · \(invitation.role.title)")
                                    .font(.tt.meta)
                                    .foregroundStyle(.tt.textTertiary)
                            }
                            Spacer()
                            Text(L10n.Profile.pending)
                                .font(.tt.captionSemibold)
                                .foregroundStyle(.tt.textWarning)
                        }
                        .padding(.vertical, TTSpacing.lg)
                    }
                }
            }
        }
    }

    @ViewBuilder
    private var accountStatsSection: some View {
        if let user = auth.currentUser,
           user.dateJoined != nil || user.loginCount != nil || user.lastLogin != nil {
            menuGroup {
                if let dateJoined = user.dateJoined {
                    menuRow(icon: "calendar", title: L10n.Profile.registeredAt) {
                        Text(formatDateString(dateJoined))
                            .font(.tt.meta)
                            .foregroundStyle(.tt.textSecondary)
                    }
                }
                if let loginCount = user.loginCount {
                    menuRow(icon: "number", title: L10n.Profile.loginCount) {
                        Text("\(loginCount)")
                            .font(.tt.meta)
                            .foregroundStyle(.tt.textSecondary)
                    }
                }
                if let lastLogin = user.lastLogin {
                    menuRow(icon: "clock", title: L10n.Profile.lastLogin) {
                        Text(formatDateString(lastLogin))
                            .font(.tt.meta)
                            .foregroundStyle(.tt.textSecondary)
                    }
                }
            }
        }
    }

    private var deviceInfoRow: some View {
        menuRow(icon: "iphone", title: L10n.Profile.deviceId) {
            Text(String(KeychainService.shared.getOrCreateDeviceId().prefix(8)) + "...")
                .font(.tt.meta)
                .foregroundStyle(.tt.textSecondary)
        }
    }

    private var logoutButton: some View {
        Button(role: .destructive) {
            showLogoutConfirm = true
        } label: {
            Text(L10n.Profile.logout)
                .font(.tt.subtitleSemibold)
                .frame(maxWidth: .infinity)
                .padding(.vertical, TTSpacing.lg)
                .background(
                    RoundedRectangle(cornerRadius: TTRadius.md)
                        .fill(.tt.bgCritical.opacity(0.08))
                )
        }
    }

    private func chevronRow(icon: String, title: String) -> some View {
        menuRow(icon: icon, title: title) { chevron }
    }

    private func menuRow<Trailing: View>(
        icon: String,
        title: String,
        @ViewBuilder trailing: () -> Trailing
    ) -> some View {
        HStack(spacing: TTSpacing.md) {
            Image(systemName: icon)
                .font(.system(size: 18))
                .foregroundStyle(.tt.iconAccent)
                .frame(width: 28)
            Text(title)
                .font(.tt.subtitle)
                .foregroundStyle(.tt.textPrimary)
            Spacer()
            trailing()
        }
        .padding(.vertical, TTSpacing.lg)
        .contentShape(Rectangle())
    }

    private func menuGroup<Content: View>(@ViewBuilder content: () -> Content) -> some View {
        VStack(spacing: 0) { content() }
            .padding(.horizontal, TTSpacing.xl)
    }

    private var chevron: some View {
        Image(systemName: "chevron.right")
            .font(.system(size: 12, weight: .semibold))
            .foregroundStyle(.tt.textTertiary)
    }

    private func workspaceIcon(_ organization: Organization, size: CGFloat) -> some View {
        ProfileAvatarView(
            name: organization.name,
            imageURL: organization.logoURL,
            size: size,
            cornerRadius: size * 0.24,
            fallbackText: organization.avatarFallbackText
        )
    }

    private func errorRetry(_ message: String) -> some View {
        Button {
            Task { await reload() }
        } label: {
            Label(message, systemImage: "exclamationmark.triangle")
                .font(.tt.meta)
                .foregroundStyle(.tt.textCritical)
        }
    }

    private var reloadError: String? {
        profileLoadError ?? workspace.errorMessage ?? invitations.errorMessage
    }

    private func reload() async {
        // `.task`、下拉刷新和错误重试共用同一入口；首个加载未结束时沿用该加载，
        // 避免旧请求晚于新请求回写资料/错误状态。
        guard !isReloading else { return }
        isReloading = true
        defer { isReloading = false }

        do {
            try await auth.fetchProfile()
            profileLoadError = nil
        } catch {
            // `.task` / `.refreshable` 会在切 Tab、退出页面时被 SwiftUI 主动取消。
            // 取消不是资料加载失败，也不能继续串行触发 organizations / my-pending。
            if error.isCancellation || Task.isCancelled { return }
            profileLoadError = error.localizedDescription
        }

        guard !Task.isCancelled else { return }
        await workspace.loadOrganizations()
        guard !Task.isCancelled else { return }
        await invitations.loadMyPendingInvitations()
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

struct DebugSettingsScreen: View {
    @State private var settings = DebugEnvironmentSettings.shared
    @State private var preset = DebugEnvironmentSettings.shared.preset
    @State private var customBaseURL = DebugEnvironmentSettings.shared.customBaseURL
    @State private var advancedEnabled = DebugEnvironmentSettings.shared.advancedEnabled
    @State private var advancedAPIURL = DebugEnvironmentSettings.shared.advancedAPIURL
    @State private var advancedWSURL = DebugEnvironmentSettings.shared.advancedWSURL
    @State private var advancedWebURL = DebugEnvironmentSettings.shared.advancedWebURL
    @State private var advancedCentrifugoURL = DebugEnvironmentSettings.shared.advancedCentrifugoURL
    @State private var sentryDSN = SentryDSN.stored
    @State private var message: String?
    @State private var isApplying = false
    @State private var showQRScanner = false
    @State private var deviceIdCopied = false

    var body: some View {
        @Bindable var settings = settings

        Form {
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

            Section("当前连接") {
                debugValueRow(
                    title: "API（通知等 REST 请求同此地址）",
                    value: settings.effectiveAPIBaseURL,
                    projectDefault: AppConfig.configuredAPIBaseURL,
                    systemImage: "network"
                )
                debugValueRow(
                    title: "任务 WebSocket",
                    value: settings.effectiveWSBaseURL,
                    projectDefault: AppConfig.configuredWSBaseURL,
                    systemImage: "bolt.horizontal.fill"
                )
                debugValueRow(
                    title: "Web",
                    value: settings.effectiveWebBaseURL,
                    projectDefault: AppConfig.configuredWebBaseURL,
                    systemImage: "globe"
                )
                debugValueRow(
                    title: "消息实时连接",
                    value: settings.effectiveCentrifugoURL,
                    projectDefault: AppConfig.configuredCentrifugoWSURL,
                    systemImage: "antenna.radiowaves.left.and.right"
                )
            }

            Section("环境") {
                Picker(selection: $preset) {
                    ForEach(DebugEnvironmentPreset.allCases) { option in
                        Text(option.title).tag(option)
                    }
                } label: {
                    TTSettingsDetailLabel(title: "环境", systemImage: "server.rack")
                }
                if preset == .custom {
                    TextField("基础地址，例如 http://1.2.3.4:1234", text: $customBaseURL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .keyboardType(.URL)
                    Text("自动生成：/api、/ws/v1/gateway、Web 根路径、/connection/websocket。")
                        .font(.tt.caption)
                        .foregroundStyle(.tt.textTertiary)
                    Button {
                        showQRScanner = true
                    } label: {
                        TTSettingsDetailLabel(
                            title: L10n.Debug.scanQRCode,
                            systemImage: "qrcode.viewfinder",
                            tone: .accent
                        )
                    }
                    Text(L10n.Debug.scanQRCodeHint)
                        .font(.tt.caption)
                        .foregroundStyle(.tt.textTertiary)
                }
            }

            Section("高级自定义") {
                Toggle(isOn: $advancedEnabled) {
                    TTSettingsDetailLabel(
                        title: "独立覆盖某个地址",
                        systemImage: "slider.horizontal.3"
                    )
                }
                    .tint(.tt.bgAccent)
                if advancedEnabled {
                    endpointField("API", text: $advancedAPIURL, example: "https://api.example.com/api")
                    endpointField("任务 WebSocket", text: $advancedWSURL, example: "wss://api.example.com/ws/v1/gateway")
                    endpointField("Web", text: $advancedWebURL, example: "https://web.example.com")
                    endpointField("消息实时连接", text: $advancedCentrifugoURL, example: "wss://centrifugo.example.com/connection/websocket")
                    Text("留空即沿用上方环境自动生成的地址。")
                        .font(.tt.caption)
                        .foregroundStyle(.tt.textTertiary)
                }
            }

            Section(L10n.Debug.sentrySection) {
                TextField(L10n.Debug.sentryDSN, text: $sentryDSN)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .keyboardType(.URL)
                Text(L10n.Debug.sentryDSNHint)
                    .font(.tt.caption)
                    .foregroundStyle(.tt.textTertiary)
            }

            #if DEBUGSWIFT_ENABLED
            Section(L10n.Debug.debugSwiftSection) {
                Toggle(isOn: $settings.isDebugSwiftVisible) {
                    TTSettingsDetailLabel(
                        title: L10n.Debug.debugSwiftFloatingWindow,
                        systemImage: "ladybug.fill",
                        tone: .warning
                    )
                }
                    .tint(.tt.bgAccent)
            }
            #endif

            Section {
                Button {
                    Task { await apply() }
                } label: {
                    HStack(spacing: TTSpacing.md) {
                        TTSettingsDetailLabel(
                            title: L10n.Debug.apply,
                            systemImage: "checkmark.circle.fill",
                            tone: .success
                        )
                        Spacer()
                        if isApplying { ProgressView().controlSize(.small) }
                    }
                }
                .disabled(isApplying || !hasDraftChanges)

                Button(role: .destructive) {
                    Task { await reset() }
                } label: {
                    TTSettingsDetailLabel(
                        title: L10n.Debug.reset,
                        systemImage: "arrow.counterclockwise",
                        tone: .critical
                    )
                }
                .disabled(isApplying)
            }
        }
        .ttSettingsDetailFormStyle()
        .navigationTitle(L10n.Debug.title)
        .navigationBarTitleDisplayMode(.inline)
        .ttTabBarHidden(true)
        .sheet(isPresented: $showQRScanner) {
            MobileEnvironmentQRScannerSheet(onScan: handleScannedQRCode)
        }
        .alert(L10n.Debug.title, isPresented: Binding(
            get: { message != nil },
            set: { if !$0 { message = nil } }
        )) {
            Button(L10n.Common.confirm, role: .cancel) { message = nil }
        } message: {
            Text(message ?? "")
        }
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

    private func endpointField(_ title: String, text: Binding<String>, example: String) -> some View {
        TextField("\(title)，例如 \(example)", text: text)
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
            .keyboardType(.URL)
    }

    private func debugValueRow(
        title: String,
        value: String,
        projectDefault: String,
        systemImage: String
    ) -> some View {
        HStack(alignment: .top, spacing: TTSpacing.md) {
            TTSettingsDetailIcon(systemImage: systemImage, tone: .neutral)
            VStack(alignment: .leading, spacing: TTSpacing.xxs) {
                Text(title)
                    .font(.tt.metaSemibold)
                    .foregroundStyle(.tt.textSecondary)
                Text(value)
                    .font(.system(.caption, design: .monospaced))
                    .foregroundStyle(.tt.textPrimary)
                    .textSelection(.enabled)
                if value != projectDefault {
                    Text(L10n.Debug.projectDefault(projectDefault))
                        .font(.tt.caption)
                        .foregroundStyle(.tt.textTertiary)
                        .textSelection(.enabled)
                }
            }
        }
        .padding(.vertical, TTSpacing.xxs)
    }

    private var hasDraftChanges: Bool {
        hasNetworkDraftChanges || SentryDSN.normalize(sentryDSN) != SentryDSN.stored
    }

    private var hasNetworkDraftChanges: Bool {
        preset != settings.preset
            || customBaseURL != settings.customBaseURL
            || advancedEnabled != settings.advancedEnabled
            || advancedAPIURL != settings.advancedAPIURL
            || advancedWSURL != settings.advancedWSURL
            || advancedWebURL != settings.advancedWebURL
            || advancedCentrifugoURL != settings.advancedCentrifugoURL
    }

    private func apply() async {
        if let validationMessage = validate() {
            message = validationMessage
            return
        }
        guard SentryReporter.apply(dsn: sentryDSN) else {
            message = L10n.Debug.invalidSentryDSN
            return
        }
        sentryDSN = SentryDSN.stored
        guard hasNetworkDraftChanges else {
            message = L10n.Debug.sentryApplied
            return
        }
        isApplying = true
        settings.preset = preset
        settings.customBaseURL = customBaseURL
        settings.advancedEnabled = advancedEnabled
        settings.advancedAPIURL = advancedAPIURL
        settings.advancedWSURL = advancedWSURL
        settings.advancedWebURL = advancedWebURL
        settings.advancedCentrifugoURL = advancedCentrifugoURL
        settings.applyNetworkingAndQuit()
        isApplying = false
        message = L10n.Debug.applied
    }

    private func handleScannedQRCode(_ rawValue: String) {
        do {
            let configuration = try MobileEnvironmentQRCode.parse(rawValue)
            preset = .custom
            customBaseURL = configuration.webURL
            advancedEnabled = true
            advancedAPIURL = configuration.apiURL
            advancedWSURL = configuration.websocketURL
            advancedWebURL = configuration.webURL
            advancedCentrifugoURL = configuration.centrifugoURL
            message = L10n.Debug.scanSucceeded
        } catch {
            message = L10n.Debug.invalidQRCode
        }
    }

    private func reset() async {
        isApplying = true
        settings.resetNetworkingAndQuit()
        syncDraftFromSettings()
        isApplying = false
        message = L10n.Debug.applied
    }

    private func validate() -> String? {
        if preset == .custom && !isValidURL(customBaseURL, schemes: ["http", "https"]) {
            return "基础地址无效"
        }
        guard advancedEnabled else { return nil }
        let values: [(String, String, Set<String>)] = [
            ("API", advancedAPIURL, ["http", "https"]),
            ("任务 WebSocket", advancedWSURL, ["ws", "wss"]),
            ("Web", advancedWebURL, ["http", "https"]),
            ("消息实时连接", advancedCentrifugoURL, ["ws", "wss"]),
        ]
        for (title, value, schemes) in values where !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            if !isValidURL(value, schemes: schemes) { return "\(title) 地址无效" }
        }
        return nil
    }

    private func syncDraftFromSettings() {
        preset = settings.preset
        customBaseURL = settings.customBaseURL
        advancedEnabled = settings.advancedEnabled
        advancedAPIURL = settings.advancedAPIURL
        advancedWSURL = settings.advancedWSURL
        advancedWebURL = settings.advancedWebURL
        advancedCentrifugoURL = settings.advancedCentrifugoURL
    }

    private func isValidURL(_ raw: String, schemes: Set<String>) -> Bool {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let url = URL(string: trimmed),
              let scheme = url.scheme?.lowercased(),
              schemes.contains(scheme),
              url.host != nil else {
            return false
        }
        return true
    }
}

/// 顶栏会随 Tab 与导航层级重建。`AsyncImage` 的新实例总会先进入空态，即使
/// URLSession 已缓存响应，也会让头像短暂回退为首字母。这里保存已解码图片，使
/// 同一头像 URL 的后续视图创建可以同步展示真实头像。
final class AvatarImageMemoryCache: @unchecked Sendable {
    static let shared = AvatarImageMemoryCache()

    private let images = NSCache<NSURL, UIImage>()
    private let lock = NSLock()
    private var inFlight: [URL: Task<Data?, Never>] = [:]

    func cachedImage(for url: URL?) -> UIImage? {
        guard let url else { return nil }
        return images.object(forKey: url as NSURL)
    }

    func store(_ image: UIImage, for url: URL) {
        images.setObject(image, forKey: url as NSURL)
    }

    func image(for url: URL) async -> UIImage? {
        if let image = cachedImage(for: url) {
            return image
        }

        let task = loadTask(for: url)

        guard let data = await task.value,
              let image = UIImage(data: data) else {
            completeLoad(for: url)
            return nil
        }

        store(image, for: url)
        completeLoad(for: url)
        return image
    }

    private func loadTask(for url: URL) -> Task<Data?, Never> {
        lock.lock()
        defer { lock.unlock() }

        if let existingTask = inFlight[url] {
            return existingTask
        }

        let task: Task<Data?, Never> = Task.detached(priority: .userInitiated) {
            let request = URLRequest(url: url)
            let span = DiagnosticRecorder.beginHTTP(request)
            do {
                let (data, response) = try await URLSession.shared.data(for: request)
                let status = (response as? HTTPURLResponse)?.statusCode
                await DiagnosticRecorder.shared.finishHTTP(span, statusCode: status, responseBytes: data.count)
                guard let status, (200 ..< 300).contains(status) else { return nil }
                return data
            } catch {
                await DiagnosticRecorder.shared.finishHTTP(
                    span,
                    statusCode: nil,
                    responseBytes: nil,
                    errorClass: String(describing: type(of: error))
                )
                return nil
            }
        }
        inFlight[url] = task
        return task
    }

    private func completeLoad(for url: URL) {
        lock.lock()
        inFlight[url] = nil
        lock.unlock()
    }
}

struct ProfileAvatarView: View {
    let name: String
    let imageURL: URL?
    let size: CGFloat
    var seed: String? = nil
    var cornerRadius: CGFloat? = nil
    var fallbackText: String? = nil
    @State private var loadedImage: UIImage?
    @State private var loadedImageURL: URL?

    private var initials: String {
        fallbackText ?? IdentityAvatar.initials(name)
    }

    private var usesIdentityColor: Bool { seed != nil }

    private var fallbackFill: Color {
        usesIdentityColor
            ? IdentityAvatar.color(IdentityAvatar.colorSeed(seed, fallbackName: name))
            : Color.tt.bgAccent.opacity(0.14)
    }

    private var fallbackForeground: Color {
        usesIdentityColor ? .white : .tt.iconAccent
    }

    var body: some View {
        Group {
            if let image = displayedImage {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFill()
            } else {
                placeholder
            }
        }
        .frame(width: size, height: size)
        .clipShape(RoundedRectangle(cornerRadius: resolvedCornerRadius))
        .task(id: imageURL) {
            guard let imageURL else {
                loadedImage = nil
                loadedImageURL = nil
                return
            }

            if let image = AvatarImageMemoryCache.shared.cachedImage(for: imageURL) {
                loadedImage = image
                loadedImageURL = imageURL
                return
            }

            loadedImage = nil
            loadedImageURL = nil
            if let image = await AvatarImageMemoryCache.shared.image(for: imageURL) {
                loadedImage = image
                loadedImageURL = imageURL
            }
        }
    }

    private var displayedImage: UIImage? {
        if loadedImageURL == imageURL {
            return loadedImage
        }
        return AvatarImageMemoryCache.shared.cachedImage(for: imageURL)
    }

    private var placeholder: some View {
        ZStack {
            RoundedRectangle(cornerRadius: resolvedCornerRadius)
                .fill(fallbackFill)
            Text(usesIdentityColor || initials != "?" ? initials : "U")
                .font(.system(size: max(12, size * 0.33), weight: .semibold))
                .foregroundStyle(fallbackForeground)
        }
    }

    private var resolvedCornerRadius: CGFloat {
        cornerRadius ?? size / 2
    }
}

/// 顶栏统一复用当前登录用户的真实头像；图片尚未加载或用户未设置头像时才回退到昵称首字母。
struct CurrentUserAvatarView: View {
    @State private var auth = AuthService.shared
    var size: CGFloat = 30

    var body: some View {
        ProfileAvatarView(
            name: auth.currentUser?.displayName ?? L10n.Profile.defaultName,
            imageURL: auth.currentUser?.avatar.flatMap(URL.init(string:)),
            size: size,
            seed: auth.currentUser?.id
        )
        .overlay {
            Circle()
                .stroke(.tt.borderLight, lineWidth: 0.5)
        }
        .accessibilityHidden(true)
    }
}

enum ProfileInputError: Equatable {
    case nicknameRequired
    case nicknameTooLong
    case usernameLength
    case usernameFormat
    case usernameUnavailable
}

struct ProfileInputValidation: Equatable {
    let normalizedNickname: String
    let normalizedUsername: String
    let nicknameError: ProfileInputError?
    let usernameError: ProfileInputError?

    var isValid: Bool {
        nicknameError == nil && usernameError == nil
    }
}

enum ProfileInputValidator {
    private static let nicknameMaxLength = 50
    private static let usernameMinLength = 3
    private static let usernameMaxLength = 20
    private static let reservedUsernames: Set<String> = [
        "admin", "root", "api", "www", "mail", "ftp", "test",
        "user", "guest", "public", "system", "support", "help"
    ]

    static func validate(nickname: String, username: String) -> ProfileInputValidation {
        let normalizedNickname = nickname.trimmingCharacters(in: .whitespacesAndNewlines)
        let normalizedUsername = username.trimmingCharacters(in: .whitespacesAndNewlines)
        let nicknameError: ProfileInputError? = if normalizedNickname.isEmpty {
            .nicknameRequired
        } else if normalizedNickname.count > nicknameMaxLength {
            .nicknameTooLong
        } else {
            nil
        }
        let usernameError: ProfileInputError? = if !(usernameMinLength...usernameMaxLength).contains(normalizedUsername.count) {
            .usernameLength
        } else if normalizedUsername.range(of: "^[a-zA-Z_][a-zA-Z0-9_]*$", options: .regularExpression) == nil {
            .usernameFormat
        } else if reservedUsernames.contains(normalizedUsername.lowercased()) {
            .usernameUnavailable
        } else {
            nil
        }
        return ProfileInputValidation(
            normalizedNickname: normalizedNickname,
            normalizedUsername: normalizedUsername,
            nicknameError: nicknameError,
            usernameError: usernameError
        )
    }
}

struct ProfileEditScreen: View {
    @Environment(\.dismiss) private var dismiss
    @State private var auth = AuthService.shared
    @State private var nickname = ""
    @State private var username = ""
    @State private var bio = ""
    @State private var selectedPhoto: PhotosPickerItem?
    @State private var avatarImage: Image?
    @State private var isSaving = false
    @State private var isUploadingAvatar = false
    @State private var errorMessage: String?

    private static let bioMaxLength = 500
    private var profileValidation: ProfileInputValidation {
        ProfileInputValidator.validate(nickname: nickname, username: username)
    }

    private var usernameError: String? {
        switch profileValidation.usernameError {
        case .usernameLength: L10n.Profile.usernameLength
        case .usernameFormat: L10n.Profile.usernameFormat
        case .usernameUnavailable: L10n.Profile.usernameUnavailable
        default: nil
        }
    }

    private var nicknameError: String? {
        switch profileValidation.nicknameError {
        case .nicknameRequired: L10n.Profile.nicknameRequired
        case .nicknameTooLong: L10n.Profile.nicknameTooLong(50)
        default: nil
        }
    }

    private var hasChanges: Bool {
        profileValidation.normalizedNickname != (auth.currentUser?.nickname ?? "")
            || profileValidation.normalizedUsername != (auth.currentUser?.username ?? "")
            || bio != (auth.currentUser?.bio ?? "")
            || avatarImage != nil
    }

    var body: some View {
        NavigationStack {
            Form {
                if let errorMessage {
                    Section {
                        Label(errorMessage, systemImage: "exclamationmark.triangle")
                            .foregroundStyle(.tt.textCritical)
                    }
                }

                Section {
                    avatarPicker
                }

                Section(L10n.Profile.basicInfoHeader) {
                    TextField(L10n.Profile.nicknameLabel, text: $nickname)
                    if let nicknameError {
                        Text(nicknameError).font(.caption).foregroundStyle(.tt.textCritical)
                    }

                    HStack(spacing: 0) {
                        Text("@").foregroundStyle(.tt.textTertiary)
                        TextField(L10n.Profile.usernameLabel, text: $username)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                    }
                    if let usernameError {
                        Text(usernameError).font(.caption).foregroundStyle(.tt.textCritical)
                    }
                }

                Section(L10n.Profile.bioLabel) {
                    TextField(L10n.Profile.bioPlaceholder, text: $bio, axis: .vertical)
                        .lineLimit(3...6)
                    HStack {
                        if bio.count > Self.bioMaxLength {
                            Text(L10n.Profile.bioTooLong(Self.bioMaxLength))
                                .foregroundStyle(.tt.textCritical)
                        }
                        Spacer()
                        Text("\(bio.count)/\(Self.bioMaxLength)")
                            .foregroundStyle(.tt.textTertiary)
                    }
                    .font(.caption)
                }
            }
            .ttFormStyle()
            .navigationTitle(L10n.Profile.editTitle)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(L10n.Common.cancel) { dismiss() }
                        .disabled(isSaving || isUploadingAvatar)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(L10n.Common.save) {
                        Task { await save() }
                    }
                    .fontWeight(.semibold)
                    .disabled(!canSave)
                }
            }
            .ttLoading(isSaving || isUploadingAvatar)
            .onAppear { loadCurrentValues() }
            .onChange(of: selectedPhoto) { _, newValue in
                Task { await handlePhotoSelection(newValue) }
            }
        }
    }

    private var canSave: Bool {
        hasChanges && !isSaving && !isUploadingAvatar && profileValidation.isValid && bio.count <= Self.bioMaxLength
    }

    private var avatarPicker: some View {
        let displayName = auth.currentUser?.displayName ?? L10n.Profile.defaultName
        let avatarURL = auth.currentUser?.avatar.flatMap(URL.init(string:))
        let image = avatarImage
        return HStack {
            Spacer()
            PhotosPicker(selection: $selectedPhoto, matching: .images) {
                VStack(spacing: TTSpacing.sm) {
                    ZStack(alignment: .bottomTrailing) {
                        if let image {
                            image.resizable().scaledToFill()
                                .frame(width: 82, height: 82)
                                .clipShape(Circle())
                        } else {
                            ProfileAvatarView(
                                name: displayName,
                                imageURL: avatarURL,
                                size: 82,
                                seed: auth.currentUser?.id
                            )
                        }
                        Image(systemName: "camera.fill")
                            .font(.system(size: 12, weight: .semibold))
                            .foregroundStyle(.tt.textOnAccent)
                            .frame(width: 26, height: 26)
                            .background(Circle().fill(.tt.bgAccent))
                    }
                    Text(L10n.Profile.changeAvatar)
                        .font(.tt.meta)
                        .foregroundStyle(.tt.textAccent)
                }
            }
            .disabled(isUploadingAvatar)
            Spacer()
        }
        .listRowBackground(Color.clear)
    }

    private func loadCurrentValues() {
        nickname = auth.currentUser?.nickname ?? ""
        username = auth.currentUser?.username ?? ""
        bio = auth.currentUser?.bio ?? ""
    }

    private func save() async {
        guard canSave else { return }
        let validation = profileValidation
        guard validation.isValid else { return }
        isSaving = true
        errorMessage = nil
        defer { isSaving = false }

        do {
            let user = auth.currentUser
            try await auth.updateProfile(
                nickname: validation.normalizedNickname != (user?.nickname ?? "") ? validation.normalizedNickname : nil,
                username: validation.normalizedUsername != (user?.username ?? "") ? validation.normalizedUsername : nil,
                bio: bio != (user?.bio ?? "") ? bio : nil
            )
            dismiss()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func handlePhotoSelection(_ item: PhotosPickerItem?) async {
        guard let item else { return }
        isUploadingAvatar = true
        defer { isUploadingAvatar = false }

        guard let data = try? await item.loadTransferable(type: Data.self),
              let uiImage = UIImage(data: data) else {
            errorMessage = L10n.Profile.imageReadFailed
            return
        }

        avatarImage = Image(uiImage: uiImage)
        do {
            let resized = resizeImage(uiImage, maxDimension: 512)
            guard let jpeg = resized.jpegData(compressionQuality: 0.8) else {
                errorMessage = L10n.Profile.imageProcessFailed
                avatarImage = nil
                return
            }

            let userId = auth.currentUser?.id
            // 对齐 Electron UserAvatarUploader：module=user + context=avatar/userId + is_public，
            // 持久化走 avatar_file_id（UAVTR），旧头像 FileUsage 由后端负责 deactivate。
            let result = try await OSSUploadService.shared.directUpload(
                data: jpeg,
                fileName: "user-\(userId ?? "unknown")-\(Int(Date().timeIntervalSince1970)).jpg",
                contentType: "image/jpeg",
                folder: "user-avatars",
                scope: UploadScope(
                    module: "user",
                    contextType: "avatar",
                    contextId: userId ?? "",
                    organizationId: WorkspaceStore.shared.selectedOrganizationId ?? "",
                    isPublic: true
                )
            )

            do {
                try await auth.updateProfile(avatarFileId: result.fileId)
                avatarImage = nil
            } catch {
                await OSSUploadService.shared.deleteFile(fileId: result.fileId)
                throw error
            }
        } catch {
            errorMessage = OSSBusinessError.userMessage(for: error)
            avatarImage = nil
        }
    }

    private func resizeImage(_ image: UIImage, maxDimension: CGFloat) -> UIImage {
        let size = image.size
        guard max(size.width, size.height) > maxDimension else { return image }
        let scale = maxDimension / max(size.width, size.height)
        let newSize = CGSize(width: size.width * scale, height: size.height * scale)
        return UIGraphicsImageRenderer(size: newSize).image { _ in
            image.draw(in: CGRect(origin: .zero, size: newSize))
        }
    }
}

struct NotificationSettingsScreen: View {
    @Environment(\.scenePhase) private var scenePhase
    @State private var authorizationStatus: UNAuthorizationStatus = .notDetermined
    @Bindable private var preferences = MobilePushPreferencesStore.shared

    private let notificationCenter = UNUserNotificationCenter.current()

    var body: some View {
        List {
            Section(L10n.Profile.notificationsCategories) {
                Toggle(
                    L10n.Profile.notificationsApprovalTitle,
                    isOn: Binding(
                        get: { preferences.value.approval },
                        set: { preferences.setApproval($0) }
                    )
                )
                Toggle(
                    L10n.Profile.notificationsTaskTitle,
                    isOn: Binding(
                        get: { preferences.value.taskCompleted },
                        set: { preferences.setTaskCompleted($0) }
                    )
                )
                Toggle(
                    L10n.Profile.notificationsChatTitle,
                    isOn: Binding(
                        get: { preferences.value.messages },
                        set: { preferences.setMessages($0) }
                    )
                )
                if !preferences.value.messages {
                    Toggle(
                        L10n.Profile.notificationsMentionsTitle,
                        isOn: Binding(
                            get: { preferences.value.mentions },
                            set: { preferences.setMentions($0) }
                        )
                    )
                }
            }

            Section(L10n.Profile.notificationsPermission) {
                switch authorizationStatus {
                case .authorized, .provisional:
                    TTSettingsDetailLabel(
                        title: L10n.Profile.notificationsEnabled,
                        systemImage: "bell.badge.fill",
                        tone: .success
                    )
                case .denied:
                    TTSettingsDetailLabel(
                        title: L10n.Profile.notificationsDenied,
                        systemImage: "bell.slash.fill",
                        tone: .warning
                    )
                    Button { openSystemSettings() } label: {
                        TTSettingsDetailLabel(
                            title: L10n.Profile.notificationsOpenSettings,
                            systemImage: "gearshape.fill",
                            tone: .neutral
                        )
                    }
                default:
                    TTSettingsDetailLabel(
                        title: L10n.Profile.notificationsNotDetermined,
                        systemImage: "bell.badge.fill"
                    )
                    Button {
                        Task { await requestPermission() }
                    } label: {
                        TTSettingsDetailLabel(
                            title: L10n.Profile.notificationsEnable,
                            systemImage: "checkmark.shield.fill",
                            tone: .success
                        )
                    }
                }
            }
        }
        .ttSettingsDetailListStyle()
        .navigationTitle(L10n.Profile.notificationsTitle)
        .navigationBarTitleDisplayMode(.inline)
        .ttTabBarHidden(true)
        .task {
            preferences.bootstrap()
            await checkPermission()
        }
        .onChange(of: scenePhase) { _, newPhase in
            if newPhase == .active { Task { await checkPermission() } }
        }
    }

    private func checkPermission() async {
        let settings = await notificationCenter.notificationSettings()
        authorizationStatus = settings.authorizationStatus
    }

    private func requestPermission() async {
        do {
            authorizationStatus = try await notificationCenter.requestAuthorization(options: [.alert, .badge, .sound])
                ? .authorized : .denied
        } catch {
            authorizationStatus = .denied
        }
    }

    private func openSystemSettings() {
        guard let url = URL(string: UIApplication.openSettingsURLString) else { return }
        UIApplication.shared.open(url)
    }
}

struct VoiceSettingsScreen: View {
    @Bindable private var settings = VoiceSettings.shared

    var body: some View {
        List {
            Section {
                NavigationLink {
                    VoicePlatformHotwordsView()
                } label: {
                    navigationLabel(
                        icon: "text.badge.checkmark",
                        title: L10n.Profile.voicePlatformTitle,
                        value: L10n.Profile.voiceAutoEnabled
                    )
                }
            }

            Section {
                Toggle(isOn: $settings.enableAppContext) {
                    TTSettingsDetailLabel(
                        title: L10n.Profile.voiceAppContextTitle,
                        subtitle: L10n.Profile.voiceAppContextDesc,
                        systemImage: "square.stack.3d.up.fill"
                    )
                }
                .tint(.tt.bgAccent)
                Toggle(isOn: $settings.enableDialogContext) {
                    TTSettingsDetailLabel(
                        title: L10n.Profile.voiceDialogContextTitle,
                        subtitle: L10n.Profile.voiceDialogContextDesc,
                        systemImage: "bubble.left.and.bubble.right.fill"
                    )
                }
                .tint(.tt.bgAccent)
            }

            Section {
                NavigationLink {
                    VoiceCustomHotwordsView()
                } label: {
                    navigationLabel(
                        icon: "text.badge.plus",
                        title: L10n.Profile.voiceHotwordHeader,
                        value: settings.customHotwords.isEmpty ? nil : "\(settings.customHotwords.count)"
                    )
                }
                NavigationLink {
                    VoiceReplacementRulesView()
                } label: {
                    navigationLabel(
                        icon: "arrow.left.arrow.right",
                        title: L10n.Profile.voiceReplacementHeader,
                        value: settings.replacementRules.isEmpty ? nil : "\(settings.replacementRules.count)"
                    )
                }
            }
        }
        .ttSettingsDetailListStyle()
        .navigationTitle(L10n.Profile.voiceTitle)
        .navigationBarTitleDisplayMode(.inline)
        .ttTabBarHidden(true)
    }

    private func navigationLabel(icon: String, title: String, value: String? = nil) -> some View {
        HStack(spacing: TTSpacing.md) {
            TTSettingsDetailLabel(title: title, systemImage: icon)
            Spacer()
            if let value {
                Text(value).font(.tt.meta).foregroundStyle(.tt.textTertiary)
            }
        }
    }
}

private struct VoicePlatformHotwordsView: View {
    private let categories: [(String, [String])] = [
        (L10n.Profile.voiceCategoryProduct, ["TabTin", "TabData", "TabDoc", "TabSlide"]),
        (L10n.Profile.voiceCategoryAgent, ["Agent", "Agentspace", "Space", "RAG", "Prompt"]),
        (L10n.Profile.voiceCategoryFeature, ["Skill", "Memo", "Composer", "Crawler"]),
    ]

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: TTSpacing.xl) {
                Label(L10n.Profile.voicePlatformDesc, systemImage: "checkmark.circle.fill")
                    .font(.tt.body)
                    .foregroundStyle(.tt.textSecondary)
                ForEach(categories, id: \.0) { category, words in
                    Text(category).font(.tt.metaSemibold).foregroundStyle(.tt.textSecondary)
                    tagGrid(words)
                }
            }
            .padding(.horizontal, TTSpacing.xl)
            .padding(.vertical, TTSpacing.lg)
        }
        .background(.tt.bgCanvasDefault, ignoresSafeAreaEdges: .all)
        .navigationTitle(L10n.Profile.voicePlatformTitle)
        .navigationBarTitleDisplayMode(.inline)
        .ttToolbarBackground()
    }
}

private struct VoiceCustomHotwordsView: View {
    @Bindable private var settings = VoiceSettings.shared
    @State private var newWord = ""

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: TTSpacing.xl) {
                HStack {
                    TextField(L10n.Profile.voiceHotwordPlaceholder, text: $newWord)
                        .textFieldStyle(.roundedBorder)
                        .onSubmit { commit() }
                    Button { commit() } label: {
                        Image(systemName: "plus.circle.fill")
                    }
                    .disabled(newWord.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
                if settings.customHotwords.isEmpty {
                    ContentUnavailableView(L10n.Profile.voiceHotwordEmpty, systemImage: "text.badge.plus")
                } else {
                    LazyVGrid(columns: [GridItem(.adaptive(minimum: 88), spacing: TTSpacing.sm)], alignment: .leading, spacing: TTSpacing.sm) {
                        ForEach(Array(settings.customHotwords.enumerated()), id: \.element) { index, word in
                            Button {
                                settings.removeHotword(at: index)
                            } label: {
                                Label(word, systemImage: "xmark")
                                    .font(.tt.meta)
                                    .lineLimit(1)
                            }
                            .buttonStyle(.bordered)
                        }
                    }
                }
            }
            .padding(.horizontal, TTSpacing.xl)
            .padding(.vertical, TTSpacing.lg)
        }
        .background(.tt.bgCanvasDefault, ignoresSafeAreaEdges: .all)
        .navigationTitle(L10n.Profile.voiceHotwordHeader)
        .navigationBarTitleDisplayMode(.inline)
        .ttToolbarBackground()
    }

    private func commit() {
        settings.addHotword(newWord)
        newWord = ""
    }
}

private struct VoiceReplacementRulesView: View {
    @Bindable private var settings = VoiceSettings.shared
    @State private var from = ""
    @State private var to = ""

    var body: some View {
        List {
            Section(L10n.Profile.voiceReplacementAdd) {
                TextField(L10n.Profile.voiceReplacementFromPlaceholder, text: $from)
                TextField(L10n.Profile.voiceReplacementToPlaceholder, text: $to)
                Button(L10n.Common.create) { commit() }
                    .disabled(from.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || to.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
            Section(L10n.Profile.voiceReplacementHeader) {
                if settings.replacementRules.isEmpty {
                    Text(L10n.Profile.voiceReplacementEmpty).foregroundStyle(.tt.textTertiary)
                }
                ForEach(Array(settings.replacementRules.enumerated()), id: \.element.id) { index, rule in
                    HStack {
                        Button {
                            settings.toggleReplacementRule(at: index)
                        } label: {
                            Image(systemName: rule.isEnabled ? "checkmark.circle.fill" : "circle")
                        }
                        Text(rule.from)
                        Image(systemName: "arrow.right")
                        Text(rule.to).foregroundStyle(.tt.textAccent)
                        Spacer()
                        Button(role: .destructive) {
                            settings.removeReplacementRule(at: index)
                        } label: {
                            Image(systemName: "trash")
                        }
                    }
                }
            }
        }
        .ttSettingsDetailListStyle()
        .navigationTitle(L10n.Profile.voiceReplacementHeader)
        .navigationBarTitleDisplayMode(.inline)
    }

    private func commit() {
        settings.addReplacementRule(from: from, to: to)
        from = ""
        to = ""
    }
}

private func tagGrid(_ words: [String]) -> some View {
    LazyVGrid(columns: [GridItem(.adaptive(minimum: 84), spacing: TTSpacing.sm)], alignment: .leading, spacing: TTSpacing.sm) {
        ForEach(words, id: \.self) { word in
            Text(word)
                .font(.tt.meta)
                .foregroundStyle(.tt.textPrimary)
                .padding(.horizontal, TTSpacing.sm)
                .padding(.vertical, TTSpacing.xs)
                .frame(maxWidth: .infinity)
                .background(RoundedRectangle(cornerRadius: TTRadius.xs).fill(.tt.bgSubtle))
        }
    }
}

struct AboutScreen: View {
    var body: some View {
        List {
            Section {
                VStack(spacing: TTSpacing.lg) {
                    Image(systemName: "sparkle")
                        .font(.system(size: 48))
                        .foregroundStyle(.tt.iconAccent)
                        .accessibilityHidden(true)
                    VStack(spacing: TTSpacing.xs) {
                        Text("TabTin")
                            .font(.tt.titleSemibold)
                            .foregroundStyle(.tt.textPrimary)
                        Text(L10n.Profile.aboutVersionFormat(AppConfig.appVersion, AppConfig.buildNumber))
                            .font(.tt.body)
                            .foregroundStyle(.tt.textSecondary)
                    }
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, TTSpacing.xxl)
                .listRowBackground(Color.clear)
            }
            Section {
                externalLink(L10n.Profile.aboutWebsite, icon: "globe", url: "https://www.example.com")
                externalLink(L10n.Profile.aboutHelp, icon: "questionmark.circle", url: "https://www.example.com/help/")
            }
            Section {
                externalLink(L10n.Profile.aboutPrivacy, icon: "hand.raised", url: PrivacyConsentStore.privacyPolicyURL.absoluteString)
                externalLink(
                    L10n.Profile.aboutTerms,
                    icon: "doc.text",
                    url: "https://assets.example.com/tabtin-agreement/TabTin%E6%A1%8C%E9%9D%A2%E7%AB%AF%E7%94%A8%E6%88%B7%E5%8D%8F%E8%AE%AE-V1.0%E4%B8%AD%E8%8B%B1%E5%8F%8C%E8%AF%AD%E7%89%88.pdf"
                )
            } footer: {
                Text("© \(Calendar.current.component(.year, from: Date())) TabTin")
                    .frame(maxWidth: .infinity, alignment: .center)
            }
        }
        .ttSettingsDetailListStyle()
        .navigationTitle(L10n.Profile.aboutTitle)
        .navigationBarTitleDisplayMode(.inline)
    }

    private func externalLink(_ title: String, icon: String, url: String) -> some View {
        Link(destination: URL(string: url)!) {
            Label {
                HStack {
                    Text(title).foregroundStyle(.tt.textPrimary)
                    Spacer()
                    Image(systemName: "arrow.up.right").foregroundStyle(.tt.textTertiary)
                }
            } icon: {
                TTSettingsDetailIcon(systemImage: icon)
            }
        }
    }
}

struct InvitationResponseSheet: View {
    @Environment(\.dismiss) private var dismiss
    @State private var invitations = InvitationService.shared
    let invitation: PendingInvitation
    @State private var isSubmitting = false
    @State private var errorMessage: String?

    var body: some View {
        NavigationStack {
            VStack(spacing: TTSpacing.xl) {
                Text(invitation.workspaceIcon.isEmpty ? "✉️" : invitation.workspaceIcon)
                    .font(.system(size: 52))
                VStack(spacing: TTSpacing.xs) {
                    Text(invitation.workspaceName)
                        .font(.tt.titleSemibold)
                    Text(L10n.Workspace.invitedAs(invitation.role.title))
                        .font(.tt.body)
                        .foregroundStyle(.tt.textSecondary)
                }
                if let errorMessage {
                    Text(errorMessage).foregroundStyle(.tt.textCritical)
                }
                HStack(spacing: TTSpacing.md) {
                    Button(role: .destructive) {
                        Task { await respond(false) }
                    } label: {
                        Text(L10n.Workspace.rejectInvitation).frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.bordered)
                    Button {
                        Task { await respond(true) }
                    } label: {
                        Text(L10n.Workspace.acceptInvitation).frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(.tt.bgAccent)
                }
                Spacer()
            }
            .padding(TTSpacing.xl)
            .navigationTitle(L10n.Workspace.teamInvitation)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(L10n.Common.close) { dismiss() }
                }
            }
            .ttLoading(isSubmitting)
        }
        .presentationDetents([.medium])
    }

    private func respond(_ accept: Bool) async {
        isSubmitting = true
        errorMessage = nil
        defer { isSubmitting = false }
        do {
            _ = try await invitations.respondToInvitation(invitationId: invitation.id, accept: accept)
            dismiss()
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}

struct WorkspaceSettingsScreen: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @State private var workspace = WorkspaceStore.shared
    @State private var invitations = InvitationService.shared
    let organization: Organization
    @State private var showDeleteConfirm = false
    @State private var showLeaveConfirm = false
    @State private var showTransferOwnership = false
    @State private var isMutating = false
    @State private var errorMessage: String?

    private var current: Organization {
        workspace.selectedOrganization?.id == organization.id ? workspace.selectedOrganization ?? organization : organization
    }

    private var isOwner: Bool {
        workspace.isOwner || current.ownerId == AuthService.shared.currentUser?.id
    }

    private var canManage: Bool {
        workspace.canManage
    }

    var body: some View {
        List {
            Section {
                VStack(spacing: TTSpacing.md) {
                    ProfileAvatarView(
                        name: current.name,
                        imageURL: current.logoURL,
                        size: 72,
                        cornerRadius: 18,
                        fallbackText: current.avatarFallbackText
                    )
                    Text(current.name)
                        .font(.tt.titleSemibold)
                    if let desc = current.description, !desc.isEmpty {
                        Text(desc).font(.tt.body).foregroundStyle(.tt.textSecondary)
                    }
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, TTSpacing.lg)
            }

            if let errorMessage {
                Section {
                    Label(errorMessage, systemImage: "exclamationmark.triangle")
                        .font(.tt.meta)
                        .foregroundStyle(.tt.textCritical)
                }
            }

            Section {
                NavigationLink {
                    WorkspaceBasicInfoEditView(organization: current)
                } label: {
                    settingsRow(icon: "pencil", title: L10n.Workspace.basicInfo, value: current.name)
                }
                NavigationLink {
                    WorkspaceMembersScreen(organization: current)
                } label: {
                    settingsRow(icon: "person.2.fill", title: L10n.Workspace.members, value: memberCountText)
                }
                NavigationLink {
                    ExternalContactsScreen(organization: current)
                } label: {
                    settingsRow(icon: "person.2.badge.plus", title: "外部联系人", value: nil)
                }
                if canManage && current.isPersonal != true {
                    NavigationLink {
                        WorkspaceInvitationsScreen(organization: current)
                    } label: {
                        settingsRow(icon: "person.badge.plus", title: L10n.Workspace.invitationManagement, value: "\(invitations.invitations.count)")
                    }
                }
                NavigationLink {
                    WorkspaceCapabilitiesScreen(organization: current)
                } label: {
                    settingsRow(icon: "sparkles", title: L10n.Workspace.capabilitiesTitle, value: nil)
                }
                infoRow(
                    icon: "square.grid.2x2",
                    title: L10n.Workspace.spacesLabel,
                    value: "\(current.spaceCount ?? 0)"
                )
            }

            Section {
                NavigationLink {
                    WorkspaceWalletScreen(organizationId: current.id)
                } label: {
                    settingsRow(icon: "creditcard.fill", title: L10n.Workspace.walletTitle, value: nil)
                }
                NavigationLink {
                    WorkspaceUsageScreen(organizationId: current.id)
                } label: {
                    settingsRow(icon: "chart.pie.fill", title: L10n.Workspace.usageTitle, value: nil)
                }
                NavigationLink {
                    TrashBinEditor(organizationId: current.id)
                } label: {
                    settingsRow(
                        icon: "trash",
                        title: L10n.Workspace.dataRecoveryTitle,
                        subtitle: L10n.Workspace.dataRecoveryDescription,
                        value: nil
                    )
                }
            }

            Section {
                if isOwner && current.isPersonal == false {
                    Button(role: .destructive) {
                        showTransferOwnership = true
                    } label: {
                        dangerRow(
                            icon: "person.crop.circle.badge.arrow.forward",
                            title: L10n.Workspace.transferOwnership,
                            desc: L10n.Workspace.transferOwnershipDescription
                        )
                    }
                }
                if isOwner && current.isDefault != true {
                    Button(role: .destructive) {
                        showDeleteConfirm = true
                    } label: {
                        dangerRow(icon: "trash.fill", title: L10n.Workspace.deleteTeam, desc: L10n.Workspace.deleteTeamDesc)
                    }
                } else if current.isDefault == true {
                    infoRow(icon: "lock.fill", title: L10n.Workspace.defaultTeam, value: L10n.Workspace.cannotDelete)
                } else {
                    Button(role: .destructive) {
                        showLeaveConfirm = true
                    } label: {
                        dangerRow(icon: "rectangle.portrait.and.arrow.right", title: L10n.Workspace.leaveTeam, desc: L10n.Workspace.leaveTeamDesc)
                    }
                }
            }
        }
        .ttSettingsDetailListStyle()
        .navigationTitle(L10n.Workspace.teamSettings)
        .navigationBarTitleDisplayMode(.inline)
        .ttTabBarHidden(true)
        .ttLoading(isMutating)
        .task { await reloadSettings() }
        .refreshable { await reloadSettings() }
        .sheet(isPresented: $showTransferOwnership) {
            WorkspaceTransferOwnershipSheet(organizationId: current.id)
        }
        .alert(L10n.Workspace.deleteTeamConfirm, isPresented: $showDeleteConfirm) {
            Button(L10n.Workspace.deleteTeam, role: .destructive) { Task { await deleteOrganization() } }
            Button(L10n.Common.cancel, role: .cancel) {}
        }
        .alert(L10n.Workspace.leaveTeamConfirm, isPresented: $showLeaveConfirm) {
            Button(L10n.Workspace.leaveTeam, role: .destructive) { Task { await leaveOrganization() } }
            Button(L10n.Common.cancel, role: .cancel) {}
        }
    }

    private var memberCountText: String {
        let count = workspace.members.isEmpty ? current.memberCount ?? 0 : workspace.members.count
        return "\(count)"
    }

    @ViewBuilder
    private func settingsRow(icon: String, title: String, subtitle: String? = nil, value: String?) -> some View {
        if dynamicTypeSize.isAccessibilitySize {
            VStack(alignment: .leading, spacing: TTSpacing.sm) {
                TTSettingsDetailLabel(title: title, subtitle: subtitle, systemImage: icon)
                if let value {
                    Text(value)
                        .font(.tt.meta)
                        .foregroundStyle(.tt.textTertiary)
                        .padding(.leading, 30 + TTSpacing.md)
                }
            }
        } else {
            HStack(spacing: TTSpacing.md) {
                TTSettingsDetailLabel(title: title, subtitle: subtitle, systemImage: icon)
                Spacer()
                if let value { Text(value).font(.tt.meta).foregroundStyle(.tt.textTertiary) }
            }
        }
    }

    @ViewBuilder
    private func infoRow(icon: String, title: String, value: String) -> some View {
        if dynamicTypeSize.isAccessibilitySize {
            VStack(alignment: .leading, spacing: TTSpacing.sm) {
                TTSettingsDetailLabel(title: title, systemImage: icon, tone: .neutral)
                Text(value)
                    .font(.tt.meta)
                    .foregroundStyle(.tt.textSecondary)
                    .padding(.leading, 30 + TTSpacing.md)
            }
        } else {
            HStack(spacing: TTSpacing.md) {
                TTSettingsDetailLabel(title: title, systemImage: icon, tone: .neutral)
                Spacer()
                Text(value).font(.tt.meta).foregroundStyle(.tt.textSecondary)
            }
        }
    }

    private func dangerRow(icon: String, title: String, desc: String) -> some View {
        HStack(spacing: TTSpacing.md) {
            TTSettingsDetailLabel(title: title, subtitle: desc, systemImage: icon, tone: .critical)
            Spacer()
        }
    }

    private func deleteOrganization() async {
        isMutating = true
        errorMessage = nil
        defer { isMutating = false }
        do {
            try await workspace.deleteOrganization(id: current.id)
            dismiss()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func leaveOrganization() async {
        isMutating = true
        errorMessage = nil
        defer { isMutating = false }
        do {
            try await workspace.leaveOrganization(id: current.id)
            dismiss()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func reloadSettings() async {
        await workspace.loadMembers(organizationId: current.id)
        if workspace.canManage {
            await invitations.loadInvitations(organizationId: current.id)
        }
    }
}

private struct WorkspaceBasicInfoEditView: View {
    @Environment(\.dismiss) private var dismiss
    @State private var workspace = WorkspaceStore.shared
    let organization: Organization
    @State private var name: String
    @State private var description: String
    @State private var selectedLogoItem: PhotosPickerItem?
    @State private var isUploadingLogo = false
    @State private var isSaving = false
    @State private var errorMessage: String?

    private var canManage: Bool { workspace.canManage }
    private var canUploadLogo: Bool {
        workspace.isOwner || organization.ownerId == AuthService.shared.currentUser?.id
    }

    private var currentOrganization: Organization {
        workspace.organizations.first(where: { $0.id == organization.id }) ?? organization
    }

    init(organization: Organization) {
        self.organization = organization
        _name = State(initialValue: organization.name)
        _description = State(initialValue: organization.description ?? "")
    }

    var body: some View {
        Form {
            Section("组织头像") {
                HStack(spacing: TTSpacing.lg) {
                    ProfileAvatarView(
                        name: currentOrganization.name,
                        imageURL: currentOrganization.logoURL,
                        size: 64,
                        cornerRadius: 16,
                        fallbackText: currentOrganization.avatarFallbackText
                    )
                    VStack(alignment: .leading, spacing: TTSpacing.xs) {
                        if canUploadLogo {
                            PhotosPicker(selection: $selectedLogoItem, matching: .images) {
                                Label("更换头像", systemImage: "camera.fill")
                            }
                            .disabled(isUploadingLogo)
                            Text("支持常见图片格式，上传后将在移动端和桌面端同步显示")
                                .font(.tt.caption)
                                .foregroundStyle(.tt.textSecondary)
                        } else {
                            Text("仅组织所有者可更换头像")
                                .font(.tt.caption)
                                .foregroundStyle(.tt.textSecondary)
                        }
                    }
                }
                .padding(.vertical, TTSpacing.xs)
            }
            Section(L10n.Workspace.teamInfo) {
                TextField(L10n.Workspace.teamName, text: $name)
                    .disabled(!canManage)
                TextField(L10n.Workspace.teamDescription, text: $description, axis: .vertical)
                    .lineLimit(3...6)
                    .disabled(!canManage)
            }
            if let errorMessage {
                Section {
                    Label(errorMessage, systemImage: "exclamationmark.triangle")
                        .foregroundStyle(.tt.textCritical)
                }
            }
        }
        .ttSettingsDetailFormStyle()
        .navigationTitle(L10n.Workspace.basicInfo)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if canManage {
                ToolbarItem(placement: .confirmationAction) {
                    Button(L10n.Common.save) { Task { await save() } }
                        .disabled(name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || isSaving)
                }
            }
        }
        .ttLoading(isSaving || isUploadingLogo)
        .onChange(of: selectedLogoItem) { _, item in
            Task { await uploadLogo(item) }
        }
    }

    private func save() async {
        guard canManage else { return }
        isSaving = true
        errorMessage = nil
        defer { isSaving = false }
        do {
            _ = try await workspace.updateOrganization(
                id: organization.id,
                name: name,
                description: description,
                icon: nil
            )
            dismiss()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func uploadLogo(_ item: PhotosPickerItem?) async {
        guard canUploadLogo, let item else { return }
        isUploadingLogo = true
        errorMessage = nil
        defer {
            isUploadingLogo = false
            selectedLogoItem = nil
        }

        guard let data = try? await item.loadTransferable(type: Data.self) else {
            errorMessage = "无法读取所选图片，请重新选择"
            return
        }
        guard data.count <= 5 * 1024 * 1024 else {
            errorMessage = "请选择不超过 5MB 的图片"
            return
        }
        guard let image = UIImage(data: data) else {
            errorMessage = "所选文件不是有效图片，请重新选择"
            return
        }

        guard let jpeg = resizeImage(image, maxDimension: 512).jpegData(compressionQuality: 0.8) else {
            errorMessage = "图片处理失败，请更换图片后重试"
            return
        }

        do {
            let result = try await OSSUploadService.shared.directUpload(
                data: jpeg,
                fileName: "organization-\(organization.id)-\(Int(Date().timeIntervalSince1970)).jpg",
                contentType: "image/jpeg",
                folder: "org-logos",
                scope: UploadScope(
                    module: "tabtinspace",
                    contextType: "organization",
                    contextId: organization.id,
                    organizationId: organization.id,
                    isPublic: true
                )
            )
            guard !result.accessUrl.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
                await OSSUploadService.shared.deleteFile(fileId: result.fileId)
                throw APIError.apiError("头像上传结果缺少访问地址")
            }
            do {
                _ = try await workspace.updateOrganizationLogo(id: organization.id, logoURL: result.accessUrl)
            } catch {
                await OSSUploadService.shared.deleteFile(fileId: result.fileId)
                throw error
            }
        } catch {
            errorMessage = OSSBusinessError.userMessage(for: error)
        }
    }

    private func resizeImage(_ image: UIImage, maxDimension: CGFloat) -> UIImage {
        let size = image.size
        guard max(size.width, size.height) > maxDimension else { return image }
        let scale = maxDimension / max(size.width, size.height)
        let targetSize = CGSize(width: size.width * scale, height: size.height * scale)
        return UIGraphicsImageRenderer(size: targetSize).image { _ in
            image.draw(in: CGRect(origin: .zero, size: targetSize))
        }
    }
}

struct WorkspaceInvitationsScreen: View {
    private enum InviteMethod: String, CaseIterable, Identifiable {
        case phone, link, direct
        var id: String { rawValue }
        var title: String {
            switch self {
            case .phone: return "手机号"
            case .link: return "链接"
            case .direct: return "直邀"
            }
        }
    }

    @State private var workspace = WorkspaceStore.shared
    @State private var invitations = InvitationService.shared
    let organization: Organization
    @State private var method: InviteMethod = .phone
    @State private var phone = ""
    @State private var directUserId = ""
    @State private var role: OrganizationRole = .editor
    @State private var generatedLink: String?
    @State private var linkCopied = false
    @State private var errorMessage: String?

    private var canManage: Bool { workspace.canManage && organization.isPersonal != true }

    var body: some View {
        List {
            if canManage {
            Section(L10n.Workspace.inviteMembers) {
                Picker("邀请方式", selection: $method) {
                    ForEach(InviteMethod.allCases) { m in
                        Text(m.title).tag(m)
                    }
                }
                .pickerStyle(.segmented)

                if method == .phone {
                    LabeledContent(L10n.Workspace.role) {
                        Text(OrganizationRole.editor.title)
                            .foregroundStyle(.tt.textAccent)
                    }
                    Text("手机号邀请仅支持已注册的 TabTin 用户，将以编辑者身份加入组织。")
                        .font(.tt.meta)
                        .foregroundStyle(.tt.textTertiary)
                } else {
                    Picker(L10n.Workspace.role, selection: $role) {
                        ForEach([OrganizationRole.viewer, .editor, .admin], id: \.self) { role in
                            Text(role.title).tag(role)
                        }
                    }
                }

                switch method {
                case .phone:
                    TextField("手机号", text: $phone)
                        .keyboardType(.phonePad)
                        .textContentType(.telephoneNumber)
                    Button("发送手机号邀请") {
                        Task { await createPhoneInvitation() }
                    }
                    .disabled(phone.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || invitations.isMutating)

                case .link:
                    if let generatedLink {
                        VStack(alignment: .leading, spacing: TTSpacing.xs) {
                            Text(generatedLink)
                                .font(.tt.meta.monospaced())
                                .foregroundStyle(.tt.textSecondary)
                                .lineLimit(2)
                                .textSelection(.enabled)
                            Button {
                                UIPasteboard.general.string = generatedLink
                                linkCopied = true
                            } label: {
                                Label(linkCopied ? "已复制" : "复制链接", systemImage: linkCopied ? "checkmark" : "doc.on.doc")
                            }
                        }
                    }
                    Button("生成邀请链接") {
                        Task { await createLinkInvitation() }
                    }
                    .disabled(invitations.isMutating)

                case .direct:
                    TextField("成员 User ID", text: $directUserId)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    Button("直接邀请") {
                        Task { await createDirectInvitation() }
                    }
                    .disabled(directUserId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || invitations.isMutating)
                }
            }
            }
            if !canManage {
                Section {
                    Label("仅管理员可管理邀请", systemImage: "lock.fill")
                        .foregroundStyle(.tt.textSecondary)
                }
            }
            if let errorMessage {
                Section { Text(errorMessage).foregroundStyle(.tt.textCritical) }
            }
            Section(L10n.Workspace.pendingInvitations) {
                if invitations.invitations.isEmpty {
                    Text(L10n.Workspace.noPendingInvitations).foregroundStyle(.tt.textTertiary)
                }
                ForEach(invitations.invitations) { invitation in
                    HStack {
                        Image(systemName: inviteTypeIcon(invitation))
                            .foregroundStyle(.tt.iconAccent)
                            .frame(width: 24)
                        VStack(alignment: .leading) {
                            Text(inviteDisplayTarget(invitation))
                                .font(.tt.body)
                                .lineLimit(1)
                            Text(invitation.role.title)
                                .font(.tt.meta)
                                .foregroundStyle(.tt.textTertiary)
                        }
                        Spacer()
                        if canManage {
                            Button(role: .destructive) {
                                Task { await cancel(invitation.id) }
                            } label: {
                                Image(systemName: "xmark.circle")
                            }
                        }
                    }
                }
            }
        }
        .ttSettingsDetailListStyle()
        .navigationTitle(L10n.Workspace.invitationManagement)
        .navigationBarTitleDisplayMode(.inline)
        .ttLoading(invitations.isMutating)
        .task {
            if canManage {
                await invitations.loadInvitations(organizationId: organization.id)
            }
        }
        .refreshable {
            if canManage {
                await invitations.loadInvitations(organizationId: organization.id)
            }
        }
    }

    private func inviteTypeIcon(_ invitation: OrganizationInvitation) -> String {
        switch invitation.inviteType {
        case "link": return "link"
        case "direct": return "person.fill.badge.plus"
        default: return "envelope"
        }
    }

    private func inviteDisplayTarget(_ invitation: OrganizationInvitation) -> String {
        if let email = invitation.email, !email.isEmpty { return email }
        if let userId = invitation.invitedUserId, !userId.isEmpty { return userId }
        if let token = invitation.token, !token.isEmpty { return InvitationLink.url(token: token) }
        return invitation.id
    }

    private func createPhoneInvitation() async {
        guard canManage else { return }
        errorMessage = nil
        do {
            _ = try await invitations.createPhoneInvitation(organizationId: organization.id, phone: phone)
            phone = ""
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func createLinkInvitation() async {
        guard canManage else { return }
        errorMessage = nil
        linkCopied = false
        do {
            let invitation = try await invitations.createLinkInvitation(organizationId: organization.id, role: role)
            if let token = invitation.token {
                generatedLink = InvitationLink.url(token: token)
            }
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func createDirectInvitation() async {
        guard canManage else { return }
        errorMessage = nil
        do {
            _ = try await invitations.createDirectInvitation(organizationId: organization.id, userId: directUserId, role: role)
            directUserId = ""
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func cancel(_ id: String) async {
        guard canManage else { return }
        errorMessage = nil
        do {
            try await invitations.cancelInvitation(organizationId: organization.id, invitationId: id)
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}
