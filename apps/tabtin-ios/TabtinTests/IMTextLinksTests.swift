import XCTest
@testable import Tabtin

@MainActor
final class IMTextLinksTests: XCTestCase {
    func testFindsMultipleHTTPLinksAndExcludesSentencePunctuation() {
        let content = "请先看 https://www.example.com/shared/table-1。再看 (http://example.com/a), 以及 https://example.com/wiki/Function_(math)"

        let links = findIMTextLinks(in: content)

        XCTAssertEqual(
            links.map(\.url.absoluteString),
            [
                "https://www.example.com/shared/table-1",
                "http://example.com/a",
                "https://example.com/wiki/Function_(math)",
            ]
        )
        XCTAssertEqual(
            links.compactMap { Range($0.range, in: content).map { String(content[$0]) } },
            links.map(\.url.absoluteString)
        )
    }

    func testAttributedTextRoutesOnlyHTTPLinks() {
        let content = "打开 https://example.com/a 和 http://example.com/b；不要打开 www.example.com、javascript:alert(1)、file:///tmp/a 或 tabtin://resource/1。"

        let attributed = attributedIMText(content)

        XCTAssertEqual(String(attributed.characters), content)
        XCTAssertEqual(
            attributed.runs.compactMap(\.link?.absoluteString),
            ["https://example.com/a", "http://example.com/b"]
        )
    }
}
