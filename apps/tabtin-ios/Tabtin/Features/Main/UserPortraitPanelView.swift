import SwiftUI
@preconcurrency import MarkdownUI

struct UserPortraitPanelView: View {
    @State var observable: UserPortraitObservable
    let organizationId: String
    let agentId: String
    let canManage: Bool

    @State private var notice: String?

    var body: some View {
        VStack(alignment: .leading, spacing: TTSpacing.md) {
            if organizationId.isEmpty || agentId.isEmpty {
                Text(L10n.Agent.userPortraitNoOrganization)
                    .font(.tt.meta)
                    .foregroundStyle(.tt.textTertiary)
                    .frame(maxWidth: .infinity, alignment: .center)
                    .padding(.vertical, TTSpacing.xl)
            } else {
                statusRow

                if let loadError = observable.loadError {
                    loadErrorBanner(loadError)
                } else {
                    portraitContent
                    if let notice {
                        Text(notice)
                            .font(.tt.caption)
                            .foregroundStyle(.tt.textAccent)
                    }
                    if observable.portrait?.memoryEnabled != false {
                        HintInputView(
                            disabled: actionsDisabled,
                            onSubmit: submitHint
                        )
                        .id("\(organizationId):\(agentId)")
                    }
                }
            }
        }
        .onAppear {
            observable.configure(organizationId: organizationId, agentId: agentId)
        }
        .onChange(of: organizationId) { _, value in
            notice = nil
            observable.configure(organizationId: value, agentId: agentId)
        }
        .onChange(of: agentId) { _, value in
            notice = nil
            observable.configure(organizationId: organizationId, agentId: value)
        }
    }

    private var actionsDisabled: Bool {
        !canManage || observable.isLoading || observable.isDistilling || observable.portrait?.memoryEnabled == false
    }

    private var statusRow: some View {
        HStack(spacing: TTSpacing.sm) {
            Image(systemName: "sparkles")
                .font(.tt.iconCaption)
                .foregroundStyle(.tt.iconAccent)
            Text(L10n.Agent.userPortraitLastDistilled)
                .font(.tt.caption)
                .foregroundStyle(.tt.textTertiary)
            Text(relativeTime(observable.portrait?.lastDistilledAt))
                .font(.tt.captionMedium)
                .foregroundStyle(.tt.textSecondary)
            Spacer()
            if observable.isLoading || observable.isDistilling {
                ProgressView().controlSize(.small)
            }
        }
    }

    @ViewBuilder
    private var portraitContent: some View {
        if observable.isLoading && observable.portrait == nil {
            ProgressView()
                .frame(maxWidth: .infinity)
                .padding(.vertical, TTSpacing.xl)
        } else if observable.portrait?.memoryEnabled == false {
            Text(L10n.Agent.userPortraitDisabled)
                .font(.tt.meta)
                .foregroundStyle(.tt.textTertiary)
                .frame(maxWidth: .infinity, alignment: .center)
                .padding(.vertical, TTSpacing.xl)
        } else if let portrait = observable.portrait,
                  !portrait.contentMd.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            let sections = parseUserPortraitSections(portrait.contentMd)
            VStack(alignment: .leading, spacing: TTSpacing.lg) {
                ForEach(Array(sections.enumerated()), id: \.offset) { item in
                    let section = item.element
                    VStack(alignment: .leading, spacing: TTSpacing.xs) {
                        if !section.title.isEmpty {
                            Text(section.title)
                                .font(.tt.bodySemibold)
                                .foregroundStyle(.tt.textPrimary)
                            Divider().overlay(.tt.borderLight)
                        }
                        if !section.body.isEmpty {
                            Markdown(section.body)
                                .markdownTheme(.tabtin)
                                .textSelection(.enabled)
                        }
                    }
                }
            }
        } else {
            VStack(spacing: TTSpacing.sm) {
                Image(systemName: "leaf")
                    .font(.tt.iconEmpty)
                    .foregroundStyle(.tt.iconAccent)
                Text(L10n.Agent.userPortraitEmptyTitle)
                    .font(.tt.subtitleSemibold)
                    .foregroundStyle(.tt.textPrimary)
                Text(L10n.Project.myAgentsMemoryOverviewHint)
                    .font(.tt.body)
                    .foregroundStyle(.tt.textSecondary)
                    .multilineTextAlignment(.center)
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, TTSpacing.xxxl)
        }

        if observable.isStillDistilling {
            HStack(spacing: TTSpacing.sm) {
                Image(systemName: "clock")
                Text(L10n.Agent.userPortraitStillDistillingHint)
                    .font(.tt.caption)
                Spacer()
                Button(L10n.Agent.userPortraitStillDistillingRefresh) {
                    Task { await observable.refresh() }
                }
                .font(.tt.captionMedium)
            }
            .foregroundStyle(.tt.textWarning)
        }
    }

    private func loadErrorBanner(_ message: String) -> some View {
        VStack(alignment: .leading, spacing: TTSpacing.xs) {
            Label(L10n.Agent.userPortraitLoadFailedTitle, systemImage: "exclamationmark.triangle")
                .font(.tt.metaSemibold)
                .foregroundStyle(.tt.textCritical)
            Text(message)
                .font(.tt.caption)
                .foregroundStyle(.tt.textTertiary)
                .lineLimit(3)
            Button(L10n.Agent.userPortraitLoadFailedRetry) {
                Task { await observable.refresh() }
            }
            .font(.tt.metaMedium)
        }
        .padding(TTSpacing.sm)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.tt.bgCritical.opacity(0.08), in: RoundedRectangle(cornerRadius: TTRadius.sm))
    }

    private func submitHint(_ text: String) async throws {
        do {
            let value = try await observable.submitHint(text)
            if let warning = value.softWarning, !warning.isEmpty {
                notice = warning
            } else if value.distillDispatched != false {
                notice = L10n.Agent.userPortraitDistillScheduled
            }
        } catch {
            notice = "\(L10n.Agent.userPortraitHintSubmitFailed)：\(error.localizedDescription)"
            throw error
        }
    }

    private func relativeTime(_ value: String?) -> String {
        guard let value, !value.isEmpty else { return L10n.Agent.userPortraitNeverDistilled }
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        var date = formatter.date(from: value)
        if date == nil {
            formatter.formatOptions = [.withInternetDateTime]
            date = formatter.date(from: value)
        }
        guard let date else { return value }
        let seconds = Date().timeIntervalSince(date)
        if seconds < 60 { return L10n.Agent.userPortraitJustNow }
        if seconds < 3_600 { return L10n.Agent.userPortraitMinAgo(Int(seconds / 60)) }
        if seconds < 86_400 { return L10n.Agent.userPortraitHourAgo(Int(seconds / 3_600)) }
        return L10n.Agent.userPortraitDayAgo(Int(seconds / 86_400))
    }
}

private struct HintInputView: View {
    private static let softLimit = 200
    private static let hardLimit = 2_000

    let disabled: Bool
    let onSubmit: (String) async throws -> Void

    @State private var text = ""
    @State private var isSubmitting = false

    private var trimmed: String { text.trimmingCharacters(in: .whitespacesAndNewlines) }

    var body: some View {
        VStack(alignment: .leading, spacing: TTSpacing.xs) {
            Text(L10n.Project.myAgentsMemoryHintLabel)
                .font(.tt.metaMedium)
                .foregroundStyle(.tt.textPrimary)
            TextField(
                L10n.Project.myAgentsMemoryHintPlaceholder,
                text: $text,
                axis: .vertical
            )
            .lineLimit(2...5)
            .font(.tt.body)
            .padding(TTSpacing.sm)
            .background(
                RoundedRectangle(cornerRadius: TTRadius.sm)
                    .stroke(.tt.borderLight, lineWidth: 1)
            )
            .disabled(disabled || isSubmitting)

            HStack {
                if trimmed.count > Self.hardLimit {
                    Text(L10n.Agent.userPortraitHintHardLimit(Self.hardLimit))
                        .foregroundStyle(.tt.textCritical)
                } else if trimmed.count > Self.softLimit {
                    Text(L10n.Agent.userPortraitHintSoftLimit(Self.softLimit))
                        .foregroundStyle(.tt.textWarning)
                }
                Spacer()
                Button(L10n.Agent.userPortraitHintSubmit) {
                    Task { await submit() }
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.small)
                .disabled(disabled || isSubmitting || trimmed.isEmpty || trimmed.count > Self.hardLimit)
            }
            .font(.tt.caption)
        }
    }

    private func submit() async {
        guard !trimmed.isEmpty, trimmed.count <= Self.hardLimit else { return }
        isSubmitting = true
        defer { isSubmitting = false }
        do {
            try await onSubmit(trimmed)
            text = ""
        } catch {
            // 提交失败保留草稿，用户可直接重试。
        }
    }
}
