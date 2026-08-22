import SwiftUI
import UIKit

/// 会话阅读排版，对齐 Electron `chatDesignTokens`：
/// `CHAT_MESSAGE_TEXT_*` / `CHAT_STEP_TEXT` / `COMPOSER_TEXT_*`。
///
/// App chrome（导航、列表、设置）走 `TTFonts` 的 14pt `body`；
/// **本类型只服务对话阅读面**，避免长文与控件密度抢同一档。
///
/// 正典：`apps/tabtin-ios/docs/design-system.md` §3。
enum ConversationTypography {
    /// 消息正文 / Markdown：15pt（Electron `CHAT_MESSAGE_TEXT_BODY_BASE`）。
    static let bodySize: CGFloat = 15

    /// 一级标题（Electron `CHAT_MARKDOWN_HEADING_1` / `text-title`）。
    static let heading1Size: CGFloat = 20

    /// 二级标题（Electron `CHAT_MARKDOWN_HEADING_2`）。
    static let heading2Size: CGFloat = 18

    /// 步骤行固定行高 22pt（Electron `CHAT_STEP_TEXT`）。
    static let stepLineHeight: CGFloat = 22

    /// Markdown / 纯文本目标行高倍数（Electron `leading-[1.7]`）。
    static let bodyLineHeightMultiple: CGFloat = 1.7

    static let bodyUIFont = UIFont.systemFont(ofSize: bodySize, weight: .regular)

    static var bodyFont: Font { Font(bodyUIFont) }
    static var stepFont: Font { bodyFont }

    /// SwiftUI `Text` 在默认行高之上追加的间距。
    static var bodyLineSpacing: CGFloat {
        spacing(toLineHeight: bodySize * bodyLineHeightMultiple, font: bodyUIFont)
    }

    static var stepLineSpacing: CGFloat {
        spacing(toLineHeight: stepLineHeight, font: bodyUIFont)
    }

    /// MarkdownUI 段落相对行距 em（在 `MarkdownTheme` 中转为 `RelativeSize.em`）。
    /// 约等于在引擎默认行高上补到 ~1.7。
    static let markdownParagraphLineSpacingEm: CGFloat = 0.38

    static var composerFont: Font { bodyFont }
    static var composerLineSpacing: CGFloat { stepLineSpacing }

    /// Agent 身份牌 / Composer meta：走 UI 字号体系的 `meta`（13pt）。
    static var metaFont: Font { .tt.meta }

    private static func spacing(toLineHeight target: CGFloat, font: UIFont) -> CGFloat {
        max(0, target - font.lineHeight)
    }
}
