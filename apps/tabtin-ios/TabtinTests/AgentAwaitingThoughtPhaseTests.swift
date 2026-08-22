import XCTest
@testable import Tabtin

final class AgentAwaitingThoughtPhaseTests: XCTestCase {
    private func thinking(
        index: Int,
        completed: Bool,
        text: String
    ) -> MessageBlock {
        .thinking(ThinkingSegment(
            messageId: "m1",
            index: index,
            text: text,
            completed: completed
        ))
    }

    private func tool(
        id: String,
        index: Int,
        phase: ToolExecutionPhase
    ) -> MessageBlock {
        .tool(ToolCall(
            toolCallId: id,
            index: index,
            name: "bash",
            inputJson: #"{"command":"ls"}"#,
            finalized: phase.isTerminal,
            resultText: phase.isTerminal ? "ok" : nil,
            executionPhase: phase
        ))
    }

    func testPendingWhenNoEffectiveBlocks() {
        let phase = AgentAwaitingThoughtPresentation.resolvePhase(
            sessionPulseVisible: true,
            isLastAssistantMessage: true,
            blocks: []
        )
        XCTAssertEqual(phase, .pending)
    }

    func testPlanningNextAfterSettledTool() {
        let phase = AgentAwaitingThoughtPresentation.resolvePhase(
            sessionPulseVisible: true,
            isLastAssistantMessage: true,
            blocks: [tool(id: "t1", index: 0, phase: .succeeded)]
        )
        XCTAssertEqual(phase, .planningNext)
    }

    func testEmptyStreamingThinkingKeepsPlanningNext() {
        let phase = AgentAwaitingThoughtPresentation.resolvePhase(
            sessionPulseVisible: true,
            isLastAssistantMessage: true,
            blocks: [
                tool(id: "t1", index: 0, phase: .succeeded),
                thinking(index: 1, completed: false, text: "  "),
            ]
        )
        XCTAssertEqual(phase, .planningNext)
        XCTAssertEqual(
            AgentAwaitingThoughtPresentation.resolveTailActivity(blocks: [
                tool(id: "t1", index: 0, phase: .succeeded),
                thinking(index: 1, completed: false, text: ""),
            ]),
            .settledTool
        )
    }

    func testVisibleThinkingHidesAwaitingShell() {
        let phase = AgentAwaitingThoughtPresentation.resolvePhase(
            sessionPulseVisible: true,
            isLastAssistantMessage: true,
            blocks: [
                tool(id: "t1", index: 0, phase: .succeeded),
                thinking(index: 1, completed: false, text: "下一步要读文件"),
            ]
        )
        XCTAssertEqual(phase, .hidden)
    }

    func testUnsettledToolHidesAwaitingShell() {
        let phase = AgentAwaitingThoughtPresentation.resolvePhase(
            sessionPulseVisible: true,
            isLastAssistantMessage: true,
            blocks: [tool(id: "t1", index: 0, phase: .running)]
        )
        XCTAssertEqual(phase, .hidden)
    }

    func testEmptyWhitespaceTextDoesNotBreakTimelineGroup() {
        let units = AssistantTimelineUnit.group([
            tool(id: "t1", index: 0, phase: .succeeded),
            .text(TextBlock(index: 1, text: " \n")),
            tool(id: "t2", index: 2, phase: .succeeded),
        ])
        XCTAssertEqual(units.count, 1)
        guard case let .stepGroup(group) = units.first else {
            return XCTFail("空 text 不应打断连续工具折叠")
        }
        XCTAssertEqual(group.count, 2)
    }

    /// 模型回吐的 turn_identity 展示为空，不能当成「可见正文」打断执行组。
    func testTurnIdentityOnlyTextDoesNotBreakTimelineGroup() {
        let identity = #"<turn_identity agent_id="agent-1">小Tin</turn_identity>"#
        XCTAssertTrue(
            AgentAwaitingThoughtPresentation.isInertWhitespaceText(
                .text(TextBlock(index: 1, text: identity))
            )
        )
        let units = AssistantTimelineUnit.group([
            tool(id: "t1", index: 0, phase: .succeeded),
            thinking(index: 1, completed: true, text: "准备写文件"),
            .text(TextBlock(index: 2, text: identity)),
            tool(id: "t2", index: 3, phase: .succeeded),
            tool(id: "t3", index: 4, phase: .succeeded),
        ])
        XCTAssertEqual(units.count, 1, "身份标签不应拆成多个「执行详情」")
        guard case let .stepGroup(group) = units.first else {
            return XCTFail("应合成单一执行组")
        }
        XCTAssertEqual(group.count, 4)
    }

    /// 跨消息合并同样要忽略仅含 turn_identity 的 text，否则会出现紧挨的多个「执行详情 · 2 步」。
    func testTurnIdentityDoesNotBlockCrossMessageStepCoalesce() {
        let identity = #"<turn_identity agent_id="a">x</turn_identity>"#
        let msgA = ChatMessage(
            id: "a",
            role: .assistant,
            blocks: [
                tool(id: "t1", index: 0, phase: .succeeded),
                thinking(index: 1, completed: true, text: "一步"),
                .text(TextBlock(index: 2, text: identity)),
            ]
        )
        let msgB = ChatMessage(
            id: "b",
            role: .assistant,
            blocks: [
                tool(id: "t2", index: 0, phase: .succeeded),
                tool(id: "t3", index: 1, phase: .succeeded),
            ]
        )
        XCTAssertTrue(msgA.isCrossMessageStepOnly)
        XCTAssertTrue(msgB.isCrossMessageStepOnly)
        let units = MessageListRenderUnit.group([msgA, msgB])
        XCTAssertEqual(units.count, 1)
        guard case let .stepGroup(grouped) = units.first else {
            return XCTFail("含 turn_identity 的纯步骤子轮仍应跨消息合并")
        }
        XCTAssertEqual(grouped.map(\.id), ["a", "b"])
    }

    /// 历史接口给每条 assistant 都挂 checkpoint_record。那是回退元数据，不能切开执行组。
    func testCheckpointRecordDoesNotBlockCrossMessageStepCoalesce() {
        let checkpoint = ChatCheckpointRecord(checkpointId: "cp-1", status: .ready)
        let msgA = ChatMessage(
            id: "a",
            role: .assistant,
            blocks: [tool(id: "t1", index: 0, phase: .succeeded)],
            checkpointRecord: checkpoint
        )
        let msgB = ChatMessage(
            id: "b",
            role: .assistant,
            blocks: [tool(id: "t2", index: 0, phase: .succeeded)],
            checkpointRecord: checkpoint
        )
        XCTAssertTrue(msgA.isCrossMessageStepOnly)
        XCTAssertTrue(msgB.isCrossMessageStepOnly)
        let units = MessageListRenderUnit.group([msgA, msgB])
        XCTAssertEqual(units.count, 1)
        guard case let .stepGroup(grouped) = units.first else {
            return XCTFail("带 checkpoint 的连续纯步骤子轮仍应合成一个执行组")
        }
        XCTAssertEqual(grouped.map(\.id), ["a", "b"])
    }

    func testEmptyStreamingThinkingIsNotActiveTail() {
        let emptyThinking = thinking(index: 1, completed: false, text: "")
        let summary = ExecutionGroupSummary(blocks: [
            tool(id: "t1", index: 0, phase: .succeeded),
            emptyThinking,
        ])
        XCTAssertTrue(summary.isRunning)
        XCTAssertNil(summary.activeTailId, "空 thinking 不应外露为组尾可见行")
    }

    func testConsecutiveStepOnlyMessagesCoalesceIntoOneRenderUnit() {
        let msgA = ChatMessage(
            id: "a",
            role: .assistant,
            blocks: [
                tool(id: "t1", index: 0, phase: .succeeded),
                tool(id: "t2", index: 1, phase: .succeeded),
            ]
        )
        let msgB = ChatMessage(
            id: "b",
            role: .assistant,
            blocks: [
                tool(id: "t3", index: 0, phase: .succeeded),
                tool(id: "t4", index: 1, phase: .succeeded),
            ]
        )
        let units = MessageListRenderUnit.group([msgA, msgB])
        XCTAssertEqual(units.count, 1)
        guard case let .stepGroup(grouped) = units.first else {
            return XCTFail("连续纯步骤子轮应合成一个 RenderUnit")
        }
        XCTAssertEqual(grouped.map(\.id), ["a", "b"])
    }

    func testEmptyShellMessageIsTimelineTransparent() {
        let empty = ChatMessage(id: "empty", role: .user, blocks: [])
        XCTAssertTrue(empty.isTimelineTransparent)
        let streaming = ChatMessage(id: "stream", role: .assistant, blocks: [], isStreaming: true)
        XCTAssertFalse(streaming.isTimelineTransparent, "流式占位不能当透明壳丢掉")
    }
}
