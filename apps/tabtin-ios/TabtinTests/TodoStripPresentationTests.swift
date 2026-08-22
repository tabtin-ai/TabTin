import XCTest
@testable import Tabtin

final class TodoStripPresentationTests: XCTestCase {
    func testCollapsedStripShowsCurrentTaskAndDoneOverTotalWithoutPercent() {
        let strip = TodoStripPresentation.make(
            items: [
                item("t1", "整理需求", "completed"),
                item("t2", "实现 UI", "in_progress"),
                item("t3", "补测试", "pending"),
                item("t4", "废弃步骤", "cancelled"),
            ],
            paused: false,
            awaitingSubagents: false
        )

        XCTAssertEqual(strip?.label, "当前：实现 UI")
        XCTAssertEqual(strip?.progressText, "1/3")
        XCTAssertFalse(strip?.progressText.contains("%") ?? true)
        XCTAssertEqual(strip?.labelKind, .current)
        XCTAssertEqual(strip?.iconKind, .inProgress)
        XCTAssertEqual(strip?.isRunning, true)
    }

    func testPausedStreamingShowsPausedCurrentWithoutSpinner() {
        let strip = TodoStripPresentation.make(
            items: [
                item("t1", "整理需求", "completed"),
                item("t2", "实现 UI", "in_progress"),
                item("t3", "补测试", "pending"),
            ],
            paused: true,
            awaitingSubagents: false
        )

        XCTAssertEqual(strip?.label, "已暂停：实现 UI")
        XCTAssertEqual(strip?.progressText, "1/3")
        XCTAssertEqual(strip?.iconKind, .paused)
        XCTAssertEqual(strip?.isRunning, false)
    }

    func testAwaitingSubagentsBeatsPausedLabel() {
        let strip = TodoStripPresentation.make(
            items: [
                item("t1", "整理需求", "completed"),
                item("t2", "等待研究员汇总", "in_progress"),
                item("t3", "补测试", "pending"),
            ],
            paused: true,
            awaitingSubagents: true
        )

        XCTAssertEqual(strip?.label, "等待子任务：等待研究员汇总")
        XCTAssertEqual(strip?.labelKind, .awaitingSubagents)
        XCTAssertEqual(strip?.isRunning, false)
    }

    func testAllDoneKeepsStripVisible() {
        let strip = TodoStripPresentation.make(
            items: [
                item("t1", "整理需求", "completed"),
                item("t2", "实现 UI", "completed"),
            ],
            paused: true,
            awaitingSubagents: false
        )

        XCTAssertEqual(strip?.label, "待办已完成")
        XCTAssertEqual(strip?.progressText, "2/2")
        XCTAssertEqual(strip?.iconKind, .complete)
    }

    func testEmptyTodosHideStrip() {
        XCTAssertNil(TodoStripPresentation.make(items: [], paused: false, awaitingSubagents: false))
    }

    func testAwaitingSubagentsReadsActiveRuns() {
        var running = SubagentRun.pending(runId: "r1")
        running.status = .running
        XCTAssertTrue(TodoStripPresentation.awaitingSubagents([running]))

        var done = SubagentRun.pending(runId: "r2")
        done.status = .completed
        XCTAssertFalse(TodoStripPresentation.awaitingSubagents([done]))
    }

    private func item(_ id: String, _ content: String, _ status: String) -> AgentTodoItem {
        AgentTodoItem(id: id, content: content, status: status)
    }
}
