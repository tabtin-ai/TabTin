import XCTest
@testable import Tabtin

final class NativeTabDocCommentDockPolicyTests: XCTestCase {
    func testShortDocumentDocksCommentsToViewportBottom() {
        XCTAssertEqual(
            NativeTabDocCommentDockPolicy.extraTop(
                viewportHeight: 800,
                precedingHeight: 200,
                footerContentHeight: 180
            ),
            420
        )
    }

    func testLongDocumentKeepsCommentsAfterLastBlock() {
        XCTAssertEqual(
            NativeTabDocCommentDockPolicy.extraTop(
                viewportHeight: 800,
                precedingHeight: 700,
                footerContentHeight: 180
            ),
            0
        )
    }

    func testInvalidViewportDoesNotPad() {
        XCTAssertEqual(
            NativeTabDocCommentDockPolicy.extraTop(
                viewportHeight: 0,
                precedingHeight: 200,
                footerContentHeight: 180
            ),
            0
        )
    }
}
