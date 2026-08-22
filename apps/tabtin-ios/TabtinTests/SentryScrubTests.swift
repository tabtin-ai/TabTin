import Sentry
import XCTest
@testable import Tabtin

/// 脱敏规则单测。规则口径需与 TS 侧
/// `packages/tabtin-shared/src/__tests__/sentry-scrub.test.ts` 保持同步。
final class SentryScrubTests: XCTestCase {
    // MARK: - redact(_:) 纯文本规则

    func testRedactMasksPhoneNumber() {
        XCTAssertEqual(SentryScrub.redact("联系电话 13812345678 请回电"), "联系电话 138****5678 请回电")
    }

    func testRedactMasksEmail() {
        XCTAssertEqual(SentryScrub.redact("邮箱 zhangsan@example.com"), "邮箱 z***@example.com")
    }

    func testRedactMasksBearerToken() {
        XCTAssertEqual(SentryScrub.redact("Authorization: Bearer abcdef123456==").contains("abcdef123456"), false)
        XCTAssertTrue(SentryScrub.redact("Authorization: Bearer abcdef123456==").contains("<redacted>"))
    }

    func testRedactMasksKeyValueSecrets() {
        let input = #"{"password": "sup3rSecret!", "token":"tok_abcdefgh"}"#
        let out = SentryScrub.redact(input)
        XCTAssertFalse(out.contains("sup3rSecret"))
        XCTAssertFalse(out.contains("tok_abcdefgh"))
    }

    func testRedactMasksJWT() {
        let jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U"
        XCTAssertEqual(SentryScrub.redact("token=\(jwt)").contains(jwt), false)
    }

    func testRedactMasksHomeDirectoryUsername() {
        XCTAssertEqual(SentryScrub.redact("/Users/zhangsan/Documents/a.txt"), "/Users/<user>/Documents/a.txt")
    }

    func testRedactLeavesEmptyStringUnchanged() {
        XCTAssertEqual(SentryScrub.redact(""), "")
    }

    func testRedactLeavesNonSensitiveTextUnchanged() {
        XCTAssertEqual(SentryScrub.redact("normal error message, nothing sensitive here"),
                       "normal error message, nothing sensitive here")
    }

    // MARK: - scrub(_ event:) beforeSend 钩子

    func testScrubDropsServerName() {
        let event = Event(level: .error)
        event.serverName = "zhangsandeiPhone.local"
        _ = SentryScrub.scrub(event)
        XCTAssertNil(event.serverName)
    }

    func testScrubRedactsMessage() {
        let event = Event(level: .error)
        event.message = SentryMessage(formatted: "手机号 13812345678 报错")
        _ = SentryScrub.scrub(event)
        XCTAssertEqual(event.message?.formatted, "手机号 138****5678 报错")
    }

    func testScrubRedactsExceptionValue() {
        let event = Event(level: .error)
        let exception = Exception(value: "token=tok_abcdefgh1234 failed", type: "NetworkError")
        event.exceptions = [exception]
        _ = SentryScrub.scrub(event)
        XCTAssertFalse(event.exceptions?.first?.value?.contains("tok_abcdefgh1234") ?? true)
    }

    func testScrubRedactsBreadcrumbMessageAndData() {
        let event = Event(level: .error)
        let crumb = Breadcrumb(level: .info, category: "http")
        crumb.message = "邮箱 zhangsan@example.com 登录失败"
        crumb.data = ["url": "https://api.example.com?token=tok_abcdefgh1234", "count": 3]
        event.breadcrumbs = [crumb]
        _ = SentryScrub.scrub(event)
        XCTAssertEqual(event.breadcrumbs?.first?.message, "邮箱 z***@example.com 登录失败")
        let data = event.breadcrumbs?.first?.data
        XCTAssertFalse((data?["url"] as? String ?? "").contains("tok_abcdefgh1234"))
        XCTAssertEqual(data?["count"] as? Int, 3)
    }

    func testScrubLeavesEventWithoutSensitiveFieldsUnchanged() {
        let event = Event(level: .error)
        event.message = SentryMessage(formatted: "boom")
        _ = SentryScrub.scrub(event)
        XCTAssertEqual(event.message?.formatted, "boom")
    }
}
