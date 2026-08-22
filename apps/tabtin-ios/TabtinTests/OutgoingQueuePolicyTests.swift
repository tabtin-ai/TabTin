import XCTest
@testable import Tabtin

final class OutgoingQueuePolicyTests: XCTestCase {
    func testCancelledRunIdentityFiltersOnlyOldRunTail() {
        let identity = ConversationCancelledRunIdentity(
            clientEventId: "old-client",
            taskId: "old-task"
        )

        XCTAssertTrue(identity.matches(sourceClientEventId: "old-client", taskId: nil))
        XCTAssertTrue(identity.matches(sourceClientEventId: nil, taskId: "old-task"))
        XCTAssertFalse(identity.matches(sourceClientEventId: "new-client", taskId: "new-task"))
    }

    func testQueueActionsKeepUnsentRemovalSeparateFromAcceptedTracking() {
        let expected: [(QueuedOutgoingMessageStatus, OutgoingQueueLocalAction?, OutgoingQueueLocalAction?)] = [
            (.waiting, .removeUnsent, nil),
            (.offline, .retry, .removeUnsent),
            (.sending, nil, nil),
            (.accepted, .hideAcceptedTracking, nil),
            (.awaitingDevice, .hideAcceptedTracking, nil),
            (.persistedExecutionFailed, .hideAcceptedTracking, nil),
            (.failed, .retry, .removeUnsent),
        ]

        for (status, primary, secondary) in expected {
            let actions = OutgoingQueuePolicy.presentation(for: status, queueCount: 1).actions
            XCTAssertEqual(actions.primaryAction, primary, "\(status)")
            XCTAssertEqual(actions.secondaryAction, secondary, "\(status)")
        }
    }

    func testAcceptedAndAwaitingDeviceCopyNamesLocalTrackingRatherThanCancellation() {
        for status in [QueuedOutgoingMessageStatus.accepted, .awaitingDevice] {
            let presentation = OutgoingQueuePolicy.presentation(for: status, queueCount: 1)
            XCTAssertEqual(presentation.actions.primaryAction, .hideAcceptedTracking)
            XCTAssertTrue(presentation.fallbackDetail.contains("仅影响本机跟踪"))
            XCTAssertEqual(presentation.label(for: .hideAcceptedTracking), "隐藏本机跟踪")
        }
    }

    func testAcceptedDeliveryRemainsWaitingUntilExecutionIsObserved() {
        let accepted = OutgoingQueuePolicy.presentation(for: .accepted, queueCount: 1)
        let awaitingDevice = OutgoingQueuePolicy.presentation(for: .awaitingDevice, queueCount: 1)

        XCTAssertEqual(accepted.title, "消息已送达，正在确认执行状态")
        XCTAssertEqual(accepted.iconName, "clock")
        XCTAssertEqual(accepted.tone, .warning)
        XCTAssertTrue(accepted.fallbackDetail.contains("尚未确认 Agent 已开始处理"))
        XCTAssertEqual(awaitingDevice.tone, .warning)
    }

    func testAwaitingDeviceUsesCompactTotalCountWithoutClaimingEveryItemWaitsForDevice() {
        let presentation = OutgoingQueuePolicy.presentation(
            for: .awaitingDevice,
            queueCount: 3
        )

        XCTAssertEqual(presentation.title, "消息已送达，等待执行设备接手（队列共 3 条）")
    }

    func testAcknowledgedDeliveryUsesExecutionStateForDeviceWaiting() {
        XCTAssertEqual(
            OutgoingQueuePolicy.statusForAcknowledgedDelivery(
                delivery: "persisted",
                executionState: "awaiting_device"
            ),
            .awaitingDevice
        )
        XCTAssertEqual(
            OutgoingQueuePolicy.statusForAcknowledgedDelivery(
                delivery: "persisted",
                executionState: "waiting_for_device"
            ),
            .awaitingDevice
        )
        XCTAssertEqual(
            OutgoingQueuePolicy.statusForAcknowledgedDelivery(
                delivery: "persisted",
                executionState: "device_offline"
            ),
            .awaitingDevice
        )
        XCTAssertEqual(
            OutgoingQueuePolicy.statusForAcknowledgedDelivery(
                delivery: "persisted",
                executionState: "running"
            ),
            .accepted
        )
        XCTAssertEqual(
            OutgoingQueuePolicy.statusForAcknowledgedDelivery(
                delivery: "accepted",
                executionState: nil
            ),
            .accepted
        )
        XCTAssertEqual(
            OutgoingQueuePolicy.statusForAcknowledgedDelivery(
                delivery: "persisted",
                executionState: "failed_after_persist"
            ),
            .persistedExecutionFailed
        )
    }

    func testAcknowledgedDeliveryDoesNotTreatUnknownExecutionOrDeliveryAsAwaitingDevice() {
        for unknownState in ["not_started", "pending_device", "offline"] {
            XCTAssertEqual(
                OutgoingQueuePolicy.statusForAcknowledgedDelivery(
                    delivery: "persisted",
                    executionState: unknownState
                ),
                .accepted,
                "execution_state=\(unknownState) should stay accepted"
            )
        }
        XCTAssertEqual(
            OutgoingQueuePolicy.statusForAcknowledgedDelivery(
                delivery: "offline",
                executionState: nil
            ),
            .accepted,
            "delivery alone must not flip to awaitingDevice"
        )
    }

    func testStripVisibilitySilencesHappyPathAndRequiresBusyAgentForWaiting() {
        XCTAssertTrue(OutgoingQueuePolicy.shouldPresentStrip(for: .offline, agentBusy: false))
        XCTAssertTrue(OutgoingQueuePolicy.shouldPresentStrip(for: .failed, agentBusy: false))
        XCTAssertTrue(OutgoingQueuePolicy.shouldPresentStrip(for: .persistedExecutionFailed, agentBusy: false))

        XCTAssertFalse(OutgoingQueuePolicy.shouldPresentStrip(for: .waiting, agentBusy: false))
        XCTAssertTrue(OutgoingQueuePolicy.shouldPresentStrip(for: .waiting, agentBusy: true))

        XCTAssertFalse(OutgoingQueuePolicy.shouldPresentStrip(for: .sending, agentBusy: true))
        XCTAssertFalse(OutgoingQueuePolicy.shouldPresentStrip(for: .accepted, agentBusy: true))
        XCTAssertFalse(OutgoingQueuePolicy.shouldPresentStrip(for: .awaitingDevice, agentBusy: true))
    }

    func testStripMessagesSkipsSilentHeadAndSurfacesLaterOffline() {
        let accepted = QueuedOutgoingMessage(
            id: "a",
            clientEventId: "c1",
            sessionId: "s",
            text: "ok",
            modelId: nil,
            agentMode: nil,
            blocks: nil,
            createdAt: Date(),
            status: .accepted,
            attemptCount: 0,
            lastError: nil,
            serverMessageId: nil,
            taskId: nil
        )
        let offline = QueuedOutgoingMessage(
            id: "b",
            clientEventId: "c2",
            sessionId: "s",
            text: "retry",
            modelId: nil,
            agentMode: nil,
            blocks: nil,
            createdAt: Date(),
            status: .offline,
            attemptCount: 1,
            lastError: "device_offline",
            serverMessageId: nil,
            taskId: nil
        )
        let visible = OutgoingQueuePolicy.stripMessages([accepted, offline], agentBusy: false)
        XCTAssertEqual(visible.map(\.id), ["b"])
        XCTAssertEqual(
            OutgoingQueuePolicy.displayDetail(lastError: offline.lastError, fallback: "fallback"),
            "执行设备暂未在线。"
        )
        XCTAssertEqual(
            OutgoingQueuePolicy.displayDetail(lastError: "[device_offline] x", fallback: "fallback"),
            "执行设备暂未在线。"
        )
    }

    func testWaitingCopyExplainsPostReplyDeliveryWhenVisible() {
        let single = OutgoingQueuePolicy.presentation(for: .waiting, queueCount: 1)
        let multiple = OutgoingQueuePolicy.presentation(for: .waiting, queueCount: 3)

        XCTAssertEqual(single.title, "消息已排队，当前回复结束后发送")
        XCTAssertEqual(multiple.title, "3 条消息排队中，当前回复结束后发送")
    }

    func testBusyStripKeepsFIFOOrderAndPreviews() {
        let first = QueuedOutgoingMessage(
            id: "q1",
            clientEventId: "c1",
            sessionId: "s",
            text: "先改首页文案",
            modelId: nil,
            agentMode: nil,
            blocks: nil,
            createdAt: Date(),
            status: .waiting,
            attemptCount: 0,
            lastError: nil,
            serverMessageId: nil,
            taskId: nil
        )
        let second = QueuedOutgoingMessage(
            id: "q2",
            clientEventId: "c2",
            sessionId: "s",
            text: "再补安卓截图",
            modelId: nil,
            agentMode: nil,
            blocks: nil,
            createdAt: Date().addingTimeInterval(1),
            status: .waiting,
            attemptCount: 0,
            lastError: nil,
            serverMessageId: nil,
            taskId: nil
        )
        let visible = OutgoingQueuePolicy.stripMessages([first, second], agentBusy: true)
        XCTAssertEqual(visible.map(\.id), ["q1", "q2"])
        XCTAssertEqual(visible.map(\.previewText), ["先改首页文案", "再补安卓截图"])
    }

    func testPersistedExecutionFailureIsCriticalAndCanOnlyHideLocalTracking() {
        let presentation = OutgoingQueuePolicy.presentation(
            for: .persistedExecutionFailed,
            queueCount: 1
        )

        XCTAssertEqual(presentation.title, "消息已保存，但执行未启动")
        XCTAssertEqual(presentation.tone, .critical)
        XCTAssertEqual(presentation.actions.primaryAction, .hideAcceptedTracking)
        XCTAssertNil(presentation.actions.secondaryAction)
        XCTAssertFalse(presentation.actions.allows(.retry))
        XCTAssertFalse(presentation.actions.allows(.removeUnsent))
    }

    func testOnlyRecoverableUnsentStatusesParticipateInAutomaticFIFODrain() {
        XCTAssertTrue(OutgoingQueuePolicy.isAutoDrainEligible(.waiting))
        XCTAssertTrue(OutgoingQueuePolicy.isAutoDrainEligible(.offline))
        XCTAssertTrue(OutgoingQueuePolicy.isAutoDrainEligible(.sending))
        XCTAssertFalse(OutgoingQueuePolicy.isAutoDrainEligible(.accepted))
        XCTAssertFalse(OutgoingQueuePolicy.isAutoDrainEligible(.awaitingDevice))
        XCTAssertFalse(OutgoingQueuePolicy.isAutoDrainEligible(.persistedExecutionFailed))
        XCTAssertFalse(OutgoingQueuePolicy.isAutoDrainEligible(.failed))
    }

    func testUnattributedVisibleAssistantEventsCanConfirmCurrentAcceptedSend() {
        let clientEventId = "client-1"

        for eventType in [
            AgentStreamEvent.fullType(AgentStreamEvent.messageStart),
            AgentStreamEvent.fullType(AgentStreamEvent.contentBlockStart),
            AgentStreamEvent.fullType(AgentStreamEvent.contentBlockDelta),
            AgentStreamEvent.fullType(AgentStreamEvent.messageStop),
        ] {
            XCTAssertTrue(
                OutgoingQueuePolicy.isUnattributedExecutionEvidence(
                    eventType: eventType,
                    sourceClientEventId: nil,
                    activeClientEventId: clientEventId
                ),
                eventType
            )
        }
    }

    func testNoiseEventsDoNotConfirmAcceptedSendWithoutSourceClientEventId() {
        let clientEventId = "client-1"

        for eventType in [
            AgentStreamEvent.fullType(AgentStreamEvent.user),
            AgentStreamEvent.fullType(AgentStreamEvent.lifecycle),
            AgentStreamEvent.fullType(AgentStreamEvent.systemNotice),
            AgentStreamEvent.fullType(AgentStreamEvent.messageCommitted),
            "tick",
        ] {
            XCTAssertFalse(
                OutgoingQueuePolicy.isUnattributedExecutionEvidence(
                    eventType: eventType,
                    sourceClientEventId: nil,
                    activeClientEventId: clientEventId
                ),
                eventType
            )
        }
    }

    func testExplicitDifferentSourceClientEventIdBlocksUnattributedFallback() {
        XCTAssertFalse(
            OutgoingQueuePolicy.isUnattributedExecutionEvidence(
                eventType: AgentStreamEvent.fullType(AgentStreamEvent.contentBlockDelta),
                sourceClientEventId: "other-client",
                activeClientEventId: "client-1"
            )
        )
    }

    func testStopRequestNeedsAcknowledgementBeforeTerminalConfirmation() {
        XCTAssertTrue(
            ConversationStopRequestPolicy.canRequest(
                hasActiveRun: true,
                isPaused: false,
                state: .idle
            )
        )
        XCTAssertFalse(
            ConversationStopRequestPolicy.canRequest(
                hasActiveRun: true,
                isPaused: false,
                state: .requesting
            )
        )
        XCTAssertEqual(
            ConversationStopRequestPolicy.state(after: .acknowledged),
            .acknowledgedAwaitingTerminal
        )
        XCTAssertEqual(
            ConversationStopRequestPolicy.message(for: .acknowledged),
            nil
        )
        XCTAssertEqual(
            ConversationStopRequestPolicy.state(after: .timedOut),
            .failed
        )
    }

    // MARK: -  pause ACK ≠ runtime paused

    func testPauseAckKeepsPendingAndDoesNotClaimRuntimeStopped() {
        let next = PauseControlPolicy.afterAck(
            requestedPause: true,
            ackSucceeded: true,
            currentlyPaused: false,
            currentlyPending: true
        )
        XCTAssertFalse(next.isPaused)
        XCTAssertTrue(next.isPauseControlPending)
    }

    func testResumeAckClearsPauseImmediately() {
        let next = PauseControlPolicy.afterAck(
            requestedPause: false,
            ackSucceeded: true,
            currentlyPaused: true,
            currentlyPending: true
        )
        XCTAssertFalse(next.isPaused)
        XCTAssertFalse(next.isPauseControlPending)
    }

    func testFailedPauseAckDropsPending() {
        let next = PauseControlPolicy.afterAck(
            requestedPause: true,
            ackSucceeded: false,
            currentlyPaused: false,
            currentlyPending: true
        )
        XCTAssertFalse(next.isPaused)
        XCTAssertFalse(next.isPauseControlPending)
    }

    func testRunStatePausedIsTheOnlyReachedPauseSignal() {
        let paused = PauseControlPolicy.afterRunState(.paused, currentlyPending: true)
        XCTAssertTrue(paused.isPaused)
        XCTAssertFalse(paused.isPauseControlPending)

        let running = PauseControlPolicy.afterRunState(.running, currentlyPending: true)
        XCTAssertFalse(running.isPaused)
        XCTAssertTrue(running.isPauseControlPending)

        let completed = PauseControlPolicy.afterRunState(.completed, currentlyPending: true)
        XCTAssertFalse(completed.isPaused)
        XCTAssertFalse(completed.isPauseControlPending)
    }

    func testSessionRequestedPauseRestoresPendingWhenRunStateStillRunning() {
        let restoring = PauseControlPolicy.afterRunState(
            .running,
            currentlyPending: false,
            sessionRequestedPause: true
        )
        XCTAssertFalse(restoring.isPaused)
        XCTAssertTrue(restoring.isPauseControlPending)

        let reached = PauseControlPolicy.afterRunState(
            .paused,
            currentlyPending: false,
            sessionRequestedPause: true
        )
        XCTAssertTrue(reached.isPaused)
        XCTAssertFalse(reached.isPauseControlPending)

        let terminal = PauseControlPolicy.afterRunState(
            .completed,
            currentlyPending: false,
            sessionRequestedPause: true
        )
        XCTAssertFalse(terminal.isPaused)
        XCTAssertFalse(terminal.isPauseControlPending)
    }

    func testRejectsStopInTheSameGestureWindowAsSend() {
        XCTAssertFalse(
            ConversationStopRequestPolicy.canRequest(
                hasActiveRun: true,
                isPaused: false,
                state: .idle,
                elapsedSinceCanCancel: 0.09
            )
        )
        XCTAssertTrue(
            ConversationStopRequestPolicy.canRequest(
                hasActiveRun: true,
                isPaused: false,
                state: .idle,
                elapsedSinceCanCancel: ConversationStopRequestPolicy.accidentalStopGrace
            )
        )
        XCTAssertTrue(
            ConversationStopRequestPolicy.canRequest(
                hasActiveRun: true,
                isPaused: false,
                state: .idle
            )
        )
    }

    func testPausedRunCanStillStopDuringSendGrace() {
        XCTAssertTrue(
            ConversationStopRequestPolicy.canRequest(
                hasActiveRun: true,
                isPaused: true,
                state: .idle,
                elapsedSinceCanCancel: 0.09
            )
        )
    }

    func testPausePendingDoesNotBlockStop() {
        XCTAssertTrue(
            ConversationStopRequestPolicy.canRequest(
                hasActiveRun: true,
                isPaused: false,
                state: .idle,
                pauseControlPending: true
            )
        )
        XCTAssertTrue(
            ConversationStopRequestPolicy.canRequest(
                hasActiveRun: false,
                isPaused: false,
                state: .idle,
                pauseControlPending: true
            )
        )
        XCTAssertFalse(
            ConversationStopRequestPolicy.canRequest(
                hasActiveRun: false,
                isPaused: false,
                state: .idle,
                pauseControlPending: false
            )
        )
    }

    // MARK: -  withdraw_applied 终态对账门控

    func testWithdrawAppliedTrueExemptsTerminalReconcile() {
        let clientEventId = "client-evt-withdraw-1"
        var gate = WithdrawTerminalReconcilePolicy.beginWithdraw(clientEventId: clientEventId)
        XCTAssertFalse(WithdrawTerminalReconcilePolicy.shouldSuppressTerminalReconcile(gate))

        gate = WithdrawTerminalReconcilePolicy.applySignal(gate, withdrawApplied: true)
        XCTAssertEqual(gate, .exempt(clientEventId: clientEventId))
        XCTAssertTrue(WithdrawTerminalReconcilePolicy.shouldSuppressTerminalReconcile(gate))
    }

    func testWithdrawAppliedFalseDoesNotExemptAndAllowsReconcile() {
        let clientEventId = "client-evt-withdraw-1"
        var gate = WithdrawTerminalReconcilePolicy.beginWithdraw(clientEventId: clientEventId)
        gate = WithdrawTerminalReconcilePolicy.applySignal(gate, withdrawApplied: false)

        XCTAssertEqual(gate, .idle)
        XCTAssertFalse(WithdrawTerminalReconcilePolicy.shouldSuppressTerminalReconcile(gate))
    }

    func testMissingWithdrawAppliedKeepsLegacyReconcileBehavior() {
        let clientEventId = "client-evt-withdraw-1"
        var gate = WithdrawTerminalReconcilePolicy.beginWithdraw(clientEventId: clientEventId)
        gate = WithdrawTerminalReconcilePolicy.applySignal(gate, withdrawApplied: nil)

        // 旧后端不下发字段：清等待态，终态对账按现状执行（可能回拉）。
        XCTAssertEqual(gate, .idle)
        XCTAssertFalse(WithdrawTerminalReconcilePolicy.shouldSuppressTerminalReconcile(gate))
    }

    func testNilAfterExemptKeepsExemption() {
        let clientEventId = "client-evt-withdraw-1"
        var gate = WithdrawTerminalReconcilePolicy.beginWithdraw(clientEventId: clientEventId)
        gate = WithdrawTerminalReconcilePolicy.applySignal(gate, withdrawApplied: true)
        gate = WithdrawTerminalReconcilePolicy.applySignal(gate, withdrawApplied: nil)

        XCTAssertEqual(gate, .exempt(clientEventId: clientEventId))
        XCTAssertTrue(WithdrawTerminalReconcilePolicy.shouldSuppressTerminalReconcile(gate))
    }

    func testFalseAfterExemptClearsForReconcileFallback() {
        let clientEventId = "client-evt-withdraw-1"
        var gate = WithdrawTerminalReconcilePolicy.beginWithdraw(clientEventId: clientEventId)
        gate = WithdrawTerminalReconcilePolicy.applySignal(gate, withdrawApplied: true)
        gate = WithdrawTerminalReconcilePolicy.applySignal(gate, withdrawApplied: false)

        XCTAssertEqual(gate, .idle)
        XCTAssertFalse(WithdrawTerminalReconcilePolicy.shouldSuppressTerminalReconcile(gate))
    }

    func testTimeoutAndNewSendClearPending() {
        let awaiting = WithdrawTerminalReconcilePolicy.beginWithdraw(clientEventId: "c1")
        XCTAssertEqual(WithdrawTerminalReconcilePolicy.clearPending(), .idle)
        XCTAssertEqual(WithdrawTerminalReconcilePolicy.clearForNewSend(), .idle)
        XCTAssertNotEqual(awaiting, .idle)
    }
}
