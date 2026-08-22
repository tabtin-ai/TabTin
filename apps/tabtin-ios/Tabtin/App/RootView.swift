import SwiftUI

/// 根路由：按鉴权状态在 恢复中 / 登录 / 工作区 间切换。
/// 状态机来源是 `AuthService`（@Observable 单例）：
///   needsTokenRefreshOnActive → 恢复中；!isAuthenticated → 登录；else → 工作区流程。
struct RootView: View {
    @State private var auth = AuthService.shared
    @State private var theme = ThemeManager.shared
    @State private var language = LanguageManager.shared
    @State private var billing = BillingEventHandler.shared
    @State private var pendingInteractions = PendingInteractionStore.shared
    @State private var versionGate = VersionGateService.shared
    @State private var router = MainRouter.shared
    @State private var colorScheme = ColorSchemeStore.shared
    @State private var inviteDeepLink = InviteDeepLinkCoordinator.shared
    @State private var workspace = WorkspaceStore.shared
    /// 冷启动 Profile 是邀请码准入的权威来源；失败时必须给用户恢复出口，不能永久转圈。
    @State private var profileLoadError: String?
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.openURL) private var openURL

    var body: some View {
        Group {
            if auth.needsTokenRefreshOnActive {
                RestoringView()
            } else if !auth.isAuthenticated {
                LoginView()
            } else if let profileLoadError, auth.currentUser == nil {
                ProfileLoadFailureView(
                    message: profileLoadError,
                    onRetry: {
                        Task {
                            await loadCurrentUserProfile()
                            await startAuthenticatedRuntimeIfAllowed()
                        }
                    },
                    onChangeAccount: { auth.logout() }
                )
            } else if auth.currentUser == nil {
                RestoringView()
            } else if auth.needsInviteCode {
                InviteCodeGateView()
            } else {
                WorkspaceFlowView()
            }
        }
        .preferredColorScheme(theme.resolvedColorScheme)
        .environment(\.locale, language.effectiveLocale)
        .id(language.language)
        .overlay(alignment: .top) {
            if let toast = billing.activeToast {
                BillingToastBanner(toast: toast) {
                    billing.dismissToast()
                }
                .padding(.horizontal, TTSpacing.lg)
                .padding(.top, TTSpacing.lg)
                .transition(.move(edge: .top).combined(with: .opacity))
            }
        }
        .animation(.easeInOut(duration: 0.2), value: billing.activeToast)
        // 版本门禁走独立 task：与会话恢复并发，接口慢/超时也不拖住启动。
        .task {
            await versionGate.checkOnColdLaunch()
        }
        .task {
            // 冷启动：access token 过期则尝试用 refresh token 恢复会话。
            await auth.attemptColdLaunchRefresh()
            // 未恢复出有效账号时回到访客默认配色，避免登录页短暂继承上一账号的
            // 云端 colorScheme；与 Electron 退出后的 system + blue 访客口径一致。
            if !auth.isAuthenticated {
                colorScheme.resetToDefaultWithoutSave()
            }
            // 冷启动没有本地邀请码判定；先从 allowlist Profile 拿到服务端明确状态。
            await loadCurrentUserProfile()
            await startAuthenticatedRuntimeIfAllowed()
        }
        .onChange(of: auth.isAuthenticated) { _, isAuthenticated in
            if isAuthenticated && !auth.needsInviteCode {
                billing.start()
                pendingInteractions.start()
                // ：登录后注册远程推送并上报 token（登出反注册走 logout hook）
                PushService.shared.start()
            } else {
                billing.stop()
                pendingInteractions.stop()
            }
            // 账号级配色：登录后拉云端偏好；登出立刻回默认且不写后端，避免下一个账号
            // 短暂看到上一个账号的配色。
            if isAuthenticated {
                colorScheme.onAuthenticated()
            } else {
                colorScheme.resetToDefaultWithoutSave()
            }
        }
        .onChange(of: auth.needsInviteCode) { _, needsInviteCode in
            if needsInviteCode {
                RealtimeGateway.shared.disconnect()
                billing.stop()
                pendingInteractions.stop()
            } else if auth.isAuthenticated {
                billing.start()
                pendingInteractions.start()
                PushService.shared.start()
            }
        }
        .onChange(of: scenePhase) { _, newPhase in
            // App 前后台：后台宽限后挂起 WS（保留 cursor），前台恢复连接 + resume 续传。
            // 未登录时 enterForeground 无凭据自动 no-op，可安全无条件调用。
            switch newPhase {
            case .background:
                RealtimeGateway.shared.enterBackground()
            case .active:
                Task { await versionGate.refresh() }
                Task { await auth.checkTokenValidity() }
                if auth.isAuthenticated && auth.currentUser != nil && !auth.needsInviteCode {
                    PushService.shared.retryPendingUpload()
                    RealtimeGateway.shared.enterForeground()
                    Task { await OSSUploadService.shared.retryPendingConfirms() }
                    Task { await CloudDrivePendingMountStore.shared.retryAll() }
                    Task { await pendingInteractions.refreshAll() }
                    billing.subscribeCurrentOrganization()
                }
            default:
                break
            }
        }
        .alert(
            "登录已过期",
            isPresented: Binding(
                get: { auth.sessionExpiredMessage != nil },
                set: { if !$0 { auth.sessionExpiredMessage = nil } }
            )
        ) {
            Button(L10n.Common.confirm, role: .cancel) {
                auth.sessionExpiredMessage = nil
            }
        } message: {
            Text(auth.sessionExpiredMessage ?? "")
        }
        .alert(
            L10n.AccountDrawer.organizationAccessRevokedTitle,
            isPresented: Binding(
                get: { workspace.organizationAccessRevokedNotice != nil },
                set: { if !$0 { workspace.clearOrganizationAccessRevokedNotice() } }
            )
        ) {
            if workspace.organizationAccessRevokedNotice?.fallbackOrganization != nil {
                Button(L10n.AccountDrawer.switchToDefaultOrganization) {
                    Task {
                        if await workspace.selectDefaultOrganization() {
                            workspace.clearOrganizationAccessRevokedNotice()
                        }
                    }
                }
            } else {
                Button(L10n.Common.confirm, role: .cancel) {
                    workspace.clearOrganizationAccessRevokedNotice()
                }
            }
        } message: {
            if let notice = workspace.organizationAccessRevokedNotice,
               let name = notice.organizationName {
                Text(L10n.AccountDrawer.organizationAccessRevokedMessage(name))
            } else {
                Text(L10n.AccountDrawer.organizationAccessRevokedMessageGeneric)
            }
        }
        .alert(
            L10n.Common.resourceLinkNoticeTitle,
            isPresented: Binding(
                get: { router.navigationNotice != nil },
                set: { if !$0 { router.navigationNotice = nil } }
            )
        ) {
            Button(L10n.Common.confirm, role: .cancel) {
                router.navigationNotice = nil
            }
        } message: {
            Text(router.navigationNotice ?? "")
        }
        .sheet(item: invitePresentation) { invite in
            AcceptInvitationSheet(invite: invite) {
                inviteDeepLink.finish(invite)
            }
        }
        // 强制更新：不可关闭全屏拦截（binding set 为 no-op，用户无法退出）。
        .fullScreenCover(isPresented: Binding(
            get: { versionGate.shouldForceUpdate },
            set: { _ in }
        )) {
            if let decision = versionGate.decision {
                ForceUpdateView(decision: decision)
            }
        }
        // 推荐更新：可关闭提示，用户可选择「稍后」。
        .alert(
            versionGate.decision?.title ?? "发现新版本",
            isPresented: Binding(
                get: { versionGate.shouldSoftPrompt },
                set: { if !$0 { versionGate.dismissSoftPrompt() } }
            )
        ) {
            Button("稍后", role: .cancel) { versionGate.dismissSoftPrompt() }
            Button("去更新") {
                if let urlString = versionGate.decision?.resolvedStoreURL, let url = URL(string: urlString) {
                    openURL(url)
                }
                versionGate.dismissSoftPrompt()
            }
        } message: {
            Text(versionGate.decision?.message ?? "")
        }
    }

    private var invitePresentation: Binding<InviteDeepLink?> {
        Binding(
            get: {
                inviteDeepLink.inviteForPresentation(
                    isAuthenticated: auth.isAuthenticated,
                    hasProfile: auth.currentUser != nil,
                    needsInviteCode: auth.needsInviteCode
                )
            },
            set: { invite in
                if invite == nil, let pending = inviteDeepLink.pendingInvite {
                    inviteDeepLink.finish(pending)
                }
            }
        )
    }

    @MainActor
    private func loadCurrentUserProfile() async {
        guard auth.isAuthenticated, auth.currentUser == nil else { return }
        profileLoadError = nil
        do {
            try await auth.fetchProfile()
        } catch is CancellationError {
            return
        } catch {
            profileLoadError = error.localizedDescription
        }
    }

    @MainActor
    private func startAuthenticatedRuntimeIfAllowed() async {
        guard auth.isAuthenticated, auth.currentUser != nil, !auth.needsInviteCode else { return }
        await OSSUploadService.shared.retryPendingConfirms()
        await CloudDrivePendingMountStore.shared.retryAll()
        billing.start()
        pendingInteractions.start()
        PushService.shared.start()
    }
}

/// 会话恢复中（冷启动刷新 token）。
private struct RestoringView: View {
    var body: some View {
        VStack(spacing: 16) {
            ProgressView()
            Text(L10n.Main.restoringSession)
                .font(.tt.body)
                .foregroundStyle(.secondary)
        }
    }
}

/// Profile 是邀请码准入的服务端事实来源；临时失败时允许用户重试或切换账号。
private struct ProfileLoadFailureView: View {
    let message: String
    let onRetry: () -> Void
    let onChangeAccount: () -> Void

    var body: some View {
        VStack(spacing: TTSpacing.lg) {
            Image(systemName: "exclamationmark.triangle")
                .font(.tt.iconEmpty)
                .foregroundStyle(.tt.textWarning)
            Text(L10n.Auth.loginFailed)
                .font(.tt.subtitleSemibold)
                .foregroundStyle(.tt.textPrimary)
            Text(message)
                .font(.tt.meta)
                .foregroundStyle(.tt.textSecondary)
                .multilineTextAlignment(.center)
            Button(L10n.Common.retry, action: onRetry)
                .buttonStyle(.borderedProminent)
            Button(L10n.Auth.inviteCodeChangeAccount, action: onChangeAccount)
                .buttonStyle(.bordered)
        }
        .padding(TTSpacing.xl)
    }
}

/// 登录后工作区流程：拉 organization 完成后进入 3-tab 主界面（最近 / Agent / Memo + ➕）。
/// Space 选择与会话进入下沉到 Agent tab（AgentTabRoot）。
private struct WorkspaceFlowView: View {
    @State private var store = WorkspaceStore.shared

    var body: some View {
        Group {
            // 仅在「首次 organization 加载尚未完成」时显示加载页；一旦尝试过（成功或失败）即恒挂
            // MainTabView，空/错误态由各 tab 自行展示。避免 isLoadingOrganizations 反复翻转导致
            // 主界面 + Space 列表无限重挂闪烁。
            if !store.didAttemptOrganizationLoad && store.organizations.isEmpty {
                VStack(spacing: 16) {
                    ProgressView()
                    Text(L10n.Main.loadingWorkspace).font(.tt.body).foregroundStyle(.secondary)
                }
            } else {
                MainTabView()
            }
        }
        .task {
            if AuthService.shared.currentUser == nil {
                try? await AuthService.shared.fetchProfile()
            }
            guard !AuthService.shared.needsInviteCode else { return }
            await store.loadOrganizations()
            BillingEventHandler.shared.subscribeCurrentOrganization()
        }
    }
}

enum InviteCodeGatePresentation {
    static func errorMessage(for error: Error) -> String {
        if (error as? APIError)?.businessCode == "RATE_LIMITED" {
            return L10n.Auth.inviteCodeRateLimited
        }
        return error.localizedDescription
    }
}

/// 邀请码是登录后的准入条件，不提供下滑、返回或点遮罩退出；用户只能完成兑换或换账号。
private struct InviteCodeGateView: View {
    @State private var inviteCode = ""
    @State private var isSubmitting = false
    @State private var errorMessage: String?

    var body: some View {
        ZStack {
            Color.tt.bgCanvasDefault.ignoresSafeArea()
            VStack(spacing: TTSpacing.lg) {
                VStack(alignment: .leading, spacing: TTSpacing.sm) {
                    Text(L10n.Auth.inviteCodeTitle)
                        .font(.tt.headingSemibold)
                        .foregroundStyle(.tt.textPrimary)
                    Text(L10n.Auth.inviteCodeDescription)
                        .font(.tt.body)
                        .foregroundStyle(.tt.textSecondary)
                    TextField(L10n.Auth.inviteCodePlaceholder, text: $inviteCode)
                        .textInputAutocapitalization(.characters)
                        .autocorrectionDisabled()
                        .textFieldStyle(.roundedBorder)
                        .disabled(isSubmitting)
                    if let errorMessage {
                        Text(errorMessage)
                            .font(.tt.meta)
                            .foregroundStyle(.tt.textCritical)
                    }
                }

                Button {
                    submit()
                } label: {
                    HStack(spacing: TTSpacing.sm) {
                        if isSubmitting { ProgressView().tint(.white) }
                        Text(L10n.Auth.inviteCodeContinue)
                    }
                    .frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .disabled(inviteCode.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || isSubmitting)

                Button(L10n.Auth.inviteCodeChangeAccount) {
                    AuthService.shared.logout()
                }
                .buttonStyle(.bordered)
                .disabled(isSubmitting)
            }
            .padding(TTSpacing.xl)
            .background(.tt.bgBubbleIncoming, in: RoundedRectangle(cornerRadius: TTRadius.lg, style: .continuous))
            .padding(TTSpacing.xl)
        }
    }

    private func submit() {
        let code = inviteCode.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !code.isEmpty else {
            errorMessage = L10n.Auth.inviteCodeRequired
            return
        }
        isSubmitting = true
        errorMessage = nil
        Task {
            do {
                try await AuthService.shared.redeemInviteCode(code)
            } catch {
                errorMessage = InviteCodeGatePresentation.errorMessage(for: error)
            }
            isSubmitting = false
        }
    }
}

private struct BillingToastBanner: View {
    let toast: BillingToast
    var onDismiss: () -> Void

    var body: some View {
        HStack(alignment: .top, spacing: TTSpacing.sm) {
            Image(systemName: toast.isDestructive ? "creditcard.trianglebadge.exclamationmark" : "checkmark.circle.fill")
                .font(.tt.iconBody)
                .foregroundStyle(toast.isDestructive ? .tt.textCritical : .tt.textSuccess)
                .frame(width: 20, height: 20)
            Text(toast.message)
                .font(.tt.meta)
                .foregroundStyle(.tt.textPrimary)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
            Button(action: onDismiss) {
                Image(systemName: "xmark")
                    .font(.tt.iconCaption)
                    .foregroundStyle(.tt.textTertiary)
            }
            .buttonStyle(.plain)
        }
        .padding(.horizontal, TTSpacing.md)
        .padding(.vertical, TTSpacing.sm)
        .background(.thinMaterial, in: RoundedRectangle(cornerRadius: TTRadius.md, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: TTRadius.md, style: .continuous)
                .strokeBorder(toast.isDestructive ? .tt.bgCritical.opacity(0.25) : .tt.borderLight, lineWidth: 0.5)
        )
        .shadow(color: .black.opacity(0.12), radius: 16, x: 0, y: 8)
    }
}

#Preview {
    RootView()
}
