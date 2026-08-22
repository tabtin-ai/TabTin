import SwiftUI
import UIKit
@preconcurrency import Highlightr
@preconcurrency import MarkdownUI

/// 会话 Markdown 代码块：暖灰底等宽 + 顶栏语言标签 + 复制按钮 + 语法高亮 + 长代码折叠。
/// 高亮结果按主题/语言/内容缓存，避免历史消息和流式刷新反复跑 Highlightr。
private struct ChatCodeBlock: View {
    let language: String?
    let content: String
    @Environment(\.colorScheme) private var colorScheme
    @State private var copied = false
    @State private var isExpanded = false
    @State private var copyResetTask: Task<Void, Never>?

    private var languageLabel: String {
        let lang = (language ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        return lang.isEmpty ? "代码" : lang
    }

    private static let collapseThreshold = 50
    private static let collapsedPreviewLines = 20

    private var trimmedContent: String {
        var value = content
        while value.last == "\n" { value.removeLast() }
        return value
    }

    private var lines: [String] {
        trimmedContent.components(separatedBy: "\n")
    }

    private var canCollapse: Bool { lines.count > Self.collapseThreshold }

    private var displayContent: String {
        if !canCollapse || isExpanded { return trimmedContent }
        return lines.prefix(Self.collapsedPreviewLines).joined(separator: "\n")
    }

    private var hiddenLineCount: Int {
        max(0, lines.count - Self.collapsedPreviewLines)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: TTSpacing.xs) {
                Text(languageLabel)
                    .font(.tt.codeXS)
                    .foregroundStyle(.tt.textTertiary)
                Spacer(minLength: 0)
                Button {
                    copyCode()
                } label: {
                    Label(copied ? "已复制" : "复制", systemImage: copied ? "checkmark" : "doc.on.doc")
                        .font(.tt.captionMedium)
                        .foregroundStyle(copied ? .tt.textSuccess : .tt.textSecondary)
                }
                .buttonStyle(.plain)
            }
            .padding(.horizontal, TTSpacing.md)
            .padding(.vertical, TTSpacing.xs)

            Divider().overlay(.tt.borderLight)

            ScrollView(.horizontal, showsIndicators: false) {
                Text(highlightedContent)
                    .textSelection(.enabled)
                    .padding(TTSpacing.md)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }

            if canCollapse {
                Button {
                    withAnimation(.easeInOut(duration: 0.18)) {
                        isExpanded.toggle()
                    }
                } label: {
                    HStack(spacing: TTSpacing.xs) {
                        Image(systemName: isExpanded ? "chevron.up" : "chevron.down")
                            .font(.tt.iconCaption)
                        Text(isExpanded ? "收起" : "展开剩余 \(hiddenLineCount) 行")
                            .font(.tt.captionMedium)
                    }
                    .foregroundStyle(.tt.textSecondary)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, TTSpacing.xs)
                    .background(.tt.bgCanvasDefault.opacity(0.55))
                }
                .buttonStyle(.plain)
            }
        }
        .background(.tt.bgSubtle, in: RoundedRectangle(cornerRadius: TTRadius.sm))
        .overlay(
            RoundedRectangle(cornerRadius: TTRadius.sm)
                .strokeBorder(.tt.borderLight, lineWidth: 0.5)
        )
    }

    private var highlightedContent: AttributedString {
        Self.cachedHighlight(code: displayContent, language: language, colorScheme: colorScheme)
    }

    private func copyCode() {
        UIPasteboard.general.string = trimmedContent
        UISelectionFeedbackGenerator().selectionChanged()
        UIAccessibility.post(notification: .announcement, argument: "已复制")

        copyResetTask?.cancel()
        withAnimation(.easeInOut(duration: 0.15)) {
            copied = true
        }
        copyResetTask = Task { @MainActor in
            try? await Task.sleep(for: .milliseconds(1500))
            guard !Task.isCancelled else { return }
            withAnimation(.easeInOut(duration: 0.15)) {
                copied = false
            }
        }
    }

    private static let highlightedCache: NSCache<NSString, NSAttributedString> = {
        let cache = NSCache<NSString, NSAttributedString>()
        cache.countLimit = 80
        return cache
    }()

    private static func cachedHighlight(
        code: String,
        language: String?,
        colorScheme: ColorScheme
    ) -> AttributedString {
        let schemeKey = colorScheme == .dark ? "dark" : "light"
        let key = "\(schemeKey)|\(language ?? "")|\(code.count)|\(code.hashValue)" as NSString
        if let cached = highlightedCache.object(forKey: key) {
            return AttributedString(cached)
        }

        let baseFont = UIFont.monospacedSystemFont(ofSize: TTFonts.Role.caption.size, weight: .regular)
        if let highlighter = sharedHighlightr(for: colorScheme),
           let highlighted = highlighter.highlight(code, as: supportedLanguage(language), fastRender: true) {
            let mutable = NSMutableAttributedString(attributedString: highlighted)
            mutable.enumerateAttribute(.font, in: NSRange(location: 0, length: mutable.length)) { _, range, _ in
                mutable.addAttribute(.font, value: baseFont, range: range)
            }
            highlightedCache.setObject(mutable.copy() as! NSAttributedString, forKey: key)
            return AttributedString(mutable)
        }

        var fallback = AttributedString(code)
        fallback.font = .tt.codeSM
        fallback.foregroundColor = .tt.textPrimary
        return fallback
    }

    private static let supportedLanguages: Set<String> = [
        "swift", "python", "py", "typescript", "ts", "javascript", "js", "jsx", "tsx",
        "json", "bash", "shell", "sh", "zsh", "sql", "go", "rust", "rs",
        "kotlin", "kt", "java", "c", "cpp", "c++", "objectivec", "objc",
        "ruby", "rb", "php", "yaml", "yml", "xml", "html", "css", "scss", "less",
        "markdown", "md", "diff", "dockerfile", "makefile", "ini", "toml",
        "csharp", "cs", "powershell", "ps1", "graphql", "hcl", "lua", "perl",
        "scala", "vue", "dart", "r"
    ]

    private static func supportedLanguage(_ language: String?) -> String? {
        guard let language, !language.isEmpty else { return nil }
        let normalized = language.lowercased()
        let mapped: String = {
            switch normalized {
            case "py": return "python"
            case "ts": return "typescript"
            case "js": return "javascript"
            case "sh", "zsh": return "bash"
            case "rs": return "rust"
            case "kt": return "kotlin"
            case "rb": return "ruby"
            case "yml": return "yaml"
            case "md": return "markdown"
            case "objc": return "objectivec"
            case "c++": return "cpp"
            case "cs": return "csharp"
            case "ps1": return "powershell"
            default: return normalized
            }
        }()
        return supportedLanguages.contains(normalized) ? mapped : nil
    }

    private static var darkHighlightr: Highlightr? = makeHighlightr(theme: "atom-one-dark")
    private static var lightHighlightr: Highlightr? = makeHighlightr(theme: "atom-one-light")

    private static func makeHighlightr(theme: String) -> Highlightr? {
        guard let highlighter = Highlightr() else { return nil }
        _ = highlighter.setTheme(to: theme)
        return highlighter
    }

    private static func sharedHighlightr(for colorScheme: ColorScheme) -> Highlightr? {
        colorScheme == .dark ? darkHighlightr : lightHighlightr
    }

    static func prewarm() {
        let sample = "let message = \"TabTin\""
        _ = cachedHighlight(code: sample, language: "swift", colorScheme: .light)
        _ = cachedHighlight(code: sample, language: "swift", colorScheme: .dark)
    }
}

enum ChatMarkdownRendererWarmup {
    @MainActor
    static func prewarm() {
        ChatCodeBlock.prewarm()
    }
}

extension MarkdownUI.Theme {
    @MainActor
    static let tabtin = Theme()
        .text {
            ForegroundColor(.tt.textPrimary)
            FontWeight(.regular)
            FontSize(ConversationTypography.bodySize)
        }
        .code {
            FontFamilyVariant(.monospaced)
            FontSize(ConversationTypography.bodySize * 0.9)
            ForegroundColor(.tt.textAccent)
        }
        .strong {
            // 强调只改变字重，不参与字号层级；避免整段加粗看起来像隐式标题。
            FontWeight(.semibold)
            FontSize(ConversationTypography.bodySize)
        }
        .codeBlock { configuration in
            // mermaid 代码块升级为图渲染（对齐 Electron MermaidBlock）；
            // 渲染成功前与失败后都回退为普通代码块。
            Group {
                if configuration.language?.lowercased() == "mermaid" {
                    MermaidBlockView(code: configuration.content) {
                        ChatCodeBlock(
                            language: configuration.language,
                            content: configuration.content
                        )
                    }
                } else {
                    ChatCodeBlock(language: configuration.language, content: configuration.content)
                }
            }
            .markdownMargin(top: 8, bottom: 8)
        }
        .paragraph { configuration in
            // 段间距是阅读节奏的主要来源。实测 ChatGPT iOS：段间等效 margin
            // ≈ 1.2 倍字号（15pt → 18pt）、标题贴近下文（≈7pt）。
            // MarkdownUI 相邻块间距取 max，故用不对称 top 6 / bottom 18：
            // 段落间 = max(18, 6) = 18；标题(bottom 8) → 段落 = max(8, 6) = 8。
            configuration.label
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
                .relativeLineSpacing(.em(ConversationTypography.markdownParagraphLineSpacingEm))
                .markdownMargin(top: 6, bottom: 18)
        }
        .list { configuration in
            // 列表作为整块与段落同节奏：引导句贴近列表（top 6），
            // 列表结束到下一段落 18（实测 ChatGPT 同款）。
            configuration.label
                .fixedSize(horizontal: false, vertical: true)
                .markdownMargin(top: 6, bottom: 18)
        }
        .heading1 { configuration in
            configuration.label
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
                .markdownTextStyle {
                    FontWeight(.semibold)
                    FontSize(ConversationTypography.heading1Size)
                    ForegroundColor(.tt.textPrimary)
                }
                .markdownMargin(top: 16, bottom: 8)
        }
        .heading2 { configuration in
            configuration.label
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
                .markdownTextStyle {
                    FontWeight(.semibold)
                    FontSize(ConversationTypography.heading2Size)
                    ForegroundColor(.tt.textPrimary)
                }
                .markdownMargin(top: 12, bottom: 6)
        }
        .heading3 { configuration in
            configuration.label
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
                .markdownTextStyle {
                    FontWeight(.semibold)
                    FontSize(ConversationTypography.bodySize)
                    ForegroundColor(.tt.textPrimary)
                }
                .relativeLineSpacing(.em(ConversationTypography.markdownParagraphLineSpacingEm))
                .markdownMargin(top: 10, bottom: 4)
        }
        .listItem { configuration in
            configuration.label
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
                .relativeLineSpacing(.em(ConversationTypography.markdownParagraphLineSpacingEm))
                .markdownMargin(top: 5, bottom: 5)
        }
        .blockquote { configuration in
            // 阅读流里的引用不做强调装饰：中性细竖线 + 正文同色，
            // 靠缩进表达层级（对齐 ChatGPT 的引用观感，忌彩色线/降色文字）。
            HStack(spacing: 0) {
                RoundedRectangle(cornerRadius: 1)
                    .fill(.tt.borderLight)
                    .frame(width: 2)
                configuration.label
                    .markdownTextStyle { ForegroundColor(.tt.textPrimary) }
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.leading, TTSpacing.md)
            }
            .fixedSize(horizontal: false, vertical: true)
            .markdownMargin(top: 8, bottom: 8)
        }
        .table { configuration in
            ScrollView(.horizontal, showsIndicators: false) {
                configuration.label
                    .fixedSize(horizontal: true, vertical: false)
                    .markdownTableBorderStyle(.init(.horizontalBorders, color: .tt.borderLight, width: 0.5))
                    .markdownTableBackgroundStyle(
                        .alternatingRows(.tt.bgCanvasDefault, .tt.bgSubtle.opacity(0.42), header: .tt.bgSubtle)
                    )
                    .padding(0.5)
            }
            .background(.tt.bgCanvasDefault, in: RoundedRectangle(cornerRadius: TTRadius.sm))
            .overlay(
                RoundedRectangle(cornerRadius: TTRadius.sm)
                    .strokeBorder(.tt.borderLight, lineWidth: 0.5)
            )
            .clipShape(RoundedRectangle(cornerRadius: TTRadius.sm))
            .markdownMargin(top: 10, bottom: 10)
        }
        .tableCell { configuration in
            configuration.label
                .markdownTextStyle {
                    FontSize(ConversationTypography.bodySize * 0.88)
                    ForegroundColor(.tt.textPrimary)
                    BackgroundColor(nil)
                    if configuration.row == 0 {
                        FontWeight(.medium)
                    }
                }
                .fixedSize(horizontal: false, vertical: true)
                .frame(minWidth: 78, alignment: .leading)
                .padding(.horizontal, TTSpacing.sm)
                .padding(.vertical, TTSpacing.xs + 2)
                .relativeLineSpacing(.em(ConversationTypography.markdownParagraphLineSpacingEm))
        }
        .thematicBreak {
            Divider().markdownMargin(top: 12, bottom: 12)
        }

    /// 系统通知精简主题：文字偏小、次要色，去掉大块标题。
    @MainActor
    static let tabtinSystemNotice = Theme()
        .text {
            ForegroundColor(.tt.textSecondary)
            FontSize(.em(0.85))
        }
        .code {
            FontFamilyVariant(.monospaced)
            FontSize(.em(0.8))
            ForegroundColor(.tt.textSecondary)
        }
        .paragraph { configuration in
            configuration.label
                .fixedSize(horizontal: false, vertical: true)
                .relativeLineSpacing(.em(ConversationTypography.markdownParagraphLineSpacingEm))
                .markdownMargin(top: 6, bottom: 6)
        }
        .listItem { configuration in
            configuration.label
                .fixedSize(horizontal: false, vertical: true)
                .relativeLineSpacing(.em(ConversationTypography.markdownParagraphLineSpacingEm))
                .markdownMargin(top: 3, bottom: 3)
        }
        .blockquote { configuration in
            HStack(spacing: 0) {
                RoundedRectangle(cornerRadius: 1)
                    .fill(.tt.borderLight)
                    .frame(width: 2)
                configuration.label
                    .markdownTextStyle { ForegroundColor(.tt.textSecondary) }
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.leading, TTSpacing.xs)
            }
            .fixedSize(horizontal: false, vertical: true)
            .markdownMargin(top: 4, bottom: 4)
        }

    /// 思考展开内容与折叠条共用 `ConversationTypography` 阅读字号（默认 15pt）。
    /// MarkdownUI 相对字号无法继承外层 SwiftUI Font，故显式传点数；
    /// 标题 / strong 只改字重，不放大字号。
    @MainActor
    static func tabtinThinking(fontSize: CGFloat) -> MarkdownUI.Theme {
        MarkdownUI.Theme()
            .text {
                ForegroundColor(.tt.textSecondary)
                FontWeight(.regular)
                FontSize(fontSize)
            }
            .strong {
                FontWeight(.medium)
                FontSize(fontSize)
            }
            .code {
                FontFamilyVariant(.monospaced)
                FontSize(fontSize)
                ForegroundColor(.tt.textSecondary)
            }
            .paragraph { configuration in
                configuration.label
                    .fixedSize(horizontal: false, vertical: true)
                    .relativeLineSpacing(.em(ConversationTypography.markdownParagraphLineSpacingEm))
                    .markdownMargin(top: 12, bottom: 12)
            }
            .heading1 { configuration in
                thinkingHeading(configuration.label, fontSize: fontSize)
            }
            .heading2 { configuration in
                thinkingHeading(configuration.label, fontSize: fontSize)
            }
            .heading3 { configuration in
                thinkingHeading(configuration.label, fontSize: fontSize)
            }
            .heading4 { configuration in
                thinkingHeading(configuration.label, fontSize: fontSize)
            }
            .heading5 { configuration in
                thinkingHeading(configuration.label, fontSize: fontSize)
            }
            .heading6 { configuration in
                thinkingHeading(configuration.label, fontSize: fontSize)
            }
            .listItem { configuration in
                configuration.label
                    .fixedSize(horizontal: false, vertical: true)
                    .relativeLineSpacing(.em(ConversationTypography.markdownParagraphLineSpacingEm))
                    .markdownMargin(top: 3, bottom: 3)
            }
            .blockquote { configuration in
                HStack(spacing: 0) {
                    RoundedRectangle(cornerRadius: 1)
                        .fill(.tt.borderLight)
                        .frame(width: 2)
                    configuration.label
                        .markdownTextStyle { ForegroundColor(.tt.textSecondary) }
                        .fixedSize(horizontal: false, vertical: true)
                        .padding(.leading, TTSpacing.xs)
                }
                .fixedSize(horizontal: false, vertical: true)
                .markdownMargin(top: 4, bottom: 4)
            }
    }

    @MainActor
    private static func thinkingHeading<Label: View>(
        _ label: Label,
        fontSize: CGFloat
    ) -> some View {
        label
            .fixedSize(horizontal: false, vertical: true)
            .markdownTextStyle {
                FontWeight(.medium)
                FontSize(fontSize)
                ForegroundColor(.tt.textSecondary)
            }
            .relativeLineSpacing(.em(ConversationTypography.markdownParagraphLineSpacingEm))
            .markdownMargin(top: 4, bottom: 2)
    }
}
