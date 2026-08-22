import XCTest
@testable import Tabtin

final class StreamingTailRevealPolicyTests: XCTestCase {
    func testGrowingTailFadesOnlyTheNewSuffix() {
        let reveal = StreamingTailRevealPolicy.reveal(
            previousTail: "hello",
            nextTail: "hello world"
        )

        XCTAssertEqual(reveal.prefix, "hello")
        XCTAssertEqual(reveal.incoming, " world")
        XCTAssertTrue(reveal.shouldAnimateIncoming)
    }

    func testRewrittenTailDoesNotAnimate() {
        let reveal = StreamingTailRevealPolicy.reveal(
            previousTail: "hello",
            nextTail: "other"
        )

        XCTAssertEqual(reveal.prefix, "other")
        XCTAssertEqual(reveal.incoming, "")
        XCTAssertFalse(reveal.shouldAnimateIncoming)
    }

    func testFirstTailChunkTreatsEmptyPreviousAsPrefix() {
        let reveal = StreamingTailRevealPolicy.reveal(previousTail: "", nextTail: "hi")

        XCTAssertEqual(reveal.prefix, "")
        XCTAssertEqual(reveal.incoming, "hi")
        XCTAssertTrue(reveal.shouldAnimateIncoming)
    }

    func testUnchangedTailHasNothingIncoming() {
        let reveal = StreamingTailRevealPolicy.reveal(
            previousTail: "hello",
            nextTail: "hello"
        )

        XCTAssertEqual(reveal.prefix, "hello")
        XCTAssertEqual(reveal.incoming, "")
        XCTAssertFalse(reveal.shouldAnimateIncoming)
    }
}
