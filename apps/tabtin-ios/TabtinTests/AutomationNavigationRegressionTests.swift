import XCTest
import SwiftUI
@testable import Tabtin

/// 自动化模块从任务页 push 进入的导航回归。
///
/// 2026-08-02 线上崩溃（EXC_BREAKPOINT / `swift_unexpectedError`，栈顶
/// `NavigationColumnState.boundPathChange`）：`AutomationRoot` 自带
/// `NavigationStack`，而任务页是 `NavigationStack(path:)` push 进去的——
/// NavigationStack 套 NavigationStack，SwiftUI 拿到类型不匹配的路径元素直接 trap。
///
/// 这个用例把真实的宿主栈搭起来并跑 runloop：一旦有人把 `providesNavigationContainer`
/// 改回 `true`（或删掉这个开关），测试进程会跟着崩，而不是等用户点崩。
@MainActor
final class AutomationNavigationRegressionTests: XCTestCase {

    private var window: UIWindow?

    override func tearDown() {
        window?.isHidden = true
        window = nil
        super.tearDown()
    }

    /// 嵌入宿主导航栈时不得自带容器。
    func testAutomationRootPushedIntoHostStackDoesNotTrap() {
        struct Host: View {
            @State var path: [TaskHomeRoute] = []

            var body: some View {
                NavigationStack(path: $path) {
                    Color.clear
                        .navigationDestination(for: TaskHomeRoute.self) { route in
                            if case .automation = route {
                                AutomationRoot(
                                    organizationId: "org-under-test",
                                    workspaces: [],
                                    onOpenConversation: { _ in },
                                    // 崩溃修复点：宿主已有导航栈，这里不能再套一个。
                                    providesNavigationContainer: false
                                )
                            }
                        }
                }
                .onAppear { path = [.automation] }
            }
        }

        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 393, height: 852))
        self.window = window
        window.rootViewController = UIHostingController(rootView: Host())
        window.makeKeyAndVisible()

        // 崩溃发生在导航状态 flush 阶段，必须真正转几圈 runloop 才会走到。
        let settled = expectation(description: "navigation settled")
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) { settled.fulfill() }
        wait(for: [settled], timeout: 5)

        XCTAssertNotNil(window.rootViewController, "push 自动化后宿主栈应仍然存活")
    }

    /// 模态旧调用点仍需自带容器——它自己就是根，没有祖先栈可挂。
    func testModalAutomationRootKeepsItsOwnContainer() {
        let modal = AutomationRoot(
            organizationId: "org-under-test",
            workspaces: [],
            onClose: {},
            onOpenConversation: { _ in }
        )
        XCTAssertTrue(
            modal.providesNavigationContainer,
            "模态呈现没有祖先 NavigationStack，必须自带容器"
        )
    }

    /// 嵌入任务页时不得反写 MainRouter：否则列表层会把 path.count 上报的 pushed 清掉，dock 不消失。
    func testEmbeddedAutomationDoesNotReportTabBarPush() {
        XCTAssertFalse(
            AutomationTabBarPushReporting.shouldReportToMainRouter(
                providesNavigationContainer: false,
                isModal: false
            )
        )
        XCTAssertFalse(
            AutomationTabBarPushReporting.shouldReportToMainRouter(
                providesNavigationContainer: true,
                isModal: true
            )
        )
        XCTAssertTrue(
            AutomationTabBarPushReporting.shouldReportToMainRouter(
                providesNavigationContainer: true,
                isModal: false
            )
        )
    }
}
