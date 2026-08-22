import SwiftUI

/// Shared audio level bar visualization used during voice recording.
struct AudioLevelVisualization: View {
    let levels: [CGFloat]
    var accessibilityText: String = ""

    var body: some View {
        HStack(spacing: 2) {
            ForEach(Array(levels.enumerated()), id: \.offset) { _, level in
                RoundedRectangle(cornerRadius: 1.5)
                    .fill(.tt.bgAccent.opacity(0.6))
                    .frame(width: 3, height: max(3, level * 40))
            }
        }
        .frame(height: 44)
        .animation(.easeInOut(duration: 0.1), value: levels)
        .accessibilityLabel(accessibilityText)
        .accessibilityAddTraits(.updatesFrequently)
    }
}
