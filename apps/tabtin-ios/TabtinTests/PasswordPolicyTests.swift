import XCTest
@testable import Tabtin

final class PasswordPolicyTests: XCTestCase {
    func testSanitizeStripsWhitespaceAndReportsIt() {
        let result = PasswordPolicy.sanitize("Abc 1234!")

        XCTAssertEqual(result.value, "Abc1234!")
        XCTAssertTrue(result.hadWhitespace)
        XCTAssertFalse(result.hadCJK)
    }

    func testSanitizeClearsCJKInput() {
        let result = PasswordPolicy.sanitize("Abc中文123!")

        XCTAssertEqual(result.value, "")
        XCTAssertTrue(result.hadCJK)
    }

    func testValidateAcceptsThreeCharacterClasses() {
        XCTAssertNil(PasswordPolicy.validate(newPassword: "Abc12345", confirmation: "Abc12345"))
        XCTAssertNil(PasswordPolicy.validate(newPassword: "Abc12345!", confirmation: "Abc12345!"))
    }

    func testValidateRejectsWeakAndMismatchedPasswords() {
        XCTAssertEqual(
            PasswordPolicy.validate(newPassword: "Ab1!", confirmation: "Ab1!"),
            .tooShort
        )
        XCTAssertEqual(
            PasswordPolicy.validate(newPassword: "abcdefgh", confirmation: "abcdefgh"),
            .notComplex
        )
        XCTAssertEqual(
            PasswordPolicy.validate(newPassword: "Abc12345", confirmation: "Abc12346"),
            .mismatch
        )
    }
}
