import XCTest
@testable import Tabtin

final class IMFileCardStyleTests: XCTestCase {
    func testFileExtension() {
        XCTAssertEqual(IMFileCardStyle.fileExtension(of: "Q3-roadmap.pdf"), "pdf")
        XCTAssertEqual(IMFileCardStyle.fileExtension(of: "竞品调研-汇总.xlsx"), "xlsx")
        XCTAssertEqual(IMFileCardStyle.fileExtension(of: "noext"), "")
        XCTAssertEqual(IMFileCardStyle.fileExtension(of: ".hidden"), "")
    }

    func testBadgeMatchesExtension() {
        XCTAssertEqual(IMFileCardStyle.resolve(fileName: "a.pdf").badge, "PDF")
        XCTAssertEqual(IMFileCardStyle.resolve(fileName: "a.docx").badge, "DOCX")
        XCTAssertEqual(IMFileCardStyle.resolve(fileName: "a.xlsx").badge, "XLSX")
        XCTAssertEqual(IMFileCardStyle.resolve(fileName: "a.pptx").badge, "PPTX")
        XCTAssertEqual(IMFileCardStyle.resolve(fileName: "a.md").badge, "MD")
        XCTAssertEqual(IMFileCardStyle.resolve(fileName: "a.json").badge, "JSON")
        XCTAssertEqual(IMFileCardStyle.resolve(fileName: "a.zip").badge, "ZIP")
    }

    func testUnavailableKeepsBadge() {
        let style = IMFileCardStyle.resolve(fileName: "report.pdf", isUnavailable: true)
        XCTAssertEqual(style.badge, "PDF")
    }

    func testCompactMetrics() {
        XCTAssertEqual(IMFileCardStyle.cardMaxWidth, 252)
        XCTAssertEqual(IMFileCardStyle.cardMinHeight, 64)
        XCTAssertEqual(IMFileCardStyle.cardCornerRadius, 14)
        XCTAssertEqual(IMFileCardStyle.actionSize, 28)
    }
}
