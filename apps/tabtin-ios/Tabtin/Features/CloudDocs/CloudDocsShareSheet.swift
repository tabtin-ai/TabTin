import SwiftUI

/// 云文档 / 表格「分享设置」面板（公开链接段）。
///
/// 对齐 Electron `PublicLinkSection`：开关、可见范围、权限、密码、链接复制 / 系统分享 / 重新生成。
/// 邀请协作者留二期。面板自管加载与乐观失败回滚，依赖并行任务提供的 `CloudDocsShareService`。
struct CloudDocsShareSheet: View {
    let type: CloudShareResourceType
    let resourceId: String
    let resourceTitle: String

    @Environment(\.dismiss) private var dismiss
    @State private var workspace = WorkspaceStore.shared

    @State private var loadPhase: LoadPhase = .loading
    @State private var share: CloudDocShare?
    @State private var isBusy = false
    @State private var updateError: String?
    @State private var passwordDraft = ""
    @State private var showAnyoneConfirm = false
    @State private var showRefreshConfirm = false
    @State private var didCopyLink = false
    @State private var copyFeedbackTask: Task<Void, Never>?
    @State private var collaborators: [CloudDocsCollaborator] = []
    @State private var collaboratorQuery = ""
    @State private var pendingCollaboratorRemoval: CloudDocsCollaborator?

    private enum LoadPhase: Equatable {
        case loading
        case ready
        case forbidden
        case failed
    }

    private enum Metrics {
        /// HIG 推荐最小可点热区
        static let minTouchTarget: CGFloat = 44
        /// 行内状态图标占位宽度（视觉对齐用，非间距令牌）
        static let inlineIconWidth: CGFloat = 22
        /// 复制成功提示展示时长（与 Electron ~1.8s 对齐）
        static let copiedFeedbackNanoseconds: UInt64 = 1_800_000_000
    }

    private var isLinkEnabled: Bool {
        share != nil
    }

    private var currentScope: CloudShareScope {
        guard let share else { return .organization }
        return scope(from: share)
    }

    private var currentPermission: CloudSharePermission {
        guard let raw = share?.permission,
              let permission = CloudSharePermission(rawValue: raw),
              type.availablePermissions.contains(permission)
        else {
            return type.availablePermissions.first ?? .view
        }
        return permission
    }

    private var publicURL: URL? {
        guard let shareId = share?.shareId else { return nil }
        return CloudDocsShareService.publicURL(shareId: shareId, type: type)
    }

    private var canInteract: Bool {
        loadPhase == .ready && !isBusy
    }

    var body: some View {
        NavigationStack {
            Group {
                switch loadPhase {
                case .loading:
                    loadingView
                case .forbidden:
                    statusView(
                        systemImage: "lock.fill",
                        message: L10n.CloudDocs.shareForbidden,
                        showsRetry: false
                    )
                case .failed:
                    statusView(
                        systemImage: "exclamationmark.triangle",
                        message: L10n.CloudDocs.shareLoadFailed,
                        showsRetry: true
                    )
                case .ready:
                    contentForm
                }
            }
            .background(.tt.bgCanvasDefault)
            .navigationTitle(L10n.CloudDocs.shareTitle)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(L10n.Common.close) { dismiss() }
                }
            }
            .interactiveDismissDisabled(isBusy)
            .alert(
                L10n.CloudDocs.shareAnyoneConfirmTitle,
                isPresented: $showAnyoneConfirm
            ) {
                Button(L10n.CloudDocs.shareAnyoneConfirmAction, role: .destructive) {
                    Task { await confirmAnyoneScope() }
                }
                Button(L10n.Common.cancel, role: .cancel) {}
            } message: {
                Text(L10n.CloudDocs.shareAnyoneConfirmMessage)
            }
            .confirmationDialog(
                L10n.CloudDocs.shareRefreshConfirmTitle,
                isPresented: $showRefreshConfirm,
                titleVisibility: .visible
            ) {
                Button(L10n.CloudDocs.shareRefreshLink, role: .destructive) {
                    Task { await refreshLink() }
                }
                Button(L10n.Common.cancel, role: .cancel) {}
            } message: {
                Text(L10n.CloudDocs.shareRefreshConfirmMessage)
            }
            .confirmationDialog(
                "移除协作者？",
                isPresented: Binding(
                    get: { pendingCollaboratorRemoval != nil },
                    set: { if !$0 { pendingCollaboratorRemoval = nil } }
                ),
                titleVisibility: .visible
            ) {
                Button("移除", role: .destructive) {
                    guard let collaborator = pendingCollaboratorRemoval else { return }
                    pendingCollaboratorRemoval = nil
                    Task { await removeCollaborator(collaborator.userId) }
                }
                Button(L10n.Common.cancel, role: .cancel) { pendingCollaboratorRemoval = nil }
            } message: {
                Text("移除后，该成员将不能再访问这份资源。")
            }
            .task {
                await loadShare()
                await loadCollaborators()
            }
            .onDisappear {
                copyFeedbackTask?.cancel()
            }
        }
    }

    // MARK: - Content

    private var contentForm: some View {
        Form {
            if !resourceTitle.isEmpty {
                Section {
                    Text(resourceTitle)
                        .font(.tt.meta)
                        .foregroundStyle(.tt.textSecondary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }

            if let updateError {
                Section {
                    Text(updateError)
                        .font(.tt.meta)
                        .foregroundStyle(.tt.textCritical)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }

            Section {
                Toggle(isOn: linkEnabledBinding) {
                    Text(L10n.CloudDocs.shareLinkToggle)
                        .font(.tt.body)
                        .foregroundStyle(.tt.textPrimary)
                }
                .disabled(!canInteract)
                .tint(.tt.bgAccent)
            } footer: {
                if !isLinkEnabled {
                    Text(L10n.CloudDocs.shareLinkOffHint)
                        .font(.tt.captionMedium)
                        .foregroundStyle(.tt.textTertiary)
                }
            }

            collaboratorSection
            if isLinkEnabled {
                scopeSection
                permissionSection
                passwordSection
                linkSection
                if let visitCount = share?.visitCount {
                    Section {
                        Text(L10n.CloudDocs.shareVisitCount(visitCount))
                            .font(.tt.meta)
                            .foregroundStyle(.tt.textSecondary)
                    }
                }
            }
        }
        .scrollContentBackground(.hidden)
    }

    private var collaboratorSection: some View {
        Section {
            VStack(alignment: .leading, spacing: TTSpacing.md) {
                Text("协作者")
                    .font(.tt.bodyMedium)
                    .foregroundStyle(.tt.textPrimary)

                TextField("搜索组织成员", text: $collaboratorQuery)
                    .textFieldStyle(.roundedBorder)
                    .disabled(!canInteract)

                ForEach(inviteCandidates) { member in
                    HStack {
                        Text(member.displayName)
                        Spacer()
                        Menu {
                            Button("邀请为可查看") { Task { await invite(member.userId, permission: "viewer") } }
                            Button("邀请为可编辑") { Task { await invite(member.userId, permission: "editor") } }
                        } label: {
                            roleMenuLabel("邀请")
                        }
                        .disabled(!canInteract)
                    }
                }

                ForEach(collaborators) { collaborator in
                    HStack {
                        Text(collaborator.nickname.isEmpty ? collaborator.email : collaborator.nickname)
                        Spacer()
                        Menu {
                            Button("设为可查看") { Task { await updateCollaborator(collaborator.userId, permission: "viewer") } }
                            Button("设为可编辑") { Task { await updateCollaborator(collaborator.userId, permission: "editor") } }
                        } label: {
                            roleMenuLabel(collaboratorPermissionLabel(collaborator.permission))
                        }
                        .disabled(!canInteract)
                        Button {
                            pendingCollaboratorRemoval = collaborator
                        } label: {
                            Image(systemName: "minus.circle.fill")
                                .foregroundStyle(.tt.textCritical)
                                .frame(minWidth: Metrics.minTouchTarget, minHeight: Metrics.minTouchTarget)
                        }
                        .disabled(!canInteract)
                    }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private var inviteCandidates: [OrganizationMember] {
        let currentUserId = AuthService.shared.currentUser?.id
        return workspace.members.filter { member in
            member.userId != currentUserId
                && !collaborators.contains(where: { $0.userId == member.userId })
                && (collaboratorQuery.isEmpty || member.displayName.localizedCaseInsensitiveContains(collaboratorQuery))
        }
    }

    private var scopeSection: some View {
        Section {
            Picker(L10n.CloudDocs.shareScopeSection, selection: scopeBinding) {
                Text(L10n.CloudDocs.shareScopeOrganization)
                    .tag(CloudShareScope.organization)
                Text(L10n.CloudDocs.shareScopeAnyone)
                    .tag(CloudShareScope.anyone)
            }
            .disabled(!canInteract)

            Text(scopeHint(for: currentScope))
                .font(.tt.captionMedium)
                .foregroundStyle(.tt.textTertiary)
        } header: {
            Text(L10n.CloudDocs.shareScopeSection)
        }
    }

    private var permissionSection: some View {
        Section {
            Picker(L10n.CloudDocs.sharePermissionSection, selection: permissionBinding) {
                ForEach(type.availablePermissions, id: \.self) { permission in
                    Text(permissionLabel(permission))
                        .tag(permission)
                }
            }
            .disabled(!canInteract)
        } header: {
            Text(L10n.CloudDocs.sharePermissionSection)
        }
    }

    private var passwordSection: some View {
        Section {
            if share?.hasPassword == true {
                HStack(spacing: TTSpacing.sm) {
                    Image(systemName: "lock.fill")
                        .foregroundStyle(.tt.iconSecondary)
                        .frame(width: Metrics.inlineIconWidth, alignment: .center)
                    Text(L10n.CloudDocs.sharePasswordSet)
                        .font(.tt.meta)
                        .foregroundStyle(.tt.textSecondary)
                    Spacer(minLength: TTSpacing.sm)
                    Button(L10n.CloudDocs.sharePasswordClear, role: .destructive) {
                        Task { await clearPassword() }
                    }
                    .font(.tt.bodyMedium)
                    .disabled(!canInteract)
                }
                .frame(minHeight: Metrics.minTouchTarget)
            }

            SecureField(L10n.CloudDocs.sharePasswordPlaceholder, text: $passwordDraft)
                .textContentType(.password)
                .font(.tt.body)
                .foregroundStyle(.tt.textPrimary)
                .disabled(!canInteract)

            Button(L10n.CloudDocs.sharePasswordApply) {
                Task { await applyPassword() }
            }
            .font(.tt.bodyMedium)
            .disabled(!canInteract || passwordDraft.isEmpty)
        } header: {
            Text(L10n.CloudDocs.sharePasswordSection)
        }
    }

    @ViewBuilder
    private var linkSection: some View {
        Section {
            if let publicURL {
                Text(publicURL.absoluteString)
                    .font(.tt.codeSM)
                    .foregroundStyle(.tt.textSecondary)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)

                Button {
                    copyLink(publicURL)
                } label: {
                    Label(
                        didCopyLink ? L10n.CloudDocs.shareLinkCopied : L10n.CloudDocs.shareCopyLink,
                        systemImage: didCopyLink ? "checkmark" : "doc.on.doc"
                    )
                    .font(.tt.bodyMedium)
                    .frame(maxWidth: .infinity, minHeight: Metrics.minTouchTarget, alignment: .leading)
                }
                .foregroundStyle(didCopyLink ? .tt.textSuccess : .tt.textAccent)

                // 清单无「系统分享」专用文案，复用 shareAction；需要独立文案时再补 key。
                ShareLink(item: publicURL) {
                    Label(L10n.CloudDocs.shareAction, systemImage: "square.and.arrow.up")
                        .font(.tt.bodyMedium)
                        .frame(maxWidth: .infinity, minHeight: Metrics.minTouchTarget, alignment: .leading)
                }
                .foregroundStyle(.tt.textAccent)

                Button(role: .destructive) {
                    showRefreshConfirm = true
                } label: {
                    Label(L10n.CloudDocs.shareRefreshLink, systemImage: "arrow.clockwise")
                        .font(.tt.bodyMedium)
                        .frame(maxWidth: .infinity, minHeight: Metrics.minTouchTarget, alignment: .leading)
                }
                .disabled(!canInteract)
            }
        } header: {
            Text(L10n.CloudDocs.shareLinkSection)
        }
    }

    private var loadingView: some View {
        ProgressView(L10n.Common.loading)
            .font(.tt.meta)
            .foregroundStyle(.tt.textSecondary)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .tint(.tt.bgAccent)
    }

    private func statusView(systemImage: String, message: String, showsRetry: Bool) -> some View {
        VStack(spacing: TTSpacing.md) {
            Image(systemName: systemImage)
                .font(.tt.iconFeature)
                .foregroundStyle(.tt.iconSecondary)
            Text(message)
                .font(.tt.meta)
                .foregroundStyle(.tt.textSecondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, TTSpacing.xl)
            if showsRetry {
                Button(L10n.Common.retry) {
                    Task { await loadShare() }
                }
                .font(.tt.bodyMedium)
                .tint(.tt.bgAccent)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    // MARK: - Bindings（get 始终来自服务端快照，避免乐观漂移）

    private var linkEnabledBinding: Binding<Bool> {
        Binding(
            get: { isLinkEnabled },
            set: { newValue in
                Task { await setLinkEnabled(newValue) }
            }
        )
    }

    private var scopeBinding: Binding<CloudShareScope> {
        Binding(
            get: { currentScope },
            set: { newValue in
                handleScopeSelection(newValue)
            }
        )
    }

    private var permissionBinding: Binding<CloudSharePermission> {
        Binding(
            get: { currentPermission },
            set: { newValue in
                Task { await changePermission(to: newValue) }
            }
        )
    }

    // MARK: - Actions

    @MainActor
    private func loadShare() async {
        loadPhase = .loading
        updateError = nil
        do {
            share = try await CloudDocsShareService.shared.fetch(
                type: type,
                resourceId: resourceId
            )
            loadPhase = .ready
        } catch let error as CloudDocsShareError {
            share = nil
            switch error {
            case .forbidden:
                loadPhase = .forbidden
            default:
                loadPhase = .failed
            }
        } catch {
            share = nil
            loadPhase = .failed
        }
    }

    @MainActor
    private func loadCollaborators() async {
        if let organizationId = workspace.selectedOrganizationId {
            await workspace.loadMembers(organizationId: organizationId)
        }
        do { collaborators = try await CloudDocsShareService.shared.collaborators(type: type, resourceId: resourceId) }
        catch { /* 链接分享仍可独立使用；成员候选仍会可用。 */ }
    }

    @MainActor private func invite(_ userId: String, permission: String) async { await collaboratorMutation { try await CloudDocsShareService.shared.invite(type: type, resourceId: resourceId, userId: userId, permission: permission) } }
    @MainActor private func updateCollaborator(_ userId: String, permission: String) async { await collaboratorMutation { try await CloudDocsShareService.shared.updateCollaborator(type: type, resourceId: resourceId, userId: userId, permission: permission) } }
    @MainActor private func removeCollaborator(_ userId: String) async { await collaboratorMutation { try await CloudDocsShareService.shared.removeCollaborator(type: type, resourceId: resourceId, userId: userId) } }
    @MainActor private func collaboratorMutation(_ work: () async throws -> Void) async { await mutate { try await work(); await loadCollaborators() } }

    private func collaboratorPermissionLabel(_ permission: String) -> String {
        permission == "viewer" ? "可查看" : permission == "editor" ? "可编辑" : permission
    }

    private func roleMenuLabel(_ title: String) -> some View {
        HStack(spacing: TTSpacing.xs) {
            Text(title)
            Image(systemName: "chevron.up.chevron.down")
                .font(.tt.iconCaptionMedium)
        }
        .font(.tt.bodyMedium)
        .foregroundStyle(.tt.textAccent)
        .frame(minWidth: Metrics.minTouchTarget, minHeight: Metrics.minTouchTarget)
    }

    @MainActor
    private func setLinkEnabled(_ enabled: Bool) async {
        guard canInteract else { return }
        if enabled == isLinkEnabled { return }

        await mutate {
            if enabled {
                let created = try await CloudDocsShareService.shared.upsert(
                    type: type,
                    resourceId: resourceId,
                    scope: .organization,
                    permission: .view,
                    password: nil,
                    acknowledgePublicExposure: false
                )
                share = created
                passwordDraft = ""
            } else {
                let scope = currentScope
                try await CloudDocsShareService.shared.disable(
                    type: type,
                    resourceId: resourceId,
                    scope: scope
                )
                share = nil
                passwordDraft = ""
            }
        }
    }

    /// 切到「任何人」时**不**改 `share`；取消确认后 Picker get 仍返回组织内。
    private func handleScopeSelection(_ next: CloudShareScope) {
        guard canInteract else { return }
        guard next != currentScope else { return }

        if next == .anyone {
            showAnyoneConfirm = true
            return
        }

        Task { await changeScope(to: .organization, acknowledgePublicExposure: false) }
    }

    @MainActor
    private func confirmAnyoneScope() async {
        await changeScope(to: .anyone, acknowledgePublicExposure: true)
    }

    @MainActor
    private func changeScope(
        to scope: CloudShareScope,
        acknowledgePublicExposure: Bool
    ) async {
        // 确认弹窗的确认按钮在 dismiss 后触发；此时只需保证仍在 ready 且链接已开。
        guard loadPhase == .ready, isLinkEnabled, !isBusy else { return }

        await mutate {
            let updated = try await CloudDocsShareService.shared.upsert(
                type: type,
                resourceId: resourceId,
                scope: scope,
                permission: currentPermission,
                password: nil,
                acknowledgePublicExposure: acknowledgePublicExposure
            )
            share = updated
        }
    }

    @MainActor
    private func changePermission(to permission: CloudSharePermission) async {
        guard canInteract else { return }
        guard permission != currentPermission else { return }
        guard type.availablePermissions.contains(permission) else { return }

        await mutate {
            let updated = try await CloudDocsShareService.shared.upsert(
                type: type,
                resourceId: resourceId,
                scope: currentScope,
                permission: permission,
                password: nil,
                acknowledgePublicExposure: currentScope == .anyone
            )
            share = updated
        }
    }

    @MainActor
    private func applyPassword() async {
        guard canInteract else { return }
        let password = passwordDraft
        guard !password.isEmpty else { return }

        await mutate {
            let updated = try await CloudDocsShareService.shared.upsert(
                type: type,
                resourceId: resourceId,
                scope: currentScope,
                permission: currentPermission,
                password: password,
                acknowledgePublicExposure: currentScope == .anyone
            )
            share = updated
            passwordDraft = ""
        }
    }

    @MainActor
    private func clearPassword() async {
        guard canInteract else { return }
        guard share?.hasPassword == true else { return }

        await mutate {
            let updated = try await CloudDocsShareService.shared.upsert(
                type: type,
                resourceId: resourceId,
                scope: currentScope,
                permission: currentPermission,
                password: "",
                acknowledgePublicExposure: currentScope == .anyone
            )
            share = updated
            passwordDraft = ""
        }
    }

    @MainActor
    private func refreshLink() async {
        guard canInteract else { return }

        // 表格没有 /share/refresh，服务层用 disable + upsert 兜底，失败可能停在
        // 「已关掉但没重开」的中间态，所以这里要校准。
        await mutate(reconcileOnFailure: true) {
            let updated = try await CloudDocsShareService.shared.refresh(
                type: type,
                resourceId: resourceId,
                scope: currentScope,
                permission: currentPermission
            )
            share = updated
        }
    }

    /// - Parameter reconcileOnFailure: 失败后重新拉一次服务端状态。
    ///   给「不是单个请求」的操作用：表格轮换链接是 disable + upsert 两步（后端没有
    ///   `/share/refresh`），前一步成功而后一步失败时分享已经被关掉了。不校准的话
    ///   面板会继续显示开启状态和那条已失效的旧链接，用户照样把它发出去。
    private func mutate(
        reconcileOnFailure: Bool = false,
        _ work: () async throws -> Void
    ) async {
        guard !isBusy else { return }
        isBusy = true
        updateError = nil
        defer { isBusy = false }

        do {
            try await work()
        } catch let error as CloudDocsShareError {
            handleMutationError(error)
            if reconcileOnFailure { await reconcile() }
        } catch {
            updateError = L10n.CloudDocs.shareUpdateFailed
            if reconcileOnFailure { await reconcile() }
        }
    }

    /// 静默重新对齐服务端状态，保留已经显示出来的错误文案。
    ///
    /// 与 `loadShare` 的区别：不动 `loadPhase`，失败也不接管页面——用户此刻要看的是
    /// 刚才那次操作为什么失败，不该被一个整页加载态盖掉。
    @MainActor
    private func reconcile() async {
        guard let latest = try? await CloudDocsShareService.shared.fetch(
            type: type,
            resourceId: resourceId
        ) else {
            // 连状态都拉不回来：清掉手里这份，避免继续展示一条可能已经失效的链接。
            share = nil
            return
        }
        share = latest
    }

    @MainActor
    private func handleMutationError(_ error: CloudDocsShareError) {
        switch error {
        case .forbidden:
            updateError = L10n.CloudDocs.shareForbidden
        case .publicExposureNotAcknowledged:
            // 确认流程漏带 ack：再弹同一确认窗；UI 范围仍停留在组织内（share 未改）
            showAnyoneConfirm = true
        case .unsupportedResourceType, .other:
            updateError = L10n.CloudDocs.shareUpdateFailed
        }
    }

    private func copyLink(_ url: URL) {
        UIPasteboard.general.string = url.absoluteString
        didCopyLink = true
        copyFeedbackTask?.cancel()
        copyFeedbackTask = Task { @MainActor in
            try? await Task.sleep(nanoseconds: Metrics.copiedFeedbackNanoseconds)
            guard !Task.isCancelled else { return }
            didCopyLink = false
        }
    }

    // MARK: - Helpers

    private func scope(from share: CloudDocShare) -> CloudShareScope {
        if share.shareType == type.anyoneWireValue {
            return .anyone
        }
        return .organization
    }

    private func scopeHint(for scope: CloudShareScope) -> String {
        switch scope {
        case .organization:
            return L10n.CloudDocs.shareScopeOrganizationHint
        case .anyone:
            return L10n.CloudDocs.shareScopeAnyoneHint
        }
    }

    private func permissionLabel(_ permission: CloudSharePermission) -> String {
        switch permission {
        case .view:
            return L10n.CloudDocs.sharePermissionView
        case .comment:
            return L10n.CloudDocs.sharePermissionComment
        case .edit:
            return L10n.CloudDocs.sharePermissionEdit
        }
    }
}
