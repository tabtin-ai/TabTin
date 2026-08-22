import SwiftUI

struct AcceptInvitationSheet: View {
    @Environment(\.dismiss) private var dismiss
    @State private var info: InvitationInfo?
    @State private var isLoading = true
    @State private var isAccepting = false
    @State private var errorMessage: String?

    let invite: InviteDeepLink
    let onFinished: () -> Void

    var body: some View {
        NavigationStack {
            Group {
                if isLoading {
                    ProgressView(L10n.Common.loading)
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else if let info, info.valid {
                    invitationPreview(info)
                } else if let info {
                    invalidInvitation(info)
                } else {
                    loadFailure
                }
            }
            .navigationTitle(L10n.Workspace.acceptInvitation)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(L10n.Common.close) { finish() }
                }
            }
        }
        .interactiveDismissDisabled(isAccepting)
        .task(id: invite.id) { await loadInfo() }
    }

    private func invitationPreview(_ info: InvitationInfo) -> some View {
        VStack(spacing: TTSpacing.xl) {
            Spacer()
            IdentityColorAvatar(
                name: info.organizationName ?? L10n.Workspace.team,
                seed: info.organizationName,
                size: 72,
                group: true
            )
            VStack(spacing: TTSpacing.sm) {
                Text(L10n.Workspace.invitedToWorkspace)
                    .font(.tt.body)
                    .foregroundStyle(.tt.textSecondary)
                Text(info.organizationName ?? L10n.Workspace.team)
                    .font(.tt.headingSemibold)
                    .foregroundStyle(.tt.textPrimary)
                    .multilineTextAlignment(.center)
                if let role = info.role {
                    Text(role.title)
                        .font(.tt.metaSemibold)
                        .foregroundStyle(.tt.textAccent)
                        .padding(.horizontal, TTSpacing.md)
                        .padding(.vertical, TTSpacing.xs)
                        .background(.tt.bgAccent.opacity(0.12), in: Capsule())
                }
            }
            if let errorMessage {
                Text(errorMessage)
                    .font(.tt.meta)
                    .foregroundStyle(.tt.textCritical)
                    .multilineTextAlignment(.center)
            }
            Button {
                Task { await acceptInvitation() }
            } label: {
                HStack(spacing: TTSpacing.sm) {
                    if isAccepting { ProgressView().tint(.white) }
                    Text(L10n.Workspace.joinWorkspace)
                }
                .frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .disabled(isAccepting)
            Spacer()
        }
        .padding(TTSpacing.xl)
    }

    private func invalidInvitation(_ info: InvitationInfo) -> some View {
        VStack(spacing: TTSpacing.lg) {
            Image(systemName: "xmark.circle")
                .font(.tt.iconEmptyLG)
                .foregroundStyle(.tt.textCritical)
            Text(info.status == "expired"
                ? L10n.Workspace.invitationExpired
                : L10n.Workspace.invitationInvalid)
                .font(.tt.subtitleSemibold)
                .foregroundStyle(.tt.textSecondary)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding(TTSpacing.xl)
    }

    private var loadFailure: some View {
        VStack(spacing: TTSpacing.lg) {
            Image(systemName: "exclamationmark.triangle")
                .font(.tt.iconEmptyLG)
                .foregroundStyle(.tt.textWarning)
            Text(errorMessage ?? L10n.Workspace.invitationInvalid)
                .font(.tt.body)
                .foregroundStyle(.tt.textSecondary)
                .multilineTextAlignment(.center)
            Button(L10n.Common.retry) {
                Task { await loadInfo() }
            }
            .buttonStyle(.borderedProminent)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding(TTSpacing.xl)
    }

    @MainActor
    private func loadInfo() async {
        isLoading = true
        errorMessage = nil
        do {
            info = try await InvitationService.shared.invitationInfo(token: invite.token)
        } catch is CancellationError {
            return
        } catch {
            info = nil
            errorMessage = error.localizedDescription
        }
        isLoading = false
    }

    @MainActor
    private func acceptInvitation() async {
        isAccepting = true
        errorMessage = nil
        defer { isAccepting = false }
        do {
            _ = try await InvitationService.shared.acceptInvitation(token: invite.token)
            finish()
        } catch is CancellationError {
            return
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func finish() {
        onFinished()
        dismiss()
    }
}
