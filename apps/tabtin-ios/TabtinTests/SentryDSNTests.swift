import XCTest
@testable import Tabtin

final class SentryDSNTests: XCTestCase {
    func testEmptyDSNIsValidAndDisablesReporting() {
        XCTAssertTrue(SentryDSN.isValid(""))
        XCTAssertTrue(SentryDSN.isValid("   "))
        XCTAssertEqual(SentryDSN.normalize("  "), "")
    }

    func testHTTPSDSNWithPublicKeyIsValid() {
        XCTAssertTrue(SentryDSN.isValid("https://public@sentry.example.com/1"))
    }

    func testDSNWithoutPublicKeyIsInvalid() {
        XCTAssertFalse(SentryDSN.isValid("https://sentry.example.com/1"))
    }

    func testNonHTTPSchemeIsInvalid() {
        XCTAssertFalse(SentryDSN.isValid("ftp://public@sentry.example.com/1"))
    }
}
