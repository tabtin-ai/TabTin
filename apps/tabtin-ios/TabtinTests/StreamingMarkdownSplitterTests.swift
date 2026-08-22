import XCTest
@testable import Tabtin

final class StreamingMarkdownSplitterTests: XCTestCase {
    /// 稳定区必须 >= 100 字符才会被切出来，这里给足前缀。
    private let prologue = String(repeating: "先说明一下。", count: 30)

    func testShortContentStaysEntirelyInTail() {
        let content = "很短的一段流式文本，还不值得切分。"
        let parts = StreamingMarkdownSplitter.split(content)

        XCTAssertEqual(parts.stable, "")
        XCTAssertEqual(parts.tail, content)
    }

    func testSplitsAtLastDoubleNewline() {
        let paragraph = String(repeating: "稳定段落。", count: 40)
        let content = paragraph + "\n\n尾巴还在增长"

        let parts = StreamingMarkdownSplitter.split(content)

        XCTAssertEqual(parts.stable, paragraph + "\n\n")
        XCTAssertEqual(parts.tail, "尾巴还在增长")
        XCTAssertEqual(parts.stable + parts.tail, content)
    }

    func testUnclosedFenceMovesWholeCodeBlockToTail() {
        let content = prologue + "\n\n```swift\nlet a = 1\n\nlet b = 2"

        let parts = StreamingMarkdownSplitter.split(content)

        XCTAssertEqual(parts.stable, prologue + "\n\n")
        XCTAssertEqual(parts.tail, "```swift\nlet a = 1\n\nlet b = 2")
        XCTAssertEqual(parts.stable + parts.tail, content)
    }

    func testClosedFenceStaysInStable() {
        let content = prologue + "\n\n```swift\nlet a = 1\n```\n\n后续说明"

        let parts = StreamingMarkdownSplitter.split(content)

        XCTAssertEqual(parts.stable, prologue + "\n\n```swift\nlet a = 1\n```\n\n")
        XCTAssertEqual(parts.tail, "后续说明")
        XCTAssertEqual(parts.stable + parts.tail, content)
    }

    func testUnclosedTildeFenceMovesWholeCodeBlockToTail() {
        let content = prologue + "\n\n~~~\nplain code\n\nstill going"

        let parts = StreamingMarkdownSplitter.split(content)

        XCTAssertEqual(parts.stable, prologue + "\n\n")
        XCTAssertTrue(parts.tail.hasPrefix("~~~"))
    }

    func testContentWithoutDoubleNewlineStaysInTail() {
        let content = String(repeating: "一行到底的长文本。", count: 40)

        let parts = StreamingMarkdownSplitter.split(content)

        XCTAssertEqual(parts.stable, "")
        XCTAssertEqual(parts.tail, content)
    }

    func testDoubleNewlineTooEarlyStaysInTail() {
        let content = "开头\n\n" + String(repeating: "正文", count: 120)

        let parts = StreamingMarkdownSplitter.split(content)

        XCTAssertEqual(parts.stable, "")
        XCTAssertEqual(parts.tail, content)
    }

    func testFenceAtVeryStartKeepsEverythingInTail() {
        let content = "```swift\n" + String(repeating: "let value = 1\n", count: 20) + "\n继续"

        let parts = StreamingMarkdownSplitter.split(content)

        XCTAssertEqual(parts.stable, "")
        XCTAssertEqual(parts.tail, content)
    }
}

final class StreamingMarkdownSnapshotPolicyTests: XCTestCase {
    func testShortStreamDoesNotUseLiveMarkdown() {
        XCTAssertFalse(
            StreamingMarkdownSnapshotPolicy.usesLiveMarkdown(
                currentUTF16Length: 80
            )
        )
        XCTAssertFalse(
            StreamingMarkdownSnapshotPolicy.usesLiveMarkdown(
                currentUTF16Length: 1_200
            )
        )
    }

    func testLongStreamDoesNotRefreshSnapshotForEveryDelta() {
        XCTAssertTrue(
            StreamingMarkdownSnapshotPolicy.shouldRefreshSnapshot(
                currentUTF16Length: 1_201,
                snapshotUTF16Length: 0,
                snapshotIsPrefix: true,
                force: true
            )
        )
        XCTAssertFalse(
            StreamingMarkdownSnapshotPolicy.shouldRefreshSnapshot(
                currentUTF16Length: 1_400,
                snapshotUTF16Length: 1_201,
                snapshotIsPrefix: true,
                force: false
            )
        )
        XCTAssertTrue(
            StreamingMarkdownSnapshotPolicy.shouldRefreshSnapshot(
                currentUTF16Length: 1_621,
                snapshotUTF16Length: 1_201,
                snapshotIsPrefix: true,
                force: false
            )
        )
    }

    func testSnapshotRefreshesWhenTextShrinks() {
        XCTAssertTrue(
            StreamingMarkdownSnapshotPolicy.shouldRefreshSnapshot(
                currentUTF16Length: 1_300,
                snapshotUTF16Length: 1_700,
                snapshotIsPrefix: false,
                force: false
            )
        )
    }

    func testSnapshotRefreshesWhenServerCorrectsPrefixAtSameLength() {
        XCTAssertTrue(
            StreamingMarkdownSnapshotPolicy.shouldRefreshSnapshot(
                currentUTF16Length: 1_300,
                snapshotUTF16Length: 1_300,
                snapshotIsPrefix: false,
                force: false
            )
        )
    }

    func testTailUsesUTF16Boundary() {
        let text = "A🙂BC"
        XCTAssertEqual(
            StreamingMarkdownSnapshotPolicy.tail(
                in: text,
                snapshot: "A🙂"
            ),
            "BC"
        )
    }

    func testTailKeepsComplexGraphemeBoundary() {
        let snapshot = "👨‍👩‍👧‍👦e\u{301}"
        let text = snapshot + "尾巴"

        XCTAssertEqual(
            StreamingMarkdownSnapshotPolicy.tail(
                in: text,
                snapshot: snapshot
            ),
            "尾巴"
        )
    }

    func testTailRejectsStaleSnapshot() {
        XCTAssertEqual(
            StreamingMarkdownSnapshotPolicy.tail(
                in: "新的正文",
                snapshot: "旧的正文"
            ),
            "新的正文"
        )
    }

    func testCanonicalEquivalentTextIsNotAnExactPrefix() {
        let snapshot = "\u{00E9}"
        let text = "e\u{301}尾巴"

        XCTAssertFalse(
            StreamingMarkdownSnapshotPolicy.isExactPrefix(snapshot, of: text)
        )
        XCTAssertEqual(
            StreamingMarkdownSnapshotPolicy.tail(in: text, snapshot: snapshot),
            text
        )
    }

    func testSnapshotCannotSplitAnExtendedGrapheme() {
        let cases = [
            (snapshot: "e", text: "e\u{301}尾巴"),
            (snapshot: "👨", text: "👨‍👩尾巴"),
            (snapshot: "✈", text: "✈️尾巴"),
            (snapshot: "🇨", text: "🇨🇳尾巴"),
        ]

        for item in cases {
            XCTAssertFalse(
                StreamingMarkdownSnapshotPolicy.canReuseSnapshot(
                    item.snapshot,
                    in: item.text
                )
            )
            XCTAssertEqual(
                StreamingMarkdownSnapshotPolicy.tail(
                    in: item.text,
                    snapshot: item.snapshot
                ),
                item.text
            )
        }
    }
}
