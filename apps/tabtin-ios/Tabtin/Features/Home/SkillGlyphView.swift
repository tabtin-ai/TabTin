import SwiftUI

/// 能力市场矢量头图：技能 = Lucide BookText，连接器 = Lucide Plug（对齐 Electron）。
/// 入口集合语义仍用 LucideBlocks；列表项禁止 emoji。
struct SkillGlyphView: View {
    var size: CGFloat = 30
    var cornerRadius: CGFloat = TTRadius.xs

    private var glyphSize: CGFloat { max(12, size * 0.55) }

    var body: some View {
        CapabilityGlyphView(kind: .skill, size: size, cornerRadius: cornerRadius)
    }
}

enum CapabilityGlyphKind {
    case skill
    case connector

    var assetName: String {
        switch self {
        case .skill: return "LucideBookText"
        case .connector: return "LucidePlug"
        }
    }
}

struct CapabilityGlyphView: View {
    var kind: CapabilityGlyphKind
    var size: CGFloat = 30
    var cornerRadius: CGFloat = TTRadius.xs

    private var glyphSize: CGFloat { max(12, size * 0.55) }

    var body: some View {
        Image(kind.assetName)
            .renderingMode(.template)
            .resizable()
            .scaledToFit()
            .frame(width: glyphSize, height: glyphSize)
            .foregroundStyle(.tt.iconAccent)
            .frame(width: size, height: size)
            .background(Color.tt.bgSubtle, in: RoundedRectangle(cornerRadius: cornerRadius))
            .accessibilityHidden(true)
    }
}
