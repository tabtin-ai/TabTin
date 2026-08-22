import SwiftUI

#if DEBUG
@MainActor
enum AccountDrawerLayoutDebugProbe {
    static var titleFrame: CGRect?
    static var versionFrame: CGRect?
}
#endif

enum AccountDrawerPanelLayout {
    case compact
    case regular
}

/// 账户与上下文侧栏：身份、组织、通知摘要、组织邀请、设置入口。
struct AccountDrawerPanel: View {
    let layout: AccountDrawerPanelLayout

    @State private var auth = AuthService.shared
    @State private var workspace = WorkspaceStore.shared
    @State private var notificationStore = NotificationStore.shared
    @State private var invitations = InvitationService.shared
    @State private var coordinator = AccountDrawerCoordinator.shared
    @State private var pendingInvitation: PendingInvitation?
    @State private var showsCreateOrganization = false

    var body: some View {
        VStack(spacing: 0) {
            header
            ScrollView {
                VStack(spacing: TTSpacing.lg) {
                    identityCard
                    organizationSection
                    if !invitations.pendingInvitations.isEmpty {
                        invitationsSection
                    }
                    notificationsRow
                }
                .padding(.horizontal, TTSpacing.md)
                .padding(.top, TTSpacing.sm)
                .padding(.bottom, TTSpacing.lg)
            }
            footer
        }
        .background {
            Color.tt.bgCanvasDefault.ignoresSafeArea()
        }
        // 前景内容遵循系统安全区；只有背景延伸到状态栏和 Home Indicator。
        .sheet(item: $pendingInvitation) { invitation in
            InvitationResponseSheet(invitation: invitation)
        }
        .sheet(isPresented: $showsCreateOrganization) {
            CreateOrganizationSheet()
        }
    }

    private var header: some View {
        HStack {
            Text(L10n.AccountDrawer.title)
                .font(.tt.titleSemibold)
                .foregroundStyle(.tt.textPrimary)
                .accountDrawerTitleFrameProbe()
            Spacer()
            Button {
                coordinator.closeDrawer()
            } label: {
                Image(systemName: "xmark")
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(.tt.textSecondary)
                    .frame(width: 44, height: 44)
            }
            .accessibilityLabel(L10n.Common.close)
        }
        .padding(.horizontal, TTSpacing.lg)
        .padding(.top, layout == .regular ? TTSpacing.md : TTSpacing.sm)
        .padding(.bottom, TTSpacing.xs)
    }

    private var identityCard: some View {
        Button {
            coordinator.route(to: .me)
        } label: {
            HStack(spacing: TTSpacing.md) {
                ProfileAvatarView(
                    name: auth.currentUser?.displayName ?? L10n.Profile.defaultName,
                    imageURL: auth.currentUser?.avatar.flatMap(URL.init(string:)),
                    size: 52,
                    seed: auth.currentUser?.id
                )
                VStack(alignment: .leading, spacing: TTSpacing.xxs) {
                    Text(auth.currentUser?.displayName ?? L10n.Profile.defaultName)
                        .font(.tt.subtitleSemibold)
                        .foregroundStyle(.tt.textPrimary)
                        .lineLimit(1)
                    if let username = auth.currentUser?.username, !username.isEmpty {
                        Text("@\(username)")
                            .font(.tt.meta)
                            .foregroundStyle(.tt.textTertiary)
                            .lineLimit(1)
                    }
                }
                Spacer(minLength: 0)
                Image(systemName: "chevron.right")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(.tt.textTertiary)
            }
            .padding(TTSpacing.lg)
            .background(
                RoundedRectangle(cornerRadius: TTRadius.lg)
                    .fill(.tt.bgSubtle)
            )
        }
        .buttonStyle(.plain)
        .accessibilityLabel(L10n.AccountDrawer.openMe)
    }

    private var organizationSection: some View {
        VStack(alignment: .leading, spacing: TTSpacing.sm) {
            Text(L10n.AccountDrawer.currentOrganization)
                .font(.tt.captionSemibold)
                .foregroundStyle(.tt.textTertiary)
                .padding(.horizontal, TTSpacing.xs)

            if let organization = workspace.selectedOrganization {
                Button {
                    coordinator.setOrganizationPickerVisible(!coordinator.showsOrganizationPicker)
                } label: {
                    HStack(spacing: TTSpacing.md) {
                        organizationIcon(organization, size: 32)
                        VStack(alignment: .leading, spacing: TTSpacing.xxs) {
                            Text(organization.name)
                                .font(.tt.subtitle)
                                .foregroundStyle(.tt.textPrimary)
                                .lineLimit(1)
                            if let role = workspace.currentUserRole, role != .unknown {
                                Text(role.title)
                                    .font(.tt.meta)
                                    .foregroundStyle(.tt.textTertiary)
                            } else if coordinator.switchingOrganizationId != nil
                                        || workspace.isLoadingSpaces
                                        || workspace.isLoadingMembers {
                                Text(L10n.Common.loading)
                                    .font(.tt.meta)
                                    .foregroundStyle(.tt.textTertiary)
                            }
                        }
                        Spacer(minLength: 0)
                        Image(systemName: coordinator.showsOrganizationPicker ? "chevron.up" : "chevron.down")
                            .font(.system(size: 12, weight: .semibold))
                            .foregroundStyle(.tt.textTertiary)
                    }
                    .padding(.vertical, TTSpacing.md)
                    .padding(.horizontal, TTSpacing.lg)
                    .background(
                        RoundedRectangle(cornerRadius: TTRadius.md)
                            .fill(.tt.bgSubtle)
                    )
                }
                .buttonStyle(.plain)
                .accessibilityLabel(L10n.AccountDrawer.switchOrganization)
            }

            if coordinator.showsOrganizationPicker {
                organizationPicker
            }

            if let error = coordinator.organizationSwitchError {
                VStack(alignment: .leading, spacing: TTSpacing.sm) {
                    Text(error)
                        .font(.tt.meta)
                        .foregroundStyle(.tt.textCritical)
                    Button(L10n.Common.retry) {
                        Task {
                            await coordinator.retrySelectedOrganizationContext(workspace: workspace)
                        }
                    }
                    .font(.tt.metaSemibold)
                    .disabled(coordinator.switchingOrganizationId != nil)
                }
                .padding(.horizontal, TTSpacing.xs)
            }
        }
    }

    private var organizationPicker: some View {
        VStack(spacing: 0) {
            ForEach(workspace.organizations) { organization in
                let isSelected = organization.id == workspace.selectedOrganizationId
                let isSwitching = coordinator.switchingOrganizationId == organization.id
                Button {
                    guard coordinator.switchingOrganizationId == nil else { return }
                    Task {
                        await coordinator.switchOrganization(organization, workspace: workspace)
                    }
                } label: {
                    HStack(spacing: TTSpacing.md) {
                        organizationIcon(organization, size: 28)
                        Text(organization.name)
                            .font(.tt.subtitle)
                            .foregroundStyle(.tt.textPrimary)
                            .lineLimit(1)
                        Spacer(minLength: 0)
                        if isSwitching {
                            ProgressView()
                                .controlSize(.small)
                        } else if isSelected {
                            Image(systemName: "checkmark")
                                .font(.tt.bodySemibold)
                                .foregroundStyle(.tt.iconAccent)
                        }
                    }
                    .padding(.vertical, TTSpacing.md)
                    .padding(.horizontal, TTSpacing.lg)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .disabled(isSwitching || coordinator.switchingOrganizationId != nil)
                .frame(maxWidth: .infinity, alignment: .leading)
                .contentShape(Rectangle())
            }
            Divider()
            Button {
                coordinator.setOrganizationPickerVisible(false)
                showsCreateOrganization = true
            } label: {
                Label(L10n.Workspace.create, systemImage: "plus.circle.fill")
                    .font(.tt.subtitle)
                    .foregroundStyle(.tt.textAccent)
                    .padding(.vertical, TTSpacing.md)
                    .padding(.horizontal, TTSpacing.lg)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("account-drawer-create-organization")
        }
        .background(
            RoundedRectangle(cornerRadius: TTRadius.md)
                .stroke(.tt.borderLight, lineWidth: 1)
        )
    }

    private var invitationsSection: some View {
        VStack(alignment: .leading, spacing: TTSpacing.sm) {
            Text(L10n.AccountDrawer.organizationInvitations)
                .font(.tt.captionSemibold)
                .foregroundStyle(.tt.textTertiary)
                .padding(.horizontal, TTSpacing.xs)

            VStack(spacing: 0) {
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
                                    .lineLimit(1)
                                Text(
                                    invitation.invitedByName.isEmpty
                                        ? invitation.role.title
                                        : "\(invitation.invitedByName) · \(invitation.role.title)"
                                )
                                .font(.tt.meta)
                                .foregroundStyle(.tt.textTertiary)
                                .lineLimit(1)
                            }
                            Spacer(minLength: 0)
                            Text(L10n.Profile.pending)
                                .font(.tt.captionSemibold)
                                .foregroundStyle(.tt.textWarning)
                        }
                        .padding(.vertical, TTSpacing.md)
                        .padding(.horizontal, TTSpacing.lg)
                    }
                    .buttonStyle(.plain)
                }
            }
            .background(
                RoundedRectangle(cornerRadius: TTRadius.md)
                    .fill(.tt.bgSubtle)
            )
        }
    }

    private var notificationsRow: some View {
        Button {
            coordinator.requestGlobalPush(.notifications)
        } label: {
            HStack(spacing: TTSpacing.md) {
                Image(systemName: "bell.fill")
                    .font(.system(size: 18))
                    .foregroundStyle(.tt.iconAccent)
                    .frame(width: 28)
                VStack(alignment: .leading, spacing: TTSpacing.xxs) {
                    Text(L10n.Notifications.title)
                        .font(.tt.subtitle)
                        .foregroundStyle(.tt.textPrimary)
                    Text(
                        notificationStore.unreadCount > 0
                            ? L10n.Notifications.unreadCount(notificationStore.unreadCount)
                            : L10n.Notifications.noUnread
                    )
                    .font(.tt.meta)
                    .foregroundStyle(.tt.textTertiary)
                }
                Spacer(minLength: 0)
                if notificationStore.unreadCount > 0 {
                    Text("\(min(notificationStore.unreadCount, 99))")
                        .font(.tt.captionSemibold)
                        .foregroundStyle(.white)
                        .padding(.horizontal, 8)
                        .padding(.vertical, 3)
                        .background(Capsule().fill(.tt.bgAccent))
                }
                Image(systemName: "chevron.right")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(.tt.textTertiary)
            }
            .padding(.vertical, TTSpacing.md)
            .padding(.horizontal, TTSpacing.lg)
            .background(
                RoundedRectangle(cornerRadius: TTRadius.md)
                    .fill(.tt.bgSubtle)
            )
        }
        .buttonStyle(.plain)
    }

    private var footer: some View {
        VStack(spacing: 0) {
            Divider()
            Button {
                coordinator.route(to: .settings)
            } label: {
                HStack(spacing: TTSpacing.md) {
                    Image(systemName: "gearshape.fill")
                        .font(.system(size: 18))
                        .foregroundStyle(.tt.iconAccent)
                        .frame(width: 28)
                    Text(L10n.Common.settings)
                        .font(.tt.subtitle)
                        .foregroundStyle(.tt.textPrimary)
                    Spacer()
                    Image(systemName: "chevron.right")
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(.tt.textTertiary)
                }
                .padding(.horizontal, TTSpacing.lg)
                .padding(.vertical, TTSpacing.lg)
                .frame(minHeight: 44)
                .frame(maxWidth: .infinity, alignment: .leading)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(Rectangle())

            Text(L10n.Profile.aboutVersionFormat(AppConfig.appVersion, AppConfig.buildNumber))
                .font(.tt.caption)
                .foregroundStyle(.tt.textTertiary)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, TTSpacing.lg)
                .padding(.bottom, TTSpacing.lg)
                .accountDrawerVersionFrameProbe()
        }
        .background(.tt.bgCanvasDefault)
    }

    @ViewBuilder
    private func organizationIcon(_ organization: Organization, size: CGFloat) -> some View {
        ProfileAvatarView(
            name: organization.name,
            imageURL: organization.logoURL,
            size: size,
            cornerRadius: size * 0.24,
            fallbackText: organization.avatarFallbackText
        )
    }
}

private struct CreateOrganizationSheet: View {
    @Environment(\.dismiss) private var dismiss
    @State private var workspace = WorkspaceStore.shared
    @State private var name = ""
    @State private var description = ""
    @State private var isCreating = false
    @State private var errorMessage: String?

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField(L10n.Workspace.namePlaceholder, text: $name)
                        .textContentType(.organizationName)
                    TextField(L10n.Workspace.descriptionPlaceholder, text: $description, axis: .vertical)
                        .lineLimit(2...5)
                }
                if let errorMessage {
                    Section {
                        Label(errorMessage, systemImage: "exclamationmark.triangle.fill")
                            .font(.tt.meta)
                            .foregroundStyle(.tt.textCritical)
                    }
                }
            }
            .ttSettingsDetailFormStyle()
            .navigationTitle(L10n.Workspace.createTitle)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(L10n.Common.cancel) { dismiss() }
                        .disabled(isCreating)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(L10n.Workspace.createAction) { Task { await create() } }
                        .disabled(name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || isCreating)
                }
            }
            .interactiveDismissDisabled(isCreating)
            .ttLoading(isCreating)
        }
    }

    @MainActor
    private func create() async {
        isCreating = true
        errorMessage = nil
        defer { isCreating = false }
        do {
            _ = try await workspace.createOrganization(name: name, description: description)
            dismiss()
        } catch is CancellationError {
            return
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}

private extension View {
    @ViewBuilder
    func accountDrawerTitleFrameProbe() -> some View {
#if DEBUG
        onGeometryChange(for: CGRect.self) { proxy in
            proxy.frame(in: .global)
        } action: { frame in
            AccountDrawerLayoutDebugProbe.titleFrame = frame
        }
#else
        self
#endif
    }

    @ViewBuilder
    func accountDrawerVersionFrameProbe() -> some View {
#if DEBUG
        onGeometryChange(for: CGRect.self) { proxy in
            proxy.frame(in: .global)
        } action: { frame in
            AccountDrawerLayoutDebugProbe.versionFrame = frame
        }
#else
        self
#endif
    }
}
