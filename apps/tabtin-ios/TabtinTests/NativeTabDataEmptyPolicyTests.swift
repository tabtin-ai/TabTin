import XCTest
@testable import Tabtin

final class NativeTabDataEmptyPolicyTests: XCTestCase {
    func testKindMatchesAndroidEmptyStates() {
        XCTAssertEqual(
            NativeTabDataEmptyPolicy.kind(
                hasViews: false,
                isKanban: false,
                recordCount: 0,
                hasActiveQuery: false
            ),
            .noViews
        )
        XCTAssertEqual(
            NativeTabDataEmptyPolicy.kind(
                hasViews: true,
                isKanban: false,
                recordCount: 0,
                hasActiveQuery: false
            ),
            .noRecords
        )
        XCTAssertEqual(
            NativeTabDataEmptyPolicy.kind(
                hasViews: true,
                isKanban: false,
                recordCount: 0,
                hasActiveQuery: true
            ),
            .noMatches
        )
        XCTAssertEqual(
            NativeTabDataEmptyPolicy.kind(
                hasViews: true,
                isKanban: true,
                recordCount: 0,
                hasActiveQuery: true
            ),
            .emptyKanban
        )
        XCTAssertNil(
            NativeTabDataEmptyPolicy.kind(
                hasViews: true,
                isKanban: false,
                recordCount: 2,
                hasActiveQuery: true
            )
        )
    }
}
