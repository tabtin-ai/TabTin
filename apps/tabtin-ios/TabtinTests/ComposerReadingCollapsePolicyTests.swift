import XCTest
@testable import Tabtin

final class ComposerReadingCollapsePolicyTests: XCTestCase {
    // MARK: 滚动层

    func testScrollingAlwaysWantsCollapse() {
        // 滚动中即便算出「贴底」也要收——收敛会让底部 inset 变小，滚动期间信任它就会
        // 触发 收敛 → 判成贴底 → 展开 → 又不贴底 的自激抖动。
        XCTAssertTrue(
            ComposerReadingCollapsePolicy.scrollWantsCollapse(
                MessageListScrollState(isUserScrolling: true, isAtBottom: true)
            )
        )
        XCTAssertTrue(
            ComposerReadingCollapsePolicy.scrollWantsCollapse(
                MessageListScrollState(isUserScrolling: true, isAtBottom: false)
            )
        )
    }

    func testSettledAtBottomWantsExpand() {
        XCTAssertFalse(
            ComposerReadingCollapsePolicy.scrollWantsCollapse(.settledAtBottom)
        )
    }

    func testSettledInHistoryStaysCollapsed() {
        XCTAssertTrue(
            ComposerReadingCollapsePolicy.scrollWantsCollapse(
                MessageListScrollState(isUserScrolling: false, isAtBottom: false)
            )
        )
    }

    // MARK: 内容层

    func testCollapsesWhenNothingToProtect() {
        XCTAssertTrue(collapse(scrollWantsCollapse: true))
    }

    func testNeverCollapsesWhenScrollDoesNotAskFor() {
        XCTAssertFalse(collapse(scrollWantsCollapse: false))
    }

    func testKeepsExpandedWhileTyping() {
        XCTAssertFalse(collapse(scrollWantsCollapse: true, isFocused: true))
    }

    func testKeepsExpandedWithHalfWrittenDraft() {
        XCTAssertFalse(collapse(scrollWantsCollapse: true, hasDraftText: true))
    }

    func testKeepsExpandedWithPendingMaterials() {
        XCTAssertFalse(collapse(scrollWantsCollapse: true, hasAttachments: true))
        XCTAssertFalse(collapse(scrollWantsCollapse: true, hasContextRefs: true))
    }

    func testKeepsExpandedSoBlockingReasonStaysVisible() {
        XCTAssertFalse(collapse(scrollWantsCollapse: true, hasBlockingReason: true))
    }

    // MARK: 发送 / 停止主按钮

    func testKeepsSendHiddenWhileFirstSendIsInFlightEvenIfAttachmentsRemain() {
        XCTAssertEqual(
            ComposerPrimaryActionPolicy.action(
                canSubmitCurrentDraft: true,
                canCancel: false,
                sendInFlight: true
            ),
            .sending
        )
    }

    func testDoesNotExposeStopInTheSameSlotUntilArmed() {
        XCTAssertEqual(
            ComposerPrimaryActionPolicy.action(
                canSubmitCurrentDraft: false,
                canCancel: true,
                sendInFlight: false,
                stopArmed: false
            ),
            .sending
        )
        XCTAssertEqual(
            ComposerPrimaryActionPolicy.action(
                canSubmitCurrentDraft: false,
                canCancel: true,
                sendInFlight: false,
                stopArmed: true
            ),
            .stop
        )
    }

    func testIgnoresFreshCanCancelWhileSendIsStillInFlight() {
        XCTAssertEqual(
            ComposerPrimaryActionPolicy.action(
                canSubmitCurrentDraft: false,
                canCancel: true,
                sendInFlight: true,
                stopArmed: true
            ),
            .sending
        )
    }

    func testShowsSendWhenDraftIsReadyAndNothingIsInFlight() {
        XCTAssertEqual(
            ComposerPrimaryActionPolicy.action(
                canSubmitCurrentDraft: true,
                canCancel: false,
                sendInFlight: false
            ),
            .send
        )
    }

    func testShowsNothingWhenComposerIsIdle() {
        XCTAssertEqual(
            ComposerPrimaryActionPolicy.action(
                canSubmitCurrentDraft: false,
                canCancel: false,
                sendInFlight: false
            ),
            .none
        )
    }

    func testPausedRunStillShowsStopDuringSendInFlight() {
        XCTAssertEqual(
            ComposerPrimaryActionPolicy.action(
                canSubmitCurrentDraft: false,
                canCancel: true,
                sendInFlight: true,
                isPaused: true
            ),
            .stop
        )
    }

    private func collapse(
        scrollWantsCollapse: Bool,
        isFocused: Bool = false,
        hasDraftText: Bool = false,
        hasAttachments: Bool = false,
        hasContextRefs: Bool = false,
        hasBlockingReason: Bool = false
    ) -> Bool {
        ComposerReadingCollapsePolicy.shouldCollapse(
            scrollWantsCollapse: scrollWantsCollapse,
            isFocused: isFocused,
            hasDraftText: hasDraftText,
            hasAttachments: hasAttachments,
            hasContextRefs: hasContextRefs,
            hasBlockingReason: hasBlockingReason
        )
    }
}
