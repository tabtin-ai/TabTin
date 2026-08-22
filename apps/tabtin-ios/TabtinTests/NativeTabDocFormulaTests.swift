import UIKit
import XCTest
@testable import Tabtin

@MainActor
final class NativeTabDocFormulaTests: XCTestCase {
    func testKatexRenderToStringMatchesDesktopOptions() throws {
        let html = try XCTUnwrap(
            NativeTabDocFormulaRenderer.renderHTML(latex: "E = mc^2", displayMode: false)
        )
        XCTAssertTrue(NativeTabDocFormulaRenderer.looksRendered(html))
        XCTAssertTrue(html.contains("katex"))
        XCTAssertFalse(html.contains("$E = mc^2$"))
        XCTAssertFalse(html.localizedCaseInsensitiveContains("mathematics"))
        XCTAssertEqual(NativeTabDocFormulaRenderer.katexVersion, "0.16.28")
    }

    func testInvalidLatexDoesNotThrowAndStillLooksLikeKatex() {
        let html = NativeTabDocFormulaRenderer.renderHTML(
            latex: "\\notARealCommand{??}",
            displayMode: false
        )
        // throwOnError: false —— 非法公式也要有 HTML，不能空白或崩。
        XCTAssertNotNil(html)
        XCTAssertTrue(NativeTabDocFormulaRenderer.looksRendered(html ?? ""))
    }

    func testEmptyLatexDoesNotRender() {
        XCTAssertNil(NativeTabDocFormulaRenderer.renderHTML(latex: "", displayMode: false))
        XCTAssertNil(NativeTabDocFormulaRenderer.renderHTML(latex: "   ", displayMode: true))
    }

    func testInlineAttachmentCoversAtomWithoutRewritingIdentity() throws {
        let mathematics = NativeTabDocInlineMathematics(
            atomId: "atom-e",
            nodeType: "mathematics",
            valueAttribute: "latex",
            attrs: [
                "latex": AnyCodable("E = mc^2"),
                "display": AnyCodable(false),
            ],
            sourceText: "E = mc^2"
        )
        let spans = [
            NativeTabDocInlineSpan(text: "质能方程 "),
            NativeTabDocInlineSpan(text: "E = mc^2", mathematics: mathematics),
            NativeTabDocInlineSpan(text: "。"),
        ]
        let traits = UITraitCollection(userInterfaceStyle: .light)
        let store = NativeTabDocFormulaStore()
        let image = UIGraphicsImageRenderer(size: CGSize(width: 20, height: 12)).image { context in
            UIColor.black.setFill()
            context.fill(CGRect(x: 0, y: 0, width: 20, height: 12))
        }
        let attributes = NativeTabDocRichTextMarkBridge.attributes(
            for: [],
            mathematics: mathematics,
            style: .body,
            traitCollection: traits
        )
        let font = try XCTUnwrap(attributes[.font] as? UIFont)
        store.prime(
            image,
            for: NativeTabDocFormulaRenderer.Descriptor(
                latex: "E = mc^2",
                displayMode: false,
                fontSize: font.pointSize,
                textColorHex: TTColors.textPrimaryUI.resolvedColor(with: traits).tabDocFormulaHexString
            )
        )
        let rendered = NativeTabDocRichTextMarkBridge.attributedString(
            spans: spans,
            style: .body,
            textAlignment: .natural,
            traitCollection: traits,
            inlineImageAttachment: nil,
            inlineFormulaAttachment: { math, attachmentFont in
                NativeTabDocFormulaAttachmentFactory.make(
                    for: math,
                    font: attachmentFont,
                    traitCollection: traits,
                    store: store
                )
            }
        )
        var attachments = 0
        rendered.enumerateAttribute(
            .attachment,
            in: NSRange(location: 0, length: rendered.length)
        ) { value, _, _ in
            if value is NativeTabDocFormulaAttachment { attachments += 1 }
        }
        XCTAssertEqual(attachments, 1)
        XCTAssertTrue(rendered.string.contains("质能方程"))
        XCTAssertTrue(rendered.string.contains("。"))
        XCTAssertFalse(rendered.string.contains("E = mc^2"))

        let recovered = NativeTabDocRichTextMarkBridge.spans(from: rendered, baseStyle: .body)
        let recoveredMath = try XCTUnwrap(recovered.first(where: { $0.mathematics != nil }))
        XCTAssertEqual(recoveredMath.mathematics?.sourceText, "E = mc^2")
        XCTAssertEqual(recoveredMath.mathematics?.attrs["display"]?.value as? Bool, false)
        XCTAssertNotEqual(recoveredMath.text, NativeTabDocInlineSpan.attachmentPlaceholderCharacter)
    }

    func testMissingStoreFallsBackToReadableLatex() {
        let mathematics = NativeTabDocInlineMathematics(
            atomId: "atom-e",
            nodeType: "mathematics",
            valueAttribute: "latex",
            attrs: ["latex": AnyCodable("E = mc^2"), "display": AnyCodable(false)],
            sourceText: "E = mc^2"
        )
        let rendered = NativeTabDocRichTextMarkBridge.attributedString(
            spans: [NativeTabDocInlineSpan(text: "E = mc^2", mathematics: mathematics)],
            style: .body,
            textAlignment: .natural,
            traitCollection: UITraitCollection(userInterfaceStyle: .light),
            inlineImageAttachment: nil,
            inlineFormulaAttachment: { math, font in
                NativeTabDocFormulaAttachmentFactory.make(
                    for: math,
                    font: font,
                    traitCollection: UITraitCollection(userInterfaceStyle: .light)
                )
            }
        )
        XCTAssertTrue(rendered.string.contains("E = mc^2"))
        var attachments = 0
        rendered.enumerateAttribute(
            .attachment,
            in: NSRange(location: 0, length: rendered.length)
        ) { value, _, _ in
            if value is NativeTabDocFormulaAttachment { attachments += 1 }
        }
        XCTAssertEqual(attachments, 0)
    }

    func testSnapshotCropKeepsOnlyInkedFormulaNotOffscreenCanvas() throws {
        let canvas = CGSize(width: 640, height: 240)
        let ink = CGRect(x: 0, y: 0, width: 48, height: 18)
        let image = UIGraphicsImageRenderer(size: canvas).image { context in
            UIColor.clear.setFill()
            context.fill(CGRect(origin: .zero, size: canvas))
            UIColor.black.setFill()
            context.fill(ink)
        }
        let cropped = try XCTUnwrap(NativeTabDocFormulaSnapshotCrop.cropped(image))
        XCTAssertLessThan(cropped.size.width, 80)
        XCTAssertLessThan(cropped.size.height, 40)
        XCTAssertGreaterThanOrEqual(cropped.size.width, 48)
        XCTAssertGreaterThanOrEqual(cropped.size.height, 18)
    }

    func testPaintPageDoesNotReloadKatexAndKeepsFormulaHost() {
        let page = NativeTabDocFormulaRenderer.paintPageHTML(textColorHex: "#111111", fontSize: 16)
        XCTAssertTrue(page.contains("katex.min.css"))
        XCTAssertTrue(page.contains("id=\"formula\""))
        XCTAssertFalse(page.contains("katex.min.js"))
        XCTAssertFalse(page.contains("renderToString"))
    }

    func testBlankSnapshotCropFailsSoSourceStaysVisible() {
        let image = UIGraphicsImageRenderer(size: CGSize(width: 640, height: 240)).image { context in
            UIColor.clear.setFill()
            context.fill(CGRect(x: 0, y: 0, width: 640, height: 240))
        }
        XCTAssertNil(NativeTabDocFormulaSnapshotCrop.cropped(image))
    }

    func testTinySnapshotCropFailsSoSourceStaysVisible() {
        let image = UIGraphicsImageRenderer(size: CGSize(width: 640, height: 240)).image { context in
            UIColor.clear.setFill()
            context.fill(CGRect(x: 0, y: 0, width: 640, height: 240))
            UIColor.black.setFill()
            context.fill(CGRect(x: 0, y: 0, width: 4, height: 4))
        }
        XCTAssertNil(NativeTabDocFormulaSnapshotCrop.cropped(image))
    }
}
