import SwiftUI

/// 第三方 AI 数据共享披露与同意（App Store 5.1.1(i) / 5.1.2(i)）。
struct AIDataSharingConsentView: View {
    let model: ChatModel?
    /// 仅聊天首发链路可同意；设置页的泛化说明只供查看。
    var allowsAcceptance = false
    var showsDeclineButton = true
    let onAccept: () -> Void
    let onDecline: () -> Void

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: TTSpacing.xl) {
                header
                disclosureSection(
                    title: L10n.Privacy.aiDataSharedTitle,
                    items: [
                        L10n.Privacy.aiDataChatMessages,
                        L10n.Privacy.aiDataAttachments,
                        L10n.Privacy.aiDataContextRefs,
                        L10n.Privacy.aiDataVoiceTranscripts,
                        L10n.Privacy.aiDataProfileBasic,
                    ]
                )
                disclosureSection(
                    title: L10n.Privacy.aiRecipientsTitle,
                    items: [
                        recipientDisclosure,
                    ]
                )
                Text(L10n.Privacy.aiPurposeNote)
                    .font(.tt.meta)
                    .foregroundStyle(.tt.textSecondary)
                Link(destination: PrivacyConsentStore.privacyPolicyURL) {
                    HStack(spacing: TTSpacing.xs) {
                        Text(L10n.Privacy.viewPrivacyPolicy)
                        Image(systemName: "arrow.up.right")
                    }
                    .font(.tt.body)
                    .foregroundStyle(.tt.textAccent)
                }
                actionButtons
            }
            .padding(TTSpacing.xl)
        }
        .background(.tt.bgCanvasDefault)
    }

    private var recipientDisclosure: String {
        L10n.Privacy.aiRecipientProviders
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: TTSpacing.sm) {
            Text(L10n.Privacy.aiConsentTitle)
                .font(.tt.subtitleSemibold)
                .foregroundStyle(.tt.textPrimary)
            Text(L10n.Privacy.aiConsentSubtitle)
                .font(.tt.body)
                .foregroundStyle(.tt.textSecondary)
        }
    }

    private func disclosureSection(title: String, items: [String]) -> some View {
        VStack(alignment: .leading, spacing: TTSpacing.sm) {
            Text(title)
                .font(.tt.bodySemibold)
                .foregroundStyle(.tt.textPrimary)
            ForEach(items, id: \.self) { item in
                HStack(alignment: .top, spacing: TTSpacing.sm) {
                    Text("•")
                        .foregroundStyle(.tt.textTertiary)
                    Text(item)
                        .font(.tt.body)
                        .foregroundStyle(.tt.textSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var actionButtons: some View {
        Group {
            // 设置页只提供泛化说明；会话首发一旦弹窗即必须直接给出操作。
            // 会话页以有效模型驱动 sheet，提交时仍由 PrivacyConsentStore 做最终校验。
            if allowsAcceptance {
                consentButtons
            }
        }
    }

    private var consentButtons: some View {
        VStack(spacing: TTSpacing.md) {
            Button {
                guard PrivacyConsentStore.shared.acceptAISharing(for: model) else { return }
                onAccept()
            } label: {
                Text(L10n.Privacy.aiConsentAgree)
                    .font(.tt.bodySemibold)
                    .foregroundStyle(.white)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, TTSpacing.lg)
                    .background(RoundedRectangle(cornerRadius: TTRadius.md).fill(.tt.bgAccent))
            }
            .buttonStyle(.plain)

            if showsDeclineButton {
                Button {
                    onDecline()
                } label: {
                    Text(L10n.Privacy.aiConsentDecline)
                        .font(.tt.body)
                        .foregroundStyle(.tt.textSecondary)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, TTSpacing.md)
                }
                .buttonStyle(.plain)
            }
        }
    }
}

struct AIDataSharingConsentSheet: View {
    @Environment(\.dismiss) private var dismiss
    var model: ChatModel?
    var allowsAcceptance = false
    let onAccepted: () -> Void

    var body: some View {
        NavigationStack {
            AIDataSharingConsentView(
                model: model,
                allowsAcceptance: allowsAcceptance,
                onAccept: {
                    dismiss()
                    onAccepted()
                },
                onDecline: { dismiss() }
            )
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(L10n.Common.close) { dismiss() }
                }
            }
        }
    }
}
