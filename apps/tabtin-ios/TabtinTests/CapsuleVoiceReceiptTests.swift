import XCTest
@testable import Tabtin

@MainActor
final class CapsuleVoiceReceiptTests: XCTestCase {
    private var key: String!

    override func setUp() {
        super.setUp()
        key = "test.voiceReceipt.\(UUID().uuidString)"
        TaskSurfaceCoordinator.resetPersistence(for: key)
    }

    override func tearDown() {
        TaskSurfaceCoordinator.resetPersistence(for: key)
        key = nil
        super.tearDown()
    }

    func testPersistedReceiptCarriesQueueIdAndAdvancesToAccepted() {
        let coordinator = TaskSurfaceCoordinator(persistenceKey: key)
        let queueId = "queue-capsule-1"
        coordinator.recordVoiceDispatchReceipt(.persisted(queueId: queueId))
        XCTAssertEqual(coordinator.lastVoiceDispatchReceipt?.userFacingMessage, "已保存到本机")
        XCTAssertEqual(coordinator.pendingVoiceQueueId, queueId)

        coordinator.advanceVoiceDispatchReceipt(queueId: queueId, to: .accepted(queueId: queueId))
        XCTAssertEqual(coordinator.lastVoiceDispatchReceipt?.userFacingMessage, "已送达")
        XCTAssertNil(coordinator.pendingVoiceQueueId)
    }

    func testAdvanceIgnoresMismatchedQueueId() {
        let coordinator = TaskSurfaceCoordinator(persistenceKey: key)
        coordinator.recordVoiceDispatchReceipt(.queued(queueId: "q-a"))
        coordinator.advanceVoiceDispatchReceipt(queueId: "q-b", to: .accepted(queueId: "q-b"))
        if case let .queued(id) = coordinator.lastVoiceDispatchReceipt {
            XCTAssertEqual(id, "q-a")
        } else {
            XCTFail("receipt should stay queued for original id")
        }
    }

    func testFailedReceiptKeepsPendingTranscriptOnController() {
        let controller = CapsuleVoiceCommandController()
        controller.handle(.pressBegan)
        controller.handle(.pressHeld(elapsedMs: 520))
        controller.handle(.pressEnded)
        controller.handle(.transcriptReady("把标题改成发布"))
        XCTAssertEqual(controller.phase, .readyToSubmit)
        XCTAssertEqual(controller.recoverableTranscript, "把标题改成发布")

        controller.noteSubmitFailed(reason: "发送失败")
        XCTAssertEqual(controller.recoverableTranscript, "把标题改成发布")
        XCTAssertEqual(controller.phase, .blocked(reason: "发送失败"))
    }

    func testVoiceHudVisibilityTracksPressAndRecordingPhases() {
        let controller = CapsuleVoiceCommandController()
        XCTAssertFalse(controller.showsVoiceHud)
        XCTAssertFalse(controller.isPressingVisually)

        controller.handle(.pressBegan)
        XCTAssertTrue(controller.showsVoiceHud)
        XCTAssertTrue(controller.isPressingVisually)
        XCTAssertFalse(controller.isRecordingVisually)

        controller.handle(.pressHeld(elapsedMs: 520))
        XCTAssertTrue(controller.showsVoiceHud)
        XCTAssertTrue(controller.isRecordingVisually)
        XCTAssertFalse(controller.isPressingVisually)

        controller.handle(.fingerMoved(dx: 0, dy: -56))
        XCTAssertTrue(controller.isCancelArmed)
        XCTAssertTrue(controller.showsVoiceHud)

        controller.reset()
        XCTAssertFalse(controller.showsVoiceHud)
        XCTAssertEqual(controller.liveTranscript, "")
    }

    func testReleaseWhileRecordingBecomesProcessingThenReady() {
        var reducer = CapsuleHoldToTalkReducer()
        reducer.handle(.pressBegan)
        reducer.handle(.pressHeld(elapsedMs: 520))
        XCTAssertEqual(reducer.phase, .recording)
        reducer.handle(.pressEnded)
        XCTAssertEqual(reducer.phase, .processing)
        reducer.handle(.transcriptReady("你好"))
        XCTAssertEqual(reducer.phase, .readyToSubmit)
    }

    func testCancelBeforeReleaseDoesNotSubmit() {
        var reducer = CapsuleHoldToTalkReducer()
        reducer.handle(.pressBegan)
        reducer.handle(.pressHeld(elapsedMs: 520))
        reducer.handle(.fingerMoved(dx: 0, dy: -56))
        XCTAssertEqual(reducer.phase, .cancelling)
        reducer.handle(.pressEnded)
        XCTAssertEqual(reducer.phase, .idle)
        reducer.handle(.transcriptReady("不该发送"))
        XCTAssertEqual(reducer.phase, .idle)
        XCTAssertEqual(reducer.recoverableTranscript, "不该发送")
    }

    func testShortPressOutcomeIsTapNotRecord() {
        XCTAssertEqual(
            CapsuleHoldToTalkPointerOutcome.resolve(phaseBeforeEnd: .pressing),
            .tap
        )
        XCTAssertEqual(
            CapsuleHoldToTalkPointerOutcome.resolve(phaseBeforeEnd: .recording),
            .submitRecording
        )
        XCTAssertEqual(
            CapsuleHoldToTalkPointerOutcome.resolve(phaseBeforeEnd: .cancelling),
            .cancel
        )
        XCTAssertEqual(
            CapsuleHoldToTalkPointerOutcome.resolve(phaseBeforeEnd: .awaitingConsent),
            .ignore
        )
    }

    func testConsentGrantedFirstTimeDoesNotAutoStartRecording() {
        var reducer = CapsuleHoldToTalkReducer()
        reducer.handle(.consentRequired)
        reducer.handle(.consentGrantedFirstTime)
        XCTAssertEqual(reducer.phase, .idle)
        XCTAssertTrue(reducer.requiresFreshPressAfterConsent)

        // 同意弹窗结束后残留 hold tick 不得开录。
        reducer.handle(.pressHeld(elapsedMs: 520))
        XCTAssertEqual(reducer.phase, .idle)

        reducer.handle(.consentAlreadyGranted)
        reducer.handle(.pressBegan)
        reducer.handle(.pressHeld(elapsedMs: 520))
        XCTAssertEqual(reducer.phase, .recording)
    }

    func testFailedAdvanceClearsPendingQueueIdButKeepsReceiptMessage() {
        let coordinator = TaskSurfaceCoordinator(persistenceKey: key)
        coordinator.recordVoiceDispatchReceipt(.persisted(queueId: "q-fail"))
        coordinator.advanceVoiceDispatchReceipt(
            queueId: "q-fail",
            to: .failed(reason: "发送确认超时，消息已保存在待发送队列")
        )
        XCTAssertNil(coordinator.pendingVoiceQueueId)
        XCTAssertEqual(
            coordinator.lastVoiceDispatchReceipt?.userFacingMessage,
            "发送确认超时，消息已保存在待发送队列"
        )
    }

    func testSystemCancelSuppressesSubsequentPointerEndedSubmit() {
        let controller = CapsuleVoiceCommandController()
        var submitted = false
        controller.onReadyToSubmit = { _, _ in submitted = true }

        controller.handle(.consentAlreadyGranted)
        controller.handle(.pressBegan)
        controller.handle(.pressHeld(elapsedMs: 520))
        XCTAssertEqual(controller.phase, .recording)

        controller.pointerCancelled()
        XCTAssertEqual(controller.phase, .idle)
        XCTAssertNil(controller.frozenFocus)

        // 中断后松手：不得 finishCaptureAndSubmit。
        controller.pointerEnded()
        XCTAssertFalse(submitted)
    }

    func testMissingFrozenFocusKeepsTranscriptAndDoesNotSubmit() {
        let controller = CapsuleVoiceCommandController()
        var submitted = false
        controller.onReadyToSubmit = { _, _ in submitted = true }

        controller.handle(.consentAlreadyGranted)
        controller.handle(.pressBegan)
        controller.handle(.pressHeld(elapsedMs: 520))
        // 模拟起录后 Focus 丢失（未 freeze）。
        controller.handle(.pressEnded)
        controller.handle(.transcriptReady("把标题改成发布"))
        XCTAssertEqual(controller.recoverableTranscript, "把标题改成发布")

        // finish 路径在无 frozenFocus 时应 noteSubmitFailed，不回调 onReadyToSubmit。
        // 这里直接验证控制器在 readyToSubmit 且无 focus 时的失败保留语义。
        XCTAssertNil(controller.frozenFocus)
        controller.noteSubmitFailed(reason: "焦点已失效，请重新按住说话")
        XCTAssertEqual(controller.recoverableTranscript, "把标题改成发布")
        XCTAssertFalse(submitted)
        if case let .blocked(reason) = controller.phase {
            XCTAssertTrue(reason.contains("焦点"))
        } else {
            XCTFail("expected blocked phase after missing focus")
        }
    }
}
