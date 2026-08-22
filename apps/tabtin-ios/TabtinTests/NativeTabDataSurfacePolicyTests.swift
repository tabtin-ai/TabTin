import XCTest
@testable import Tabtin

final class NativeTabDataSurfacePolicyTests: XCTestCase {
    func testOnlyGridListAndKanbanStayNative() {
        XCTAssertEqual(NativeTabDataSurfacePolicy.kind(viewType: "grid"), .cards)
        XCTAssertEqual(NativeTabDataSurfacePolicy.kind(viewType: "list"), .cards)
        XCTAssertEqual(NativeTabDataSurfacePolicy.kind(viewType: "kanban"), .kanban)
        XCTAssertEqual(NativeTabDataSurfacePolicy.kind(viewType: "calendar"), .summary)
        XCTAssertEqual(NativeTabDataSurfacePolicy.kind(viewType: "gallery"), .summary)
        XCTAssertEqual(NativeTabDataSurfacePolicy.kind(viewType: "form"), .summary)
        XCTAssertEqual(NativeTabDataSurfacePolicy.kind(viewType: "flashcard"), .summary)
        XCTAssertEqual(NativeTabDataSurfacePolicy.kind(viewType: "GANTT"), .summary)
        XCTAssertEqual(NativeTabDataSurfacePolicy.kind(viewType: "pivot"), .summary)
    }

    func testSupportsNativeCardsFollowsCardsAndKanbanOnly() {
        XCTAssertTrue(NativeTabDataSurfacePolicy.supportsNativeCards(viewType: "grid"))
        XCTAssertTrue(NativeTabDataSurfacePolicy.supportsNativeCards(viewType: "list"))
        XCTAssertTrue(NativeTabDataSurfacePolicy.supportsNativeCards(viewType: "kanban"))
        XCTAssertTrue(NativeTabDataSurfacePolicy.supportsNativeCards(viewType: "  Grid  "))
        XCTAssertFalse(NativeTabDataSurfacePolicy.supportsNativeCards(viewType: "calendar"))
        XCTAssertFalse(NativeTabDataSurfacePolicy.supportsNativeCards(viewType: "gallery"))
        XCTAssertFalse(NativeTabDataSurfacePolicy.supportsNativeCards(viewType: "form"))
        XCTAssertFalse(NativeTabDataSurfacePolicy.supportsNativeCards(viewType: "flashcard"))
        XCTAssertFalse(NativeTabDataSurfacePolicy.supportsNativeCards(viewType: "pivot"))
        XCTAssertFalse(NativeTabDataSurfacePolicy.supportsNativeCards(viewType: "gantt"))
    }
}
