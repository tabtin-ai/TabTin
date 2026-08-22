import XCTest
@testable import Tabtin

/// 子 Agent 事件解码、WireDecoder 路由与运行状态合并规则。
final class SubagentModelsTests: XCTestCase {
    private let decoder = WireDecoder()

    private func envelope(_ short: String, payload: [String: Any]) -> WSEnvelope {
        WSEnvelope.build(type: AgentStreamEvent.fullType(short), deviceId: "ios-test", payload: payload)
    }

    // MARK: - SubagentEvent 解码 + WireDecoder 路由

    func testSubagentStartedDecodesAndRoutes() {
        let env = envelope(AgentStreamEvent.subagentStarted, payload: [
            "subagent_run_id": "run1",
            "label": "代码探索",
            "task": "找到 ClientError 定义",
            "started_at": 1_700_000_000.0,
        ])
        guard case let .subagent(event) = decoder.decode(env) else {
            return XCTFail("expected .subagent decoded event")
        }
        XCTAssertEqual(event.kind, .started)
        XCTAssertEqual(event.runId, "run1")
        XCTAssertEqual(event.label, "代码探索")
        XCTAssertEqual(event.task, "找到 ClientError 定义")
    }

    func testSubagentProgressParsesToolHistory() {
        let env = envelope(AgentStreamEvent.subagentProgress, payload: [
            "subagent_run_id": "run2",
            "step_count": 3,
            "latest_tool": "Grep",
            "latest_success": true,
            "elapsed_ms": 4200,
            "tool_history": [
                ["tool_name": "Read", "success": true, "input_summary": "main.swift"],
                ["tool_name": "Grep", "success": false],
            ],
        ])
        guard case let .subagent(event) = decoder.decode(env) else {
            return XCTFail("expected .subagent progress")
        }
        XCTAssertEqual(event.kind, .progress)
        XCTAssertEqual(event.stepCount, 3)
        XCTAssertEqual(event.latestTool, "Grep")
        XCTAssertEqual(event.elapsedMs, 4200)
        XCTAssertEqual(event.toolHistory.count, 2)
        XCTAssertEqual(event.toolHistory.first?.toolName, "Read")
        XCTAssertEqual(event.toolHistory.first?.inputSummary, "main.swift")
        XCTAssertEqual(event.toolHistory.last?.success, false)
    }

    func testSubagentFailedCancelledClassification() {
        let env = envelope(AgentStreamEvent.subagentFailed, payload: [
            "subagent_run_id": "run3",
            "error": "用户取消",
            "error_kind": "cancelled",
            "cancelled": true,
        ])
        guard case let .subagent(event) = decoder.decode(env) else {
            return XCTFail("expected .subagent failed")
        }
        XCTAssertEqual(event.kind, .failed)
        XCTAssertEqual(event.errorKind, "cancelled")
        XCTAssertEqual(event.cancelled, true)
    }

    func testSubagentMissingRunIdFallsBackToIgnored() {
        let env = envelope(AgentStreamEvent.subagentStarted, payload: ["label": "无 id"])
        guard case .ignored = decoder.decode(env) else {
            return XCTFail("expected .ignored when run id missing")
        }
    }

    func testSubagentIdAliasResolves() {
        let env = envelope(AgentStreamEvent.subagentCompleted, payload: [
            "subagent_id": "legacy1",
            "summary": "完成",
        ])
        guard case let .subagent(event) = decoder.decode(env) else {
            return XCTFail("expected .subagent via subagent_id alias")
        }
        XCTAssertEqual(event.runId, "legacy1")
        XCTAssertEqual(event.summary, "完成")
    }

    func testSubagentRunMergesRealtimeActivityAndKeepsTerminalStateMonotonic() {
        func event(_ kind: String, _ payload: [String: Any]) -> SubagentEvent {
            let decoded = decoder.decode(envelope(kind, payload: payload))
            guard case let .subagent(event) = decoded else {
                XCTFail("expected subagent event")
                fatalError("missing subagent event")
            }
            return event
        }

        var run = SubagentRun.pending(runId: "run-state")
        run.merge(event(AgentStreamEvent.subagentQueued, [
            "subagent_run_id": "run-state",
        ]))
        XCTAssertEqual(run.status, .queued)

        run.merge(event(AgentStreamEvent.subagentProgress, [
            "subagent_run_id": "run-state",
            "latest_tool": "Grep",
            "latest_tool_status": "running",
            "summary": "正在查找引用",
            "step_count": 1,
        ]))
        XCTAssertEqual(run.status, .running)
        XCTAssertEqual(run.latestTool, "Grep")
        XCTAssertEqual(run.latestToolStatus, .running)
        XCTAssertEqual(run.summary, "正在查找引用")

        run.merge(event(AgentStreamEvent.subagentCompleted, [
            "subagent_run_id": "run-state",
            "summary": "找到 3 处引用",
            "duration_ms": 2_400,
        ]))
        XCTAssertEqual(run.status, .completed)
        XCTAssertEqual(run.summary, "找到 3 处引用")
        XCTAssertEqual(run.durationMs, 2_400)

        // 乱序 progress/queued 只能补充无害字段，不得把终态降回 running/queued。
        run.merge(event(AgentStreamEvent.subagentProgress, [
            "subagent_run_id": "run-state",
            "latest_tool": "Read",
            "latest_tool_status": "running",
            "summary": "迟到进度",
        ]))
        run.merge(event(AgentStreamEvent.subagentQueued, [
            "subagent_run_id": "run-state",
        ]))
        XCTAssertEqual(run.status, .completed)
        XCTAssertEqual(run.summary, "找到 3 处引用")
        XCTAssertEqual(run.latestToolStatus, .completed)
    }

    //  隔离门闩与 ViewModel 集成见 SubagentStreamIsolationTests。

}
