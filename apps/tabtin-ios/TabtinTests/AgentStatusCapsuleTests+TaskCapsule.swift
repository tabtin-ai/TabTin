import XCTest
@testable import Tabtin

/// Fixture-driven TaskCapsule 投影：与 `packages/agent-wire/.../task-capsule-status-v1.json` 对齐。
final class TaskCapsuleStatusTests: XCTestCase {
    func testFixtureCasesMatchCrossLangContract() throws {
        // TabtinTests → tabtin-ios → apps → repo root
        let fixtureURL = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("packages/agent-wire/src/cross-lang-fixtures/task-capsule-status-v1.json")
        let data = try Data(contentsOf: fixtureURL)
        let json = try JSONSerialization.jsonObject(with: data) as? [String: Any]
        let cases = json?["cases"] as? [[String: Any]] ?? []
        XCTAssertFalse(cases.isEmpty, "fixture cases should not be empty at \(fixtureURL.path)")

        for testCase in cases {
            let name = testCase["name"] as? String ?? "unnamed"
            let inputDict = testCase["input"] as? [String: Any] ?? [:]
            let expectedStatus = testCase["expected_status"] as? String
            let expectedVisual = testCase["expected_visual"] as? String

            let input = TaskCapsuleStatusInput(
                busy: inputDict["busy"] as? Bool ?? false,
                runPhase: (inputDict["runPhase"] as? String).flatMap(TaskCapsuleRunPhase.init(rawValue:)),
                completedToolCalls: inputDict["completedToolCalls"] as? Int,
                queuedCount: inputDict["queuedCount"] as? Int,
                pendingApproval: inputDict["pendingApproval"] as? Bool,
                pendingAnswer: inputDict["pendingAnswer"] as? Bool,
                paused: inputDict["paused"] as? Bool,
                suspended: inputDict["suspended"] as? Bool,
                unreadCount: inputDict["unreadCount"] as? Int
            )
            let status = TaskCapsuleStatus.resolve(input)
            let visual = TaskCapsuleStatus.resolveVisual(status)
            XCTAssertEqual(status.rawValue, expectedStatus, "status mismatch for \(name)")
            XCTAssertEqual(visual.rawValue, expectedVisual, "visual mismatch for \(name)")
        }
    }

    func testOnlyReadyIsMiniUnreadCompleteIsFull() {
        XCTAssertEqual(TaskCapsuleStatus.resolveVisual(.ready), .mini)
        XCTAssertEqual(TaskCapsuleStatus.resolveVisual(.complete), .full)
        XCTAssertEqual(TaskCapsuleStatus.resolveVisual(.paused), .full)
        XCTAssertEqual(
            TaskCapsuleStatus.resolve(TaskCapsuleStatusInput(busy: false, unreadCount: 1)),
            .complete
        )
        XCTAssertEqual(
            TaskCapsuleStatus.resolveVisual(
                TaskCapsuleStatus.resolve(TaskCapsuleStatusInput(busy: false, unreadCount: 1))
            ),
            .full
        )
    }

    func testPausedCopyMatchesElectron() {
        XCTAssertEqual(TaskCapsuleStatus.statusTitle(.paused), "任务已暂停")
        XCTAssertEqual(TaskCapsuleStatus.statusTitle(.ready), "随时待命")
        XCTAssertEqual(TaskCapsuleStatus.statusTitle(.needsApproval), "等待你确认")
        XCTAssertEqual(TaskCapsuleStatus.statusTitle(.complete, unreadCount: 2), "已完成 · 2 条更新")
    }

    func testRunStateGateUsesCanonicalVisual() {
        let unreadComplete = AgentRunPresentationState(
            phase: .completed(hasUnreadReply: true),
            currentAction: nil,
            failureReason: nil,
            recovery: nil,
            unreadReplyCount: 2
        )
        XCTAssertEqual(AgentCapsuleRunStateGate.presentation(for: unreadComplete), .full)
        XCTAssertEqual(
            TaskCapsuleStatus.resolve(TaskCapsuleStatus.input(from: unreadComplete)),
            .complete
        )
        XCTAssertEqual(
            TaskCapsuleStatus.input(from: unreadComplete).unreadCount,
            2
        )

        let readComplete = AgentRunPresentationState(
            phase: .completed(hasUnreadReply: false),
            currentAction: nil,
            failureReason: nil,
            recovery: nil
        )
        XCTAssertEqual(AgentCapsuleRunStateGate.presentation(for: readComplete), .mini)
        XCTAssertEqual(AgentCapsuleRunStateGate.presentation(for: .idle), .mini)

        let paused = AgentRunPresentationState(
            phase: .paused,
            currentAction: nil,
            failureReason: nil,
            recovery: nil
        )
        XCTAssertEqual(AgentCapsuleRunStateGate.presentation(for: paused), .full)
    }

    func testPendingAnswerProjectsNeedsAnswerNotApproval() {
        let waiting = AgentRunPresentationState(
            phase: .waitingForUser(count: 1),
            currentAction: nil,
            failureReason: nil,
            recovery: nil
        )
        XCTAssertEqual(
            TaskCapsuleStatus.resolve(
                TaskCapsuleStatus.input(from: waiting, pendingAnswer: true)
            ),
            .needsAnswer
        )
        XCTAssertEqual(
            AgentCapsuleRunStateGate.presentation(
                for: waiting,
                pendingApproval: false,
                pendingAnswer: true
            ),
            .full
        )
    }

    func testPlanningWithCompletedToolsProjectsPlanningNext() {
        let planningNext = AgentRunPresentationState(
            phase: .planning,
            currentAction: nil,
            failureReason: nil,
            recovery: nil,
            completedToolCalls: 2
        )
        XCTAssertEqual(
            TaskCapsuleStatus.resolve(TaskCapsuleStatus.input(from: planningNext)),
            .planningNext
        )
        let thinking = AgentRunPresentationState(
            phase: .planning,
            currentAction: nil,
            failureReason: nil,
            recovery: nil,
            completedToolCalls: 0
        )
        XCTAssertEqual(
            TaskCapsuleStatus.resolve(TaskCapsuleStatus.input(from: thinking)),
            .thinking
        )
    }

    func testQueuedCountFromRunStateProjectsQueued() {
        let idleQueued = AgentRunPresentationState(
            phase: .idle,
            currentAction: nil,
            failureReason: nil,
            recovery: nil,
            queuedCount: 3
        )
        XCTAssertEqual(
            TaskCapsuleStatus.resolve(TaskCapsuleStatus.input(from: idleQueued)),
            .queued
        )
        XCTAssertEqual(
            TaskCapsuleStatus.statusTitle(.queued, queuedCount: 3),
            "等待执行 · 3 项排队"
        )
        XCTAssertEqual(AgentCapsuleRunStateGate.presentation(for: idleQueued), .full)
    }

    func testUnreadAssistantCountAlignsWithSeenUntil() {
        let older = ChatMessage(
            id: "a1",
            role: .assistant,
            text: "old",
            createdAt: Date(timeIntervalSince1970: 100)
        )
        let newer = ChatMessage(
            id: "a2",
            role: .assistant,
            text: "new",
            createdAt: Date(timeIntervalSince1970: 300)
        )
        let user = ChatMessage(
            id: "u1",
            role: .user,
            text: "hi",
            createdAt: Date(timeIntervalSince1970: 400)
        )
        let count = TaskCapsuleActivity.unreadAssistantCount(
            messages: [older, newer, user],
            seenUntil: Date(timeIntervalSince1970: 200)
        )
        XCTAssertEqual(count, 1)
        XCTAssertEqual(
            TaskCapsuleActivity.resolveUnreadCount(messages: [older, newer], readState: nil),
            0,
            "无 read_state 时不得把历史 assistant 全算未读"
        )

        let readState = SessionReadState(
            lastReadRunSequence: 1,
            lastReadTerminalRevision: 1,
            readAt: "1970-01-01T00:03:20Z",
            latestCompletedRunId: "r2",
            latestCompletedRunSequence: 2,
            latestCompletedTerminalRevision: 1
        )
        XCTAssertTrue(readState.hasUnreadCompletedReply)
        let resolved = TaskCapsuleActivity.resolveUnreadCount(
            messages: [older, newer],
            readState: readState
        )
        XCTAssertEqual(resolved, 1)
        XCTAssertEqual(
            TaskCapsuleStatus.statusTitle(.complete, unreadCount: resolved),
            "已完成 · 1 条更新"
        )
    }

    func testCompletedToolCallsIgnoresTodoTools() {
        var todo = ToolCall(
            toolCallId: "t0",
            index: 0,
            name: "todo_write",
            inputJson: "{}",
            finalized: true
        )
        todo.resultText = "ok"
        var shell = ToolCall(
            toolCallId: "t1",
            index: 1,
            name: "shell",
            inputJson: "{}",
            finalized: true
        )
        shell.resultText = "done"
        let message = ChatMessage(
            id: "a",
            role: .assistant,
            text: "",
            toolCalls: [todo, shell],
            isStreaming: true
        )
        XCTAssertEqual(TaskCapsuleActivity.completedToolCalls(in: [message]), 1)
    }
}
