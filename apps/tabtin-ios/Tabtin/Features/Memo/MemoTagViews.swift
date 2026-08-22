import SwiftUI

struct MemoTagFlow<Content: View>: View {
    let spacing: CGFloat
    let rowSpacing: CGFloat
    let content: Content

    init(
        spacing: CGFloat,
        rowSpacing: CGFloat,
        @ViewBuilder content: () -> Content
    ) {
        self.spacing = spacing
        self.rowSpacing = rowSpacing
        self.content = content()
    }

    var body: some View {
        FlowLayout(spacing: spacing, rowSpacing: rowSpacing) {
            content
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private struct FlowLayout: Layout {
        let spacing: CGFloat
        let rowSpacing: CGFloat

        func sizeThatFits(
            proposal: ProposedViewSize,
            subviews: Subviews,
            cache: inout ()
        ) -> CGSize {
            let maxWidth = proposal.width ?? .greatestFiniteMagnitude
            var currentRowWidth: CGFloat = 0
            var currentRowHeight: CGFloat = 0
            var totalWidth: CGFloat = 0
            var totalHeight: CGFloat = 0

            for subview in subviews {
                let size = subview.sizeThatFits(.unspecified)
                let itemWidth = min(size.width, maxWidth)
                let additionalWidth = currentRowWidth == 0 ? itemWidth : spacing + itemWidth

                if currentRowWidth > 0, currentRowWidth + additionalWidth > maxWidth {
                    totalWidth = max(totalWidth, currentRowWidth)
                    totalHeight += currentRowHeight + rowSpacing
                    currentRowWidth = itemWidth
                    currentRowHeight = size.height
                } else {
                    currentRowWidth += additionalWidth
                    currentRowHeight = max(currentRowHeight, size.height)
                }
            }

            totalWidth = max(totalWidth, currentRowWidth)
            totalHeight += currentRowHeight
            return CGSize(width: min(totalWidth, maxWidth), height: totalHeight)
        }

        func placeSubviews(
            in bounds: CGRect,
            proposal: ProposedViewSize,
            subviews: Subviews,
            cache: inout ()
        ) {
            var x = bounds.minX
            var y = bounds.minY
            var rowHeight: CGFloat = 0

            for subview in subviews {
                let size = subview.sizeThatFits(.unspecified)
                let itemWidth = min(size.width, bounds.width)

                if x > bounds.minX, x + itemWidth > bounds.maxX {
                    x = bounds.minX
                    y += rowHeight + rowSpacing
                    rowHeight = 0
                }

                subview.place(
                    at: CGPoint(x: x, y: y),
                    proposal: ProposedViewSize(width: itemWidth, height: size.height)
                )
                x += itemWidth + spacing
                rowHeight = max(rowHeight, size.height)
            }
        }
    }
}

struct MemoTagChip: View {
    let tag: String
    var horizontalPadding: CGFloat = TTSpacing.sm
    var verticalPadding: CGFloat = 5
    var background: Color = .tt.bgSubtle
    var isSelected: Bool = false

    var body: some View {
        Text("#\(tag)")
            .font(.tt.captionMedium)
            .foregroundStyle(isSelected ? .tt.textOnAccent : .tt.textSecondary)
            .lineLimit(1)
            .truncationMode(.tail)
            .padding(.horizontal, horizontalPadding)
            .padding(.vertical, verticalPadding)
            .background(isSelected ? Color.tt.bgAccent : background, in: Capsule())
    }
}

/// 兼容旧名（PlaceholderTabs / CloudMemoDetailScreen 迁移期）。
typealias CloudTagFlow = MemoTagFlow
typealias CloudTagChip = MemoTagChip
