import SwiftUI

struct MemoHeatmapView: View {
    let buckets: [MemoHeatmapBucket]
    let monthCount: Int
    let selectedDayKey: String?
    let onSelectDay: (String?) -> Void

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.colorScheme) private var colorScheme

    private let columns = 12
    private let rows = 7

    var body: some View {
        VStack(alignment: .leading, spacing: TTSpacing.sm) {
            HStack(alignment: .firstTextBaseline) {
                Text(L10n.MemoAppHome.monthCount(monthCount))
                    .font(.tt.captionSemibold)
                    .foregroundStyle(.tt.textPrimary)
                Spacer(minLength: 0)
                if selectedDayKey != nil {
                    Button(L10n.MemoAppHome.clearDayFilter) {
                        onSelectDay(nil)
                    }
                    .font(.tt.captionMedium)
                    .foregroundStyle(.tt.textSecondary)
                    .accessibilityLabel(L10n.MemoAppHome.clearDayFilter)
                }
            }

            let cells = heatmapCells
            let maxCount = max(cells.map(\.count).max() ?? 0, 1)

            LazyVGrid(
                columns: Array(repeating: GridItem(.flexible(minimum: 8), spacing: 3), count: columns),
                spacing: 3
            ) {
                ForEach(cells) { cell in
                    Button {
                        guard cell.count > 0 else { return }
                        onSelectDay(selectedDayKey == cell.date ? nil : cell.date)
                    } label: {
                        RoundedRectangle(cornerRadius: 3, style: .continuous)
                            .fill(fill(for: cell.count, maxCount: maxCount, selected: selectedDayKey == cell.date))
                            .frame(minWidth: 8, minHeight: 8)
                            .aspectRatio(1, contentMode: .fit)
                    }
                    .buttonStyle(.plain)
                    .disabled(cell.count == 0)
                    .accessibilityLabel(cellAccessibility(cell))
                    .accessibilityAddTraits(selectedDayKey == cell.date ? .isSelected : [])
                }
            }
            .accessibilityElement(children: .contain)
            .animation(reduceMotion ? nil : .easeInOut(duration: 0.15), value: selectedDayKey)
        }
        .padding(TTSpacing.md)
        .background(.tt.bgSubtle, in: RoundedRectangle(cornerRadius: TTRadius.md))
    }

    private struct HeatCell: Identifiable {
        let date: String
        let count: Int
        var id: String { date }
    }

    private var heatmapCells: [HeatCell] {
        let map = Dictionary(uniqueKeysWithValues: buckets.map { ($0.date, $0.count) })
        let calendar = Calendar.current
        let today = calendar.startOfDay(for: Date())
        let total = columns * rows
        guard let start = calendar.date(byAdding: .day, value: -(total - 1), to: today) else {
            return buckets.map { HeatCell(date: $0.date, count: $0.count) }
        }
        var cells: [HeatCell] = []
        cells.reserveCapacity(total)
        let formatter = DateFormatter()
        formatter.calendar = calendar
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "yyyy-MM-dd"
        for offset in 0..<total {
            guard let day = calendar.date(byAdding: .day, value: offset, to: start) else { continue }
            let key = formatter.string(from: day)
            cells.append(HeatCell(date: key, count: map[key] ?? 0))
        }
        return cells
    }

    private func fill(for count: Int, maxCount: Int, selected: Bool) -> Color {
        if selected {
            return Color(red: 0.90, green: 0.33, blue: 0.44)
        }
        if count <= 0 {
            return colorScheme == .dark
                ? Color.white.opacity(0.06)
                : Color.black.opacity(0.05)
        }
        let ratio = min(1, Double(count) / Double(maxCount))
        let opacity = 0.22 + ratio * 0.70
        return Color(red: 0.90, green: 0.33, blue: 0.44).opacity(opacity)
    }

    private func cellAccessibility(_ cell: HeatCell) -> String {
        if cell.count == 0 {
            return L10n.MemoAppHome.heatmapEmptyDay(cell.date)
        }
        return L10n.MemoAppHome.heatmapDay(cell.date, cell.count)
    }
}
