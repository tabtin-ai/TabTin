import XCTest
@testable import Tabtin

final class SubagentPresentationPolicyTests: XCTestCase {
    func testRunningPresentationShowsLatestToolProgress() {
        var run = SubagentRun.pending(runId: "run-1")
        run.status = .running
        run.stepCount = 3
        run.latestTool = "Grep"
        run.latestToolStatus = .running

        let presentation = SubagentPresentationPolicy.presentation(for: run)

        XCTAssertEqual(presentation.statusLabel, "进行中")
        XCTAssertEqual(presentation.latestProgress, "第 3 步 · 正在使用 Grep")
        XCTAssertTrue(presentation.canRequestCancel)
        XCTAssertEqual(presentation.cancelLabel, "请求停止")
    }

    func testCancellationRequestDoesNotClaimCancelledBeforeTerminalEvent() {
        var run = SubagentRun.pending(runId: "run-2")
        run.status = .queued

        let requesting = SubagentPresentationPolicy.presentation(for: run, cancellationRequested: true)
        XCTAssertEqual(requesting.statusLabel, "排队中")
        XCTAssertEqual(requesting.subtitle, "正在尝试停止，等待运行状态回流")
        XCTAssertEqual(requesting.cancelLabel, "尝试停止中")
        XCTAssertFalse(requesting.canRequestCancel)

        run.status = .cancelled
        let terminal = SubagentPresentationPolicy.presentation(for: run)
        XCTAssertEqual(terminal.statusLabel, "已取消")
        XCTAssertFalse(terminal.canRequestCancel)
    }

    func testFailedRunKeepsConclusionAndOnlySuggestsParentRedispatch() {
        var run = SubagentRun.pending(runId: "run-3")
        run.status = .failed
        run.error = "访问工作区失败"

        let presentation = SubagentPresentationPolicy.presentation(for: run)

        XCTAssertEqual(presentation.terminalConclusion, "访问工作区失败")
        XCTAssertTrue(presentation.failureGuidance?.contains("父 Agent") == true)
        XCTAssertTrue(presentation.failureGuidance?.contains("重新委派") == true)
        XCTAssertFalse(presentation.failureGuidance?.contains("重试成功") == true)
        XCTAssertNil(presentation.cancelLabel)
    }

    func testCompletedRunExposesTerminalEvidenceSummary() {
        var run = SubagentRun.pending(runId: "run-4")
        run.status = .completed
        run.summary = "已找到调用入口"
        run.transcript = [
            SubagentTranscriptItem(
                id: "tool-1", messageId: nil, index: 0, kind: .tool,
                title: "Read", text: nil, inputText: nil,
                outputText: nil, isFinal: true, isError: false,
                toolCallId: "tool-1", richContent: nil, contextRef: nil
            ),
            SubagentTranscriptItem(
                id: "event-1", messageId: nil, index: 1, kind: .assistant,
                title: nil, text: "入口在 ConversationViewModel", inputText: nil,
                outputText: nil, isFinal: true, isError: false,
                toolCallId: nil, richContent: nil, contextRef: nil
            )
        ]

        let presentation = SubagentPresentationPolicy.presentation(for: run)

        XCTAssertEqual(presentation.statusLabel, "已完成")
        XCTAssertEqual(presentation.terminalConclusion, "已找到调用入口")
        XCTAssertEqual(presentation.evidenceSummary, "执行证据：1 个工具步骤，1 条执行流")
    }

    func testTerminalRunDoesNotReuseAnInProgressToolLabel() {
        var run = SubagentRun.pending(runId: "run-terminal")
        run.status = .completed
        run.latestTool = "Grep"
        run.latestToolStatus = .running

        let presentation = SubagentPresentationPolicy.presentation(for: run)

        XCTAssertEqual(presentation.statusLabel, "已完成")
        XCTAssertEqual(presentation.latestProgress, "最后一个工具：Grep")
        XCTAssertFalse(presentation.latestProgress?.contains("正在使用") ?? false)
    }

    func testThinkingStepLabelUsesDurationWhenTimestampsExist() {
        var streaming = SubagentTranscriptItem(
            id: "think-1", messageId: nil, index: 0, kind: .thinking,
            title: "思考", text: "先搜", inputText: nil, outputText: nil,
            isFinal: false, isError: false, toolCallId: nil,
            richContent: nil, contextRef: nil
        )
        XCTAssertEqual(SubagentThinkingStepPresentation.label(for: streaming), "思考中…")

        var completedNoTime = streaming
        completedNoTime.isFinal = true
        XCTAssertEqual(SubagentThinkingStepPresentation.label(for: completedNoTime), "思考完成")

        var timed = completedNoTime
        timed.startedAt = Date(timeIntervalSince1970: 100)
        timed.stoppedAt = Date(timeIntervalSince1970: 103.2)
        XCTAssertEqual(SubagentThinkingStepPresentation.label(for: timed), "思考了 3 秒")
        XCTAssertEqual(SubagentThinkingStepPresentation.elapsedSeconds(for: timed), 3)
    }
}
