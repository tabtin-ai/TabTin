import XCTest
@testable import Tabtin

final class ProfileInputValidatorTests: XCTestCase {
    func testNicknameMustContainNonWhitespaceText() {
        let result = ProfileInputValidator.validate(nickname: "   ", username: "valid_name")

        XCTAssertEqual(result.nicknameError, .nicknameRequired)
        XCTAssertFalse(result.isValid)
    }

    func testUsernameMustBeAtLeastThreeCharacters() {
        XCTAssertEqual(
            ProfileInputValidator.validate(nickname: "昵称", username: "ab").usernameError,
            .usernameLength
        )
        XCTAssertEqual(
            ProfileInputValidator.validate(nickname: "昵称", username: "   ").usernameError,
            .usernameLength
        )
    }

    func testUsernameRejectsCharactersOutsideAsciiLettersNumbersAndUnderscores() {
        for username in ["user name", "用户名", "user-name", "user.name"] {
            XCTAssertEqual(
                ProfileInputValidator.validate(nickname: "昵称", username: username).usernameError,
                .usernameFormat
            )
        }
    }

    func testUsernameMayStartWithUnderscoreButNotNumber() {
        XCTAssertTrue(ProfileInputValidator.validate(nickname: "昵称", username: "_abc").isValid)
        XCTAssertEqual(
            ProfileInputValidator.validate(nickname: "昵称", username: "123").usernameError,
            .usernameFormat
        )
    }

    func testValidInputIsTrimmedAndAccepted() {
        let result = ProfileInputValidator.validate(nickname: "  昵称  ", username: "  user_01  ")

        XCTAssertTrue(result.isValid)
        XCTAssertNil(result.nicknameError)
        XCTAssertNil(result.usernameError)
        XCTAssertEqual(result.normalizedNickname, "昵称")
        XCTAssertEqual(result.normalizedUsername, "user_01")
    }
}
