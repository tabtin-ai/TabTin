import UIKit

/// 行内图片在 UITextView 里的载体。
///
/// 附件只占一个 `NSTextAttachment` 字符，所以行内图片天然是不可拆原子：
/// 一次退格删掉整张图，光标也不会停在图片"中间"。身份仍由同范围的
/// `NativeTabDocRichTextMarkBridge.inlineImageKey` 私有属性承载，附件本身不参与写回。
final class NativeTabDocInlineImageAttachment: NSTextAttachment {
    enum LoadState: Equatable {
        case loading
        case loaded(UIImage)
        case failed
    }

    let atomId: String
    let descriptor: NativeTabDocInlineImagePresentation.Descriptor
    let fallbackText: String
    private let font: UIFont
    private let textColor: UIColor
    private let placeholderBackground: UIColor
    private(set) var state: LoadState

    init(
        atomId: String,
        descriptor: NativeTabDocInlineImagePresentation.Descriptor,
        fallbackText: String,
        accessibilityLabel: String,
        font: UIFont,
        textColor: UIColor,
        placeholderBackground: UIColor,
        state: LoadState
    ) {
        self.atomId = atomId
        self.descriptor = descriptor
        self.fallbackText = fallbackText
        self.font = font
        self.textColor = textColor
        self.placeholderBackground = placeholderBackground
        self.state = state
        super.init(data: nil, ofType: nil)
        self.accessibilityLabel = accessibilityLabel
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    func apply(_ state: LoadState) {
        self.state = state
    }

    override func attachmentBounds(
        for textContainer: NSTextContainer?,
        proposedLineFragment lineFrag: CGRect,
        glyphPosition position: CGPoint,
        characterIndex charIndex: Int
    ) -> CGRect {
        let availableWidth = lineFrag.width > 0 ? lineFrag.width : Self.assumedContentWidth
        let size = displaySize(availableWidth: availableWidth)
        // 让附件坐在基线上并略微下探，与相邻文字的视觉重心对齐。
        return CGRect(x: 0, y: font.descender, width: size.width, height: size.height)
    }

    override func image(
        forBounds imageBounds: CGRect,
        textContainer: NSTextContainer?,
        characterIndex charIndex: Int
    ) -> UIImage? {
        switch state {
        case .loaded(let image):
            image
        case .loading, .failed:
            // 加载中和失败都必须可读，不能留下空白底或破图标。
            renderPlaceholder(size: imageBounds.size, showsFallbackText: true)
        }
    }

    /// 附件宽高：attrs 声明尺寸优先，正文宽度与最大行高兜底；加载前后不跳变。
    func displaySize(availableWidth: CGFloat) -> CGSize {
        var loadedSize: CGSize?
        if case .loaded(let image) = state, image.size.width > 0, image.size.height > 0 {
            loadedSize = image.size
        }
        return NativeTabDocInlineImagePresentation.displaySize(
            intrinsicSize: descriptor.intrinsicSize,
            loadedSize: loadedSize,
            lineHeight: font.lineHeight,
            availableWidth: availableWidth
        )
    }

    /// 加载中画中性底，失败画「图标 + alt」——两者都绝不显示地址或 fileId。
    private func renderPlaceholder(size: CGSize, showsFallbackText: Bool) -> UIImage? {
        let width = max(size.width, 1)
        let height = max(size.height, 1)
        let canvas = CGSize(width: width, height: height)
        return UIGraphicsImageRenderer(size: canvas).image { context in
            let rect = CGRect(origin: .zero, size: canvas)
            let path = UIBezierPath(roundedRect: rect, cornerRadius: min(TTRadius.sm, height / 2))
            placeholderBackground.setFill()
            path.fill()

            guard showsFallbackText else { return }
            let paragraph = NSMutableParagraphStyle()
            paragraph.alignment = .center
            paragraph.lineBreakMode = .byTruncatingTail
            let attributes: [NSAttributedString.Key: Any] = [
                .font: UIFont.systemFont(ofSize: min(font.pointSize, height / 2)),
                .foregroundColor: textColor,
                .paragraphStyle: paragraph,
            ]
            let text = fallbackText as NSString
            let inset = rect.insetBy(dx: 4, dy: 2)
            let bounding = text.boundingRect(
                with: CGSize(width: inset.width, height: inset.height),
                options: [.usesLineFragmentOrigin],
                attributes: attributes,
                context: nil
            )
            let origin = CGRect(
                x: inset.minX,
                y: inset.midY - bounding.height / 2,
                width: inset.width,
                height: min(bounding.height, inset.height)
            )
            text.draw(with: origin, options: [.usesLineFragmentOrigin], attributes: attributes, context: nil)
            _ = context
        }
    }

    /// 布局阶段拿不到容器宽度时的兜底正文宽度，仅用于估算，不影响最终排版。
    private static let assumedContentWidth: CGFloat = 320
}

/// 按当前缓存状态造附件。没有任何可加载地址的图片不造附件，交回调用方走文本占位——
/// 空框比一行可读的 alt 更糟。
@MainActor
enum NativeTabDocInlineImageAttachmentFactory {
    static func make(
        for image: NativeTabDocInlineImage,
        font: UIFont,
        traitCollection: UITraitCollection,
        store: NativeTabDocInlineImageStore = .shared
    ) -> NativeTabDocInlineImageAttachment? {
        let descriptor = NativeTabDocInlineImagePresentation.descriptor(for: image)
        guard descriptor.canLoad else { return nil }
        return NativeTabDocInlineImageAttachment(
            atomId: image.atomId,
            descriptor: descriptor,
            fallbackText: NativeTabDocInlineImagePresentation.fallbackText(for: image),
            accessibilityLabel: NativeTabDocInlineImagePresentation.accessibilityLabel(for: image),
            font: font,
            textColor: TTColors.textSecondaryUI.resolvedColor(with: traitCollection),
            placeholderBackground: TTColors.bgSubtleUI.resolvedColor(with: traitCollection),
            state: state(for: descriptor, store: store)
        )
    }

    static func state(
        for descriptor: NativeTabDocInlineImagePresentation.Descriptor,
        store: NativeTabDocInlineImageStore = .shared
    ) -> NativeTabDocInlineImageAttachment.LoadState {
        if let cached = store.cachedImage(for: descriptor) { return .loaded(cached) }
        if store.hasFailed(for: descriptor) { return .failed }
        return .loading
    }
}
