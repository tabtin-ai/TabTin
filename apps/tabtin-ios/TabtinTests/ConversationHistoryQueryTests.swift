import XCTest
@testable import Tabtin

@MainActor
final class ConversationHistoryQueryTests: XCTestCase {
    func testHistoryAlwaysRequestsExpandedArtifacts() {
        let query = ConversationViewModel.historyQuery(
            ["limit": "50", "before": "latest", "expand_artifacts": "false"],
            shareId: nil
        )

        XCTAssertEqual(query["expand_artifacts"], "true")
        XCTAssertEqual(query["limit"], "50")
        XCTAssertEqual(query["before"], "latest")
    }

    func testSharedHistoryKeepsShareIdAndExpandedArtifacts() {
        let query = ConversationViewModel.historyQuery(
            ["limit": "20"],
            shareId: "share-123"
        )

        XCTAssertEqual(query["expand_artifacts"], "true")
        XCTAssertEqual(query["share_id"], "share-123")
    }
}
