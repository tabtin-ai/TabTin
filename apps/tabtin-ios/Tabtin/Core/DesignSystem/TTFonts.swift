import SwiftUI
import UIKit

public extension Font {
    static let tt = TTFonts()
}

/// TabTin 排版系统 —— **视觉语义对齐 Electron** `design-system.md` §2。
///
/// 正典文档：`apps/tabtin-ios/docs/design-system.md`
/// 对话阅读层（15pt / 1.7）见 `ConversationTypography`。
///
/// 只用 `caption` / `meta` / `body` / `subtitle` / `title` / `heading` / `display`
/// 及其 Medium / Semibold 变体，以及 `icon*` / `iconEmpty*` 图标档。
public struct TTFonts: Sendable {

    // MARK: - Roles（与 Electron text-* 一一对应）

    public enum Role: String, Sendable, CaseIterable {
        case caption
        case meta
        case body
        case subtitle
        case title
        case heading
        case display

        public var size: CGFloat {
            switch self {
            case .caption: return 12
            case .meta: return 13
            case .body: return 14
            case .subtitle: return 16
            case .title: return 20
            case .heading: return 24
            case .display: return 32
            }
        }

        /// 目标行高（pt），对齐 Electron leading。
        public var lineHeight: CGFloat {
            switch self {
            case .caption: return 18
            case .meta: return 18
            case .body: return 22
            case .subtitle: return 24
            case .title: return 28
            case .heading: return 32
            case .display: return 40
            }
        }
    }

    /// 空态 / 装饰大图标档（不算正文字号；消除 28/34/40/48 散点）。
    public enum DecorativeIcon: CGFloat, Sendable, CaseIterable {
        /// 内容区中等符号（原 20–24）
        case feature = 22
        /// 卡片内 / 紧凑空态（原 26–30）
        case empty = 28
        /// 列表空态（原 32–36）
        case emptyMD = 34
        /// 页面空态（原 40–42）
        case emptyLG = 40
        /// 全页 / Login 主符号（原 48–52）
        case hero = 48
        /// 强制更新等全屏强调（原 64）
        case splash = 64

        public var size: CGFloat { rawValue }
    }

    // MARK: - Canonical fonts（Electron §2）

    /// 12 / 18 — 时间戳、角标、极次要元数据
    public let caption = Self.font(role: .caption, weight: .regular)
    public let captionMedium = Self.font(role: .caption, weight: .medium)
    public let captionSemibold = Self.font(role: .caption, weight: .semibold)

    /// 13 / 18 — Composer meta、身份牌等（Electron `COMPOSER_TEXT_META`）
    public let meta = Self.font(role: .meta, weight: .regular)
    public let metaMedium = Self.font(role: .meta, weight: .medium)
    public let metaSemibold = Self.font(role: .meta, weight: .semibold)

    /// 14 / 22 — 默认正文、导航、按钮、表单
    public let body = Self.font(role: .body, weight: .regular)
    public let bodyMedium = Self.font(role: .body, weight: .medium)
    public let bodySemibold = Self.font(role: .body, weight: .semibold)

    /// 16 / 24 — 分组 / Sheet 标题
    public let subtitle = Self.font(role: .subtitle, weight: .regular)
    public let subtitleMedium = Self.font(role: .subtitle, weight: .medium)
    public let subtitleSemibold = Self.font(role: .subtitle, weight: .semibold)

    /// 20 / 28 — 页面标题
    public let title = Self.font(role: .title, weight: .regular)
    public let titleMedium = Self.font(role: .title, weight: .medium)
    public let titleSemibold = Self.font(role: .title, weight: .semibold)

    /// 24 / 32 — 大标题
    public let heading = Self.font(role: .heading, weight: .regular)
    public let headingMedium = Self.font(role: .heading, weight: .medium)
    public let headingSemibold = Self.font(role: .heading, weight: .semibold)

    /// 32 / 40 — 展示文字（极少用）
    public let display = Self.font(role: .display, weight: .regular)
    public let displayMedium = Self.font(role: .display, weight: .medium)
    public let displaySemibold = Self.font(role: .display, weight: .semibold)

    // MARK: - Code

    public let codeXS = Font.system(size: 10, design: .monospaced)
    public let codeXSSemibold = Font.system(size: 10, weight: .semibold, design: .monospaced)
    public let codeSM = Font.system(size: 12, design: .monospaced)
    public let codeSMSemibold = Font.system(size: 12, weight: .semibold, design: .monospaced)
    public let codeBody = Font.system(size: Role.body.size, design: .monospaced)

    // MARK: - UI icons（= 同角色文字点数）

    public let iconCaption = Self.font(role: .caption, weight: .semibold)
    public let iconCaptionMedium = Self.font(role: .caption, weight: .medium)
    public let iconBody = Self.font(role: .body, weight: .semibold)
    public let iconBodyMedium = Self.font(role: .body, weight: .medium)
    public let iconSubtitle = Self.font(role: .subtitle, weight: .semibold)
    public let iconSubtitleMedium = Self.font(role: .subtitle, weight: .medium)

    // MARK: - Decorative / empty-state icons

    public let iconFeature = Self.decorative(.feature, weight: .regular)
    public let iconFeatureMedium = Self.decorative(.feature, weight: .medium)
    public let iconFeatureSemibold = Self.decorative(.feature, weight: .semibold)

    public let iconEmpty = Self.decorative(.empty, weight: .regular)
    public let iconEmptyMedium = Self.decorative(.empty, weight: .medium)
    public let iconEmptySemibold = Self.decorative(.empty, weight: .semibold)

    public let iconEmptyMD = Self.decorative(.emptyMD, weight: .regular)
    public let iconEmptyMDMedium = Self.decorative(.emptyMD, weight: .medium)
    public let iconEmptyMDSemibold = Self.decorative(.emptyMD, weight: .semibold)

    public let iconEmptyLG = Self.decorative(.emptyLG, weight: .regular)

    public let iconEmptyHero = Self.decorative(.hero, weight: .regular)
    public let iconEmptyHeroLight = Self.decorative(.hero, weight: .light)

    public let iconEmptySplash = Self.decorative(.splash, weight: .regular)

    // MARK: - Line spacing helpers

    public static func lineSpacing(for role: Role, weight: UIFont.Weight = .regular) -> CGFloat {
        let font = UIFont.systemFont(ofSize: role.size, weight: weight)
        return max(0, role.lineHeight - font.lineHeight)
    }

    public static func uiFont(role: Role, weight: UIFont.Weight = .regular) -> UIFont {
        UIFont.systemFont(ofSize: role.size, weight: weight)
    }

    // MARK: - Private

    private static func font(role: Role, weight: Font.Weight) -> Font {
        .system(size: role.size, weight: weight)
    }

    private static func decorative(_ icon: DecorativeIcon, weight: Font.Weight) -> Font {
        .system(size: icon.size, weight: weight)
    }
}

public extension Font.TextStyle {
    static let ttStyle = TTTextStyles()
}

/// Dynamic Type 锚点：语义角色的默认点数以 `TTFonts.Role` 为准。
public struct TTTextStyles: Sendable {
    public let caption = Font.TextStyle.caption2
    public let meta = Font.TextStyle.footnote
    public let body = Font.TextStyle.subheadline
    public let subtitle = Font.TextStyle.callout
    public let title = Font.TextStyle.title3
    public let heading = Font.TextStyle.title2
    public let display = Font.TextStyle.largeTitle
}
