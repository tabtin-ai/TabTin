import XCTest
@testable import Tabtin

final class AgentRunPresentationStateTests: XCTestCase {
    func testConversationMapsPlanningPhase() {
        let state = AgentRunPresentationState.conversation(
            rawPhase: "planning",
            isStreaming: true,
            isPaused: false,
            pendingInteractionCount: 0,
            connectionInterrupted: false,
            currentAction: nil,
            failure: nil
        )

        XCTAssertEqual(state.phase, .planning)
        XCTAssertTrue(state.isActive)
        XCTAssertTrue(state.isVisibleInConversationHeader)
    }

    func testThinkingPhaseIsPlanningRatherThanToolExecution() {
        let state = AgentRunPresentationState.conversation(
            rawPhase: "reasoning",
            isStreaming: true,
            isPaused: false,
            pendingInteractionCount: 0,
            connectionInterrupted: false,
            currentAction: nil,
            failure: nil
        )

        XCTAssertEqual(state.phase, .planning)
        XCTAssertNil(state.currentAction)
    }

    func testCurrentToolTakesExecutingPriorityAndIsTrimmed() {
        let state = AgentRunPresentationState.conversation(
            rawPhase: "executing",
            isStreaming: true,
            isPaused: false,
            pendingInteractionCount: 0,
            connectionInterrupted: false,
            currentAction: "  read_file  ",
            failure: nil
        )

        XCTAssertEqual(state.phase, .executing)
        XCTAssertEqual(state.currentAction, "read_file")
    }

    func testThinkingPhaseSuppressesStaleToolAction() {
        let state = AgentRunPresentationState.conversation(
            rawPhase: "thinking",
            isStreaming: true,
            isPaused: false,
            pendingInteractionCount: 0,
            connectionInterrupted: false,
            currentAction: "read_file",
            failure: nil
        )

        XCTAssertEqual(state.phase, .planning)
        XCTAssertNil(state.currentAction)
    }

    func testPendingInteractionTakesPriorityAndKeepsCount() {
        let state = AgentRunPresentationState.conversation(
            rawPhase: "executing",
            isStreaming: true,
            isPaused: false,
            pendingInteractionCount: 3,
            connectionInterrupted: false,
            currentAction: "bash",
            failure: nil
        )

        XCTAssertEqual(state.phase, .waitingForUser(count: 3))
        XCTAssertFalse(state.isActive)
    }

    func testConnectionRecoveryTakesPriorityDuringRun() {
        let state = AgentRunPresentationState.conversation(
            rawPhase: "executing",
            isStreaming: true,
            isPaused: false,
            pendingInteractionCount: 2,
            connectionInterrupted: true,
            currentAction: "bash",
            failure: nil
        )

        XCTAssertEqual(state.phase, .recoveringConnection)
        XCTAssertTrue(state.isActive)
    }

    func testConnectionRecoveryRemainsVisibleOutsideActiveRun() {
        let state = AgentRunPresentationState.conversation(
            rawPhase: nil,
            isStreaming: false,
            isPaused: false,
            pendingInteractionCount: 0,
            connectionInterrupted: true,
            currentAction: nil,
            failure: nil
        )

        XCTAssertEqual(state.phase, .recoveringConnection)
        XCTAssertTrue(state.isVisibleInConversationHeader)
    }

    func testConnectionRecoveryYieldsToRecoveryBannerWhenOwned() {
        let state = AgentRunPresentationState.conversation(
            rawPhase: "executing",
            isStreaming: true,
            isPaused: false,
            pendingInteractionCount: 0,
            connectionInterrupted: true,
            currentAction: "bash",
            failure: nil,
            connectionRecoveryOwnedByBanner: true
        )

        XCTAssertNotEqual(state.phase, .recoveringConnection)
        XCTAssertEqual(state.phase, .executing)
    }

    func testPendingInteractionYieldsToHITLPanelWhenOwned() {
        let state = AgentRunPresentationState.conversation(
            rawPhase: "executing",
            isStreaming: true,
            isPaused: false,
            pendingInteractionCount: 2,
            connectionInterrupted: false,
            currentAction: "bash",
            failure: nil,
            blockingHITLOwnedByPanel: true
        )

        XCTAssertNotEqual(state.phase, .waitingForUser(count: 2))
        XCTAssertEqual(state.phase, .executing)
    }

    func testPendingInteractionKeepsWaitingWhenPanelDoesNotOwnHITL() {
        // 工作台聚焦：对话面板不可见 → blockingHITLOwnedByPanel=false → 胶囊保留 HITL。
        let state = AgentRunPresentationState.conversation(
            rawPhase: "executing",
            isStreaming: true,
            isPaused: false,
            pendingInteractionCount: 2,
            connectionInterrupted: false,
            currentAction: "bash",
            failure: nil,
            blockingHITLOwnedByPanel: false
        )
        XCTAssertEqual(state.phase, .waitingForUser(count: 2))
    }

    func testAuthoritativeCompletedRespectsUnreadReply() {
        let unread = AgentRunPresentationState.conversation(
            rawPhase: nil,
            isStreaming: false,
            isPaused: false,
            pendingInteractionCount: 0,
            connectionInterrupted: false,
            currentAction: nil,
            failure: nil,
            authoritativeRunStatus: .completed,
            hasUnreadReply: true,
            unreadReplyCount: 3
        )
        XCTAssertEqual(unread.phase, .completed(hasUnreadReply: true))
        XCTAssertEqual(unread.unreadReplyCount, 3)

        let read = AgentRunPresentationState.conversation(
            rawPhase: nil,
            isStreaming: false,
            isPaused: false,
            pendingInteractionCount: 0,
            connectionInterrupted: false,
            currentAction: nil,
            failure: nil,
            authoritativeRunStatus: .completed,
            hasUnreadReply: false
        )
        XCTAssertEqual(read.phase, .completed(hasUnreadReply: false))
        XCTAssertEqual(read.unreadReplyCount, 0)
    }

    func testWithCapsuleMetricsPreservesPhaseAndOverridesCounts() {
        let base = AgentRunPresentationState(
            phase: .planning,
            currentAction: nil,
            failureReason: nil,
            recovery: nil
        )
        let enriched = base.withCapsuleMetrics(
            completedToolCalls: 2,
            queuedCount: 4,
            unreadReplyCount: 0
        )
        XCTAssertEqual(enriched.phase, .planning)
        XCTAssertEqual(enriched.completedToolCalls, 2)
        XCTAssertEqual(enriched.queuedCount, 4)
        XCTAssertEqual(
            TaskCapsuleStatus.resolve(TaskCapsuleStatus.input(from: enriched)),
            .planningNext
        )
    }

    func testColdStartAuthoritativeActiveRunKeepsHeaderAndStopSemanticsAlive() {
        let state = AgentRunPresentationState.conversation(
            rawPhase: nil,
            isStreaming: false,
            isPaused: false,
            pendingInteractionCount: 0,
            connectionInterrupted: false,
            currentAction: nil,
            failure: nil,
            authoritativeRunStatus: .running
        )

        XCTAssertEqual(state.phase, .executing)
        XCTAssertTrue(state.isVisibleInConversationHeader)
        XCTAssertTrue(state.isActive)
    }

    func testColdStartAuthoritativeTerminalDoesNotResurrectLoading() {
        for status in [
            SessionRunStatus.completed,
            .cancelled,
            .interrupted,
        ] {
            let state = AgentRunPresentationState.conversation(
                rawPhase: nil,
                isStreaming: false,
                isPaused: false,
                pendingInteractionCount: 0,
                connectionInterrupted: false,
                currentAction: nil,
                failure: nil,
                authoritativeRunStatus: status
            )

            XCTAssertFalse(state.isActive)
            XCTAssertFalse(state.isVisibleInConversationHeader)
        }
    }

    func testNewRunHidesPreviousFailure() {
        let failure = AgentRunFailurePresentation(
            errorMessage: "模型暂时不可用",
            errorClass: "LLM_PROVIDER_ERROR",
            errorCategory: nil,
            errorCode: nil,
            suggestedAction: nil,
            stopReason: nil
        )

        let state = AgentRunPresentationState.conversation(
            rawPhase: "start",
            isStreaming: true,
            isPaused: false,
            pendingInteractionCount: 0,
            connectionInterrupted: false,
            currentAction: nil,
            failure: failure
        )

        // lifecycle start 对齐 Electron/Android → planning，不再卡在「正在准备…」。
        XCTAssertEqual(state.phase, .planning)
        XCTAssertNil(state.failureReason)
    }

    func testWireStartAndNilPhaseMapToPlanningWhileStreaming() {
        let start = AgentRunPresentationState.conversation(
            rawPhase: "start",
            isStreaming: true,
            isPaused: false,
            pendingInteractionCount: 0,
            connectionInterrupted: false,
            currentAction: nil,
            failure: nil
        )
        XCTAssertEqual(start.phase, .planning)

        let nilPhase = AgentRunPresentationState.conversation(
            rawPhase: nil,
            isStreaming: true,
            isPaused: false,
            pendingInteractionCount: 0,
            connectionInterrupted: false,
            currentAction: nil,
            failure: nil
        )
        XCTAssertEqual(nilPhase.phase, .planning)

        let turnStart = AgentRunPresentationState.conversation(
            rawPhase: "turn_start",
            isStreaming: true,
            isPaused: false,
            pendingInteractionCount: 0,
            connectionInterrupted: false,
            currentAction: nil,
            failure: nil
        )
        XCTAssertEqual(turnStart.phase, .planning)
    }

    func testStoppedRunIsNotPresentedAsFailure() {
        let failure = AgentRunFailurePresentation(
            errorMessage: "User aborted",
            errorClass: "ABORT",
            errorCategory: nil,
            errorCode: "cancelled",
            suggestedAction: nil,
            stopReason: "cancelled"
        )

        XCTAssertNil(failure)
    }

    func testFailureMapsRecoveryAction() {
        let failure = AgentRunFailurePresentation(
            errorMessage: "上下文过长",
            errorClass: "CONTEXT_OVERFLOW",
            errorCategory: nil,
            errorCode: nil,
            suggestedAction: "shorten_context",
            stopReason: "error"
        )

        let state = AgentRunPresentationState.conversation(
            rawPhase: nil,
            isStreaming: false,
            isPaused: false,
            pendingInteractionCount: 0,
            connectionInterrupted: false,
            currentAction: nil,
            failure: failure
        )

        XCTAssertEqual(state.phase, .failed)
        XCTAssertEqual(state.failureReason, "上下文过长")
        XCTAssertEqual(state.recovery, .newConversation)
    }

    func testTaskSummaryPrioritizesPendingThenRunningThenUnread() {
        XCTAssertEqual(
            AgentRunPresentationState.sessionSummary(
                hasActiveTask: true,
                hasUnreadReply: true,
                hasPendingInteraction: true
            ).phase,
            .waitingForUser(count: 1)
        )
        XCTAssertEqual(
            AgentRunPresentationState.sessionSummary(
                hasActiveTask: true,
                hasUnreadReply: true,
                hasPendingInteraction: false
            ).phase,
            .executing
        )
        XCTAssertEqual(
            AgentRunPresentationState.sessionSummary(
                hasActiveTask: false,
                hasUnreadReply: true,
                hasPendingInteraction: false
            ).phase,
            .completed(hasUnreadReply: true)
        )
        XCTAssertEqual(
            AgentRunPresentationState.sessionSummary(
                hasActiveTask: false,
                hasUnreadReply: false,
                hasPendingInteraction: false,
                hasFailedTask: true
            ).phase,
            .failed
        )
    }

    func testTaskHomeTerminalNotificationOverridesHeuristicRunningState() throws {
        let session = try recentSession(
            lastMessageAt: "2026-07-28T11:00:00Z",
            hasActiveTask: true
        )

        XCTAssertEqual(
            TaskHomeSessionStatusPolicy.override(
                for: session,
                notifications: [
                    terminalNotification(
                        type: "agent.task.completed",
                        isRead: false,
                        createdAt: "2026-07-28T11:00:01Z"
                    ),
                ]
            ),
            .completedUnread
        )
        XCTAssertEqual(
            TaskHomeSessionStatusPolicy.override(
                for: session,
                notifications: [
                    terminalNotification(
                        type: "agent.task.error",
                        isRead: true,
                        createdAt: "2026-07-28T11:00:01.500Z"
                    ),
                ]
            ),
            .failed
        )
    }

    func testTaskHomeIgnoresTerminalNotificationFromOlderRun() throws {
        let session = try recentSession(
            lastMessageAt: "2026-07-28T11:00:02Z",
            hasActiveTask: true
        )

        XCTAssertNil(
            TaskHomeSessionStatusPolicy.override(
                for: session,
                notifications: [
                    terminalNotification(
                        type: "agent.task.completed",
                        isRead: false,
                        createdAt: "2026-07-28T11:00:01Z"
                    ),
                ]
            )
        )
    }

    private func recentSession(
        lastMessageAt: String,
        hasActiveTask: Bool
    ) throws -> RecentSession {
        try JSONDecoder().decode(RecentSession.self, from: Data("""
        {
          "id": "session-1",
          "last_message_at": "\(lastMessageAt)",
          "has_active_task": \(hasActiveTask)
        }
        """.utf8))
    }

    private func terminalNotification(
        type: String,
        isRead: Bool,
        createdAt: String
    ) -> MobileNotification {
        MobileNotification(
            id: "\(type)-\(createdAt)",
            type: type,
            title: "",
            body: "",
            metadata: ["session_id": AnyCodable("session-1")],
            organizationId: "org-1",
            priority: nil,
            category: nil,
            sourceExtensionId: nil,
            navigateTo: nil,
            isRead: isRead,
            readAt: nil,
            createdAt: createdAt
        )
    }

    // MARK: - TaskRowStatusPresentation

    func testTaskRowBadgeCollapsesRunningPhasesIntoOneBadge() {
        for phase in [
            AgentRunPresentationState.Phase.preparing,
            .planning,
            .executing,
            .responding,
            .recoveringConnection,
        ] {
            let state = AgentRunPresentationState(
                phase: phase, currentAction: nil, failureReason: nil, recovery: nil
            )
            XCTAssertEqual(TaskRowStatusPresentation.resolve(from: state), .running,
                           "phase \(phase) should map to .running")
        }
    }

    func testTaskRowBadgeMapsWaitingAndPausedToAttention() {
        let waiting = AgentRunPresentationState(
            phase: .waitingForUser(count: 1), currentAction: nil, failureReason: nil, recovery: nil
        )
        let paused = AgentRunPresentationState(
            phase: .paused, currentAction: nil, failureReason: nil, recovery: nil
        )
        XCTAssertEqual(TaskRowStatusPresentation.resolve(from: waiting), .attention)
        XCTAssertEqual(TaskRowStatusPresentation.resolve(from: paused), .attention)
    }

    func testTaskRowBadgeMapsFailedAndCompletedAndIdle() {
        let failed = AgentRunPresentationState(
            phase: .failed, currentAction: nil, failureReason: nil, recovery: nil
        )
        let done = AgentRunPresentationState(
            phase: .completed(hasUnreadReply: false), currentAction: nil, failureReason: nil, recovery: nil
        )
        let unread = AgentRunPresentationState(
            phase: .completed(hasUnreadReply: true), currentAction: nil, failureReason: nil, recovery: nil
        )
        XCTAssertEqual(TaskRowStatusPresentation.resolve(from: failed), .failed)
        XCTAssertEqual(TaskRowStatusPresentation.resolve(from: done), .done)
        XCTAssertEqual(TaskRowStatusPresentation.resolve(from: unread), .done)
        XCTAssertEqual(TaskRowStatusPresentation.resolve(from: .idle), .none)
    }

    /// 「需要你」区的准入判定必须只认 waitingForUser，不能把 paused 也捞进来——
    /// 暂停是 Agent 自己停下，不是在等人。
    func testOnlyWaitingForUserCountsAsNeedsYou() {
        let waiting = AgentRunPresentationState(
            phase: .waitingForUser(count: 1), currentAction: nil, failureReason: nil, recovery: nil
        )
        let paused = AgentRunPresentationState(
            phase: .paused, currentAction: nil, failureReason: nil, recovery: nil
        )
        XCTAssertTrue(TaskRowStatusPresentation.needsUserAction(waiting))
        XCTAssertFalse(TaskRowStatusPresentation.needsUserAction(paused))
        XCTAssertFalse(TaskRowStatusPresentation.needsUserAction(.idle))
    }
}

final class AssistantErrorPresentationTests: XCTestCase {
    func testProviderFailureOffersRetry() {
        let presentation = resolve(errorClass: "LLM_PROVIDER_ERROR")

        XCTAssertEqual(presentation.severity, .error)
        XCTAssertEqual(presentation.action, .retry)
    }

    func testSuggestedActionMatrixMatchesRecoveryDestinations() {
        XCTAssertEqual(
            resolve(errorClass: "LLM_ERROR", suggestedAction: "switch_model").action,
            .switchModel
        )
        XCTAssertEqual(
            resolve(errorClass: "BUDGET_EXHAUSTED", suggestedAction: "check_billing").action,
            .recharge
        )
        XCTAssertEqual(
            resolve(errorClass: "AUTH_REQUIRED").action,
            .relogin
        )
        XCTAssertEqual(
            resolve(errorClass: "CONTEXT_OVERFLOW").action,
            .newConversation
        )
    }

    func testRunLimitOverridesLegacyBillingHintWithRetry() {
        let presentation = resolve(
            errorClass: "MAX_CREDITS_EXCEEDED",
            suggestedAction: "check_billing"
        )

        XCTAssertEqual(presentation.severity, .warning)
        XCTAssertEqual(presentation.action, .retry)
    }

    func testUnknownOrUnsupportedRecoveryFallsBackToRetry() {
        XCTAssertEqual(resolve(errorClass: "SOME_NEW_RUNTIME_ERROR").action, .retry)
        XCTAssertEqual(
            resolve(errorClass: "LLM_PROVIDER_ERROR", suggestedAction: "inspect_logs").action,
            .retry
        )
    }

    func testAuthCodeWithoutErrorClassOffersRelogin() {
        let message = ChatMessage(
            id: "assistant-auth",
            role: .assistant,
            errorMessage: "",
            errorCode: "auth_required"
        )

        XCTAssertEqual(
            ChatErrorPresentation.resolve(message: message, fallbackMessage: "").action,
            .relogin
        )
    }

    func testRestrictedModelCategoryOffersModelSwitch() {
        let message = ChatMessage(
            id: "assistant-model-restricted",
            role: .assistant,
            errorMessage: "",
            errorCategory: "member_model_restricted"
        )

        XCTAssertEqual(
            ChatErrorPresentation.resolve(message: message, fallbackMessage: "").action,
            .switchModel
        )
    }

    func testUserAbortIsNeutralAndHasNoRecoveryAction() {
        let message = ChatMessage(
            id: "assistant-abort",
            role: .assistant,
            stopReason: "aborted",
            errorMessage: "Run aborted by user.",
            errorCategory: "aborted",
            errorClass: "ABORT"
        )

        XCTAssertTrue(ChatErrorPresentation.shouldPresent(message: message))
        let presentation = ChatErrorPresentation.resolve(
            message: message,
            fallbackMessage: message.errorMessage ?? ""
        )
        XCTAssertEqual(presentation.severity, .neutral)
        XCTAssertNil(presentation.action)
        XCTAssertTrue(ChatErrorPresentation.isRuntimeAbortDiagnostic("Run aborted by user."))
        XCTAssertFalse(ChatErrorPresentation.isRuntimeAbortDiagnostic("已完成部分分析"))
    }

    func testStopReasonAloneStillProducesNeutralInterruptedState() {
        let message = ChatMessage(
            id: "assistant-stop",
            role: .assistant,
            stopReason: "cancelled"
        )

        XCTAssertTrue(ChatErrorPresentation.shouldPresent(message: message))
        XCTAssertEqual(
            ChatErrorPresentation.resolve(message: message, fallbackMessage: "").severity,
            .neutral
        )
    }

    private func resolve(
        errorClass: String,
        suggestedAction: String? = nil
    ) -> ChatErrorPresentation {
        let message = ChatMessage(
            id: "assistant-error",
            role: .assistant,
            errorMessage: "runtime detail",
            errorClass: errorClass,
            suggestedAction: suggestedAction
        )
        return ChatErrorPresentation.resolve(
            message: message,
            fallbackMessage: message.errorMessage ?? ""
        )
    }
}
