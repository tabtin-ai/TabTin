import XCTest
@testable import Tabtin

@MainActor
final class AgentStatusCapsuleTests: XCTestCase {
    private var key: String!

    override func setUp() {
        super.setUp()
        key = "test.agentCapsule.\(UUID().uuidString)"
        TaskSurfaceCoordinator.resetPersistence(for: key)
    }

    override func tearDown() {
        TaskSurfaceCoordinator.resetPersistence(for: key)
        key = nil
        super.tearDown()
    }

    // MARK: - Run-state gate（空闲 / 完成收成微缩态，改口径只动 AgentCapsuleRunStateGate）

    func testRunStateGateMinimizesOnlyReadyNotUnreadComplete() {
        XCTAssertEqual(AgentCapsuleRunStateGate.presentation(for: .idle), .mini)
        XCTAssertEqual(
            AgentCapsuleRunStateGate.presentation(
                for: AgentRunPresentationState(
                    phase: .completed(hasUnreadReply: true),
                    currentAction: nil,
                    failureReason: nil,
                    recovery: nil
                )
            ),
            .full,
            "未读 complete 必须保持完整胶囊"
        )
        XCTAssertEqual(
            AgentCapsuleRunStateGate.presentation(
                for: AgentRunPresentationState(
                    phase: .completed(hasUnreadReply: false),
                    currentAction: nil,
                    failureReason: nil,
                    recovery: nil
                )
            ),
            .mini
        )
    }

    func testRunStateGateShowsRunningHitlAndFailed() {
        let cases: [AgentRunPresentationState.Phase] = [
            .preparing,
            .planning,
            .executing,
            .responding,
            .waitingForUser(count: 2),
            .paused,
            .recoveringConnection,
            .failed,
        ]
        for phase in cases {
            let state = AgentRunPresentationState(
                phase: phase,
                currentAction: nil,
                failureReason: phase == .failed ? "timeout" : nil,
                recovery: nil
            )
            XCTAssertEqual(
                AgentCapsuleRunStateGate.presentation(for: state),
                .full,
                "phase \(phase) should render the full capsule"
            )
        }
    }

    // MARK: - Visibility matrix

    func testVisibilityMatrixCompactWorkbenchShowsWhenRunning() {
        let coordinator = makeCoordinator(runPhase: .executing)
        coordinator.selectCompactSurface(.workbench)
        coordinator.updateLayoutContext(isCompactLayout: true)

        XCTAssertTrue(coordinator.capsuleVisibility().shouldShow)
        XCTAssertTrue(coordinator.capsuleVisibility(isCompactLayout: true).shouldShow)

        coordinator.selectCompactSurface(.conversation)
        XCTAssertFalse(coordinator.capsuleVisibility(isCompactLayout: true).shouldShow)
    }

    func testVisibilityMatrixCompactMinimizesWhenIdleOnWorkbench() {
        let coordinator = makeCoordinator(runPhase: .idle)
        coordinator.selectCompactSurface(.workbench)
        XCTAssertEqual(
            coordinator.capsuleVisibility(isCompactLayout: true).presentation,
            .mini
        )
    }

    func testVisibilityMatrixRegularSplitAlwaysHidesFloatingCapsule() {
        let coordinator = makeCoordinator(runPhase: .waitingForUser(count: 1))
        coordinator.setViewMode(.split)
        coordinator.updateLayoutContext(isCompactLayout: false)

        XCTAssertFalse(coordinator.capsuleVisibility().shouldShow)
        XCTAssertFalse(coordinator.capsuleVisibility(isCompactLayout: false).shouldShow)
    }

    func testVisibilityMatrixRegularAppFocusShowsWhenActive() {
        let coordinator = makeCoordinator(runPhase: .executing)
        coordinator.setViewMode(.appFocus)
        coordinator.updateLayoutContext(isCompactLayout: false)

        let info = coordinator.capsuleVisibility()
        XCTAssertTrue(info.shouldShow)
        XCTAssertEqual(info.agentName, "CapsuleBot")
        XCTAssertEqual(info.completedTodoCount, 1)
        XCTAssertEqual(info.totalTodoCount, 3)
    }

    func testVisibilityMatrixRegularAppFocusMinimizesWhenIdle() {
        let coordinator = makeCoordinator(runPhase: .idle)
        coordinator.setViewMode(.appFocus)
        XCTAssertEqual(
            coordinator.capsuleVisibility(isCompactLayout: false).presentation,
            .mini
        )
    }

    /// 分屏 / 对话面即使空闲也**不该**出现微缩环——布局门闩优先于运行态。
    func testLayoutGateBeatsRunStateForMiniPresentation() {
        let coordinator = makeCoordinator(runPhase: .idle)
        coordinator.setViewMode(.split)
        XCTAssertEqual(
            coordinator.capsuleVisibility(isCompactLayout: false).presentation,
            .hidden
        )

        coordinator.selectCompactSurface(.conversation)
        XCTAssertEqual(
            coordinator.capsuleVisibility(isCompactLayout: true).presentation,
            .hidden
        )
    }

    func testVisibilityMatrixRegularChatFocusHides() {
        let coordinator = makeCoordinator(runPhase: .failed)
        coordinator.setViewMode(.chatFocus)
        XCTAssertFalse(coordinator.capsuleVisibility(isCompactLayout: false).shouldShow)
    }

    func testResourcePageUsesSameLayoutGateAsDashboard() {
        // 资源页与 dashboard 共用 WorkbenchContainerView 挂载点；
        // 可见性只看 layout + runState，与 navigation path 无关。
        let coordinator = makeCoordinator(runPhase: .responding)
        coordinator.selectCompactSurface(.workbench)
        XCTAssertTrue(coordinator.capsuleVisibility(isCompactLayout: true).shouldShow)
    }

    // MARK: - Voice + focus intents

    func testRequestVoiceInputSetsAndClearsTypedRequest() {
        let coordinator = TaskSurfaceCoordinator(persistenceKey: key)
        XCTAssertNil(coordinator.voiceInputRequest)
        XCTAssertFalse(coordinator.wantsVoiceInput)
        coordinator.requestVoiceInput(.capsule)
        XCTAssertEqual(coordinator.voiceInputRequest, .capsule)
        XCTAssertTrue(coordinator.wantsVoiceInput)
        coordinator.clearVoiceInputRequest()
        XCTAssertNil(coordinator.voiceInputRequest)
        XCTAssertFalse(coordinator.wantsVoiceInput)
    }

    func testReturnToConversationFromAppFocus() {
        let coordinator = makeCoordinator(runPhase: .waitingForUser(count: 1))
        coordinator.updateLayoutContext(isCompactLayout: false)
        coordinator.setViewMode(.appFocus)
        coordinator.returnToConversation(focusingMessageId: "row-hitl")
        XCTAssertEqual(coordinator.viewMode, .chatFocus)
        XCTAssertEqual(coordinator.compactSurface, .conversation)
        XCTAssertEqual(coordinator.pendingFocusMessageId, "row-hitl")
        XCTAssertFalse(coordinator.capsuleVisibility(isCompactLayout: false).shouldShow)
    }

    // MARK: - Copy / a11y strings

    func testCapsuleCopyForHitlEmphasizesAttention() {
        let copy = AgentStatusCapsuleCopy(
            runState: AgentRunPresentationState(
                phase: .waitingForUser(count: 3),
                currentAction: nil,
                failureReason: nil,
                recovery: nil
            )
        )
        XCTAssertEqual(copy.title, "等待你确认")
        XCTAssertEqual(copy.subtitle, "3 项待处理")
        XCTAssertTrue(copy.emphasizesUserAttention)
        XCTAssertEqual(copy.colorName, .warning)
    }

    func testCapsuleCopyForExecutingUsesCurrentAction() {
        let copy = AgentStatusCapsuleCopy(
            runState: AgentRunPresentationState(
                phase: .executing,
                currentAction: "读取表格",
                failureReason: nil,
                recovery: nil
            )
        )
        XCTAssertEqual(copy.title, "执行中")
        XCTAssertEqual(copy.subtitle, "读取表格")
        XCTAssertTrue(copy.isBusy)
    }

    func testCapsuleMetricsMatchCanonicalSizes() {
        XCTAssertEqual(AgentStatusCapsule.height, 48)
        XCTAssertEqual(AgentStatusCapsule.avatarSize, 32)
        XCTAssertEqual(AgentStatusCapsule.maxWidth, 360)
        XCTAssertEqual(AgentStatusCapsule.hostInset, 14)
    }

    // MARK: - Helpers

    private func makeCoordinator(
        runPhase: AgentRunPresentationState.Phase
    ) -> TaskSurfaceCoordinator {
        let coordinator = TaskSurfaceCoordinator(persistenceKey: key)
        coordinator.updateCapsuleFeed(
            agentName: "CapsuleBot",
            runState: AgentRunPresentationState(
                phase: runPhase,
                currentAction: runPhase == .executing ? "干活中" : nil,
                failureReason: runPhase == .failed ? "出错了" : nil,
                recovery: nil
            ),
            completedTodoCount: 1,
            totalTodoCount: 3
        )
        return coordinator
    }
}
