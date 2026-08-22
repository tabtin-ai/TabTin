import SwiftUI

/// 账号注销流程（App Store 5.1.1(v)）。当前为客户端占位：30 天冷静期后完成注销。
struct AccountDeletionScreen: View {
    @Environment(\.dismiss) private var dismiss
    @State private var privacy = PrivacyConsentStore.shared
    @State private var auth = AuthService.shared
    @State private var showConfirmAlert = false
    @State private var showCompletionAlert = false
    @State private var scheduledDeletionDate: Date?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: TTSpacing.xl) {
                if privacy.isAccountDeletionPending {
                    pendingState
                } else {
                    deletionIntro
                    warningCard
                    gracePeriodCard
                    deleteButton
                }
            }
            .padding(TTSpacing.xl)
        }
        .background(.tt.bgCanvasDefault, ignoresSafeAreaEdges: .all)
        .navigationTitle(L10n.Profile.deleteAccountTitle)
        .navigationBarTitleDisplayMode(.inline)
        .alert(L10n.Profile.deleteAccountConfirmTitle, isPresented: $showConfirmAlert) {
            Button(L10n.Profile.deleteAccountConfirmAction, role: .destructive) {
                submitDeletionRequest()
            }
            Button(L10n.Common.cancel, role: .cancel) {}
        } message: {
            Text(L10n.Profile.deleteAccountConfirmMessage)
        }
        .alert(L10n.Profile.deleteAccountSubmittedTitle, isPresented: $showCompletionAlert) {
            Button(L10n.Common.confirm) {
                auth.logout()
                dismiss()
            }
        } message: {
            if let scheduledDeletionDate {
                Text(L10n.Profile.deleteAccountSubmittedMessage(formattedDate(scheduledDeletionDate)))
            }
        }
    }

    private var deletionIntro: some View {
        VStack(alignment: .leading, spacing: TTSpacing.sm) {
            Text(L10n.Profile.deleteAccountIntroTitle)
                .font(.tt.subtitleSemibold)
                .foregroundStyle(.tt.textPrimary)
            Text(L10n.Profile.deleteAccountIntroBody)
                .font(.tt.body)
                .foregroundStyle(.tt.textSecondary)
        }
    }

    private var warningCard: some View {
        VStack(alignment: .leading, spacing: TTSpacing.sm) {
            Label(L10n.Profile.deleteAccountWarningTitle, systemImage: "exclamationmark.triangle.fill")
                .font(.tt.bodySemibold)
                .foregroundStyle(.tt.textCritical)
            Text(L10n.Profile.deleteAccountWarningBody)
                .font(.tt.meta)
                .foregroundStyle(.tt.textSecondary)
        }
        .padding(TTSpacing.lg)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: TTRadius.md)
                .fill(.tt.bgCritical.opacity(0.08))
        )
    }

    private var gracePeriodCard: some View {
        VStack(alignment: .leading, spacing: TTSpacing.sm) {
            Text(L10n.Profile.deleteAccountGraceTitle)
                .font(.tt.bodySemibold)
                .foregroundStyle(.tt.textPrimary)
            Text(L10n.Profile.deleteAccountGraceBody(PrivacyConsentStore.accountDeletionGraceDays))
                .font(.tt.meta)
                .foregroundStyle(.tt.textSecondary)
        }
        .padding(TTSpacing.lg)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: TTRadius.md)
                .fill(.tt.bgSubtle)
        )
    }

    private var deleteButton: some View {
        Button(role: .destructive) {
            showConfirmAlert = true
        } label: {
            Text(L10n.Profile.deleteAccountAction)
                .font(.tt.bodySemibold)
                .frame(maxWidth: .infinity)
                .padding(.vertical, TTSpacing.lg)
                .background(
                    RoundedRectangle(cornerRadius: TTRadius.md)
                        .fill(.tt.bgCritical.opacity(0.12))
                )
        }
        .buttonStyle(.plain)
    }

    private var pendingState: some View {
        VStack(alignment: .leading, spacing: TTSpacing.lg) {
            Label(L10n.Profile.deleteAccountPendingTitle, systemImage: "clock.badge.exclamationmark")
                .font(.tt.subtitleSemibold)
                .foregroundStyle(.tt.textPrimary)
            if let scheduled = privacy.accountDeletionScheduledDate {
                Text(L10n.Profile.deleteAccountPendingBody(formattedDate(scheduled)))
                    .font(.tt.body)
                    .foregroundStyle(.tt.textSecondary)
            }
            Text(L10n.Profile.deleteAccountPendingNote)
                .font(.tt.meta)
                .foregroundStyle(.tt.textTertiary)
            Button {
                privacy.clearAccountDeletionRequest()
            } label: {
                Text(L10n.Profile.deleteAccountCancelRequest)
                    .font(.tt.bodySemibold)
                    .foregroundStyle(.tt.textAccent)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, TTSpacing.lg)
                    .background(
                        RoundedRectangle(cornerRadius: TTRadius.md)
                            .strokeBorder(.tt.borderLight, lineWidth: 1)
                    )
            }
            .buttonStyle(.plain)
        }
    }

    private func submitDeletionRequest() {
        scheduledDeletionDate = privacy.requestAccountDeletion()
        showCompletionAlert = true
    }

    private func formattedDate(_ date: Date) -> String {
        date.formatted(date: .long, time: .omitted)
    }
}

struct PrivacySettingsScreen: View {
    @State private var privacy = PrivacyConsentStore.shared
    @State private var showConsentSheet = false
    @State private var showRevokeConfirm = false

    var body: some View {
        List {
            Section {
                HStack(spacing: TTSpacing.md) {
                    TTSettingsDetailLabel(
                        title: L10n.Privacy.aiSharingStatus,
                        systemImage: privacy.hasAcceptedAISharing ? "checkmark.shield.fill" : "shield.slash.fill",
                        tone: privacy.hasAcceptedAISharing ? .success : .neutral
                    )
                    Spacer()
                    Text(privacy.hasAcceptedAISharing ? L10n.Privacy.aiSharingEnabled : L10n.Privacy.aiSharingDisabled)
                        .foregroundStyle(privacy.hasAcceptedAISharing ? .tt.textAccent : .tt.textTertiary)
                }
            } footer: {
                Text(L10n.Privacy.aiSharingStatusFooter)
            }

            Section {
                Button {
                    showConsentSheet = true
                } label: {
                    TTSettingsDetailLabel(
                        title: L10n.Privacy.reviewAiConsent,
                        systemImage: "doc.text.magnifyingglass"
                    )
                }

                Link(destination: PrivacyConsentStore.privacyPolicyURL) {
                    HStack(spacing: TTSpacing.md) {
                        TTSettingsDetailLabel(
                            title: L10n.Profile.aboutPrivacy,
                            systemImage: "hand.raised.fill"
                        )
                        Spacer()
                        Image(systemName: "arrow.up.right")
                            .foregroundStyle(.tt.textTertiary)
                            .accessibilityHidden(true)
                    }
                }

                if privacy.hasAcceptedAISharing {
                    Button(role: .destructive) {
                        showRevokeConfirm = true
                    } label: {
                        TTSettingsDetailLabel(
                            title: L10n.Privacy.revokeAiConsent,
                            systemImage: "xmark.shield.fill",
                            tone: .critical
                        )
                    }
                }
            }
        }
        .ttSettingsDetailListStyle()
        .navigationTitle(L10n.Privacy.settingsTitle)
        .navigationBarTitleDisplayMode(.inline)
        .sheet(isPresented: $showConsentSheet) {
            AIDataSharingConsentSheet(model: nil, onAccepted: {})
        }
        .alert(L10n.Privacy.revokeAiConsentTitle, isPresented: $showRevokeConfirm) {
            Button(L10n.Privacy.revokeAiConsent, role: .destructive) {
                privacy.revokeAISharing()
            }
            Button(L10n.Common.cancel, role: .cancel) {}
        } message: {
            Text(L10n.Privacy.revokeAiConsentMessage)
        }
    }
}
