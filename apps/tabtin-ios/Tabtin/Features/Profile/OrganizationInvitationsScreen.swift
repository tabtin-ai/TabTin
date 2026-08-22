import SwiftUI

/// 账号级组织邀请处理层（通知深链 / 侧栏入口共用）。
struct OrganizationInvitationsScreen: View {
    @State private var invitations = InvitationService.shared
    @State private var pendingInvitation: PendingInvitation?

    var body: some View {
        Group {
            if invitations.isLoadingPendingInvitations, invitations.pendingInvitations.isEmpty {
                ProgressView()
            } else if
                let error = invitations.pendingInvitationsErrorMessage,
                invitations.pendingInvitations.isEmpty
            {
                ContentUnavailableView {
                    Label(
                        L10n.AccountDrawer.organizationInvitations,
                        systemImage: "exclamationmark.triangle"
                    )
                } description: {
                    Text(error)
                } actions: {
                    Button(L10n.Common.retry) {
                        Task { await invitations.loadMyPendingInvitations() }
                    }
                }
            } else if invitations.pendingInvitations.isEmpty {
                ContentUnavailableView(
                    L10n.AccountDrawer.noOrganizationInvitations,
                    systemImage: "envelope.open"
                )
            } else {
                List {
                    ForEach(invitations.pendingInvitations) { invitation in
                        Button {
                            pendingInvitation = invitation
                        } label: {
                            VStack(alignment: .leading, spacing: TTSpacing.xxs) {
                                Text(invitation.workspaceName)
                                    .font(.tt.subtitle)
                                    .foregroundStyle(.tt.textPrimary)
                                Text(
                                    invitation.invitedByName.isEmpty
                                        ? invitation.role.title
                                        : "\(invitation.invitedByName) · \(invitation.role.title)"
                                )
                                .font(.tt.meta)
                                .foregroundStyle(.tt.textTertiary)
                            }
                        }
                    }
                    if let error = invitations.pendingInvitationsErrorMessage {
                        Section {
                            VStack(alignment: .leading, spacing: TTSpacing.sm) {
                                Text(error)
                                    .font(.tt.meta)
                                    .foregroundStyle(.tt.textCritical)
                                Button(L10n.Common.retry) {
                                    Task { await invitations.loadMyPendingInvitations() }
                                }
                                .font(.tt.metaSemibold)
                            }
                        }
                    }
                }
                .ttListStyle()
                .refreshable {
                    await invitations.loadMyPendingInvitations()
                }
            }
        }
        .navigationTitle(L10n.AccountDrawer.organizationInvitations)
        .navigationBarTitleDisplayMode(.inline)
        .task {
            await invitations.loadMyPendingInvitations()
        }
        .sheet(item: $pendingInvitation) { invitation in
            InvitationResponseSheet(invitation: invitation)
        }
    }
}
