import UIKit

/// 行内公式在 UITextView 里的载体。
///
/// 附件只占一个 `NSTextAttachment` 字符，公式原子因此不可拆。身份仍由
/// `inlineMathematicsKey` 私有属性承载，附件本身不参与写回。
final class NativeTabDocFormulaAttachment: NSTextAttachment {
    let atomId: String
    let latex: String
    let displayMode: Bool
    private let font: UIFont
    private let textColor: UIColor
    private(set) var imageValue: UIImage?

    init(
        atomId: String,
        latex: String,
        displayMode: Bool,
        accessibilityLabel: String,
        font: UIFont,
        textColor: UIColor,
        image: UIImage
    ) {
        self.atomId = atomId
        self.latex = latex
        self.displayMode = displayMode
        self.font = font
        self.textColor = textColor
        self.imageValue = image
        super.init(data: nil, ofType: nil)
        self.accessibilityLabel = accessibilityLabel
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is unavailable")
    }

    func apply(_ image: UIImage) {
        imageValue = image
    }

    override func attachmentBounds(
        for textContainer: NSTextContainer?,
        proposedLineFragment lineFrag: CGRect,
        glyphPosition position: CGPoint,
        characterIndex charIndex: Int
    ) -> CGRect {
        let size = displaySize(availableWidth: lineFrag.width)
        return CGRect(x: 0, y: font.descender, width: size.width, height: size.height)
    }

    override func image(
        forBounds imageBounds: CGRect,
        textContainer: NSTextContainer?,
        characterIndex charIndex: Int
    ) -> UIImage? {
        imageValue
    }

    func displaySize(availableWidth: CGFloat) -> CGSize {
        guard let image = imageValue, image.size.width > 0, image.size.height > 0 else {
            return CGSize(width: max(font.lineHeight, 1), height: max(font.lineHeight, 1))
        }
        let maxWidth = availableWidth > 0 ? availableWidth : 320
        let scale = min(1, maxWidth / image.size.width)
        return CGSize(
            width: max(image.size.width * scale, 1),
            height: max(image.size.height * scale, 1)
        )
    }
}

/// 按当前缓存状态造公式附件。还没有 KaTeX 图时返回 nil，正文继续显示可读 LaTeX 源码。
@MainActor
enum NativeTabDocFormulaAttachmentFactory {
    static func make(
        for mathematics: NativeTabDocInlineMathematics,
        font: UIFont,
        traitCollection: UITraitCollection,
        store: NativeTabDocFormulaStore = .shared
    ) -> NativeTabDocFormulaAttachment? {
        let latex = NativeTabDocFormulaRenderer.latex(from: mathematics)
        guard !latex.isEmpty else { return nil }
        let displayMode = NativeTabDocFormulaRenderer.displayMode(from: mathematics)
        let textColor = TTColors.textPrimaryUI.resolvedColor(with: traitCollection)
        let descriptor = NativeTabDocFormulaRenderer.Descriptor(
            latex: latex,
            displayMode: displayMode,
            fontSize: font.pointSize,
            textColorHex: textColor.tabDocFormulaHexString
        )
        guard let image = store.cachedImage(for: descriptor) else { return nil }
        return NativeTabDocFormulaAttachment(
            atomId: mathematics.atomId,
            latex: latex,
            displayMode: displayMode,
            accessibilityLabel: latex,
            font: font,
            textColor: textColor,
            image: image
        )
    }
}

/// 行内公式的解码缓存。测试可 `prime`，生产路径走 KaTeX HTML → 离屏 WebView 快照。
@MainActor
final class NativeTabDocFormulaStore {
    static let shared = NativeTabDocFormulaStore()

    private var images: [String: UIImage] = [:]
    private var failed: Set<String> = []
    private var inFlight: Set<String> = []

    func prime(_ image: UIImage, for descriptor: NativeTabDocFormulaRenderer.Descriptor) {
        images[descriptor.cacheKey] = image
        failed.remove(descriptor.cacheKey)
    }

    func cachedImage(for descriptor: NativeTabDocFormulaRenderer.Descriptor) -> UIImage? {
        images[descriptor.cacheKey]
    }

    func hasFailed(for descriptor: NativeTabDocFormulaRenderer.Descriptor) -> Bool {
        failed.contains(descriptor.cacheKey)
    }

    func image(
        for descriptor: NativeTabDocFormulaRenderer.Descriptor
    ) async -> UIImage? {
        if let cached = images[descriptor.cacheKey] { return cached }
        if failed.contains(descriptor.cacheKey) { return nil }
        guard !inFlight.contains(descriptor.cacheKey) else { return images[descriptor.cacheKey] }
        inFlight.insert(descriptor.cacheKey)
        defer { inFlight.remove(descriptor.cacheKey) }

        guard NativeTabDocFormulaRenderer.renderHTML(
            latex: descriptor.latex,
            displayMode: descriptor.displayMode
        ) != nil else {
            failed.insert(descriptor.cacheKey)
            return nil
        }
        guard let snapshot = await NativeTabDocFormulaSnapshotter.snapshot(descriptor: descriptor) else {
            failed.insert(descriptor.cacheKey)
            return nil
        }
        images[descriptor.cacheKey] = snapshot
        return snapshot
    }
}

/// 离屏 WKWebView 常把公式画在大画布左上角。行内附件必须裁到墨迹，
/// 否则会留下空白或只露出公式一角。全透明或裁切过小视为失败，正文继续显示源码。
enum NativeTabDocFormulaSnapshotCrop {
    static func cropped(_ image: UIImage, alphaThreshold: UInt8 = 12) -> UIImage? {
        guard let cgImage = image.cgImage, cgImage.width > 0, cgImage.height > 0 else {
            return nil
        }
        let width = cgImage.width
        let height = cgImage.height
        let colorSpace = CGColorSpaceCreateDeviceRGB()
        var pixels = [UInt8](repeating: 0, count: width * height * 4)
        guard let context = CGContext(
            data: &pixels,
            width: width,
            height: height,
            bitsPerComponent: 8,
            bytesPerRow: width * 4,
            space: colorSpace,
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        ) else {
            return nil
        }
        context.draw(cgImage, in: CGRect(x: 0, y: 0, width: width, height: height))

        var minX = width
        var minY = height
        var maxX = -1
        var maxY = -1
        for y in 0..<height {
            for x in 0..<width {
                let alpha = pixels[(y * width + x) * 4 + 3]
                if alpha > alphaThreshold {
                    minX = min(minX, x)
                    minY = min(minY, y)
                    maxX = max(maxX, x)
                    maxY = max(maxY, y)
                }
            }
        }
        guard maxX >= minX, maxY >= minY, let rendered = context.makeImage() else { return nil }
        let pad = 1
        let crop = CGRect(
            x: max(minX - pad, 0),
            y: max(minY - pad, 0),
            width: min(maxX - minX + 1 + pad * 2, width - max(minX - pad, 0)),
            height: min(maxY - minY + 1 + pad * 2, height - max(minY - pad, 0))
        )
        let pointWidth = crop.width / max(image.scale, 1)
        let pointHeight = crop.height / max(image.scale, 1)
        guard pointWidth >= 8, pointHeight >= 8 else { return nil }
        guard let cropped = rendered.cropping(to: crop) else { return nil }
        return UIImage(cgImage: cropped, scale: image.scale, orientation: .up)
    }
}

extension UIColor {
    var tabDocFormulaHexString: String {
        var red: CGFloat = 0
        var green: CGFloat = 0
        var blue: CGFloat = 0
        var alpha: CGFloat = 0
        getRed(&red, green: &green, blue: &blue, alpha: &alpha)
        return String(
            format: "#%02X%02X%02X",
            Int(red * 255),
            Int(green * 255),
            Int(blue * 255)
        )
    }
}
