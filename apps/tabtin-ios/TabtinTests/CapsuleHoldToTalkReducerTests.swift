import XCTest
@testable import Tabtin

final class CapsuleHoldToTalkReducerTests: XCTestCase {
    func testHoldThresholdStartsRecordingAt520ms() {
        var reducer = CapsuleHoldToTalkReducer()
        reducer.handle(.pressBegan)
        reducer.handle(.pressHeld(elapsedMs: 519))
        XCTAssertEqual(reducer.phase, .pressing)
        reducer.handle(.pressHeld(elapsedMs: 520))
        XCTAssertEqual(reducer.phase, .recording)
    }

    func testSwipeUpCancelsWith56ptAndIgnores12ptJitter() {
        var reducer = CapsuleHoldToTalkReducer()
        reducer.handle(.pressBegan)
        reducer.handle(.pressHeld(elapsedMs: 520))
        reducer.handle(.fingerMoved(dx: 10, dy: -20))
        XCTAssertEqual(reducer.phase, .recording)
        reducer.handle(.fingerMoved(dx: 8, dy: -56))
        XCTAssertEqual(reducer.phase, .cancelling)
    }

    func testFirstConsentRequiresFreshPress() {
        var reducer = CapsuleHoldToTalkReducer()
        reducer.handle(.pressBegan)
        reducer.handle(.consentRequired)
        XCTAssertEqual(reducer.phase, .awaitingConsent)
        reducer.handle(.consentGrantedFirstTime)
        XCTAssertEqual(reducer.phase, .idle)
        XCTAssertTrue(reducer.requiresFreshPressAfterConsent)

        // 授权后残留 touch 不得自动续录。
        reducer.handle(.pressHeld(elapsedMs: 520))
        XCTAssertEqual(reducer.phase, .idle)

        reducer.handle(.pressBegan)
        reducer.handle(.consentAlreadyGranted)
        reducer.handle(.pressHeld(elapsedMs: 520))
        XCTAssertEqual(reducer.phase, .recording)
    }

    func testSystemCancelClearsCommand() {
        var reducer = CapsuleHoldToTalkReducer()
        reducer.handle(.pressBegan)
        XCTAssertNotNil(reducer.commandId)
        reducer.handle(.systemCancelled)
        XCTAssertEqual(reducer.phase, .idle)
        XCTAssertNil(reducer.commandId)
    }

    func testSystemCancelWhileRecordingClearsFrozenFocusAndBlocksSubmitOutcome() {
        var reducer = CapsuleHoldToTalkReducer()
        reducer.handle(.pressBegan)
        reducer.handle(.pressHeld(elapsedMs: 520))
        let focus = FocusSnapshot(
            appType: "tabdoc",
            appMeta: [
                "idField": "current_doc_id",
                "current_doc_id": "doc-1",
            ],
            openTabs: [
                FocusTab(type: "tabdoc", id: "doc-1", title: "D", active: true, app_key: "tabdoc"),
            ],
            spaceId: "s1",
            userTimeZone: "UTC",
            workspaceMode: "desktop"
        )
        reducer.freezeFocus(focus)
        XCTAssertNotNil(reducer.frozenFocus)

        let phaseBefore = reducer.phase
        reducer.handle(.systemCancelled)
        XCTAssertEqual(reducer.phase, .idle)
        XCTAssertNil(reducer.frozenFocus)
        XCTAssertEqual(
            CapsuleHoldToTalkPointerOutcome.resolve(phaseBeforeEnd: .idle),
            .ignore
        )
        // 中断前若仍是 recording，松手语义也不该再 submit——调用方靠 suppress 旗标；
        // reducer 侧中断后 phase 已 idle → ignore。
        XCTAssertEqual(phaseBefore, .recording)
        XCTAssertEqual(
            CapsuleHoldToTalkPointerOutcome.resolve(phaseBeforeEnd: phaseBefore),
            .submitRecording,
            "pre-cancel phase still maps to submit; controller must suppress after systemCancelled"
        )
    }

    func testFreezeFocusOnlyOnceWhileRecording() {
        var reducer = CapsuleHoldToTalkReducer()
        reducer.handle(.pressBegan)
        reducer.handle(.pressHeld(elapsedMs: 520))
        let focusA = FocusSnapshot(
            appType: "tabdoc",
            openTabs: [FocusTab(type: "tabdoc", id: "A", title: "A", active: true, app_key: "tabdoc")],
            spaceId: "s1",
            userTimeZone: "UTC",
            workspaceMode: "desktop"
        )
        let focusB = FocusSnapshot(
            appType: "tabdata",
            openTabs: [FocusTab(type: "tabdata", id: "B", title: "B", active: true, app_key: "tabdata")],
            spaceId: "s1",
            userTimeZone: "UTC",
            workspaceMode: "desktop"
        )
        reducer.freezeFocus(focusA)
        reducer.freezeFocus(focusB)
        XCTAssertEqual(reducer.frozenFocus?.openTabs?.first?.id, "A")
    }

    func testShortPressOutcomeIsTapBeforeConsentGate() {
        // 短点只到 pressing；同意门禁应在 ≥520ms 之后，不得因短点弹同意框。
        var reducer = CapsuleHoldToTalkReducer()
        reducer.handle(.pressBegan)
        XCTAssertEqual(reducer.phase, .pressing)
        XCTAssertEqual(
            CapsuleHoldToTalkPointerOutcome.resolve(phaseBeforeEnd: .pressing),
            .tap
        )
        XCTAssertNotEqual(reducer.phase, .awaitingConsent)
    }
}
