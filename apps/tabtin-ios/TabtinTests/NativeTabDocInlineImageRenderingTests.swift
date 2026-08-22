import UIKit
import XCTest
@testable import Tabtin

/// 行内图片「真排版」的呈现层证据（iOS）。
///
/// 身份保真由 `NativeTabDocTests` / `NativeTabDocContractFixtureTests` 覆盖；这里只回答呈现
/// 问题：图片有没有真的排进正文、加载不出来时会不会退回可读文案、以及身份是否在两种
/// 呈现下都原样存活。与 Android `DocInlineImagePresentationTest` / `DocInlineImageRenderingTest` 对称。
final class NativeTabDocInlineImageRenderingTests: XCTestCase {
    private let fixtureAttrs: [String: Any] = [
        "src": "https://oss.example.com/tabtin/demo-image.png",
        "fileId": "file-demo-0001",
        "alt": "示例图片",
        "title": "示例图片标题",
        "width": 640,
        "height": 360,
    ]

    private var fixtureImage: NativeTabDocInlineImage {
        image(attrs: fixtureAttrs)
    }

    private func image(atomId: String = "atom-1", attrs: [String: Any]) -> NativeTabDocInlineImage {
        NativeTabDocInlineImage(
            atomId: atomId,
            nodeType: "image",
            attrs: attrs.mapValues(AnyCodable.init)
        )
    }

    /// 与生产渲染同一条路径：`inlineImageAttachment` 给得出附件就走真图，给不出就退回文本。
    private func attributed(
        spans: [NativeTabDocInlineSpan],
        attachment: ((NativeTabDocInlineImage, UIFont) -> NativeTabDocInlineImageAttachment?)?
    ) -> NSAttributedString {
        NativeTabDocRichTextMarkBridge.attributedString(
            spans: spans,
            style: .body,
            textAlignment: .natural,
            traitCollection: UITraitCollection.current,
            inlineImageAttachment: attachment
        )
    }

    private func mixedSpans(_ image: NativeTabDocInlineImage? = nil) -> [NativeTabDocInlineSpan] {
        let resolved = image ?? fixtureImage
        return [
            NativeTabDocInlineSpan(text: "行内图片："),
            NativeTabDocInlineSpan(text: resolved.placeholderText, image: resolved),
            NativeTabDocInlineSpan(text: "\n硬换行后的文字。"),
        ]
    }

    /// 造一个「已加载成功」的附件，等价于缓存命中时生产代码的产物。
    private func loadedAttachment(
        for image: NativeTabDocInlineImage,
        font: UIFont,
        loaded: UIImage? = nil
    ) -> NativeTabDocInlineImageAttachment? {
        let descriptor = NativeTabDocInlineImagePresentation.descriptor(for: image)
        guard descriptor.canLoad else { return nil }
        return NativeTabDocInlineImageAttachment(
            atomId: image.atomId,
            descriptor: descriptor,
            fallbackText: NativeTabDocInlineImagePresentation.fallbackText(for: image),
            accessibilityLabel: NativeTabDocInlineImagePresentation.accessibilityLabel(for: image),
            font: font,
            textColor: .label,
            placeholderBackground: .secondarySystemBackground,
            state: .loaded(loaded ?? Self.solidImage())
        )
    }

    private func attachments(in attributed: NSAttributedString) -> [NativeTabDocInlineImageAttachment] {
        var found: [NativeTabDocInlineImageAttachment] = []
        attributed.enumerateAttributes(
            in: NSRange(location: 0, length: attributed.length),
            options: []
        ) { attributes, _, _ in
            if let attachment = NativeTabDocRichTextMarkBridge.inlineImageAttachment(in: attributes) {
                found.append(attachment)
            }
        }
        return found
    }

    /// 回采出的行内图片身份，等价于保存写回时读到的东西。
    private func harvestedImages(in attributed: NSAttributedString) -> [NativeTabDocInlineImage] {
        NativeTabDocRichTextMarkBridge
            .spans(from: attributed, baseStyle: .body)
            .compactMap(\.image)
    }

    private static func solidImage(width: CGFloat = 1920, height: CGFloat = 1080) -> UIImage {
        let size = CGSize(width: width, height: height)
        return UIGraphicsImageRenderer(size: size).image { context in
            UIColor.systemBlue.setFill()
            context.fill(CGRect(origin: .zero, size: size))
        }
    }

    // MARK: - 呈现策略（与 Android DocInlineImagePresentationTest 一一对应）

    func testDescriptorExtractsIdentityAndDeclaredIntrinsicSize() {
        let descriptor = NativeTabDocInlineImagePresentation.descriptor(for: fixtureImage)
        XCTAssertEqual(descriptor.fileId, "file-demo-0001")
        XCTAssertEqual(descriptor.source, "https://oss.example.com/tabtin/demo-image.png")
        XCTAssertEqual(descriptor.alt, "示例图片")
        XCTAssertEqual(descriptor.title, "示例图片标题")
        XCTAssertEqual(descriptor.intrinsicSize, CGSize(width: 640, height: 360))
        XCTAssertTrue(descriptor.canLoad)
    }

    func testDescriptorAcceptsSnakeCaseFileIdAndFlagsUnloadableImage() {
        let snake = NativeTabDocInlineImagePresentation.descriptor(
            for: image(attrs: ["src": "", "file_id": "file-legacy", "alt": "旧字段"])
        )
        XCTAssertEqual(snake.fileId, "file-legacy")
        XCTAssertTrue(snake.canLoad, "只有 snake_case fileId 也应当能加载")

        let empty = NativeTabDocInlineImagePresentation.descriptor(
            for: image(attrs: ["src": "", "fileId": "", "alt": "没有地址"])
        )
        XCTAssertFalse(empty.canLoad, "既没有 fileId 也没有 src 时不该发起加载")
        XCTAssertNil(empty.intrinsicSize, "没声明宽高就不该编造尺寸")
    }

    func testCacheKeyPrefersFileIdOverExpiringSignedSource() {
        let first = NativeTabDocInlineImagePresentation.Descriptor(
            fileId: "file-demo-0001",
            source: "https://oss.example.com/a.png?sig=1"
        )
        let second = NativeTabDocInlineImagePresentation.Descriptor(
            fileId: "file-demo-0001",
            source: "https://oss.example.com/a.png?sig=2"
        )
        XCTAssertEqual(
            NativeTabDocInlineImagePresentation.cacheKey(for: first),
            NativeTabDocInlineImagePresentation.cacheKey(for: second),
            "签名地址漂移不得让同一张图反复重下"
        )
        XCTAssertEqual(
            NativeTabDocInlineImagePresentation.cacheKey(
                for: .init(source: "https://oss.example.com/b.png")
            ),
            "src:https://oss.example.com/b.png"
        )
        XCTAssertNil(NativeTabDocInlineImagePresentation.cacheKey(for: .init()))
    }

    func testDeclaredSizeKeepsAspectRatioAndFitsContentWidth() {
        let size = NativeTabDocInlineImagePresentation.displaySize(
            intrinsicSize: CGSize(width: 640, height: 360),
            lineHeight: 24,
            availableWidth: 320
        )
        XCTAssertEqual(size.width, 320, "超过正文宽度必须收进正文宽度")
        XCTAssertEqual(size.height, 180, "收缩后必须保持 16:9 宽高比")
    }

    func testRoundedDisplaySizeNeverExceedsMaximumHeightOnFractionalLineHeight() {
        let lineHeight: CGFloat = 16.70703125
        let size = NativeTabDocInlineImagePresentation.displaySize(
            intrinsicSize: CGSize(width: 640, height: 360),
            lineHeight: lineHeight,
            availableWidth: 320
        )
        XCTAssertLessThanOrEqual(
            size.height,
            lineHeight * NativeTabDocInlineImagePresentation.maximumHeightInLines,
            "四舍五入后仍不得冲破 8 行上限（真机 Dynamic Type 会踩中）"
        )
        XCTAssertLessThanOrEqual(size.width, 320)
        XCTAssertEqual(size.width / size.height, 640.0 / 360.0, accuracy: 0.05)
    }

    func testMaximumHeightStopsTallImageFromSwallowingTheScreen() {
        let size = NativeTabDocInlineImagePresentation.displaySize(
            intrinsicSize: CGSize(width: 400, height: 4000),
            lineHeight: 20,
            availableWidth: 320
        )
        XCTAssertEqual(size.height, 160, "最多 8 行高，否则一行正文会撑成一屏")
        XCTAssertEqual(size.width, 16, "限高后仍须等比")
    }

    func testDeclaredSizeMakesPlaceholderAndLoadedImageIdentical() {
        let declared = CGSize(width: 640, height: 360)
        let beforeLoad = NativeTabDocInlineImagePresentation.displaySize(
            intrinsicSize: declared,
            lineHeight: 24,
            availableWidth: 320
        )
        let afterLoad = NativeTabDocInlineImagePresentation.displaySize(
            intrinsicSize: declared,
            loadedSize: CGSize(width: 1920, height: 1080),
            lineHeight: 24,
            availableWidth: 320
        )
        XCTAssertEqual(beforeLoad, afterLoad, "声明尺寸下加载前后必须同尺寸，行高不能跳变")
        XCTAssertEqual(beforeLoad, CGSize(width: 320, height: 180))
    }

    func testUndeclaredSizeLocksHeightAndUsesLoadedAspectRatio() {
        let beforeLoad = NativeTabDocInlineImagePresentation.displaySize(
            intrinsicSize: nil,
            lineHeight: 20,
            availableWidth: 320
        )
        XCTAssertEqual(
            beforeLoad,
            CGSize(width: 60, height: 60),
            "缺声明尺寸先占一个 3 行高方块"
        )

        let afterLoad = NativeTabDocInlineImagePresentation.displaySize(
            intrinsicSize: nil,
            loadedSize: CGSize(width: 200, height: 100),
            lineHeight: 20,
            availableWidth: 320
        )
        XCTAssertEqual(afterLoad.height, 60, "缺声明尺寸时高度必须锁定，避免行高跳变")
        XCTAssertEqual(afterLoad.width, 120, "宽度按实际宽高比展开")
    }

    func testFallbackTextStaysReadableAndNeverLeaksSourceOrFileId() {
        let fallback = NativeTabDocInlineImagePresentation.fallbackText(for: fixtureImage)
        XCTAssertEqual(fallback, "🖼 示例图片")
        XCTAssertFalse(fallback.contains("oss.example.com"), "降级不得泄露签名 URL")
        XCTAssertFalse(fallback.contains("file-demo-0001"), "降级不得泄露 fileId")
    }

    func testAccessibilityLabelFallsBackThroughAltThenTitle() {
        XCTAssertEqual(
            NativeTabDocInlineImagePresentation.accessibilityLabel(for: fixtureImage),
            "示例图片"
        )
        XCTAssertEqual(
            NativeTabDocInlineImagePresentation.accessibilityLabel(
                for: image(attrs: ["src": "https://x/a.png", "alt": "   ", "title": "只有标题"])
            ),
            "只有标题",
            "alt 只有空白时必须继续退到 title"
        )
        let defaulted = NativeTabDocInlineImagePresentation.accessibilityLabel(
            for: image(attrs: ["src": "https://x/a.png"])
        )
        XCTAssertFalse(defaulted.isEmpty, "无 alt/title 时仍须给读屏一个可念的标签")
        XCTAssertFalse(defaulted.contains("x/a.png"), "默认标签不得回落成地址")
    }

    // MARK: - 真排版

    func testLoadedInlineImageRendersAsAttachmentAndKeepsNeighbouringText() throws {
        var usedFont: UIFont?
        let rendered = attributed(spans: mixedSpans()) { [self] image, font in
            usedFont = font
            return loadedAttachment(for: image, font: font)
        }

        let found = attachments(in: rendered)
        XCTAssertEqual(found.count, 1, "行内图片必须排成一个 attachment，而不是 alt 文本")
        let attachment = try XCTUnwrap(found.first)
        XCTAssertEqual(attachment.atomId, "atom-1")
        XCTAssertNotNil(attachment.state.loadedImage, "缓存命中时附件必须处于已加载态")
        // 不拿被测函数自己算期望值（那是同义反复），改断言几何性质。
        let lineHeight = try XCTUnwrap(usedFont).lineHeight
        let size = attachment.displaySize(availableWidth: 320)
        XCTAssertEqual(
            size.width / size.height,
            640.0 / 360.0,
            accuracy: 0.02,
            "真图必须保持 attrs 声明的 16:9 宽高比"
        )
        XCTAssertLessThanOrEqual(size.width, 320, "不得超出正文宽度")
        XCTAssertLessThanOrEqual(
            size.height,
            lineHeight * NativeTabDocInlineImagePresentation.maximumHeightInLines,
            "不得超过最大行高，否则一行正文会撑成一屏"
        )
        XCTAssertGreaterThan(size.height, lineHeight, "真图必须比一行文字高，才谈得上真排版")

        XCTAssertTrue(rendered.string.hasPrefix("行内图片："), "同行文字必须与图片并排保留")
        XCTAssertTrue(rendered.string.hasSuffix("硬换行后的文字。"))
        XCTAssertTrue(
            rendered.string.contains(NativeTabDocRichTextMarkBridge.inlineImagePlaceholderCharacter),
            "真图在正文里只留一个附件字符"
        )
        XCTAssertFalse(rendered.string.contains("🖼"), "真图排出来后不该再显示 alt 占位串")
    }

    func testInlineImageOccupiesExactlyOneCharacterSoItStaysAnUnbreakableAtom() {
        let rendered = attributed(spans: mixedSpans()) { [self] image, font in
            loadedAttachment(for: image, font: font)
        }
        let attachmentCharacters = rendered.string.filter {
            String($0) == NativeTabDocRichTextMarkBridge.inlineImagePlaceholderCharacter
        }
        XCTAssertEqual(
            attachmentCharacters.count,
            1,
            "一张图 = 一个字符，退格才能整体删除而不是拆成半张图"
        )
    }

    func testIdentitySurvivesBothRenderedAndFallbackPresentation() throws {
        let rendered = attributed(spans: mixedSpans()) { [self] image, font in
            loadedAttachment(for: image, font: font)
        }
        let degraded = attributed(spans: mixedSpans(), attachment: nil)

        for (label, output) in [("真图", rendered), ("降级", degraded)] {
            let images = harvestedImages(in: output)
            XCTAssertEqual(images.count, 1, "\(label) 呈现下身份必须唯一存在")
            let harvested = try XCTUnwrap(images.first)
            XCTAssertEqual(harvested.atomId, "atom-1", "\(label) 呈现不得改写 atomId")
            XCTAssertEqual(harvested.nodeType, "image")
            XCTAssertEqual(harvested.attrs["fileId"]?.value as? String, "file-demo-0001")
            XCTAssertEqual(harvested.attrs["src"]?.value as? String, fixtureAttrs["src"] as? String)
            XCTAssertEqual(harvested.attrs["alt"]?.value as? String, "示例图片")
            XCTAssertEqual(harvested.attrs["title"]?.value as? String, "示例图片标题")
            XCTAssertEqual(harvested.attrs["width"]?.value as? Int, 640)
            XCTAssertEqual(harvested.attrs["height"]?.value as? Int, 360)
        }
    }

    func testHarvestedSpanRestoresPlaceholderTextSoAttachmentCharacterNeverReachesTheDocument() throws {
        let rendered = attributed(spans: mixedSpans()) { [self] image, font in
            loadedAttachment(for: image, font: font)
        }
        let spans = NativeTabDocRichTextMarkBridge.spans(from: rendered, baseStyle: .body)
        let imageSpan = try XCTUnwrap(spans.first { $0.image != nil })
        XCTAssertEqual(imageSpan.text, fixtureImage.placeholderText, "回采必须还原模型占位文本")
        XCTAssertFalse(
            imageSpan.text.contains(NativeTabDocRichTextMarkBridge.inlineImagePlaceholderCharacter),
            "U+FFFC 是呈现载体，绝不能作为正文写回文档"
        )
        XCTAssertFalse(
            spans.contains { $0.image == nil && $0.text.contains("\u{FFFC}") },
            "任何普通文本 span 里都不该混入附件字符"
        )
    }

    func testTwoInlineImagesInOneParagraphStayIndependentAtoms() {
        let second = image(
            atomId: "atom-2",
            attrs: fixtureAttrs.merging(["fileId": "file-demo-0002", "alt": "第二张"]) { _, new in new }
        )
        let spans = [
            NativeTabDocInlineSpan(text: fixtureImage.placeholderText, image: fixtureImage),
            NativeTabDocInlineSpan(text: "、"),
            NativeTabDocInlineSpan(text: second.placeholderText, image: second),
        ]
        let rendered = attributed(spans: spans) { [self] image, font in
            loadedAttachment(for: image, font: font)
        }

        XCTAssertEqual(
            attachments(in: rendered).map(\.atomId),
            ["atom-1", "atom-2"],
            "同段两张图必须各自成附件，不能被合并"
        )
        XCTAssertEqual(
            harvestedImages(in: rendered).map(\.atomId),
            ["atom-1", "atom-2"],
            "两张图的身份必须分别存活"
        )
        XCTAssertTrue(rendered.string.contains("、"), "两图之间的文字必须保留")
    }

    // MARK: - 诚实降级

    @MainActor
    func testImageWithoutAnySourceNeverBecomesAnAttachmentAndStaysReadableAltText() {
        let sourceless = image(attrs: ["src": "", "fileId": "", "alt": "缺地址的图"])
        let rendered = attributed(spans: mixedSpans(sourceless)) { image, font in
            NativeTabDocInlineImageAttachmentFactory.make(
                for: image,
                font: font,
                traitCollection: UITraitCollection.current
            )
        }
        XCTAssertTrue(
            attachments(in: rendered).isEmpty,
            "没有任何可加载地址时不该造空附件框——一行可读 alt 比空框好"
        )
        XCTAssertTrue(rendered.string.contains("🖼 缺地址的图"))
        XCTAssertEqual(harvestedImages(in: rendered).count, 1, "降级也不得丢身份")
    }

    func testFallbackPresentationKeepsAltAndNeverLeaksSourceOrFileId() {
        let degraded = attributed(spans: mixedSpans(), attachment: nil)
        XCTAssertTrue(attachments(in: degraded).isEmpty, "降级不得产生任何图片 attachment")

        let visible = degraded.string
        XCTAssertTrue(visible.contains("🖼 示例图片"), "降级必须是人能读懂的文案")
        XCTAssertFalse(visible.contains("oss.example.com"), "降级不得泄露签名 URL")
        XCTAssertFalse(visible.contains("file-demo-0001"), "降级不得泄露 fileId")
    }

    func testFailedAttachmentStillDrawsReadableFallbackInsteadOfBlankOrBrokenIcon() throws {
        let descriptor = NativeTabDocInlineImagePresentation.descriptor(for: fixtureImage)
        let attachment = NativeTabDocInlineImageAttachment(
            atomId: fixtureImage.atomId,
            descriptor: descriptor,
            fallbackText: NativeTabDocInlineImagePresentation.fallbackText(for: fixtureImage),
            accessibilityLabel: NativeTabDocInlineImagePresentation.accessibilityLabel(for: fixtureImage),
            font: .preferredFont(forTextStyle: .body),
            textColor: .label,
            placeholderBackground: .secondarySystemBackground,
            state: .failed
        )
        let drawn = attachment.image(
            forBounds: CGRect(x: 0, y: 0, width: 320, height: 180),
            textContainer: nil,
            characterIndex: 0
        )
        XCTAssertNotNil(drawn, "加载失败必须画出可读占位，不能留空白或破图标")
        XCTAssertEqual(attachment.fallbackText, "🖼 示例图片")
        XCTAssertEqual(attachment.accessibilityLabel, "示例图片", "读屏始终能念出 alt")

        attachment.apply(.loaded(Self.solidImage()))
        let loaded = try XCTUnwrap(
            attachment.image(
                forBounds: CGRect(x: 0, y: 0, width: 320, height: 180),
                textContainer: nil,
                characterIndex: 0
            )
        )
        XCTAssertEqual(loaded.size, CGSize(width: 1920, height: 1080), "加载成功后必须换成真图")
    }

    func testLoadingStateSharesTheDeclaredSizeSoSwappingInTheRealImageDoesNotReflow() {
        let descriptor = NativeTabDocInlineImagePresentation.descriptor(for: fixtureImage)
        let font = UIFont.preferredFont(forTextStyle: .body)
        let attachment = NativeTabDocInlineImageAttachment(
            atomId: fixtureImage.atomId,
            descriptor: descriptor,
            fallbackText: NativeTabDocInlineImagePresentation.fallbackText(for: fixtureImage),
            accessibilityLabel: NativeTabDocInlineImagePresentation.accessibilityLabel(for: fixtureImage),
            font: font,
            textColor: .label,
            placeholderBackground: .secondarySystemBackground,
            state: .loading
        )
        let loadingSize = attachment.displaySize(availableWidth: 320)
        attachment.apply(.loaded(Self.solidImage()))
        XCTAssertEqual(
            loadingSize,
            attachment.displaySize(availableWidth: 320),
            "声明了宽高的图，加载前后占位必须同尺寸，正文不能跳动"
        )
    }

    // MARK: - 加载缓存与失败记账

    @MainActor
    func testFailedLoadIsRememberedSoEveryBindDoesNotRetry() async {
        let store = NativeTabDocInlineImageStore()
        let descriptor = NativeTabDocInlineImagePresentation.descriptor(for: fixtureImage)
        var resolveCount = 0

        for _ in 0..<3 {
            _ = await store.image(for: descriptor) { _ in
                resolveCount += 1
                return nil
            }
        }
        XCTAssertEqual(resolveCount, 1, "失败必须记账，不能每次绑定都重试")
        XCTAssertTrue(store.hasFailed(for: descriptor))
        XCTAssertNil(store.cachedImage(for: descriptor))

        store.reset()
        _ = await store.image(for: descriptor) { _ in
            resolveCount += 1
            return nil
        }
        XCTAssertEqual(resolveCount, 2, "用户换会话或主动刷新后必须给坏图一次机会")
    }

    @MainActor
    func testUnloadableDescriptorIsNeverRequestedAndReportsFailedState() async {
        let store = NativeTabDocInlineImageStore()
        let descriptor = NativeTabDocInlineImagePresentation.descriptor(
            for: image(attrs: ["src": "", "fileId": "", "alt": "缺地址的图"])
        )
        var resolveCount = 0
        let loaded = await store.image(for: descriptor) { _ in
            resolveCount += 1
            return nil
        }
        XCTAssertNil(loaded)
        XCTAssertEqual(resolveCount, 0, "没有地址就不该发起任何请求")
        XCTAssertTrue(
            store.hasFailed(for: descriptor),
            "拿不到缓存键的图必须直接判为失败，让呈现层走 alt 文本"
        )
    }

    @MainActor
    func testPrimedImageIsServedFromCacheKeyedByFileIdAcrossSignedUrlDrift() {
        let store = NativeTabDocInlineImageStore()
        let first = NativeTabDocInlineImagePresentation.Descriptor(
            fileId: "file-demo-0001",
            source: "https://oss.example.com/a.png?sig=1"
        )
        let drifted = NativeTabDocInlineImagePresentation.Descriptor(
            fileId: "file-demo-0001",
            source: "https://oss.example.com/a.png?sig=2"
        )
        store.prime(Self.solidImage(width: 10, height: 10), for: first)
        XCTAssertNotNil(
            store.cachedImage(for: drifted),
            "签名地址换了但 fileId 没变，必须命中同一份缓存"
        )
        XCTAssertFalse(store.hasFailed(for: drifted))
    }
}

private extension NativeTabDocInlineImageAttachment.LoadState {
    var loadedImage: UIImage? {
        if case .loaded(let image) = self { return image }
        return nil
    }
}
