import SwiftUI

struct MemoRowView: View {
    let memo: CloudMemoSummary
    var spaceName: String? = nil

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        VStack(alignment: .leading, spacing: TTSpacing.sm) {
            HStack(spacing: TTSpacing.xs) {
                Image(systemName: memo.isAgentSource ? "sparkles" : "note.text")
                    .foregroundStyle(memoAccent)
                    .accessibilityHidden(true)
                Text(spaceName ?? (memo.isAgentSource ? L10n.MemoAppHome.agentPenLabel : L10n.MemoAppHome.personalMemo))
                    .font(.tt.captionMedium)
                    .foregroundStyle(.tt.textTertiary)
                if memo.isPinned {
                    Image(systemName: "pin.fill")
                        .font(.tt.iconCaption)
                        .foregroundStyle(memoAccent)
                        .accessibilityLabel(L10n.MemoAppHome.pinned)
                }
                Spacer(minLength: 0)
            }
            Text(memo.displayText)
                .font(.tt.body)
                .foregroundStyle(.tt.textPrimary)
                .lineLimit(5)
                .multilineTextAlignment(.leading)
                .frame(maxWidth: .infinity, alignment: .leading)
            if !memo.allTags.isEmpty {
                MemoTagFlow(spacing: TTSpacing.xs, rowSpacing: TTSpacing.xs) {
                    ForEach(memo.allTags.prefix(4), id: \.self) { tag in
                        MemoTagChip(
                            tag: tag,
                            horizontalPadding: TTSpacing.xs,
                            verticalPadding: 3,
                            background: .tt.bgCanvasDefault
                        )
                    }
                }
            }
        }
        .padding(TTSpacing.md)
        .background(memo.memoColor.softBackground, in: RoundedRectangle(cornerRadius: TTRadius.sm))
        .overlay(
            RoundedRectangle(cornerRadius: TTRadius.sm)
                .strokeBorder(memo.memoColor == .none ? .tt.borderLight : memo.memoColor.swatch.opacity(0.45), lineWidth: 0.5)
        )
        .accessibilityElement(children: .combine)
        .accessibilityHint(L10n.MemoAppHome.openHint)
        .animation(reduceMotion ? nil : .easeInOut(duration: 0.18), value: memo.isPinned)
    }

    private var memoAccent: Color {
        memo.memoColor == .none ? .tt.iconAccent : memo.memoColor.swatch
    }
}

struct AgentDiaryRowView: View {
    let item: AgentDiaryFeedItem

    var body: some View {
        VStack(alignment: .leading, spacing: TTSpacing.sm) {
            HStack(spacing: TTSpacing.xs) {
                Image(systemName: "sparkles")
                    .foregroundStyle(.tt.iconAccent)
                    .accessibilityHidden(true)
                Text(item.agentName)
                    .font(.tt.captionMedium)
                    .foregroundStyle(.tt.textTertiary)
                Text(L10n.MemoAppHome.agentPenLabel)
                    .font(.tt.captionMedium)
                    .foregroundStyle(.tt.textTertiary)
                Spacer(minLength: 0)
            }
            Text(item.content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                 ? L10n.MemoAppHome.emptyMemoTitle
                 : item.content)
                .font(.tt.body)
                .foregroundStyle(.tt.textPrimary)
                .lineLimit(5)
                .frame(maxWidth: .infinity, alignment: .leading)
            if !item.tags.isEmpty {
                MemoTagFlow(spacing: TTSpacing.xs, rowSpacing: TTSpacing.xs) {
                    ForEach(item.tags.prefix(4), id: \.self) { tag in
                        MemoTagChip(tag: tag, horizontalPadding: TTSpacing.xs, verticalPadding: 3)
                    }
                }
            }
        }
        .padding(TTSpacing.md)
        .background(.tt.bgSubtle, in: RoundedRectangle(cornerRadius: TTRadius.sm))
        .overlay(RoundedRectangle(cornerRadius: TTRadius.sm).strokeBorder(.tt.borderLight, lineWidth: 0.5))
        .accessibilityElement(children: .combine)
    }
}
