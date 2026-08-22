import XCTest
@testable import Tabtin

/// WKWebView Web 内容进程终止兜底的单测。
///
/// 覆盖两条硬约束：
///  1. 上报限频——内存尖峰会连着回收多个 WebView，不限频会把 Sentry 刷满；
///  2. 恢复状态机——内容进程终止后必须换实例（`instanceId`）才救得回来，
///     且「无重试按钮」的宿主只能自愈一次，否则内存持续紧张时会白屏抖动。
///
/// 对应 Android 侧 `WebViewRenderProcessGuardTest`（两端口径同源，处理方式因平台而异）。
@MainActor
final class WebContentProcessGuardTests: XCTestCase {

    override func setUp() {
        super.setUp()
        WebContentProcessGuard.resetReportThrottleForTesting()
    }

    override func tearDown() {
        WebContentProcessGuard.resetReportThrottleForTesting()
        super.tearDown()
    }

    // MARK: - 上报限频

    func testFirstTerminationIsReported() {
        XCTAssertTrue(WebContentProcessGuard.shouldReport(host: .tabsiteViewer))
    }

    func testRepeatedTerminationWithinWindowIsThrottled() {
        let start = Date()
        XCTAssertTrue(WebContentProcessGuard.shouldReport(host: .tabsiteViewer, now: start))
        XCTAssertFalse(
            WebContentProcessGuard.shouldReport(host: .tabsiteViewer, now: start.addingTimeInterval(1)),
            "同一宿主 60s 窗口内的重复终止不应重复上报"
        )
        XCTAssertFalse(
            WebContentProcessGuard.shouldReport(host: .tabsiteViewer, now: start.addingTimeInterval(59)),
            "窗口边界内仍应被限住"
        )
    }

    func testTerminationAfterWindowIsReportedAgain() {
        let start = Date()
        XCTAssertTrue(WebContentProcessGuard.shouldReport(host: .tabsiteViewer, now: start))
        XCTAssertTrue(
            WebContentProcessGuard.shouldReport(host: .tabsiteViewer, now: start.addingTimeInterval(61)),
            "限频只压噪音，不能把后续真实发生的终止永久吞掉"
        )
    }

    func testThrottleIsPerHost() {
        let start = Date()
        XCTAssertTrue(WebContentProcessGuard.shouldReport(host: .tabsiteViewer, now: start))
        XCTAssertTrue(
            WebContentProcessGuard.shouldReport(host: .workbenchResource, now: start),
            "不同宿主各自计窗口，别让一个宿主的噪音掩盖另一个宿主的首次终止"
        )
        XCTAssertTrue(WebContentProcessGuard.shouldReport(host: .mermaidBlock, now: start))
    }

    // MARK: - 降级文案

    func testTerminatedMessagePointsAtRetry() {
        // 断言按钮标题本身而不是字面「重试」：两者都走 L10n，换语言时一起变，
        // 断言才不会在英文环境下假失败，钉住的也才是真正的契约——文案指的那个词，
        // 必须就是按钮上印的那个词。
        XCTAssertTrue(
            WebContentProcessGuard.terminatedMessage.contains(L10n.Common.retry),
            "降级文案必须指向重试出口，且用词要和按钮一致，否则用户不知道该点哪里"
        )
    }

    // MARK: - 恢复状态机

    func testRecoveryStartsClean() {
        let recovery = WebContentProcessRecovery()
        XCTAssertFalse(recovery.isTerminated)
    }

    func testMarkTerminatedDoesNotSwapInstanceOnItsOwn() {
        var recovery = WebContentProcessRecovery()
        let original = recovery.instanceId

        recovery.markTerminated()

        XCTAssertTrue(recovery.isTerminated)
        XCTAssertEqual(
            recovery.instanceId, original,
            "终止后不自动重建：内存压力还在时立刻重建大概率再被杀，要等用户点重试"
        )
    }

    func testRecreateSwapsInstanceAndClearsTerminatedFlag() {
        var recovery = WebContentProcessRecovery()
        let original = recovery.instanceId
        recovery.markTerminated()

        recovery.recreate()

        XCTAssertNotEqual(
            recovery.instanceId, original,
            "必须换 id：内容进程终止后同一个 WKWebView 实例 reload 救不回来"
        )
        XCTAssertFalse(recovery.isTerminated)
    }

    func testAutoRecoveryIsOfferedOnlyOnce() {
        var recovery = WebContentProcessRecovery()
        let original = recovery.instanceId

        recovery.markTerminated()
        XCTAssertTrue(recovery.recoverAutomaticallyIfPossible(), "第一次终止给一次静默自愈")
        let afterFirst = recovery.instanceId
        XCTAssertNotEqual(afterFirst, original)

        recovery.markTerminated()
        XCTAssertFalse(
            recovery.recoverAutomaticallyIfPossible(),
            "第二次不再自愈：否则内存持续紧张时会变成白屏抖动，宿主应落到内容回退视图"
        )
        XCTAssertEqual(recovery.instanceId, afterFirst, "不自愈就不能换实例")
    }

    func testManualRetryStillWorksAfterAutoRecoveryIsUsedUp() {
        var recovery = WebContentProcessRecovery()
        recovery.markTerminated()
        _ = recovery.recoverAutomaticallyIfPossible()
        recovery.markTerminated()
        _ = recovery.recoverAutomaticallyIfPossible()
        let stuck = recovery.instanceId

        recovery.recreate()

        XCTAssertNotEqual(recovery.instanceId, stuck, "自动自愈用尽不影响用户手动重试")
        XCTAssertFalse(recovery.isTerminated)
    }
}
