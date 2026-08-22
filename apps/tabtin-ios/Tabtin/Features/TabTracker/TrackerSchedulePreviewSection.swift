import SwiftUI

/// 自动化列表顶部的「接下来」：未来几天要跑什么，按天分组。
///
/// 这是桌面端月历 / 周历在手机上的等价物。手机上用户问的是「等下、今晚、明早有什么
/// 要跑」，不是「这个月的全貌」——所以不搬日历，搬结论：一列按天分好的清单。
///
/// 没有排期时整块不出现：一个空的「接下来」比不显示更占地方，也更让人以为出了错。
struct TrackerSchedulePreviewSection: View {
    let occurrences: [TrackerScheduleOccurrence]
    let truncated: Bool
    let isLoading: Bool
    let onSelect: (TrackerScheduleOccurrence) -> Void

    private var days: [TrackerSchedulePreviewPolicy.Day] {
        TrackerSchedulePreviewPolicy.days(from: occurrences)
    }

    var body: some View {
        if !days.isEmpty {
            VStack(alignment: .leading, spacing: TTSpacing.sm) {
                header

                VStack(alignment: .leading, spacing: TTSpacing.md) {
                    ForEach(days) { day in
                        dayBlock(day)
                    }
                }

                if truncated {
                    // 服务端截断了就如实说：静默展示一半会让用户以为这就是全部排期。
                    Text(L10n.Automation.upcomingTruncated)
                        .font(.tt.caption)
                        .foregroundStyle(.tt.textTertiary)
                }
            }
            .padding(TTSpacing.md)
            .background(
                RoundedRectangle(cornerRadius: TTRadius.md, style: .continuous)
                    .fill(.tt.bgSubtle)
            )
            .padding(.horizontal, TTSpacing.lg)
            .padding(.bottom, TTSpacing.sm)
        }
    }

    private var header: some View {
        HStack(spacing: TTSpacing.xs) {
            Image(systemName: "calendar")
                .font(.tt.iconCaption)
                .foregroundStyle(.tt.iconSecondary)
            Text(L10n.Automation.upcomingTitle)
                .font(.tt.bodySemibold)
                .foregroundStyle(.tt.textPrimary)
            Spacer(minLength: TTSpacing.sm)
            if isLoading {
                ProgressView().controlSize(.mini)
            }
        }
    }

    private func dayBlock(_ day: TrackerSchedulePreviewPolicy.Day) -> some View {
        VStack(alignment: .leading, spacing: TTSpacing.xs) {
            Text(TrackerSchedulePreviewPolicy.dayTitle(for: day.date))
                .font(.tt.captionSemibold)
                .foregroundStyle(.tt.textSecondary)

            ForEach(day.occurrences) { occurrence in
                Button {
                    onSelect(occurrence)
                } label: {
                    HStack(alignment: .firstTextBaseline, spacing: TTSpacing.sm) {
                        Text(TrackerSchedulePreviewPolicy.timeLabel(for: occurrence) ?? "--:--")
                            .font(.tt.metaMedium)
                            .foregroundStyle(.tt.textSecondary)
                            .monospacedDigit()
                            // 时刻列对齐，名字才不会参差；宽度跟随 Dynamic Type。
                            .frame(minWidth: 44, alignment: .leading)

                        Text(occurrence.name)
                            .font(.tt.body)
                            .foregroundStyle(.tt.textPrimary)
                            .lineLimit(1)

                        Spacer(minLength: 0)
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }

            if day.hiddenCount > 0 {
                Text(String(format: L10n.Automation.upcomingMoreInDay, day.hiddenCount))
                    .font(.tt.caption)
                    .foregroundStyle(.tt.textTertiary)
            }
        }
    }
}
