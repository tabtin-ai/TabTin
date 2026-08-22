import XCTest
@testable import Tabtin

final class TaskSurfaceStableLayoutTests: XCTestCase {
    func testChatFocusKeepsWorkbenchCollapsedOnTrailingEdge() {
        let geo = TaskSurfaceStableLayout.geometry(
            mode: .chatFocus,
            availableWidth: 1000,
            workbenchFraction: 0.4
        )
        XCTAssertEqual(geo.conversationWidth, 1000)
        XCTAssertEqual(geo.workbenchWidth, 0)
        XCTAssertEqual(geo.conversationOpacity, 1)
        XCTAssertEqual(geo.workbenchOpacity, 0)
        XCTAssertTrue(geo.conversationAllowsHitTesting)
        XCTAssertFalse(geo.workbenchAllowsHitTesting)
        XCTAssertFalse(geo.showsDivider)
        XCTAssertEqual(geo.workbenchTrailingInset, 0)
        XCTAssertEqual(geo.conversationLeadingInset, 0)
    }

    func testSplitPinsWorkbenchToTrailingEdgeAndStretchesLeading() {
        let geo = TaskSurfaceStableLayout.geometry(
            mode: .split,
            availableWidth: 1000,
            workbenchFraction: 0.4
        )
        XCTAssertEqual(geo.workbenchWidth, 400)
        XCTAssertEqual(geo.conversationWidth, 1000 - 400 - TaskSurfaceSplitMetrics.dividerHitWidth)
        XCTAssertTrue(geo.showsDivider)
        XCTAssertEqual(geo.workbenchTrailingInset, 0)
        XCTAssertEqual(geo.conversationLeadingInset, 0)
        XCTAssertEqual(geo.conversationOpacity, 1)
        XCTAssertEqual(geo.workbenchOpacity, 1)
        XCTAssertTrue(geo.conversationAllowsHitTesting)
        XCTAssertTrue(geo.workbenchAllowsHitTesting)
    }

    func testAppFocusExpandsWorkbenchFromTrailingEdge() {
        let geo = TaskSurfaceStableLayout.geometry(
            mode: .appFocus,
            availableWidth: 1000,
            workbenchFraction: 0.4
        )
        XCTAssertEqual(geo.workbenchWidth, 1000)
        XCTAssertEqual(geo.conversationWidth, 0)
        XCTAssertEqual(geo.workbenchOpacity, 1)
        XCTAssertEqual(geo.conversationOpacity, 0)
        XCTAssertFalse(geo.conversationAllowsHitTesting)
        XCTAssertTrue(geo.workbenchAllowsHitTesting)
        XCTAssertFalse(geo.showsDivider)
        XCTAssertEqual(geo.workbenchTrailingInset, 0)
    }

    func testBothPanesAlwaysPlacedOncePerMode() {
        for mode in TaskViewMode.allCases {
            let geo = TaskSurfaceStableLayout.geometry(
                mode: mode,
                availableWidth: 900,
                workbenchFraction: 0.35
            )
            // 对话与工作台各有一个 placement；不因模式销毁实例语义。
            XCTAssertGreaterThanOrEqual(geo.conversationWidth, 0)
            XCTAssertGreaterThanOrEqual(geo.workbenchWidth, 0)
            XCTAssertEqual(
                geo.conversationWidth + geo.workbenchWidth + (geo.showsDivider ? TaskSurfaceSplitMetrics.dividerHitWidth : 0),
                900,
                accuracy: 0.5
            )
        }
    }
}
