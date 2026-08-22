import CoreGraphics
import Foundation

/// 行内图片的呈现决策。
///
/// 身份与写回由 `NativeTabDocInlineImage.attrs` 独立承担，本类型只回答
/// 「这张图应该以什么形态出现在正文里」，不改写任何 attrs，也不生成新的引用地址。
/// 与 Android `DocInlineImagePresentation` 保持同一口径，双端排版结果必须一致。
enum NativeTabDocInlineImagePresentation {
    /// 从 attrs 抽出的呈现输入。`fileId` 是稳定引用，`source` 只是渲染期地址。
    struct Descriptor: Equatable, Sendable {
        var fileId: String = ""
        var source: String = ""
        var alt: String = ""
        var title: String = ""
        var intrinsicSize: CGSize?

        /// 没有任何可加载的地址时不必发起请求，直接走降级。
        var canLoad: Bool { !fileId.isEmpty || !source.isEmpty }
    }

    /// 行内图最多占据的行高倍数。再高就会把一行正文撑成一屏，读者失去上下文。
    static let maximumHeightInLines: CGFloat = 8
    /// 缺少内在尺寸时的方形边长（相对行高）。
    static let fallbackHeightInLines: CGFloat = 3

    static func descriptor(for image: NativeTabDocInlineImage) -> Descriptor {
        Descriptor(
            fileId: string(image.attrs["fileId"]) ?? string(image.attrs["file_id"]) ?? "",
            source: string(image.attrs["src"]) ?? "",
            alt: string(image.attrs["alt"]) ?? "",
            title: string(image.attrs["title"]) ?? "",
            intrinsicSize: intrinsicSize(for: image)
        )
    }

    /// 图片加载不出来时显示的诚实文案：只暴露 alt/title，不暴露签名地址或 fileId。
    static func fallbackText(for image: NativeTabDocInlineImage) -> String {
        image.placeholderText
    }

    /// 缓存键优先用 `fileId`：签名地址会过期漂移，同一张图会因此反复重下。
    static func cacheKey(for descriptor: Descriptor) -> String? {
        if !descriptor.fileId.isEmpty { return "file:\(descriptor.fileId)" }
        if !descriptor.source.isEmpty { return "src:\(descriptor.source)" }
        return nil
    }

    /// 无障碍标签始终可用，即使真图已经渲染出来。
    static func accessibilityLabel(for image: NativeTabDocInlineImage) -> String {
        let descriptor = descriptor(for: image)
        for candidate in [descriptor.alt, descriptor.title] {
            let trimmed = candidate.trimmingCharacters(in: .whitespacesAndNewlines)
            if !trimmed.isEmpty { return trimmed }
        }
        return L10n.TabDoc.imageDefaultAlt
    }

    /// 行内排版尺寸：按内在宽高比等比缩放，同时受正文宽度与最大行高双重约束。
    ///
    /// `intrinsicSize` 是 attrs 声明的尺寸，也是布局真源——它在图片下载之前就已知，
    /// 因此加载前后的占位框与真图完全同尺寸，行高不会跳变。只有文档没声明尺寸时才退而
    /// 求其次：锁定一个与行高成比例的高度，仅用实际解码尺寸决定宽高比。
    static func displaySize(
        intrinsicSize: CGSize?,
        loadedSize: CGSize? = nil,
        lineHeight: CGFloat,
        availableWidth: CGFloat
    ) -> CGSize {
        let safeLineHeight = max(lineHeight, 1)
        let maximumHeight = safeLineHeight * maximumHeightInLines
        let maximumWidth = max(availableWidth, 1)

        if let intrinsicSize, intrinsicSize.width > 0, intrinsicSize.height > 0 {
            return fitted(intrinsicSize, maximumWidth: maximumWidth, maximumHeight: maximumHeight)
        }

        let lockedHeight = min(safeLineHeight * fallbackHeightInLines, maximumHeight)
        guard let loadedSize, loadedSize.width > 0, loadedSize.height > 0 else {
            let side = min(lockedHeight, maximumWidth)
            return CGSize(width: max(side.rounded(), 1), height: max(side.rounded(), 1))
        }
        let aspect = loadedSize.width / loadedSize.height
        return fitted(
            CGSize(width: lockedHeight * aspect, height: lockedHeight),
            maximumWidth: maximumWidth,
            maximumHeight: lockedHeight
        )
    }

    private static func fitted(
        _ size: CGSize,
        maximumWidth: CGFloat,
        maximumHeight: CGFloat
    ) -> CGSize {
        let scale = min(1, min(maximumWidth / size.width, maximumHeight / size.height))
        // 真机 Dynamic Type 的行高常带小数。先四舍五入再夹回上限，
        // 否则 16:9 图按 8 行限高时会出现 134 > 133.65625 这种 1pt 溢出。
        return CGSize(
            width: min(max((size.width * scale).rounded(), 1), maximumWidth),
            height: min(max((size.height * scale).rounded(), 1), maximumHeight)
        )
    }

    private static func intrinsicSize(for image: NativeTabDocInlineImage) -> CGSize? {
        guard let width = number(image.attrs["width"]),
              let height = number(image.attrs["height"]),
              width > 0,
              height > 0
        else { return nil }
        return CGSize(width: width, height: height)
    }

    private static func string(_ value: AnyCodable?) -> String? {
        value?.value as? String
    }

    private static func number(_ value: AnyCodable?) -> CGFloat? {
        switch value?.value {
        case let intValue as Int: CGFloat(intValue)
        case let doubleValue as Double: CGFloat(doubleValue)
        case let numberValue as NSNumber: CGFloat(truncating: numberValue)
        default: nil
        }
    }
}
