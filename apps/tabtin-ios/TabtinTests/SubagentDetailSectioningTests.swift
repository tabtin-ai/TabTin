import XCTest
@testable import Tabtin

final class SubagentDetailSectioningTests: XCTestCase {
    func testRunningWithTaskAndStepsHasPendingResult() {
        var run = SubagentRun.pending(runId: "run-pending")
        run.status = .running
        run.task = "找到 ClientError 定义"
        run.label = "代码探索"
        run.transcript = [
            item(id: "t1", kind: .thinking, text: "先搜类型名"),
            item(id: "tool1", kind: .tool, title: "Grep", text: nil),
            item(id: "a1", kind: .assistant, text: nil),
        ]

        let sections = SubagentDetailSectioning.sections(for: run)

        XCTAssertEqual(sections.instruction, "找到 ClientError 定义")
        XCTAssertEqual(sections.steps.map(\.id), ["t1", "tool1"])
        XCTAssertTrue(sections.steps.allSatisfy { $0.kind != .assistant })
        XCTAssertEqual(sections.result.assistantTexts, [])
        XCTAssertNil(sections.result.terminalConclusion)
        XCTAssertNil(sections.result.failureGuidance)
        XCTAssertTrue(sections.result.isPendingResult)
    }

    func testCompletedPutsAssistantInResultAndDropsRedundantSummary() {
        var run = SubagentRun.pending(runId: "run-done")
        run.status = .completed
        run.task = "定位入口"
        run.summary = "已找到调用入口"
        run.transcript = [
            item(id: "think", kind: .thinking, text: "从 ViewModel 往下追"),
            item(id: "tool", kind: .tool, title: "Read", text: nil),
            item(id: "assistant", kind: .assistant, text: "入口在 ConversationViewModel"),
            item(id: "sys", kind: .system, text: "budget ok"),
        ]

        let sections = SubagentDetailSectioning.sections(for: run)

        XCTAssertEqual(sections.instruction, "定位入口")
        XCTAssertEqual(sections.steps.map(\.kind), [.thinking, .tool, .system])
        XCTAssertFalse(sections.steps.contains(where: { $0.kind == .assistant }))
        XCTAssertEqual(sections.result.assistantTexts, ["入口在 ConversationViewModel"])
        // 已有 assistant 正文时不再叠一层 summary「结果摘要」
        XCTAssertNil(sections.result.terminalConclusion)
        XCTAssertNil(sections.result.failureGuidance)
        XCTAssertFalse(sections.result.isPendingResult)
        XCTAssertFalse(sections.result.assistantTexts.contains(where: { $0.contains("从 ViewModel") }))
    }

    func testCompletedWithoutAssistantKeepsSummaryAsConclusion() {
        var run = SubagentRun.pending(runId: "run-summary-only")
        run.status = .completed
        run.summary = "44"
        run.transcript = [
            item(id: "think", kind: .thinking, text: "数文件"),
        ]

        let sections = SubagentDetailSectioning.sections(for: run)

        XCTAssertEqual(sections.result.assistantTexts, [])
        XCTAssertEqual(sections.result.terminalConclusion, "44")
        XCTAssertFalse(sections.result.isPendingResult)
    }

    func testFiltersThinkingIterationNoiseFromSteps() {
        var run = SubagentRun.pending(runId: "run-noise")
        run.status = .running
        run.transcript = [
            item(id: "noise-1", kind: .system, title: "Thinking...", text: nil),
            item(id: "think", kind: .thinking, text: "真正思考"),
            item(id: "noise-2", kind: .system, title: "Thinking... (iteration 2)", text: nil),
            item(id: "tool", kind: .tool, title: "run_terminal_command", text: nil),
            item(id: "sys-ok", kind: .system, title: "事件", text: "checkpoint ok"),
        ]

        let sections = SubagentDetailSectioning.sections(for: run)

        XCTAssertEqual(sections.steps.map(\.id), ["think", "tool", "sys-ok"])
        XCTAssertTrue(SubagentDetailSectioning.isThinkingIterationNoise(
            item(id: "n", kind: .system, title: "thinking (iteration 3)", text: nil)
        ))
        XCTAssertFalse(SubagentDetailSectioning.isThinkingIterationNoise(
            item(id: "ok", kind: .system, title: "事件", text: "x")
        ))
    }

    func testFailedPutsErrorInConclusionWithFailureGuidance() {
        var run = SubagentRun.pending(runId: "run-fail")
        run.status = .failed
        run.label = "读仓库"
        run.error = "访问工作区失败"
        run.transcript = [
            item(id: "err", kind: .error, text: "permission denied"),
            item(id: "assistant", kind: .assistant, text: "没法继续"),
        ]

        let sections = SubagentDetailSectioning.sections(for: run)

        XCTAssertEqual(sections.instruction, "读仓库")
        XCTAssertEqual(sections.steps.map(\.kind), [.error])
        XCTAssertEqual(sections.result.assistantTexts, ["没法继续"])
        XCTAssertEqual(sections.result.terminalConclusion, "访问工作区失败")
        XCTAssertEqual(
            sections.result.failureGuidance,
            "当前没有独立重试通道；可让父 Agent 根据此结论重新委派。"
        )
        XCTAssertFalse(sections.result.isPendingResult)
    }

    func testInstructionFallsBackToLabelThenNil() {
        var labeled = SubagentRun.pending(runId: "run-label")
        labeled.label = "仅有标签"
        labeled.task = "   "
        XCTAssertEqual(SubagentDetailSectioning.sections(for: labeled).instruction, "仅有标签")

        let empty = SubagentRun.pending(runId: "run-empty")
        XCTAssertNil(SubagentDetailSectioning.sections(for: empty).instruction)
    }

    func testThinkingAndToolDoNotAppearInAssistantTexts() {
        var run = SubagentRun.pending(runId: "run-split")
        run.status = .running
        run.transcript = [
            item(id: "think", kind: .thinking, text: "思考正文不应进结果列表"),
            item(id: "tool", kind: .tool, title: "Bash", text: "工具输出也不进"),
            item(id: "rich", kind: .richContent, text: "rich"),
        ]

        let sections = SubagentDetailSectioning.sections(for: run)

        XCTAssertEqual(sections.steps.map(\.id), ["think", "tool", "rich"])
        XCTAssertEqual(sections.result.assistantTexts, [])
        XCTAssertTrue(sections.result.isPendingResult)
    }

    private func item(
        id: String,
        kind: SubagentTranscriptItem.Kind,
        title: String? = nil,
        text: String?
    ) -> SubagentTranscriptItem {
        SubagentTranscriptItem(
            id: id,
            messageId: nil,
            index: nil,
            kind: kind,
            title: title,
            text: text,
            inputText: nil,
            outputText: nil,
            isFinal: true,
            isError: kind == .error,
            toolCallId: nil,
            richContent: nil,
            contextRef: nil
        )
    }
}

