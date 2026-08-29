import XCTest
@testable import Tabtin

@MainActor
final class NativeConversationLayerContractTests: XCTestCase {
    private var key: String!

    override func setUp() {
        super.setUp()
        key = "test.nativeConversationLayer.\(UUID().uuidString)"
        TaskSurfaceCoordinator.resetPersistence(for: key)
    }

    override func tearDown() {
        TaskSurfaceCoordinator.resetPersistence(for: key)
        key = nil
        super.tearDown()
    }

    func testRichContentFileSizeKeepsSubKilobyteBytesVisible() {
        XCTAssertEqual(RichContentFileSizeFormatter.string(from: 1), "1 B")
        XCTAssertEqual(RichContentFileSizeFormatter.string(from: 512), "512 B")
        XCTAssertEqual(RichContentFileSizeFormatter.string(from: 1024), "1 KB")
    }

    func testCompactSurfaceSwitcherRemainsNativeSegmentedPicker() throws {
        let source = try sourceText(
            "Tabtin/Features/Conversation/ConversationScreen.swift"
        )
        let pickerSection = try section(
            in: source,
            from: "struct CompactTaskSurfacePicker",
            through: "struct CompactConversationOverlayHost"
        )

        XCTAssertNotNil(
            pickerSection.range(
                of: #"(?m)^\s*Picker\("#,
                options: .regularExpression
            ),
            "iOS 顶部“对话 / 工作台”必须继续使用 SwiftUI 原生 Picker"
        )
        XCTAssertTrue(
            pickerSection.contains(".pickerStyle(.segmented)"),
            "iOS 顶部切换器必须继续使用原生 segmented 样式"
        )
        XCTAssertFalse(
            pickerSection.contains("Button"),
            "不要用两个自绘 Button 模拟系统 segmented control"
        )
    }

    func testCompactNavigationUsesPresentationWhileRegularNavigationStaysEmbedded() {
        let app = makeApp()

        let compactNavigation = WorkbenchNavigationState()
        compactNavigation.prepare(
            for: "org-1",
            spaceId: "workspace-1",
            presentsPagesModally: true
        )
        compactNavigation.showAppHome(app)
        XCTAssertEqual(compactNavigation.presentedPage, .appHome(app))
        XCTAssertNil(compactNavigation.appHome)

        let regularNavigation = WorkbenchNavigationState()
        regularNavigation.prepare(
            for: "org-1",
            spaceId: "workspace-1",
            presentsPagesModally: false
        )
        regularNavigation.showAppHome(app)
        XCTAssertEqual(regularNavigation.appHome, app)
        XCTAssertNil(
            regularNavigation.presentedPage,
            "iPad regular 的 App 首页必须留在 Workbench pane，不能进入系统 presentation"
        )
    }

    func testNavigationPresentationPolicyCanReturnFromCompactModalToRegularEmbedded() {
        let navigation = WorkbenchNavigationState()
        let app = makeApp()

        navigation.prepare(
            for: "org-1",
            spaceId: "workspace-1",
            presentsPagesModally: true
        )
        navigation.showAppHome(app)
        XCTAssertEqual(navigation.presentedPage, .appHome(app))
        navigation.dismissPresentedPage()

        navigation.prepare(
            for: "org-1",
            spaceId: "workspace-1",
            presentsPagesModally: false
        )
        navigation.showAppHome(app)

        XCTAssertEqual(
            navigation.appHome,
            app,
            "窗口回到 regular 后，同一导航状态不能永久粘在 compact modal 策略"
        )
        XCTAssertNil(navigation.presentedPage)
    }

    func testTaskAppAndDetailUseCompactSheetAndRegularEmbeddedPane() throws {
        let source = try sourceText(
            "Tabtin/Features/Workbench/WorkbenchSheet.swift"
        )
        let containerSection = try section(
            in: source,
            from: "struct WorkbenchContainerView: View",
            through: "private func resourceOpenNotice"
        )

        XCTAssertTrue(
            containerSection.contains(".sheet(item: compactPresentedPageBinding)"),
            "iPhone / compact Workbench App 与详情必须继续由系统 sheet 承载"
        )
        XCTAssertFalse(
            containerSection.contains(".fullScreenCover("),
            "iPad / regular Workbench App 与详情必须嵌入 Workbench pane，不能再走 fullScreenCover"
        )
        XCTAssertTrue(
            containerSection.contains("presentsPagesModally: shouldPresentPagesModally")
                && containerSection.contains("isTaskWorkbenchPane && presentedPageIsCompactLayout"),
            "taskPane 只有 compact 使用 modal；regular 必须让 appHome/path 留在 pane 内"
        )
        let embeddedSection = try section(
            in: source,
            from: "private var embeddedTaskPane",
            through: "private func activateApp"
        )
        XCTAssertTrue(
            embeddedSection.contains("navigationState.appHome")
                && embeddedSection.contains("navigationState.path.last"),
            "iPad pane 内必须同时承载 App 首页与资源详情导航"
        )
    }

    func testConversationSheetDoesNotDismissNativeAppPresentation() {
        let coordinator = TaskSurfaceCoordinator(persistenceKey: key)
        coordinator.updateLayoutContext(isCompactLayout: true)
        coordinator.presentWorkbench(isRegularSplitCapable: false)

        let navigation = WorkbenchNavigationState()
        navigation.prepare(
            for: "org-1",
            spaceId: "workspace-1",
            presentsPagesModally: true
        )
        let app = makeApp()
        navigation.showAppHome(app)
        XCTAssertEqual(navigation.presentedPage, .appHome(app))
        let pageBefore = navigation.presentedPage
        let focusBefore = navigation.presentedFocusTab
        let pathBefore = navigation.path

        coordinator.returnToConversation()

        XCTAssertEqual(coordinator.conversationLayerDetent, .sheet)
        XCTAssertEqual(
            navigation.presentedPage,
            .appHome(app),
            "上滑胶囊只展开对话层，不能关闭 App sheet 或退回工作台首页"
        )

        coordinator.selectCompactSurface(.conversation)
        XCTAssertEqual(
            navigation.presentedPage,
            pageBefore,
            "sheet-local 全屏对话必须盖在 App 上，不能清掉 presentedPage"
        )
        XCTAssertEqual(navigation.presentedFocusTab, focusBefore)
        XCTAssertEqual(navigation.path, pathBefore, "App 内导航必须原位保留")
    }

    func testRegularEmbeddedAppFloatingConversationKeepsPaneNavigation() {
        let coordinator = TaskSurfaceCoordinator(persistenceKey: key)
        coordinator.updateLayoutContext(isCompactLayout: false)
        coordinator.setViewMode(.appFocus)

        let navigation = WorkbenchNavigationState()
        navigation.prepare(
            for: "org-1",
            spaceId: "workspace-1",
            presentsPagesModally: false
        )
        let app = makeApp()
        navigation.showAppHome(app)
        let appHomeBefore = navigation.appHome
        let pathBefore = navigation.path
        XCTAssertNil(navigation.presentedPage)

        coordinator.openRegularFloatingConversation()

        XCTAssertEqual(coordinator.regularFloatingConversationPresentation, .floating)
        XCTAssertEqual(coordinator.viewMode, .appFocus)
        XCTAssertEqual(navigation.appHome, appHomeBefore)
        XCTAssertNil(navigation.presentedPage)
        XCTAssertEqual(navigation.path, pathBefore)

        coordinator.collapseRegularFloatingConversation()

        XCTAssertEqual(coordinator.regularFloatingConversationPresentation, .closed)
        XCTAssertEqual(coordinator.viewMode, .appFocus)
        XCTAssertEqual(navigation.appHome, appHomeBefore)
        XCTAssertNil(navigation.presentedPage)
        XCTAssertEqual(navigation.path, pathBefore)
    }

    func testRegularWorkbenchEntryFromChatFocusEntersSplit() {
        let coordinator = TaskSurfaceCoordinator(persistenceKey: key)
        coordinator.updateLayoutContext(isCompactLayout: false)
        coordinator.setViewMode(.chatFocus)

        coordinator.presentWorkbench(isRegularSplitCapable: true)

        XCTAssertEqual(
            coordinator.viewMode,
            .split,
            "iPad 从完整对话打开工作台或 App 时必须进入 Electron 式分屏"
        )
    }

    func testCompactNativeAppSheetConversationHostRemainsOverlayOnly() {
        XCTAssertEqual(
            WorkbenchPresentedPageSheetPolicy.conversationHostPlacement(
                hasConversationLayer: true,
                hasRegularFloatingHost: true,
                isCompactLayout: true,
                compactConversationLayerIsActive: true
            ),
            .compactOverlay,
            "compact App sheet 必须保持既有 bottom overlay，不得同时挂 regular 浮窗"
        )
        XCTAssertEqual(
            WorkbenchPresentedPageSheetPolicy.conversationHostPlacement(
                hasConversationLayer: true,
                hasRegularFloatingHost: true,
                isCompactLayout: true,
                compactConversationLayerIsActive: false
            ),
            .none,
            "compact 主对话面不得被 sheet-local overlay 重复挂载"
        )
        XCTAssertEqual(
            WorkbenchPresentedPageSheetPolicy.conversationHostPlacement(
                hasConversationLayer: false,
                hasRegularFloatingHost: true,
                isCompactLayout: true,
                compactConversationLayerIsActive: false
            ),
            .none,
            "没有 conversation content 时 compact overlay 必须保持关闭"
        )
    }

    func testRegularFloatingWindowUsesCoordinatorAsSingleLayoutAuthority() throws {
        let source = try sourceText(
            "Tabtin/Features/Conversation/RegularConversationFloatingWindow.swift"
        )

        XCTAssertFalse(
            source.contains("horizontalSizeClass"),
            "浮窗组件不能再次读取 sheet-local size class；布局桶只由 coordinator/宿主决定"
        )
        XCTAssertTrue(
            source.contains("if isPresented, layout.frame.width > 0"),
            "宿主批准 regular floating 后，组件只按 presentation 与有效几何渲染"
        )
    }

    func testNativeAppSheetOnlyDisablesInteractiveDismissWhileConversationSurfaceIsOpen() {
        XCTAssertFalse(
            WorkbenchPresentedPageSheetPolicy.disablesInteractiveDismiss(
                conversationHostPlacement: .compactOverlay,
                conversationLayerDetent: .collapsed,
                regularFloatingConversationPresentation: .closed
            ),
            "对话层收起时必须保留原生 App sheet 的系统下滑关闭"
        )
        XCTAssertTrue(
            WorkbenchPresentedPageSheetPolicy.disablesInteractiveDismiss(
                conversationHostPlacement: .compactOverlay,
                conversationLayerDetent: .sheet,
                regularFloatingConversationPresentation: .closed
            ),
            "半屏卡片展开时必须避免纵向手势误关闭 App sheet"
        )
        XCTAssertTrue(
            WorkbenchPresentedPageSheetPolicy.disablesInteractiveDismiss(
                conversationHostPlacement: .compactOverlay,
                conversationLayerDetent: .expanded,
                regularFloatingConversationPresentation: .closed
            ),
            "更长的 overlay card 展开时必须避免纵向手势误关闭 App sheet"
        )
        XCTAssertFalse(
            WorkbenchPresentedPageSheetPolicy.hidesCapsule(
                conversationHostPlacement: .compactOverlay,
                conversationLayerDetent: .collapsed,
                regularFloatingConversationPresentation: .closed
            ),
            "compact overlay 收起时胶囊必须恢复"
        )
        XCTAssertTrue(
            WorkbenchPresentedPageSheetPolicy.hidesCapsule(
                conversationHostPlacement: .compactOverlay,
                conversationLayerDetent: .sheet,
                regularFloatingConversationPresentation: .closed
            ),
            "compact overlay 展开后不能保留第二个胶囊入口"
        )
    }

    func testOverlayDetentsStayWorkbenchAndConversationIntentEntersIndependentFullSurface() {
        let coordinator = TaskSurfaceCoordinator(persistenceKey: key)
        coordinator.updateLayoutContext(isCompactLayout: true)
        coordinator.presentWorkbench(isRegularSplitCapable: false)
        coordinator.moveConversationLayer(to: .sheet)

        XCTAssertEqual(
            coordinator.compactPickerSurface,
            .workbench,
            "半屏 overlay 仍属于工作台现场"
        )

        coordinator.moveConversationLayer(to: .expanded)
        XCTAssertEqual(
            coordinator.compactPickerSurface,
            .workbench,
            "更长的 overlay card 仍属于工作台，不得伪装成全屏对话"
        )

        coordinator.selectCompactSurface(.conversation)

        XCTAssertEqual(coordinator.conversationLayerDetent, .collapsed)
        XCTAssertEqual(coordinator.compactSurface, .conversation)
        XCTAssertEqual(coordinator.compactPickerSurface, .conversation)
        XCTAssertFalse(
            coordinator.isConversationLayerActive,
            "全屏对话是独立工作面，不得继续由 overlay host 承载"
        )
    }

    func testLayerGestureCanRevealSheetThenExpandCardWithoutChangingPickerSurface() {
        let coordinator = TaskSurfaceCoordinator(persistenceKey: key)
        coordinator.updateLayoutContext(isCompactLayout: true)
        coordinator.presentWorkbench(isRegularSplitCapable: false)

        coordinator.dragConversationLayer(by: -800, viewportHeight: 800)
        XCTAssertEqual(
            coordinator.settleConversationLayer(velocityPointsPerSecond: -2_000),
            .sheet,
            "从收起态上滑最多只能展开半屏"
        )

        coordinator.dragConversationLayer(by: -800, viewportHeight: 800)
        XCTAssertEqual(
            coordinator.settleConversationLayer(velocityPointsPerSecond: -2_000),
            .expanded,
            "从 SHEET 继续上滑应把同一张 overlay card 拉到 EXPANDED"
        )
        XCTAssertEqual(coordinator.compactPickerSurface, .workbench)
        coordinator.dragConversationLayer(by: 16, viewportHeight: 800)
        XCTAssertEqual(
            coordinator.settleConversationLayer(velocityPointsPerSecond: 0),
            .expanded,
            "EXPANDED 小幅拖放应吸回 overlay 的 expanded detent"
        )
    }

    func testFullConversationAndWorkbenchOverlayUseSeparatePresentationStructures() throws {
        let conversationSource = try sourceText(
            "Tabtin/Features/Conversation/ConversationScreen.swift"
        )
        let compactLayoutSection = try section(
            in: conversationSource,
            from: "private var compactLayout",
            through: "/// 三态："
        )
        XCTAssertTrue(
            compactLayoutSection.contains("coordinator.compactSurface == .conversation")
                && compactLayoutSection.contains("conversation")
                && compactLayoutSection.contains("CompactConversationOverlayHost"),
            "全屏对话必须直出 content；工作台 overlay 必须走另一条结构"
        )
        XCTAssertTrue(
            compactLayoutSection.contains("if hostsConversationContent"),
            "原生 App sheet 活跃时根层 direct 与 overlay 都必须卸载，避免双会话子树"
        )

        let regularLayoutSection = try section(
            in: conversationSource,
            from: "private func regularLayout",
            through: "private var regularFloatingConversationPlacement"
        )
        XCTAssertTrue(
            regularLayoutSection.contains("if hostsConversationContent")
                && regularLayoutSection.contains("RegularConversationFloatingWindow("),
            "regular App 嵌入 pane 后继续由根工作面承载统一 420×560 浮窗"
        )

        XCTAssertTrue(
            conversationSource.contains(
                "hostsConversationContent: workbenchNavigationState.presentedPage == nil"
            ),
            "compact App sheet 活跃时仍须卸载根会话树；regular embedded 状态不会触发该 gate"
        )

        let layerSection = try section(
            in: conversationSource,
            from: "struct CompactConversationOverlayHost",
            through: "/// iPad 三态切换器"
        )
        XCTAssertTrue(
            layerSection.contains(".clipShape("),
            "背景形状本身有圆角不够；对话内容也必须裁进同一张卡片"
        )
        XCTAssertTrue(
            layerSection.contains("return VStack(spacing: 0)")
                && layerSection.contains("Self.chromeHeight"),
            "抓手必须位于卡片内独立的 44pt chrome，不能覆盖消息内容"
        )
        XCTAssertTrue(
            layerSection.contains(".shadow("),
            "半屏卡片需要明确的层级阴影"
        )
        XCTAssertTrue(
            layerSection.contains("conversationLayerCloseButton")
                && layerSection.contains("moveLayer(to: .collapsed)"),
            "工作台 AI 对话层右上角必须有可直接关闭的按钮"
        )
        XCTAssertFalse(
            layerSection.contains("conversationLayerDetent == .full")
                || layerSection.contains("cornerRadius = CGFloat.zero"),
            "overlay 的 EXPANDED 仍必须是带抓手与顶部圆角的卡片，不能冒充全屏"
        )

        let workbenchSource = try sourceText(
            "Tabtin/Features/Workbench/WorkbenchSheet.swift"
        )
        let presentedPageSection = try section(
            in: workbenchSource,
            from: "private struct WorkbenchPresentedPageSheet",
            through: "private extension View"
        )
        XCTAssertTrue(
            presentedPageSection.localizedCaseInsensitiveContains("conversationLayer"),
            "compact App sheet 是独立 hosting controller；对话 overlay 必须在 sheet 内重新挂载"
        )
        XCTAssertFalse(
            presentedPageSection.contains("CompactTaskSurfacePicker"),
            "App sheet 已可用胶囊和抓手唤起对话，不得再用分段器遮挡 App 内容"
        )
        XCTAssertFalse(
            presentedPageSection.contains(".fullScreenCover(")
                || presentedPageSection.contains("presentsFullConversation"),
            "App sheet 内不提供第二套工作面切换，避免额外 presentation 与状态分叉"
        )
        XCTAssertTrue(
            presentedPageSection.contains("WorkbenchPresentedPageSheetPolicy.disablesInteractiveDismiss"),
            "App sheet 必须按对话层档位决定是否禁用系统 dismiss"
        )
        XCTAssertTrue(
            presentedPageSection.contains("hidesCapsule:"),
            "对话层展开后必须隐藏 sheet 顶层胶囊，避免双重拖拽入口"
        )
        let capsuleReturnSection = try section(
            in: conversationSource,
            from: "private func handleCapsuleReturnToConversation()",
            through: "private func resolveCapsuleFocusMessageId"
        )
        XCTAssertFalse(
            capsuleReturnSection.contains("dismissPresentedPage"),
            "胶囊打开浮窗不能清理当前 App 导航"
        )
        XCTAssertTrue(
            capsuleReturnSection.contains("taskSurfaceCoordinator.viewMode == .appFocus")
                && capsuleReturnSection.contains("openRegularFloatingConversation()"),
            "iPad App Focus 胶囊必须在当前 pane 上打开根 420×560 浮窗"
        )
    }

    func testSessionShareV2RoutesBeforeUnsupportedCardFallback() throws {
        let source = try sourceText(
            "Tabtin/Features/TabChat/IMConversationScreen.swift"
        )
        let bubbleSection = try section(
            in: source,
            from: "private func bubbleContent",
            through: "private func messageFooter"
        )

        let v2Route = try XCTUnwrap(
            bubbleSection.range(of: "else if let card = message.sessionShareV2Card")
        )
        let fallback = try XCTUnwrap(
            bubbleSection.range(of: "} else if message.hasStructuredCard {")
        )
        XCTAssertLessThan(v2Route.lowerBound, fallback.lowerBound)
        XCTAssertTrue(bubbleSection.contains("IMSessionShareV2CardBubble"))

        let previewSection = try section(
            in: source,
            from: "var previewTextForConversationList",
            through: "private extension Error"
        )
        let v2Preview = try XCTUnwrap(
            previewSection.range(of: "if sessionShareV2Card != nil { return \"协作邀请\" }")
        )
        let rawContentPreview = try XCTUnwrap(
            previewSection.range(of: "if !content.trimmingCharacters")
        )
        XCTAssertLessThan(v2Preview.lowerBound, rawContentPreview.lowerBound)
    }

    func testStructuredCardBubblesDoNotReserveMessageRowInsets() throws {
        let source = try sourceText(
            "Tabtin/Features/TabChat/IMResourceCardView.swift"
        )

        XCTAssertNil(
            source.range(
                of: #"if\s+!?isMine\s*\{\s*Spacer\(minLength:"#,
                options: .regularExpression
            ),
            "结构化卡片已由消息行负责头像与屏幕边距，不能再重复预留对侧空间"
        )
    }

    func testIMMessageMenuKeepsSelfHostedHandoffAndOmitsRemovedSelectionActions() throws {
        let source = try sourceText(
            "Tabtin/Features/TabChat/IMConversationScreen.swift"
        )
        let menuSection = try section(
            in: source,
            from: "private func messageMenu",
            through: "private var emptyOrError"
        )

        XCTAssertTrue(menuSection.contains("整理为交接"))
        XCTAssertFalse(menuSection.contains("多选"))
        XCTAssertTrue(source.contains("@State private var handoffSourceMessage"))
        XCTAssertTrue(source.contains(".sheet(item: $handoffSourceMessage)"))
        XCTAssertFalse(source.contains("@State private var isSelectingMessages"))
        XCTAssertFalse(source.contains("@State private var selectedMessageIds"))
    }

    func testIMCloudResourcePickerUsesFullWidthAccessibleRows() throws {
        let source = try sourceText(
            "Tabtin/Features/TabChat/IMConversationScreen.swift"
        )
        let pickerSection = try section(
            in: source,
            from: "private struct IMResourceCardPickerSheet",
            through: "private struct IMSessionSharePickerSheet"
        )

        XCTAssertTrue(
            pickerSection.contains(".frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)"),
            "云文件行必须扩展到列表整行，并保留至少 44pt 的点击高度"
        )
        XCTAssertTrue(pickerSection.contains(".contentShape(Rectangle())"))
        XCTAssertTrue(pickerSection.contains(".accessibilityLabel(\"选择云文件："))
        XCTAssertTrue(pickerSection.contains(".accessibilityHint(\"添加到待发送消息\")"))
    }

    func testFailedPendingMessageShowsSafeRetryFeedback() throws {
        let source = try sourceText(
            "Tabtin/Features/TabChat/IMConversationScreen.swift"
        )
        let pendingBubbleSection = try section(
            in: source,
            from: "private struct IMPendingMessageBubble: View",
            through: "private struct IMReplyPreviewBubble: View"
        )

        XCTAssertTrue(
            pendingBubbleSection.contains(
                "Label(\"发送失败，点击重试\", systemImage: \"exclamationmark.circle\")"
            ),
            "断网发送失败后必须显示可理解、可操作的重试提示"
        )
        XCTAssertTrue(
            pendingBubbleSection.contains("Button(action: { onRetry?() })"),
            "失败提示必须保留原有幂等重试动作"
        )
        XCTAssertFalse(
            pendingBubbleSection.contains("pending.errorMessage"),
            "失败提示不得把网络或 IM 底层错误直接暴露给用户"
        )
    }

    private func makeApp() -> TaskWorkbenchApp {
        TaskWorkbenchApp(
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
    }

    private func sourceText(_ relativePath: String) throws -> String {
        let iosRoot = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        return try String(
            contentsOf: iosRoot.appendingPathComponent(relativePath),
            encoding: .utf8
        )
    }

    private func section(
        in source: String,
        from startMarker: String,
        through endMarker: String
    ) throws -> String {
        let start = try XCTUnwrap(
            source.range(of: startMarker),
            "找不到源码区段起点：\(startMarker)"
        )
        let tail = source[start.lowerBound...]
        let end = try XCTUnwrap(
            tail.range(of: endMarker),
            "找不到源码区段终点：\(endMarker)"
        )
        return String(tail[..<end.lowerBound])
    }
}
