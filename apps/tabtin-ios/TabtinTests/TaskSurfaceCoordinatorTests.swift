import XCTest
@testable import Tabtin

@MainActor
final class TaskSurfaceCoordinatorTests: XCTestCase {
    private var key: String!

    override func setUp() {
        super.setUp()
        key = "test.taskSurface.\(UUID().uuidString)"
        TaskSurfaceCoordinator.resetPersistence(for: key)
    }

    override func tearDown() {
        TaskSurfaceCoordinator.resetPersistence(for: key)
        key = nil
        super.tearDown()
    }

    func testDefaultModeIsChatFocus() {
        let coordinator = TaskSurfaceCoordinator(persistenceKey: key)
        XCTAssertEqual(coordinator.viewMode, .chatFocus)
        XCTAssertEqual(coordinator.compactSurface, .conversation)
        XCTAssertFalse(coordinator.hasPresentedWorkbench)
    }

    func testSetViewModePersistsAndMarksWorkbenchPresented() {
        let coordinator = TaskSurfaceCoordinator(persistenceKey: key)
        coordinator.setViewMode(.split)
        XCTAssertEqual(coordinator.viewMode, .split)
        XCTAssertTrue(coordinator.hasPresentedWorkbench)
        // 分屏不强制改 compact 表面，避免旋转到窄屏时丢掉对话。
        XCTAssertEqual(coordinator.compactSurface, .conversation)

        let reloaded = TaskSurfaceCoordinator(persistenceKey: key)
        XCTAssertEqual(reloaded.viewMode, .split)
    }

    func testRegularAppFocusCapsuleOpensFloatingConversationWithoutChangingViewMode() {
        let coordinator = TaskSurfaceCoordinator(persistenceKey: key)
        coordinator.updateLayoutContext(isCompactLayout: false)
        coordinator.setViewMode(.appFocus)
        let compactDetentBefore = coordinator.conversationLayerDetent

        coordinator.openRegularFloatingConversation()

        XCTAssertEqual(coordinator.regularFloatingConversationPresentation, .floating)
        XCTAssertEqual(coordinator.viewMode, .appFocus)
        XCTAssertEqual(coordinator.conversationLayerDetent, compactDetentBefore)
        XCTAssertEqual(TaskViewMode.allCases, [.chatFocus, .split, .appFocus])
    }

    func testRegularFloatingConversationClosesWhenLeavingAppFocus() {
        let coordinator = TaskSurfaceCoordinator(persistenceKey: key)
        coordinator.updateLayoutContext(isCompactLayout: false)
        coordinator.setViewMode(.appFocus)
        coordinator.openRegularFloatingConversation()

        coordinator.setViewMode(.split)

        XCTAssertEqual(coordinator.regularFloatingConversationPresentation, .closed)
        coordinator.openRegularFloatingConversation()
        XCTAssertEqual(
            coordinator.regularFloatingConversationPresentation,
            .closed,
            "regular split 不允许重新打开悬浮对话"
        )

        coordinator.setViewMode(.appFocus)
        coordinator.openRegularFloatingConversation()
        coordinator.setViewMode(.chatFocus)
        XCTAssertEqual(coordinator.regularFloatingConversationPresentation, .closed)
    }

    func testCollapsingRegularFloatingConversationKeepsAppFocusAndRestoresCapsule() {
        let coordinator = TaskSurfaceCoordinator(persistenceKey: key)
        coordinator.updateLayoutContext(isCompactLayout: false)
        coordinator.setViewMode(.appFocus)
        XCTAssertEqual(
            coordinator.capsuleVisibility(isCompactLayout: false).presentation,
            .mini
        )

        coordinator.openRegularFloatingConversation()

        XCTAssertEqual(
            coordinator.capsuleVisibility(isCompactLayout: false).presentation,
            .hidden,
            "悬浮对话与胶囊必须二选一"
        )
        XCTAssertEqual(
            coordinator.capsuleVisibility(
                isCompactLayout: false,
                forcesWorkbenchVisibility: true
            ).presentation,
            .hidden,
            "顶层宿主也不能在悬浮对话之上重复显示胶囊"
        )

        coordinator.collapseRegularFloatingConversation()

        XCTAssertEqual(coordinator.regularFloatingConversationPresentation, .closed)
        XCTAssertEqual(coordinator.viewMode, .appFocus)
        XCTAssertEqual(
            coordinator.capsuleVisibility(isCompactLayout: false).presentation,
            .mini
        )
    }

    func testBackToSplitClosesRegularFloatingConversationAndChangesViewMode() {
        let coordinator = TaskSurfaceCoordinator(persistenceKey: key)
        coordinator.updateLayoutContext(isCompactLayout: false)
        coordinator.setViewMode(.appFocus)
        coordinator.openRegularFloatingConversation()

        coordinator.backToSplitFromRegularFloatingConversation()

        XCTAssertEqual(coordinator.regularFloatingConversationPresentation, .closed)
        XCTAssertEqual(coordinator.viewMode, .split)
        XCTAssertEqual(
            coordinator.capsuleVisibility(isCompactLayout: false).presentation,
            .hidden,
            "回到 split 后由并排对话栏承载状态，不恢复悬浮胶囊"
        )
    }

    func testSwitchingFromRegularToCompactClosesFloatingWithoutChangingCompactBehavior() {
        let coordinator = TaskSurfaceCoordinator(persistenceKey: key)
        coordinator.updateLayoutContext(isCompactLayout: false)
        coordinator.setViewMode(.appFocus)
        coordinator.openRegularFloatingConversation()
        coordinator.moveConversationLayer(to: .sheet)

        coordinator.updateLayoutContext(isCompactLayout: true)

        XCTAssertEqual(coordinator.regularFloatingConversationPresentation, .closed)
        XCTAssertEqual(coordinator.viewMode, .appFocus)
        XCTAssertEqual(coordinator.compactSurface, .workbench)
        XCTAssertEqual(coordinator.conversationLayerDetent, .collapsed)
        XCTAssertTrue(coordinator.isConversationLayerActive)
    }

    func testRegularFloatingConversationPresentationIsNotPersisted() {
        let coordinator = TaskSurfaceCoordinator(persistenceKey: key)
        coordinator.updateLayoutContext(isCompactLayout: false)
        coordinator.setViewMode(.appFocus)
        coordinator.openRegularFloatingConversation()
        XCTAssertEqual(coordinator.regularFloatingConversationPresentation, .floating)

        coordinator.updatePersistenceKey("\(key!).next-session")
        XCTAssertEqual(
            coordinator.regularFloatingConversationPresentation,
            .closed,
            "切换 session 时临时小窗不能跨会话泄漏"
        )

        let reloaded = TaskSurfaceCoordinator(persistenceKey: key)

        XCTAssertEqual(reloaded.viewMode, .appFocus, "既有 viewMode 仍按原契约持久化")
        XCTAssertEqual(reloaded.regularFloatingConversationPresentation, .closed)
    }

    func testRegularFloatingGeometryMatchesElectronWindowAndCapsuleSide() {
        let left = RegularConversationFloatingWindowGeometry.resolve(
            viewport: CGSize(width: 1_024, height: 768),
            placement: .init(side: .left, yRatio: 0.5)
        )
        let right = RegularConversationFloatingWindowGeometry.resolve(
            viewport: CGSize(width: 1_024, height: 768),
            placement: .init(side: .right, yRatio: 0.5)
        )

        XCTAssertEqual(left.frame, CGRect(x: 24, y: 104, width: 420, height: 560))
        XCTAssertEqual(left.transformOrigin, CGPoint(x: 0, y: 280))
        XCTAssertEqual(right.frame, CGRect(x: 580, y: 104, width: 420, height: 560))
        XCTAssertEqual(right.transformOrigin, CGPoint(x: 420, y: 280))
    }

    func testRegularFloatingGeometryShrinksAndClampsInsideNarrowViewport() {
        let layout = RegularConversationFloatingWindowGeometry.resolve(
            viewport: CGSize(width: 400, height: 600),
            placement: .init(side: .right, yRatio: 2)
        )

        XCTAssertEqual(layout.frame, CGRect(x: 24, y: 116, width: 352, height: 460))
        XCTAssertEqual(layout.transformOrigin, CGPoint(x: 352, y: 460))
    }

    func testSelectSurfaceMapsWorkbenchToSplitOnRegular() {
        let coordinator = TaskSurfaceCoordinator(persistenceKey: key)
        coordinator.selectSurface(.workbench, isRegularSplitCapable: true)
        XCTAssertEqual(coordinator.viewMode, .split)
        XCTAssertTrue(coordinator.isWorkbenchVisible(isCompactLayout: false))
        XCTAssertTrue(coordinator.isConversationVisible(isCompactLayout: false))
    }

    func testSelectSurfaceKeepsAppFocusWhenAlreadyImmersed() {
        let coordinator = TaskSurfaceCoordinator(persistenceKey: key)
        coordinator.setViewMode(.appFocus)
        coordinator.selectSurface(.workbench, isRegularSplitCapable: true)
        XCTAssertEqual(coordinator.viewMode, .appFocus)
        XCTAssertFalse(coordinator.isConversationVisible(isCompactLayout: false))
        XCTAssertTrue(coordinator.isWorkbenchVisible(isCompactLayout: false))
    }

    func testConversationVisibilityGatesAutoReadAckSurfaces() {
        let coordinator = TaskSurfaceCoordinator(persistenceKey: key)
        // compact 工作台：对话不可见 → 不得自动已读。
        coordinator.selectSurface(.workbench, isRegularSplitCapable: false)
        XCTAssertFalse(coordinator.isConversationVisible(isCompactLayout: true))
        // compact 对话面 / regular split / chat-focus：可见。
        coordinator.selectSurface(.conversation, isRegularSplitCapable: false)
        XCTAssertTrue(coordinator.isConversationVisible(isCompactLayout: true))
        coordinator.setViewMode(.split)
        XCTAssertTrue(coordinator.isConversationVisible(isCompactLayout: false))
        coordinator.setViewMode(.chatFocus)
        XCTAssertTrue(coordinator.isConversationVisible(isCompactLayout: false))
        coordinator.setViewMode(.appFocus)
        XCTAssertFalse(coordinator.isConversationVisible(isCompactLayout: false))
    }

    func testPresentWorkbenchOnCompactOnlyTouchesCompactSurface() {
        let coordinator = TaskSurfaceCoordinator(persistenceKey: key)
        coordinator.presentWorkbench(isRegularSplitCapable: false)
        XCTAssertEqual(coordinator.compactSurface, .workbench)
        XCTAssertEqual(coordinator.conversationLayerDetent, .collapsed)
        XCTAssertEqual(coordinator.viewMode, .chatFocus)
        XCTAssertTrue(coordinator.shouldMountWorkbench(isCompactLayout: true))
        XCTAssertTrue(coordinator.isWorkbenchVisible(isCompactLayout: true))
    }

    func testPresentWorkbenchOnRegularLeavesChatFocusForSplit() {
        let coordinator = TaskSurfaceCoordinator(persistenceKey: key)
        coordinator.presentWorkbench(isRegularSplitCapable: true)
        XCTAssertEqual(coordinator.viewMode, .split)
        XCTAssertTrue(coordinator.shouldMountWorkbench(isCompactLayout: false))
    }

    func testChatFocusKeepsWorkbenchMountedAfterPresentation() {
        let coordinator = TaskSurfaceCoordinator(persistenceKey: key)
        coordinator.presentWorkbench(isRegularSplitCapable: true)
        coordinator.setViewMode(.chatFocus)
        XCTAssertTrue(coordinator.shouldMountWorkbench(isCompactLayout: false))
        XCTAssertFalse(coordinator.isWorkbenchVisible(isCompactLayout: false))
    }

    func testReturnToConversationSetsFocusIntent() {
        let coordinator = TaskSurfaceCoordinator(persistenceKey: key)
        coordinator.setViewMode(.appFocus)
        coordinator.returnToConversation(focusingMessageId: "msg-42")
        XCTAssertEqual(coordinator.viewMode, .chatFocus)
        XCTAssertEqual(coordinator.compactSurface, .workbench)
        XCTAssertEqual(coordinator.conversationLayerDetent, .sheet)
        XCTAssertEqual(coordinator.pendingFocusMessageId, "msg-42")
        coordinator.clearPendingFocusMessageId()
        XCTAssertNil(coordinator.pendingFocusMessageId)
    }

    func testCompactConversationPickerLeavesOverlayAndShowsIndependentFullSurface() {
        let coordinator = TaskSurfaceCoordinator(persistenceKey: key)
        coordinator.presentWorkbench(isRegularSplitCapable: false)

        XCTAssertTrue(coordinator.isConversationLayerActive)
        XCTAssertTrue(coordinator.isWorkbenchVisible(isCompactLayout: true))
        XCTAssertFalse(coordinator.isConversationVisible(isCompactLayout: true))

        coordinator.selectCompactSurface(.conversation)
        XCTAssertEqual(coordinator.compactSurface, .conversation)
        XCTAssertEqual(coordinator.conversationLayerDetent, .collapsed)
        XCTAssertFalse(coordinator.isConversationLayerActive)
        XCTAssertFalse(coordinator.isWorkbenchVisible(isCompactLayout: true))
        XCTAssertTrue(coordinator.isConversationVisible(isCompactLayout: true))

        coordinator.selectCompactSurface(.workbench)
        coordinator.moveConversationLayer(to: .sheet)
        coordinator.selectCompactSurface(.conversation)
        XCTAssertEqual(coordinator.compactSurface, .conversation)
        XCTAssertEqual(coordinator.conversationLayerDetent, .collapsed)
        XCTAssertFalse(coordinator.isConversationLayerActive)

        coordinator.selectCompactSurface(.conversation)
        XCTAssertEqual(coordinator.compactSurface, .conversation, "全屏重复选择应为空操作")
        XCTAssertEqual(coordinator.conversationLayerDetent, .collapsed)
    }

    func testCompactPickerSelectionReflectsIndependentSurfaceNotOverlayDetent() {
        XCTAssertTrue(
            ConversationTaskSurfaceSwitcherPolicy.hides(
                featureEnabled: true,
                isRegularLayout: false,
                hasPresentedPage: true,
                hasEmbeddedAppHome: false,
                hasEmbeddedPath: false
            ),
            "原生 App sheet 接管同款 Picker 后，底层根 Picker 必须隐藏"
        )
        XCTAssertTrue(
            ConversationTaskSurfaceSwitcherPolicy.hides(
                featureEnabled: true,
                isRegularLayout: true,
                hasPresentedPage: false,
                hasEmbeddedAppHome: true,
                hasEmbeddedPath: false
            )
        )

        let freshCoordinator = TaskSurfaceCoordinator(persistenceKey: key)
        XCTAssertEqual(
            freshCoordinator.compactPickerSurface,
            freshCoordinator.compactSurface,
            "对话层尚未启用时，picker 沿用既有 compact surface"
        )

        let coordinator = TaskSurfaceCoordinator(persistenceKey: key)
        coordinator.presentWorkbench(isRegularSplitCapable: false)

        XCTAssertEqual(coordinator.compactPickerSurface, .workbench)

        coordinator.moveConversationLayer(to: .sheet)
        XCTAssertEqual(
            coordinator.compactPickerSurface,
            .workbench,
            "SHEET 是工作台上的 overlay，顶部切换器必须仍显示工作台选中"
        )

        coordinator.moveConversationLayer(to: .expanded)
        XCTAssertEqual(
            coordinator.compactPickerSurface,
            .workbench,
            "EXPANDED 仍是工作台 overlay，不得点亮对话"
        )

        coordinator.selectCompactSurface(.conversation)
        XCTAssertEqual(coordinator.compactSurface, .conversation)
        XCTAssertEqual(coordinator.conversationLayerDetent, .collapsed)
        XCTAssertEqual(
            coordinator.compactPickerSurface,
            .conversation,
            "只有独立全屏对话工作面才应显示顶部对话选中"
        )
    }

    func testConversationLayerDragTracksFingerAndSettlesByVelocity() {
        let coordinator = TaskSurfaceCoordinator(persistenceKey: key)
        coordinator.presentWorkbench(isRegularSplitCapable: false)

        coordinator.dragConversationLayer(by: -300, viewportHeight: 1_000)
        XCTAssertEqual(coordinator.conversationLayerTopRatio, 0.7, accuracy: 0.0001)
        XCTAssertTrue(coordinator.conversationLayerIsDragging)

        XCTAssertEqual(
            coordinator.settleConversationLayer(velocityPointsPerSecond: -800),
            .sheet
        )
        XCTAssertEqual(coordinator.conversationLayerTopRatio, 0.52, accuracy: 0.0001)
        XCTAssertFalse(coordinator.conversationLayerIsDragging)

        coordinator.dragConversationLayer(by: -80, viewportHeight: 1_000)
        XCTAssertEqual(
            coordinator.settleConversationLayer(velocityPointsPerSecond: -800),
            .expanded,
            "从 SHEET 继续上滑应展开为更长的同一卡片"
        )
        coordinator.dragConversationLayer(by: 24, viewportHeight: 1_000)
        XCTAssertEqual(
            coordinator.settleConversationLayer(velocityPointsPerSecond: 0),
            .expanded,
            "EXPANDED 小幅拖放应吸回 expanded detent"
        )
        XCTAssertEqual(coordinator.compactPickerSurface, .workbench)
    }

    func testConversationLayerGeometryClampsAndSettlesToNearestDetent() {
        XCTAssertEqual(ConversationLayerGeometry.clamp(-1), 0.09, accuracy: 0.0001)
        XCTAssertEqual(ConversationLayerGeometry.clamp(2), 1, accuracy: 0.0001)
        XCTAssertEqual(
            ConversationLayerGeometry.settle(
                topRatio: 0.53,
                velocityPointsPerMillisecond: 0,
                allowsExpanded: false
            ),
            .sheet
        )
        XCTAssertEqual(
            ConversationLayerGeometry.settle(
                topRatio: 0.2,
                velocityPointsPerMillisecond: 0.8,
                allowsExpanded: false
            ),
            .sheet
        )
        XCTAssertEqual(
            ConversationLayerGeometry.settle(
                topRatio: 0.1,
                velocityPointsPerMillisecond: 0,
                allowsExpanded: true
            ),
            .expanded
        )
    }

    func testConversationLayerHeightIncludesBottomSafeAreaOnlyWhileVisible() {
        XCTAssertEqual(
            ConversationLayerGeometry.visibleHeight(
                viewportHeight: 1_000,
                bottomSafeAreaInset: 34,
                topRatio: ConversationLayerGeometry.sheetTopRatio
            ),
            514,
            accuracy: 0.0001
        )
        XCTAssertEqual(
            ConversationLayerGeometry.visibleHeight(
                viewportHeight: 1_000,
                bottomSafeAreaInset: 34,
                topRatio: ConversationLayerGeometry.collapsedTopRatio
            ),
            0,
            accuracy: 0.0001
        )
    }

    func testSheetSteadyStateLaysOutConversationAtVisibleHeight() {
        let visibleHeight = ConversationLayerGeometry.visibleHeight(
            viewportHeight: 1_000,
            bottomSafeAreaInset: 34,
            topRatio: ConversationLayerGeometry.sheetTopRatio
        )
        let contentLayoutHeight = ConversationLayerGeometry.steadyContentLayoutHeight(
            viewportHeight: 1_000,
            bottomSafeAreaInset: 34,
            detent: ConversationLayerDetent.sheet
        )

        XCTAssertEqual(contentLayoutHeight, visibleHeight, accuracy: 0.0001)
        XCTAssertNotEqual(
            contentLayoutHeight,
            1_034,
            "SHEET 稳态必须按实际可见高度布局消息与 Composer，不能全高布局后再从底部裁切"
        )

        let expandedDetentHeight = ConversationLayerGeometry.steadyContentLayoutHeight(
            viewportHeight: 1_000,
            bottomSafeAreaInset: 34,
            detent: .expanded
        )
        XCTAssertEqual(
            ConversationLayerGeometry.contentLayoutHeight(
                viewportHeight: 1_000,
                bottomSafeAreaInset: 34,
                detent: .sheet,
                isDragging: true
            ),
            expandedDetentHeight,
            accuracy: 0.0001,
            "拖动期必须锁定 expanded-detent proposal，只让轻量裁剪跟手"
        )
        XCTAssertEqual(
            ConversationLayerGeometry.contentLayoutHeight(
                viewportHeight: 1_000,
                bottomSafeAreaInset: 34,
                detent: .collapsed,
                isDragging: true
            ),
            expandedDetentHeight,
            accuracy: 0.0001
        )
    }

    func testCompactTaskPaneKeepsNativeAppSheetWhileConversationLayerExpands() {
        let coordinator = TaskSurfaceCoordinator(persistenceKey: key)
        coordinator.presentWorkbench(isRegularSplitCapable: false)

        let navigation = WorkbenchNavigationState()
        navigation.prepare(
            for: "org-1",
            spaceId: "workspace-1",
            presentsPagesModally: true
        )
        let app = TaskWorkbenchApp(
            id: "tabdoc",
            name: "云文档",
            description: "协作文档",
            manifestIcon: "file-text",
            surface: .collaborative,
            installed: true,
            workspaceAvailable: true,
            enabled: true,
            canCreate: true,
            order: 1,
            recentResource: nil,
            resourceCount: 0
        )
        navigation.showAppHome(app)
        XCTAssertEqual(navigation.presentedPage, .appHome(app))

        coordinator.returnToConversation()

        XCTAssertEqual(coordinator.conversationLayerDetent, .sheet)
        XCTAssertEqual(
            navigation.presentedPage,
            .appHome(app),
            "展开半屏对话不能 dismiss App sheet 或退回工作台首页"
        )
    }

    func testBackdropTapAlwaysCollapsesLayerWithoutUnmountingWorkbench() {
        let coordinator = TaskSurfaceCoordinator(persistenceKey: key)
        coordinator.presentWorkbench(isRegularSplitCapable: false)

        coordinator.moveConversationLayer(to: .sheet)
        coordinator.collapseConversationLayerFromBackdrop()
        XCTAssertEqual(coordinator.conversationLayerDetent, .collapsed)
        XCTAssertTrue(coordinator.shouldMountWorkbench(isCompactLayout: true))

        coordinator.moveConversationLayer(to: .expanded)
        coordinator.collapseConversationLayerFromBackdrop()
        XCTAssertEqual(
            coordinator.conversationLayerDetent,
            .sheet,
            "EXPANDED 的显式回程应沿层级先退到半屏"
        )
        XCTAssertTrue(coordinator.shouldMountWorkbench(isCompactLayout: true))
    }

    func testCapsuleVisibilityCompactVsAppFocus() {
        let coordinator = TaskSurfaceCoordinator(persistenceKey: key)
        coordinator.updateCapsuleFeed(
            agentName: "Codex",
            runState: AgentRunPresentationState(
                phase: .executing,
                currentAction: "读取文档",
                failureReason: nil,
                recovery: nil
            ),
            completedTodoCount: 1,
            totalTodoCount: 3
        )

        coordinator.selectCompactSurface(.workbench)
        let compactInfo = coordinator.capsuleVisibility(isCompactLayout: true)
        XCTAssertTrue(compactInfo.shouldShow)
        XCTAssertEqual(compactInfo.agentName, "Codex")
        XCTAssertEqual(compactInfo.completedTodoCount, 1)

        coordinator.setViewMode(.split)
        XCTAssertFalse(coordinator.capsuleVisibility(isCompactLayout: false).shouldShow)

        coordinator.setViewMode(.appFocus)
        XCTAssertTrue(coordinator.capsuleVisibility(isCompactLayout: false).shouldShow)

        // 空闲不整条常驻，但收成微缩环保留回对话 / 语音入口
        coordinator.updateCapsuleFeed(
            agentName: "Codex",
            runState: .idle,
            completedTodoCount: 1,
            totalTodoCount: 3
        )
        XCTAssertEqual(
            coordinator.capsuleVisibility(isCompactLayout: false).presentation,
            .mini
        )
    }

    func testForcedWorkbenchCapsuleFollowsRunStateAboveRegularSplitSheet() {
        let coordinator = TaskSurfaceCoordinator(persistenceKey: key)
        coordinator.setViewMode(.split)
        coordinator.updateCapsuleFeed(
            agentName: "Codex",
            runState: AgentRunPresentationState(
                phase: .executing,
                currentAction: "读取文档",
                failureReason: nil,
                recovery: nil
            ),
            completedTodoCount: 1,
            totalTodoCount: 3
        )

        XCTAssertEqual(
            coordinator.capsuleVisibility(isCompactLayout: false).presentation,
            .hidden,
            "regular split 默认由并排对话栏承载状态，不应额外显示胶囊"
        )
        XCTAssertEqual(
            coordinator.capsuleVisibility(
                isCompactLayout: false,
                forcesWorkbenchVisibility: true
            ).presentation,
            .full,
            "系统 sheet 覆盖对话栏后，强制宿主应按执行态保留完整胶囊"
        )

        coordinator.updateCapsuleFeed(
            agentName: "Codex",
            runState: .idle,
            completedTodoCount: 1,
            totalTodoCount: 3
        )
        XCTAssertEqual(
            coordinator.capsuleVisibility(
                isCompactLayout: false,
                forcesWorkbenchVisibility: true
            ).presentation,
            .mini,
            "强制可见只改变布局门闩，不应绕过运行态的微缩规则"
        )
    }

    func testWorkbenchCapsuleLayerCoordinatorHandsHostToTopmostSheet() {
        let coordinator = WorkbenchCapsuleLayerCoordinator()
        let root = UUID()
        let nested = UUID()

        coordinator.mount(root)
        XCTAssertTrue(coordinator.isTopLayer(root))

        coordinator.mount(nested)
        XCTAssertFalse(coordinator.isTopLayer(root))
        XCTAssertTrue(coordinator.isTopLayer(nested))

        coordinator.mount(nested)
        XCTAssertEqual(coordinator.layerIDs, [root, nested], "重复 onAppear 不能制造双宿主")

        coordinator.unmount(nested)
        XCTAssertTrue(coordinator.isTopLayer(root), "二级 sheet 关闭后应把胶囊交还根 sheet")

        coordinator.unmount(root)
        XCTAssertTrue(coordinator.layerIDs.isEmpty)
    }

    func testVoiceDispatchDoesNotChangeSurfaceOrPath() {
        let coordinator = TaskSurfaceCoordinator(persistenceKey: key)
        coordinator.selectCompactSurface(.workbench)
        coordinator.setViewMode(.appFocus)
        let navigation = WorkbenchNavigationState()
        navigation.show(.tabdoc(documentId: "doc-A", documentName: "资源 A"))
        let pathBefore = navigation.path
        let surfaceBefore = coordinator.compactSurface
        let modeBefore = coordinator.viewMode

        coordinator.updateFocusSnapshot(
            FocusSnapshot.projecting(
                navigationState: navigation,
                spaceId: "space-1",
                viewMode: coordinator.viewMode,
                isCompactLayout: false,
                compactSurface: coordinator.compactSurface
            )
        )
        coordinator.recordVoiceDispatchReceipt(.queued(queueId: "voice-q-1"))

        XCTAssertEqual(coordinator.compactSurface, surfaceBefore)
        XCTAssertEqual(coordinator.viewMode, modeBefore)
        XCTAssertEqual(navigation.path, pathBefore)
        XCTAssertEqual(coordinator.currentFocusSnapshot?.openTabs?.first?.id, "doc-A")
        if case let .queued(id) = coordinator.lastVoiceDispatchReceipt {
            XCTAssertEqual(id, "voice-q-1")
        } else {
            XCTFail("expected queued receipt")
        }
    }

    func testTaskViewModeLabelsMatchElectron() {
        XCTAssertEqual(TaskViewMode.chatFocus.title, "对话聚焦")
        XCTAssertEqual(TaskViewMode.split.title, "分屏")
        XCTAssertEqual(TaskViewMode.appFocus.title, "应用聚焦")
        XCTAssertEqual(TaskViewMode.chatFocus.rawValue, "chat-focus")
        XCTAssertEqual(TaskViewMode.appFocus.rawValue, "app-focus")
    }

    func testSplitMetricsClampWidthAndFraction() {
        let width = TaskSurfaceSplitMetrics.workbenchWidth(
            availableWidth: 1000,
            fraction: 0.4
        )
        XCTAssertEqual(width, 400)

        let clampedLow = TaskSurfaceSplitMetrics.workbenchWidth(
            availableWidth: 1000,
            fraction: 0.1
        )
        XCTAssertEqual(clampedLow, 320)

        let clampedHigh = TaskSurfaceSplitMetrics.workbenchWidth(
            availableWidth: 1000,
            fraction: 0.9
        )
        XCTAssertEqual(clampedHigh, 480)

        XCTAssertEqual(
            TaskSurfaceSplitMetrics.appStorageKey(for: .regular),
            "tt.taskSurface.workbenchFraction.regular"
        )
        XCTAssertEqual(
            TaskSurfaceSplitMetrics.appStorageKey(for: .compact),
            "tt.taskSurface.workbenchFraction.compact"
        )
    }
}
