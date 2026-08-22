import SwiftUI
import UIKit
import WebKit

/// 工作台 Sheet 的兼容入口。具体内容与导航由 WorkbenchContainerView 承载，
/// 后续可将同一容器直接嵌入对话工作面。
struct WorkbenchSheet: View {
    @State private var vm: WorkbenchViewModel
    @State private var navigationState = WorkbenchNavigationState()

    private let organizationId: String
    private let initialOpenRequest: SpaceResourceOpenRequest?
    private let onClose: () -> Void

    init(
        organizationId: String,
        spaceId: String?,
        initialOpenRequest: SpaceResourceOpenRequest? = nil,
        onClose: @escaping () -> Void
    ) {
        self.organizationId = organizationId
        self.initialOpenRequest = initialOpenRequest
        self.onClose = onClose
        _vm = State(initialValue: WorkbenchViewModel(spaceId: spaceId))
    }

    var body: some View {
        WorkbenchContainerView(
            organizationId: organizationId,
            initialOpenRequest: initialOpenRequest,
            presentation: .sheet(onClose: onClose),
            viewModel: vm,
            navigationState: navigationState
        )
    }
}

/// 工作台内部的导航状态独立于展示形态：Sheet 与对话分屏共享同一套资源打开行为。
@MainActor @Observable
final class WorkbenchNavigationState {
    enum PresentedPage: Identifiable, Equatable {
        case appHome(TaskWorkbenchApp)
        case resource(
            route: SpaceAppRoute,
            locationHint: String?,
            resourceScope: WorkbenchResourceRouteScope?
        )

        var id: String {
            switch self {
            case let .appHome(app):
                return "app:\(app.id)"
            case let .resource(route, locationHint, resourceScope):
                let scopeID = resourceScope.map {
                    "\($0.organizationId):\($0.spaceId ?? "organization")"
                } ?? "default"
                return "resource:\(route.presentedPageID):\(locationHint ?? ""):\(scopeID)"
            }
        }

        var focusTab: FocusTab? {
            switch self {
            case let .appHome(app):
                return FocusTab.from(appHome: app)
            case let .resource(route, _, _):
                return FocusTab.from(route: route)
            }
        }
    }

    var path: [SpaceAppRoute] = []
    /// 当前停在哪个 App 的首页。资源详情仍走 `path`，所以从详情返回会落回首页而不是工作台。
    /// 只有对话工作面（`.taskPane`）有 App 卡片，Sheet 形态不会置位。
    private(set) var appHome: TaskWorkbenchApp?
    private(set) var openNotice: String?
    private(set) var routeLocationHints: [SpaceAppRoute: String] = [:]
    private(set) var routeResourceScopes: [SpaceAppRoute: WorkbenchResourceRouteScope] = [:]
    /// 会话内工作台保持底层列表挂载，详情以 present 显示；独立工作台 Sheet 仍使用 push。
    private(set) var presentedPage: PresentedPage?
    /// 顶层 sheet 内的真实焦点；资源 push / 继续预览会覆盖 PresentedPage 的初始焦点。
    private(set) var presentedFocusTab: FocusTab?
    /// NativeFocus bridge 回写：resourceId → viewId（与 FocusTab 解耦，避免 syncPresentedFocus 重建时丢视图）。
    private(set) var resourceViewIds: [String: String] = [:]

    private var lastAutomaticRequest: SpaceResourceOpenRequest?
    private var boundOrganizationId: String?
    private var boundSpaceId: String?
    private var hasBoundScope = false
    private var presentsPagesModally = false

    func prepare(for spaceId: String?) {
        prepare(for: nil, spaceId: spaceId, presentsPagesModally: false)
    }

    func prepare(
        for organizationId: String?,
        spaceId: String?,
        presentsPagesModally: Bool = false
    ) {
        // 展示策略跟随当前布局桶：compact 使用系统 sheet，regular 留在 pane 内。
        // 不能用 sticky OR，否则窗口从 compact 回到 regular 后会永久粘在 modal。
        let resolvedModal = presentsPagesModally
        let presentationChanged = self.presentsPagesModally != resolvedModal
        self.presentsPagesModally = resolvedModal
        guard !hasBoundScope
                || boundOrganizationId != organizationId
                || boundSpaceId != spaceId
        else {
            if presentationChanged {
                promotePendingNavigationToPresentationIfNeeded()
            }
            return
        }
        hasBoundScope = true
        boundOrganizationId = organizationId
        boundSpaceId = spaceId
        resetForScopeChange()
    }

    func resetForScopeChange() {
        path = []
        appHome = nil
        openNotice = nil
        routeLocationHints = [:]
        routeResourceScopes = [:]
        presentedPage = nil
        presentedFocusTab = nil
        resourceViewIds = [:]
        lastAutomaticRequest = nil
    }

    func show(
        _ route: SpaceAppRoute,
        locationHint: String? = nil,
        resourceScope: WorkbenchResourceRouteScope? = nil
    ) {
        openNotice = nil
        let normalizedHint = locationHint.flatMap { $0.isEmpty ? nil : $0 }
        if let normalizedHint {
            routeLocationHints[route] = normalizedHint
        } else {
            routeLocationHints.removeValue(forKey: route)
        }
        if let resourceScope {
            routeResourceScopes[route] = resourceScope
        } else {
            routeResourceScopes.removeValue(forKey: route)
        }
        if presentsPagesModally {
            path = []
            appHome = nil
            presentedPage = .resource(
                route: route,
                locationHint: normalizedHint,
                resourceScope: resourceScope
            )
            presentedFocusTab = presentedPage?.focusTab
        } else {
            path = [route]
        }
    }

    func showAppHome(_ app: TaskWorkbenchApp) {
        openNotice = nil
        if presentsPagesModally {
            path = []
            appHome = nil
            presentedPage = .appHome(app)
            presentedFocusTab = presentedPage?.focusTab
        } else {
            path = []
            appHome = app
        }
    }

    func closeAppHome() {
        if presentsPagesModally {
            presentedPage = nil
            presentedFocusTab = nil
            return
        }
        appHome = nil
    }

    func closeResource() {
        if presentsPagesModally {
            presentedPage = nil
            presentedFocusTab = nil
            return
        }
        path = []
    }

    func dismissPresentedPage() {
        presentedPage = nil
        presentedFocusTab = nil
    }

    /// 通知等外部入口会在工作台视图挂载前先调用 `open`。若当前 scope 已绑定，
    /// 将那段旧的 push 状态升级为弹层，避免在会话工作面短暂重绘详情。
    private func promotePendingNavigationToPresentationIfNeeded() {
        guard presentsPagesModally, presentedPage == nil else { return }
        if let appHome {
            self.appHome = nil
            presentedPage = .appHome(appHome)
            presentedFocusTab = presentedPage?.focusTab
            return
        }
        guard let route = path.last else { return }
        path = []
        presentedPage = .resource(
            route: route,
            locationHint: routeLocationHints[route],
            resourceScope: routeResourceScopes[route]
        )
        presentedFocusTab = presentedPage?.focusTab
    }

    func showNotice(_ message: String) {
        path = []
        presentedPage = nil
        presentedFocusTab = nil
        openNotice = message
    }

    func open(
        _ request: SpaceResourceOpenRequest,
        resources: [SpaceResource],
        resourceScope: WorkbenchResourceRouteScope? = nil
    ) {
        openNotice = nil
        if let route = request.route(in: resources) {
            let hint = request.locationHint.flatMap { $0.isEmpty ? nil : $0 }
            show(route, locationHint: hint, resourceScope: resourceScope)
            return
        }
        path = []
        presentedPage = nil
        presentedFocusTab = nil
        openNotice = request.unsupportedOpenNotice
    }

    func openAutomaticallyIfNeeded(
        _ request: SpaceResourceOpenRequest?,
        resources: [SpaceResource]
    ) {
        guard let request, request != lastAutomaticRequest else { return }
        lastAutomaticRequest = request
        open(request, resources: resources)
    }

    func locationHint(for route: SpaceAppRoute) -> String? {
        routeLocationHints[route]
    }

    func resourceScope(for route: SpaceAppRoute) -> WorkbenchResourceRouteScope? {
        routeResourceScopes[route]
    }

    func updatePresentedFocus(_ focusTab: FocusTab?) {
        guard presentedPage != nil else { return }
        presentedFocusTab = focusTab ?? presentedPage?.focusTab
    }

    /// Web `TabTinNativeFocus` 上报：按 resourceId 记住当前视图，供 FocusSnapshot 投影。
    func updateResourceViewFocus(appType: String, resourceId: String, viewId: String?) {
        let trimmedApp = appType.trimmingCharacters(in: .whitespacesAndNewlines)
        let trimmedResource = resourceId.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedResource.isEmpty else { return }
        // 当前协议只消费 tabdata；其它类型忽略以免污染旁路表。
        guard trimmedApp.isEmpty || trimmedApp == "tabdata" else { return }

        if let viewId {
            let trimmedView = viewId.trimmingCharacters(in: .whitespacesAndNewlines)
            if trimmedView.isEmpty {
                resourceViewIds.removeValue(forKey: trimmedResource)
            } else {
                resourceViewIds[trimmedResource] = String(trimmedView.prefix(FocusSnapshot.maxStringLength))
            }
        } else {
            resourceViewIds.removeValue(forKey: trimmedResource)
        }
    }

    func viewId(forResourceId resourceId: String?) -> String? {
        guard let resourceId else { return nil }
        let trimmed = resourceId.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        return resourceViewIds[trimmed]
    }

    func applyNativeFocusReport(_ report: NativeWorkbenchFocusReport) {
        updateResourceViewFocus(
            appType: report.appType,
            resourceId: report.resourceId,
            viewId: report.viewId
        )
    }
}

/// WKWebView NativeFocus bridge 上报载荷。
struct NativeWorkbenchFocusReport: Equatable, Sendable {
    let appType: String
    let resourceId: String
    let viewId: String?

    static func parse(_ body: Any) -> NativeWorkbenchFocusReport? {
        guard let dict = body as? [String: Any] else { return nil }
        let appType = (dict["appType"] as? String)?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let resourceId = (dict["resourceId"] as? String)?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard !resourceId.isEmpty else { return nil }

        let viewId: String?
        if dict["viewId"] is NSNull || dict["viewId"] == nil {
            viewId = nil
        } else if let raw = dict["viewId"] as? String {
            let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
            viewId = trimmed.isEmpty ? nil : trimmed
        } else {
            viewId = nil
        }

        return NativeWorkbenchFocusReport(
            appType: appType.isEmpty ? "tabdata" : appType,
            resourceId: resourceId,
            viewId: viewId
        )
    }
}

/// 从组织资源库打开资源时保留它真实的 Organization / Workspace 宿主。
/// `spaceId == nil` 是有效的 Organization-only 资源，不能回退成当前任务 Workspace。
struct WorkbenchResourceRouteScope: Hashable, Sendable {
    let organizationId: String
    let spaceId: String?
}

/// 同一工作台容器可运行在独立 Sheet 或对话工作面中；两种形态只替换退出动作，
/// 资源列表、加载状态、内部导航与打开资源逻辑保持一致。
struct WorkbenchContainerView: View {
    enum Presentation {
        case sheet(onClose: () -> Void)
        case taskPane
    }

    let organizationId: String
    let initialOpenRequest: SpaceResourceOpenRequest?
    let presentation: Presentation
    let viewModel: WorkbenchViewModel
    let navigationState: WorkbenchNavigationState
    /// 仅会话 task pane 注入：原生 App sheet 在自己的 hosting controller 内承载同一对话层。
    let conversationLayerContent: (() -> AnyView)?
    /// 工作台实际布局桶；compact 使用系统 sheet，iPad regular 留在 Workbench pane。
    let presentedPageIsCompactLayout: Bool
    /// regular App/detail sheet 的顶层 portal。构建器只负责浮窗本体，外围必须保持
    /// hit-transparent，避免阻断原生 App；根层是否挂载由调用方按 presentedPage 互斥。
    let regularConversationFloatingHost: ((AnyView) -> AnyView)?
    let taskSnapshot: TaskWorkbenchSnapshot?
    let onOpenCheckpoint: (TaskWorkbenchCheckpoint) -> Void
    let onRequestApp: (TaskWorkbenchApp) -> Void
    let onReturnToConversation: () -> Void
    /// 仅 taskPane 注入：把资源发到当前对话 composer。Sheet / 深链为空。
    let onSendToConversation: ((MentionContextRef) -> Void)?
    /// 以 present 打开的 App 首页在返回时关闭弹层；普通工作台仍回到工作台首页。
    let onCloseAppHome: (() -> Void)?
    /// 以 present 打开的 App 首页使用，避免首次短暂展示工作台首页。
    let initialAppHome: TaskWorkbenchApp?
    /// App 首页内继续打开资源时也用下一层 present，而非重新走 push 返回箭头。
    let presentsNestedPagesModally: Bool
    /// modal 宿主回写 sheet 内的真实资源焦点，供顶层对话胶囊冻结上下文。
    let onPresentedFocusChange: ((FocusTab?) -> Void)?
    /// App 首页 sheet 用本地 navigationState；viewId 需回写宿主，Conversation 才能投影。
    let onNativeFocusReport: ((NativeWorkbenchFocusReport) -> Void)?

    /// 挂在容器上，详情压栈时首页筛选 / 搜索 / 草稿不丢。
    @State private var memoAppHomeViewModel: MemoAppHomeViewModel?
    @State private var cloudDriveAppHomeViewModel: CloudDriveViewModel?
    @State private var taskResourceLibraryViewModel: TaskResourceLibraryViewModel?

    init(
        organizationId: String,
        initialOpenRequest: SpaceResourceOpenRequest?,
        presentation: Presentation,
        viewModel: WorkbenchViewModel,
        navigationState: WorkbenchNavigationState,
        conversationLayerContent: (() -> AnyView)? = nil,
        presentedPageIsCompactLayout: Bool = true,
        regularConversationFloatingHost: ((AnyView) -> AnyView)? = nil,
        taskSnapshot: TaskWorkbenchSnapshot? = nil,
        onOpenCheckpoint: @escaping (TaskWorkbenchCheckpoint) -> Void = { _ in },
        onRequestApp: @escaping (TaskWorkbenchApp) -> Void = { _ in },
        onReturnToConversation: @escaping () -> Void = {},
        onSendToConversation: ((MentionContextRef) -> Void)? = nil,
        onCloseAppHome: (() -> Void)? = nil,
        initialAppHome: TaskWorkbenchApp? = nil,
        presentsNestedPagesModally: Bool = false,
        onPresentedFocusChange: ((FocusTab?) -> Void)? = nil,
        onNativeFocusReport: ((NativeWorkbenchFocusReport) -> Void)? = nil
    ) {
        self.organizationId = organizationId
        self.initialOpenRequest = initialOpenRequest
        self.presentation = presentation
        self.viewModel = viewModel
        self.navigationState = navigationState
        self.conversationLayerContent = conversationLayerContent
        self.presentedPageIsCompactLayout = presentedPageIsCompactLayout
        self.regularConversationFloatingHost = regularConversationFloatingHost
        self.taskSnapshot = taskSnapshot
        self.onOpenCheckpoint = onOpenCheckpoint
        self.onRequestApp = onRequestApp
        self.onReturnToConversation = onReturnToConversation
        self.onSendToConversation = onSendToConversation
        self.onCloseAppHome = onCloseAppHome
        self.initialAppHome = initialAppHome
        self.presentsNestedPagesModally = presentsNestedPagesModally
        self.onPresentedFocusChange = onPresentedFocusChange
        self.onNativeFocusReport = onNativeFocusReport
    }

    var body: some View {
        Group {
            switch presentation {
            case .sheet:
                sheetNavigation
            case .taskPane:
                embeddedTaskPane
                    // 单一宿主：圆圈 ↔ 完整胶囊连续承载，避免 inset/overlay 双实例对切。
                    // 落点由 CapsulePositionedHost（side+yRatio）；轻点回对话经 controller.onTap。
                    .overlay {
                        // 系统 sheet 是独立展示层，底层 capsule 无法靠 zIndex 压过它。
                        // presentedPage 活跃时由 sheet 根视图接管宿主，避免双实例同时上报几何帧。
                        if navigationState.presentedPage == nil {
                            AgentStatusCapsuleHost()
                        }
                    }
                    .overlay(alignment: .top) {
                        if navigationState.presentedPage == nil {
                            CapsuleVoiceDispatchNotice()
                                .padding(.horizontal, TTSpacing.md)
                                .padding(.top, TTSpacing.md)
                        }
                    }
            }
        }
        .sheet(item: compactPresentedPageBinding) { page in
            presentedPageHost(page)
        }
        .task(id: "\(organizationId)|\(viewModel.spaceId ?? "")|\(shouldPresentPagesModally)") {
            navigationState.prepare(
                for: organizationId,
                spaceId: viewModel.spaceId,
                presentsPagesModally: shouldPresentPagesModally
            )
            await viewModel.load(
                organizationId: taskSnapshot == nil ? nil : organizationId
            )
            // 弹层 App 首页已由 `sheetRootContent` 直接承载。若这里再写入
            // `presentedPage`，会把 App 首页递归 present 出自身，连带重复 load。
            if let initialAppHome, !presentsNestedPagesModally {
                navigationState.showAppHome(initialAppHome)
            }
            navigationState.openAutomaticallyIfNeeded(
                initialOpenRequest,
                resources: viewModel.resources
            )
        }
        .onChange(of: initialOpenRequest) {
            navigationState.openAutomaticallyIfNeeded(
                initialOpenRequest,
                resources: viewModel.resources
            )
        }
    }

    private var isTaskWorkbenchPane: Bool {
        if case .taskPane = presentation { return true }
        return false
    }

    private var shouldPresentPagesModally: Bool {
        presentsNestedPagesModally
            || (isTaskWorkbenchPane && presentedPageIsCompactLayout)
    }

    private var compactPresentedPageBinding: Binding<WorkbenchNavigationState.PresentedPage?> {
        Binding(
            get: { navigationState.presentedPage },
            set: { page in
                if page == nil { navigationState.dismissPresentedPage() }
            }
        )
    }

    private func presentedPageHost(
        _ page: WorkbenchNavigationState.PresentedPage
    ) -> some View {
        WorkbenchPresentedPageSheet(
            page: page,
            organizationId: organizationId,
            spaceId: viewModel.spaceId,
            viewModel: viewModel,
            taskSnapshot: taskSnapshot,
            onOpenCheckpoint: onOpenCheckpoint,
            onRequestApp: onRequestApp,
            hostNavigationState: navigationState,
            conversationLayerContent: conversationLayerContent,
            regularConversationFloatingHost: regularConversationFloatingHost
        )
    }

    private var sheetNavigation: some View {
        NavigationStack(path: Binding(
            get: { navigationState.path },
            set: { navigationState.path = $0 }
        )) {
            sheetRootContent
                .background(.tt.bgCanvasDefault)
                .navigationDestination(for: SpaceAppRoute.self) { route in
                    destination(route)
                        .toolbar(.visible, for: .navigationBar)
                }
                .modifier(WorkbenchRootChrome(
                    presentation: presentation,
                    isAppHomePresentation: initialAppHome != nil
                ))
        }
    }

    @ViewBuilder
    private var sheetRootContent: some View {
        // 从会话工作台弹出的 App 首页要第一帧就是目标页，不能先闪过工作台首页。
        if let app = navigationState.appHome ?? initialAppHome {
            appHomePane(app)
        } else {
            content
        }
    }

    @ViewBuilder
    private var embeddedTaskPane: some View {
        // 独立工作台会在此保留 App 首页并压栈资源详情；会话工作台则由
        // `presentedPage` 承载详情，底下的工作台始终保持挂载。
        if let memoApp = navigationState.appHome,
           TaskWorkbenchAppVisibility.normalized(memoApp.id) == "tabmemo" {
            ZStack {
                memoAppHomePane(memoApp)
                    .opacity(navigationState.path.isEmpty ? 1 : 0)
                    .allowsHitTesting(navigationState.path.isEmpty)
                    .accessibilityHidden(!navigationState.path.isEmpty)

                if let route = navigationState.path.last {
                    VStack(spacing: 0) {
                        paneHeader(
                            title: routeTitle(route),
                            backLabel: "返回\(memoApp.name)",
                            onBack: { navigationState.closeResource() }
                        )

                        destination(route)
                            .id(route)
                            .frame(maxWidth: .infinity, maxHeight: .infinity)
                    }
                    .background(.tt.bgCanvasDefault)
                }
            }
        } else if let route = navigationState.path.last {
            VStack(spacing: 0) {
                paneHeader(
                    title: routeTitle(route),
                    backLabel: navigationState.appHome.map { "返回\($0.name)" } ?? "返回工作台",
                    onBack: { navigationState.closeResource() }
                )

                destination(route)
                    .id(route)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
            .background(.tt.bgCanvasDefault)
        } else if let app = navigationState.appHome {
            appHomePane(app)
        } else {
            if let taskSnapshot {
                TaskWorkbenchDashboardView(
                    snapshot: taskSnapshot,
                    organizationId: organizationId,
                    isResourceLoading: viewModel.isLoading,
                    resourceErrorMessage: viewModel.errorMessage,
                    apps: viewModel.apps,
                    isAppCatalogLoading: viewModel.isAppCatalogLoading,
                    appCatalogErrorMessage: viewModel.appCatalogErrorMessage,
                    appAvailabilityErrorMessage: viewModel.appAvailabilityErrorMessage,
                    openNotice: navigationState.openNotice,
                    onOpenOutput: { output in
                        guard output.canOpen else { return }
                        if SpaceResource.normalizedType(output.resourceType) == "tabfiles",
                           TaskWorkbenchConversationArtifactPolicy.isOpenableFileRecord(output.resourceId) {
                            navigationState.show(
                                .tabfiles(context: CloudFileDetailContext(
                                    contextItemId: output.resource?.id ?? "",
                                    fileRecordId: output.resourceId,
                                    organizationId: organizationId,
                                    title: output.title
                                )),
                                locationHint: output.openRequest.locationHint
                            )
                            return
                        }
                        navigationState.open(
                            output.openRequest,
                            resources: viewModel.resources
                        )
                    },
                    onRetryResources: {
                        Task { await viewModel.load(organizationId: organizationId) }
                    },
                    onOpenCheckpoint: onOpenCheckpoint,
                    onRequestApp: onRequestApp,
                    onActivateApp: activateApp,
                    onRetryApps: {
                        Task { await viewModel.load(organizationId: organizationId) }
                    }
                )
            } else {
                content
                    .background(.tt.bgCanvasDefault)
            }
        }
    }

    private func activateApp(_ app: TaskWorkbenchApp) {
        switch app.activation {
        case .openAppHome:
            navigationState.showAppHome(app)
        case .requestAgent:
            onRequestApp(app)
        case let .unavailable(message):
            navigationState.showNotice(message)
        }
    }

    /// App 首页：文档 / 多维表走 Task 资源投影；Memo 走 Organization 写作流；
    /// 云盘（tabfiles 卡）走 Organization CloudDrive；其它仍用 Workspace 资源列表。
    /// 打开单条资源仍旧压进 `navigationState.path`，返回即回到这里。
    @ViewBuilder
    private func appHomePane(_ app: TaskWorkbenchApp) -> some View {
        switch TaskWorkbenchAppVisibility.normalized(app.id) {
        case "tabdoc", "tabdata":
            taskResourceAppHomePane(app)
        case "tabmemo":
            memoAppHomePane(app)
        case "tabfiles":
            cloudDriveAppHomePane(app)
        default:
            legacyResourceListAppHome(app)
        }
    }

    @ViewBuilder
    private func memoAppHomePane(_ app: TaskWorkbenchApp) -> some View {
        Group {
            if let vm = memoAppHomeViewModel, vm.organizationId == organizationId {
                MemoAppHomeView(
                    viewModel: vm,
                    appName: app.name,
                    organizationName: WorkspaceStore.shared.selectedOrganization?.name,
                    onBack: {
                        memoAppHomeViewModel = nil
                        closeAppHome()
                    },
                    onClose: onCloseAppHome,
                    onOpenMemo: { memo in
                        navigationState.open(
                            SpaceResourceOpenRequest(
                                resourceType: "tabmemo",
                                resourceId: memo.id,
                                title: memo.displayText,
                                locationHint: nil
                            ),
                            resources: viewModel.resources
                        )
                    }
                )
            } else {
                ProgressView()
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .accessibilityLabel(L10n.Common.loading)
            }
        }
        .onAppear { ensureMemoAppHomeViewModel() }
        .onChange(of: organizationId) { _, newValue in
            if memoAppHomeViewModel?.organizationId != newValue {
                memoAppHomeViewModel = nil
                ensureMemoAppHomeViewModel(for: newValue)
            }
        }
    }

    /// 在 onAppear / onChange 里创建，禁止在 ViewBuilder body 里写 `@State`。
    private func ensureMemoAppHomeViewModel(for orgId: String? = nil) {
        let targetOrg = orgId ?? organizationId
        if let existing = memoAppHomeViewModel, existing.organizationId == targetOrg {
            return
        }
        memoAppHomeViewModel = MemoAppHomeViewModel(organizationId: targetOrg)
    }

    @ViewBuilder
    private func cloudDriveAppHomePane(_ app: TaskWorkbenchApp) -> some View {
        Group {
            if let vm = cloudDriveAppHomeViewModel, vm.organizationId == organizationId {
                CloudDriveAppHomeView(
                    viewModel: vm,
                    appName: app.name,
                    organizationName: WorkspaceStore.shared.selectedOrganization?.name,
                    launchContext: cloudDriveLaunchContext,
                    conversationSink: cloudDriveConversationSink,
                    onBack: {
                        cloudDriveAppHomeViewModel = nil
                        closeAppHome()
                    },
                    onClose: onCloseAppHome,
                    onOpenRoute: { route in
                        navigationState.show(route)
                    }
                )
            } else {
                ProgressView()
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .accessibilityLabel(L10n.Common.loading)
            }
        }
        .onAppear { ensureCloudDriveAppHomeViewModel() }
        .onChange(of: organizationId) { _, newValue in
            if cloudDriveAppHomeViewModel?.organizationId != newValue {
                cloudDriveAppHomeViewModel = nil
                ensureCloudDriveAppHomeViewModel(for: newValue)
            }
        }
    }

    private func ensureCloudDriveAppHomeViewModel(for orgId: String? = nil) {
        let targetOrg = orgId ?? organizationId
        if let existing = cloudDriveAppHomeViewModel, existing.organizationId == targetOrg {
            return
        }
        cloudDriveAppHomeViewModel = CloudDriveViewModel(organizationId: targetOrg)
    }

    private func closeAppHome() {
        if let onCloseAppHome {
            onCloseAppHome()
        } else {
            navigationState.closeAppHome()
        }
    }

    private var cloudDriveLaunchContext: AppHomeLaunchContext {
        let source: AppHomeLaunchContext.Source
        switch presentation {
        case .taskPane:
            source = .taskWorkbench
        case .sheet:
            source = .sheet
        }
        return AppHomeLaunchContext(organizationId: organizationId, source: source)
    }

    private var cloudDriveConversationSink: CloudDriveConversationSink? {
        guard case .taskPane = presentation, let onSendToConversation else { return nil }
        return CloudDriveConversationSink(send: onSendToConversation)
    }

    private func taskResourceAppHomePane(_ app: TaskWorkbenchApp) -> some View {
        let kind: TaskResourceAppKind = TaskWorkbenchAppVisibility.normalized(app.id) == "tabdata"
            ? .tabdata
            : .tabdoc
        let libraryViewModel = taskResourceLibraryViewModel.flatMap { model in
            model.organizationId == organizationId && model.appKind == kind ? model : nil
        }
        // App 首页展示时 path 通常为空；若将来叠层同显，仍以当前 route 为 continue 第一优先。
        let currentlyOpen: TaskResourceIdentity? = navigationState.path.first.flatMap { route in
            switch route {
            case let .tabdoc(documentId, _):
                return TaskResourceIdentity(resourceType: "tabdoc", resourceId: documentId)
            case let .tabdata(tableId, _):
                return TaskResourceIdentity(resourceType: "tabdata", resourceId: tableId)
            default:
                return nil
            }
        }
        // 以对话即时 outputs 为准重建 pending：不依赖 VM 是否已赶上 onChange 同步。
        let pendingOverlays = TaskWorkbenchPendingOverlayBuilder.build(
            outputs: taskSnapshot?.outputs ?? [],
            confirmedResources: viewModel.taskResources
        ).map { $0.asAppHomeOverlay() }
        return TaskResourceAppHomeView(
            appKind: kind,
            resources: viewModel.taskResources.map { $0.asAppHomeResource() },
            pendingOverlays: pendingOverlays,
            libraryViewModel: libraryViewModel,
            currentlyOpen: currentlyOpen,
            isLoading: viewModel.isTaskResourcesLoading,
            isCreatingBlank: viewModel.isCreatingBlankResource,
            errorMessage: viewModel.taskResourcesErrorMessage,
            blankCreateErrorMessage: viewModel.blankCreateErrorMessage,
            organizationName: WorkspaceStore.shared.selectedOrganization?.name,
            onClose: onCloseAppHome,
            onBack: { closeAppHome() },
            onRetry: {
                Task { await refreshTaskResourceAppHome() }
            },
            onLoadLibrary: { scope, searchQuery, force in
                await refreshTaskResourceLibrary(
                    appKind: kind,
                    scope: scope,
                    searchQuery: searchQuery,
                    force: force
                )
            },
            onCreateBlank: {
                Task {
                    let launchOrganizationId = viewModel.organizationId
                    let launchSessionId = viewModel.sessionId
                    do {
                        let created = try await viewModel.createBlankTaskResource(appKind: kind)
                        guard viewModel.organizationId == launchOrganizationId,
                              viewModel.sessionId == launchSessionId
                        else { return }
                        guard created.canOpen else { return }
                        viewModel.recordTaskResourceAccess(contextItemId: created.contextItemId)
                        if let optimisticItem = TaskResourceAppHomeProjector.project(
                            appKind: kind,
                            resources: [created.asAppHomeResource()],
                            pendingOverlays: [],
                            currentlyOpen: nil,
                            searchQuery: ""
                        ).items.first {
                            taskResourceLibraryViewModel?.recordAccess(
                                item: optimisticItem,
                                reportsToServer: false
                            )
                        }
                        navigationState.open(
                            SpaceResourceOpenRequest(
                                resourceType: created.resourceType,
                                resourceId: created.resourceId,
                                title: created.title,
                                locationHint: nil
                            ),
                            resources: [],
                            resourceScope: WorkbenchResourceRouteScope(
                                organizationId: created.organizationId,
                                spaceId: created.resourceSpaceId
                            )
                        )
                        Task {
                            await refreshTaskResourceLibrary(
                                appKind: kind,
                                scope: .all,
                                searchQuery: "",
                                force: true
                            )
                        }
                    } catch is CancellationError {
                        // 用户已切换组织 / 会话；旧请求不得把错误或资源写回新页面。
                        return
                    } catch {
                        guard viewModel.organizationId == launchOrganizationId,
                              viewModel.sessionId == launchSessionId
                        else { return }
                        viewModel.blankCreateErrorMessage =
                            (error as? LocalizedError)?.errorDescription
                            ?? L10n.WorkbenchAppHome.blankCreateFailed
                    }
                }
            },
            onRequestAgent: { onRequestApp(app) },
            onOpen: { item in
                guard item.canOpen else { return }
                if item.source != .library {
                    viewModel.recordTaskResourceAccess(contextItemId: item.contextItemId)
                }
                taskResourceLibraryViewModel?.recordAccess(
                    item: item,
                    reportsToServer: item.source == .library
                )
                let resourceScope: WorkbenchResourceRouteScope? = item.organizationId.flatMap { rawOrganizationId in
                    let trimmed = rawOrganizationId.trimmingCharacters(in: .whitespacesAndNewlines)
                    guard !trimmed.isEmpty else { return nil }
                    return WorkbenchResourceRouteScope(
                        organizationId: trimmed,
                        spaceId: item.resourceSpaceId
                    )
                }
                navigationState.open(
                    SpaceResourceOpenRequest(
                        resourceType: item.resourceType,
                        resourceId: item.resourceId,
                        title: item.title,
                        locationHint: nil
                    ),
                    resources: [],
                    // pending overlay 没有宿主契约，沿用当前任务上下文；正式资源才覆盖。
                    resourceScope: resourceScope
                )
            },
            onOpenLibrary: { item in
                guard item.canOpen else { return }
                taskResourceLibraryViewModel?.recordAccess(item: item)
                navigationState.open(
                    SpaceResourceOpenRequest(
                        resourceType: item.resourceType,
                        resourceId: item.resourceId,
                        title: item.title,
                        locationHint: item.spaceName
                    ),
                    resources: [],
                    resourceScope: WorkbenchResourceRouteScope(
                        organizationId: item.organizationId ?? organizationId,
                        spaceId: item.resourceSpaceId
                    )
                )
            },
            onOpenLibraryHub: {
                openLibraryHub()
            },
            onPreviewFocusChange: { item in
                // path 优先：打开资源后 App Home onDisappear 会传 nil，不得盖回首页焦点。
                let focusTab = FocusTab.resolveAppHomePresentedFocus(
                    previewItemId: item?.resourceId,
                    previewItemTitle: item?.title,
                    resourceType: kind.resourceType,
                    path: navigationState.path,
                    appHome: app
                )
                onPresentedFocusChange?(focusTab)
            }
        )
        .task(id: "\(organizationId)|\(app.id)|\(viewModel.sessionId ?? "")") {
            await refreshTaskResourceAppHome()
        }
    }

    /// 进入文档/多维表 App 首页时强制拉服务端 + 用当前对话 outputs 对齐 pending。
    private func refreshTaskResourceAppHome() async {
        if let outputs = taskSnapshot?.outputs {
            viewModel.syncPendingOverlays(from: outputs)
        }
        await viewModel.refreshTaskResources()
        if let outputs = taskSnapshot?.outputs {
            viewModel.syncPendingOverlays(from: outputs)
        }
    }

    /// 切到全局云文档前先关闭当前展示层，否则新 Tab 会被工作台 sheet 继续遮住。
    private func openLibraryHub() {
        switch presentation {
        case .sheet(let onClose):
            onClose()
        case .taskPane:
            closeAppHome()
        }
        MainRouter.shared.selectTab(.cloudDocs)
    }

    /// “你的文档 / 你的多维表”按当前 App 类型、范围和搜索词走服务端分页。
    private func refreshTaskResourceLibrary(
        appKind: TaskResourceAppKind,
        scope: TaskResourceLibraryScope,
        searchQuery: String,
        force: Bool
    ) async {
        let model: TaskResourceLibraryViewModel
        if let current = taskResourceLibraryViewModel,
           current.organizationId == organizationId,
           current.appKind == appKind {
            model = current
        } else {
            let created = TaskResourceLibraryViewModel(
                organizationId: organizationId,
                appKind: appKind
            )
            taskResourceLibraryViewModel = created
            model = created
        }
        await model.load(scope: scope, searchQuery: searchQuery, force: force)
    }

    /// 其它 App：该 App 在当前 Workspace 的资源列表（通用 fallback）。
    private func legacyResourceListAppHome(_ app: TaskWorkbenchApp) -> some View {
        let items = viewModel.resources(ofType: app.id)
        return VStack(spacing: 0) {
            if onCloseAppHome == nil {
                paneHeader(
                    title: app.name,
                    subtitle: items.isEmpty ? nil : "\(items.count) 项",
                    backLabel: "返回工作台",
                    onBack: { closeAppHome() }
                )
            }

            if items.isEmpty {
                appHomeEmptyState(app)
            } else {
                ScrollView {
                    VStack(spacing: TTSpacing.xs) {
                        ForEach(items) { resource in
                            resourceRow(resource)
                        }
                    }
                    .padding(TTSpacing.lg)
                }
            }
        }
        .background(.tt.bgCanvasDefault)
        .appHomeSystemNavigationChrome(
            enabled: onCloseAppHome != nil,
            title: app.name,
            subtitle: WorkspaceStore.shared.selectedOrganization?.name,
            onClose: onCloseAppHome
        )
    }

    private func appHomeEmptyState(_ app: TaskWorkbenchApp) -> some View {
        VStack(spacing: TTSpacing.sm) {
            Image(systemName: app.systemImage)
                .font(.tt.iconEmptyMD)
                .symbolRenderingMode(.hierarchical)
                .foregroundStyle(.tt.iconAccent.opacity(0.6))
            Text("这个任务还没有 \(app.name) 内容")
                .font(.tt.body)
                .foregroundStyle(.tt.textPrimary)
            Text(app.canCreate
                ? "交给 Agent，它会在当前任务里新建一个。"
                : "交给 Agent，让它在当前任务里处理。")
                .font(.tt.meta)
                .foregroundStyle(.tt.textSecondary)
                .multilineTextAlignment(.center)
            Button(app.agentActionTitle) { onRequestApp(app) }
                .buttonStyle(.borderedProminent)
                .tint(.tt.bgAccent)
                .frame(minWidth: 44, minHeight: 44)
                .padding(.top, TTSpacing.xs)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding(TTSpacing.lg)
    }

    private func paneHeader(
        title: String,
        subtitle: String? = nil,
        backLabel: String,
        onBack: @escaping () -> Void
    ) -> some View {
        HStack(spacing: TTSpacing.sm) {
            Button(action: onBack) {
                Image(systemName: "chevron.left")
                    .font(.tt.iconBody)
                    .frame(width: 44, height: 44)
            }
            .buttonStyle(.plain)
            .foregroundStyle(.tt.iconAccent)
            .accessibilityLabel(backLabel)

            Text(title)
                .font(.tt.captionSemibold)
                .foregroundStyle(.tt.textPrimary)
                .lineLimit(1)

            if let subtitle {
                Text(subtitle)
                    .font(.tt.captionMedium)
                    .foregroundStyle(.tt.textTertiary)
            }

            Spacer(minLength: 0)
        }
        .padding(.horizontal, TTSpacing.sm)
        .frame(maxWidth: .infinity, minHeight: 44)
        .background(.tt.bgCanvasDefault)
        .overlay(alignment: .bottom) {
            Rectangle()
                .fill(.tt.borderLight)
                .frame(height: 0.5)
        }
    }

    @ViewBuilder
    private var content: some View {
        if viewModel.isLoading {
            WorkbenchLoadingSkeleton(style: .resourceList)
        } else if let error = viewModel.errorMessage {
            errorState(error)
        } else if viewModel.availableTypes.isEmpty {
            emptyState
        } else {
            ScrollView {
                VStack(alignment: .leading, spacing: TTSpacing.lg) {
                    if let openNotice = navigationState.openNotice {
                        resourceOpenNotice(openNotice)
                    }
                    ForEach(viewModel.availableTypes, id: \.self) { type in
                        typeSection(type)
                    }
                }
                .padding(TTSpacing.lg)
            }
        }
    }

    @ViewBuilder
    private func typeSection(_ type: String) -> some View {
        let items = viewModel.resources(ofType: type)
        if let first = items.first {
            VStack(alignment: .leading, spacing: TTSpacing.sm) {
                Label(first.typeLabel, systemImage: first.icon)
                    .font(.tt.bodySemibold)
                    .foregroundStyle(.tt.textPrimary)
                VStack(spacing: TTSpacing.xs) {
                    ForEach(items) { resource in
                        resourceRow(resource)
                    }
                }
            }
        }
    }

    @ViewBuilder
    private func resourceRow(_ resource: SpaceResource) -> some View {
        if let route = resource.appRoute {
            switch presentation {
            case .sheet:
                NavigationLink(value: route) {
                    rowLabel(resource, openable: true)
                }
                .buttonStyle(.plain)
            case .taskPane:
                Button {
                    navigationState.show(route)
                } label: {
                    rowLabel(resource, openable: true)
                }
                .buttonStyle(.plain)
            }
        } else {
            rowLabel(resource, openable: false)
        }
    }

    private func rowLabel(_ resource: SpaceResource, openable: Bool) -> some View {
        HStack(spacing: TTSpacing.sm) {
            Image(systemName: resource.icon)
                .foregroundStyle(openable ? .tt.iconAccent : .tt.textTertiary)
            VStack(alignment: .leading, spacing: 2) {
                Text(resource.displayTitle)
                    .font(.tt.captionMedium)
                    .foregroundStyle(openable ? .tt.textPrimary : .tt.textSecondary)
                    .lineLimit(1)
                if !openable {
                    Text("暂不支持在此打开")
                        .font(.tt.captionMedium)
                        .foregroundStyle(.tt.textTertiary)
                }
            }
            Spacer(minLength: 0)
            if resource.isPinned == true {
                Image(systemName: "pin.fill").font(.tt.iconCaptionMedium).foregroundStyle(.tt.textTertiary)
            }
            if openable {
                Image(systemName: "chevron.right").font(.tt.iconCaptionMedium).foregroundStyle(.tt.textTertiary)
            }
        }
        .padding(TTSpacing.sm)
        .frame(maxWidth: .infinity)
        .background(.tt.bgSubtle, in: RoundedRectangle(cornerRadius: TTRadius.sm))
    }

    @ViewBuilder
    private func destination(_ route: SpaceAppRoute) -> some View {
        switch route {
        case let .tabmemo(memoId, memoName, spaceName):
            // 详情 trash/archive/pin 写回挂起的 Memo App 首页列表（与 CloudMemoScreen 同口径）。
            CloudMemoDetailScreen(
                context: CloudMemoDetailContext(
                    memoId: memoId,
                    title: memoName,
                    spaceName: spaceName ?? navigationState.locationHint(for: route)
                ),
                onStatusChanged: { id in
                    memoAppHomeViewModel?.removeMemo(id: id)
                    navigationState.closeResource()
                },
                onPinnedChanged: { id, pinned in
                    memoAppHomeViewModel?.applyPinned(id: id, pinned: pinned)
                }
            )
        default:
            if let scope = navigationState.resourceScope(for: route) {
                SpaceAppRouteScreen(
                    route: route,
                    organizationId: scope.organizationId,
                    spaceId: scope.spaceId,
                    locationHint: navigationState.locationHint(for: route),
                    onNativeFocusReport: handleNativeFocusReport
                )
            } else {
                SpaceAppRouteScreen(
                    route: route,
                    organizationId: organizationId,
                    spaceId: viewModel.spaceId,
                    locationHint: navigationState.locationHint(for: route),
                    onNativeFocusReport: handleNativeFocusReport
                )
            }
        }
    }

    private func handleNativeFocusReport(_ report: NativeWorkbenchFocusReport) {
        navigationState.applyNativeFocusReport(report)
        onNativeFocusReport?(report)
    }

    private func routeTitle(_ route: SpaceAppRoute) -> String {
        switch route {
        case let .tabdoc(_, name),
             let .tabdata(_, name),
             let .tabslide(_, name),
             let .tabmemo(_, name, _):
            return name
        case let .tabsite(_, _, name):
            return name
        case let .tabfiles(context):
            return context.displayTitle
        }
    }

    private var emptyState: some View {
        VStack(spacing: TTSpacing.sm) {
            if let openNotice = navigationState.openNotice {
                resourceOpenNotice(openNotice)
                    .padding(.bottom, TTSpacing.sm)
            }
            Image(systemName: "square.grid.2x2")
                .font(.tt.iconEmptyMD)
                .foregroundStyle(.tt.iconAccent.opacity(0.6))
            Text("这个 Space 还没有资源")
                .font(.tt.body)
                .foregroundStyle(.tt.textSecondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private func errorState(_ message: String) -> some View {
        TTErrorStateView(message: message, prominence: .inline) {
            Task { await viewModel.load() }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding(TTSpacing.lg)
    }

    private func resourceOpenNotice(_ message: String) -> some View {
        HStack(alignment: .top, spacing: TTSpacing.sm) {
            Image(systemName: "info.circle.fill")
                .font(.tt.iconBody)
                .foregroundStyle(.tt.iconAccent)
                .padding(.top, 1)
            Text(message)
                .font(.tt.meta)
                .foregroundStyle(.tt.textSecondary)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
        }
        .padding(TTSpacing.sm)
        .background(.tt.bgSubtle, in: RoundedRectangle(cornerRadius: TTRadius.sm))
        .overlay(RoundedRectangle(cornerRadius: TTRadius.sm).strokeBorder(.tt.borderLight, lineWidth: 0.5))
    }
}

/// 会话内工作台的详情承载页。父工作台不替换内容，只在其上方 present 本页。
enum WorkbenchPresentedPageConversationHostPlacement: Equatable {
    case none
    case compactOverlay
    case regularFloating
}

enum WorkbenchPresentedPageSheetPolicy {
    static func conversationHostPlacement(
        hasConversationLayer: Bool,
        hasRegularFloatingHost: Bool,
        isCompactLayout: Bool,
        compactConversationLayerIsActive: Bool
    ) -> WorkbenchPresentedPageConversationHostPlacement {
        guard hasConversationLayer else { return .none }
        if isCompactLayout {
            return compactConversationLayerIsActive ? .compactOverlay : .none
        }
        guard hasRegularFloatingHost else {
            return .none
        }
        return .regularFloating
    }

    static func hidesCapsule(
        conversationHostPlacement: WorkbenchPresentedPageConversationHostPlacement,
        conversationLayerDetent: ConversationLayerDetent,
        regularFloatingConversationPresentation: RegularFloatingConversationPresentation
    ) -> Bool {
        conversationSurfaceIsOpen(
            conversationHostPlacement: conversationHostPlacement,
            conversationLayerDetent: conversationLayerDetent,
            regularFloatingConversationPresentation: regularFloatingConversationPresentation
        )
    }

    static func disablesInteractiveDismiss(
        conversationHostPlacement: WorkbenchPresentedPageConversationHostPlacement,
        conversationLayerDetent: ConversationLayerDetent,
        regularFloatingConversationPresentation: RegularFloatingConversationPresentation
    ) -> Bool {
        conversationSurfaceIsOpen(
            conversationHostPlacement: conversationHostPlacement,
            conversationLayerDetent: conversationLayerDetent,
            regularFloatingConversationPresentation: regularFloatingConversationPresentation
        )
    }

    private static func conversationSurfaceIsOpen(
        conversationHostPlacement: WorkbenchPresentedPageConversationHostPlacement,
        conversationLayerDetent: ConversationLayerDetent,
        regularFloatingConversationPresentation: RegularFloatingConversationPresentation
    ) -> Bool {
        switch conversationHostPlacement {
        case .none:
            return false
        case .compactOverlay:
            return conversationLayerDetent != .collapsed
        case .regularFloating:
            return regularFloatingConversationPresentation == .floating
        }
    }
}

private struct WorkbenchPresentedPageSheet: View {
    let page: WorkbenchNavigationState.PresentedPage
    let organizationId: String
    let spaceId: String?
    let viewModel: WorkbenchViewModel
    let taskSnapshot: TaskWorkbenchSnapshot?
    let onOpenCheckpoint: (TaskWorkbenchCheckpoint) -> Void
    let onRequestApp: (TaskWorkbenchApp) -> Void
    let hostNavigationState: WorkbenchNavigationState
    let conversationLayerContent: (() -> AnyView)?
    let regularConversationFloatingHost: ((AnyView) -> AnyView)?

    @Environment(\.dismiss) private var dismiss
    @Environment(TaskSurfaceCoordinator.self) private var taskSurfaceCoordinator
    @State private var navigationState = WorkbenchNavigationState()
    @State private var capsuleLayerCoordinator = WorkbenchCapsuleLayerCoordinator()

    var body: some View {
        ZStack(alignment: .bottom) {
            presentedPageContent

            if conversationHostPlacement == .compactOverlay,
               let conversationLayerContent {
                CompactConversationOverlayHost(coordinator: taskSurfaceCoordinator) {
                    conversationLayerContent()
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        // regular 浮窗与 compact overlay 共用一个 placement 判定，绝不同时挂载。
        // overlay 不提供 scrim；构建器的浮窗外区域保持 hit-transparent，App 仍可操作。
        .overlay(alignment: .bottomTrailing) {
            regularFloatingConversationLayer
        }
        // 对话层展开后由卡片接管纵向手势，避免误 dismiss App；层收起时仍保留
        // 原生 sheet 的系统下滑关闭能力。
        .interactiveDismissDisabled(
            WorkbenchPresentedPageSheetPolicy.disablesInteractiveDismiss(
                conversationHostPlacement: conversationHostPlacement,
                conversationLayerDetent: taskSurfaceCoordinator.conversationLayerDetent,
                regularFloatingConversationPresentation:
                    taskSurfaceCoordinator.regularFloatingConversationPresentation
            )
        )
        // `zIndex` 不能跨系统 presentation；每个工作台 sheet 都在自己的根层交接胶囊宿主。
        .environment(\.workbenchCapsuleLayerCoordinator, capsuleLayerCoordinator)
        .workbenchCapsuleTopLayer(
            coordinator: capsuleLayerCoordinator,
            hidesCapsule: WorkbenchPresentedPageSheetPolicy.hidesCapsule(
                conversationHostPlacement: conversationHostPlacement,
                conversationLayerDetent: taskSurfaceCoordinator.conversationLayerDetent,
                regularFloatingConversationPresentation:
                    taskSurfaceCoordinator.regularFloatingConversationPresentation
            )
        )
        .onAppear { syncPresentedFocus() }
        .onChange(of: navigationState.path) { syncPresentedFocus() }
        .onChange(of: navigationState.appHome) { syncPresentedFocus() }
        .onDisappear {
            taskSurfaceCoordinator.collapseRegularPresentedPageFloatingConversation()
        }
    }

    private var conversationHostPlacement: WorkbenchPresentedPageConversationHostPlacement {
        WorkbenchPresentedPageSheetPolicy.conversationHostPlacement(
            hasConversationLayer: conversationLayerContent != nil,
            hasRegularFloatingHost: regularConversationFloatingHost != nil,
            isCompactLayout: taskSurfaceCoordinator.isCompactLayout,
            compactConversationLayerIsActive: taskSurfaceCoordinator.isConversationLayerActive
        )
    }

    @ViewBuilder
    private var regularFloatingConversationLayer: some View {
        if conversationHostPlacement == .regularFloating,
           let regularConversationFloatingHost,
           let conversationLayerContent {
            regularConversationFloatingHost(conversationLayerContent())
        }
    }

    @ViewBuilder
    private var presentedPageContent: some View {
        switch page {
        case let .resource(route, locationHint, resourceScope):
            NavigationStack {
                if let resourceScope {
                    // 显式 scope 的 `spaceId == nil` 表示 Organization-only，禁止回退任务 Workspace。
                    SpaceAppRouteScreen(
                        route: route,
                        organizationId: resourceScope.organizationId,
                        spaceId: resourceScope.spaceId,
                        locationHint: locationHint,
                        onNativeFocusReport: hostNavigationState.applyNativeFocusReport
                    )
                    .presentedResourceCloseToolbar(onClose: dismiss.callAsFunction)
                } else {
                    SpaceAppRouteScreen(
                        route: route,
                        organizationId: organizationId,
                        spaceId: spaceId,
                        locationHint: locationHint,
                        onNativeFocusReport: hostNavigationState.applyNativeFocusReport
                    )
                    .presentedResourceCloseToolbar(onClose: dismiss.callAsFunction)
                }
            }

        case let .appHome(app):
            WorkbenchContainerView(
                organizationId: organizationId,
                initialOpenRequest: nil,
                presentation: .sheet(onClose: { dismiss() }),
                viewModel: viewModel,
                navigationState: navigationState,
                taskSnapshot: taskSnapshot,
                onOpenCheckpoint: onOpenCheckpoint,
                onRequestApp: { app in
                    dismiss()
                    onRequestApp(app)
                },
                onCloseAppHome: { dismiss() },
                initialAppHome: app,
                // App 首页本身保留系统 sheet；资源详情在同一 sheet 内 push，
                // 这样胶囊宿主始终位于唯一的系统展示层之上。
                presentsNestedPagesModally: false,
                onPresentedFocusChange: hostNavigationState.updatePresentedFocus,
                onNativeFocusReport: hostNavigationState.applyNativeFocusReport
            )
        }
    }

    private func syncPresentedFocus() {
        let focusTab: FocusTab?
        switch page {
        case .resource:
            focusTab = page.focusTab
        case let .appHome(app):
            // 与 resolveAppHomePresentedFocus 同口径：sheet 内 path 上的资源 id
            // 必须盖过 App 首页壳，供宿主 Conversation 胶囊冻结。
            focusTab = FocusTab.resolveAppHomePresentedFocus(
                previewItemId: nil,
                previewItemTitle: nil,
                resourceType: app.id,
                path: navigationState.path,
                appHome: navigationState.appHome ?? app
            )
        }
        hostNavigationState.updatePresentedFocus(focusTab)
    }
}

private extension View {
    func presentedResourceCloseToolbar(onClose: @escaping () -> Void) -> some View {
        toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button(action: onClose) {
                    Image(systemName: "xmark")
                        .frame(width: 44, height: 44)
                        .contentShape(Rectangle())
                }
                .accessibilityLabel(L10n.Common.close)
            }
        }
    }
}

private extension SpaceAppRoute {
    /// 供 `sheet(item:)` 使用的稳定资源身份；不依赖 Swift 的随机 hash seed。
    var presentedPageID: String {
        switch self {
        case let .tabdoc(documentId, _):
            return "tabdoc:\(documentId)"
        case let .tabdata(tableId, _):
            return "tabdata:\(tableId)"
        case let .tabsite(siteId, _, _):
            return "tabsite:\(siteId)"
        case let .tabslide(slideId, _):
            return "tabslide:\(slideId)"
        case let .tabmemo(memoId, _, _):
            return "tabmemo:\(memoId)"
        case let .tabfiles(context):
            return "tabfiles:\(context.contextItemId):\(context.fileRecordId)"
        }
    }
}

struct TaskWorkbenchDashboardView: View {
    let snapshot: TaskWorkbenchSnapshot
    let organizationId: String
    let isResourceLoading: Bool
    let resourceErrorMessage: String?
    let apps: [TaskWorkbenchApp]
    let isAppCatalogLoading: Bool
    let appCatalogErrorMessage: String?
    let appAvailabilityErrorMessage: String?
    let openNotice: String?
    let onOpenOutput: (TaskWorkbenchOutput) -> Void
    let onRetryResources: () -> Void
    let onOpenCheckpoint: (TaskWorkbenchCheckpoint) -> Void
    let onRequestApp: (TaskWorkbenchApp) -> Void
    let onActivateApp: (TaskWorkbenchApp) -> Void
    let onRetryApps: () -> Void

    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @State private var outputsExpanded = false

    private var quickActionColumns: [GridItem] {
        let count = dynamicTypeSize.isAccessibilitySize ? 1 : (horizontalSizeClass == .regular ? 2 : 2)
        return Array(repeating: GridItem(.flexible(), spacing: TTSpacing.sm), count: count)
    }

    /// 对齐 Electron `DesktopHomePane`：紧凑磁贴约 150px 起，手机上尽量排 3 列。
    private var allAppColumns: [GridItem] {
        if dynamicTypeSize.isAccessibilitySize {
            return [GridItem(.flexible())]
        }
        let minimum: CGFloat = horizontalSizeClass == .regular ? 132 : 96
        return [GridItem(.adaptive(minimum: minimum), spacing: TTSpacing.sm)]
    }

    private var quickStartApps: [TaskWorkbenchApp] {
        TaskWorkbenchAppProjector.quickStartApps(from: apps)
    }

    private var appSections: [TaskWorkbenchAppSection] {
        TaskWorkbenchAppProjector.sections(from: apps)
    }

    private var remainingOutputs: [TaskWorkbenchOutput] {
        guard let resumeItem = snapshot.resumeItem else { return snapshot.outputs }
        return snapshot.outputs.filter { $0.id != resumeItem.id }
    }

    private var showsInitialSkeleton: Bool {
        WorkbenchDashboardLoadingPolicy.showsSkeleton(
            hasOutputs: !snapshot.outputs.isEmpty,
            hasApps: !apps.isEmpty,
            isResourceLoading: isResourceLoading,
            isAppCatalogLoading: isAppCatalogLoading,
            hasResourceError: resourceErrorMessage != nil,
            hasAppCatalogError: appCatalogErrorMessage != nil
        )
    }

    var body: some View {
        Group {
            if showsInitialSkeleton {
                WorkbenchLoadingSkeleton(style: .dashboard)
            } else {
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: TTSpacing.xl) {
                        resourceStatus

                        if let resumeItem = snapshot.resumeItem {
                            workbenchSection(title: "继续工作") {
                                resumeCard(resumeItem)
                            }
                        }

                        if snapshot.outputs.isEmpty || !remainingOutputs.isEmpty {
                            workbenchSection(
                                title: "本任务产出",
                                trailing: remainingOutputs.isEmpty ? nil : "\(remainingOutputs.count) 项"
                            ) {
                                if snapshot.outputs.isEmpty {
                                    taskOutputEmptyState
                                } else {
                                    outputBars(remainingOutputs)
                                }
                            }
                        }

                        if !quickStartApps.isEmpty {
                            workbenchSection(title: "开始新的", trailing: "通过 Agent 创建") {
                                LazyVGrid(columns: quickActionColumns, spacing: TTSpacing.sm) {
                                    ForEach(quickStartApps) { app in
                                        quickStartCard(app)
                                    }
                                }
                            }
                        }

                        workbenchSection(
                            title: "全部应用",
                            trailing: apps.isEmpty ? nil : "\(apps.count) 个"
                        ) {
                            appCatalogContent
                        }

                        workbenchSection(title: "恢复与安全") {
                            if let checkpoint = snapshot.latestCheckpoint {
                                checkpointCard(checkpoint)
                            } else {
                                checkpointEmptyState
                            }
                        }
                    }
                    .padding(TTSpacing.lg)
                }
            }
        }
        .background(.tt.bgCanvasDefault)
    }

    @ViewBuilder
    private var appCatalogContent: some View {
        if isAppCatalogLoading && apps.isEmpty {
            HStack(spacing: TTSpacing.sm) {
                ProgressView().controlSize(.small)
                Text("正在加载应用目录…")
                    .font(.tt.meta)
                    .foregroundStyle(.tt.textSecondary)
            }
            .frame(maxWidth: .infinity, minHeight: 72, alignment: .leading)
        } else if let appCatalogErrorMessage, apps.isEmpty {
            statusNotice(
                icon: "exclamationmark.arrow.triangle.2.circlepath",
                message: "应用目录暂不可用：\(appCatalogErrorMessage)",
                color: .tt.textWarning,
                actionTitle: "重试",
                action: onRetryApps
            )
        } else if appSections.isEmpty {
            VStack(alignment: .leading, spacing: TTSpacing.sm) {
                if let appAvailabilityErrorMessage {
                    statusNotice(
                        icon: "exclamationmark.arrow.triangle.2.circlepath",
                        message: "应用状态暂不可确认：\(appAvailabilityErrorMessage)",
                        color: .tt.textWarning,
                        actionTitle: "重试",
                        action: onRetryApps
                    )
                }
                Text("当前组织还没有可展示的应用。")
                    .font(.tt.meta)
                    .foregroundStyle(.tt.textSecondary)
                    .padding(TTSpacing.md)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(.tt.bgSubtle, in: RoundedRectangle(cornerRadius: TTRadius.md))
            }
        } else {
            LazyVStack(alignment: .leading, spacing: TTSpacing.md) {
                if let appCatalogErrorMessage {
                    statusNotice(
                        icon: "exclamationmark.arrow.triangle.2.circlepath",
                        message: "应用目录刷新失败，当前展示上次结果：\(appCatalogErrorMessage)",
                        color: .tt.textWarning,
                        actionTitle: "重试",
                        action: onRetryApps
                    )
                }
                if let appAvailabilityErrorMessage {
                    statusNotice(
                        icon: "exclamationmark.arrow.triangle.2.circlepath",
                        message: "应用状态暂不可确认：\(appAvailabilityErrorMessage)",
                        color: .tt.textWarning,
                        actionTitle: "重试",
                        action: onRetryApps
                    )
                }
                ForEach(appSections) { section in
                    VStack(alignment: .leading, spacing: TTSpacing.sm) {
                        Text(section.title)
                            .font(.tt.captionMedium)
                            .foregroundStyle(.tt.textSecondary)
                        LazyVGrid(columns: allAppColumns, spacing: TTSpacing.sm) {
                            ForEach(section.apps) { app in
                                allAppCard(app)
                            }
                        }
                    }
                }
            }
        }
    }

    private func quickStartCard(_ app: TaskWorkbenchApp) -> some View {
        Button {
            onRequestApp(app)
        } label: {
            HStack(spacing: TTSpacing.sm) {
                AppIconImage(reference: quickStartIconReference(app), size: 34)
                VStack(alignment: .leading, spacing: TTSpacing.xxs) {
                    Text(app.name)
                        .font(.tt.metaSemibold)
                        .foregroundStyle(.tt.textPrimary)
                        .lineLimit(1)
                    Text("让 Agent 开始")
                        .font(.tt.captionMedium)
                        .foregroundStyle(.tt.textSecondary)
                }
                Spacer(minLength: 0)
                Image(systemName: "plus")
                    .font(.tt.iconCaption)
                    .foregroundStyle(.tt.iconAccent)
            }
            .padding(TTSpacing.sm)
            .frame(maxWidth: .infinity, minHeight: 64)
            .background(.tt.bgSubtle, in: RoundedRectangle(cornerRadius: TTRadius.md))
            .overlay {
                RoundedRectangle(cornerRadius: TTRadius.md)
                    .strokeBorder(.tt.borderLight, lineWidth: 0.5)
            }
        }
        .buttonStyle(.plain)
        .accessibilityHint("切回对话并预填 \(app.name) 请求")
    }

    /// “开始新的”代表创建具体资源，不使用带白底底座的完整 App 图标。
    private func quickStartIconReference(_ app: TaskWorkbenchApp) -> AppIconReference {
        switch app.id.lowercased() {
        case "tabdoc", "tabdata", "tabweb":
            return AppIconResolver.resolveContentGlyph(
                appId: app.id,
                manifestIcon: app.manifestIcon
            )
        default:
            return .system(
                AppIconResolver.systemImageFallback(
                    manifestIcon: app.manifestIcon,
                    appId: app.id
                )
            )
        }
    }

    /// Electron `DesktopHomePane` 全部应用磁贴：居中 icon + 单行 title，无描述 / CTA。
    private func allAppCard(_ app: TaskWorkbenchApp) -> some View {
        Button {
            onActivateApp(app)
        } label: {
            VStack(spacing: TTSpacing.sm) {
                appIcon(app, size: horizontalSizeClass == .regular ? 52 : 48)
                Text(app.name)
                    .font(.tt.meta)
                    .foregroundStyle(.tt.textPrimary.opacity(0.85))
                    .lineLimit(dynamicTypeSize.isAccessibilitySize ? 3 : 1)
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: .infinity)
            }
            .padding(.horizontal, TTSpacing.sm)
            .padding(.vertical, TTSpacing.md)
            .frame(
                maxWidth: .infinity,
                minHeight: horizontalSizeClass == .regular ? 124 : 112
            )
            .background(.tt.bgSubtle, in: RoundedRectangle(cornerRadius: TTRadius.md))
            .overlay {
                RoundedRectangle(cornerRadius: TTRadius.md)
                    .strokeBorder(.tt.borderLight, lineWidth: 0.5)
            }
        }
        .buttonStyle(.plain)
        .accessibilityLabel(app.name)
        .accessibilityHint(appAccessibilityHint(app))
    }

    /// 品牌资产是 self-contained（自带底色圆角），直接铺满；SF Symbol 才套 accent chip。
    @ViewBuilder
    private func appIcon(_ app: TaskWorkbenchApp, size: CGFloat) -> some View {
        switch app.iconReference {
        case .asset:
            AppIconImage(reference: app.iconReference, size: size)
                .clipShape(RoundedRectangle(cornerRadius: TTRadius.sm, style: .continuous))
        case .system(let name):
            Image(systemName: name)
                .font(.system(size: size * 0.72, weight: .semibold))
                .symbolRenderingMode(.hierarchical)
                .foregroundStyle(.tt.iconAccent)
                .frame(width: size, height: size)
                .background(
                    .tt.bgAccent.opacity(0.10),
                    in: RoundedRectangle(cornerRadius: TTRadius.sm, style: .continuous)
                )
        }
    }

    private func appAccessibilityHint(_ app: TaskWorkbenchApp) -> String {
        switch app.activation {
        case .openAppHome:
            guard app.resourceCount > 0 else { return "打开 \(app.name) 列表，当前还没有内容" }
            return "打开 \(app.name) 列表，共 \(app.resourceCount) 项"
        case .requestAgent:
            return "切回对话并让 Agent 使用 \(app.name)"
        case let .unavailable(message):
            return message
        }
    }

    @ViewBuilder
    private var resourceStatus: some View {
        if let openNotice {
            statusNotice(
                icon: "info.circle.fill",
                message: openNotice,
                color: .tt.iconAccent,
                actionTitle: nil,
                action: {}
            )
        }
        if isResourceLoading {
            HStack(spacing: TTSpacing.sm) {
                ProgressView().controlSize(.small)
                Text("正在同步任务资源…")
                    .font(.tt.meta)
                    .foregroundStyle(.tt.textSecondary)
            }
            .accessibilityElement(children: .combine)
        } else if let resourceErrorMessage {
            statusNotice(
                icon: "exclamationmark.arrow.triangle.2.circlepath",
                message: "部分资源暂未同步：\(resourceErrorMessage)",
                color: .tt.textWarning,
                actionTitle: "重试",
                action: onRetryResources
            )
        }
    }

    private func workbenchSection<SectionContent: View>(
        title: String,
        trailing: String? = nil,
        @ViewBuilder content: () -> SectionContent
    ) -> some View {
        VStack(alignment: .leading, spacing: TTSpacing.sm) {
            HStack(alignment: .firstTextBaseline) {
                Text(title)
                    .font(.tt.bodySemibold)
                    .foregroundStyle(.tt.textPrimary)
                Spacer(minLength: TTSpacing.sm)
                if let trailing {
                    Text(trailing)
                        .font(.tt.captionMedium)
                        .foregroundStyle(.tt.textTertiary)
                }
            }
            content()
        }
    }

    @ViewBuilder
    private func resumeCard(_ output: TaskWorkbenchOutput) -> some View {
        if output.fileKind != nil {
            CloudDriveResumeCard(
                presentation: CloudDriveRowPresentation(
                    output: output,
                    organizationId: organizationId
                )
            ) {
                onOpenOutput(output)
            }
            .opacity(output.canOpen ? 1 : 0.64)
            .accessibilityHint(output.canOpen ? "打开最近的任务产物" : "资源同步后可打开")
        } else if let kind = TaskWorkbenchContinueWindowPolicy.appKind(for: output.resourceType) {
            let palette = AppHomePalette(appKind: kind)
            TaskResourceContinueCard(
                appKind: kind,
                actionTitle: kind.continueActionTitle,
                originText: L10n.WorkbenchAppHome.resumeTask,
                iconReference: AppIconResolver.resolveContentGlyph(
                    appId: kind.resourceType,
                    manifestIcon: kind == .tabdoc ? "file-text" : "table"
                ),
                item: TaskWorkbenchContinueWindowPolicy.item(from: output),
                collaboration: .idle,
                accent: palette.accent,
                accentSoft: palette.accentSoft,
                surface: palette.surface,
                line: palette.line,
                onPreview: { onOpenOutput(output) }
            )
            .accessibilityHint(output.canOpen ? "打开最近的任务产物" : "资源同步后可打开")
        } else {
            outputCard(output)
        }
    }

    private func outputBars(_ outputs: [TaskWorkbenchOutput]) -> some View {
        let visible = TaskWorkbenchOutputListPolicy.visible(
            from: outputs,
            expanded: outputsExpanded
        )
        let hiddenCount = TaskWorkbenchOutputListPolicy.hiddenCount(
            total: outputs.count,
            expanded: outputsExpanded
        )
        return VStack(spacing: TTSpacing.xs) {
            ForEach(visible) { output in
                outputBar(output)
            }
            if hiddenCount > 0 || (outputsExpanded && outputs.count > TaskWorkbenchOutputListPolicy.collapsedVisibleCount) {
                Button {
                    outputsExpanded.toggle()
                } label: {
                    Text(outputsExpanded ? "收起" : "展开其余 \(hiddenCount) 项")
                        .font(.tt.captionMedium)
                        .foregroundStyle(.tt.textSecondary)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, TTSpacing.xs)
                }
                .buttonStyle(.plain)
            }
        }
    }

    private func outputBar(_ output: TaskWorkbenchOutput) -> some View {
        Button {
            onOpenOutput(output)
        } label: {
            HStack(spacing: TTSpacing.sm) {
                if let fileKind = output.fileKind {
                    CloudDriveResourceGlyph(kind: fileKind, size: 20)
                } else {
                    AppIconImage(reference: output.iconReference, size: 20)
                }
                VStack(alignment: .leading, spacing: 2) {
                    Text(output.title)
                        .font(.tt.metaSemibold)
                        .foregroundStyle(.tt.textPrimary)
                        .lineLimit(1)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    HStack(spacing: 4) {
                        Text(output.canOpen ? output.presentationTypeLabel : "资源同步后可打开")
                        Text("·")
                        Text(output.timestamp, style: .relative)
                    }
                    .font(.tt.captionMedium)
                    .foregroundStyle(output.canOpen ? .tt.textTertiary : .tt.textWarning)
                    .lineLimit(1)
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
                Image(systemName: output.canOpen ? "chevron.right" : "arrow.triangle.2.circlepath")
                    .font(.tt.iconCaption)
                    .foregroundStyle(.tt.textTertiary)
            }
            .padding(.horizontal, TTSpacing.sm)
            .padding(.vertical, TTSpacing.xs)
            .frame(maxWidth: .infinity, minHeight: 48, alignment: .leading)
            .background(.tt.bgSubtle, in: RoundedRectangle(cornerRadius: TTRadius.sm))
            .overlay {
                RoundedRectangle(cornerRadius: TTRadius.sm)
                    .strokeBorder(.tt.borderLight, lineWidth: 0.5)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(!output.canOpen)
        .accessibilityHint(output.canOpen ? "打开任务产物" : "资源同步后可打开")
    }

    private func outputCard(_ output: TaskWorkbenchOutput) -> some View {
        outputBar(output)
    }

    private var taskOutputEmptyState: some View {
        HStack(alignment: .top, spacing: TTSpacing.sm) {
            Image(systemName: "sparkles.rectangle.stack")
                .font(.tt.iconSubtitleMedium)
                .foregroundStyle(.tt.iconAccent)
            VStack(alignment: .leading, spacing: TTSpacing.xxs) {
                Text("这个任务还没有产物")
                    .font(.tt.metaSemibold)
                    .foregroundStyle(.tt.textPrimary)
                Text("Agent 生成的文档、数据和站点会自动出现在这里。")
                    .font(.tt.meta)
                    .foregroundStyle(.tt.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 0)
        }
        .padding(TTSpacing.md)
        .frame(maxWidth: .infinity)
        .background(.tt.bgSubtle, in: RoundedRectangle(cornerRadius: TTRadius.md))
    }

    private func checkpointCard(_ checkpoint: TaskWorkbenchCheckpoint) -> some View {
        Button {
            onOpenCheckpoint(checkpoint)
        } label: {
            HStack(spacing: TTSpacing.md) {
                Image(systemName: checkpoint.status == .ready ? "clock.arrow.circlepath" : "exclamationmark.shield")
                    .font(.tt.iconFeatureMedium)
                    .symbolRenderingMode(.hierarchical)
                    .foregroundStyle(checkpoint.status == .ready ? .tt.iconAccent : .tt.textWarning)
                    .frame(width: 40, height: 40)
                    .background(.tt.bgAccent.opacity(0.10), in: RoundedRectangle(cornerRadius: TTRadius.sm))

                VStack(alignment: .leading, spacing: TTSpacing.xxs) {
                    Text(checkpoint.title)
                        .font(.tt.metaSemibold)
                        .foregroundStyle(.tt.textPrimary)
                        .lineLimit(2)
                    HStack(spacing: TTSpacing.xs) {
                        Text(checkpoint.createdAt, style: .relative)
                        if checkpoint.changedFileCount > 0 {
                            Text("· \(checkpoint.changedFileCount) 个文件")
                        }
                        if checkpoint.canRestoreResources {
                            Text("· 含资源")
                        }
                    }
                    .font(.tt.captionMedium)
                    .foregroundStyle(.tt.textSecondary)
                }
                Spacer(minLength: 0)
                Image(systemName: "chevron.right")
                    .font(.tt.iconCaption)
                    .foregroundStyle(.tt.textTertiary)
            }
            .padding(TTSpacing.md)
            .frame(maxWidth: .infinity)
            .background(.tt.bgSubtle, in: RoundedRectangle(cornerRadius: TTRadius.md))
            .overlay {
                RoundedRectangle(cornerRadius: TTRadius.md)
                    .strokeBorder(.tt.borderLight, lineWidth: 0.5)
            }
        }
        .buttonStyle(.plain)
        .accessibilityHint("查看恢复范围")
    }

    private var checkpointEmptyState: some View {
        HStack(spacing: TTSpacing.sm) {
            Image(systemName: "shield.checkered")
                .foregroundStyle(.tt.iconAccent)
            Text("关键步骤完成后，这里会显示可恢复的检查点。")
                .font(.tt.meta)
                .foregroundStyle(.tt.textSecondary)
            Spacer(minLength: 0)
        }
        .padding(TTSpacing.md)
        .frame(maxWidth: .infinity)
        .background(.tt.bgSubtle, in: RoundedRectangle(cornerRadius: TTRadius.md))
    }

    private func statusNotice(
        icon: String,
        message: String,
        color: Color,
        actionTitle: String?,
        action: @escaping () -> Void
    ) -> some View {
        HStack(alignment: .top, spacing: TTSpacing.sm) {
            Image(systemName: icon)
                .font(.tt.iconBody)
                .foregroundStyle(color)
                .padding(.top, 1)
            Text(message)
                .font(.tt.meta)
                .foregroundStyle(.tt.textSecondary)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
            if let actionTitle {
                Button(actionTitle, action: action)
                    .font(.tt.metaSemibold)
                    .buttonStyle(.plain)
                    .foregroundStyle(.tt.textAccent)
                    .frame(minWidth: 44, minHeight: 44)
                    .contentShape(Rectangle())
            }
        }
        .padding(TTSpacing.sm)
        .background(.tt.bgSubtle, in: RoundedRectangle(cornerRadius: TTRadius.sm))
        .overlay {
            RoundedRectangle(cornerRadius: TTRadius.sm)
                .strokeBorder(.tt.borderLight, lineWidth: 0.5)
        }
    }
}

enum WorkbenchDashboardLoadingPolicy {
    static func showsSkeleton(
        hasOutputs: Bool,
        hasApps: Bool,
        isResourceLoading: Bool,
        isAppCatalogLoading: Bool,
        hasResourceError: Bool,
        hasAppCatalogError: Bool
    ) -> Bool {
        let hasMeaningfulContent = hasOutputs || hasApps
        let hasBlockingError = hasResourceError || hasAppCatalogError
        return !hasMeaningfulContent
            && !hasBlockingError
            && (isResourceLoading || isAppCatalogLoading)
    }
}

private struct WorkbenchLoadingSkeleton: View {
    enum Style {
        case dashboard
        case resourceList
    }

    let style: Style

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        ScrollView {
            TimelineView(.animation(minimumInterval: 1.0 / 30.0, paused: reduceMotion)) { context in
                skeletonContent
                    .opacity(pulseOpacity(at: context.date))
            }
            .padding(TTSpacing.lg)
        }
        .background(.tt.bgCanvasDefault)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(L10n.Common.loading)
    }

    @ViewBuilder
    private var skeletonContent: some View {
        switch style {
        case .dashboard:
            LazyVStack(alignment: .leading, spacing: TTSpacing.xl) {
                skeletonSectionHeader(trailing: true)
                WorkbenchSkeletonBlock(radius: TTRadius.lg)
                    .frame(maxWidth: .infinity, minHeight: 96)

                skeletonSectionHeader(trailing: false)
                LazyVGrid(
                    columns: [GridItem(.adaptive(minimum: 138), spacing: TTSpacing.sm)],
                    spacing: TTSpacing.sm
                ) {
                    ForEach(0..<2, id: \.self) { _ in
                        WorkbenchSkeletonBlock(radius: TTRadius.md)
                            .frame(minHeight: 88)
                    }
                }

                skeletonSectionHeader(trailing: true)
                LazyVGrid(
                    columns: [GridItem(.adaptive(minimum: 96), spacing: TTSpacing.sm)],
                    spacing: TTSpacing.sm
                ) {
                    ForEach(0..<3, id: \.self) { _ in
                        WorkbenchSkeletonBlock(radius: TTRadius.md)
                            .frame(minHeight: 112)
                    }
                }
            }
        case .resourceList:
            LazyVStack(alignment: .leading, spacing: TTSpacing.xl) {
                ForEach(0..<3, id: \.self) { section in
                    VStack(alignment: .leading, spacing: TTSpacing.sm) {
                        WorkbenchSkeletonBlock(radius: TTRadius.full)
                            .frame(width: section == 1 ? 72 : 96, height: 14)
                        ForEach(0..<2, id: \.self) { row in
                            HStack(spacing: TTSpacing.sm) {
                                WorkbenchSkeletonBlock(radius: TTRadius.sm)
                                    .frame(width: 32, height: 32)
                                VStack(alignment: .leading, spacing: TTSpacing.xs) {
                                    WorkbenchSkeletonBlock(radius: TTRadius.full)
                                        .frame(maxWidth: row == 0 ? .infinity : 220, minHeight: 12)
                                    WorkbenchSkeletonBlock(radius: TTRadius.full)
                                        .frame(maxWidth: 144, minHeight: 10)
                                }
                            }
                            .padding(TTSpacing.md)
                            .background(.tt.bgSubtle, in: RoundedRectangle(cornerRadius: TTRadius.md))
                        }
                    }
                }
            }
        }
    }

    private func skeletonSectionHeader(trailing: Bool) -> some View {
        HStack {
            WorkbenchSkeletonBlock(radius: TTRadius.full)
                .frame(width: 88, height: 14)
            Spacer(minLength: TTSpacing.sm)
            if trailing {
                WorkbenchSkeletonBlock(radius: TTRadius.full)
                    .frame(width: 52, height: 12)
            }
        }
    }

    private func pulseOpacity(at date: Date) -> Double {
        guard !reduceMotion else { return 0.72 }
        let phase = date.timeIntervalSinceReferenceDate
            .remainder(dividingBy: 1.6) / 1.6
        return 0.58 + 0.22 * ((sin(phase * .pi * 2) + 1) / 2)
    }
}

private struct WorkbenchSkeletonBlock: View {
    let radius: CGFloat

    var body: some View {
        RoundedRectangle(cornerRadius: radius, style: .continuous)
            .fill(.tt.bgSubtleSecondary)
    }
}

private struct WorkbenchRootChrome: ViewModifier {
    let presentation: WorkbenchContainerView.Presentation
    let isAppHomePresentation: Bool

    @ViewBuilder
    func body(content: Content) -> some View {
        switch presentation {
        case let .sheet(onClose):
            if isAppHomePresentation {
                content
            } else {
                content
                    .navigationTitle("工作台")
                    .navigationBarTitleDisplayMode(.inline)
                    .toolbar {
                        ToolbarItem(placement: .topBarTrailing) {
                            Button("完成", action: onClose)
                        }
                    }
            }
        case .taskPane:
            content
                .toolbar(.hidden, for: .navigationBar)
        }
    }
}

/// SpaceAppRoute → 具体承载页的统一映射。WorkbenchSheet 与 Space 详情页（SpaceSessionsView）共用，
/// 保证同一种资源无论从哪个入口打开，落到的都是同一个承载实现。
struct SpaceAppRouteScreen: View {
    let route: SpaceAppRoute
    let organizationId: String
    let spaceId: String?
    var locationHint: String? = nil
    var onNativeFocusReport: ((NativeWorkbenchFocusReport) -> Void)? = nil

    var body: some View {
        switch route {
        case let .tabdoc(documentId, documentName):
            NativeTabDocEditorScreen(
                documentId: documentId,
                organizationId: organizationId,
                spaceId: spaceId,
                fallbackTitle: documentName,
                locationHint: locationHint
            )
        case let .tabdata(tableId, tableName):
            NativeTabDataScreen(
                tableId: tableId,
                organizationId: organizationId,
                spaceId: spaceId,
                fallbackTitle: tableName,
                locationHint: locationHint,
                onNativeFocusReport: onNativeFocusReport
            )
        case let .tabsite(siteId, siteUrl, siteName):
            TabSiteViewerScreen(siteId: siteId, siteUrl: siteUrl, siteName: siteName)
        case let .tabslide(slideId, slideName):
            AuthenticatedWorkbenchResourceWebScreen(
                resource: .slide(id: slideId),
                organizationId: organizationId,
                spaceId: spaceId,
                title: slideName,
                locationHint: locationHint,
                onNativeFocusReport: onNativeFocusReport
            )
        case let .tabmemo(memoId, memoName, spaceName):
            CloudMemoDetailScreen(context: CloudMemoDetailContext(
                memoId: memoId,
                title: memoName,
                spaceName: spaceName ?? locationHint
            ))
        case let .tabfiles(context):
            CloudFileDetailScreen(context: context)
        }
    }
}

enum AuthenticatedWorkbenchResource: Equatable {
    case document(id: String)
    case table(id: String)
    case slide(id: String)

    var pathName: String {
        switch self {
        case .document: return "docs"
        case .table: return "tables"
        case .slide: return "slides"
        }
    }

    var id: String {
        switch self {
        case let .document(id), let .table(id), let .slide(id): return id
        }
    }

    var emptyTitle: String {
        switch self {
        case .document: return "文档暂不可用"
        case .table: return "表格暂不可用"
        case .slide: return "幻灯片暂不可用"
        }
    }

    var emptyMessage: String {
        switch self {
        case .document: return "未能生成文档 Web 地址，请稍后重试。"
        case .table: return "未能生成表格 Web 地址，请稍后重试。"
        case .slide: return "未能生成幻灯片 Web 地址，请稍后重试。"
        }
    }
}

/// 与 Web 端 `spaceRoutes` 同口径：资源既可能有 Organization + Space 上下文，
/// 也可能只由 Organization 直接拥有。后者必须走根级 `/docs/{id}`、`/tables/{id}`。
func workbenchResourceURL(
    baseURL: URL,
    organizationId: String?,
    spaceId: String?,
    pathName: String,
    resourceId: String
) -> URL {
    let normalizedOrganizationId = organizationId.flatMap { value -> String? in
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }
    let normalizedSpaceId = spaceId.flatMap { value -> String? in
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    var url = baseURL
    if let organizationId = normalizedOrganizationId, let spaceId = normalizedSpaceId {
        url = url
            .appendingPathComponent("organizations")
            .appendingPathComponent(organizationId)
            .appendingPathComponent("spaces")
            .appendingPathComponent(spaceId)
    } else if let spaceId = normalizedSpaceId {
        url = url
            .appendingPathComponent("spaces")
            .appendingPathComponent(spaceId)
    }
    return url
        .appendingPathComponent(pathName)
        .appendingPathComponent(resourceId)
}

func embeddedWorkbenchResourceURL(
    canonicalURL: URL,
    client: String,
    isDarkTheme: Bool
) -> URL? {
    guard var components = URLComponents(url: canonicalURL, resolvingAgainstBaseURL: false) else {
        return nil
    }
    components.queryItems = (components.queryItems ?? []).filter {
        $0.name != "shell" && $0.name != "client" && $0.name != "theme"
    } + [
        URLQueryItem(name: "shell", value: "embedded"),
        URLQueryItem(name: "client", value: client),
        URLQueryItem(name: "theme", value: isDarkTheme ? "dark" : "light"),
    ]
    return components.url
}

struct AuthenticatedWorkbenchResourceWebScreen: View {
    let resource: AuthenticatedWorkbenchResource
    let organizationId: String
    let spaceId: String?
    let title: String
    let locationHint: String?
    var onNativeFocusReport: ((NativeWorkbenchFocusReport) -> Void)? = nil

    @State private var isLoading = true
    @State private var loadError: String?
    @State private var authSnapshot: WorkbenchWebAuthSnapshot?
    @State private var authLoadError: String?
    @State private var reloadToken = UUID()
    @State private var recovery = WebContentProcessRecovery()
    @State private var showCopiedToast = false
    @Environment(\.openURL) private var openURL
    @Environment(\.colorScheme) private var colorScheme

    private var canonicalURL: URL? {
        guard let baseURL = URL(string: AppConfig.webBaseURL) else { return nil }
        return workbenchResourceURL(
            baseURL: baseURL,
            organizationId: organizationId,
            spaceId: spaceId,
            pathName: resource.pathName,
            resourceId: resource.id
        )
    }

    private var targetURL: URL? {
        canonicalURL.flatMap {
            embeddedWorkbenchResourceURL(
                canonicalURL: $0,
                client: "ios",
                isDarkTheme: colorScheme == .dark
            )
        }
    }
    var body: some View {
        Group {
            if let targetURL, let origin = WorkbenchWebOrigin(url: targetURL) {
                if let authSnapshot {
                    ZStack {
                        AuthenticatedWorkbenchResourceWebView(
                            url: targetURL,
                            expectedOrigin: origin,
                            authSnapshot: authSnapshot,
                            isLoading: $isLoading,
                            loadError: $loadError,
                            reloadToken: reloadToken,
                            onContentProcessTerminated: handleContentProcessTermination,
                            onNativeFocusReport: onNativeFocusReport
                        )
                        // 内容进程终止后同一实例救不回来，重试靠换 id 让 SwiftUI 整个重建。
                        .id(recovery.instanceId)
                        if let error = loadError {
                            WebHostLoadErrorView(message: error, onRetry: retry)
                        }
                    }
                } else if let authLoadError {
                    WebHostLoadErrorView(message: authLoadError, onRetry: retry)
                } else {
                    ProgressView("正在验证登录状态…")
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                }
            } else {
                unavailableState
            }
        }
        .background(.tt.bgCanvasDefault)
        .navigationTitle(title)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar { toolbarContent }
        .overlay(alignment: .top) {
            if showCopiedToast {
                copiedToast.transition(.move(edge: .top).combined(with: .opacity))
            }
        }
        .task(id: targetURL) {
            await loadCredential()
        }
    }

    @ToolbarContentBuilder
    private var toolbarContent: some ToolbarContent {
        ToolbarItem(placement: .topBarTrailing) {
            HStack(spacing: TTSpacing.sm) {
                if isLoading && targetURL != nil {
                    ProgressView().scaleEffect(0.7)
                }
                Menu {
                    if targetURL != nil {
                        Button { copyLink() } label: { Label("复制链接", systemImage: "doc.on.doc") }
                        Button { openInBrowser() } label: { Label("在浏览器打开", systemImage: "safari") }
                        if loadError != nil {
                            Button { retry() } label: { Label("重试", systemImage: "arrow.clockwise") }
                        }
                    }
                } label: {
                    Image(systemName: "ellipsis.circle").foregroundStyle(.tt.iconAccent)
                }
                .disabled(targetURL == nil)
            }
        }
    }

    private var unavailableState: some View {
        VStack(spacing: TTSpacing.md) {
            Image(systemName: "exclamationmark.triangle")
                .font(.tt.iconEmptyLG)
                .foregroundStyle(.tt.textTertiary)
            Text(resource.emptyTitle).font(.tt.bodySemibold).foregroundStyle(.tt.textSecondary)
            Text(resource.emptyMessage)
                .font(.tt.body)
                .foregroundStyle(.tt.textTertiary)
                .multilineTextAlignment(.center)
            if let locationHint, !locationHint.isEmpty {
                Text(locationHint)
                    .font(.tt.meta)
                    .foregroundStyle(.tt.textTertiary)
                    .multilineTextAlignment(.center)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding(TTSpacing.lg)
    }

    private var copiedToast: some View {
        HStack(spacing: TTSpacing.xs) {
            Image(systemName: "checkmark.circle.fill").foregroundStyle(.tt.bgSuccess)
            Text("链接已复制").font(.tt.meta).foregroundStyle(.tt.textPrimary)
        }
        .padding(.horizontal, TTSpacing.lg)
        .padding(.vertical, TTSpacing.sm)
        .background(Capsule().fill(.tt.bgSubtle).shadow(color: .black.opacity(0.08), radius: 8, y: 4))
        .padding(.top, TTSpacing.md)
    }

    private func retry() {
        loadError = nil
        authLoadError = nil
        isLoading = true
        Task { await loadCredential(forceRefresh: authSnapshot == nil) }
        guard authSnapshot != nil else { return }
        if recovery.isTerminated {
            // 内容进程没了之后 reload() / load() 打在旧实例上常常没反应，必须重建
            // （重建也会带着最新 authSnapshot 重新注入 userScript）。
            recovery.recreate()
        } else {
            reloadToken = UUID()
        }
    }

    /// Web 内容进程被系统回收：上报 + 切「加载失败 + 重试」降级 UI，不留白屏。
    private func handleContentProcessTermination() {
        WebContentProcessGuard.handleTermination(host: .workbenchResource)
        recovery.markTerminated()
        isLoading = false
        loadError = WebContentProcessGuard.terminatedMessage
    }

    @MainActor
    private func loadCredential(forceRefresh: Bool = false) async {
        switch await APIClient.shared.embeddedWebCredential(forceRefresh: forceRefresh) {
        case .ready(let credential):
            authSnapshot = WorkbenchWebAuthSnapshot.current(credential: credential)
            authLoadError = nil
        case .unauthenticated:
            authSnapshot = nil
        case .temporarilyUnavailable:
            authSnapshot = nil
            authLoadError = "暂时无法验证登录状态，请检查网络后重试。"
            isLoading = false
        }
    }

    private func copyLink() {
        guard let canonicalURL else { return }
        UIPasteboard.general.string = canonicalURL.absoluteString
        withAnimation(.spring(duration: 0.3)) { showCopiedToast = true }
        Task {
            try? await Task.sleep(for: .seconds(2))
            withAnimation(.spring(duration: 0.3)) { showCopiedToast = false }
        }
    }

    private func openInBrowser() {
        guard let canonicalURL else { return }
        openURL(canonicalURL)
    }
}

private struct AuthenticatedWorkbenchResourceWebView: UIViewRepresentable {
    let url: URL
    let expectedOrigin: WorkbenchWebOrigin
    let authSnapshot: WorkbenchWebAuthSnapshot
    @Binding var isLoading: Bool
    @Binding var loadError: String?
    let reloadToken: UUID
    let onContentProcessTerminated: @MainActor () -> Void
    let onNativeFocusReport: ((NativeWorkbenchFocusReport) -> Void)?

    func makeCoordinator() -> Coordinator { Coordinator(parent: self) }

    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.allowsInlineMediaPlayback = true
        config.websiteDataStore = .default()
        config.userContentController.addUserScript(authSnapshot.userScript(expectedOrigin: expectedOrigin))
        config.userContentController.addUserScript(
            WorkbenchNativeFocusBridge.userScript(expectedOrigin: expectedOrigin)
        )
        config.userContentController.addUserScript(
            WorkbenchMobileHostContext.currentIOS.userScript(expectedOrigin: expectedOrigin)
        )
        config.userContentController.addScriptMessageHandler(
            context.coordinator,
            contentWorld: .page,
            name: WorkbenchWebAuthSnapshot.bridgeHandlerName
        )
        // Focus 与 Auth 分通道：无 reply，仅 fire-and-forget postMessage。
        config.userContentController.add(
            context.coordinator,
            contentWorld: .page,
            name: WorkbenchNativeFocusBridge.handlerName
        )

        let webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = context.coordinator
        webView.allowsBackForwardNavigationGestures = true
        webView.scrollView.pinchGestureRecognizer?.isEnabled = true
        webView.scrollView.keyboardDismissMode = .interactive
        context.coordinator.currentToken = reloadToken
        context.coordinator.currentAuthSnapshot = authSnapshot
        webView.load(URLRequest(url: url))
        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {
        context.coordinator.parent = self
        if authSnapshot != context.coordinator.currentAuthSnapshot {
            context.coordinator.currentAuthSnapshot = authSnapshot
            webView.configuration.userContentController.removeAllUserScripts()
            webView.configuration.userContentController.addUserScript(
                authSnapshot.userScript(expectedOrigin: expectedOrigin)
            )
            webView.configuration.userContentController.addUserScript(
                WorkbenchNativeFocusBridge.userScript(expectedOrigin: expectedOrigin)
            )
            webView.configuration.userContentController.addUserScript(
                WorkbenchMobileHostContext.currentIOS.userScript(expectedOrigin: expectedOrigin)
            )
            webView.evaluateJavaScript(authSnapshot.injectionScript(expectedOrigin: expectedOrigin))
            webView.evaluateJavaScript(
                WorkbenchNativeFocusBridge.injectionScript(expectedOrigin: expectedOrigin)
            )
            webView.evaluateJavaScript(
                WorkbenchMobileHostContext.currentIOS.injectionScript(expectedOrigin: expectedOrigin)
            )
        }

        guard reloadToken != context.coordinator.currentToken else { return }
        context.coordinator.currentToken = reloadToken
        webView.load(URLRequest(url: url))
    }

    static func dismantleUIView(_ webView: WKWebView, coordinator: Coordinator) {
        webView.configuration.userContentController.removeScriptMessageHandler(
            forName: WorkbenchWebAuthSnapshot.bridgeHandlerName,
            contentWorld: .page
        )
        webView.configuration.userContentController.removeScriptMessageHandler(
            forName: WorkbenchNativeFocusBridge.handlerName,
            contentWorld: .page
        )
        webView.navigationDelegate = nil
    }

    final class Coordinator: NSObject, WKNavigationDelegate, WKScriptMessageHandler, WKScriptMessageHandlerWithReply {
        var parent: AuthenticatedWorkbenchResourceWebView
        var currentToken: UUID?
        var currentAuthSnapshot: WorkbenchWebAuthSnapshot?

        init(parent: AuthenticatedWorkbenchResourceWebView) { self.parent = parent }

        /// NativeFocus（无 reply）
        func userContentController(
            _ userContentController: WKUserContentController,
            didReceive message: WKScriptMessage
        ) {
            guard message.name == WorkbenchNativeFocusBridge.handlerName,
                  parent.expectedOrigin.matches(message.frameInfo.securityOrigin),
                  let report = NativeWorkbenchFocusReport.parse(message.body) else {
                return
            }
            Task { @MainActor in
                parent.onNativeFocusReport?(report)
            }
        }

        /// Auth refresh（带 reply）
        func userContentController(
            _ userContentController: WKUserContentController,
            didReceive message: WKScriptMessage
        ) async -> (Any?, String?) {
            guard message.name == WorkbenchWebAuthSnapshot.bridgeHandlerName,
                  parent.expectedOrigin.matches(message.frameInfo.securityOrigin),
                  let body = message.body as? [String: Any],
                  body["action"] as? String == "refresh" else {
                return (nil, "unsupported_request")
            }

            switch await APIClient.shared.embeddedWebCredential(forceRefresh: true) {
            case .ready(let credential):
                var payload: [String: Any] = [
                    "status": "succeeded",
                    "accessToken": credential.accessToken,
                    "expiresAt": NSNull(),
                ]
                if let expiresAt = credential.expiresAt { payload["expiresAt"] = expiresAt }
                return (payload, nil)
            case .unauthenticated:
                return (["status": "unauthenticated"], nil)
            case .temporarilyUnavailable:
                return ([
                        "status": "temporarily_unavailable",
                        "message": "登录状态暂时无法刷新",
                    ], nil)
            }
        }

        func webView(
            _ webView: WKWebView,
            decidePolicyFor navigationAction: WKNavigationAction
        ) async -> WKNavigationActionPolicy {
            guard let targetURL = navigationAction.request.url else { return .allow }
            guard navigationAction.targetFrame?.isMainFrame != false else { return .allow }
            guard !parent.expectedOrigin.shouldOpenExternally(targetURL) else {
                Task { @MainActor in UIApplication.shared.open(targetURL) }
                return .cancel
            }
            return .allow
        }

        func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
            Task { @MainActor in parent.isLoading = true }
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            Task { @MainActor in
                parent.isLoading = false
                parent.loadError = nil
            }
        }

        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
            Task { @MainActor in
                parent.isLoading = false
                parent.loadError = error.localizedDescription
            }
        }

        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
            Task { @MainActor in
                parent.isLoading = false
                parent.loadError = error.localizedDescription
            }
        }

        /// 系统回收了 Web 内容进程：视图已经永久变白，且不会再有任何 `didFail*` 回调。
        func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
            Task { @MainActor in parent.onContentProcessTerminated() }
        }
    }
}

struct WorkbenchWebOrigin: Equatable {
    let scheme: String
    let host: String
    let port: Int?

    init?(url: URL) {
        guard let scheme = url.scheme?.lowercased(),
              let host = url.host()?.lowercased() else { return nil }
        self.scheme = scheme
        self.host = host
        self.port = Self.canonicalPort(url.port, scheme: scheme)
    }

    var javascriptValue: String {
        // URL.host strips IPv6 brackets, while a browser origin keeps them in the authority.
        let authorityHost = host.contains(":") ? "[\(host)]" : host
        var value = "\(scheme)://\(authorityHost)"
        if let port { value += ":\(port)" }
        return value
    }

    func matches(_ url: URL) -> Bool {
        url.scheme?.lowercased() == scheme
            && url.host()?.lowercased() == host
            && Self.canonicalPort(url.port, scheme: scheme) == port
    }

    func shouldOpenExternally(_ url: URL) -> Bool {
        url.scheme?.lowercased() != "blob" && !matches(url)
    }

    @MainActor
    func matches(_ origin: WKSecurityOrigin) -> Bool {
        origin.protocol.lowercased() == scheme
            && origin.host.lowercased() == host
            && normalizedPort(origin.port) == normalizedPort(port ?? 0)
    }

    private func normalizedPort(_ value: Int) -> Int {
        if value != 0 { return value }
        return Self.defaultPort(for: scheme) ?? value
    }

    private static func canonicalPort(_ port: Int?, scheme: String) -> Int? {
        guard port != defaultPort(for: scheme) else { return nil }
        return port
    }

    private static func defaultPort(for scheme: String) -> Int? {
        switch scheme {
        case "https": return 443
        case "http": return 80
        default: return nil
        }
    }
}

/// iOS WebView 向共享 Web 应用暴露的版本化宿主契约。
///
/// 宿主只描述原生容器稳定能力；屏幕宽度、横竖屏等易变布局信息继续由 Web
/// 使用 viewport 自适应，避免把原生设备类型误当作当前可用宽度。
struct WorkbenchMobileHostContext: Codable, Equatable {
    enum FormFactor: String, Codable {
        case phone
        case tablet
    }

    struct Capabilities: Codable, Equatable {
        let filePicker: Bool
        let nativeFocus: Bool
        let fullEditor: Bool
    }

    let version: Int
    let platform: String
    let formFactor: FormFactor
    let capabilities: Capabilities

    static func iOS(formFactor: FormFactor) -> WorkbenchMobileHostContext {
        WorkbenchMobileHostContext(
            version: 1,
            platform: "ios",
            formFactor: formFactor,
            capabilities: Capabilities(
                filePicker: true,
                nativeFocus: true,
                fullEditor: true
            )
        )
    }

    @MainActor
    static var currentIOS: WorkbenchMobileHostContext {
        iOS(formFactor: UIDevice.current.userInterfaceIdiom == .pad ? .tablet : .phone)
    }

    var encodedJSON: String {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        guard let data = try? encoder.encode(self),
              let encoded = String(data: data, encoding: .utf8) else {
            return "{}"
        }
        return encoded
    }

    @MainActor
    func userScript(expectedOrigin: WorkbenchWebOrigin) -> WKUserScript {
        WKUserScript(
            source: injectionScript(expectedOrigin: expectedOrigin),
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true
        )
    }

    func injectionScript(expectedOrigin: WorkbenchWebOrigin) -> String {
        """
        (() => {
          if (window.location.origin !== \(Self.jsonString(expectedOrigin.javascriptValue))) {
            return;
          }
          const hostContext = \(encodedJSON);
          window.__TABTIN_MOBILE_HOST__ = hostContext;
          window.dispatchEvent(
            new CustomEvent('tabtin:host-context', { detail: hostContext })
          );
        })();
        """
    }

    private static func jsonString(_ value: String) -> String {
        guard let data = try? JSONEncoder().encode(value),
              let encoded = String(data: data, encoding: .utf8) else {
            return "\"\""
        }
        return encoded
    }
}

///  NativeFocus bridge：与 Auth 分通道，仅注入 report → TabTinNativeFocus。
private enum WorkbenchNativeFocusBridge {
    static let handlerName = "TabTinNativeFocus"

    static func userScript(expectedOrigin: WorkbenchWebOrigin) -> WKUserScript {
        WKUserScript(
            source: injectionScript(expectedOrigin: expectedOrigin),
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true
        )
    }

    static func injectionScript(expectedOrigin: WorkbenchWebOrigin) -> String {
        """
        (() => {
          if (window.location.origin !== \(jsonString(expectedOrigin.javascriptValue))) {
            return;
          }
          window.__TABTIN_NATIVE_FOCUS__ = {
            report: (payload) => {
              window.webkit.messageHandlers[\(jsonString(handlerName))].postMessage(payload);
            }
          };
        })();
        """
    }

    private static func jsonString(_ value: String) -> String {
        guard let data = try? JSONEncoder().encode(value),
              let encoded = String(data: data, encoding: .utf8) else { return "\"\"" }
        return encoded
    }
}

struct WorkbenchWebAuthSnapshot: Equatable {
    let accessToken: String?
    let expiresAt: Int?
    let userJSON: String?

    static let bridgeHandlerName = "tabtinAuth"

    @MainActor
    static func current(credential: EmbeddedWebCredential) -> WorkbenchWebAuthSnapshot {
        let userJSON: String?
        if let user = AuthService.shared.currentUser,
           let data = try? JSONEncoder().encode(user) {
            userJSON = String(data: data, encoding: .utf8)
        } else {
            userJSON = nil
        }
        return WorkbenchWebAuthSnapshot(
            accessToken: credential.accessToken,
            expiresAt: credential.expiresAt,
            userJSON: userJSON
        )
    }

    @MainActor
    func userScript(expectedOrigin: WorkbenchWebOrigin) -> WKUserScript {
        WKUserScript(
            source: injectionScript(expectedOrigin: expectedOrigin),
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true
        )
    }

    func injectionScript(expectedOrigin: WorkbenchWebOrigin) -> String {
        """
        (() => {
          if (window.location.origin !== \(Self.jsonString(expectedOrigin.javascriptValue))) {
            return;
          }
          const auth = {
            accessToken: \(Self.jsonString(accessToken)),
            expiresAt: \(expiresAt.map { String($0) } ?? "null"),
            user: \(userJSON ?? "null")
          };
          localStorage.removeItem('tabtin-auth-storage');
          if (auth.accessToken) {
            localStorage.setItem('tabtin_access_token', auth.accessToken);
          } else {
            localStorage.removeItem('tabtin_access_token');
          }
          localStorage.removeItem('tabtin_refresh_token');
          if (auth.expiresAt != null) {
            localStorage.setItem('tabtin_expires_at', String(auth.expiresAt));
          } else {
            localStorage.removeItem('tabtin_expires_at');
          }
          if (auth.user) {
            localStorage.setItem('tabtin_user', JSON.stringify(auth.user));
          } else {
            localStorage.removeItem('tabtin_user');
          }
          window.__TABTIN_NATIVE_AUTH__ = {
            platform: 'ios',
            refresh: async () => {
              const result = await window.webkit.messageHandlers[
                \(Self.jsonString(Self.bridgeHandlerName))
              ].postMessage({ action: 'refresh' });
              if (result && result.status === 'succeeded') {
                localStorage.setItem('tabtin_access_token', result.accessToken);
                if (result.expiresAt != null) {
                  localStorage.setItem('tabtin_expires_at', String(result.expiresAt));
                }
              } else if (result && result.status === 'unauthenticated') {
                localStorage.removeItem('tabtin_access_token');
                localStorage.removeItem('tabtin_expires_at');
                localStorage.removeItem('tabtin_user');
              }
              localStorage.removeItem('tabtin_refresh_token');
              return result;
            }
          };
        })();
        """
    }

    private static func jsonString(_ value: String?) -> String {
        guard let value,
              let data = try? JSONEncoder().encode(value),
              let encoded = String(data: data, encoding: .utf8) else { return "null" }
        return encoded
    }
}
