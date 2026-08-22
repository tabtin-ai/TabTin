import SwiftUI

// MARK: - 状态条

/// 会话顶部 / Composer 内状态条（连接 / 旁观 / 系统通知 / 错误统一视觉）。
/// 对齐旧 iOS ConnectionStatusBar：图标 + 文案 + 可选转圈，按语义着色。
struct StatusBanner: View {
    enum Style {
        case warning, critical, accent

        var foreground: Color {
            switch self {
            case .warning: return .tt.textWarning
            case .critical: return .tt.textCritical
            case .accent: return .tt.textAccent
            }
        }
        var background: Color {
            switch self {
            case .warning: return .tt.bgWarning.opacity(0.12)
            case .critical: return .tt.bgCritical.opacity(0.12)
            case .accent: return .tt.bgAccent.opacity(0.12)
            }
        }
    }

    enum Placement {
        case edgeToEdge
        case insetRounded(maxWidth: CGFloat = 680)
    }

    let style: Style
    let icon: String
    let text: String
    var showsProgress: Bool = false
    var placement: Placement = .edgeToEdge

    var body: some View {
        let content = HStack(spacing: TTSpacing.xs) {
            if showsProgress {
                ProgressView().controlSize(.mini)
            } else {
                Image(systemName: icon).font(.tt.iconCaptionMedium)
            }
            Text(text).font(.tt.captionMedium)
            Spacer(minLength: 0)
        }
        .foregroundStyle(style.foreground)
        .padding(.vertical, TTSpacing.xs + 2)
        .padding(.horizontal, TTSpacing.md)
        .background(style.background)
        .clipShape(RoundedRectangle(cornerRadius: TTRadius.sm, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: TTRadius.sm, style: .continuous)
                .strokeBorder(style.foreground.opacity(0.18), lineWidth: 0.5)
        )

        switch placement {
        case .edgeToEdge:
            content
                .frame(maxWidth: .infinity, alignment: .leading)
                .transition(.move(edge: .top).combined(with: .opacity))
        case let .insetRounded(maxWidth):
            content
                .frame(maxWidth: maxWidth)
                .frame(maxWidth: .infinity)
                .padding(.horizontal, TTSpacing.lg)
                .padding(.vertical, TTSpacing.xxs)
                .transition(.move(edge: .top).combined(with: .opacity))
        }
    }
}
