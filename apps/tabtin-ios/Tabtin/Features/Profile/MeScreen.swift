import SwiftUI

/// 阶段 2：身份资料页（「我的」）— 头像/昵称/用户名/简介、编辑入口、当前组织身份卡。
struct MeScreen: View {
    @State private var auth = AuthService.shared
    @State private var workspace = WorkspaceStore.shared
    @State private var showEditSheet = false
    @State private var profileLoadError: String?
    @State private var isReloading = false

    var body: some View {
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
                organizationIdentityCard
                Spacer().frame(height: TTSpacing.huge)
            }
        }
        .background(.tt.bgCanvasDefault, ignoresSafeAreaEdges: .all)
        .navigationTitle(L10n.Profile.title)
        .navigationBarTitleDisplayMode(.large)
        .sheet(isPresented: $showEditSheet) {
            ProfileEditScreen()
        }
        .refreshable { await reload() }
        .task { await reload() }
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
                    .lineLimit(4)
            }
        }
        .padding(.horizontal, TTSpacing.xl)
    }

    @ViewBuilder
    private var organizationIdentityCard: some View {
        VStack(alignment: .leading, spacing: TTSpacing.sm) {
            Text(L10n.AccountDrawer.currentOrganization)
                .font(.tt.captionSemibold)
                .foregroundStyle(.tt.textTertiary)
                .padding(.horizontal, TTSpacing.xl + TTSpacing.xs)

            if let organization = workspace.selectedOrganization {
                HStack(spacing: TTSpacing.md) {
                    organizationIcon(organization, size: 32)
                    VStack(alignment: .leading, spacing: TTSpacing.xxs) {
                        Text(organization.name)
                            .font(.tt.subtitle)
                            .foregroundStyle(.tt.textPrimary)
                            .lineLimit(2)
                        if let role = workspace.currentUserRole, role != .unknown {
                            Text(role.title)
                                .font(.tt.meta)
                                .foregroundStyle(.tt.textTertiary)
                        } else if workspace.isLoadingMembers {
                            Text(L10n.Common.loading)
                                .font(.tt.meta)
                                .foregroundStyle(.tt.textTertiary)
                        }
                    }
                    Spacer(minLength: 0)
                }
                .padding(.vertical, TTSpacing.lg)
                .padding(.horizontal, TTSpacing.xl)
                .background(
                    RoundedRectangle(cornerRadius: TTRadius.md)
                        .fill(.tt.bgSubtle)
                )
                .padding(.horizontal, TTSpacing.xl)
            } else {
                Text(L10n.Settings.organizationUnavailable)
                    .font(.tt.body)
                    .foregroundStyle(.tt.textTertiary)
                    .padding(.horizontal, TTSpacing.xl)
                    .padding(.vertical, TTSpacing.lg)
            }
        }
    }

    private func organizationIcon(_ organization: Organization, size: CGFloat) -> some View {
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
        profileLoadError ?? workspace.errorMessage
    }

    private func reload() async {
        guard !isReloading else { return }
        isReloading = true
        defer { isReloading = false }

        do {
            try await auth.fetchProfile()
            profileLoadError = nil
        } catch {
            if error.isCancellation || Task.isCancelled { return }
            profileLoadError = error.localizedDescription
        }

        guard !Task.isCancelled else { return }
        await workspace.loadOrganizations()
    }
}
