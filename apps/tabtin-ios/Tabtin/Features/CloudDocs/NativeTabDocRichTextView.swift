import SwiftUI
import UIKit

extension NativeTabDocTextAlignment {
    var uiTextAlignment: NSTextAlignment {
        switch self {
        case .natural: .natural
        case .left: .left
        case .center: .center
        case .right: .right
        case .justify: .justified
        }
    }
}

enum NativeTabDocRichTextSynchronizationPolicy {
    static func shouldApplyIncoming(
        isApplyingChange: Bool,
        hasMarkedText: Bool,
        contentMatches: Bool
    ) -> Bool {
        !isApplyingChange && !hasMarkedText && !contentMatches
    }

    static func shouldPublishChange(
        isApplyingChange: Bool,
        hasMarkedText: Bool
    ) -> Bool {
        !isApplyingChange && !hasMarkedText
    }

    /// 真图 attachment 每次重建都是新实例，`isEqual` 会误判成内容变了并重置光标。
    static func attributedContentMatches(
        _ lhs: NSAttributedString,
        _ rhs: NSAttributedString
    ) -> Bool {
        if lhs.isEqual(to: rhs) { return true }
        guard lhs.string == rhs.string else { return false }
        return NativeTabDocRichTextMarkBridge.spans(from: lhs, baseStyle: .body)
            == NativeTabDocRichTextMarkBridge.spans(from: rhs, baseStyle: .body)
    }
}

enum NativeTabDocInputAccessoryLayout {
    static func bottomSafeAreaInset(
        accessoryMaxY: CGFloat,
        viewportMaxY: CGFloat,
        safeAreaBottom: CGFloat,
        tolerance: CGFloat = 1
    ) -> CGFloat {
        guard safeAreaBottom > 0,
              abs(accessoryMaxY - viewportMaxY) <= tolerance
        else { return 0 }
        return safeAreaBottom
    }
}

/// 表格网格是轻量 UILabel，不能整段复用 UITextView；有 marks 时必须自己画 attributedText。
enum NativeTabDocTableCellPreviewTypography {
    static func usesAttributedPreview(_ spans: [NativeTabDocInlineSpan]) -> Bool {
        spans.contains { !$0.marks.isEmpty || $0.mathematics != nil || $0.image != nil }
    }

    static func attributedString(
        spans: [NativeTabDocInlineSpan],
        style: NativeTabDocRichTextStyle,
        textAlignment: NativeTabDocTextAlignment,
        traitCollection: UITraitCollection
    ) -> NSAttributedString {
        // 表格格子是轻量预览，没有图片加载生命周期，行内图片继续走诚实 alt 占位。
        NativeTabDocRichTextMarkBridge.attributedString(
            spans: spans,
            style: style,
            textAlignment: textAlignment,
            traitCollection: traitCollection,
            inlineImageAttachment: nil,
            inlineFormulaAttachment: nil
        )
    }
}

enum NativeTabDocRichTextStyle: Equatable, Sendable {
    case body
    case bodySecondary
    case subtitle
    case title
    case heading
    case display
    case headingFour
    case headingFive
    case headingSix
    case code
    case tableHeader

    var font: UIFont {
        switch self {
        case .body, .bodySecondary:
            TTFonts.uiFont(role: .body)
        case .subtitle:
            TTFonts.uiFont(role: .subtitle, weight: .semibold)
        case .title:
            TTFonts.uiFont(role: .title, weight: .semibold)
        case .heading:
            TTFonts.uiFont(role: .heading, weight: .semibold)
        case .display:
            TTFonts.uiFont(role: .display, weight: .semibold)
        case .headingFour:
            TTFonts.uiFont(role: .body, weight: .semibold)
        case .headingFive:
            TTFonts.uiFont(role: .meta, weight: .semibold)
        case .headingSix:
            TTFonts.uiFont(role: .caption, weight: .semibold)
        case .code:
            UIFont.monospacedSystemFont(ofSize: TTFonts.Role.body.size, weight: .regular)
        case .tableHeader:
            TTFonts.uiFont(role: .body, weight: .medium)
        }
    }

    var textStyle: UIFont.TextStyle {
        switch self {
        case .body, .bodySecondary, .code, .tableHeader: .subheadline
        case .subtitle: .callout
        case .title: .title3
        case .heading: .title2
        case .display: .largeTitle
        case .headingFour: .subheadline
        case .headingFive: .footnote
        case .headingSix: .caption1
        }
    }

    var typographyRole: TTFonts.Role {
        switch self {
        case .body, .bodySecondary, .code, .tableHeader, .headingFour: .body
        case .headingFive: .meta
        case .headingSix: .caption
        case .subtitle: .subtitle
        case .title: .title
        case .heading: .heading
        case .display: .display
        }
    }

    var textColorRole: NativeTabDocRichTextColorRole {
        switch self {
        case .bodySecondary, .headingSix: .secondary
        default: .primary
        }
    }

    var textColor: UIColor { textColorRole.color }

    func scaledFont(traits: UIFontDescriptor.SymbolicTraits = []) -> UIFont {
        let descriptor = font.fontDescriptor.withSymbolicTraits(traits) ?? font.fontDescriptor
        return UIFontMetrics(forTextStyle: textStyle).scaledFont(
            for: UIFont(descriptor: descriptor, size: font.pointSize)
        )
    }

    func paragraphStyle(
        scaledFont: UIFont,
        textAlignment: NativeTabDocTextAlignment = .natural,
        traitCollection: UITraitCollection
    ) -> NSParagraphStyle {
        let scaledTargetLineHeight = UIFontMetrics(forTextStyle: textStyle).scaledValue(
            for: typographyRole.lineHeight,
            compatibleWith: traitCollection
        )
        let lineHeight = NativeTabDocRichTextLineHeightPolicy.resolvedLineHeight(
            scaledTargetLineHeight: scaledTargetLineHeight,
            scaledFontLineHeight: scaledFont.lineHeight
        )
        let paragraphStyle = NSMutableParagraphStyle()
        paragraphStyle.minimumLineHeight = lineHeight
        paragraphStyle.maximumLineHeight = lineHeight
        paragraphStyle.alignment = textAlignment.uiTextAlignment
        return paragraphStyle
    }
}

enum NativeTabDocRichTextColorRole: Equatable, Sendable {
    case primary
    case secondary

    var color: UIColor {
        switch self {
        case .primary: TTColors.textPrimaryUI
        case .secondary: TTColors.textSecondaryUI
        }
    }
}

enum NativeTabDocHeadingStylePolicy {
    static func style(for level: Int) -> NativeTabDocRichTextStyle {
        switch level {
        case 1: .heading
        case 2: .title
        case 3: .subtitle
        case 4: .headingFour
        case 5: .headingFive
        case 6: .headingSix
        default: .body
        }
    }
}

enum NativeTabDocRichTextSizingPolicy {
    static func height(fittedHeight: CGFloat, isEmpty: Bool) -> CGFloat {
        isEmpty ? max(fittedHeight, TTSpacing.Control.minimumTouchTarget) : fittedHeight
    }
}

enum NativeTabDocRichTextFocusPolicy {
    static func shouldResignFirstResponder(
        wasEditable: Bool,
        isEditable: Bool,
        isFirstResponder: Bool
    ) -> Bool {
        wasEditable && !isEditable && isFirstResponder
    }
}

struct NativeTabDocRichTextFocusRequest: Equatable, Sendable {
    let token: UUID
    let editorId: UUID
    let caretPosition: Int

    init(destination: NativeTabDocEditorFocusDestination) {
        token = UUID()
        editorId = destination.editorId
        caretPosition = destination.caretPosition
    }
}

enum NativeTabDocRichTextLineHeightPolicy {
    static func resolvedLineHeight(
        scaledTargetLineHeight: CGFloat,
        scaledFontLineHeight: CGFloat
    ) -> CGFloat {
        max(scaledTargetLineHeight, scaledFontLineHeight)
    }
}

/// UIKit 展示属性只是视图状态，不能反推 TabDoc 的颜色、上下标或不可点击链接语义。
/// 这里把需要保真回采的 mark 原始节点编码进私有属性，并作为编辑回采时的身份真源。
enum NativeTabDocRichTextMarkBridge {
    static let preservedMarksKey = NSAttributedString.Key(
        "com.tabtin.nativeTabDoc.preservedMarks.v1"
    )
    static let inlineMathematicsKey = NSAttributedString.Key(
        "com.tabtin.nativeTabDoc.inlineMathematics.v1"
    )
    static let inlineImageKey = NSAttributedString.Key(
        "com.tabtin.nativeTabDoc.inlineImage.v1"
    )

    static func attributes(
        for marks: [NativeTabDocInlineMark],
        mathematics: NativeTabDocInlineMathematics? = nil,
        image: NativeTabDocInlineImage? = nil,
        style: NativeTabDocRichTextStyle,
        textAlignment: NativeTabDocTextAlignment = .natural,
        traitCollection: UITraitCollection
    ) -> [NSAttributedString.Key: Any] {
        var symbolicTraits: UIFontDescriptor.SymbolicTraits = []
        var attributes: [NSAttributedString.Key: Any] = [
            .foregroundColor: style.textColor.resolvedColor(with: traitCollection),
        ]
        var usesCodeFont = style == .code
        var scriptKind: NativeTabDocInlineMarkKind?

        for mark in marks {
            switch mark.kind {
            case .bold:
                symbolicTraits.insert(.traitBold)
            case .italic:
                symbolicTraits.insert(.traitItalic)
            case .underline:
                attributes[.underlineStyle] = NSUnderlineStyle.single.rawValue
            case .strike:
                attributes[.strikethroughStyle] = NSUnderlineStyle.single.rawValue
            case .code:
                usesCodeFont = true
                attributes[.backgroundColor] = TTColors.bgSubtleUI.resolvedColor(
                    with: traitCollection
                )
            case .link:
                if let href = mark.linkHref,
                   let url = URL(string: href),
                   isSafeLink(url) {
                    attributes[.link] = url
                    attributes[.foregroundColor] = TTColors.bgAccentUI.resolvedColor(
                        with: traitCollection
                    )
                }
            case .textStyle:
                if let color = color(for: mark) {
                    attributes[.foregroundColor] = color
                }
            case .highlight:
                if let color = color(for: mark) {
                    attributes[.backgroundColor] = color
                }
            case .subscript, .superscript:
                scriptKind = mark.kind
            case .unknown:
                break
            }
        }

        let base = usesCodeFont
            ? UIFont.monospacedSystemFont(ofSize: style.font.pointSize, weight: .regular)
            : style.font
        let descriptor = base.fontDescriptor.withSymbolicTraits(symbolicTraits) ?? base.fontDescriptor
        let scaledFont = UIFontMetrics(forTextStyle: style.textStyle).scaledFont(
            for: UIFont(descriptor: descriptor, size: base.pointSize)
        )
        if let scriptKind {
            attributes[.font] = scaledFont.withSize(scaledFont.pointSize * 0.75)
            attributes[.baselineOffset] = scriptKind == .superscript
                ? scaledFont.pointSize * 0.3
                : -scaledFont.pointSize * 0.18
        } else {
            attributes[.font] = scaledFont
        }
        attributes[.paragraphStyle] = style.paragraphStyle(
            scaledFont: scaledFont,
            textAlignment: textAlignment,
            traitCollection: traitCollection
        )
        if let encoded = encodedPreservedMarks(from: marks) {
            attributes[preservedMarksKey] = encoded
        }
        if let image, let encoded = encodedInlineImage(image) {
            // 诚实占位：等宽字体让 alt 串在正文里可辨认，身份走私有属性回采。
            attributes[inlineImageKey] = encoded
            attributes[.font] = UIFontMetrics(forTextStyle: style.textStyle).scaledFont(
                for: UIFont.monospacedSystemFont(ofSize: style.font.pointSize, weight: .regular)
            )
        }
        if let mathematics, let encoded = encodedMathematics(mathematics) {
            attributes[inlineMathematicsKey] = encoded
            let mathFont = UIFont.monospacedSystemFont(ofSize: style.font.pointSize, weight: .regular)
            var mathTraits = mathFont.fontDescriptor.symbolicTraits
            mathTraits.insert(.traitItalic)
            let descriptor = mathFont.fontDescriptor.withSymbolicTraits(mathTraits) ?? mathFont.fontDescriptor
            attributes[.font] = UIFontMetrics(forTextStyle: style.textStyle).scaledFont(
                for: UIFont(descriptor: descriptor, size: mathFont.pointSize)
            )
        }
        return attributes
    }

    /// 行内图片被渲染成真图时，正文里只留一个附件字符；`inlineImageAttachment`
    /// 返回 nil 就退回诚实 alt 占位文本。图片身份始终走 `inlineImageKey` 私有属性，
    /// 与这里选了哪种呈现无关，所以写回保真不受呈现层影响。
    ///
    /// 行内公式同口径：KaTeX 图就绪才换成附件字符；否则继续显示可读 LaTeX 源码。
    static func attributedString(
        spans: [NativeTabDocInlineSpan],
        style: NativeTabDocRichTextStyle,
        textAlignment: NativeTabDocTextAlignment,
        traitCollection: UITraitCollection,
        inlineImageAttachment: (
            (NativeTabDocInlineImage, UIFont) -> NativeTabDocInlineImageAttachment?
        )?,
        inlineFormulaAttachment: (
            (NativeTabDocInlineMathematics, UIFont) -> NativeTabDocFormulaAttachment?
        )? = nil
    ) -> NSAttributedString {
        let result = NSMutableAttributedString()
        for span in spans {
            var attributes = attributes(
                for: span.marks,
                mathematics: span.mathematics,
                image: span.image,
                style: style,
                textAlignment: textAlignment,
                traitCollection: traitCollection
            )
            if let image = span.image,
               let make = inlineImageAttachment,
               let font = attributes[.font] as? UIFont,
               let attachment = make(image, font) {
                attributes[.attachment] = attachment
                result.append(
                    NSAttributedString(string: inlineImagePlaceholderCharacter, attributes: attributes)
                )
                continue
            }
            if let mathematics = span.mathematics,
               let make = inlineFormulaAttachment,
               let font = attributes[.font] as? UIFont,
               let attachment = make(mathematics, font) {
                attributes[.attachment] = attachment
                result.append(
                    NSAttributedString(string: inlineImagePlaceholderCharacter, attributes: attributes)
                )
                continue
            }
            result.append(NSAttributedString(string: span.text, attributes: attributes))
        }
        return result
    }

    /// `NSTextAttachment` 的占位字符（U+FFFC）。一个字符 = 一张不可拆的行内图片。
    static let inlineImagePlaceholderCharacter =
        NativeTabDocInlineSpan.attachmentPlaceholderCharacter

    static func inlineImageAttachment(
        in attributes: [NSAttributedString.Key: Any]
    ) -> NativeTabDocInlineImageAttachment? {
        attributes[.attachment] as? NativeTabDocInlineImageAttachment
    }

    static func spans(
        from attributed: NSAttributedString,
        baseStyle: NativeTabDocRichTextStyle
    ) -> [NativeTabDocInlineSpan] {
        guard attributed.length > 0 else { return [] }
        var spans: [NativeTabDocInlineSpan] = []
        attributed.enumerateAttributes(
            in: NSRange(location: 0, length: attributed.length),
            options: []
        ) { attributes, range, _ in
            let mathematics = mathematics(from: attributes)
            let image = inlineImage(from: attributes)
            // 真图 / 真公式呈现用 U+FFFC 替换占位串；回采必须还原模型源，附件字符不能写进身份。
            let visible = attributed.attributedSubstring(from: range).string
            let text = image?.placeholderText
                ?? formulaSourceText(mathematics, visible: visible)
                ?? visible
            var marks: [NativeTabDocInlineMark] = []
            if mathematics == nil, image == nil, let font = attributes[.font] as? UIFont {
                let traits = font.fontDescriptor.symbolicTraits
                if traits.contains(.traitBold) { marks.append(.canonical(.bold)) }
                if traits.contains(.traitItalic) { marks.append(.canonical(.italic)) }
                if hasCodeMark(attributes), baseStyle != .code {
                    marks.append(.canonical(.code))
                }
            }
            if (attributes[.underlineStyle] as? Int ?? 0) != 0 {
                marks.append(.canonical(.underline))
            }
            if (attributes[.strikethroughStyle] as? Int ?? 0) != 0 {
                marks.append(.canonical(.strike))
            }
            let preserved = preservedMarks(from: attributes)
            if let preservedLink = preserved.first(where: { $0.kind == .link }) {
                marks.append(preservedLink)
            } else if let url = attributes[.link] as? URL {
                marks.append(.canonical(.link, href: url.absoluteString))
            } else if let value = attributes[.link] as? String {
                marks.append(.canonical(.link, href: value))
            }
            marks.append(contentsOf: preserved.filter { $0.kind != .link })
            if let last = spans.last,
               last.marks == marks,
               last.mathematics?.atomId == mathematics?.atomId,
               last.mathematics?.nodeType == mathematics?.nodeType,
               last.mathematics?.valueAttribute == mathematics?.valueAttribute,
               last.mathematics?.attrs == mathematics?.attrs,
               last.image?.atomId == image?.atomId,
               last.image?.nodeType == image?.nodeType,
               last.image?.attrs == image?.attrs {
                if image == nil {
                    spans[spans.count - 1].text = last.text + text
                }
            } else {
                spans.append(NativeTabDocInlineSpan(
                    text: text,
                    marks: marks,
                    mathematics: mathematics,
                    image: image
                ))
            }
        }
        return spans
    }

    static func preservedMarks(
        from attributes: [NSAttributedString.Key: Any]
    ) -> [NativeTabDocInlineMark] {
        guard let value = attributes[preservedMarksKey] as? String,
              let data = Data(base64Encoded: value),
              let marks = try? JSONDecoder().decode([NativeTabDocInlineMark].self, from: data)
        else { return [] }
        return marks.filter { preservedKinds.contains($0.kind) }
    }

    static func hasCodeMark(_ attributes: [NSAttributedString.Key: Any]) -> Bool {
        attributes[.backgroundColor] != nil
            && (attributes[.font] as? UIFont)?
                .fontDescriptor.symbolicTraits.contains(.traitMonoSpace) == true
    }

    static func isSafeLink(_ url: URL) -> Bool {
        guard let scheme = url.scheme?.lowercased() else { return false }
        return ["http", "https", "mailto", "tel"].contains(scheme)
    }

    private static let preservedKinds: Set<NativeTabDocInlineMarkKind> = [
        .link,
        .textStyle,
        .highlight,
        .subscript,
        .superscript,
        .unknown,
    ]

    static func mathematics(
        from attributes: [NSAttributedString.Key: Any]
    ) -> NativeTabDocInlineMathematics? {
        guard let value = attributes[inlineMathematicsKey] as? String,
              let data = Data(base64Encoded: value),
              let payload = try? JSONDecoder().decode(NativeTabDocInlineMathematics.self, from: data)
        else { return nil }
        return payload
    }

    /// 行内原子（公式 / 图片）和未知 mark 范围都不接受工具条格式。
    /// 套加粗会在保存时静默丢身份，必须拒绝。
    static func acceptsInlineMark(_ attributes: [NSAttributedString.Key: Any]) -> Bool {
        mathematics(from: attributes) == nil
            && inlineImage(from: attributes) == nil
            && !preservedMarks(from: attributes).contains(where: { $0.kind == .unknown })
    }

    static func unknownMarkRanges(in attributed: NSAttributedString) -> [NSRange] {
        guard attributed.length > 0 else { return [] }
        var ranges: [NSRange] = []
        attributed.enumerateAttributes(
            in: NSRange(location: 0, length: attributed.length),
            options: []
        ) { attributes, range, _ in
            if preservedMarks(from: attributes).contains(where: { $0.kind == .unknown }) {
                ranges.append(range)
            }
        }
        return ranges
    }

    /// 未知 mark 只能整段删掉，或在范围外改字。部分重叠必须拒绝。
    static func allowsUnknownRangeEdit(
        in unknownRanges: [NSRange],
        replacing range: NSRange
    ) -> Bool {
        unknownRanges.allSatisfy { unknown in
            let unknownEnd = unknown.location + unknown.length
            let editEnd = range.location + range.length
            if editEnd <= unknown.location || range.location >= unknownEnd { return true }
            return range.location <= unknown.location && editEnd >= unknownEnd
        }
    }

    static func inlineImage(
        from attributes: [NSAttributedString.Key: Any]
    ) -> NativeTabDocInlineImage? {
        guard let value = attributes[inlineImageKey] as? String,
              let data = Data(base64Encoded: value),
              let payload = try? JSONDecoder().decode(NativeTabDocInlineImage.self, from: data)
        else { return nil }
        return payload
    }

    static func formulaSourceText(
        _ mathematics: NativeTabDocInlineMathematics?,
        visible: String
    ) -> String? {
        guard let mathematics else { return nil }
        if visible == inlineImagePlaceholderCharacter {
            return mathematics.sourceText
        }
        return nil
    }

    private static func encodedMathematics(_ mathematics: NativeTabDocInlineMathematics) -> String? {
        guard let data = try? JSONEncoder().encode(mathematics) else { return nil }
        return data.base64EncodedString()
    }

    private static func encodedInlineImage(_ image: NativeTabDocInlineImage) -> String? {
        guard let data = try? JSONEncoder().encode(image) else { return nil }
        return data.base64EncodedString()
    }

    static func encodePreservedMarksForTyping(
        _ marks: [NativeTabDocInlineMark]
    ) -> String? {
        encodedPreservedMarks(from: marks)
    }

    private static func encodedPreservedMarks(
        from marks: [NativeTabDocInlineMark]
    ) -> String? {
        let preserved = marks.filter { preservedKinds.contains($0.kind) }
        guard !preserved.isEmpty,
              let data = try? JSONEncoder().encode(preserved)
        else { return nil }
        return data.base64EncodedString()
    }

    private static func color(for mark: NativeTabDocInlineMark) -> UIColor? {
        guard let attrs = mark.rawNode["attrs"]?.dictValue,
              let color = attrs["color"] as? String
        else { return nil }
        if mark.kind == .highlight,
           Set(mark.rawNode.keys) == ["type", "attrs"],
           mark.rawNode["type"]?.stringValue == "highlight",
           Set(attrs.keys) == ["color"],
           color == "yellow" {
            return .yellow
        }
        guard color.count == 7,
              color.first == "#",
              let value = UInt64(color.dropFirst(), radix: 16)
        else { return nil }
        return UIColor(
            red: CGFloat((value >> 16) & 0xFF) / 255,
            green: CGFloat((value >> 8) & 0xFF) / 255,
            blue: CGFloat(value & 0xFF) / 255,
            alpha: 1
        )
    }
}

/// 小而明确的 UIKit bridge：保留 ProseMirror 常用 marks，并给触屏键盘提供格式工具条。
/// 未识别的 marks 不会进入这里；解析层会把对应块整体降为只读，避免编辑时静默丢失。
struct NativeTabDocRichTextView: UIViewRepresentable {
    let spans: [NativeTabDocInlineSpan]
    let isEditable: Bool
    let style: NativeTabDocRichTextStyle
    let textAlignment: NativeTabDocTextAlignment
    let placeholder: String
    let onChange: ([NativeTabDocInlineSpan]) -> Void
    let onFocusChange: (Bool) -> Void
    let focusRequest: NativeTabDocRichTextFocusRequest?
    let onBackspaceAtStart: () -> Bool
    /// 提供行内图片的可读地址。传 nil 表示这条渲染路径没有加载生命周期
    /// （如表格格子预览），行内图片继续以诚实 alt 占位显示。
    let inlineImageResolver: (
        (NativeTabDocInlineImagePresentation.Descriptor) async -> URL?
    )?
    var canUndo: Bool = false
    var canRedo: Bool = false
    var onUndo: (() -> Void)? = nil
    var onRedo: (() -> Void)? = nil

    init(
        spans: [NativeTabDocInlineSpan],
        isEditable: Bool,
        style: NativeTabDocRichTextStyle,
        textAlignment: NativeTabDocTextAlignment = .natural,
        placeholder: String,
        onChange: @escaping ([NativeTabDocInlineSpan]) -> Void,
        onFocusChange: @escaping (Bool) -> Void,
        focusRequest: NativeTabDocRichTextFocusRequest? = nil,
        onBackspaceAtStart: @escaping () -> Bool = { false },
        inlineImageResolver: (
            (NativeTabDocInlineImagePresentation.Descriptor) async -> URL?
        )? = nil,
        canUndo: Bool = false,
        canRedo: Bool = false,
        onUndo: (() -> Void)? = nil,
        onRedo: (() -> Void)? = nil
    ) {
        self.spans = spans
        self.isEditable = isEditable
        self.style = style
        self.textAlignment = textAlignment
        self.placeholder = placeholder
        self.onChange = onChange
        self.onFocusChange = onFocusChange
        self.focusRequest = focusRequest
        self.onBackspaceAtStart = onBackspaceAtStart
        self.inlineImageResolver = inlineImageResolver
        self.canUndo = canUndo
        self.canRedo = canRedo
        self.onUndo = onUndo
        self.onRedo = onRedo
    }

    func makeCoordinator() -> Coordinator {
        Coordinator(parent: self)
    }

    static func dismantleUIView(_ uiView: UITextView, coordinator: Coordinator) {
        if uiView.isFirstResponder {
            coordinator.parent.onFocusChange(false)
        }
        uiView.delegate = nil
        uiView.inputAccessoryView = nil
        (uiView as? NativeTabDocUITextView)?.onBackspaceAtStart = nil
        coordinator.textView = nil
    }

    func makeUIView(context: Context) -> UITextView {
        let textView = NativeTabDocUITextView()
        context.coordinator.textView = textView
        let coordinator = context.coordinator
        textView.onBackspaceAtStart = { [weak coordinator] in
            coordinator?.parent.onBackspaceAtStart() == true
        }
        textView.delegate = context.coordinator
        textView.backgroundColor = .clear
        textView.isScrollEnabled = false
        textView.textContainerInset = UIEdgeInsets(
            top: TTSpacing.xs,
            left: 0,
            bottom: TTSpacing.xs,
            right: 0
        )
        textView.textContainer.lineFragmentPadding = 0
        textView.adjustsFontForContentSizeCategory = true
        textView.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        textView.linkTextAttributes = [
            .foregroundColor: TTColors.bgAccentUI,
            .underlineStyle: NSUnderlineStyle.single.rawValue,
        ]
        textView.inputAccessoryView = context.coordinator.makeToolbar()
        return textView
    }

    func sizeThatFits(
        _ proposal: ProposedViewSize,
        uiView: UITextView,
        context: Context
    ) -> CGSize? {
        guard let width = proposal.width else { return nil }
        let fitted = uiView.sizeThatFits(CGSize(width: width, height: .greatestFiniteMagnitude))
        return CGSize(
            width: width,
            height: NativeTabDocRichTextSizingPolicy.height(
                fittedHeight: fitted.height,
                isEmpty: spans.allSatisfy { $0.text.isEmpty }
            )
        )
    }

    func updateUIView(_ textView: UITextView, context: Context) {
        context.coordinator.parent = self
        context.coordinator.textView = textView
        if let richTextView = textView as? NativeTabDocUITextView {
            richTextView.richTextStyle = style
            richTextView.richTextAlignment = textAlignment
        }
        let wasEditable = textView.isEditable
        textView.isEditable = isEditable
        if NativeTabDocRichTextFocusPolicy.shouldResignFirstResponder(
            wasEditable: wasEditable,
            isEditable: isEditable,
            isFirstResponder: textView.isFirstResponder
        ) {
            textView.resignFirstResponder()
        }
        textView.isSelectable = true
        textView.accessibilityLabel = placeholder

        let incoming = attributedString(traitCollection: textView.traitCollection)
        if NativeTabDocRichTextSynchronizationPolicy.shouldApplyIncoming(
            isApplyingChange: context.coordinator.isApplyingChange,
            hasMarkedText: textView.markedTextRange != nil,
            contentMatches: NativeTabDocRichTextSynchronizationPolicy.attributedContentMatches(
                textView.attributedText,
                incoming
            )
        ) {
            let selection = textView.selectedRange
            context.coordinator.isApplyingChange = true
            textView.attributedText = incoming
            textView.selectedRange = NSRange(
                location: min(selection.location, incoming.length),
                length: min(selection.length, max(0, incoming.length - min(selection.location, incoming.length)))
            )
            context.coordinator.didApplyIncoming(to: textView)
        }

        context.coordinator.loadPendingInlineImages(in: textView)
        context.coordinator.loadPendingFormulas(in: textView)

        if !textView.isFirstResponder || textView.attributedText.length == 0 {
            textView.typingAttributes = attributes(for: [], traitCollection: textView.traitCollection)
        }

        if textView.attributedText.length == 0 {
            textView.accessibilityValue = placeholder
        }

        context.coordinator.refreshUndoRedoButtons()
        context.coordinator.applyFocusRequestIfNeeded(to: textView)
    }

    private func attributedString(traitCollection: UITraitCollection) -> NSAttributedString {
        NativeTabDocRichTextMarkBridge.attributedString(
            spans: spans,
            style: style,
            textAlignment: textAlignment,
            traitCollection: traitCollection,
            inlineImageAttachment: inlineImageResolver == nil
                ? nil
                : { image, font in
                    NativeTabDocInlineImageAttachmentFactory.make(
                        for: image,
                        font: font,
                        traitCollection: traitCollection
                    )
                },
            inlineFormulaAttachment: { mathematics, font in
                NativeTabDocFormulaAttachmentFactory.make(
                    for: mathematics,
                    font: font,
                    traitCollection: traitCollection
                )
            }
        )
    }

    private func attributes(
        for marks: [NativeTabDocInlineMark],
        mathematics: NativeTabDocInlineMathematics? = nil,
        image: NativeTabDocInlineImage? = nil,
        traitCollection: UITraitCollection
    ) -> [NSAttributedString.Key: Any] {
        NativeTabDocRichTextMarkBridge.attributes(
            for: marks,
            mathematics: mathematics,
            image: image,
            style: style,
            textAlignment: textAlignment,
            traitCollection: traitCollection
        )
    }

    @MainActor
    final class Coordinator: NSObject, UITextViewDelegate {
        var parent: NativeTabDocRichTextView
        weak var textView: UITextView?
        var isApplyingChange = false
        private var appliedFocusRequestToken: UUID?
        private var inlineImageTasks: [String: Task<Void, Never>] = [:]
        private var formulaTasks: [String: Task<Void, Never>] = [:]
        private var undoButton: UIBarButtonItem?
        private var redoButton: UIBarButtonItem?

        init(parent: NativeTabDocRichTextView) {
            self.parent = parent
        }

        deinit {
            inlineImageTasks.values.forEach { $0.cancel() }
            formulaTasks.values.forEach { $0.cancel() }
        }

        /// 对仍在加载态的行内图片各发一次请求，结果统一回落到缓存后再整体刷新。
        /// 附件实例每次 `updateUIView` 都会重建，所以请求按缓存键去重，回来后不认实例、
        /// 只按当前正文里的附件重新对账。
        func loadPendingInlineImages(in textView: UITextView) {
            guard let resolve = parent.inlineImageResolver else { return }
            let attributed = textView.attributedText ?? NSAttributedString()
            var pending: [String: NativeTabDocInlineImagePresentation.Descriptor] = [:]
            attributed.enumerateAttribute(
                .attachment,
                in: NSRange(location: 0, length: attributed.length)
            ) { value, _, _ in
                guard let attachment = value as? NativeTabDocInlineImageAttachment,
                      attachment.state == .loading,
                      let key = NativeTabDocInlineImagePresentation.cacheKey(
                          for: attachment.descriptor
                      )
                else { return }
                pending[key] = attachment.descriptor
            }

            for (key, descriptor) in pending where inlineImageTasks[key] == nil {
                inlineImageTasks[key] = Task { [weak self] in
                    _ = await NativeTabDocInlineImageStore.shared.image(
                        for: descriptor,
                        resolveURL: resolve
                    )
                    guard let self else { return }
                    self.inlineImageTasks[key] = nil
                    guard let textView = self.textView else { return }
                    self.refreshInlineImages(in: textView)
                }
            }
        }

        /// 只重排附件所在的字符，不重建正文，避免打断输入法与选区。
        private func refreshInlineImages(in textView: UITextView) {
            let storage = textView.textStorage
            var dirty: [NSRange] = []
            storage.enumerateAttribute(
                .attachment,
                in: NSRange(location: 0, length: storage.length)
            ) { value, range, _ in
                guard let attachment = value as? NativeTabDocInlineImageAttachment else { return }
                let next = NativeTabDocInlineImageAttachmentFactory.state(
                    for: attachment.descriptor
                )
                guard next != attachment.state else { return }
                attachment.apply(next)
                dirty.append(range)
            }
            guard !dirty.isEmpty else { return }
            let selection = textView.selectedRange
            isApplyingChange = true
            storage.beginEditing()
            for range in dirty {
                storage.edited(.editedAttributes, range: range, changeInLength: 0)
            }
            storage.endEditing()
            isApplyingChange = false
            textView.selectedRange = selection
        }

        /// 源码兜底先上屏，KaTeX 图到了再把对应原子换成附件，不打断旁字输入。
        func loadPendingFormulas(in textView: UITextView) {
            let traits = textView.traitCollection
            let font = UIFont.monospacedSystemFont(
                ofSize: parent.style.font.pointSize,
                weight: .regular
            )
            let textColor = TTColors.textPrimaryUI.resolvedColor(with: traits)
            for span in parent.spans {
                guard let mathematics = span.mathematics else { continue }
                let latex = NativeTabDocFormulaRenderer.latex(from: mathematics)
                guard !latex.isEmpty else { continue }
                let descriptor = NativeTabDocFormulaRenderer.Descriptor(
                    latex: latex,
                    displayMode: NativeTabDocFormulaRenderer.displayMode(from: mathematics),
                    fontSize: font.pointSize,
                    textColorHex: textColor.tabDocFormulaHexString
                )
                if NativeTabDocFormulaStore.shared.cachedImage(for: descriptor) != nil { continue }
                if NativeTabDocFormulaStore.shared.hasFailed(for: descriptor) { continue }
                let key = descriptor.cacheKey
                guard formulaTasks[key] == nil else { continue }
                formulaTasks[key] = Task { [weak self] in
                    _ = await NativeTabDocFormulaStore.shared.image(for: descriptor)
                    guard let self else { return }
                    self.formulaTasks[key] = nil
                    guard let textView = self.textView else { return }
                    self.refreshFormulas(in: textView)
                }
            }
        }

        private func refreshFormulas(in textView: UITextView) {
            let incoming = parent.attributedString(traitCollection: textView.traitCollection)
            let selection = textView.selectedRange
            isApplyingChange = true
            textView.attributedText = incoming
            textView.selectedRange = NSRange(
                location: min(selection.location, incoming.length),
                length: min(
                    selection.length,
                    max(0, incoming.length - min(selection.location, incoming.length))
                )
            )
            isApplyingChange = false
        }

        func makeToolbar() -> UIView {
            let undoItem = formatButton(title: L10n.TabDoc.undo, action: #selector(performUndo))
            let redoItem = formatButton(title: L10n.TabDoc.redo, action: #selector(performRedo))
            undoButton = undoItem
            redoButton = redoItem
            refreshUndoRedoButtons()
            return NativeTabDocInputAccessoryView(
                items: [
                    undoItem,
                    redoItem,
                    formatButton(title: "B", action: #selector(toggleBold)),
                    formatButton(title: "I", action: #selector(toggleItalic)),
                    formatButton(title: "U", action: #selector(toggleUnderline)),
                    formatButton(title: "S", action: #selector(toggleStrike)),
                    formatButton(title: "</>", action: #selector(toggleCode)),
                    UIBarButtonItem(systemItem: .flexibleSpace),
                    UIBarButtonItem(systemItem: .done, primaryAction: UIAction { [weak self] _ in
                        self?.textView?.resignFirstResponder()
                    }),
                ],
                viewportMetrics: { [weak self] in
                    guard let window = self?.textView?.window else { return nil }
                    return (
                        maxY: window.convert(window.bounds, to: nil).maxY,
                        safeAreaBottom: window.safeAreaInsets.bottom
                    )
                }
            )
        }

        func textViewDidBeginEditing(_ textView: UITextView) {
            parent.onFocusChange(true)
            restoreTypingAttributes(for: textView)
        }

        func textViewDidChangeSelection(_ textView: UITextView) {
            guard !isApplyingChange else { return }
            restoreTypingAttributes(for: textView)
        }

        func didApplyIncoming(to textView: UITextView) {
            isApplyingChange = false
            restoreTypingAttributes(for: textView)
        }

        func applyFocusRequestIfNeeded(to textView: UITextView) {
            guard let request = parent.focusRequest,
                  request.token != appliedFocusRequestToken
            else { return }
            appliedFocusRequestToken = request.token
            let apply = { [weak textView] in
                guard let textView else { return }
                if !textView.isFirstResponder { textView.becomeFirstResponder() }
                let location = min(max(request.caretPosition, 0), textView.attributedText.length)
                textView.selectedRange = NSRange(location: location, length: 0)
            }
            if textView.window == nil {
                DispatchQueue.main.async(execute: apply)
            } else {
                apply()
            }
        }

        func textViewDidEndEditing(_ textView: UITextView) {
            parent.onFocusChange(false)
        }

        func refreshUndoRedoButtons() {
            undoButton?.isEnabled = parent.canUndo
            redoButton?.isEnabled = parent.canRedo
        }

        @objc private func performUndo() {
            parent.onUndo?()
        }

        @objc private func performRedo() {
            parent.onRedo?()
        }

        private func formatButton(title: String, action: Selector) -> UIBarButtonItem {
            let item = UIBarButtonItem(title: title, style: .plain, target: self, action: action)
            item.accessibilityLabel = title
            return item
        }

        private func restoreTypingAttributes(for textView: UITextView) {
            guard textView.attributedText.length > 0 else {
                textView.typingAttributes = NativeTabDocRichTextMarkBridge.attributes(
                    for: [],
                    style: parent.style,
                    textAlignment: parent.textAlignment,
                    traitCollection: textView.traitCollection
                )
                return
            }
            let caret = textView.selectedRange
            if caret.length == 0,
               let inherited = inlineAtomTypingAttributes(in: textView, at: caret.location) {
                textView.typingAttributes = inherited
                return
            }
            let location = min(
                caret.location,
                textView.attributedText.length - 1
            )
            var attributes = textView.attributedText.attributes(
                at: location,
                effectiveRange: nil
            )
            if caret.length == 0 {
                attributes.removeValue(forKey: NativeTabDocRichTextMarkBridge.inlineMathematicsKey)
                attributes.removeValue(forKey: NativeTabDocRichTextMarkBridge.inlineImageKey)
                let preserved = NativeTabDocRichTextMarkBridge.preservedMarks(from: attributes)
                    .filter { $0.kind != .unknown }
                if let encoded = NativeTabDocRichTextMarkBridge.encodePreservedMarksForTyping(preserved) {
                    attributes[NativeTabDocRichTextMarkBridge.preservedMarksKey] = encoded
                } else {
                    attributes.removeValue(forKey: NativeTabDocRichTextMarkBridge.preservedMarksKey)
                }
            }
            textView.typingAttributes = attributes
        }

        /// 光标落在同一个行内原子内部时继承它的属性；停在原子边缘时不继承，
        /// 新输入不会被吸收进公式或图片。
        private func inlineAtomTypingAttributes(
            in textView: UITextView,
            at location: Int
        ) -> [NSAttributedString.Key: Any]? {
            let length = textView.attributedText.length
            guard location > 0, location < length else { return nil }
            let before = textView.attributedText.attributes(
                at: location - 1,
                effectiveRange: nil
            )
            let after = textView.attributedText.attributes(
                at: location,
                effectiveRange: nil
            )
            let beforeMath = NativeTabDocRichTextMarkBridge.mathematics(from: before)
            let afterMath = NativeTabDocRichTextMarkBridge.mathematics(from: after)
            if let beforeMath, let afterMath, beforeMath.atomId == afterMath.atomId {
                return after
            }
            let beforeImage = NativeTabDocRichTextMarkBridge.inlineImage(from: before)
            let afterImage = NativeTabDocRichTextMarkBridge.inlineImage(from: after)
            if let beforeImage, let afterImage, beforeImage.atomId == afterImage.atomId {
                return after
            }
            return nil
        }

        @objc private func toggleBold() { toggle(.bold) }
        @objc private func toggleItalic() { toggle(.italic) }
        @objc private func toggleUnderline() { toggle(.underline) }
        @objc private func toggleStrike() { toggle(.strike) }
        @objc private func toggleCode() { toggle(.code) }

        private func toggle(_ kind: NativeTabDocInlineMarkKind) {
            guard let textView, parent.isEditable else { return }
            let selectedRange = textView.selectedRange
            let effectiveRange = selectedRange.length > 0
                ? selectedRange
                : NSRange(location: selectedRange.location, length: 0)
            var attributes = textView.typingAttributes
            if selectedRange.length > 0, selectedRange.location < textView.attributedText.length {
                attributes = textView.attributedText.attributes(
                    at: selectedRange.location,
                    effectiveRange: nil
                )
            }
            let isActive = Self.hasMark(kind, attributes: attributes)
            let targetRange = effectiveRange.length > 0 ? effectiveRange : nil
            if let targetRange {
                isApplyingChange = true
                if isActive {
                    Self.remove(
                        kind,
                        from: textView.textStorage,
                        range: targetRange,
                        style: parent.style
                    )
                } else {
                    Self.add(kind, to: textView.textStorage, range: targetRange, style: parent.style)
                }
                isApplyingChange = false
                textViewDidChange(textView)
            } else {
                if isActive {
                    Self.remove(kind, from: &attributes, style: parent.style)
                } else {
                    Self.add(kind, to: &attributes, style: parent.style)
                }
                textView.typingAttributes = attributes
            }
        }

        func textViewDidChange(_ textView: UITextView) {
            guard NativeTabDocRichTextSynchronizationPolicy.shouldPublishChange(
                isApplyingChange: isApplyingChange,
                hasMarkedText: textView.markedTextRange != nil
            ) else { return }
            parent.onChange(Self.spans(from: textView.attributedText, baseStyle: parent.style))
        }

        func textView(
            _ textView: UITextView,
            shouldChangeTextIn range: NSRange,
            replacementText text: String
        ) -> Bool {
            let unknownRanges = NativeTabDocRichTextMarkBridge.unknownMarkRanges(
                in: textView.attributedText
            )
            return NativeTabDocRichTextMarkBridge.allowsUnknownRangeEdit(
                in: unknownRanges,
                replacing: range
            )
        }

        func textView(
            _ textView: UITextView,
            shouldInteractWith URL: URL,
            in characterRange: NSRange,
            interaction: UITextItemInteraction
        ) -> Bool {
            NativeTabDocRichTextMarkBridge.isSafeLink(URL)
        }

        private static func spans(
            from attributed: NSAttributedString,
            baseStyle: NativeTabDocRichTextStyle
        ) -> [NativeTabDocInlineSpan] {
            NativeTabDocRichTextMarkBridge.spans(
                from: attributed,
                baseStyle: baseStyle
            )
        }

        private static func hasMark(
            _ kind: NativeTabDocInlineMarkKind,
            attributes: [NSAttributedString.Key: Any]
        ) -> Bool {
            switch kind {
            case .bold:
                (attributes[.font] as? UIFont)?.fontDescriptor.symbolicTraits.contains(.traitBold) == true
            case .italic:
                (attributes[.font] as? UIFont)?.fontDescriptor.symbolicTraits.contains(.traitItalic) == true
            case .underline:
                (attributes[.underlineStyle] as? Int ?? 0) != 0
            case .strike:
                (attributes[.strikethroughStyle] as? Int ?? 0) != 0
            case .code:
                hasCodeMark(attributes)
            case .link:
                attributes[.link] != nil
            case .textStyle, .highlight, .subscript, .superscript:
                NativeTabDocRichTextMarkBridge.preservedMarks(from: attributes)
                    .contains(where: { $0.kind == kind })
            case .unknown:
                false
            }
        }

        private static func add(
            _ kind: NativeTabDocInlineMarkKind,
            to storage: NSTextStorage,
            range: NSRange,
            style: NativeTabDocRichTextStyle
        ) {
            storage.enumerateAttributes(in: range) { current, subrange, _ in
                guard NativeTabDocRichTextMarkBridge.acceptsInlineMark(current) else { return }
                var changed = current
                add(kind, to: &changed, style: style)
                storage.setAttributes(changed, range: subrange)
            }
        }

        private static func remove(
            _ kind: NativeTabDocInlineMarkKind,
            from storage: NSTextStorage,
            range: NSRange,
            style: NativeTabDocRichTextStyle
        ) {
            var replacements: [(NSRange, [NSAttributedString.Key: Any])] = []
            storage.enumerateAttributes(in: range) { current, subrange, _ in
                guard NativeTabDocRichTextMarkBridge.acceptsInlineMark(current) else { return }
                var changed = current
                remove(kind, from: &changed, style: style)
                replacements.append((subrange, changed))
            }
            for (subrange, changed) in replacements {
                storage.setAttributes(changed, range: subrange)
            }
        }

        private static func add(
            _ kind: NativeTabDocInlineMarkKind,
            to attributes: inout [NSAttributedString.Key: Any],
            style: NativeTabDocRichTextStyle
        ) {
            switch kind {
            case .bold, .italic, .code:
                if kind == .code {
                    attributes[.backgroundColor] = TTColors.bgSubtleUI
                    attributes[.font] = UIFontMetrics(forTextStyle: style.textStyle).scaledFont(
                        for: UIFont.monospacedSystemFont(
                            ofSize: style.font.pointSize,
                            weight: .regular
                        )
                    )
                } else {
                    let current = attributes[.font] as? UIFont ?? style.scaledFont()
                    var traits = current.fontDescriptor.symbolicTraits
                    traits.insert(kind == .bold ? .traitBold : .traitItalic)
                    if let descriptor = current.fontDescriptor.withSymbolicTraits(traits) {
                        attributes[.font] = UIFont(descriptor: descriptor, size: current.pointSize)
                    }
                }
            case .underline:
                attributes[.underlineStyle] = NSUnderlineStyle.single.rawValue
            case .strike:
                attributes[.strikethroughStyle] = NSUnderlineStyle.single.rawValue
            case .link:
                break
            case .textStyle, .highlight, .subscript, .superscript, .unknown:
                // 本批仅承接已有格式的显示、正文编辑与无损写回；未知 mark 不能当格式开关。
                break
            }
        }

        private static func remove(
            _ kind: NativeTabDocInlineMarkKind,
            from attributes: inout [NSAttributedString.Key: Any],
            style: NativeTabDocRichTextStyle
        ) {
            switch kind {
            case .bold, .italic:
                guard let current = attributes[.font] as? UIFont else { return }
                var traits = current.fontDescriptor.symbolicTraits
                traits.remove(kind == .bold ? .traitBold : .traitItalic)
                if let descriptor = current.fontDescriptor.withSymbolicTraits(traits) {
                    attributes[.font] = UIFont(descriptor: descriptor, size: current.pointSize)
                }
            case .code:
                attributes.removeValue(forKey: .backgroundColor)
                let existing = attributes[.font] as? UIFont
                var traits = existing?.fontDescriptor.symbolicTraits ?? []
                traits.remove(.traitMonoSpace)
                attributes[.font] = style.scaledFont(traits: traits)
            case .underline:
                attributes.removeValue(forKey: .underlineStyle)
            case .strike:
                attributes.removeValue(forKey: .strikethroughStyle)
            case .link:
                attributes.removeValue(forKey: .link)
            case .textStyle, .highlight, .subscript, .superscript, .unknown:
                // 当前没有对应工具条动作；保留身份元数据，避免普通编辑误删格式。
                break
            }
        }

        private static func hasCodeMark(_ attributes: [NSAttributedString.Key: Any]) -> Bool {
            NativeTabDocRichTextMarkBridge.hasCodeMark(attributes)
        }

    }
}

@MainActor
enum NativeTabDocRichTextPasteboard {
    static let pasteboardType = "com.tabtin.nativeTabDoc.inlineSpans.v1"

    static func encodedSpans(_ spans: [NativeTabDocInlineSpan]) throws -> Data {
        try JSONEncoder().encode(spans)
    }

    static func decodedSpans(
        from data: Data,
        renewingMathematics: Bool
    ) throws -> [NativeTabDocInlineSpan] {
        let spans = try JSONDecoder().decode([NativeTabDocInlineSpan].self, from: data)
        return renewingMathematics
            ? NativeTabDocInlineSpan.renewingInlineAtomIdentities(in: spans)
            : spans
    }

    static func copySelection(from textView: UITextView) {
        let range = textView.selectedRange
        guard range.length > 0, range.location + range.length <= textView.attributedText.length else {
            return
        }
        let selected = textView.attributedText.attributedSubstring(from: range)
        let spans = NativeTabDocRichTextMarkBridge.spans(
            from: selected,
            baseStyle: (textView as? NativeTabDocUITextView)?.richTextStyle ?? .body
        )
        var item: [String: Any] = ["public.utf8-plain-text": selected.string]
        if let data = try? encodedSpans(spans) {
            item[pasteboardType] = data
        }
        UIPasteboard.general.items = [item]
    }

    @discardableResult
    static func paste(
        into textView: UITextView,
        style: NativeTabDocRichTextStyle,
        textAlignment: NativeTabDocTextAlignment,
        traitCollection: UITraitCollection
    ) -> Bool {
        guard let data = UIPasteboard.general.data(forPasteboardType: pasteboardType),
              let spans = try? decodedSpans(from: data, renewingMathematics: true)
        else { return false }
        let incoming = NSMutableAttributedString()
        for span in spans {
            incoming.append(NSAttributedString(
                string: span.text,
                attributes: NativeTabDocRichTextMarkBridge.attributes(
                    for: span.marks,
                    mathematics: span.mathematics,
                    image: span.image,
                    style: style,
                    textAlignment: textAlignment,
                    traitCollection: traitCollection
                )
            ))
        }
        let range = textView.selectedRange
        guard range.location >= 0,
              range.location + range.length <= textView.attributedText.length
        else { return false }
        textView.textStorage.replaceCharacters(in: range, with: incoming)
        textView.selectedRange = NSRange(location: range.location + incoming.length, length: 0)
        return true
    }
}

@MainActor
final class NativeTabDocUITextView: UITextView {
    var richTextStyle: NativeTabDocRichTextStyle = .body
    var richTextAlignment: NativeTabDocTextAlignment = .natural
    var onBackspaceAtStart: (() -> Bool)?

    override func deleteBackward() {
        if markedTextRange == nil,
           selectedRange.location == 0,
           selectedRange.length == 0,
           onBackspaceAtStart?() == true {
            return
        }
        super.deleteBackward()
    }

    override func copy(_ sender: Any?) {
        NativeTabDocRichTextPasteboard.copySelection(from: self)
    }

    override func cut(_ sender: Any?) {
        NativeTabDocRichTextPasteboard.copySelection(from: self)
        let range = selectedRange
        guard range.length > 0 else { return }
        textStorage.replaceCharacters(in: range, with: NSAttributedString())
        selectedRange = NSRange(location: range.location, length: 0)
        delegate?.textViewDidChange?(self)
    }

    override func paste(_ sender: Any?) {
        if NativeTabDocRichTextPasteboard.paste(
            into: self,
            style: richTextStyle,
            textAlignment: richTextAlignment,
            traitCollection: traitCollection
        ) {
            delegate?.textViewDidChange?(self)
            return
        }
        super.paste(sender)
    }
}

@MainActor
private final class NativeTabDocInputAccessoryView: UIInputView {
    private let toolbar: UIToolbar
    private let viewportMetrics: () -> (maxY: CGFloat, safeAreaBottom: CGFloat)?
    private var bottomSafeAreaInset: CGFloat = 0

    init(
        items: [UIBarButtonItem],
        viewportMetrics: @escaping () -> (maxY: CGFloat, safeAreaBottom: CGFloat)?
    ) {
        let toolbar = UIToolbar()
        self.toolbar = toolbar
        self.viewportMetrics = viewportMetrics
        super.init(
            frame: CGRect(
                x: 0,
                y: 0,
                width: UIScreen.main.bounds.width,
                height: TTSpacing.Control.minimumTouchTarget + TTSpacing.sm
            ),
            inputViewStyle: .keyboard
        )

        allowsSelfSizing = true
        autoresizingMask = [.flexibleWidth]
        backgroundColor = .secondarySystemBackground
        toolbar.items = items
        toolbar.translatesAutoresizingMaskIntoConstraints = false
        addSubview(toolbar)
        NSLayoutConstraint.activate([
            toolbar.topAnchor.constraint(equalTo: topAnchor, constant: TTSpacing.xs),
            toolbar.leadingAnchor.constraint(equalTo: safeAreaLayoutGuide.leadingAnchor),
            toolbar.trailingAnchor.constraint(equalTo: safeAreaLayoutGuide.trailingAnchor),
            toolbar.heightAnchor.constraint(equalToConstant: TTSpacing.Control.minimumTouchTarget),
        ])
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override var intrinsicContentSize: CGSize {
        CGSize(
            width: UIView.noIntrinsicMetric,
            height: TTSpacing.Control.minimumTouchTarget + TTSpacing.sm + bottomSafeAreaInset
        )
    }

    override func didMoveToWindow() {
        super.didMoveToWindow()
        updateBottomSafeAreaInset()
    }

    override func safeAreaInsetsDidChange() {
        super.safeAreaInsetsDidChange()
        updateBottomSafeAreaInset()
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        updateBottomSafeAreaInset()
    }

    private func updateBottomSafeAreaInset() {
        guard let viewportMetrics = viewportMetrics() else { return }
        let nextInset = NativeTabDocInputAccessoryLayout.bottomSafeAreaInset(
            accessoryMaxY: convert(bounds, to: nil).maxY,
            viewportMaxY: viewportMetrics.maxY,
            safeAreaBottom: viewportMetrics.safeAreaBottom
        )
        guard abs(nextInset - bottomSafeAreaInset) > 0.5 else { return }
        bottomSafeAreaInset = nextInset
        invalidateIntrinsicContentSize()
    }
}
