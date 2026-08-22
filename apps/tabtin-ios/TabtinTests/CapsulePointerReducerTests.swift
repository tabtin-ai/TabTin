import XCTest
@testable import Tabtin

final class CapsulePointerReducerTests: XCTestCase {
    func testStillHold420msOpensMenu() {
        var reducer = CapsulePointerReducer()
        reducer.handle(.touchBegan)
        XCTAssertEqual(reducer.phase, .pressing)

        reducer.handle(.holdElapsed(ms: 419))
        XCTAssertEqual(reducer.phase, .pressing)
        XCTAssertNil(reducer.pendingOutcome)

        reducer.handle(.holdElapsed(ms: 420))
        XCTAssertEqual(reducer.phase, .menuOpen)
        XCTAssertEqual(reducer.pendingOutcome, .menuOpened)
    }

    func testMoveBeyondThresholdBeforeHoldEntersDraggingAndBlocksMenu() {
        var reducer = CapsulePointerReducer()
        reducer.handle(.touchBegan)
        reducer.handle(.touchMoved(dx: 13, dy: 0))
        XCTAssertEqual(reducer.phase, .dragging)

        reducer.handle(.holdElapsed(ms: 420))
        XCTAssertEqual(reducer.phase, .dragging)
        XCTAssertNil(reducer.pendingOutcome)
    }

    func testShortReleaseWhilePressingEmitsTap() {
        var reducer = CapsulePointerReducer()
        reducer.handle(.touchBegan)
        reducer.handle(.touchEnded)
        XCTAssertEqual(reducer.phase, .idle)
        XCTAssertEqual(reducer.pendingOutcome, .tap)
    }

    func testTouchCancelledReturnsToIdle() {
        var reducer = CapsulePointerReducer()
        reducer.handle(.touchBegan)
        reducer.handle(.touchCancelled)
        XCTAssertEqual(reducer.phase, .idle)
        XCTAssertNil(reducer.pendingOutcome)
    }

    func testDragEndOnReleaseWhileDragging() {
        var reducer = CapsulePointerReducer()
        reducer.handle(.touchBegan)
        reducer.handle(.touchMoved(dx: 20, dy: 0))
        reducer.handle(.touchEnded)
        XCTAssertEqual(reducer.phase, .idle)
        XCTAssertEqual(reducer.pendingOutcome, .dragEnd)
    }

    func testMenuSelectionAndDismissReturnToIdle() {
        var reducer = CapsulePointerReducer()
        reducer.handle(.touchBegan)
        reducer.handle(.holdElapsed(ms: 420))
        XCTAssertEqual(reducer.phase, .menuOpen)

        reducer.handle(.selectMenu(.text))
        XCTAssertEqual(reducer.phase, .idle)
        XCTAssertEqual(reducer.pendingOutcome, .menuSelection(.text))

        reducer.handle(.touchBegan)
        reducer.handle(.holdElapsed(ms: 420))
        reducer.handle(.dismissMenu)
        XCTAssertEqual(reducer.phase, .idle)
        XCTAssertEqual(reducer.pendingOutcome, .menuDismissed)
    }

    func testMovingWhileMenuOpenKeepsMenuForInputSelection() {
        var reducer = CapsulePointerReducer()
        reducer.handle(.touchBegan)
        reducer.handle(.holdElapsed(ms: 420))
        XCTAssertEqual(reducer.phase, .menuOpen)

        reducer.handle(.touchMoved(dx: 0, dy: -80))
        XCTAssertEqual(reducer.phase, .menuOpen)
        XCTAssertNil(reducer.pendingOutcome)

        reducer.handle(.touchEnded)
        XCTAssertEqual(reducer.phase, .menuOpen)
        XCTAssertNil(reducer.pendingOutcome)
    }

    func testOnboardingPromptsTapOnFirstAppearanceThenDragOnNextAppearance() {
        var progress = CapsuleOnboardingProgress()
        progress.recordAppearance()

        XCTAssertEqual(progress.nextPrompt(replySuggested: false), .tap)
        progress.markPromptShown(.tap)
        progress.markLearned(.tap)
        XCTAssertNil(progress.nextPrompt(replySuggested: false))

        progress.recordAppearance()
        XCTAssertEqual(progress.nextPrompt(replySuggested: false), .drag)
    }

    func testOnboardingPrioritizesContextualHoldPromptAfterTap() {
        var progress = CapsuleOnboardingProgress(
            appearanceCount: 2,
            tapLearned: true
        )

        XCTAssertEqual(progress.nextPrompt(replySuggested: true), .hold)
        XCTAssertEqual(progress.nextPrompt(replySuggested: false), .drag)
    }

    func testOnboardingDiscoveryAndSkipSuppressFuturePrompts() {
        var progress = CapsuleOnboardingProgress(appearanceCount: 3)
        progress.markLearned(.tap)
        progress.markLearned(.drag)
        progress.markLearned(.hold)
        XCTAssertNil(progress.nextPrompt(replySuggested: true))

        progress = CapsuleOnboardingProgress(appearanceCount: 1)
        progress.skipAll()
        XCTAssertNil(progress.nextPrompt(replySuggested: true))
    }
}
