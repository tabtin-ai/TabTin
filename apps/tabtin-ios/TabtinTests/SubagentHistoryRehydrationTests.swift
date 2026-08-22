import XCTest
@testable import Tabtin

final class SubagentHistoryRehydrationTests: XCTestCase {
    func testExtractAndStripSubagentIdMarker() {
        let raw = "统计完成：44\n\n[子 Agent ID: run-abc-123]"
        XCTAssertEqual(SubagentHistoryRehydration.extractSubagentRunId(from: raw), "run-abc-123")
        XCTAssertEqual(SubagentHistoryRehydration.stripSubagentIdMarker(from: raw), "统计完成：44")
        XCTAssertNil(SubagentHistoryRehydration.extractSubagentRunId(from: "无标记"))
    }

    func testDeriveRunFromParentToolUseAndResult() {
        let tool = ToolCall(
            toolCallId: "agent_0",
            index: 0,
            name: "agent",
            inputJson: #"{"prompt":"数文件","description":"测试子代理 1"}"#,
            finalized: true,
            resultText: "44\n\n[子 Agent ID: child-1]",
            isError: false
        )
        let message = ChatMessage(
            id: "msg-parent",
            serverId: "msg-parent",
            persistedId: "msg-parent",
            role: .assistant,
            blocks: [.tool(tool)],
            isStreaming: false,
            createdAt: Date(timeIntervalSince1970: 1_700_000_000)
        )

        let runs = SubagentHistoryRehydration.deriveRuns(from: [message])

        XCTAssertEqual(runs.count, 1)
        XCTAssertEqual(runs[0].runId, "child-1")
        XCTAssertEqual(runs[0].parentToolCallId, "agent_0")
        XCTAssertEqual(runs[0].task, "数文件")
        XCTAssertEqual(runs[0].label, "测试子代理 1")
        XCTAssertEqual(runs[0].status, .completed)
        XCTAssertEqual(runs[0].summary, "44")
    }

    func testCheckAgentDoesNotDeriveRun() {
        let tool = ToolCall(
            toolCallId: "agent_check",
            index: 0,
            name: "agent",
            inputJson: #"{"check_agent_id":"child-1"}"#,
            finalized: true,
            resultText: "ok\n\n[子 Agent ID: child-1]",
            isError: false
        )
        let message = ChatMessage(
            id: "msg-check",
            role: .assistant,
            blocks: [.tool(tool)],
            isStreaming: false
        )

        XCTAssertTrue(SubagentHistoryRehydration.deriveRuns(from: [message]).isEmpty)
    }

    func testTranscriptFromChildDTOAndSectionsNonEmpty() throws {
        let parentTool = ToolCall(
            toolCallId: "agent_0",
            index: 0,
            name: "agent",
            inputJson: #"{"prompt":"You are a file statistician","description":"测试子代理 1"}"#,
            finalized: true,
            resultText: "44\n\n[子 Agent ID: child-99]",
            isError: false
        )
        let parent = ChatMessage(
            id: "parent",
            role: .assistant,
            blocks: [.tool(parentTool)],
            isStreaming: false
        )

        let history = try decodeHistory(#"""
        {"messages":[
          {"id":"child-msg","role":"assistant","content":"44","subagent_run_id":"child-99",
           "created_at":"2026-08-05T09:00:00Z",
           "content_blocks_json":[
             {"type":"thinking","thinking":"先 ls 再统计"},
             {"type":"tool_use","id":"bash_1","name":"run_terminal_command","input":{"command":"ls"}},
             {"type":"tool_result","tool_use_id":"bash_1","content":"a.txt\nb.txt","is_error":false},
             {"type":"text","text":"44"}
           ]}
        ]}
        """#)

        let reconciled = SubagentHistoryRehydration.reconcile(
            existing: [],
            messages: [parent],
            historyDTOs: history.messages
        )

        XCTAssertEqual(reconciled.count, 1)
        let run = reconciled[0]
        XCTAssertEqual(run.runId, "child-99")
        XCTAssertFalse(run.transcript.isEmpty)

        XCTAssertEqual(run.task, "You are a file statistician")
        XCTAssertEqual(run.label, "测试子代理 1")
        XCTAssertTrue(run.transcript.contains(where: { $0.kind == .thinking }))
        XCTAssertTrue(run.transcript.contains(where: { $0.kind == .tool }))
        XCTAssertTrue(run.transcript.contains(where: { $0.kind == .assistant && $0.text == "44" }))
        XCTAssertEqual(run.summary, "44")
    }

    func testReconcileDoesNotOverwriteLiveTranscript() throws {
        var live = SubagentRun.pending(runId: "child-1")
        live.status = .running
        live.transcript = [
            SubagentTranscriptItem(
                id: "live-think",
                messageId: nil,
                index: 0,
                kind: .thinking,
                title: "思考",
                text: "直播思考",
                inputText: nil,
                outputText: nil,
                isFinal: false,
                isError: false,
                toolCallId: nil,
                richContent: nil,
                contextRef: nil
            ),
        ]

        let parentTool = ToolCall(
            toolCallId: "agent_0",
            index: 0,
            name: "agent",
            inputJson: #"{"prompt":"任务"}"#,
            finalized: true,
            resultText: "done\n\n[子 Agent ID: child-1]",
            isError: false
        )
        let parent = ChatMessage(
            id: "p",
            role: .assistant,
            blocks: [.tool(parentTool)],
            isStreaming: false
        )
        let history = try decodeHistory(#"""
        {"messages":[
          {"id":"c","role":"assistant","subagent_run_id":"child-1",
           "content_blocks_json":[{"type":"text","text":"历史正文"}]}
        ]}
        """#)

        let merged = SubagentHistoryRehydration.reconcile(
            existing: [live],
            messages: [parent],
            historyDTOs: history.messages
        )

        XCTAssertEqual(merged.count, 1)
        // archive 终态覆盖 stale running
        XCTAssertEqual(merged[0].status, .completed)
        // live transcript 保留
        XCTAssertEqual(merged[0].transcript.first?.text, "直播思考")
        XCTAssertEqual(merged[0].task, "任务")
    }

    private func decodeHistory(_ json: String) throws -> MessageHistoryResponse {
        try JSONDecoder().decode(MessageHistoryResponse.self, from: Data(json.utf8))
    }
}
