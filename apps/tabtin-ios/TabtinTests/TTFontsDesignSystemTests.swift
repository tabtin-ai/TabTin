import SwiftUI
import XCTest
@testable import Tabtin

/// 钉死 iOS 字号档与 Electron §2 / chatDesignTokens 的映射，防止回归到 Dynamic Type 默认点数。
final class TTFontsDesignSystemTests: XCTestCase {

    func testUIRolesMatchElectronTypographyScale() {
        XCTAssertEqual(TTFonts.Role.caption.size, 12)
        XCTAssertEqual(TTFonts.Role.caption.lineHeight, 18)

        XCTAssertEqual(TTFonts.Role.body.size, 14)
        XCTAssertEqual(TTFonts.Role.body.lineHeight, 22)

        XCTAssertEqual(TTFonts.Role.subtitle.size, 16)
        XCTAssertEqual(TTFonts.Role.subtitle.lineHeight, 24)

        XCTAssertEqual(TTFonts.Role.title.size, 20)
        XCTAssertEqual(TTFonts.Role.title.lineHeight, 28)

        XCTAssertEqual(TTFonts.Role.heading.size, 24)
        XCTAssertEqual(TTFonts.Role.heading.lineHeight, 32)

        XCTAssertEqual(TTFonts.Role.display.size, 32)
        XCTAssertEqual(TTFonts.Role.display.lineHeight, 40)
    }

    func testMetaRoleMatchesComposerMeta() {
        XCTAssertEqual(TTFonts.Role.meta.size, 13)
        XCTAssertEqual(TTFonts.Role.meta.lineHeight, 18)
    }

    func testConversationReadingMetricsMatchChatDesignTokens() {
        XCTAssertEqual(ConversationTypography.bodySize, 15)
        XCTAssertEqual(ConversationTypography.stepLineHeight, 22)
        XCTAssertEqual(ConversationTypography.bodyLineHeightMultiple, 1.7, accuracy: 0.001)
        XCTAssertGreaterThan(ConversationTypography.bodyLineSpacing, 0)
        XCTAssertGreaterThanOrEqual(ConversationTypography.stepLineSpacing, 0)
    }

    func testComposerTextViewKeepsSingleLineCompactAndCapsLongDrafts() {
        XCTAssertEqual(ComposerTextViewMetrics.minimumHeight, 38)
        XCTAssertEqual(ComposerTextViewMetrics.resolvedHeight(for: 20), 38)
        XCTAssertEqual(ComposerTextViewMetrics.resolvedHeight(for: 84), 84)
        XCTAssertEqual(ComposerTextViewMetrics.resolvedHeight(for: 400), 136)
        XCTAssertFalse(ComposerTextViewMetrics.shouldScroll(for: 136))
        XCTAssertTrue(ComposerTextViewMetrics.shouldScroll(for: 137))
    }

    @MainActor
    func testComposerTextViewMeasuresContentInsteadOfCurrentScrollableFrame() {
        let textView = UITextView(frame: CGRect(x: 0, y: 0, width: 320, height: 136))
        textView.font = UIFont.systemFont(ofSize: ConversationTypography.bodySize)
        textView.textContainerInset = UIEdgeInsets(
            top: TTSpacing.sm,
            left: TTSpacing.sm,
            bottom: TTSpacing.sm,
            right: TTSpacing.sm
        )
        textView.textContainer.lineFragmentPadding = 0
        textView.isScrollEnabled = true
        textView.text = "单行草稿"

        let singleLineHeight = ComposerTextViewMetrics.contentHeight(for: textView, width: 320)
        XCTAssertEqual(ComposerTextViewMetrics.resolvedHeight(for: singleLineHeight), 38)
        XCTAssertFalse(ComposerTextViewMetrics.shouldScroll(for: singleLineHeight))

        textView.text = Array(repeating: "多行草稿", count: 12).joined(separator: "\n")
        let longDraftHeight = ComposerTextViewMetrics.contentHeight(for: textView, width: 320)
        XCTAssertGreaterThan(longDraftHeight, ComposerTextViewMetrics.maximumHeight)
        XCTAssertTrue(ComposerTextViewMetrics.shouldScroll(for: longDraftHeight))
    }

    @MainActor
    func testComposerTextChangeDoesNotResignFirstResponder() {
        var text = ""
        var focused = false
        let focusRequest = UUID()
        let sut = ScrollableComposerTextView(
            text: Binding(get: { text }, set: { text = $0 }),
            isEditable: true,
            isFocused: Binding(get: { focused }, set: { focused = $0 }),
            focusRequest: focusRequest
        )
        let coordinator = sut.makeCoordinator()
        let textView = UITextView()
        let controller = UIViewController()
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 390, height: 844))
        window.rootViewController = controller
        controller.view.addSubview(textView)
        window.makeKeyAndVisible()

        XCTAssertTrue(coordinator.fulfillFocusRequest(focusRequest, on: textView))
        coordinator.textViewDidBeginEditing(textView)
        textView.text = "你"
        coordinator.textViewDidChange(textView)

        XCTAssertEqual(text, "你")
        XCTAssertTrue(focused)
        XCTAssertTrue(textView.isFirstResponder)

        window.isHidden = true
    }

    @MainActor
    func testComposerReturnKeyAllowsNewlineInDraft() {
        var draft = ""
        var focused = false
        let sut = ScrollableComposerTextView(
            text: Binding(get: { draft }, set: { draft = $0 }),
            isEditable: true,
            isFocused: Binding(get: { focused }, set: { focused = $0 }),
            focusRequest: nil
        )
        let coordinator = sut.makeCoordinator()
        let textView = UITextView()

        XCTAssertTrue(
            coordinator.textView(
                textView,
                shouldChangeTextIn: NSRange(location: 0, length: 0),
                replacementText: "\n"
            )
        )

        textView.text = "第一行\n第二行"
        coordinator.textViewDidChange(textView)
        XCTAssertEqual(draft, "第一行\n第二行")
    }

    func testLineSpacingHelperIsNonNegative() {
        for role in TTFonts.Role.allCases {
            XCTAssertGreaterThanOrEqual(TTFonts.lineSpacing(for: role), 0, "\(role)")
        }
    }

    func testInteractiveRadiusMatchesElectron() {
        XCTAssertEqual(TTRadius.interactive, 8)
        XCTAssertEqual(TTRadius.interactive, TTRadius.sm)
    }

    func testIconFontsShareTextRolePointSizes() {
        XCTAssertEqual(TTFonts.Role.caption.size, 12)
        XCTAssertEqual(TTFonts.Role.body.size, 14)
        XCTAssertEqual(TTFonts.Role.subtitle.size, 16)
        // 图标 token 必须存在且可被 SwiftUI Image 使用（编译期契约；运行时只断言角色点数）。
        _ = Font.tt.iconCaption
        _ = Font.tt.iconCaptionMedium
        _ = Font.tt.iconBody
        _ = Font.tt.iconBodyMedium
        _ = Font.tt.iconSubtitle
        _ = Font.tt.iconSubtitleMedium
    }

    func testDecorativeIconSizesArePinned() {
        XCTAssertEqual(TTFonts.DecorativeIcon.feature.size, 22)
        XCTAssertEqual(TTFonts.DecorativeIcon.empty.size, 28)
        XCTAssertEqual(TTFonts.DecorativeIcon.emptyMD.size, 34)
        XCTAssertEqual(TTFonts.DecorativeIcon.emptyLG.size, 40)
        XCTAssertEqual(TTFonts.DecorativeIcon.hero.size, 48)
        XCTAssertEqual(TTFonts.DecorativeIcon.splash.size, 64)

        _ = Font.tt.iconFeature
        _ = Font.tt.iconEmpty
        _ = Font.tt.iconEmptyMD
        _ = Font.tt.iconEmptyLG
        _ = Font.tt.iconEmptyHero
        _ = Font.tt.iconEmptySplash
    }
}
