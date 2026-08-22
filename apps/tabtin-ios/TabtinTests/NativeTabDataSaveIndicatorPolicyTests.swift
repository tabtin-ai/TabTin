import XCTest
@testable import Tabtin

final class NativeTabDataSaveIndicatorPolicyTests: XCTestCase {
    func testShowsOnlyOccupiesNavigationSpaceWhileActiveOrActionable() {
        XCTAssertFalse(NativeTabDataSaveIndicatorPolicy.shows(.idle))
        XCTAssertTrue(NativeTabDataSaveIndicatorPolicy.shows(.dirty))
        XCTAssertTrue(NativeTabDataSaveIndicatorPolicy.shows(.saved))
        XCTAssertTrue(NativeTabDataSaveIndicatorPolicy.shows(.saving))
        XCTAssertTrue(NativeTabDataSaveIndicatorPolicy.shows(.conflict))
        XCTAssertTrue(NativeTabDataSaveIndicatorPolicy.shows(.permissionDenied))
        XCTAssertTrue(NativeTabDataSaveIndicatorPolicy.shows(.failed))
    }

    func testShowsRetryIsOfferedOnlyAfterAFailedSave() {
        XCTAssertFalse(NativeTabDataSaveIndicatorPolicy.showsRetry(.idle))
        XCTAssertFalse(NativeTabDataSaveIndicatorPolicy.showsRetry(.dirty))
        XCTAssertFalse(NativeTabDataSaveIndicatorPolicy.showsRetry(.saving))
        XCTAssertFalse(NativeTabDataSaveIndicatorPolicy.showsRetry(.saved))
        XCTAssertFalse(NativeTabDataSaveIndicatorPolicy.showsRetry(.conflict))
        XCTAssertFalse(NativeTabDataSaveIndicatorPolicy.showsRetry(.permissionDenied))
        XCTAssertTrue(NativeTabDataSaveIndicatorPolicy.showsRetry(.failed))
    }
}
