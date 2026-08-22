import XCTest
@testable import Tabtin

final class StreamingMarkdownContinuityPolicyTests: XCTestCase {
    private let prologue = String(repeating: "先说明一下。", count: 30)

    func testLongStreamingKeepsStableIdentityAndPlainTail() {
        let content = prologue + "\n\n尾巴还在增长" + String(repeating: "t", count: 40)
        let streaming = StreamingMarkdownContinuityPolicy.layout(content: content, isStreaming: true)

        XCTAssertTrue(streaming.hasStable)
        XCTAssertEqual(streaming.tailRenderer, .plainText)
        XCTAssertEqual(streaming.stable + streaming.tail, content)
    }

    func testSettledContentIsNeverSplitEvenWhenLongOrTableLike() {
        let prose = prologue + "\n\n尾巴还在增长" + String(repeating: "t", count: 40)
        let table = """
            | a | b |
            | --- | --- |
            | 1 | 2 |

            | c | d |
            | --- | --- |
            | 3 | 4 |
            """

        for content in [prose, table] {
            let settled = StreamingMarkdownContinuityPolicy.layout(content: content, isStreaming: false)
            XCTAssertEqual(settled.stable, "")
            XCTAssertEqual(settled.tail, content)
            XCTAssertEqual(settled.tailRenderer, .markdown)
        }
    }

    func testGrowingTailDoesNotChangeStreamingStableIdentity() {
        let first = StreamingMarkdownContinuityPolicy.layout(
            content: prologue + "\n\nPara two is streaming " + String(repeating: "t", count: 60),
            isStreaming: true
        )
        let second = StreamingMarkdownContinuityPolicy.layout(
            content: prologue + "\n\nPara two is streaming " + String(repeating: "t", count: 60) + " further",
            isStreaming: true
        )

        XCTAssertEqual(first.stableIdentity, second.stableIdentity)
        XCTAssertEqual(second.tailRenderer, .plainText)
    }

    func testSettleReusesStreamingStableIdentityAndOnlyPromotesTheTail() {
        let content = prologue + "\n\n尾巴还在增长" + String(repeating: "t", count: 40)
        let streaming = StreamingMarkdownContinuityPolicy.layout(content: content, isStreaming: true)
        let settled = StreamingMarkdownContinuityPolicy.layout(
            content: content,
            isStreaming: false,
            lastStreamingStable: streaming.stable
        )

        XCTAssertTrue(streaming.hasStable)
        XCTAssertEqual(settled.stableIdentity, streaming.stableIdentity)
        XCTAssertEqual(settled.stable, streaming.stable)
        XCTAssertEqual(settled.tail, String(content.dropFirst(streaming.stable.count)))
        XCTAssertEqual(settled.tailRenderer, .markdown)
        XCTAssertEqual(settled.stable + settled.tail, content)
    }

    func testShortStreamingStaysPlainTextUntilSettle() {
        let content = "很短的一段回复"
        let streaming = StreamingMarkdownContinuityPolicy.layout(content: content, isStreaming: true)
        let settled = StreamingMarkdownContinuityPolicy.layout(content: content, isStreaming: false)

        XCTAssertEqual(streaming.stable, "")
        XCTAssertEqual(streaming.tail, content)
        XCTAssertEqual(streaming.tailRenderer, .plainText)
        XCTAssertEqual(settled.tailRenderer, .markdown)
    }

    func testShortStreamDoesNotUseLiveMarkdown() {
        XCTAssertFalse(
            StreamingMarkdownSnapshotPolicy.usesLiveMarkdown(currentUTF16Length: 80)
        )
        XCTAssertFalse(
            StreamingMarkdownSnapshotPolicy.usesLiveMarkdown(currentUTF16Length: 1_200)
        )
    }
}
