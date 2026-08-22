import XCTest
@testable import Tabtin

final class NativeTabDataRecordNavigationPolicyTests: XCTestCase {
    func testNeighborsFollowVisibleRecordOrder() {
        let ids = ["a", "b", "c"]

        let first = NativeTabDataRecordNavigationPolicy.neighbors(recordIds: ids, currentId: "a")
        XCTAssertNil(first.previousId)
        XCTAssertEqual(first.nextId, "b")

        let last = NativeTabDataRecordNavigationPolicy.neighbors(recordIds: ids, currentId: "c")
        XCTAssertEqual(last.previousId, "b")
        XCTAssertNil(last.nextId)

        let middle = NativeTabDataRecordNavigationPolicy.neighbors(recordIds: ids, currentId: "b")
        XCTAssertEqual(middle.previousId, "a")
        XCTAssertEqual(middle.nextId, "c")

        let missing = NativeTabDataRecordNavigationPolicy.neighbors(recordIds: ids, currentId: "missing")
        XCTAssertNil(missing.previousId)
        XCTAssertNil(missing.nextId)
    }
}
