import SwiftUI

/// 加载失败 + 重试的统一错误态。
///
/// **为什么要收成一个组件**：这个「重试」按钮通常是用户唯一的恢复出口，各屏手抄一份的结果是
/// 偏差都落在看不见的地方——11 处里 8 处漏了 44pt 最小触达尺寸（点不准就等于没有降级路径），
/// 2 处硬编码中文「重试」（英文环境漏出中文）。视觉差异反倒是次要的。
///
/// **有意保留的两个维度**，其余一律收敛：
///  - [Prominence]：全屏错误态（tab 根视图、列表页）和内嵌区域错误态（sheet、App Home
///    内容区）的字号 / 图标分量本来就该不同，硬拉成一套是视觉退步；
///  - [Palette]：App Home 有自己一套按 App 类型换 accent 的独立色板（`AppHomePalette`），
///    不走全局 `.tt` token，强行统一会破坏它的主题。
///
/// **外层布局不由组件决定**：`.frame(maxHeight:)` / `padding` / 是否包在 `ScrollView` 里
/// 各调用点诉求不同（有的要撑满、有的在 List 里、有的要保住下拉刷新），组件只管内容块。
struct TTErrorStateView: View {

    /// 视觉分量。
    enum Prominence {
        /// 全屏错误态：大图标 + 正文字号。
        case screen
        /// 内嵌区域错误态：小图标 + 次级字号。
        case inline
    }

    /// 配色注入。默认走全局 `.tt` token；自带独立色板的场景（App Home）传自己的。
    struct Palette {
        var icon: Color
        var text: Color
        var accent: Color

        static let standard = Palette(
            icon: Color.tt.textCritical,
            text: Color.tt.textTertiary,
            accent: Color.tt.bgAccent
        )

        /// 文案自己用警示色。给 `systemImage: nil` 的场景——没有图标承载「这是错误」
        /// 的信号时，正文再用弱化灰，整块就退化成一段普通说明文字了。
        static let critical = Palette(
            icon: Color.tt.textCritical,
            text: Color.tt.textCritical,
            accent: Color.tt.bgAccent
        )
    }

    let message: String
    /// 失败标题。多数错误态只有一句 message，标题留 nil。
    var title: String?
    /// 图标。传 nil 去掉图标——List 内嵌的错误行加图标会过重。
    var systemImage: String? = "exclamationmark.triangle"
    var prominence: Prominence = .screen
    var palette: Palette = .standard
    let onRetry: () -> Void

    var body: some View {
        VStack(spacing: spacing) {
            if let systemImage {
                Image(systemName: systemImage)
                    .font(iconFont)
                    .foregroundStyle(palette.icon)
            }
            if let title {
                Text(title)
                    .font(titleFont)
                    .foregroundStyle(Color.tt.textPrimary)
                    .multilineTextAlignment(.center)
            }
            Text(message)
                .font(messageFont)
                .foregroundStyle(palette.text)
                .multilineTextAlignment(.center)
            Button(L10n.Common.retry, action: onRetry)
                .buttonStyle(.borderedProminent)
                .tint(palette.accent)
                // HIG 最小触达尺寸。这是唯一恢复出口，点不准就等于没有降级路径。
                .frame(minWidth: 44, minHeight: 44)
        }
    }

    private var spacing: CGFloat {
        switch prominence {
        case .screen: TTSpacing.lg
        case .inline: TTSpacing.md
        }
    }

    private var iconFont: Font {
        switch prominence {
        case .screen: .tt.iconEmptyLG
        case .inline: .tt.iconEmptyMD
        }
    }

    private var messageFont: Font {
        switch prominence {
        case .screen: .tt.body
        case .inline: .tt.meta
        }
    }

    private var titleFont: Font {
        switch prominence {
        case .screen: .tt.subtitleSemibold
        case .inline: .tt.bodySemibold
        }
    }
}

#if DEBUG
#Preview("错误态 · 全屏") {
    TTErrorStateView(message: "加载失败，请检查网络后重试。") {}
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding(.horizontal, TTSpacing.xl)
}

#Preview("错误态 · 内嵌") {
    TTErrorStateView(message: "加载失败，请检查网络后重试。", prominence: .inline) {}
        .padding(TTSpacing.lg)
}
#endif
