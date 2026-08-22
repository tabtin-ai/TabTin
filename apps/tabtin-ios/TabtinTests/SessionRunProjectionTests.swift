import XCTest
@testable import Tabtin

final class SessionRunProjectionTests: XCTestCase {
    private struct Fixture: Decodable {
        let session: RecentSession
        let realtimeEvent: WSEnvelope

        enum CodingKeys: String, CodingKey {
            case session
            case realtimeEvent = "realtime_event"
        }
    }

    func testColdSnapshotAndRealtimeFixtureUseTheSameContract() throws {
        let fixture = try loadFixture()
        XCTAssertTrue(fixture.session.includesRunState)
        XCTAssertEqual(fixture.session.runState?.status, .waitingUser)
        XCTAssertEqual(fixture.session.runState?.waitingInteractionId, "interaction-1")

        XCTAssertEqual(fixture.realtimeEvent.payloadString("session_id"), "session-4679")
        XCTAssertEqual(fixture.realtimeEvent.payloadString("organization_id"), "org-4679")
        let update = fixture.realtimeEvent.decodePayloadField(
            "run_state",
            as: SessionRunState.self,
            encoder: JSONEncoder(),
            decoder: JSONDecoder()
        )
        XCTAssertEqual(update?.revision, 4)
        XCTAssertEqual(update?.status, .completed)
    }

    func testSessionListDecodesCrossDeviceReadWatermark() throws {
        let session = try JSONDecoder().decode(
            RecentSession.self,
            from: Data(
                """
                {
                  "id": "session-read",
                  "has_unread_reply": true,
                  "read_state": {
                    "last_read_run_sequence": 6,
                    "last_read_terminal_revision": 3,
                    "read_at": "2026-07-29T10:00:00Z",
                    "latest_completed_run_id": "run-7",
                    "latest_completed_run_sequence": 7,
                    "latest_completed_terminal_revision": 4
                  }
                }
                """.utf8
            )
        )
        XCTAssertTrue(session.hasUnreadReply)
        XCTAssertEqual(session.readState?.lastReadRunSequence, 6)
        XCTAssertEqual(session.readState?.lastReadTerminalRevision, 3)
        XCTAssertEqual(
            session.readState?.pendingAck(
                sessionId: session.id,
                mutationId: "stable"
            )?.throughRunId,
            "run-7"
        )
    }

    func testReadOutboxKeepsOnlyNewerWatermarkAndMutationIdStable() {
        let existing = PendingSessionReadAck(
            sessionId: "session-read",
            throughRunId: "run-6",
            throughSequence: 6,
            throughRevision: 3,
            mutationId: "mutation-stable"
        )
        XCTAssertFalse(SessionReadWatermarkPolicy.newer(existing, than: existing))
        XCTAssertFalse(
            SessionReadWatermarkPolicy.newer(
                PendingSessionReadAck(
                    sessionId: "session-read",
                    throughRunId: "run-5",
                    throughSequence: 5,
                    throughRevision: 99,
                    mutationId: "older"
                ),
                than: existing
            )
        )
        XCTAssertTrue(
            SessionReadWatermarkPolicy.newer(
                PendingSessionReadAck(
                    sessionId: "session-read",
                    throughRunId: "run-7",
                    throughSequence: 7,
                    throughRevision: 1,
                    mutationId: "newer"
                ),
                than: existing
            )
        )
    }

    func testSessionDetailHydratesTheSameAuthoritativeContract() throws {
        let detail = try JSONDecoder().decode(
            ChatSession.self,
            from: Data(
                """
                {
                  "id": "session-4679",
                  "run_state": {
                    "run_id": "run-1",
                    "sequence": 7,
                    "revision": 3,
                    "status": "running",
                    "queue_depth": 0,
                    "started_at": "2026-07-28T10:00:00Z",
                    "state_changed_at": "2026-07-28T10:00:03Z",
                    "ended_at": null,
                    "stop_reason": null,
                    "error_class": null,
                    "waiting_interaction_id": null
                  }
                }
                """.utf8
            )
        )

        XCTAssertEqual(detail.runState?.runId, "run-1")
        XCTAssertEqual(detail.runState?.status, .running)
    }

    func testRecentSessionMutationPolicyUpdatesRowsAndClearsDeletedProjection() throws {
        var sessions = [
            try recentSession(id: "session-1", title: "旧标题", status: "active"),
            try recentSession(id: "session-2", title: "保留", status: "active"),
        ]
        var projections = [
            "session-1": projection(
                state(runId: "run-1", sequence: 1, revision: 1, status: .running)
            ),
        ]

        RecentSessionsMutationPolicy.update(
            sessionId: "session-1",
            title: "新标题",
            status: nil,
            expectedStatus: "active",
            sessions: &sessions
        )
        XCTAssertEqual(sessions.first?.title, "新标题")

        var unfilteredSessions = sessions
        RecentSessionsMutationPolicy.update(
            sessionId: "session-1",
            title: nil,
            status: "archived",
            expectedStatus: nil,
            sessions: &unfilteredSessions
        )
        XCTAssertEqual(unfilteredSessions.map(\.id), ["session-1", "session-2"])
        XCTAssertEqual(
            unfilteredSessions.first(where: { $0.id == "session-1" })?.status,
            "archived"
        )

        RecentSessionsMutationPolicy.update(
            sessionId: "session-1",
            title: nil,
            status: "archived",
            expectedStatus: "active",
            sessions: &sessions
        )
        XCTAssertEqual(sessions.map(\.id), ["session-2"])

        RecentSessionsMutationPolicy.delete(
            sessionId: "session-1",
            sessions: &sessions,
            runProjections: &projections
        )
        XCTAssertNil(projections["session-1"])
    }

    func testRunStateDecodeRejectsNegativeAndOverflowingCounters() throws {
        let invalidCounters = [
            ("-1", "0", "0"),
            ("0", "-1", "0"),
            ("0", "0", "-1"),
            ("9223372036854775808", "0", "0"),
        ]

        for (sequence, revision, queueDepth) in invalidCounters {
            let data = Data("""
            {
              "run_id": "run-invalid",
              "sequence": \(sequence),
              "revision": \(revision),
              "status": "running",
              "queue_depth": \(queueDepth),
              "started_at": null,
              "state_changed_at": "2026-07-28T10:00:00Z",
              "ended_at": null,
              "stop_reason": null,
              "error_class": null,
              "waiting_interaction_id": null
            }
            """.utf8)

            XCTAssertThrowsError(
                try JSONDecoder().decode(SessionRunState.self, from: data),
                "must reject counters \(sequence)/\(revision)/\(queueDepth)"
            )
        }
    }

    func testDuplicateAndOutOfOrderAuthorityCannotRegressProjection() {
        let baseline = projection(state(runId: "run-1", sequence: 4, revision: 2, status: .running))

        let duplicate = SessionRunProjectionReducer.applying(
            authoritative: state(runId: "run-1", sequence: 4, revision: 2, status: .failed),
            to: baseline
        )
        let olderRevision = SessionRunProjectionReducer.applying(
            authoritative: state(runId: "run-1", sequence: 4, revision: 1, status: .failed),
            to: duplicate
        )
        let olderRun = SessionRunProjectionReducer.applying(
            authoritative: state(runId: "run-0", sequence: 3, revision: 99, status: .failed),
            to: olderRevision
        )

        XCTAssertEqual(olderRun.authoritative, baseline.authoritative)
        XCTAssertEqual(olderRun.resolvedStatus, .running)
    }

    func testHigherRevisionAuthoritativeActiveReplacesTerminalForSameRun() {
        let terminalStatuses: [SessionRunStatus] = [
            .completed, .failed, .cancelled, .interrupted,
        ]
        let activeStatuses: [SessionRunStatus] = [
            .queued, .running, .waitingUser, .paused, .cancelling,
        ]

        for terminalStatus in terminalStatuses {
            for activeStatus in activeStatuses {
                let baseline = projection(
                    state(
                        runId: "run-1",
                        sequence: 4,
                        revision: 2,
                        status: terminalStatus
                    )
                )
                let lateActive = SessionRunProjectionReducer.applying(
                    authoritative: state(
                        runId: "run-1",
                        sequence: 4,
                        revision: 99,
                        status: activeStatus
                    ),
                    to: baseline
                )

                XCTAssertEqual(lateActive.authoritative?.status, activeStatus)
                XCTAssertEqual(lateActive.authoritative?.revision, 99)
                XCTAssertEqual(lateActive.resolvedStatus, activeStatus)
            }
        }
    }

    func testHigherSequenceActiveAuthorityTakesOverTerminalWithResetRevision() {
        let terminalStatuses: [SessionRunStatus] = [
            .completed, .failed, .cancelled, .interrupted,
        ]
        let activeStatuses: [SessionRunStatus] = [
            .queued, .running, .waitingUser, .paused, .cancelling,
        ]

        for terminalStatus in terminalStatuses {
            for activeStatus in activeStatuses {
                let baseline = projection(
                    state(
                        runId: "run-old",
                        sequence: 4,
                        revision: 99,
                        status: terminalStatus
                    )
                )
                let nextRun = state(
                    runId: "run-new",
                    sequence: 5,
                    revision: 0,
                    status: activeStatus
                )
                let updated = SessionRunProjectionReducer.applying(
                    authoritative: nextRun,
                    to: baseline
                )

                XCTAssertEqual(
                    updated.authoritative,
                    nextRun,
                    "\(activeStatus) in a higher sequence must replace \(terminalStatus)"
                )
            }
        }
    }

    func testHigherRevisionAuthorityReplacesLocalTerminal() {
        let baseline = projection(state(runId: "run-1", sequence: 4, revision: 2, status: .running))
        let locallyDone = SessionRunProjectionReducer.applyingLocal(
            runId: "run-1",
            status: .completed,
            beginsNewRun: false,
            to: baseline
        )
        let lateActiveAuthority = SessionRunProjectionReducer.applying(
            authoritative: state(runId: "run-1", sequence: 4, revision: 3, status: .running),
            to: locallyDone
        )
        XCTAssertNil(lateActiveAuthority.localOverlay)
        XCTAssertEqual(lateActiveAuthority.resolvedStatus, .running)
    }

    func testTerminalWithoutRunIdTemporarilyOverridesKnownRunningAuthority() throws {
        let baseline = projection(state(runId: "run-1", sequence: 4, revision: 2, status: .running))
        let locallyDone = try XCTUnwrap(
            SessionRunProjectionReducer.applyingLocalTerminalWithoutRunId(
                status: .completed,
                to: baseline
            )
        )
        XCTAssertEqual(locallyDone.resolvedStatus, .completed)

        let lateActiveAuthority = SessionRunProjectionReducer.applying(
            authoritative: state(runId: "run-1", sequence: 4, revision: 3, status: .running),
            to: locallyDone
        )
        XCTAssertNil(lateActiveAuthority.localOverlay)
        XCTAssertEqual(lateActiveAuthority.resolvedStatus, .running)
    }

    func testNewRunRejectsOldRunTerminalAndYieldsToHigherSequenceAuthority() {
        let previous = projection(state(runId: "run-old", sequence: 8, revision: 5, status: .completed))
        let localNewRun = SessionRunProjectionReducer.applyingLocal(
            runId: "run-new",
            status: .queued,
            beginsNewRun: true,
            to: previous
        )
        let oldTerminal = SessionRunProjectionReducer.applyingLocal(
            runId: "run-old",
            status: .failed,
            beginsNewRun: false,
            to: localNewRun
        )
        XCTAssertEqual(oldTerminal.resolvedStatus, .queued)

        let authoritativeNewRun = SessionRunProjectionReducer.applying(
            authoritative: state(runId: "run-new", sequence: 9, revision: 1, status: .running),
            to: oldTerminal
        )
        XCTAssertNil(authoritativeNewRun.localOverlay)
        XCTAssertEqual(authoritativeNewRun.resolvedStatus, .running)
    }

    func testAuthoritativeHITLCancelAndFailureMapToDesktopSemantics() {
        XCTAssertEqual(summary(.waitingUser).phase, .waitingForUser(count: 1))
        XCTAssertEqual(summary(.cancelled).phase, .idle)
        XCTAssertEqual(summary(.interrupted).phase, .idle)
        XCTAssertEqual(summary(.failed).phase, .failed)
        XCTAssertEqual(summary(.running).phase, .executing)
    }

    func testAuthorityWinsEvenWhenNotificationWindowDoesNotContainSession() throws {
        let session = try JSONDecoder().decode(RecentSession.self, from: Data("""
        {"id":"session-4679","has_active_task":false}
        """.utf8))
        let unrelated = (0..<50).map { index in
            notification(sessionId: "other-\(index)", type: "agent.task.completed")
        }
        let missingOverride = TaskHomeSessionStatusPolicy.override(
            for: session,
            notifications: unrelated
        )
        XCTAssertNil(missingOverride)
        XCTAssertEqual(
            TaskHomeSessionStatusPolicy.presentation(
                for: session,
                resolvedRunStatus: .failed,
                statusOverride: missingOverride,
                hasPendingInteraction: false
            ).phase,
            .failed
        )

        let staleErrorOverride = TaskHomeSessionStatusPolicy.override(
            for: session,
            notifications: [notification(sessionId: session.id, type: "agent.task.error")]
        )
        XCTAssertEqual(
            TaskHomeSessionStatusPolicy.presentation(
                for: session,
                resolvedRunStatus: .running,
                statusOverride: staleErrorOverride,
                hasPendingInteraction: false
            ).phase,
            .executing
        )
    }

    func testMissingRunStateKeepsLegacyCompatibilityAndNullIsDistinguishable() throws {
        let decoder = JSONDecoder()
        let legacy = try decoder.decode(
            RecentSession.self,
            from: Data(#"{"id":"legacy","has_active_task":true}"#.utf8)
        )
        let authoritativeEmpty = try decoder.decode(
            RecentSession.self,
            from: Data(#"{"id":"new","run_state":null}"#.utf8)
        )

        XCTAssertFalse(legacy.includesRunState)
        XCTAssertTrue(authoritativeEmpty.includesRunState)
        XCTAssertEqual(
            TaskHomeSessionStatusPolicy.presentation(
                for: legacy,
                resolvedRunStatus: nil,
                statusOverride: nil,
                hasPendingInteraction: false
            ).phase,
            .executing
        )
    }

    @MainActor
    func testConversationHydratesActiveSnapshotAndRealtimeTerminal() throws {
        let viewModel = ConversationViewModel(sessionId: "session-4679")
        viewModel.applyAuthoritativeRunState(
            state(runId: "run-1", sequence: 7, revision: 3, status: .running)
        )

        XCTAssertEqual(viewModel.authoritativeRunStatus, .running)
        XCTAssertTrue(viewModel.canCancel)
        XCTAssertFalse(viewModel.isStreaming, "authority must not invent message streaming")

        let terminal = try envelope(
            sessionId: "session-4679",
            state: state(
                runId: "run-1",
                sequence: 7,
                revision: 4,
                status: .completed
            )
        )
        XCTAssertTrue(viewModel.consumeAuthoritativeRunStateEnvelope(terminal))
        XCTAssertEqual(viewModel.authoritativeRunStatus, .completed)
        XCTAssertFalse(viewModel.canCancel)
        XCTAssertFalse(viewModel.isStreaming)
    }

    @MainActor
    func testConversationHigherRevisionAuthorityReplacesTerminal() throws {
        let viewModel = ConversationViewModel(sessionId: "session-4679")
        XCTAssertTrue(
            viewModel.consumeAuthoritativeRunStateEnvelope(
                try envelope(
                    sessionId: "session-4679",
                    state: state(
                        runId: "run-1",
                        sequence: 7,
                        revision: 4,
                        status: .cancelled
                    )
                )
            )
        )

        XCTAssertTrue(
            viewModel.consumeAuthoritativeRunStateEnvelope(
                try envelope(
                    sessionId: "session-4679",
                    state: state(
                        runId: "run-1",
                        sequence: 7,
                        revision: 99,
                        status: .running
                    )
                )
            )
        )
        XCTAssertEqual(viewModel.authoritativeRunStatus, .running)
        XCTAssertTrue(viewModel.canCancel)
    }

    // MARK: -  合成 mini-message 不得标记「运行中」

    @MainActor
    private func ingestMessageStart(
        sessionId: String,
        runId: String,
        role: String?
    ) {
        let viewModel = ConversationViewModel(sessionId: sessionId)
        var payload: [String: Any] = [
            "message_id": "m-\(runId)",
            "run_id": runId,
            "session_id": sessionId,
        ]
        if let role { payload["role"] = role }
        viewModel.ingestEnvelopeForTesting(
            WSEnvelope.build(
                type: AgentStreamEvent.fullType(AgentStreamEvent.messageStart),
                deviceId: "ios-test",
                payload: payload
            )
        )
    }

    /// 后台命令终态 relay 的合成 mini-message（role="user"）只带占位 run_id 且永远没有
    /// 配对 done——ViewModel 不得据此把会话标成「运行中」，否则会话列表会一直显示运行中。
    @MainActor
    func testSyntheticUserRoleMessageStartDoesNotMarkRunStarted() {
        let sessionId = "session-8785-user"
        let runId = "bg-terminal-8785-user"
        RecentSessionsStore.shared.removeRunProjectionForTesting(sessionId: sessionId)
        defer { RecentSessionsStore.shared.removeRunProjectionForTesting(sessionId: sessionId) }

        ingestMessageStart(sessionId: sessionId, runId: runId, role: "user")

        XCTAssertNil(
            RecentSessionsStore.shared.runProjections[sessionId],
            "合成 mini-message（role=user）不得写入 run 投影，避免误标运行中"
        )
    }

    /// 回归：正常助手轮（role="assistant"）的 message_start 仍要把会话标为运行中。
    @MainActor
    func testAssistantRoleMessageStartMarksRunStarted() {
        let sessionId = "session-8785-assistant"
        let runId = "run-8785-assistant"
        RecentSessionsStore.shared.removeRunProjectionForTesting(sessionId: sessionId)
        defer { RecentSessionsStore.shared.removeRunProjectionForTesting(sessionId: sessionId) }

        ingestMessageStart(sessionId: sessionId, runId: runId, role: "assistant")

        XCTAssertEqual(
            RecentSessionsStore.shared.runProjections[sessionId]?.resolvedStatus,
            .running
        )
    }

    /// 回归：旧 relay 不带 role 字段时保持旧行为（标为运行中），兼容历史事件。
    @MainActor
    func testMessageStartWithoutRoleStillMarksRunStarted() {
        let sessionId = "session-8785-legacy"
        let runId = "run-8785-legacy"
        RecentSessionsStore.shared.removeRunProjectionForTesting(sessionId: sessionId)
        defer { RecentSessionsStore.shared.removeRunProjectionForTesting(sessionId: sessionId) }

        ingestMessageStart(sessionId: sessionId, runId: runId, role: nil)

        XCTAssertEqual(
            RecentSessionsStore.shared.runProjections[sessionId]?.resolvedStatus,
            .running
        )
    }

    // MARK: - RecentSession primary_surface

    /// 列表锚点已改为状态图标，不再画工作面；但 `primary_surface` 仍是后端契约字段，
    /// 解码必须保持向前兼容（旧后端缺键 → nil，不能解码失败）。
    func testRecentSessionDecodesOptionalPrimarySurface() throws {
        let withSurface = try JSONDecoder().decode(
            RecentSession.self,
            from: Data(#"{"id":"s-face","primary_surface":"browser"}"#.utf8)
        )
        XCTAssertEqual(withSurface.primarySurface, "browser")

        let missing = try JSONDecoder().decode(
            RecentSession.self,
            from: Data(#"{"id":"s-face-legacy"}"#.utf8)
        )
        XCTAssertNil(missing.primarySurface)
    }

    // MARK: - TaskRowContentPolicy

    private func contentSession(
        agentName: String? = "小 Tin",
        spaceName: String? = "默认 Space",
        projectId: String? = nil,
        projectName: String? = nil,
        preview: String? = nil,
        status: String? = nil
    ) throws -> RecentSession {
        var payload: [String: Any] = ["id": "s-content", "title": "t"]
        if let agentName { payload["agent_name"] = agentName }
        if let spaceName { payload["space_name"] = spaceName }
        if let projectId { payload["project_id"] = projectId }
        if let projectName { payload["project_name"] = projectName }
        if let preview { payload["last_message_preview"] = preview }
        if let status { payload["status"] = status }
        let data = try JSONSerialization.data(withJSONObject: payload)
        return try JSONDecoder().decode(RecentSession.self, from: data)
    }

    /// 第二行默认给最后一条消息的预览——列表里信息量最大的一行。
    func testSecondLineShowsMessagePreviewWhenIdle() throws {
        let session = try contentSession(preview: "我已经把表建好了")
        let line = TaskRowContentPolicy.secondLine(session: session, state: .idle)
        XCTAssertEqual(line.kind, .preview)
        XCTAssertEqual(line.text, "我已经把表建好了")
    }

    /// 「运行中」不抢预览：头像光环已经在说这件事，文字重复一遍等于浪费这一行。
    func testRunningStateYieldsToPreview() throws {
        let session = try contentSession(preview: "我已经把表建好了")
        let running = AgentRunPresentationState(
            phase: .executing, currentAction: nil, failureReason: nil, recovery: nil
        )
        let line = TaskRowContentPolicy.secondLine(session: session, state: running)
        XCTAssertEqual(line.kind, .preview)
        XCTAssertEqual(line.text, "我已经把表建好了")
        XCTAssertEqual(line.badge, .running)
    }

    /// 但「等你确认 / 失败」压过预览：那是行动号召，不是进展播报。
    func testBlockingStatusWinsOverPreview() throws {
        let session = try contentSession(preview: "我已经把表建好了")
        let waiting = AgentRunPresentationState(
            phase: .waitingForUser(count: 1), currentAction: nil, failureReason: nil, recovery: nil
        )
        let failed = AgentRunPresentationState(
            phase: .failed, currentAction: nil, failureReason: nil, recovery: .retry
        )
        XCTAssertEqual(
            TaskRowContentPolicy.secondLine(session: session, state: waiting).kind, .status
        )
        XCTAssertEqual(
            TaskRowContentPolicy.secondLine(session: session, state: failed).kind, .status
        )
    }

    /// 没有预览时才回落到状态 / 归属，保证这一行永远不空着。
    func testFallsBackToStatusThenLocationWithoutPreview() throws {
        let session = try contentSession(spaceName: "设计项目")
        let running = AgentRunPresentationState(
            phase: .executing, currentAction: nil, failureReason: nil, recovery: nil
        )
        let runningLine = TaskRowContentPolicy.secondLine(session: session, state: running)
        XCTAssertEqual(runningLine.kind, .status)

        let idleLine = TaskRowContentPolicy.secondLine(session: session, state: .idle)
        XCTAssertEqual(idleLine.kind, .location)
        XCTAssertEqual(idleLine.text, "设计项目")
    }

    /// 预览原文是多行的，单行渲染前必须把换行折成空格，否则会被截成断头文本。
    func testPreviewCollapsesWhitespace() throws {
        let session = try contentSession(preview: "第一行\n\n  第二行\t结尾 ")
        let line = TaskRowContentPolicy.secondLine(session: session, state: .idle)
        XCTAssertEqual(line.text, "第一行 第二行 结尾")
    }

    /// 在 Project 里干活时用户认的是 Project 名，不是宿主 Space 名。
    func testLocationNamePrefersProjectName() throws {
        let session = try contentSession(
            spaceName: "宿主 Space",
            projectId: "p-1",
            projectName: "增长项目"
        )
        XCTAssertEqual(TaskRowContentPolicy.locationName(session: session), "增长项目")
    }

    func testLocationNameFallsBackToSpaceNameWithoutProject() throws {
        let session = try contentSession(spaceName: "默认 Workspace", projectName: "孤儿项目名")
        XCTAssertEqual(TaskRowContentPolicy.locationName(session: session), "默认 Workspace")
    }

    func testArchivedSessionCarriesArchivedChip() throws {
        let session = try contentSession(status: "archived")
        let line = TaskRowContentPolicy.secondLine(session: session, state: .idle)
        XCTAssertTrue(line.isArchived)
    }

    /// 两行文本预算：第二行为空时标题才放开到两行，否则整列高度会被撑乱。
    func testTitleLineLimitFollowsSecondLineOccupancy() throws {
        let empty = try contentSession(spaceName: nil, preview: nil)
        let withLocation = try contentSession(spaceName: "默认 Workspace")
        XCTAssertEqual(
            TaskRowContentPolicy.titleLineLimit(
                secondLine: TaskRowContentPolicy.secondLine(session: empty, state: .idle)
            ),
            2
        )
        XCTAssertEqual(
            TaskRowContentPolicy.titleLineLimit(
                secondLine: TaskRowContentPolicy.secondLine(session: withLocation, state: .idle)
            ),
            1
        )
    }

    // MARK: - TaskHomeScope

    private var waitingState: AgentRunPresentationState {
        AgentRunPresentationState(
            phase: .waitingForUser(count: 1), currentAction: nil, failureReason: nil, recovery: nil
        )
    }

    private var runningState: AgentRunPresentationState {
        AgentRunPresentationState(
            phase: .executing, currentAction: nil, failureReason: nil, recovery: nil
        )
    }

    func testNeedsYouScopeMatchesOnlyWaitingSessions() throws {
        let session = try contentSession(status: "active")
        XCTAssertTrue(TaskHomeScope.needsYou.matches(state: waitingState, session: session))
        XCTAssertFalse(TaskHomeScope.needsYou.matches(state: runningState, session: session))
        XCTAssertFalse(TaskHomeScope.needsYou.matches(state: .idle, session: session))
    }

    func testRunningScopeMatchesOnlyActiveStates() throws {
        let session = try contentSession(status: "active")
        XCTAssertTrue(TaskHomeScope.running.matches(state: runningState, session: session))
        XCTAssertFalse(TaskHomeScope.running.matches(state: waitingState, session: session))
        XCTAssertFalse(TaskHomeScope.running.matches(state: .idle, session: session))
    }

    func testArchivedScopeMatchesOnlyArchivedSessions() throws {
        let archived = try contentSession(status: "archived")
        let active = try contentSession(status: "active")
        XCTAssertTrue(TaskHomeScope.archived.matches(state: .idle, session: archived))
        XCTAssertFalse(TaskHomeScope.archived.matches(state: .idle, session: active))
        // 「全部」默认不含归档，否则归档会把活跃任务挤出首屏
        XCTAssertFalse(TaskHomeScope.all.matches(state: .idle, session: archived))
        XCTAssertTrue(TaskHomeScope.all.matches(state: .idle, session: active))
    }

    /// 归档的任务即使还挂着 waiting 投影，也不该进「等我确认」——它已经被收起来了。
    func testArchivedSessionNeverMatchesActiveScopes() throws {
        let archived = try contentSession(status: "archived")
        XCTAssertFalse(TaskHomeScope.needsYou.matches(state: waitingState, session: archived))
        XCTAssertFalse(TaskHomeScope.running.matches(state: runningState, session: archived))
    }

    func testWireStatusMapsScopeToServerFilter() {
        XCTAssertEqual(TaskHomeScope.all.wireStatus, "active")
        XCTAssertEqual(TaskHomeScope.needsYou.wireStatus, "active")
        XCTAssertEqual(TaskHomeScope.running.wireStatus, "active")
        XCTAssertEqual(TaskHomeScope.archived.wireStatus, "archived")
    }

    func testWireRunStatusMapsScopeToServerFilter() {
        XCTAssertNil(TaskHomeScope.all.wireRunStatus)
        XCTAssertEqual(TaskHomeScope.needsYou.wireRunStatus, "waiting_user")
        XCTAssertEqual(TaskHomeScope.running.wireRunStatus, "running")
        XCTAssertNil(TaskHomeScope.archived.wireRunStatus)
    }

    // MARK: - TaskHomeListPolicy

    func testSanitizedWorkspaceIdClearsStaleCrossOrganizationSelection() {
        let available = Set(["ws-org-b-1", "ws-org-b-2"])
        // 冷启动进 B 组织，SceneStorage 仍是 A 组织的 workspaceId
        XCTAssertNil(
            TaskHomeListPolicy.sanitizedWorkspaceId(
                selected: "ws-org-a-stale",
                availableIds: available
            )
        )
        XCTAssertEqual(
            TaskHomeListPolicy.sanitizedWorkspaceId(
                selected: "ws-org-b-1",
                availableIds: available
            ),
            "ws-org-b-1"
        )
        XCTAssertNil(
            TaskHomeListPolicy.sanitizedWorkspaceId(
                selected: nil,
                availableIds: available
            )
        )
        // 组织确实没有可执行 Workspace 时，任何残留 id 也要清掉
        XCTAssertNil(
            TaskHomeListPolicy.sanitizedWorkspaceId(
                selected: "ws-org-a-stale",
                availableIds: []
            )
        )
    }

    private func loadFixture() throws -> Fixture {
        let url = try XCTUnwrap(
            Bundle(for: Self.self).url(
                forResource: "session_run_projection",
                withExtension: "json"
            )
        )
        return try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: url))
    }

    private func projection(_ state: SessionRunState) -> SessionRunProjection {
        SessionRunProjection(authoritative: state, localOverlay: nil)
    }

    private func recentSession(
        id: String,
        title: String,
        status: String
    ) throws -> RecentSession {
        try JSONDecoder().decode(
            RecentSession.self,
            from: Data(
                """
                {
                  "id": "\(id)",
                  "title": "\(title)",
                  "status": "\(status)",
                  "run_state": null
                }
                """.utf8
            )
        )
    }

    @MainActor
    private func envelope(
        sessionId: String,
        state: SessionRunState
    ) throws -> WSEnvelope {
        let organizationId = WorkspaceStore.shared.selectedOrganizationId ?? "org-4679"
        let stateJSON = try XCTUnwrap(
            String(data: JSONEncoder().encode(state), encoding: .utf8)
        )
        return try JSONDecoder().decode(
            WSEnvelope.self,
            from: Data(
                """
                {
                  "v": 1,
                  "type": "chat.session.run_state.updated",
                  "request_id": "req-test",
                  "ts": 1,
                  "device_id": "server",
                  "role": "server",
                  "organization_id": "\(organizationId)",
                  "payload": {
                    "session_id": "\(sessionId)",
                    "organization_id": "\(organizationId)",
                    "run_state": \(stateJSON)
                  }
                }
                """.utf8
            )
        )
    }

    private func state(
        runId: String,
        sequence: Int,
        revision: Int,
        status: SessionRunStatus
    ) -> SessionRunState {
        SessionRunState(
            runId: runId,
            sequence: sequence,
            revision: revision,
            status: status,
            queueDepth: 0,
            startedAt: "2026-07-28T10:00:00Z",
            stateChangedAt: "2026-07-28T10:00:01Z",
            endedAt: status.isTerminal ? "2026-07-28T10:00:01Z" : nil,
            stopReason: nil,
            errorClass: status == .failed ? "runtime_error" : nil,
            waitingInteractionId: status == .waitingUser ? "interaction-1" : nil
        )
    }

    private func summary(_ status: SessionRunStatus) -> AgentRunPresentationState {
        AgentRunPresentationState.sessionSummary(runStatus: status, hasUnreadReply: false)
    }

    private func notification(sessionId: String, type: String) -> MobileNotification {
        MobileNotification(
            id: "\(type)-\(sessionId)",
            type: type,
            title: "",
            body: "",
            metadata: ["session_id": AnyCodable(sessionId)],
            organizationId: "org-4679",
            priority: nil,
            category: nil,
            sourceExtensionId: nil,
            navigateTo: nil,
            isRead: false,
            readAt: nil,
            createdAt: "2026-07-28T10:00:00Z"
        )
    }
}
