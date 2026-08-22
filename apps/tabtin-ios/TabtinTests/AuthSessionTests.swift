import UIKit
import XCTest
@testable import Tabtin

final class AuthSessionTests: XCTestCase {
    func testAPIRequestsIgnoreURLCache() {
        let configuration = APIClient.makeSessionConfiguration()

        XCTAssertEqual(configuration.requestCachePolicy, .reloadIgnoringLocalCacheData)
        XCTAssertNil(configuration.urlCache)
    }

    @MainActor
    func testAvatarMemoryCacheSynchronouslyRestoresImageForSameURL() {
        let cache = AvatarImageMemoryCache()
        let url = URL(string: "https://example.com/avatar.png")!
        let image = UIImage(systemName: "person.crop.circle")!

        cache.store(image, for: url)

        XCTAssertTrue(cache.cachedImage(for: url) === image)
    }

    func testInviteGateOnlyAppliesToExplicitUnredeemedServerState() throws {
        let decoder = JSONDecoder()
        let pending = try decoder.decode(UserProfile.self, from: Data(
            #"{"id":"pending","invite_code_required":true,"invite_code_redeemed":false}"#.utf8
        ))
        let redeemed = try decoder.decode(UserProfile.self, from: Data(
            #"{"id":"redeemed","invite_code_required":true,"invite_code_redeemed":true}"#.utf8
        ))
        let legacy = try decoder.decode(UserProfile.self, from: Data(#"{"id":"legacy"}"#.utf8))

        XCTAssertTrue(pending.needsInviteCode)
        XCTAssertFalse(redeemed.needsInviteCode)
        XCTAssertFalse(legacy.needsInviteCode)
    }

    func testPasswordSetupUsesVerificationOnlyWhenServerReportsNoPassword() throws {
        let decoder = JSONDecoder()
        let noPassword = try decoder.decode(UserProfile.self, from: Data(
            #"{"id":"no-password","has_usable_password":false}"#.utf8
        ))
        let password = try decoder.decode(UserProfile.self, from: Data(
            #"{"id":"password","has_usable_password":true}"#.utf8
        ))
        let legacy = try decoder.decode(UserProfile.self, from: Data(#"{"id":"legacy"}"#.utf8))

        XCTAssertTrue(noPassword.prefersVerificationPasswordSetup)
        XCTAssertFalse(password.prefersVerificationPasswordSetup)
        XCTAssertFalse(legacy.prefersVerificationPasswordSetup)
    }

    func testInviteGatePresentsRateLimitWithoutInternalErrorCode() {
        let error = APIClient.responseError(
            statusCode: 429,
            data: Data(
                #"{"success":false,"code":"RATE_LIMITED","message":"middleware.rate_limited","retry_after_seconds":900}"#.utf8
            )
        )

        XCTAssertEqual((error as APIError).businessCode, "RATE_LIMITED")
        XCTAssertEqual(
            InviteCodeGatePresentation.errorMessage(for: error),
            L10n.Auth.inviteCodeRateLimited
        )
        XCTAssertFalse(
            InviteCodeGatePresentation.errorMessage(for: error).contains("RATE_LIMITED")
        )
    }

    func testCancellationClassificationRecognizesSwiftURLSessionAndNestedAPIErrors() {
        XCTAssertTrue(CancellationError().isCancellation)
        XCTAssertTrue(URLError(.cancelled).isCancellation)
        XCTAssertTrue(NSError(domain: NSURLErrorDomain, code: NSURLErrorCancelled).isCancellation)
        XCTAssertTrue(APIError.networkError(URLError(.cancelled)).isCancellation)
        XCTAssertTrue(APIError.networkError(APIError.networkError(CancellationError())).isCancellation)

        XCTAssertFalse(URLError(.timedOut).isCancellation)
        XCTAssertFalse(APIError.networkError(URLError(.notConnectedToInternet)).isCancellation)
        XCTAssertFalse(APIError.apiError("请求失败").isCancellation)
    }

    func testTransportErrorNormalizationPreservesCancellationSemantics() {
        XCTAssertTrue(APIClient.normalizedTransportError(CancellationError()) is CancellationError)
        XCTAssertTrue(APIClient.normalizedTransportError(URLError(.cancelled)) is CancellationError)
        XCTAssertTrue(
            APIClient.normalizedTransportError(APIError.networkError(URLError(.cancelled)))
                is CancellationError
        )

        let normalized = APIClient.normalizedTransportError(URLError(.timedOut))
        guard case let APIError.networkError(underlying) = normalized else {
            return XCTFail("非取消传输错误应继续包装为 APIError.networkError")
        }
        XCTAssertEqual((underlying as? URLError)?.code, .timedOut)
    }

    func testRefreshFailureClassificationLogsOutOnlyForDefinitiveInvalidation() {
        XCTAssertEqual(APIClient.classifyRefreshFailure(statusCode: 401), .tokenInvalid)
        XCTAssertEqual(APIClient.classifyRefreshFailure(statusCode: 403), .tokenInvalid)
        XCTAssertEqual(APIClient.classifyRefreshFailure(statusCode: 404), .tokenInvalid)
        XCTAssertEqual(APIClient.classifyRefreshFailure(statusCode: 409), .conflict)
        XCTAssertEqual(APIClient.classifyRefreshFailure(statusCode: 429), .temporarilyUnavailable)
        XCTAssertEqual(APIClient.classifyRefreshFailure(statusCode: 500), .temporarilyUnavailable)
        XCTAssertEqual(
            APIClient.classifyRefreshFailure(statusCode: 401, errorCode: "RATE_LIMITED"),
            .temporarilyUnavailable
        )
    }

    /// ：Keychain 被锁时缺少 refresh token 不能当成会话失效。
    func testMissingRefreshTokenWhileKeychainBlockedIsTemporary() {
        XCTAssertEqual(
            APIClient.missingRefreshTokenResult(keychainAccessible: false),
            .temporarilyUnavailable
        )
        XCTAssertEqual(
            APIClient.missingRefreshTokenResult(keychainAccessible: true),
            .tokenInvalid
        )
    }

    func testEmbeddedWebCredentialCarriesOnlyAccessTokenAndExpiry() {
        let credential = EmbeddedWebCredential(accessToken: "access", expiresAt: 1_234)
        XCTAssertEqual(credential.accessToken, "access")
        XCTAssertEqual(credential.expiresAt, 1_234)
    }

    func testLoginUnauthorizedPreservesBackendReason() {
        let data = Data(
            #"{"success":false,"message":"用户名或密码错误","code":"AUTH_INVALID"}"#.utf8
        )
        let error = APIClient.responseError(
            statusCode: 401,
            data: data,
            fallbackMessage: "登录失败，请检查输入后重试"
        )

        XCTAssertEqual(error.businessCode, "AUTH_INVALID")
        XCTAssertEqual(error.errorDescription, "[AUTH_INVALID] 用户名或密码错误")
    }

    func testLoginUnauthorizedHasActionableFallback() {
        let error = APIClient.responseError(
            statusCode: 401,
            data: Data(),
            fallbackMessage: "登录失败，请检查输入后重试"
        )

        XCTAssertEqual(error.errorDescription, "登录失败，请检查输入后重试")
        XCTAssertFalse(APIClient.shouldAttemptTokenRefresh(
            authentication: .none,
            hasCredential: true,
            isRetry: false
        ))
        XCTAssertFalse(APIClient.shouldAttemptTokenRefresh(
            authentication: .session,
            hasCredential: false,
            isRetry: false
        ))
        XCTAssertTrue(APIClient.shouldAttemptTokenRefresh(
            authentication: .session,
            hasCredential: true,
            isRetry: false
        ))
    }

    func testLoginPresentationHidesServerDetailAndExplainsNextAction() {
        let raw = APIError.serverError(
            401,
            "[AUTH_INVALID] internal auth detail that must not reach the UI"
        )

        XCTAssertEqual(
            LoginErrorPresentation.message(for: raw, context: .password),
            L10n.Auth.invalidPassword
        )
        XCTAssertEqual(
            LoginErrorPresentation.message(for: raw, context: .verificationCode),
            L10n.Auth.invalidVerificationCode
        )
        XCTAssertEqual(
            LoginErrorPresentation.message(
                for: APIError.networkError(URLError(.notConnectedToInternet)),
                context: .password
            ),
            L10n.Auth.networkError
        )
        XCTAssertEqual(
            LoginErrorPresentation.message(
                for: APIError.serverError(500, "internal server detail"),
                context: .password
            ),
            L10n.Auth.loginError
        )
        XCTAssertEqual(
            LoginErrorPresentation.message(
                for: APIError.apiError("internal SMS provider detail"),
                context: .sendCode
            ),
            L10n.Auth.sendCodeFailed
        )
        XCTAssertEqual(
            LoginErrorPresentation.message(
                for: APIError.apiErrorWithCode(
                    code: "AUTH_VERIFICATION_CHALLENGE_REQUIRED",
                    message: "请先重新获取验证码"
                ),
                context: .verificationCode
            ),
            L10n.Auth.invalidVerificationCode
        )
    }
}

final class LoginPhoneNumberTests: XCTestCase {
    func testVerificationChallengeOnlyMatchesThePhoneThatRequestedIt() {
        XCTAssertTrue(AuthService.challengeMatches(sentPhone: "13800138000", loginPhone: "13800138000"))
        XCTAssertTrue(AuthService.challengeMatches(sentPhone: "13800138000", loginPhone: " 13800138000 "))
        XCTAssertFalse(AuthService.challengeMatches(sentPhone: "13800138000", loginPhone: "13900139000"))
        XCTAssertFalse(AuthService.challengeMatches(sentPhone: nil, loginPhone: "13800138000"))
        XCTAssertTrue(
            AuthService.challengeRequestIsCurrent(
                requestGeneration: 2,
                currentGeneration: 2
            )
        )
        XCTAssertFalse(
            AuthService.challengeRequestIsCurrent(
                requestGeneration: 2,
                currentGeneration: 3
            )
        )
    }

    func testNormalizesCountryCodeAndGroupedPhoneSuggestion() {
        XCTAssertEqual(
            LoginPhoneNumber.editingValue("+86 138 0013 8000"),
            "13800138000"
        )
        XCTAssertEqual(
            LoginPhoneNumber.normalized("+86 138 0013 8000"),
            "13800138000"
        )
    }

    func testNormalizesGroupedLocalPhoneAndRejectsNonMobileNumber() {
        XCTAssertEqual(LoginPhoneNumber.normalized("138 0013 8000"), "13800138000")
        XCTAssertNil(LoginPhoneNumber.normalized("+86 10 1234 5678"))
    }

    func testEditingValueCapsLocalPhoneAtElevenDigits() {
        XCTAssertEqual(
            LoginPhoneNumber.editingValue("138001380001234"),
            "13800138000"
        )
    }

    func testVerificationCodeEditingValueKeepsSixDigitsAtMost() {
        XCTAssertEqual(LoginVerificationCode.editingValue("12 34a56789"), "123456")
    }

    func testEmailLoginSwitchOnlyTreatsLowercaseFalseAsOff() {
        XCTAssertTrue(LoginPhoneNumber.parseEmailLoginEnabled(nil))
        XCTAssertTrue(LoginPhoneNumber.parseEmailLoginEnabled(""))
        XCTAssertTrue(LoginPhoneNumber.parseEmailLoginEnabled("true"))
        XCTAssertFalse(LoginPhoneNumber.parseEmailLoginEnabled("false"))
        XCTAssertFalse(LoginPhoneNumber.parseEmailLoginEnabled(" FALSE "))
    }

    func testKeepsInProgressEmailLettersWhenEmailLoginIsEnabled() {
        XCTAssertEqual(LoginPhoneNumber.editingValue("u", emailLoginEnabled: true), "u")
        XCTAssertEqual(LoginPhoneNumber.editingValue("user", emailLoginEnabled: true), "user")
        XCTAssertEqual(LoginPhoneNumber.editingValue("user@", emailLoginEnabled: true), "user@")
        XCTAssertEqual(
            LoginPhoneNumber.editingValue("User@Example.com", emailLoginEnabled: true),
            "User@Example.com"
        )
        XCTAssertEqual(
            LoginPhoneNumber.editingValue("13800138000", emailLoginEnabled: true),
            "13800138000"
        )
        XCTAssertEqual(
            LoginPhoneNumber.editingValue("abc13800138000xyz", emailLoginEnabled: false),
            "13800138000"
        )
    }

    func testNormalizesEmailToLowercaseAndStillAcceptsMainlandMobile() {
        XCTAssertEqual(
            LoginPhoneNumber.normalized("  User@Example.COM ", emailLoginEnabled: true),
            "user@example.com"
        )
        XCTAssertEqual(
            LoginPhoneNumber.normalized("13800138000", emailLoginEnabled: true),
            "13800138000"
        )
        XCTAssertNil(LoginPhoneNumber.normalized("user@example.com", emailLoginEnabled: false))
        XCTAssertNil(LoginPhoneNumber.normalized("user@", emailLoginEnabled: true))
        XCTAssertNil(LoginPhoneNumber.normalized("not-an-email", emailLoginEnabled: true))
    }

    func testVerificationChallengeMatchesNormalizedEmail() {
        XCTAssertTrue(
            AuthService.challengeMatches(sentPhone: "user@example.com", loginPhone: "  User@Example.COM ")
        )
        XCTAssertFalse(
            AuthService.challengeMatches(sentPhone: "user@example.com", loginPhone: "other@example.com")
        )
    }
}

final class IdentityAvatarInitialsTests: XCTestCase {
    func testHueMatchesSharedIdentityAvatarFixtures() {
        XCTAssertEqual(IdentityAvatar.hue("user-1"), 225)
        XCTAssertEqual(IdentityAvatar.hue("user-2"), 224)
        XCTAssertEqual(IdentityAvatar.hue("05a81772-b342-4590-a4a1-ed423f5e1a4d"), 323)
        XCTAssertEqual(IdentityAvatar.hue("吴瑞源"), 150)
        XCTAssertEqual(IdentityAvatar.hue(nil), 63)
    }

    func testColorSeedPrefersUserIdOverDisplayName() {
        let userId = "05a81772-b342-4590-a4a1-ed423f5e1a4d"
        XCTAssertEqual(IdentityAvatar.colorSeed(userId, fallbackName: "吴瑞源"), userId)
        XCTAssertEqual(IdentityAvatar.colorSeed(userId, fallbackName: "吴瑞源（已离职）"), userId)
        XCTAssertEqual(
            IdentityAvatar.hue(IdentityAvatar.colorSeed(userId, fallbackName: "我")),
            IdentityAvatar.hue(userId)
        )
        XCTAssertNotEqual(IdentityAvatar.hue(userId), IdentityAvatar.hue("吴瑞源"))
        XCTAssertEqual(IdentityAvatar.colorSeed("", fallbackName: "吴瑞源"), "吴瑞源")
        XCTAssertEqual(IdentityAvatar.colorSeed("  ", fallbackName: "  "), "?")
    }

    func testChineseNamesUseLastTwoCharacters() {
        XCTAssertEqual(IdentityAvatar.initials("吴瑞源"), "瑞源")
        XCTAssertEqual(IdentityAvatar.initials("李雷"), "李雷")
    }

    func testEnglishNamesUseFirstAndLastInitials() {
        XCTAssertEqual(IdentityAvatar.initials("Taylor Swift"), "TS")
        XCTAssertEqual(IdentityAvatar.initials("Taylor Alison Swift"), "TS")
        XCTAssertEqual(IdentityAvatar.initials("taylor"), "t")
        XCTAssertEqual(IdentityAvatar.initials("taylor swift"), "ts")
        XCTAssertEqual(IdentityAvatar.initials("m"), "m")
        XCTAssertEqual(IdentityAvatar.initials("M"), "M")
        XCTAssertEqual(IdentityAvatar.initials("Mm"), "M")
    }
}
