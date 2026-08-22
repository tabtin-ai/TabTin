import AVFoundation
import PhotosUI
import SwiftUI
import UIKit
import UniformTypeIdentifiers

/// 会话进入目标：可从 Workspace 默认会话、从「最近」列表带具体 sessionId、
/// 或从 ➕ 新建（强制新建 session + 首条消息）三种来源进入。
struct ConversationTarget: Hashable, Sendable {
    let title: String
    /// 工具实际执行现场；Project 归属单独使用 ``projectId``，不能复用本字段。
    let workspaceId: String
    let organizationId: String
    /// Session 创建/进入时的执行 Agent；个人 Workspace 会话内可再切换。
    /// nil 时使用 Workspace 默认绑定。
    let agentId: String?
    /// 协作 Project 归属。任务的执行现场由 ``workspaceId`` 指定，二者不能混用。
    let projectId: String?
    /// 预解析好的 sessionId（来自「最近」列表）；nil 则按下面策略解析。
    let sessionId: String?
    /// 从通知等外部入口进入时要定位的服务端消息 id；普通进入会话时为 nil。
    let messageId: String?
    /// true 则强制新建一个 session（➕ 新建对话）；false 且 sessionId 为 nil 时取默认 session。
    let startsNewSession: Bool
    /// 新建任务的预填文本；只写入本地草稿，必须由用户在 Composer 明确发送。
    let initialMessage: String?
    /// 进入后随首条消息一起发送的资源上下文引用。
    let initialContextRefs: [MentionContextRef]
    let initialContextResources: [SpaceResource]

    init(
        title: String,
        workspaceId: String,
        organizationId: String,
        agentId: String? = nil,
        projectId: String? = nil,
        sessionId: String? = nil,
        messageId: String? = nil,
        startsNewSession: Bool = false,
        initialMessage: String? = nil,
        initialContextRefs: [MentionContextRef] = [],
        initialContextResources: [SpaceResource] = []
    ) {
        self.title = title
        self.workspaceId = workspaceId
        self.organizationId = organizationId
        self.agentId = agentId
        self.projectId = projectId
        self.sessionId = sessionId
        self.messageId = messageId
        self.startsNewSession = startsNewSession
        self.initialMessage = initialMessage
        self.initialContextRefs = initialContextRefs
        self.initialContextResources = initialContextResources
    }
}

/// Agent 详情里唯一会被 Composer 使用的扩展字段；列表没有它时明确留空。
private struct AgentPreferredModel: Decodable, Sendable {
    let id: String
    let preferredModelId: String?

    enum CodingKeys: String, CodingKey {
        case id
        case preferredModelId = "preferred_model_id"
    }
}

private struct ConversationDraftPersistenceKey: Equatable {
    let text: String
    let modelId: String?
    let contextTierId: String?
    let thinkingMode: String?
    let agentMode: String
    let approvalMode: String
    let agentId: String?
    let attachmentSignatures: [String]
    let contextSignatures: [String]
}

/// 移动端工作台工作面 UI；底层挂载与导航代码始终保留，可用本开关临时隐藏入口。
enum ConversationWorkbenchUIPolicy {
    static let showsSurfaceSwitcher = true
}

enum ConversationTaskWorkspaceLayoutMode: Equatable, Sendable {
    case compact
    /// 宽到足以承载 iPad 三态（对话聚焦 / 分屏 / 应用聚焦）。
    case split
}

enum ConversationTaskWorkspaceLayoutPolicy {
    /// 双栏至少为对话保留约 440pt、为工作台保留 320pt。
    static let minimumSplitWidth: CGFloat = 760

    static func mode(
        availableWidth: CGFloat,
        isRegularWidth: Bool
    ) -> ConversationTaskWorkspaceLayoutMode {
        guard isRegularWidth, availableWidth >= minimumSplitWidth else {
            return .compact
        }
        return .split
    }
}

private struct ConversationTaskWorkspace<ConversationContent: View, WorkbenchContent: View>: View {
    let horizontalSizeClass: UserInterfaceSizeClass?
    var coordinator: TaskSurfaceCoordinator
    /// 原生顶层页面由 sheet-local Picker 接管；根视图在 presentation 期间隐藏自己的切换器。
    var hidesSurfaceSwitcher: Bool
    /// 原生 App sheet 活跃时由顶层 presentation 独占对话内容，根层 direct / overlay 都不挂载。
    var hostsConversationContent: Bool
    let conversation: ConversationContent
    let workbench: WorkbenchContent

    @AppStorage("tt.taskSurface.workbenchFraction.regular")
    private var workbenchFractionRegular = 0.4
    @AppStorage("tt.taskSurface.workbenchFraction.compact")
    private var workbenchFractionCompact = 0.4
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var dragFractionOffset: Double = 0
    @State private var morphCoordinator = TaskSurfaceMorphCoordinator()
    @State private var containerFrame: CGRect = .zero
    @State private var railFrame: CGRect = .zero
    @State private var capsuleFrame: CGRect = .zero
    @State private var ghostPresentation: TaskSurfaceMorphGhostPresentation?

    init(
        horizontalSizeClass: UserInterfaceSizeClass?,
        coordinator: TaskSurfaceCoordinator,
        hidesSurfaceSwitcher: Bool = false,
        hostsConversationContent: Bool = true,
        @ViewBuilder conversation: () -> ConversationContent,
        @ViewBuilder workbench: () -> WorkbenchContent
    ) {
        self.horizontalSizeClass = horizontalSizeClass
        self.coordinator = coordinator
        self.hidesSurfaceSwitcher = hidesSurfaceSwitcher
        self.hostsConversationContent = hostsConversationContent
        self.conversation = conversation()
        self.workbench = workbench()
    }

    @ViewBuilder
    var body: some View {
        GeometryReader { proxy in
            let layoutMode = ConversationTaskWorkspaceLayoutPolicy.mode(
                availableWidth: proxy.size.width,
                isRegularWidth: horizontalSizeClass == .regular
            )
            Group {
                switch layoutMode {
                case .compact:
                    compactLayout
                case .split:
                    regularLayout(availableWidth: proxy.size.width)
                }
            }
            .onAppear {
                coordinator.updateLayoutContext(isCompactLayout: layoutMode == .compact)
                containerFrame = proxy.frame(in: .global)
            }
            .onChange(of: layoutMode) { _, mode in
                coordinator.updateLayoutContext(isCompactLayout: mode == .compact)
            }
            .onChange(of: proxy.size) { _, _ in
                containerFrame = proxy.frame(in: .global)
            }
        }
        .background(.tt.bgCanvasDefault)
    }

    private var compactLayout: some View {
        VStack(spacing: 0) {
            if ConversationWorkbenchUIPolicy.showsSurfaceSwitcher, !hidesSurfaceSwitcher {
                surfacePicker
            }
            ZStack(alignment: .bottom) {
                if coordinator.shouldMountWorkbench(isCompactLayout: true) {
                    workbench
                        .opacity(coordinator.isWorkbenchVisible(isCompactLayout: true) ? 1 : 0)
                        .allowsHitTesting(coordinator.isWorkbenchVisible(isCompactLayout: true))
                        .accessibilityHidden(!coordinator.isWorkbenchVisible(isCompactLayout: true))
                }

                if hostsConversationContent {
                    if coordinator.compactSurface == .conversation {
                        // 完整对话是独立工作面，直接获得整个内容区域；不经过 overlay
                        // 卡片，因此没有 grabber、圆角裁剪或半屏高度提案。
                        conversation
                            .frame(maxWidth: .infinity, maxHeight: .infinity)
                    } else if coordinator.isConversationLayerActive {
                        CompactConversationOverlayHost(coordinator: coordinator) {
                            conversation
                        }
                    }
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .background(.tt.bgCanvasDefault)
    }

    /// 三态：对话与工作台各挂载一次，只改 placement / frame / opacity / hitTesting。
    /// 三态切换器由 ``ConversationScreen`` 挂在标题栏（见 ``TaskViewModeSwitch``）。
    @ViewBuilder
    private func regularLayout(availableWidth: CGFloat) -> some View {
        let fraction = clampedFraction(workbenchFractionRegular + dragFractionOffset)
        let geo = TaskSurfaceStableLayout.geometry(
            mode: coordinator.viewMode,
            availableWidth: availableWidth,
            workbenchFraction: fraction
        )
        let hideRail = morphCoordinator.shouldHideRail()
        let hideCapsule = morphCoordinator.shouldHideCapsule()
        let showsFloatingConversation = hostsConversationContent
            && coordinator.viewMode == .appFocus
            && coordinator.isRegularFloatingConversationPresented(in: .rootAppFocus)
        let layoutAnimation: Animation? = reduceMotion
            ? nil
            : .timingCurve(0.77, 0, 0.175, 1, duration: TaskSurfaceMorphTiming.durationSeconds)

        ZStack(alignment: .topLeading) {
            HStack(spacing: 0) {
                Group {
                    if hostsConversationContent, !showsFloatingConversation {
                        taskPane(
                            surface: .conversation,
                            showsChrome: coordinator.viewMode == .split
                        ) {
                            conversation
                        }
                    } else {
                        Color.clear
                    }
                }
                .frame(width: geo.conversationWidth)
                .opacity(hideRail ? 0 : geo.conversationOpacity)
                .allowsHitTesting(geo.conversationAllowsHitTesting && !hideRail)
                .accessibilityHidden(!geo.conversationAllowsHitTesting)
                .clipped()
                .background {
                    GeometryReader { railProxy in
                        Color.clear.preference(
                            key: TaskSurfaceRailFrameKey.self,
                            value: railProxy.frame(in: .global)
                        )
                    }
                }

                if geo.showsDivider {
                    splitDivider(availableWidth: availableWidth)
                }

                if coordinator.shouldMountWorkbench(isCompactLayout: false) {
                    taskPane(
                        surface: .workbench,
                        showsChrome: coordinator.viewMode == .split
                    ) {
                        workbench
                    }
                    .frame(width: geo.workbenchWidth)
                    .opacity(geo.workbenchOpacity)
                    .allowsHitTesting(geo.workbenchAllowsHitTesting)
                    .accessibilityHidden(!geo.workbenchAllowsHitTesting)
                    .clipped()
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .trailing)
            .animation(layoutAnimation, value: coordinator.viewMode)
            .animation(layoutAnimation, value: geo.workbenchWidth)

            if hostsConversationContent {
                RegularConversationFloatingWindow(
                    isPresented: showsFloatingConversation,
                    placement: regularFloatingConversationPlacement,
                    onCollapse: collapseRegularFloatingConversation,
                    onBackToSplit: backToSplitFromRegularFloatingConversation
                ) {
                    conversation
                }
                .zIndex(900)
            }

            if let ghost = ghostPresentation {
                TaskSurfaceMorphGhostView(
                    presentation: ghost,
                    containerGlobal: containerFrame
                ) {
                    // 旧 generation 的 fade 回调不得清掉新一轮 hide / ghost。
                    guard morphCoordinator.isCurrentTransition(ghost.generation) else { return }
                    morphCoordinator.completeGhost(generation: ghost.generation)
                    ghostPresentation = nil
                    coordinator.setHidesCapsuleForMorph(morphCoordinator.shouldHideCapsule())
                }
                // 快速反向时靠稳定 id 强制重建，避免串动画。
                .id(ghost.id)
                .allowsHitTesting(false)
                .accessibilityHidden(true)
            }
        }
        .onPreferenceChange(TaskSurfaceRailFrameKey.self) { railFrame = $0 }
        .onPreferenceChange(TaskSurfaceCapsuleFrameKey.self) { capsuleFrame = $0 }
        .onChange(of: coordinator.viewMode) { previous, next in
            handleRegularModeMorph(from: previous, to: next, fraction: fraction)
        }
        .onChange(of: hideCapsule) { _, hide in
            coordinator.setHidesCapsuleForMorph(hide)
        }
        .onAppear {
            coordinator.setHidesCapsuleForMorph(hideCapsule)
        }
    }

    private var regularFloatingConversationPlacement: RegularConversationFloatingPlacement {
        let capsulePlacement = CapsulePlacementStore.load()
        return RegularConversationFloatingPlacement(
            side: capsulePlacement.side == .left ? .left : .right,
            yRatio: capsulePlacement.yRatio
        )
    }

    private func collapseRegularFloatingConversation() {
        let apply = {
            coordinator.collapseRegularFloatingConversation()
        }
        if reduceMotion {
            apply()
        } else {
            withAnimation(.spring(response: 0.34, dampingFraction: 0.9), apply)
        }
    }

    private func backToSplitFromRegularFloatingConversation() {
        let apply = {
            coordinator.backToSplitFromRegularFloatingConversation()
        }
        if reduceMotion {
            apply()
        } else {
            withAnimation(.spring(response: 0.34, dampingFraction: 0.9), apply)
        }
    }

    private func handleRegularModeMorph(
        from previous: TaskViewMode,
        to next: TaskViewMode,
        fraction: Double
    ) {
        let direction = morphCoordinator.beginTransition(
            from: previous,
            to: next,
            railRect: railFrame.width >= 1 ? railFrame : nil,
            capsuleRect: capsuleFrame.width >= 1 ? capsuleFrame : nil,
            reduceMotion: reduceMotion
        )
        let generation = morphCoordinator.transitionGeneration
        coordinator.setHidesCapsuleForMorph(morphCoordinator.shouldHideCapsule())
        guard let direction else {
            // 第三态 / Reduce Motion：立即清 ghost 与 hide，禁止 rail 长期透明。
            ghostPresentation = nil
            coordinator.setHidesCapsuleForMorph(false)
            return
        }

        // 等一帧布局稳定后再消费 pending（对齐 Electron rAF×2）。
        Task { @MainActor in
            await Task.yield()
            await Task.yield()
            guard morphCoordinator.isCurrentTransition(generation) else { return }
            let target: CGRect
            switch direction {
            case .toCapsule:
                // 目标必须是可见圆圈/胶囊 chrome，不是扩满 Host。
                target = capsuleFrame.width >= 1
                    ? capsuleFrame
                    : CGRect(
                        x: containerFrame.maxX - 64,
                        y: containerFrame.maxY - 64,
                        width: 48,
                        height: 48
                    )
            case .toRail:
                target = TaskSurfaceStableLayout.splitConversationTargetRect(
                    container: containerFrame,
                    workbenchFraction: fraction
                )
            }
            guard morphCoordinator.consume(
                direction: direction,
                targetRect: target,
                generation: generation
            ) else {
                guard morphCoordinator.isCurrentTransition(generation) else { return }
                coordinator.setHidesCapsuleForMorph(morphCoordinator.shouldHideCapsule())
                return
            }
            guard morphCoordinator.isCurrentTransition(generation),
                  let active = morphCoordinator.activeGhostSnapshot else { return }
            coordinator.setHidesCapsuleForMorph(morphCoordinator.shouldHideCapsule())
            ghostPresentation = TaskSurfaceMorphGhostPresentation(
                id: "\(active.direction.rawValue)-\(active.generation)-\(active.startedAt.timeIntervalSince1970)",
                direction: active.direction,
                from: active.from,
                to: active.to,
                generation: active.generation
            )
        }
    }

    private func splitDivider(availableWidth: CGFloat) -> some View {
        ZStack {
            Rectangle()
                .fill(.tt.borderLight)
                .frame(width: 0.5)
            Color.clear
                .frame(width: TaskSurfaceSplitMetrics.dividerHitWidth)
                .contentShape(Rectangle())
                .gesture(
                    DragGesture(minimumDistance: 2)
                        .onChanged { value in
                            let delta = Double(value.translation.width / max(availableWidth, 1))
                            // 向右拖 → 工作台变窄 → fraction 减小
                            dragFractionOffset = -delta
                        }
                        .onEnded { value in
                            let delta = Double(value.translation.width / max(availableWidth, 1))
                            workbenchFractionRegular = clampedFraction(
                                workbenchFractionRegular - delta
                            )
                            dragFractionOffset = 0
                            // compact 桶同步一份默认，便于日后窄屏分屏实验；当前 compact 不读它。
                            workbenchFractionCompact = workbenchFractionRegular
                        }
                )
                .onTapGesture(count: 2) {
                    let reset = {
                        workbenchFractionRegular = TaskSurfaceSplitMetrics.defaultWorkbenchFraction
                        workbenchFractionCompact = TaskSurfaceSplitMetrics.defaultWorkbenchFraction
                        dragFractionOffset = 0
                    }
                    if reduceMotion {
                        reset()
                    } else {
                        withAnimation(.easeInOut(duration: 0.18), reset)
                    }
                }
        }
        .frame(width: TaskSurfaceSplitMetrics.dividerHitWidth)
        .frame(maxHeight: .infinity)
        .accessibilityLabel("调整分屏比例")
        .accessibilityHint("左右拖动改变工作台宽度，点两下恢复默认")
        .accessibilityAddTraits(.allowsDirectInteraction)
    }

    private func clampedFraction(_ value: Double) -> Double {
        min(
            TaskSurfaceSplitMetrics.maxWorkbenchFraction,
            max(TaskSurfaceSplitMetrics.minWorkbenchFraction, value)
        )
    }

    private var surfacePicker: some View {
        CompactTaskSurfacePicker(coordinator: coordinator)
        .frame(maxWidth: .infinity, minHeight: 44)
        .padding(.horizontal, TTSpacing.md)
        .padding(.vertical, TTSpacing.xs)
        .background(.tt.bgCanvasDefault)
        .accessibilityLabel("任务工作面")
    }

    private func taskPane<PaneContent: View>(
        surface: ConversationTaskSurface,
        showsChrome: Bool,
        @ViewBuilder content: () -> PaneContent
    ) -> some View {
        VStack(spacing: 0) {
            if showsChrome {
                HStack(spacing: TTSpacing.xs) {
                    Image(systemName: surface.icon)
                        .foregroundStyle(.tt.iconAccent)
                    Text(surface.title)
                        .font(.tt.captionSemibold)
                        .foregroundStyle(.tt.textPrimary)
                    Spacer(minLength: 0)
                }
                .padding(.horizontal, TTSpacing.md)
                .frame(maxWidth: .infinity, minHeight: 44)
                .background(.tt.bgCanvasDefault)
                .overlay(alignment: .bottom) {
                    Rectangle()
                        .fill(.tt.borderLight)
                        .frame(height: 0.5)
                }
            }

            content()
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }
}

/// compact 顶部工作面切换器。所有 overlay 档位都投影为「工作台」；点击「对话」
/// 切换到独立的完整对话工作面。
struct CompactTaskSurfacePicker: View {
    var coordinator: TaskSurfaceCoordinator
    var onSelect: ((ConversationTaskSurface) -> Void)?

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    init(
        coordinator: TaskSurfaceCoordinator,
        onSelect: ((ConversationTaskSurface) -> Void)? = nil
    ) {
        self.coordinator = coordinator
        self.onSelect = onSelect
    }

    var body: some View {
        Picker(
            "任务工作面",
            selection: Binding(
                get: { coordinator.compactPickerSurface },
                set: { surface in
                    selectSurface(surface)
                }
            )
        ) {
            ForEach(ConversationTaskSurface.allCases) { surface in
                Text(surface.title).tag(surface)
            }
        }
        .pickerStyle(.segmented)
        .accessibilityLabel("任务工作面")
    }

    private func selectSurface(_ surface: ConversationTaskSurface) {
        let apply = {
            if let onSelect {
                onSelect(surface)
            } else {
                coordinator.selectCompactSurface(surface)
            }
        }
        if reduceMotion {
            apply()
        } else {
            withAnimation(.spring(response: 0.3, dampingFraction: 0.9), apply)
        }
    }
}

/// 工作台内的可拉伸对话卡片。完整对话不经过本类型，而由 compact 主工作面直接渲染。
struct CompactConversationOverlayHost<Content: View>: View {
    var coordinator: TaskSurfaceCoordinator
    let content: Content

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private static var chromeHeight: CGFloat { 44 }

    init(
        coordinator: TaskSurfaceCoordinator,
        @ViewBuilder content: () -> Content
    ) {
        self.coordinator = coordinator
        self.content = content()
    }

    var body: some View {
        GeometryReader { proxy in
            let topRatio = coordinator.conversationLayerTopRatio
            let progress = ConversationLayerGeometry.progress(topRatio: topRatio)
            let bottomSafeAreaInset = proxy.safeAreaInsets.bottom
            let viewportHeight = max(0, proxy.size.height - bottomSafeAreaInset)
            let visibleHeight = ConversationLayerGeometry.visibleHeight(
                viewportHeight: viewportHeight,
                bottomSafeAreaInset: bottomSafeAreaInset,
                topRatio: topRatio
            )
            let contentLayoutHeight = ConversationLayerGeometry.contentLayoutHeight(
                viewportHeight: viewportHeight,
                bottomSafeAreaInset: bottomSafeAreaInset,
                detent: coordinator.conversationLayerDetent,
                isDragging: coordinator.conversationLayerIsDragging
            )
            let topOffset = viewportHeight * topRatio
            let layerIsExpanded = coordinator.conversationLayerDetent != .collapsed

            ZStack(alignment: .top) {
                Color.black
                    .opacity(0.28 * progress)
                    .allowsHitTesting(false)
                    .ignoresSafeArea(.container, edges: .bottom)

                // 明确的顶部背景捕获层位于内容之上，且只覆盖真实露出的工作台区域。
                if layerIsExpanded {
                    Color.clear
                        .frame(maxWidth: .infinity)
                        .frame(height: max(0, topOffset))
                        .contentShape(Rectangle())
                        .onTapGesture {
                            collapseLayerFromBackdrop()
                        }
                        .frame(maxHeight: .infinity, alignment: .top)
                }

                layerCard(
                    visibleHeight: visibleHeight,
                    contentLayoutHeight: contentLayoutHeight,
                    viewportHeight: viewportHeight,
                    progress: progress,
                    layerIsExpanded: layerIsExpanded
                )
            }
        }
    }

    /// 背景、44pt 抓手 chrome 与对话内容必须是同一张 surface；统一裁剪才能让
    /// iOS 的顶部圆角真实落在内容上，而不是只画在被不透明内容盖住的背景后面。
    private func layerCard(
        visibleHeight: CGFloat,
        contentLayoutHeight surfaceLayoutHeight: CGFloat,
        viewportHeight: CGFloat,
        progress: CGFloat,
        layerIsExpanded: Bool
    ) -> some View {
        let conversationLayoutHeight = max(0, surfaceLayoutHeight - Self.chromeHeight)
        let shape = UnevenRoundedRectangle(
            topLeadingRadius: TTRadius.xl,
            bottomLeadingRadius: 0,
            bottomTrailingRadius: 0,
            topTrailingRadius: TTRadius.xl,
            style: .continuous
        )

        return VStack(spacing: 0) {
            layerChrome(viewportHeight: viewportHeight)
                .frame(height: Self.chromeHeight, alignment: .top)
                .background(.tt.bgCanvasDefault)
                .opacity(progress > 0 ? 1 : 0)
                .allowsHitTesting(layerIsExpanded)

            // 稳态给消息列表与 Composer 真实可见高度；拖动期固定 expanded 档位布局提案，
            // 内容区在独立 44pt chrome 下方从底部裁剪，避免抓手压在消息上。
            content
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .frame(height: conversationLayoutHeight)
                .animation(nil, value: conversationLayoutHeight)
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottom)
                .clipped()
                .allowsHitTesting(layerIsExpanded)
                .accessibilityHidden(!layerIsExpanded)
        }
        .frame(maxWidth: .infinity)
        .frame(height: max(0, visibleHeight))
        .background(.tt.bgCanvasDefault)
        .clipShape(shape)
        .shadow(
            color: Color.black.opacity(progress > 0 ? 0.16 : 0),
            radius: 24,
            y: -6
        )
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottom)
        .ignoresSafeArea(.container, edges: .bottom)
    }

    private func layerChrome(viewportHeight: CGFloat) -> some View {
        ZStack {
            ZStack {
                Capsule()
                    .fill(.tt.borderLight)
                    .frame(width: 36, height: 4)
                    .accessibilityHidden(true)
            }
            .frame(width: 88, height: 44)
            .contentShape(Rectangle())
            .gesture(layerDragGesture(viewportHeight: viewportHeight))
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(L10n.Agent.conversationLayerGrabber)
            .accessibilityAddTraits(.allowsDirectInteraction)
            .accessibilityAction(named: Text(L10n.Agent.conversationLayerExpand)) {
                guard let target = coordinator.conversationLayerExpandTarget() else { return }
                moveLayer(to: target)
            }
            .accessibilityAction(named: Text(L10n.Agent.conversationLayerCollapse)) {
                moveLayer(to: .collapsed)
            }

            conversationLayerCloseButton
                .padding(.trailing, TTSpacing.sm)
                .frame(maxWidth: .infinity, alignment: .trailing)
        }
        .frame(maxWidth: .infinity)
        .frame(height: Self.chromeHeight)
    }

    private var conversationLayerCloseButton: some View {
        Button {
            moveLayer(to: .collapsed)
        } label: {
            Image(systemName: "xmark.circle.fill")
                .font(.tt.iconSubtitle)
                .foregroundStyle(.tt.iconPrimary)
                .frame(width: 32, height: 32)
                .frame(
                    width: TTSpacing.Control.minimumTouchTarget,
                    height: TTSpacing.Control.minimumTouchTarget
                )
        }
        .buttonStyle(.plain)
        .accessibilityLabel(L10n.Common.close)
    }

    private func layerDragGesture(viewportHeight: CGFloat) -> some Gesture {
        DragGesture(minimumDistance: 4, coordinateSpace: .global)
            .onChanged { value in
                coordinator.dragConversationLayer(
                    toTranslation: value.translation.height,
                    viewportHeight: viewportHeight
                )
            }
            .onEnded { value in
                if reduceMotion {
                    _ = coordinator.settleConversationLayer(
                        velocityPointsPerSecond: value.velocity.height
                    )
                } else {
                    withAnimation(.spring(response: 0.3, dampingFraction: 0.9)) {
                        _ = coordinator.settleConversationLayer(
                            velocityPointsPerSecond: value.velocity.height
                        )
                    }
                }
            }
    }

    private func moveLayer(to target: ConversationLayerDetent) {
        if reduceMotion {
            coordinator.moveConversationLayer(to: target)
        } else {
            withAnimation(.spring(response: 0.3, dampingFraction: 0.9)) {
                coordinator.moveConversationLayer(to: target)
            }
        }
    }

    private func collapseLayerFromBackdrop() {
        if reduceMotion {
            coordinator.collapseConversationLayerFromBackdrop()
        } else {
            withAnimation(.spring(response: 0.3, dampingFraction: 0.9)) {
                coordinator.collapseConversationLayerFromBackdrop()
            }
        }
    }
}

/// iPad 三态切换器。挂在标题栏而不是工作面里——它是低频操作，
/// 既不该常驻占一整行压缩对话，也不该浮在内容上遮挡标题。
struct TaskViewModeSwitch: View {
    let current: TaskViewMode
    let onSelect: (TaskViewMode) -> Void

    var body: some View {
        HStack(spacing: 2) {
            ForEach(TaskViewMode.allCases) { mode in
                Button {
                    onSelect(mode)
                } label: {
                    Image(systemName: mode.systemImage)
                        .font(.tt.iconCaption)
                        .foregroundStyle(
                            current == mode ? Color.tt.textPrimary : Color.tt.textSecondary
                        )
                        // 标题栏高度有限：视觉 28pt，命中区靠 contentShape 撑到 44pt。
                        .frame(width: 32, height: 28)
                        .background {
                            if current == mode {
                                RoundedRectangle(cornerRadius: TTRadius.sm)
                                    .fill(.tt.bgCanvasDefault)
                            }
                        }
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(mode.title)
                .accessibilityAddTraits(current == mode ? .isSelected : [])
            }
        }
        .padding(2)
        .background(.tt.bgSubtle, in: RoundedRectangle(cornerRadius: TTRadius.md))
        .accessibilityElement(children: .contain)
        .accessibilityLabel("任务视图")
    }
}

#if DEBUG
private struct ConversationTaskWorkspacePreview: View {
    let horizontalSizeClass: UserInterfaceSizeClass
    let initialSurface: ConversationTaskSurface

    @State private var coordinator: TaskSurfaceCoordinator

    init(
        horizontalSizeClass: UserInterfaceSizeClass,
        initialSurface: ConversationTaskSurface = .conversation
    ) {
        self.horizontalSizeClass = horizontalSizeClass
        self.initialSurface = initialSurface
        let coordinator = TaskSurfaceCoordinator(persistenceKey: "preview")
        if initialSurface == .workbench {
            coordinator.selectCompactSurface(.workbench)
            coordinator.setViewMode(.split)
        }
        _coordinator = State(initialValue: coordinator)
    }

    var body: some View {
        NavigationStack {
            ConversationTaskWorkspace(
                horizontalSizeClass: horizontalSizeClass,
                coordinator: coordinator
            ) {
                ConversationPanePreview()
            } workbench: {
                WorkbenchPanePreview()
            }
            .navigationTitle("移动端功能布局重构")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItemGroup(placement: .topBarTrailing) {
                    Image(systemName: "person.crop.circle")
                    Image(systemName: "ellipsis")
                }
            }
        }
        .environment(coordinator)
        .environment(\.horizontalSizeClass, horizontalSizeClass)
    }
}

private struct ConversationPanePreview: View {
    var body: some View {
        VStack(spacing: 0) {
            ScrollView {
                VStack(spacing: TTSpacing.lg) {
                    previewMessage(
                        author: "你",
                        text: "先从给对话加上工作台分屏开始。",
                        isUser: true
                    )
                    previewMessage(
                        author: "Codex",
                        text: "已经开始。对话会保持当前上下文，工作台成为同一任务里的第二个工作面。",
                        isUser: false
                    )

                    HStack(spacing: TTSpacing.xs) {
                        ProgressView()
                            .controlSize(.small)
                        Text("正在整理本任务产物…")
                            .font(.tt.meta)
                            .foregroundStyle(.tt.textSecondary)
                        Spacer(minLength: 0)
                    }
                    .padding(.horizontal, TTSpacing.md)
                }
                .padding(TTSpacing.lg)
            }

            VStack(spacing: TTSpacing.sm) {
                HStack(spacing: TTSpacing.sm) {
                    Image(systemName: "plus")
                        .foregroundStyle(.tt.iconSecondary)
                    Text("给 Agent 发消息…")
                        .font(.tt.body)
                        .foregroundStyle(.tt.textTertiary)
                    Spacer(minLength: 0)
                    Image(systemName: "arrow.up.circle.fill")
                        .font(.tt.iconEmpty)
                        .foregroundStyle(.tt.iconAccent)
                }
                .padding(.horizontal, TTSpacing.md)
                .frame(minHeight: 48)
                .background(.tt.bgSubtle, in: RoundedRectangle(cornerRadius: TTRadius.lg))
            }
            .padding(TTSpacing.md)
            .background(.tt.bgCanvasDefault)
            .overlay(alignment: .top) {
                Rectangle()
                    .fill(.tt.borderLight)
                    .frame(height: 0.5)
            }
        }
        .background(.tt.bgCanvasDefault)
    }

    private func previewMessage(author: String, text: String, isUser: Bool) -> some View {
        HStack(alignment: .top, spacing: TTSpacing.sm) {
            if isUser {
                Spacer(minLength: 32)
            }

            VStack(alignment: isUser ? .trailing : .leading, spacing: TTSpacing.xs) {
                Text(author)
                    .font(.tt.captionMedium)
                    .foregroundStyle(.tt.textSecondary)
                Text(text)
                    .font(.tt.body)
                    .foregroundStyle(.tt.textPrimary)
                    .padding(.horizontal, TTSpacing.md)
                    .padding(.vertical, TTSpacing.sm)
                    .background(
                        isUser ? Color.tt.bgAccent.opacity(0.10) : Color.tt.bgSubtle,
                        in: RoundedRectangle(cornerRadius: TTRadius.md)
                    )
            }

            if !isUser {
                Spacer(minLength: 32)
            }
        }
    }
}

private struct WorkbenchPanePreview: View {
    private let outputs: [TaskWorkbenchOutput] = [
        TaskWorkbenchOutput(
            id: "tabdoc:preview-doc",
            resourceType: "tabdoc",
            resourceId: "preview-doc",
            title: "iOS 功能布局执行计划",
            preview: "从工作面、任务产出到自动化入口的分阶段方案。",
            timestamp: Date().addingTimeInterval(-240),
            resource: nil,
            openRequest: SpaceResourceOpenRequest(
                resourceType: "tabdoc",
                resourceId: "preview-doc",
                title: "iOS 功能布局执行计划",
                locationHint: nil
            )
        ),
        TaskWorkbenchOutput(
            id: "tabdata:preview-table",
            resourceType: "tabdata",
            resourceId: "preview-table",
            title: "端侧能力同步清单",
            preview: "iOS 与桌面端的入口和状态对照。",
            timestamp: Date().addingTimeInterval(-900),
            resource: nil,
            openRequest: SpaceResourceOpenRequest(
                resourceType: "tabdata",
                resourceId: "preview-table",
                title: "端侧能力同步清单",
                locationHint: nil
            )
        ),
    ]

    var body: some View {
        let runState = AgentRunPresentationState(
            phase: .executing,
            currentAction: "正在整理交付内容",
            failureReason: nil,
            recovery: nil
        )
        let snapshot = TaskWorkbenchSnapshot(
            resumeItem: outputs.first,
            outputs: outputs,
            latestCheckpoint: TaskWorkbenchCheckpoint(
                messageId: "preview-checkpoint",
                title: "工作台分屏基础完成",
                createdAt: Date().addingTimeInterval(-1_200),
                status: .ready,
                changedFileCount: 3,
                canRestoreResources: true
            ),
            runState: runState,
            agentName: "Codex",
            completedTodoCount: 3,
            totalTodoCount: 4
        )
        TaskWorkbenchDashboardView(
            snapshot: snapshot,
            organizationId: "org-preview",
            isResourceLoading: false,
            resourceErrorMessage: nil,
            apps: [],
            isAppCatalogLoading: false,
            appCatalogErrorMessage: nil,
            appAvailabilityErrorMessage: nil,
            openNotice: nil,
            onOpenOutput: { _ in },
            onRetryResources: {},
            onOpenCheckpoint: { _ in },
            onRequestApp: { _ in },
            onActivateApp: { _ in },
            onRetryApps: {}
        )
    }
}

#Preview("Agent 任务 · iPhone") {
    ConversationTaskWorkspacePreview(
        horizontalSizeClass: .compact,
        initialSurface: .conversation
    )
}

#Preview("Agent 任务 · iPad 分屏") {
    ConversationTaskWorkspacePreview(horizontalSizeClass: .regular)
}
#endif

/// 会话主屏（Phase 2 终点）：解析目标 session → 建 ViewModel → 消息列表 + 输入栏，
/// 能发消息并看到流式上屏。历史拉取 / 多 session 切换留待后续 Phase。
private struct EditResendDraftBlock {
    enum Source {
        case attachment(String)
        case contextRef(String)
    }

    let source: Source
    let payload: [String: Any]
}

private struct PendingEditResend {
    let recoveryToken: String
    let message: ChatMessage
    let text: String
    let modelId: String
    let blocks: [EditResendDraftBlock]
    let attachments: [ComposerLocalAttachment]
    let contextRefs: [MentionContextRef]

    init(message: ChatMessage, text: String, modelId: String) {
        recoveryToken = UUID().uuidString.lowercased()
        self.message = message
        self.text = text
        self.modelId = modelId
        blocks = message.editResendDraftBlocks
        attachments = message.editResendComposerAttachments
        contextRefs = message.editResendComposerContextRefs
    }

    var blockPayloads: [[String: Any]] {
        blocks.map(\.payload)
    }

    /// 原消息 blocks 保持 wire 载荷原样；用户在 Composer 新增的附件/引用正常追加。
    /// 若用户移除了恢复出的 chip，对应原 block 也随之移除，不会暗中再次发送。
    func composerBlockPayloads(
        attachments currentAttachments: [ComposerLocalAttachment],
        contextRefs currentContextRefs: [MentionContextRef]
    ) -> [[String: Any]] {
        let liveAttachmentIDs = Set(currentAttachments.map(\.id))
        let liveContextIDs = Set(currentContextRefs.map(\.id))
        let originalAttachmentIDs = Set(attachments.map(\.id))
        let originalContextIDs = Set(contextRefs.map(\.id))

        var payloads = blocks.compactMap { block -> [String: Any]? in
            switch block.source {
            case .attachment(let id):
                return liveAttachmentIDs.contains(id) ? block.payload : nil
            case .contextRef(let id):
                return liveContextIDs.contains(id) ? block.payload : nil
            }
        }
        payloads.append(contentsOf: currentAttachments.compactMap { attachment in
            guard !originalAttachmentIDs.contains(attachment.id) else { return nil }
            return attachment.readyBlockPayload()
        })
        payloads.append(contentsOf: currentContextRefs.compactMap { ref in
            guard !originalContextIDs.contains(ref.id) else { return nil }
            return ref.blockPayload()
        })
        return payloads
    }
}

struct ConversationScreen: View {
    let target: ConversationTarget
    let onBack: () -> Void
    let onOpenConversation: (ConversationTarget) -> Void

    @State private var loadState: LoadState = .loading
    @State private var vm: ConversationViewModel?
    @State private var draft = ""
    @State private var gateway = RealtimeGateway.shared
    @State private var modelStore = ChatModelStore.shared
    @State private var checkpointService = ChatCheckpointService.shared
    @State private var billing = BillingEventHandler.shared
    @State private var workspace = WorkspaceStore.shared
    @State private var taskSurfaceCoordinator: TaskSurfaceCoordinator
    @State private var workbenchViewModel: WorkbenchViewModel
    @State private var workbenchNavigationState = WorkbenchNavigationState()
    @State private var pendingWorkbenchOpenRequest: SpaceResourceOpenRequest?
    @State private var showSessionInfo = false
    @State private var showSessionShare = false
    @State private var sessionInfo: ChatSession?
    @State private var showArchiveConfirmation = false
    @State private var archiveBlockedReason: String?
    @State private var archiveError: String?
    @State private var isArchiving = false
    @State private var showBillingWallet = false
    @State private var showContextPicker = false
    @State private var showPhotoPicker = false
    @State private var showCamera = false
    @State private var cameraAccessIssue: CameraAccessIssue?
    @State private var showFileImporter = false
    @State private var showVoiceInput = false
    /// 胶囊长按打开的语音：识别结果默认直接发送；不污染 Composer 草稿。
    @State private var voiceInputPreferDirectSend = false
    @State private var capsuleVoiceController = CapsuleVoiceCommandController()
    @State private var workbenchVoiceNotice: String?
    @State private var selectedPhotoItems: [PhotosPickerItem] = []
    @State private var attachmentManager = ChatAttachmentManager()
    @State private var draftSessionCoordinator: ConversationDraftSessionCoordinator
    @State private var draftStore: ConversationDraftStore?
    @State private var draftPersistenceTask: Task<Void, Never>?
    @State private var draftWasConsumed = false
    /// 当前附件所在的上传上下文。首发成功前保持 draftId，避免重试时漂移到新 Session。
    @State private var attachmentUploadContextId: String?
    @State private var composerError: String?
    @State private var selectedModelId: String?
    @State private var selectedContextTierId: String?
    @State private var selectedThinkingMode: ChatModelThinkingMode?
    @State private var isSwitchingModel = false
    @State private var sessionInfoLoadGeneration = 0
    @State private var modelSelectionGeneration = 0
    @State private var runtimeSettingsGeneration = 0
    @State private var draftAgentMode = "agent"
    @State private var draftApprovalMode = "always_ask"
    /// 组织级 Agent 缓存；进对话走 ensureLoaded，避免每次进屏重打 /agents。
    @State private var myAgentsStore = MyAgentsStore.shared
    @State private var agentPreferredModelIds: [String: String] = [:]
    @State private var preferredModelAgentIdsLoaded: Set<String> = []
    /// 服务端 Session 当前绑定的执行 Agent；个人 Workspace 会话允许更新。
    @State private var sessionAgentId: String?
    @State private var isSwitchingAgent = false
    @State private var executionWorkspaceName: String?
    @State private var executionDeviceName: String?
    @State private var executionDeviceStatus: String?
    /// 避免从外部入口带来的首条消息在页面重建后重复发送。
    @State private var didSendInitial = false
    @State private var didSeedInitialDraft = false
    @State private var contextRefs: [MentionContextRef] = []
    @State private var openedMemoContext: CloudMemoDetailContext?
    @State private var contextResources: [SpaceResource] = []
    @State private var isLoadingContextResources = false
    @State private var editingMessageId: String?
    @State private var editingMessageSubmittingId: String?
    @State private var editingMessageError: String?
    @State private var pendingEditResend: PendingEditResend?
    /// 回退已生效但重发入队失败时，保留原消息非文本 blocks 的精确 wire 载荷。
    @State private var preservedEditResendPayload: PendingEditResend?
    @State private var dismissedRevertOperationKeys: Set<String> = []
    @State private var copyConfirmation: String?
    @State private var copyConfirmationTask: Task<Void, Never>?
    @State private var messageHighlightTask: Task<Void, Never>?
    @State private var scrollTargetMessageId: String?
    @State private var highlightedMessageId: String?
    @State private var showReloginConfirm = false
    @State private var showErrorModelSelector = false
    /// Workspace 缺失是硬阻断。设备离线 / 未绑定走 `remoteExecutionState`，
    /// 同样禁发，提示收在 Composer 井内（对齐 Electron remote gate）。
    @State private var executionScopeHardBlockReason: String?
    @State private var remoteExecutionState: RemoteExecutionState = .ready
    /// 发送消息时自增 → 触发消息列表强制滚到底。
    @State private var scrollToBottomToken = 0
    /// 用户在翻消息（滚动中 / 停在历史里）→ Composer 收成阅读态胶囊，把高度让给阅读。
    @State private var composerCollapsedForReading = false
    /// 输入框清空时自增 → 强制 Composer 丢弃 TextField 内部旧编辑态。
    @State private var composerResetToken = 0
    /// Composer 草稿世代：同 revision 快速连点不得重复夹带附件。
    @State private var composerDraftRevision = 0
    /// 正在发送的 draftRevision；非 nil 时同 revision 再点发送直接忽略。
    @State private var inFlightComposerRevision: Int?
    /// 本轮发送令牌：同意完成 / 迟到回调只认仍占有本 token 的 snapshot。
    @State private var inFlightComposerSendToken: String?
    /// 非空即表示会话首发已拿到可发送模型；用它驱动 sheet，避免 Bool 弹窗首帧读取到空模型。
    @State private var pendingAIConsentModel: ChatModel?
    @State private var pendingAIAction: (() -> Void)?
    @State private var pendingForkMessage: ChatMessage?
    @State private var pendingForkSession: ChatSession?
    @State private var isForking = false
    /// 入口是新会话的默认执行位置；已有会话读取到后端快照后，切换为该会话
    /// 创建时冻结的作用域，避免从“最近”等入口带来的旧值误伤发送门禁。
    @State private var executionScope: ConversationExecutionScope
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    init(
        target: ConversationTarget,
        onBack: @escaping () -> Void,
        onOpenConversation: @escaping (ConversationTarget) -> Void = { _ in }
    ) {
        self.target = target
        self.onBack = onBack
        self.onOpenConversation = onOpenConversation
        _draftSessionCoordinator = State(
            initialValue: ConversationDraftSessionCoordinator(
                draft: ConversationDraftState(target: target)
            )
        )
        _draftStore = State(initialValue: try? ConversationDraftStore())
        _executionScope = State(initialValue: .entry(
            workspaceId: target.workspaceId,
            projectId: target.projectId,
            organizationId: target.organizationId
        ))
        _workbenchViewModel = State(
            initialValue: WorkbenchViewModel(
                spaceId: target.workspaceId,
                organizationId: target.organizationId,
                sessionId: target.sessionId
            )
        )
        let persistenceKey = Self.taskSurfacePersistenceKey(for: target)
        _taskSurfaceCoordinator = State(
            initialValue: TaskSurfaceCoordinator(persistenceKey: persistenceKey)
        )
    }

    private static func taskSurfacePersistenceKey(for target: ConversationTarget) -> String {
        if let sessionId = target.sessionId?.trimmingCharacters(in: .whitespacesAndNewlines),
           !sessionId.isEmpty {
            return sessionId
        }
        return "draft:\(target.workspaceId)"
    }

    enum LoadState: Equatable {
        case loading
        case ready
        case failed(String)
    }

    /// 抽成独立 ToolbarContent：body 已经极大，内联 toolbar 会让类型检查开销失控。
    @ToolbarContentBuilder
    private var conversationToolbar: some ToolbarContent {
        // 模型选择已迁到 Composer 工具条中部（只显示名称）；顶栏只保留会话标题。
        ToolbarItem(placement: .principal) {
            titleWithConnection
        }
        ToolbarItem(placement: .topBarTrailing) {
            if ConversationWorkbenchUIPolicy.showsSurfaceSwitcher,
               horizontalSizeClass == .regular {
                TaskViewModeSwitch(current: taskSurfaceCoordinator.viewMode) { mode in
                    applyTaskViewMode(mode)
                }
            }
        }
        ToolbarItem(placement: .topBarTrailing) {
            conversationTrailingToolbarActions
        }
    }

    @ViewBuilder
    private var conversationTrailingToolbarActions: some View {
        if target.startsNewSession && !draftWasConsumed {
            draftMenu
        } else if vm != nil {
            // 不用 ToolbarItemGroup：iOS 26 会把组内按钮包进共享胶囊并两端对齐，间距会被拉很大。
            HStack(spacing: TTSpacing.xs) {
                Button(action: startNewTask) {
                    conversationToolbarIcon("square.and.pencil")
                }
                .accessibilityLabel("创建新消息")
                workMoreMenu
            }
        }
    }

    private func conversationToolbarIcon(_ systemName: String) -> some View {
        Image(systemName: systemName)
            .font(.tt.iconSubtitleMedium)
            .foregroundStyle(.tt.iconAccent)
            .frame(width: 28, height: 28)
            .contentShape(Rectangle())
    }

    var body: some View {
        AnyView(conversationInteractionChrome)
    }

    /// Base chrome + Task resource lifecycle (split for type-check).
    private var conversationBaseChrome: some View {
        withTaskWorkbenchLifecycle(
            taskWorkspace
                .navigationTitle(sessionDisplayTitle)
                .navigationBarTitleDisplayMode(.inline)
                .ttToolbarBackground()
                .toolbar { conversationToolbar }
                // 底栏显隐由 MainTabView 按栈深度权威控制。目的地再挂 ttTabBarHidden
                // 会在 pop 转场期间继续压住 hidden，直到对话页离开层级后底栏才出现。
        )
    }

    /// Sheets that used to sit inside the first AnyView firewall.
    private var conversationPresentedChrome: some View {
        AnyView(
            conversationBaseChrome
        // 键盘预热已上移到 MainTabView（进会话前在首屏空闲时预热，避免在会话页闪键盘）。
        // 进会话只在 startSession 内拉一次最新页历史（含缓存秒显 + 对账）；
        // 之后本机/别端事件由常驻通道实时渲染、轮次收尾再 reconcile，无需 onAppear 再整列表替换一次。
        .onDisappear {
            persistDraftBeforeLeaving()
            vm?.stopSession()
            copyConfirmationTask?.cancel()
            messageHighlightTask?.cancel()
            attachmentManager.clear(
                contextId: currentAttachmentContextId,
                deactivateUploaded: !target.startsNewSession || draftWasConsumed
            )
        }
        .onChange(of: draftPersistenceKey) { _, _ in
            composerDraftRevision += 1
            scheduleDraftPersistence()
        }
        .onChange(of: taskSurfaceCoordinator.viewMode) { _, _ in
            syncConversationContentVisibility()
            syncCapsuleFeed(using: vm)
        }
        .onChange(of: taskSurfaceCoordinator.compactSurface) { _, _ in
            syncConversationContentVisibility()
            syncCapsuleFeed(using: vm)
        }
        .onChange(of: taskSurfaceCoordinator.isCompactLayout) { _, _ in
            syncConversationContentVisibility()
            syncCapsuleFeed(using: vm)
        }
        .sheet(isPresented: $showSessionInfo) {
            if let sessionInfo {
                ConversationSessionInfoSheet(
                    session: sessionInfo,
                    agentName: currentAgentOption?.name,
                    workspaceName: executionWorkspaceName,
                    deviceName: executionDeviceName,
                    deviceStatus: executionDeviceStatus,
                    runtimeStatus: vm?.isStreaming == true ? "正在运行" : nil,
                    onRename: renameSession
                )
            } else {
                ContentUnavailableView("会话信息未提供", systemImage: "info.circle")
            }
        }
        .sheet(isPresented: $showSessionShare) {
            if let vm {
                ConversationSessionShareSheet(
                    sessionId: vm.sessionId,
                    organizationId: sessionInfo?.organizationId ?? target.organizationId
                )
            } else {
                ContentUnavailableView(
                    "会话尚未准备好",
                    systemImage: "square.and.arrow.up",
                    description: Text("请等待会话加载完成后重试。")
                )
            }
        }
        .sheet(item: $pendingAIConsentModel, onDismiss: {
            // 未点同意就关掉：释放 in-flight revision/token，允许用户改稿后再发。
            if pendingAIAction != nil {
                inFlightComposerRevision = nil
                inFlightComposerSendToken = nil
            }
            pendingAIAction = nil
        }) { model in
            AIDataSharingConsentSheet(
                model: model,
                allowsAcceptance: true
            ) {
                if let action = pendingAIAction {
                    pendingAIAction = nil
                    action()
                }
            }
        }
        .sheet(isPresented: $showBillingWallet) {
            NavigationStack {
                WorkspaceWalletScreen(organizationId: target.organizationId)
            }
        }
        .sheet(isPresented: $showContextPicker) {
            ContextRefPickerSheet(
                spaceId: executionScope.workspaceId,
                spaceName: executionWorkspaceName ?? target.title,
                onSelect: addContextRef,
                onClose: { showContextPicker = false }
            )
        }
        .sheet(item: $openedMemoContext) { context in
            NavigationStack {
                CloudMemoDetailScreen(context: context)
            }
        }
        .sheet(isPresented: $showCamera) {
            CameraPicker { image in
                addCameraAttachment(image)
            }
        }
        .sheet(isPresented: $showVoiceInput) {
            ChatVoiceInputOverlay(
                isPresented: $showVoiceInput,
                messages: vm?.messages ?? [],
                appHotwords: VoiceConfig.extractHotwords(
                    workspaceName: WorkspaceStore.shared.selectedOrganization?.name,
                    spaceName: target.title,
                    spaceKeywords: nil,
                    spaceTags: nil
                ),
                hasAIDataSharingConsent: PrivacyConsentStore.shared.hasAcceptedAISharing,
                onPermissionInterrupted: {
                    // 权限弹窗结束后不自动续录：关闭 overlay，要求用户重新按住。
                    showVoiceInput = false
                    voiceInputPreferDirectSend = false
                    capsuleVoiceController.handle(.consentGrantedFirstTime)
                    workbenchVoiceNotice = L10n.Privacy.aiVoiceConsentHoldAgain
                },
                onResult: handleVoiceResult
            )
            .presentationDetents([.medium])
            .presentationDragIndicator(.visible)
        }
        )
    }

    /// Importers / alerts / task observers — second AnyView firewall.
    private var conversationInteractionChrome: some View {
        AnyView(
            conversationPresentedChrome
        .photosPicker(
            isPresented: $showPhotoPicker,
            selection: $selectedPhotoItems,
            maxSelectionCount: max(1, attachmentManager.remainingSlots),
            matching: .images
        )
        .fileImporter(
            isPresented: $showFileImporter,
            allowedContentTypes: [.item],
            allowsMultipleSelection: true
        ) { result in
            handlePickedFiles(result)
        }
        .onChange(of: selectedPhotoItems) { _, items in
            guard !items.isEmpty else { return }
            Task { await handlePickedPhotos(items) }
        }
        .onReceive(NotificationCenter.default.publisher(for: .tabtinResourceNavigation)) { note in
            handleResourceNavigation(note)
        }
        .alert("提示", isPresented: Binding(
            get: { composerError != nil },
            set: { if !$0 { composerError = nil } }
        )) {
            Button("好", role: .cancel) { composerError = nil }
        } message: {
            Text(composerError ?? "")
        }
        .alert(
            cameraAccessIssue?.title ?? L10n.Camera.unavailableTitle,
            isPresented: Binding(
                get: { cameraAccessIssue != nil },
                set: { if !$0 { cameraAccessIssue = nil } }
            )
        ) {
            if cameraAccessIssue?.offersSettings == true {
                Button(L10n.Camera.openSettings) {
                    cameraAccessIssue = nil
                    if let url = URL(string: UIApplication.openSettingsURLString) {
                        UIApplication.shared.open(url)
                    }
                }
            }
            Button(
                cameraAccessIssue?.offersSettings == true ? L10n.Common.cancel : L10n.Common.close,
                role: .cancel
            ) {
                cameraAccessIssue = nil
            }
        } message: {
            Text(cameraAccessIssueMessage)
        }
        .alert(L10n.ErrorRecovery.reloginConfirmTitle, isPresented: $showReloginConfirm) {
            Button(L10n.ErrorRecovery.relogin, role: .destructive) {
                AuthService.shared.logout()
            }
            Button(L10n.Common.cancel, role: .cancel) {}
        } message: {
            Text(L10n.ErrorRecovery.reloginConfirmMessage)
        }
        .confirmationDialog(
            L10n.ErrorRecovery.selectModel,
            isPresented: $showErrorModelSelector,
            titleVisibility: .visible
        ) {
            ForEach(modelStore.availableModels) { model in
                Button(model.displayName) {
                    Task { await selectModel(model) }
                }
                .disabled(isSwitchingModel)
            }
            Button(L10n.Common.cancel, role: .cancel) {}
        }
        .alert(
            "从这里分叉？",
            isPresented: Binding(
                get: { pendingForkMessage != nil },
                set: { if !$0 { pendingForkMessage = nil } }
            )
        ) {
            Button("创建独立会话") {
                guard let message = pendingForkMessage else { return }
                pendingForkMessage = nil
                Task { await forkFromMessage(message) }
            }
            Button("取消", role: .cancel) { pendingForkMessage = nil }
        } message: {
            Text("会复制该消息之前的上下文到一个独立新会话；原会话不会改变。")
        }
        .alert(
            "分支正在复制",
            isPresented: Binding(
                get: { pendingForkSession != nil },
                set: { if !$0 { pendingForkSession = nil } }
            )
        ) {
            // pending 分支不能进入普通 Composer；否则用户可能在历史复制完成前写入新消息。
            Button("知道了", role: .cancel) { pendingForkSession = nil }
        } message: {
            let warnings = pendingForkSession?.warnings?.joined(separator: "\n")
            Text(
                warnings?.isEmpty == false
                    ? warnings!
                    : "消息正在后台复制。完成后可从会话列表打开该分支。"
            )
        }
        .confirmationDialog(
            "归档这个会话？",
            isPresented: $showArchiveConfirmation,
            titleVisibility: .visible
        ) {
            Button("归档", role: .destructive) {
                Task { await archiveCurrentSession() }
            }
            .disabled(isArchiving)
            Button("取消", role: .cancel) {}
        } message: {
            Text("归档后会话仍保留在任务列表中，并标记为“已归档”。")
        }
        .alert(
            "暂时不能归档",
            isPresented: archiveBlockedPresented
        ) {
            Button("知道了", role: .cancel) { archiveBlockedReason = nil }
        } message: {
            Text(archiveBlockedReason ?? "")
        }
        .alert(
            "归档失败",
            isPresented: archiveErrorPresented
        ) {
            Button("重试") {
                archiveError = nil
                Task { await archiveCurrentSession() }
            }
            .disabled(isArchiving)
            Button("取消", role: .cancel) { archiveError = nil }
        } message: {
            Text(archiveError ?? "请稍后重试。")
        }
        .sheet(isPresented: rewindSheetPresented) {
            if let preview = checkpointService.rollbackPreview, let vm {
                RewindPreviewSheet(
                    sessionId: vm.sessionId,
                    preview: preview,
                    intent: pendingEditResend == nil ? .rollback : .editAndResend,
                    onConfirm: { reason, plan, allowsConversationOnly in
                        if pendingEditResend != nil {
                            Task {
                                await executeEditedResendRollback(
                                    reason: reason,
                                    resourcePlan: plan,
                                    allowsConversationOnly: allowsConversationOnly
                                )
                            }
                        } else {
                            Task { await executeRollback(reason: reason, resourcePlan: plan) }
                        }
                    },
                    onDismiss: { dismissRewindPreview() },
                    onRetry: {
                        Task { await retryRewindPreview() }
                    }
                )
                .id("\(preview.previewRevision ?? "missing")|\(preview.filePreviewRevision ?? "missing")")
            }
        }
        .sheet(isPresented: $checkpointService.showRevertHistorySheet) {
            if let vm {
                RevertHistorySheet(
                    service: checkpointService,
                    sessionId: vm.sessionId,
                    onClose: { checkpointService.showRevertHistorySheet = false }
                )
            }
        }
        .onChange(of: taskSurfaceCoordinator.pendingFocusMessageId) { _, messageId in
            guard let messageId, !messageId.isEmpty else { return }
            focusMessageRow(messageId)
            taskSurfaceCoordinator.clearPendingFocusMessageId()
        }
        .onChange(of: taskSurfaceCoordinator.voiceInputRequest) { _, request in
            handleCapsuleVoiceInputRequest(request)
        }
        .background { ipadKeyboardShortcuts }
        )
    }

    private var archiveBlockedPresented: Binding<Bool> {
        Binding(
            get: { archiveBlockedReason != nil },
            set: { if !$0 { archiveBlockedReason = nil } }
        )
    }

    private var archiveErrorPresented: Binding<Bool> {
        Binding(
            get: { archiveError != nil },
            set: { if !$0 { archiveError = nil } }
        )
    }

    private var rewindSheetPresented: Binding<Bool> {
        Binding(
            get: { checkpointService.showRewindSheet },
            set: { if !$0 { dismissRewindPreview() } }
        )
    }

    /// Task resources 生命周期：session 就绪首拉 + scope/output/run 刷新。
    @ViewBuilder
    private func withTaskWorkbenchLifecycle<Content: View>(_ content: Content) -> some View {
        content
            .task {
                await restoreDraftIfAvailable()
                await resolveSession()
                // session 就绪后显式首拉（不依赖 WorkbenchContainer 是否已挂载）。
                await refreshTaskResourcesForCurrentSession()
                await loadAgentCandidates()
                await loadContextResourcesIfNeeded()
            }
            .task(id: executionScope.workspaceId) {
                await monitorSpaceRuntimeStatus()
            }
            .onChange(of: executionScope.workspaceId) { _, _ in
                Task { await refreshTaskResourcesForCurrentSession() }
            }
            .onChange(of: target.organizationId) { _, _ in
                Task { await refreshTaskResourcesForCurrentSession() }
            }
            .onChange(of: vm?.sessionId) { _, sessionId in
                guard let sessionId, !sessionId.isEmpty else { return }
                taskSurfaceCoordinator.updatePersistenceKey(sessionId)
                Task { await refreshTaskResourcesForCurrentSession() }
            }
            .onChange(of: sessionAgentId) { _, agentId in
                vm?.executionAgentId = agentId
            }
            .onChange(of: taskWorkbenchOutputIdentityKey) { _, _ in
                workbenchViewModel.syncPendingOverlays(from: workbenchSnapshot.outputs)
                Task { await refreshTaskResourcesForCurrentSession() }
            }
            .onChange(of: taskWorkbenchRunTerminalKey) { oldValue, newValue in
                guard newValue != "run:active", newValue != "phase:active" else { return }
                guard oldValue == "run:active" || oldValue == "phase:active" || oldValue.isEmpty else {
                    return
                }
                Task { await refreshTaskResourcesForCurrentSession() }
            }
    }

    /// iPad：⌘1/2/3 切三态，⌘↩ 发送。compact 下隐藏（仍挂载但禁用，避免误触）。
    @ViewBuilder
    private var ipadKeyboardShortcuts: some View {
        let enabled = ConversationWorkbenchUIPolicy.showsSurfaceSwitcher
            && horizontalSizeClass == .regular
        Group {
            Button("对话聚焦") {
                applyTaskViewMode(.chatFocus)
            }
            .keyboardShortcut("1", modifiers: .command)

            Button("分屏") {
                applyTaskViewMode(.split)
            }
            .keyboardShortcut("2", modifiers: .command)

            Button("应用聚焦") {
                applyTaskViewMode(.appFocus)
            }
            .keyboardShortcut("3", modifiers: .command)

            Button("发送") {
                Task { await sendCurrentDraft() }
            }
            .keyboardShortcut(.return, modifiers: .command)
        }
        .opacity(0)
        .frame(width: 0, height: 0)
        .allowsHitTesting(false)
        .accessibilityHidden(true)
        .disabled(!enabled)
    }

    private func applyTaskViewMode(_ mode: TaskViewMode) {
        guard horizontalSizeClass == .regular else { return }
        // 布局宽度动画与 ghost 由 ConversationTaskWorkspace / MorphCoordinator 对齐 420ms；
        // Reduce Motion 时 Workspace 跳过动画并立即切换。
        taskSurfaceCoordinator.setViewMode(mode)
    }

    /// 终态自动已读门禁：仅对话面板真实可见时才允许 ACK。
    /// 工作面切换后同步可见性，并刷新胶囊 feed（HITL/未读归属随可见性变）。
    private func syncConversationContentVisibility() {
        let visible = taskSurfaceCoordinator.isConversationVisible(
            isCompactLayout: taskSurfaceCoordinator.isCompactLayout
        )
        vm?.setConversationContentVisible(visible)
    }

    private func syncCapsuleFeed(using vm: ConversationViewModel?) {
        let completed = vm?.todoItems.filter {
            $0.status.lowercased() == "completed"
        }.count ?? 0
        let total = vm?.todoItems.count ?? 0
        let runState: AgentRunPresentationState
        let pendingApproval: Bool
        let pendingAnswer: Bool
        if let vm {
            runState = runPresentation(for: vm)
            switch vm.hitl.pending {
            case .askUser, .askForm:
                pendingAnswer = true
                pendingApproval = false
            case .approvalBatch, .actionApproval, .requestApproval:
                pendingAnswer = false
                pendingApproval = true
            case .none, .planProposal, .modeSwitch:
                pendingAnswer = false
                pendingApproval = vm.hitl.pendingCount > 0
            }
        } else {
            runState = .idle
            pendingApproval = false
            pendingAnswer = false
        }
        let agent = currentAgentOption
        let avatarURL: String? = {
            guard let raw = agent?.avatar?.trimmingCharacters(in: .whitespacesAndNewlines),
                  !raw.isEmpty,
                  let url = URL(string: raw),
                  let scheme = url.scheme?.lowercased(),
                  scheme == "http" || scheme == "https"
            else { return nil }
            return raw
        }()
        taskSurfaceCoordinator.updateCapsuleFeed(
            agentName: agent?.name ?? "Agent",
            avatarKey: agent?.avatarPreset?.rawValue,
            avatarURL: avatarURL,
            runState: runState,
            completedTodoCount: completed,
            totalTodoCount: total,
            pendingApproval: pendingApproval,
            pendingAnswer: pendingAnswer
        )
    }

    private func openPlan(_ proposal: PlanProposal) {
        let reference = proposal.planDocumentId.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !reference.isEmpty else {
            composerError = "这个 Plan 没有可打开的文档或文件引用。"
            return
        }
        let lowercased = reference.lowercased()
        let looksLikeFile = reference.contains("/")
            || lowercased.hasSuffix(".md")
            || lowercased.hasPrefix("file:")
        pendingWorkbenchOpenRequest = SpaceResourceOpenRequest(
            resourceType: looksLikeFile ? "tabfiles" : "tabdoc",
            resourceId: reference,
            title: proposal.planName.isEmpty ? "Plan" : proposal.planName,
            locationHint: looksLikeFile ? reference : "Plan 文档"
        )
        presentWorkbench(opening: pendingWorkbenchOpenRequest)
    }

    private var draftMenu: some View {
        Menu {
            Button(role: .destructive) {
                Task { await discardDraftAndClose() }
            } label: {
                Label("丢弃草稿", systemImage: "trash")
            }
        } label: {
            conversationToolbarIcon("ellipsis.circle")
        }
        .accessibilityLabel("草稿操作")
    }

    private var workMoreMenu: some View {
        Menu {
            Button {
                showSessionInfo = true
            } label: {
                Label("会话信息", systemImage: "info.circle")
            }
            Button {
                showSessionShare = true
            } label: {
                Label("共享", systemImage: "square.and.arrow.up")
            }

            Divider()

            Button(role: .destructive) {
                requestArchive()
            } label: {
                Label(isArchiving ? "正在归档…" : "归档", systemImage: "archivebox")
            }
            .disabled(isArchiving)
        } label: {
            conversationToolbarIcon("ellipsis.circle")
        }
        .accessibilityLabel("更多")
    }

    private var titleWithConnection: some View {
        HStack(spacing: 6) {
            Circle()
                .fill(sessionReadyIndicatorColor)
                .frame(width: 7, height: 7)
                .accessibilityHidden(true)
            Text(sessionDisplayTitle)
                .font(.tt.bodySemibold)
                .foregroundStyle(.tt.textPrimary)
                .lineLimit(1)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(sessionDisplayTitle)，\(sessionReadyIndicatorAccessibilityText)")
    }

    private var sessionDisplayTitle: String {
        guard let title = sessionInfo?.title?.trimmingCharacters(in: .whitespacesAndNewlines), !title.isEmpty else {
            return target.title
        }
        return title
    }

    private var taskWorkspace: some View {
        ConversationTaskWorkspace(
            horizontalSizeClass: horizontalSizeClass,
            coordinator: taskSurfaceCoordinator,
            hidesSurfaceSwitcher: ConversationTaskSurfaceSwitcherPolicy.hides(
                featureEnabled: ConversationWorkbenchUIPolicy.showsSurfaceSwitcher,
                isRegularLayout: horizontalSizeClass == .regular,
                hasPresentedPage: workbenchNavigationState.presentedPage != nil,
                hasEmbeddedAppHome: workbenchNavigationState.appHome != nil,
                hasEmbeddedPath: !workbenchNavigationState.path.isEmpty
            ),
            // UIKit presentation 是新的 hosting controller。原生 App sheet 出现后，
            // 由 sheet 内 portal 独占对话树，底层不再同时挂载第二份会话 UI。
            hostsConversationContent: workbenchNavigationState.presentedPage == nil
        ) {
            content
        } workbench: {
            workbenchPane
        }
        .environment(taskSurfaceCoordinator)
        .environment(capsuleVoiceController)
        .environment(\.capsuleHITLCoordinator, vm?.hitl)
        .onAppear {
            if !ConversationWorkbenchUIPolicy.showsSurfaceSwitcher {
                taskSurfaceCoordinator.returnToConversation()
            }
            bindCapsuleVoiceHandlers()
        }
    }

    private var workbenchPane: some View {
        WorkbenchContainerView(
            organizationId: target.organizationId,
            initialOpenRequest: pendingWorkbenchOpenRequest,
            presentation: .taskPane,
            viewModel: workbenchViewModel,
            navigationState: workbenchNavigationState,
            conversationLayerContent: { AnyView(content) },
            presentedPageIsCompactLayout: taskSurfaceCoordinator.isCompactLayout,
            regularConversationFloatingHost: { conversationContent in
                AnyView(
                    RegularConversationFloatingWindow(
                        isPresented:
                            taskSurfaceCoordinator.isRegularFloatingConversationPresented(
                                in: .presentedPage
                            ),
                        placement: regularFloatingConversationPlacement,
                        onCollapse: collapseRegularConversationFloatingWindow,
                        onBackToSplit: nil
                    ) {
                        conversationContent
                    }
                )
            },
            taskSnapshot: workbenchSnapshot,
            onOpenCheckpoint: { checkpoint in
                guard let message = vm?.messages.first(where: { $0.id == checkpoint.messageId }) else {
                    return
                }
                Task { await showRewindPreview(message: message) }
            },
            onRequestApp: requestWorkbenchApp,
            onReturnToConversation: {
                handleCapsuleReturnToConversation()
            },
            onSendToConversation: { ref in
                addContextRef(ref)
                workbenchNavigationState.closeAppHome()
                handleCapsuleReturnToConversation()
            }
        )
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .environment(taskSurfaceCoordinator)
        .environment(capsuleVoiceController)
        .onChange(of: workbenchNavigationState.presentedPage) {
            if workbenchNavigationState.presentedPage != nil {
                taskSurfaceCoordinator.collapseRegularRootFloatingConversation()
            }
        }
    }

    private var regularFloatingConversationPlacement: RegularConversationFloatingPlacement {
        let capsulePlacement = CapsulePlacementStore.load()
        return RegularConversationFloatingPlacement(
            side: capsulePlacement.side == .left ? .left : .right,
            yRatio: capsulePlacement.yRatio
        )
    }

    private func collapseRegularConversationFloatingWindow() {
        let apply = {
            taskSurfaceCoordinator.collapseRegularFloatingConversation()
        }
        if reduceMotion {
            apply()
        } else {
            withAnimation(.spring(response: 0.34, dampingFraction: 0.9), apply)
        }
    }

    private var workbenchSnapshot: TaskWorkbenchSnapshot {
        guard let vm else {
            return .empty(agentName: currentAgentOption?.name ?? "Agent")
        }
        let completedTodoCount = vm.todoItems.filter {
            $0.status.lowercased() == "completed"
        }.count
        return TaskWorkbenchProjector.project(
            messages: vm.messages,
            subagentRuns: vm.subagentRuns,
            resources: workbenchViewModel.resources,
            currentRoute: workbenchNavigationState.path.last,
            runState: runPresentation(for: vm),
            agentName: currentAgentOption?.name ?? "Agent",
            completedTodoCount: completedTodoCount,
            totalTodoCount: vm.todoItems.count
        )
    }

    /// Agent 输出资源身份集合；变化时刷新 Task resources，并用 outputs 做 pending overlay。
    private var taskWorkbenchOutputIdentityKey: String {
        workbenchSnapshot.outputs
            .map { "\(SpaceResource.normalizedType($0.resourceType)):\($0.resourceId)" }
            .sorted()
            .joined(separator: "\u{1e}")
    }

    /// Run 进入终态时的稳定键；仅在从非终态切到终态时触发刷新。
    private var taskWorkbenchRunTerminalKey: String {
        if let status = vm?.authoritativeRunStatus {
            return status.isTerminal ? "run:\(status.rawValue)" : "run:active"
        }
        switch workbenchSnapshot.runState.phase {
        case .completed(let hasUnread):
            return "phase:completed:\(hasUnread)"
        case .failed:
            return "phase:failed"
        default:
            return "phase:active"
        }
    }

    /// 真实 session id 就绪后的显式 Task resources 刷新（scope + load）。
    /// 刷新后始终用当前对话 outputs 重建 pending overlay：
    /// `onChange(of: outputIdentity)` 不会在首帧触发，否则对话已有文档时 App 首页仍空。
    private func refreshTaskResourcesForCurrentSession() async {
        let sessionId = (vm?.sessionId ?? target.sessionId)?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        workbenchViewModel.updateScope(
            spaceId: executionScope.workspaceId,
            organizationId: target.organizationId,
            sessionId: sessionId
        )
        guard let sessionId, !sessionId.isEmpty else { return }
        await workbenchViewModel.refreshTaskResources(sessionId: sessionId)
        workbenchViewModel.syncPendingOverlays(from: workbenchSnapshot.outputs)
    }

    private func requestWorkbenchApp(_ app: TaskWorkbenchApp) {
        let prompt = app.agentRequestPrompt
        let trimmedDraft = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        draft = trimmedDraft.isEmpty ? prompt : "\(draft)\n\(prompt)"
        selectTaskSurface(.conversation)
    }

    private func selectTaskSurface(_ surface: ConversationTaskSurface) {
        guard ConversationWorkbenchUIPolicy.showsSurfaceSwitcher || surface == .conversation else {
            return
        }
        let isRegularSplitCapable = horizontalSizeClass == .regular
        let apply = {
            taskSurfaceCoordinator.selectSurface(
                surface,
                isRegularSplitCapable: isRegularSplitCapable
            )
        }
        if reduceMotion {
            apply()
        } else {
            withAnimation(.easeInOut(duration: 0.18), apply)
        }
    }

    /// 胶囊单击：回对话；有稳定 message id 则定位，否则滚到底。
    private func handleCapsuleReturnToConversation() {
        if !taskSurfaceCoordinator.isCompactLayout {
            let hasPresentedPage = workbenchNavigationState.presentedPage != nil
            guard hasPresentedPage || taskSurfaceCoordinator.viewMode == .appFocus else {
                return
            }
            let openFloatingConversation = {
                if hasPresentedPage {
                    taskSurfaceCoordinator.openRegularPresentedPageFloatingConversation()
                } else {
                    taskSurfaceCoordinator.openRegularFloatingConversation()
                }
            }
            if reduceMotion {
                openFloatingConversation()
            } else {
                withAnimation(.spring(response: 0.34, dampingFraction: 0.9)) {
                    openFloatingConversation()
                }
            }
            return
        }

        let focusId = resolveCapsuleFocusMessageId()
        let apply = {
            taskSurfaceCoordinator.returnToConversation(focusingMessageId: focusId)
        }
        if reduceMotion {
            apply()
        } else {
            withAnimation(.easeInOut(duration: 0.18), apply)
        }
        if focusId == nil {
            scrollToBottomToken += 1
        }
    }

    /// HITL 暂无稳定 message id；优先定位正在流式的助手消息。
    private func resolveCapsuleFocusMessageId() -> String? {
        guard let vm else { return nil }
        if let streaming = vm.messages.last(where: { $0.isAssistant && $0.isStreaming }) {
            return streaming.id
        }
        return nil
    }

    private func presentWorkbench(opening request: SpaceResourceOpenRequest? = nil) {
        if let request {
            pendingWorkbenchOpenRequest = request
            workbenchNavigationState.open(
                request,
                resources: workbenchViewModel.resources
            )
        }
        guard ConversationWorkbenchUIPolicy.showsSurfaceSwitcher else { return }
        let apply = {
            taskSurfaceCoordinator.presentWorkbench(
                isRegularSplitCapable: horizontalSizeClass == .regular
            )
        }
        if reduceMotion {
            apply()
        } else {
            withAnimation(.easeInOut(duration: 0.18), apply)
        }
    }

    @ViewBuilder
    private var content: some View {
        switch loadState {
        case .loading:
            ProgressView("加载会话…")
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        case let .failed(message):
            TTErrorStateView(
                message: message,
                systemImage: "exclamationmark.bubble",
                prominence: .inline
            ) { Task { await resolveSession() } }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        case .ready:
            if let vm {
                activeConversation(vm)
            } else {
                draftConversation
            }
        }
    }

    private var draftConversation: some View {
        VStack(spacing: 0) {
            Spacer(minLength: 0)
            VStack(spacing: TTSpacing.md) {
                Text("今天想和 \(draftWelcomeAgentName) 一起完成什么？")
                    .font(.tt.subtitleSemibold)
                    .foregroundStyle(.tt.textPrimary)
                    .multilineTextAlignment(.center)
                composer(using: nil)
            }
            .frame(maxWidth: 620)
            .frame(maxWidth: .infinity)
            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(.tt.bgCanvasDefault)
    }

    private var draftWelcomeAgentName: String {
        currentAgentOption?.name ?? (currentAgentId == nil ? "Agent" : currentAgentFallbackName)
    }

    private func activeConversation(_ vm: ConversationViewModel) -> some View {
        activeConversationDecorated(vm)
    }

    private func activeConversationDecorated(_ vm: ConversationViewModel) -> some View {
        activeConversationSyncOverlay(
            activeConversationAnimated(activeConversationStack(vm), vm: vm),
            vm: vm
        )
    }

    private func activeConversationStack(_ vm: ConversationViewModel) -> some View {
        VStack(spacing: 0) {
            activeConversationBanners(vm)
            activeConversationMessageList(vm)
        }
    }

    private func activeConversationAnimated<Content: View>(
        _ content: Content,
        vm: ConversationViewModel
    ) -> some View {
        content
            .background(.tt.bgCanvasDefault)
            .animation(.easeInOut(duration: 0.2), value: vm.hitl.pending?.id)
            .animation(.easeInOut(duration: 0.2), value: vm.connectionInterrupted)
            .animation(.easeInOut(duration: 0.2), value: vm.recoveryState)
    }

    private func activeConversationSyncOverlay<Content: View>(
        _ content: Content,
        vm: ConversationViewModel
    ) -> some View {
        content
            .onAppear {
                syncConversationContentVisibility()
                syncCapsuleFeed(using: vm)
            }
            .onChange(of: vm.isStreaming) { _, _ in syncCapsuleFeed(using: vm) }
            .onChange(of: vm.phase) { _, _ in syncCapsuleFeed(using: vm) }
            .onChange(of: vm.isPaused) { _, _ in syncCapsuleFeed(using: vm) }
            .onChange(of: vm.todoItems.count) { _, _ in syncCapsuleFeed(using: vm) }
            .onChange(of: vm.hitl.pendingCount) { _, _ in syncCapsuleFeed(using: vm) }
            .onChange(of: vm.queuedOutgoingMessages.count) { _, _ in syncCapsuleFeed(using: vm) }
            .onChange(of: vm.messages.count) { _, _ in syncCapsuleFeed(using: vm) }
            .onChange(of: vm.authoritativeReadState?.readAt) { _, _ in syncCapsuleFeed(using: vm) }
            .overlay { activeConversationRestoreOverlay() }
            .overlay(alignment: .top) { activeConversationCopyConfirmationOverlay() }
    }

    @ViewBuilder
    private func activeConversationRestoreOverlay() -> some View {
        if let phase = checkpointService.restoringPhase {
            RestoreOverlay(phase: phase)
        } else if checkpointService.isLoadingPreview {
            RestoreOverlay(phase: "preparing")
        }
    }

    @ViewBuilder
    private func activeConversationCopyConfirmationOverlay() -> some View {
        if let copyConfirmation {
            Text(copyConfirmation)
                .font(.tt.metaSemibold)
                .foregroundStyle(.tt.textPrimary)
                .padding(.horizontal, TTSpacing.md)
                .padding(.vertical, TTSpacing.xs)
                .background(.thinMaterial, in: Capsule())
                .padding(.top, TTSpacing.lg)
                .transition(.move(edge: .top).combined(with: .opacity))
        }
    }

    @ViewBuilder
    private func activeConversationBanners(_ vm: ConversationViewModel) -> some View {
        // gateway 终止态先于恢复链：鉴权失效/已放弃重连时不能继续暗示“正在重连”。
        // 其余真实断线后的恢复链则优先于普通的“已连接”绿点，避免把 HTTP 对账提前说成成功。
        if let info = terminalConnectionBannerInfo {
            StatusBanner(style: info.style, icon: info.icon,
                         text: info.text, showsProgress: info.showsProgress,
                         placement: .insetRounded())
        } else if let recovery = ConversationRecoveryPresentation.banner(for: vm.recoveryState) {
            recoveryBanner(recovery, vm: vm)
        } else if !vm.connectionInterrupted, let info = connectionBannerInfo {
            StatusBanner(style: info.style, icon: info.icon,
                         text: info.text, showsProgress: info.showsProgress,
                         placement: .insetRounded())
        }
        if let notice = vm.systemNotice {
            StatusBanner(style: .warning, icon: "pause.circle",
                         text: notice, showsProgress: false,
                         placement: .insetRounded())
        }
        if let actionError = vm.actionError {
            StatusBanner(style: .critical, icon: "exclamationmark.triangle.fill",
                         text: actionError, showsProgress: false,
                         placement: .insetRounded())
        }
        if let notice = workbenchVoiceNotice {
            StatusBanner(
                style: .accent,
                icon: "waveform",
                text: notice,
                showsProgress: false,
                placement: .insetRounded()
            )
            .onTapGesture { workbenchVoiceNotice = nil }
        }
        if let banner = billingBannerInfo(vm) {
            BillingBlockedBanner(title: banner.title, message: banner.message)
        }
        if let state = checkpointService.rollbackState(for: vm.sessionId),
           state.revertActive == true,
           state.lastOperationMode != "editAndResend",
           !dismissedRevertOperationKeys.contains(state.operationKey) {
            RevertBanner(
                state: state,
                onUnrevert: { Task { await executeUnrevert() } },
                onHistory: { checkpointService.showRevertHistorySheet = true },
                onRetryResources: { Task { await retryRollbackResources(state.retryableItems) } },
                onDismiss: { dismissedRevertOperationKeys.insert(state.operationKey) }
            )
        }
        if !vm.todoItems.isEmpty {
            TodoPanel(
                items: vm.todoItems,
                paused: !vm.isStreaming,
                awaitingSubagents: TodoStripPresentation.awaitingSubagents(vm.subagentRuns)
            )
        }
    }

    private func activeConversationMessageList(_ vm: ConversationViewModel) -> some View {
        // 输入区由 MessageListView 作为底部 overlay 悬浮；列表保持全高，footer 实测高度
        // 写入 UIScrollView.contentInset.bottom，内容可经过玻璃下方且贴底不被遮挡。
        MessageListView(
            messages: timelineMessages(for: vm),
            tipRowModel: vm.tipRowModel,
            tipRowLayoutRevision: vm.tipRowLayoutRevision,
            agentOptions: composerAgentOptions,
            subagentRuns: vm.subagentRuns,
            onCancelSubagent: { vm.cancelSubagent($0) },
            onExecutePlan: { await vm.executePlan($0) },
            onOpenPlan: openPlan,
            onApproveModeSwitch: { vm.approveModeSwitch($0) },
            onIgnoreProposal: { vm.ignoreProposal(cardId: $0) },
            onRewind: { message in
                Task { await showRewindPreview(message: message) }
            },
            onRollbackAgentRun: { agentRunId in
                Task { await rollbackAgentRun(agentRunId) }
            },
            editingMessageId: editingMessageId,
            isEditSubmitting: editingMessageSubmittingId != nil || checkpointService.isReverting,
            editError: editingMessageError,
            onCopyMessage: handleCopyMessage,
            onQuoteMessage: { message in
                guard let updatedDraft = MessageQuote.replacingComposerQuote(
                    in: draft,
                    with: message
                ) else { return }
                draft = updatedDraft
                composerCollapsedForReading = false
            },
            onEditMessage: beginEditingMessage,
            onCancelEdit: cancelEditingMessage,
            onSubmitEdit: { message, text in
                Task { await submitEditedMessage(message, text: text) }
            },
            onForkMessage: { message in
                requestFork(from: message)
            },
            onErrorAction: { action, message in
                handleErrorAction(action, message: message)
            },
            scrollToBottomToken: scrollToBottomToken,
            scrollTargetMessageId: scrollTargetMessageId,
            highlightedMessageId: highlightedMessageId,
            preventsInitialBottomScroll: target.messageId != nil,
            isLoadingEarlier: vm.isLoadingEarlier,
            earlierPrependToken: vm.earlierPrependToken,
            onLoadEarlier: { Task { await vm.loadEarlier() } },
            onScrollStateChange: applyMessageScrollState
        ) {
            activeConversationInputFooter(vm)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    /// 翻消息即收敛、回到最新即展开。动画交给 ComposerView 内部那一段（它同时驱动
    /// footer 高度 → 列表底部 inset），这里只翻状态，避免两层动画叠加。
    private func applyMessageScrollState(_ state: MessageListScrollState) {
        let collapse = ComposerReadingCollapsePolicy.scrollWantsCollapse(state)
        guard collapse != composerCollapsedForReading else { return }
        composerCollapsedForReading = collapse
    }

    @ViewBuilder
    private func activeConversationInputFooter(_ vm: ConversationViewModel) -> some View {
        VStack(spacing: 0) {
            HITLPanelHost(coordinator: vm.hitl)
            OutgoingQueueStrip(
                messages: vm.queuedOutgoingMessages,
                agentBusy: vm.isStreaming || vm.canCancel,
                onRetry: { vm.retryQueuedMessage($0) },
                onRemoveUnsent: { vm.removeQueuedMessage($0) },
                onHideAcceptedTracking: { vm.hideAcceptedOutgoingTracking($0) }
            )
            composer(using: vm)
        }
        .ttComposerTopScrim()
    }

    @ViewBuilder
    private func recoveryBanner(
        _ recovery: ConversationRecoveryBanner,
        vm: ConversationViewModel
    ) -> some View {
        VStack(spacing: 0) {
            StatusBanner(
                style: statusBannerStyle(for: recovery.style),
                icon: recovery.icon,
                text: recovery.text,
                showsProgress: recovery.showsProgress,
                placement: .insetRounded()
            )
            if recovery.offersRetry {
                Button {
                    vm.retryRecoveryReconciliation()
                } label: {
                    Label("重新核对", systemImage: "arrow.clockwise")
                        .font(.tt.captionSemibold)
                }
                .buttonStyle(.plain)
                .foregroundStyle(.tt.textCritical)
                .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                .padding(.horizontal, TTSpacing.lg)
                .contentShape(Rectangle())
                .accessibilityHint("重新向服务器拉取会话历史并核对消息")
            }
        }
    }

    private func statusBannerStyle(
        for style: ConversationRecoveryBanner.Style
    ) -> StatusBanner.Style {
        switch style {
        case .warning: return .warning
        case .critical: return .critical
        case .accent: return .accent
        }
    }

    private var currentAgentId: String? {
        if vm != nil {
            return sessionAgentId ?? target.agentId ?? draftSessionCoordinator.agentId
        }
        return draftSessionCoordinator.agentId
    }

    private var canChangeExecutionAgent: Bool {
        ConversationAgentSelectionPolicy.canChange(
            isTeamSpace: isTeamExecutionSpace,
            isFirstSendInFlight: draftSessionCoordinator.isFirstSendInFlight,
            isUpdating: isSwitchingAgent
        )
    }

    /// 对齐 Electron 草稿态 Folder：仅本地草稿、尚未首发建会话时可切换执行 Workspace。
    private var canSwitchExecutionWorkspace: Bool {
        target.startsNewSession && vm == nil && !draftSessionCoordinator.isFirstSendInFlight
    }

    private var switchableExecutionWorkspaces: [ComposerExecutionWorkspaceOption] {
        workspace.spaces
            .filter(\.isExecutionSpace)
            .map {
                ComposerExecutionWorkspaceOption(
                    id: $0.id,
                    name: $0.name,
                    organizationId: $0.organizationId
                )
            }
    }

    /// 对齐 Electron 的 `isTeamDraftSpace`：判断执行 Space 本身，而不是 session.project_id。
    ///
    /// Project 成员的 companion Workspace 是个人执行现场，即使 Session 带 project_id 也可换 Agent。
    private var isTeamExecutionSpace: Bool {
        let workspaceId = executionScope.workspaceId
        if let space = workspace.spaces.first(where: { $0.id == workspaceId }) {
            return space.isProject
        }
        return target.projectId == workspaceId
    }

    private var currentAgentOption: ComposerTaskAgentOption? {
        guard let currentAgentId else { return nil }
        return composerAgentOptions.first(where: { $0.id == currentAgentId })
    }

    private var currentAgentFallbackName: String {
        currentAgentId == nil ? "请选择 Agent" : "Agent 信息未提供"
    }

    private var composerAgentOptions: [ComposerTaskAgentOption] {
        // 只展示当前会话组织下的缓存，避免短暂串到上一组织。
        guard myAgentsStore.loadedOrganizationId == target.organizationId else { return [] }

        let preferred: (String) -> String? = { agentId in
            agentPreferredModelIds[agentId].flatMap(modelDisplayName)
                ?? agentPreferredModelIds[agentId]
        }

        var options = myAgentsStore.agents.map { agent in
            let avatarURL = nonEmpty(agent.settings?.avatarURL)
            return ComposerTaskAgentOption(
                id: agent.id,
                name: agent.displayName,
                avatar: avatarURL ?? nonEmpty(agent.icon),
                avatarPreset: agent.avatarPreset
                    ?? nonEmpty(agent.icon).flatMap(AgentAvatarPreset.init(rawValue:)),
                defaultModelName: preferred(agent.id),
                isAvailable: agent.isActive != false,
                unavailableReason: agent.isActive == false ? "Agent 已停用" : nil
            )
        }

        let activeIds = Set(options.map(\.id))
        for agent in myAgentsStore.deactivatedAgents where !activeIds.contains(agent.id) {
            let avatarURL = nonEmpty(agent.settings?.avatarURL)
            options.append(ComposerTaskAgentOption(
                id: agent.id,
                name: agent.name,
                avatar: avatarURL,
                avatarPreset: agent.avatarPreset,
                defaultModelName: preferred(agent.id),
                isAvailable: false,
                unavailableReason: "Agent 已停用"
            ))
        }

        return options.sorted { lhs, rhs in
            if lhs.isAvailable != rhs.isAvailable { return lhs.isAvailable && !rhs.isAvailable }
            return lhs.name.localizedCaseInsensitiveCompare(rhs.name) == .orderedAscending
        }
    }

    private func modelDisplayName(_ modelId: String) -> String? {
        modelStore.availableModels.first(where: { $0.id == modelId })?.displayName
    }

    private func nonEmpty(_ value: String?) -> String? {
        guard let value else { return nil }
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    private func composer(using vm: ConversationViewModel?) -> some View {
        let remoteExecutionNotice = RemoteExecutionNoticePresentation.notice(
            for: remoteExecutionState
        )
        // Workspace 缺失优先；其次远程执行设备不可达。一律进井内禁发，不外挂横幅。
        let composerDisabledReason = executionScopeHardBlockReason
            ?? RemoteExecutionNoticePresentation.composerDisabledReason(
                for: remoteExecutionState
            )
        return VStack(spacing: 0) {
            // 对话面不再挂 AgentRunDock：运行态已在气泡时间轴呈现，停止走 Composer 主按钮
            //（对齐 Electron，避免「正在准备…」类底栏与状态/停止双重冗余）。
            // 远程执行离线提示已收进 Composer.disabledReason（井内），不再叠 StatusBanner。
            ComposerView(
                text: $draft,
                resetToken: composerResetToken,
                canCancel: vm?.canCancel ?? false,
                sendInFlight: inFlightComposerRevision != nil
                    || draftSessionCoordinator.isFirstSendInFlight,
                isPaused: vm?.isPaused ?? false,
                pauseControlPending: vm?.pauseControlPending ?? false,
                cancelControlPending: vm?.cancelControlPending ?? false,
                blocked: vm?.hitl.pending?.isBlocking == true
                    || billing.billingBlocked
                    || billing.memberLimitReached,
                disabledReason: composerDisabledReason,
                // 草稿态（vm == nil）没有消息列表可翻，恒展开。
                collapsedForReading: vm != nil && composerCollapsedForReading,
                currentMode: vm?.agentMode ?? draftAgentMode,
                allowMemberYolo: workspace.allowMemberYolo,
                currentAgentName: currentAgentOption?.name ?? currentAgentFallbackName,
                agentOptions: composerAgentOptions,
                selectedAgentId: currentAgentId,
                agentIsMutable: canChangeExecutionAgent,
                currentApprovalMode: vm?.approvalMode ?? draftApprovalMode,
                executionWorkspaceName: executionWorkspaceName,
                executionLocationHint: composerDisabledReason ?? remoteExecutionNotice?.text,
                canSwitchExecutionWorkspace: canSwitchExecutionWorkspace,
                executionWorkspaceOptions: switchableExecutionWorkspaces,
                selectedExecutionWorkspaceId: executionScope.workspaceId,
                selectedModelName: selectedModel?.displayName,
                selectedModelId: selectedModel?.id,
                selectedContextTierId: selectedContextTierId,
                selectedThinkingMode: selectedThinkingMode,
                runtimeSettingsSummary: ComposerRuntimeSettingsProjection.runtimeSummary(
                    model: selectedModel,
                    selectedTierId: selectedContextTierId,
                    selectedThinkingMode: selectedThinkingMode
                ),
                availableModels: modelStore.availableModels,
                modelProviders: modelStore.providerMetadata,
                isModelLoading: modelStore.isLoading,
                modelSelectionDisabled: !ConversationModelSelectionPolicy.canSelect(
                    hasActiveRun: vm?.isStreaming == true || vm?.canCancel == true,
                    isSwitchingModel: isSwitchingModel
                ),
                onSelectModel: { selected in
                    Task { await selectModel(selected) }
                },
                onSelectContextTier: { tierId in
                    Task { await selectContextTier(tierId) }
                },
                onSelectThinkingMode: { mode in
                    Task { await selectThinkingMode(mode) }
                },
                onRetryLoadModels: {
                    Task { await modelStore.load() }
                },
                attachments: attachmentManager.attachments,
                contextRefs: contextRefs,
                contextResources: contextResources,
                currentSpaceName: executionWorkspaceName ?? target.title,
                onModeChange: { mode in
                    if let vm {
                        vm.setAgentMode(mode)
                    } else {
                        draftAgentMode = mode
                    }
                },
                onAgentChange: { agent in
                    if let sessionId = vm?.sessionId {
                        Task {
                            await switchSessionAgent(
                                sessionId: sessionId,
                                to: agent
                            )
                        }
                    } else {
                        guard draftSessionCoordinator.selectAgent(id: agent.id) else {
                            composerError = "首条消息正在创建会话，暂时不能切换 Agent。"
                            return
                        }
                        Task { await applyPreferredModel(for: agent.id) }
                    }
                },
                onApprovalModeChange: { mode in
                    if let vm {
                        vm.setApprovalMode(mode)
                    } else {
                        draftApprovalMode = (
                            ChatApprovalMode.resolve(mode) ?? .alwaysAsk
                        ).clamped(
                            permitsRelaxedApproval: workspace.allowMemberYolo
                        ).rawValue
                    }
                },
                onExecutionLocationHelp: {
                    composerError = executionScopeHardBlockReason
                        ?? remoteExecutionNotice?.text
                        ?? "当前任务执行于 \(executionWorkspaceName ?? "Workspace")，执行位置由 Workspace 绑定。"
                },
                onSelectExecutionWorkspace: { option in
                    applyDraftExecutionWorkspace(option)
                },
                onSelectTool: handleComposerTool,
                onVoiceInput: {
                    voiceInputPreferDirectSend = false
                    showVoiceInput = true
                },
                onRemoveAttachment: removeAttachment,
                onRetryAttachment: retryAttachment,
                onRemoveContextRef: removeContextRef,
                onOpenContextRef: { ref in
                    guard ref.type == .memo, !ref.resourceId.isEmpty else { return }
                    openedMemoContext = CloudMemoDetailContext(
                        memoId: ref.resourceId,
                        title: ref.label,
                        spaceName: ref.spaceName
                    )
                },
                onAddContextRef: addContextRef,
                onSend: { submittedText in
                    Task { await sendCurrentDraft(submittedText: submittedText) }
                },
                onCancel: {
                    if let restoredText = vm?.cancel() {
                        draft = restoredText
                    }
                },
                onPause: { vm?.pause() },
                onResume: { vm?.resume() }
            )
        }
    }

    /// `vm.systemNotice` 是「进行中」的 live 事实，顶栏 sticky banner 已经拥有它；
    /// 服务端回放到时间轴里的同文案 system 行只是同一事实的历史投影，在 sticky 展示
    /// 期间不重复渲染，避免顶栏 + 气泡各说一遍。sticky 消失后（notice 变 nil）时间轴
    /// 恢复完整历史，不做任何隐藏。
    private func timelineMessages(for vm: ConversationViewModel) -> [ChatMessage] {
        var messages: [ChatMessage]
        if let notice = vm.systemNotice?.trimmingCharacters(in: .whitespacesAndNewlines),
           !notice.isEmpty {
            messages = vm.messages.filter { message in
                !(message.role == .system
                    && message.text.trimmingCharacters(in: .whitespacesAndNewlines) == notice)
            }
        } else {
            messages = vm.messages
        }
        // 对齐 Electron compactionInProgress：流式压缩中在时间线末尾挂 History + 扫光 pill。
        if vm.contextRuntimeState.compactionStatus.isInProgress,
           !messages.contains(where: { CompactionSummaryPresentation.isInProgressPlaceholder($0) }) {
            messages.append(
                ChatMessage(
                    id: CompactionSummaryPresentation.inProgressMessageId,
                    role: .system,
                    messageKind: "manual_compact_status"
                )
            )
        }
        return messages
    }

    private func runPresentation(
        for vm: ConversationViewModel
    ) -> AgentRunPresentationState {
        // 对话面板不可见时（工作台 / app-focus），不得把 HITL / 恢复声明为「面板拥有」，
        // 否则胶囊会丢掉 needsApproval / needsAnswer / recovering。
        let conversationVisible = taskSurfaceCoordinator.isConversationVisible(
            isCompactLayout: taskSurfaceCoordinator.isCompactLayout
        )
        let unreadCount = TaskCapsuleActivity.resolveUnreadCount(
            messages: vm.messages,
            readState: vm.authoritativeReadState
        )
        let completedTools = TaskCapsuleActivity.completedToolCalls(in: vm.messages)
        let queued = TaskCapsuleActivity.resolveQueuedCount(
            authoritativeQueueDepth: vm.authoritativeRunState?.queueDepth,
            waitingOutgoingCount: TaskCapsuleActivity.waitingOutgoingCount(
                in: vm.queuedOutgoingMessages
            )
        )
        let base = AgentRunPresentationState.conversation(
            rawPhase: vm.phase,
            isStreaming: vm.isStreaming,
            isPaused: vm.isPaused,
            pendingInteractionCount: vm.hitl.pendingCount,
            connectionInterrupted: vm.connectionInterrupted,
            currentAction: currentRunAction(in: vm.messages),
            failure: latestRunFailure(in: vm.messages),
            authoritativeRunStatus: vm.authoritativeRunStatus,
            hasUnreadReply: unreadCount > 0,
            unreadReplyCount: unreadCount,
            connectionRecoveryOwnedByBanner: conversationVisible && (
                ConversationRecoveryPresentation.banner(for: vm.recoveryState) != nil
                || terminalConnectionBannerInfo != nil
            ),
            blockingHITLOwnedByPanel: conversationVisible
                && (vm.hitl.pending?.isBlocking == true)
        )
        return base.withCapsuleMetrics(
            completedToolCalls: completedTools,
            queuedCount: queued,
            unreadReplyCount: unreadCount
        )
    }

    private func currentRunAction(in messages: [ChatMessage]) -> String? {
        for message in messages.reversed() where message.isAssistant && message.isStreaming {
            if let tool = message.toolCalls.reversed().first(where: { !$0.hasResult && !$0.isError }) {
                let name = tool.name.trimmingCharacters(in: .whitespacesAndNewlines)
                if !name.isEmpty { return ToolPresentation.of(name).verb }
            }
        }
        return nil
    }

    private func latestRunFailure(
        in messages: [ChatMessage]
    ) -> AgentRunFailurePresentation? {
        guard let message = messages.last(where: {
            !$0.isSubagentTranscript
                && $0.planProposal == nil
                && $0.modeSwitchProposal == nil
        }), message.isAssistant else {
            return nil
        }
        return AgentRunFailurePresentation(
            errorMessage: message.errorMessage,
            errorClass: message.errorClass,
            errorCategory: message.errorCategory,
            errorCode: message.errorCode,
            suggestedAction: message.suggestedAction,
            stopReason: message.stopReason
        )
    }

    private var selectedModel: ChatModel? {
        if let selectedModelId,
           let selected = modelStore.availableModels.first(where: { $0.id == selectedModelId }) {
            return selected
        }
        return modelStore.currentModel()
    }

    /// 首次同意前先解析可发送模型；同意本身每个用户只保存一次。
    private var resolvedSendModel: ChatModel? {
        if let selectedModel, isSendableChatModel(selectedModel) {
            return selectedModel
        }
        return modelStore.sendableModel()
    }

    private func requestAISharingConsent(for model: ChatModel, action: @escaping () -> Void) {
        pendingAIAction = action
        pendingAIConsentModel = model
    }

    private static func navigationLocationHint(from info: [AnyHashable: Any]) -> String? {
        var parts: [String] = []
        if let page = intValue(info["page"]) {
            parts.append("第 \(page) 页")
        }
        switch (intValue(info["start_line"] ?? info["startLine"] ?? info["line"]),
                intValue(info["end_line"] ?? info["endLine"])) {
        case let (.some(start), .some(end)) where end > start:
            parts.append("行 \(start)-\(end)")
        case let (.some(start), _):
            parts.append("行 \(start)")
        default:
            break
        }
        if let chunkId = stringValue(info["chunk_id"] ?? info["chunkId"]) {
            parts.append("Chunk \(chunkId)")
        }
        if let rowIds = stringArray(info["row_ids"] ?? info["rowIds"]), !rowIds.isEmpty {
            parts.append(rowIds.count == 1 ? "记录 \(rowIds[0])" : "\(rowIds.count) 条记录")
        }
        if let fieldIds = stringArray(info["field_ids"] ?? info["fieldIds"]), !fieldIds.isEmpty {
            parts.append(fieldIds.count == 1 ? "字段 \(fieldIds[0])" : "\(fieldIds.count) 个字段")
        }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    private static func intValue(_ value: Any?) -> Int? {
        if let int = value as? Int { return int }
        if let double = value as? Double { return Int(double) }
        if let string = value as? String { return Int(string) }
        return nil
    }

    private static func stringValue(_ value: Any?) -> String? {
        let string: String?
        if let raw = value as? String {
            string = raw
        } else if let number = value as? NSNumber {
            string = number.stringValue
        } else {
            string = nil
        }
        let trimmed = string?.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let trimmed, !trimmed.isEmpty else { return nil }
        return trimmed
    }

    private static func stringArray(_ value: Any?) -> [String]? {
        if let strings = value as? [String] {
            return strings.filter { !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
        }
        if let values = value as? [Any] {
            let strings = values.compactMap(stringValue)
            return strings.isEmpty ? nil : strings
        }
        return nil
    }

    private func billingBannerInfo(_ vm: ConversationViewModel) -> (title: String, message: String)? {
        if billing.memberLimitReached {
            let message = billing.memberLimitReason == "member_daily_limit"
                ? "你的今日成员额度已用完，请联系管理员调整额度。"
                : "你的成员额度已用完，请联系管理员调整额度。"
            return ("成员额度受限", message)
        }
        if billing.billingBlocked {
            return ("计费状态阻断", "当前组织余额或额度不足，请处理后重试。")
        }
        if let title = vm.billingBlockedTitle, let message = vm.billingBlockedMessage {
            return (title, message)
        }
        return nil
    }

    private func sendCurrentDraft(submittedText: String? = nil) async {
        // P1-3：点击发送瞬间冻结不可变快照；之后 await 只消费快照，禁止再读 live Focus/附件。
        let text = (submittedText ?? draft).trimmingCharacters(in: .whitespacesAndNewlines)
        let attachments = attachmentManager.attachments
        let refs = contextRefs
        let revision = composerDraftRevision
        // 快速连点：已有 in-flight 发送（含同意等待）→ 不重复夹带同批附件。
        if let inFlight = inFlightComposerRevision {
            if inFlight == revision { return }
            // 用户已改稿（revision 前进）时允许新快照；先释放旧占有。
            inFlightComposerRevision = nil
            inFlightComposerSendToken = nil
        }
        refreshCurrentFocusSnapshot()
        let preservedPayload = preservedEditResendPayload
        var blocks = preservedPayload?.composerBlockPayloads(
            attachments: attachments,
            contextRefs: refs
        ) ?? attachmentManager.readyBlockPayloads()
        if preservedPayload == nil {
            blocks.append(contentsOf: refs.map { $0.blockPayload() })
        }
        let snapshot = ConversationComposerSendSnapshot.capturing(
            text: text,
            focusSnapshot: taskSurfaceCoordinator.currentFocusSnapshot,
            contextRefs: refs,
            attachments: attachments,
            blockPayloads: blocks,
            draftRevision: revision,
            editResendRecoveryToken: preservedPayload?.recoveryToken
        )

        func restoreSubmittedDraftIfNeeded() {
            guard ConversationComposerSendSnapshot.shouldRestoreDraft(
                currentDraft: draft,
                snapshotText: snapshot.text
            ) else { return }
            if let submittedText {
                draft = submittedText
            } else if draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                draft = snapshot.text
            }
        }

        if billing.billingBlocked || billing.memberLimitReached {
            restoreSubmittedDraftIfNeeded()
            composerError = billing.memberLimitReached
                ? "你的成员额度已用完，请联系管理员调整额度。"
                : "当前组织余额或额度不足，请处理后重试。"
            return
        }
        if let executionScopeHardBlockReason {
            restoreSubmittedDraftIfNeeded()
            composerError = executionScopeHardBlockReason
            return
        }
        if let remoteBlock = RemoteExecutionNoticePresentation.composerDisabledReason(
            for: remoteExecutionState
        ) {
            restoreSubmittedDraftIfNeeded()
            composerError = remoteBlock
            return
        }
        if vm == nil, draftSessionCoordinator.agentId == nil {
            restoreSubmittedDraftIfNeeded()
            composerError = "请先选择一个可用 Agent，再发送任务。"
            return
        }
        guard !snapshot.text.isEmpty
            || !snapshot.attachmentIds.isEmpty
            || !snapshot.contextRefs.isEmpty else {
            return
        }

        if attachments.contains(where: { $0.status.isInFlight }) {
            restoreSubmittedDraftIfNeeded()
            composerError = "附件仍在上传中，请稍候再发送。"
            return
        }
        if attachments.contains(where: { $0.status == .error }) {
            restoreSubmittedDraftIfNeeded()
            composerError = "有附件上传失败，请重试或移除后再发送。"
            return
        }

        await modelStore.ensureLoaded()
        guard let sendModel = resolvedSendModel else {
            restoreSubmittedDraftIfNeeded()
            composerError = "没有可用模型：请在管理后台配置并激活聊天模型后重试。"
            return
        }
        if AttachmentUploadPolicy.hasUnsupportedDocumentAttachment(
            attachments: attachments,
            supportsDocumentInput: sendModel.supportsDocumentInput
        ) {
            restoreSubmittedDraftIfNeeded()
            composerError = AttachmentUploadPolicy.unsupportedDocumentMessage
            return
        }

        // 原子占有本 revision + sendToken：同意流程也复用同一 snapshot，禁止重新捕获 live Focus。
        inFlightComposerRevision = revision
        inFlightComposerSendToken = snapshot.sendToken

        guard PrivacyConsentStore.shared.hasAcceptedAISharing else {
            requestAISharingConsent(for: sendModel) {
                Task {
                    await self.continueSendAfterConsent(
                        snapshot: snapshot,
                        model: sendModel
                    )
                }
            }
            return
        }

        await continueSendAfterConsent(snapshot: snapshot, model: sendModel)
    }

    /// 同意完成后继续发送：只消费已冻结 snapshot，不再读 live Focus / 附件。
    private func continueSendAfterConsent(
        snapshot: ConversationComposerSendSnapshot,
        model: ChatModel
    ) async {
        // 迟到同意回调：若用户已另开一轮发送，本 snapshot 不再拥有 in-flight。
        guard ConversationComposerSendSnapshot.ownsInFlightSend(
            inFlightToken: inFlightComposerSendToken,
            snapshotToken: snapshot.sendToken
        ) else { return }
        defer {
            if inFlightComposerSendToken == snapshot.sendToken {
                inFlightComposerSendToken = nil
            }
            if inFlightComposerRevision == snapshot.draftRevision {
                inFlightComposerRevision = nil
            }
        }
        let runtimeConfiguration = ConversationRuntimeConfiguration.migrating(
            agentMode: vm?.agentMode ?? draftAgentMode,
            approvalMode: vm?.approvalMode ?? draftApprovalMode,
            permitsRelaxedApproval: workspace.allowMemberYolo
        )
        guard let resolvedViewModel = await resolveViewModelForSend(
            modelId: model.id,
            runtimeConfiguration: runtimeConfiguration
        ) else {
            // 建会话失败：仅当用户未另打新字时恢复快照原文。
            if ConversationComposerSendSnapshot.shouldRestoreDraft(
                currentDraft: draft,
                snapshotText: snapshot.text
            ) {
                draft = snapshot.text
            }
            return
        }
        await performSend(
            using: resolvedViewModel,
            snapshot: snapshot,
            model: model,
            runtimeConfiguration: runtimeConfiguration
        )
    }

    private func performSend(
        using vm: ConversationViewModel,
        snapshot: ConversationComposerSendSnapshot,
        model: ChatModel,
        runtimeConfiguration: ConversationRuntimeConfiguration
    ) async {
        let receipt = vm.enqueue(
            snapshot.text,
            modelId: model.id,
            agentMode: runtimeConfiguration.agentMode.rawValue,
            approvalMode: runtimeConfiguration.approvalMode.rawValue,
            blocks: snapshot.blockPayloads.isEmpty ? nil : snapshot.blockPayloads,
            focusSnapshot: snapshot.focusSnapshot
        )
        guard let receipt else {
            if ConversationComposerSendSnapshot.shouldRestoreDraft(
                currentDraft: draft,
                snapshotText: snapshot.text
            ) {
                draft = snapshot.text
            }
            composerError = vm.actionError ?? "消息未能保存，请保留草稿后重试。"
            await persistDraftNow(pendingSessionId: vm.sessionId)
            return
        }
        switch receipt {
        case .blocked, .failed:
            if ConversationComposerSendSnapshot.shouldRestoreDraft(
                currentDraft: draft,
                snapshotText: snapshot.text
            ) {
                draft = snapshot.text
            }
            composerError = vm.actionError ?? receipt.userFacingMessage
            await persistDraftNow(pendingSessionId: vm.sessionId)
            return
        case .persisted, .queued, .accepted:
            break
        }
        await consumePersistedDraft()
        // 只清快照对应状态：发送过程中用户新打的字 / 新附件 / 新引用予以保留。
        if ConversationComposerSendSnapshot.shouldClearDraft(
            currentDraft: draft,
            snapshotText: snapshot.text
        ) {
            draft = ""
            composerResetToken += 1
        }
        // 入队成功后只按 snapshot attachment ids 移除。
        // 本地排队 / 尚未 ACK：勿 deactivate 仍需的上传 usage（延迟到消息侧持有）。
        let snapshotAttachmentIds = Set(snapshot.attachmentIds)
        for id in snapshotAttachmentIds {
            attachmentManager.removeAttachment(
                id,
                contextId: currentAttachmentContextId,
                deactivateUploaded: false
            )
        }
        if attachmentManager.attachments.isEmpty {
            attachmentUploadContextId = nil
        }
        let snapshotRefIds = Set(snapshot.contextRefs.map(\.id))
        contextRefs.removeAll { snapshotRefIds.contains($0.id) }
        if let recoveryToken = snapshot.editResendRecoveryToken,
           preservedEditResendPayload?.recoveryToken == recoveryToken {
            preservedEditResendPayload = nil
        }
        composerDraftRevision += 1
        scrollToBottomToken += 1
    }

    /// `startsNewSession` 的草稿页直到用户明确点击发送才触发后端建会话。
    /// 预填文本和上下文只属于本地草稿，首发始终使用用户此刻选定的 Agent。
    private func resolveViewModelForSend(
        modelId: String?,
        runtimeConfiguration: ConversationRuntimeConfiguration
    ) async -> ConversationViewModel? {
        if let vm { return vm }
        guard target.startsNewSession else {
            composerError = "会话尚未准备好，请稍后重试。"
            return nil
        }
        guard draftSessionCoordinator.beginFirstSend() else {
            return nil
        }
        defer { draftSessionCoordinator.finishFirstSend() }

        let draft = draftSessionCoordinator.draft
        do {
            // 先把稳定 draft/session UUID 落盘，再发创建请求；即使进程在响应回来前退出，
            // 下次恢复仍会以同一个 session_id 重试，不会生成第二个空会话。
            // 默认模型也在此刻显式冻结，避免重启后目录默认值变化造成同一幂等键配置冲突。
            if selectedModelId == nil, let modelId {
                selectedModelId = modelId
            }
            await persistDraftNow()
            let sessionId = try await createSessionForDraftFirstSend(
                draft: draft,
                modelId: modelId,
                runtimeConfiguration: runtimeConfiguration
            )
            // Session 创建与首条消息入队之间存在进程被杀的窗口；先持久化 sessionId，
            // 恢复后才能继续同一事务，而不是再次制造一个空 Session。
            await persistDraftNow(pendingSessionId: sessionId)
            let model = ConversationViewModel(
                sessionId: sessionId,
                workspaceId: draft.workspaceId,
                organizationId: draft.organizationId,
                projectId: draft.projectId
            )
            model.setAgentMode(runtimeConfiguration.agentMode.rawValue)
            model.setApprovalMode(runtimeConfiguration.approvalMode.rawValue)
            sessionAgentId = draft.agentId
            model.executionAgentId = draft.agentId
            vm = model
            bindQueuedSendReceiptHandler(to: model)
            loadState = .ready
            await model.startSession()
            await ChatModelStore.shared.ensureLoaded()
            await flushDraftRuntimeSettings(sessionId: sessionId)
            await loadSessionInfo(sessionId: sessionId, fallback: draft.agentId)
            return model
        } catch {
            composerError = "新建会话失败：\(error.localizedDescription)"
            return nil
        }
    }

    /// 首发建会话；遇  CONFLICT 时轮换 draft UUID 再试一次。
    private func createSessionForDraftFirstSend(
        draft: ConversationDraftState,
        modelId: String?,
        runtimeConfiguration: ConversationRuntimeConfiguration
    ) async throws -> String {
        do {
            return try await draftSessionCoordinator.ensureSession {
                try await ChatSessionResolver.create(
                    workspaceId: draft.workspaceId,
                    organizationId: draft.organizationId,
                    agentId: draft.agentId,
                    projectId: draft.projectId,
                    sessionId: draft.id,
                    modelId: modelId,
                    agentMode: runtimeConfiguration.agentMode,
                    approvalMode: runtimeConfiguration.approvalMode
                )
            }
        } catch {
            guard Self.isSessionCreateConflict(error),
                  let rotatedId = draftSessionCoordinator.rotateDraftIdentityForConflictRetry() else {
                throw error
            }
            attachmentUploadContextId = rotatedId
            await persistDraftNow()
            let retryDraft = draftSessionCoordinator.draft
            return try await draftSessionCoordinator.ensureSession {
                try await ChatSessionResolver.create(
                    workspaceId: retryDraft.workspaceId,
                    organizationId: retryDraft.organizationId,
                    agentId: retryDraft.agentId,
                    projectId: retryDraft.projectId,
                    sessionId: rotatedId,
                    modelId: modelId,
                    agentMode: runtimeConfiguration.agentMode,
                    approvalMode: runtimeConfiguration.approvalMode
                )
            }
        }
    }

    /// 识别 createSession 的幂等键冲突（HTTP 409 / 业务码 CONFLICT）。
    private static func isSessionCreateConflict(_ error: Error) -> Bool {
        if let apiError = error as? APIError {
            if case let .serverError(status, message) = apiError {
                if status == 409 { return true }
                if apiError.businessCode == "CONFLICT" { return true }
                if message?.contains("创建配置不一致") == true { return true }
            }
            if apiError.businessCode == "CONFLICT" { return true }
        }
        let text = error.localizedDescription
        return text.contains("[CONFLICT]") || text.contains("创建配置不一致")
    }

    private func handleComposerTool(_ tool: ComposerTool) {
        switch tool {
        case .context:
            showContextPicker = true
            Task { await loadContextResourcesIfNeeded(force: true) }
        case .photoLibrary:
            guard ensureCanAddMoreAttachments() else { return }
            selectedPhotoItems = []
            showPhotoPicker = true
        case .camera:
            guard ensureCanAddMoreAttachments() else { return }
            handleCameraAccess()
        case .file:
            guard ensureCanAddMoreAttachments() else { return }
            showFileImporter = true
        }
    }

    private func handlePickedPhotos(_ items: [PhotosPickerItem]) async {
        defer { selectedPhotoItems = [] }
        guard let scope = attachmentUploadScope() else {
            composerError = "会话尚未准备好，请稍后重试。"
            return
        }
        let allowedItems = Array(items.prefix(attachmentManager.remainingSlots))
        if allowedItems.count < items.count {
            composerError = "最多只能添加 \(ChatAttachmentUploadConfig.maxAttachments) 个附件，已忽略多余项目。"
        }
        for (idx, item) in allowedItems.enumerated() {
            guard let data = try? await item.loadTransferable(type: Data.self) else { continue }
            let name = "photo_\(idx + 1).jpg"
            if let error = attachmentManager.addPhoto(
                data: data,
                filename: name,
                scope: scope
            ) {
                composerError = error
            }
        }
    }

    private func addCameraAttachment(_ image: UIImage?) {
        guard let image else { return }
        guard ensureCanAddMoreAttachments() else { return }
        guard let scope = attachmentUploadScope() else {
            composerError = "会话尚未准备好，请稍后重试。"
            return
        }
        if let error = attachmentManager.addCameraImage(
            image,
            scope: scope
        ) {
            composerError = error
        }
    }

    private func handleCameraAccess() {
        let action = cameraAccessAction(
            cameraAvailable: UIImagePickerController.isSourceTypeAvailable(.camera),
            authorizationStatus: AVCaptureDevice.authorizationStatus(for: .video)
        )

        switch action {
        case .presentCamera:
            showCamera = true
        case .requestPermission:
            Task {
                let granted = await AVCaptureDevice.requestAccess(for: .video)
                guard granted else {
                    cameraAccessIssue = AVCaptureDevice.authorizationStatus(for: .video) == .restricted
                        ? .restricted
                        : .permissionDenied
                    return
                }
                guard UIImagePickerController.isSourceTypeAvailable(.camera) else {
                    cameraAccessIssue = .unavailable
                    return
                }
                showCamera = true
            }
        case .showPermissionDenied:
            cameraAccessIssue = .permissionDenied
        case .showRestricted:
            cameraAccessIssue = .restricted
        case .showUnavailable:
            cameraAccessIssue = .unavailable
        }
    }

    private func handlePickedFiles(_ result: Result<[URL], Error>) {
        do {
            guard let scope = attachmentUploadScope() else {
                composerError = "会话尚未准备好，请稍后重试。"
                return
            }
            let urls = try result.get()
            let allowedURLs = Array(urls.prefix(attachmentManager.remainingSlots))
            if allowedURLs.count < urls.count {
                composerError = "最多只能添加 \(ChatAttachmentUploadConfig.maxAttachments) 个附件，已忽略多余项目。"
            }
            for url in allowedURLs {
                if let error = attachmentManager.addFile(
                    url: url,
                    scope: scope
                ) {
                    composerError = error
                }
            }
        } catch {
            composerError = error.localizedDescription
        }
    }

    private func ensureCanAddMoreAttachments() -> Bool {
        guard attachmentManager.remainingSlots > 0 else {
            composerError = "最多只能添加 \(ChatAttachmentUploadConfig.maxAttachments) 个附件。"
            return false
        }
        return true
    }

    private func retryAttachment(_ id: String) {
        guard let scope = attachmentUploadScope() else {
            composerError = "会话尚未准备好，请稍后重试。"
            return
        }
        if let error = attachmentManager.retryAttachment(
            id,
            scope: scope
        ) {
            composerError = error
        }
    }

    private func removeAttachment(_ id: String) {
        attachmentManager.removeAttachment(id, contextId: currentAttachmentContextId)
    }

    private func addContextRef(_ ref: MentionContextRef) {
        guard !contextRefs.contains(where: { $0.resourceId == ref.resourceId && $0.type == ref.type }) else { return }
        contextRefs.append(ref)
    }

    private func removeContextRef(_ id: String) {
        contextRefs.removeAll { $0.id == id }
    }

    private func loadContextResourcesIfNeeded(force: Bool = false) async {
        guard !isLoadingContextResources else { return }
        guard force || contextResources.isEmpty else { return }
        isLoadingContextResources = true
        defer { isLoadingContextResources = false }
        let spaceId = executionScope.workspaceId
        do {
            let response: SpaceResourceListResponse = try await APIClient.shared.get(
                path: Endpoints.Context.contextItems(spaceId: spaceId),
                query: MentionableResourceListQuery.parameters
            )
            guard spaceId == executionScope.workspaceId else { return }
            contextResources = response.items
        } catch {
            // 不阻断聊天主路径；用户仍可通过半屏选择器重试。
        }
    }

    /// 草稿 Folder 切换：同步 draft 冻结字段、executionScope、上下文资源，避免 UI 显示新现场却建到旧 Workspace。
    private func applyDraftExecutionWorkspace(_ option: ComposerExecutionWorkspaceOption) {
        guard canSwitchExecutionWorkspace else { return }
        guard draftSessionCoordinator.selectExecutionWorkspace(
            workspaceId: option.id,
            organizationId: option.organizationId,
            projectId: nil
        ) else { return }

        UserDefaults.standard.set(option.id, forKey: ComposeSheet.lastWorkspaceKey)
        adoptExecutionScope(.entry(
            workspaceId: option.id,
            projectId: nil,
            organizationId: option.organizationId
        ))
        // adoptExecutionScope 会清空名称；这里立刻写回，避免等待 runtime refresh。
        executionWorkspaceName = option.name
        contextRefs.removeAll()
        contextResources.removeAll()
        scheduleDraftPersistence()
        Task { await loadContextResourcesIfNeeded(force: true) }
    }

    private func showRewindPreview(message: ChatMessage) async {
        pendingEditResend = nil
        await checkpointService.fetchRollbackPreview(
            sessionId: message.checkpointRecord?.sessionId ?? vm?.sessionId ?? "",
            messageId: message.effectiveId
        )
    }

    private func dismissRewindPreview() {
        checkpointService.clearPreview()
        pendingEditResend = nil
    }

    private func retryRewindPreview() async {
        guard let vm else { return }
        let messageId = pendingEditResend?.message.effectiveId
            ?? checkpointService.previewTargetMessageId
        guard let messageId, !messageId.isEmpty else { return }
        _ = await checkpointService.fetchRollbackPreview(
            sessionId: vm.sessionId,
            messageId: messageId
        )
    }

    private func executeRollback(reason: String, resourcePlan: [ChatCheckpointResourcePlanItem]) async {
        guard let vm, let messageId = checkpointService.previewTargetMessageId else { return }
        let ok = await checkpointService.executeRollback(
            sessionId: vm.sessionId,
            messageId: messageId,
            reason: reason,
            resourceRestorePlan: resourcePlan
        )
        if ok {
            if !(await vm.refreshHistoryAfterTimelineRewrite()) {
                composerError = "对话已回退，但消息列表同步失败；请刷新后再继续。"
            }
        } else if let error = checkpointService.lastError {
            composerError = error
        }
    }

    private func executeUnrevert() async {
        guard let vm else { return }
        let ok = await checkpointService.executeUnrevert(sessionId: vm.sessionId)
        if ok {
            if !(await vm.refreshHistoryAfterTimelineRewrite()) {
                composerError = "已撤销回退，但消息列表同步失败；请刷新后再继续。"
            }
        } else if let error = checkpointService.lastError {
            composerError = error
        }
    }

    private func retryRollbackResources(_ items: [ChatCheckpointRetryableResource]) async {
        guard let vm else { return }
        let ok = await checkpointService.restoreRetryableResources(sessionId: vm.sessionId, items: items)
        if ok {
            await vm.refreshHistory()
        } else if let error = checkpointService.lastError ?? checkpointService.lastFileRestoreWarning {
            composerError = error
        }
    }

    private func rollbackAgentRun(_ agentRunId: String) async {
        guard let vm else { return }
        let result = await checkpointService.rollbackAgentRun(agentRunId)
        if result != nil {
            await vm.refreshHistory()
        } else if let error = checkpointService.lastError {
            composerError = error
        }
    }

    private func handleCopyMessage(_ message: ChatMessage) {
        let content = message.copyableText
        guard !content.isEmpty else {
            composerError = "这条消息没有可复制的内容。"
            return
        }
        UIPasteboard.general.string = content
        UISelectionFeedbackGenerator().selectionChanged()
        showTransientConfirmation("已复制")
        UIAccessibility.post(notification: .announcement, argument: "已复制")
    }

    private func beginEditingMessage(_ message: ChatMessage) {
        guard editingMessageSubmittingId == nil, !checkpointService.isReverting else {
            composerError = "正在处理回退，请稍候。"
            return
        }
        guard message.isEditableResendUserMessage else {
            composerError = "这条消息包含暂不支持重发的内容。"
            return
        }
        editingMessageId = message.id
        editingMessageError = nil
        pendingEditResend = nil
    }

    private func cancelEditingMessage() {
        guard editingMessageSubmittingId == nil else { return }
        editingMessageId = nil
        editingMessageError = nil
        pendingEditResend = nil
    }

    private func submitEditedMessage(_ message: ChatMessage, text: String) async {
        guard let vm else { return }
        guard editingMessageSubmittingId == nil, !checkpointService.isReverting else { return }
        guard message.isEditableResendUserMessage else {
            editingMessageError = "这条消息包含暂不支持重发的内容。"
            return
        }
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        guard trimmed != message.text.trimmingCharacters(in: .whitespacesAndNewlines) else {
            editingMessageError = "内容没有变化。"
            return
        }

        await modelStore.ensureLoaded()
        guard let sendModel = resolvedSendModel else {
            editingMessageError = "没有可用模型：请在管理后台配置并激活聊天模型后重试。"
            return
        }

        guard PrivacyConsentStore.shared.hasAcceptedAISharing else {
            requestAISharingConsent(for: sendModel) {
                Task { await self.submitEditedMessage(message, text: text) }
            }
            return
        }

        let pending = PendingEditResend(
            message: message,
            text: trimmed,
            modelId: sendModel.id
        )
        pendingEditResend = pending
        editingMessageSubmittingId = message.id
        editingMessageError = nil
        defer { editingMessageSubmittingId = nil }

        let preview = await checkpointService.fetchRollbackPreview(
            sessionId: vm.sessionId,
            messageId: message.effectiveId
        )
        guard preview != nil else {
            pendingEditResend = nil
            editingMessageError = checkpointService.lastError ?? "无法取得影响预览，请稍后重试。"
            return
        }
    }

    private func executeEditedResendRollback(
        reason: String,
        resourcePlan: [ChatCheckpointResourcePlanItem],
        allowsConversationOnly: Bool
    ) async {
        guard let vm, let pending = pendingEditResend else { return }
        guard editingMessageSubmittingId == nil, !checkpointService.isReverting else { return }
        guard let preview = checkpointService.rollbackPreview else {
            editingMessageError = "影响预览已失效，请重新检查后再继续。"
            return
        }
        if let revisionDetail = CheckpointPresentationPolicy.editResendRevisionBlockingDetail(
            previewRevision: preview.previewRevision,
            filePreviewRevision: preview.filePreviewRevision
        ) {
            editingMessageError = revisionDetail
            return
        }
        let previewRisk = CheckpointPresentationPolicy.editResendRisk(for: preview)
        guard !previewRisk.blocksExecution else {
            editingMessageError = previewRisk.blockingDetail ?? previewRisk.detail
            return
        }
        guard !previewRisk.requiresConversationOnlyAcknowledgement || allowsConversationOnly else {
            editingMessageError = "请先确认无法恢复的资源是否仅保留对话。"
            return
        }

        editingMessageSubmittingId = pending.message.id
        editingMessageError = nil
        defer { editingMessageSubmittingId = nil }

        vm.cancel()
        let ok = await checkpointService.executeRollback(
            sessionId: vm.sessionId,
            messageId: pending.message.effectiveId,
            reason: reason,
            resourceRestorePlan: resourcePlan,
            mode: "editAndResend",
            previewRevision: preview.previewRevision,
            filePreviewRevision: preview.filePreviewRevision,
            acknowledgedFilePreviewReason: allowsConversationOnly
                ? CheckpointPresentationPolicy.acknowledgedFilePreviewReason(for: preview)
                : nil
        )
        guard ok else {
            if checkpointService.lastPreviewStale {
                let refreshed = await checkpointService.fetchRollbackPreview(
                    sessionId: vm.sessionId,
                    messageId: pending.message.effectiveId
                )
                editingMessageError = refreshed == nil
                    ? checkpointService.lastError ?? "对话已变化，但新影响预览加载失败，请重试。"
                    : nil
                return
            }
            editingMessageError = checkpointService.lastError ?? "编辑失败，无法回退到该消息之前。"
            return
        }

        let refreshSucceeded = await vm.refreshHistoryAfterTimelineRewrite()
        guard refreshSucceeded else {
            preserveEditedDraftAfterRewrite(pending)
            composerError = "对话已回退，但消息列表同步失败。编辑内容已保留在输入框，刷新后再发送。"
            return
        }

        // 预览中已明确且由用户接受的缺失，只能匹配同一文件原因；任何执行阶段
        // 新文件失败或已选择资源恢复失败都必须停止发送，并把修改内容留在输入框。
        let resourceFailedCount = checkpointService.lastResourceRestoreFailed ? 1 : 0
        let matchesAcknowledgedFileGap =
            CheckpointPresentationPolicy.executionMatchesAcknowledgedPreviewFileGap(
                preview: preview,
                executionStatus: checkpointService.lastFileRestoreStatus,
                executionReason: checkpointService.lastFileRestoreReason,
                failedFiles: checkpointService.lastFailedFiles,
                acknowledged: allowsConversationOnly
            )
        let canSend = CheckpointPresentationPolicy.canCompleteEditResend(
            historyRefreshSucceeded: true,
            fileRestoreStatus: matchesAcknowledgedFileGap
                ? "not_applicable"
                : checkpointService.lastFileRestoreStatus,
            resourceFailedCount: resourceFailedCount
        )
        guard canSend else {
            var warnings: [String] = []
            if !matchesAcknowledgedFileGap,
               checkpointService.lastFileRestoreStatus?.lowercased() != "success",
               checkpointService.lastFileRestoreStatus?.lowercased() != "not_applicable" {
                warnings.append(
                    checkpointService.lastFileRestoreWarning
                        ?? "对话已回退，但工作区文件没有完全恢复。"
                )
            }
            if resourceFailedCount > 0 {
                warnings.append(
                    checkpointService.lastResourceRestoreWarning
                        ?? "部分已选择的文档或表格没有恢复。"
                )
            }
            preserveEditedDraftAfterRewrite(pending)
            composerError = warnings.joined(separator: " ")
                + " 修改后的内容已保留在输入框；请先处理恢复问题，再重新发送。"
            return
        }

        completeEditedResend(pending)
    }

    private func completeEditedResend(_ pending: PendingEditResend) {
        guard let vm else {
            preserveEditedDraftAfterRewrite(pending)
            return
        }
        let receipt = vm.enqueue(
            pending.text,
            modelId: pending.modelId,
            agentMode: vm.agentMode,
            blocks: pending.blockPayloads.isEmpty ? nil : pending.blockPayloads
        )
        guard !ConversationComposerSendSnapshot.shouldPreserveDraft(after: receipt) else {
            preserveEditedDraftAfterRewrite(pending)
            let detail = receipt?.userFacingMessage ?? vm.actionError ?? "修改后的消息未能保存"
            composerError = "对话已回退，但\(detail)。编辑内容、附件和上下文已保留在输入框。"
            return
        }
        pendingEditResend = nil
        editingMessageId = nil
        editingMessageError = nil
        scrollToBottomToken += 1
    }

    private func preserveEditedDraftAfterRewrite(_ pending: PendingEditResend? = nil) {
        guard let preserved = pending ?? pendingEditResend else { return }
        draft = preserved.text
        selectedModelId = preserved.modelId
        attachmentManager.mergeRestoredAttachments(preserved.attachments)
        let existingContextIDs = Set(contextRefs.map(\.id))
        contextRefs.append(contentsOf: preserved.contextRefs.filter {
            !existingContextIDs.contains($0.id)
        })
        preservedEditResendPayload = preserved
        composerCollapsedForReading = false
        composerDraftRevision += 1
        scheduleDraftPersistence()
        pendingEditResend = nil
        editingMessageId = nil
        editingMessageError = nil
    }

    private func requestFork(from message: ChatMessage) {
        guard !isForking else { return }
        pendingForkMessage = message
    }

    private func forkFromMessage(_ message: ChatMessage) async {
        guard let current = vm else { return }
        guard !isForking else { return }
        isForking = true
        defer { isForking = false }
        do {
            let forked = try await ChatSessionResolver.fork(
                sessionId: current.sessionId,
                messageId: message.effectiveId
            )
            switch forked.forkCopyStatus {
            case "pending":
                // 服务端已明确异步复制；先说明 pending，不把新会话说成可立即继续工作。
                pendingForkSession = forked
            case "failed":
                composerError = "分支消息复制失败，请在会话信息中查看状态后重试。"
            default:
                openForkedSession(forked)
                showTransientConfirmation("已创建独立分支会话")
            }
        } catch {
            composerError = "分叉失败：\(error.localizedDescription)"
        }
    }

    private func openForkedSession(_ forked: ChatSession) {
        onOpenConversation(ConversationTarget(
            title: forked.title?.isEmpty == false ? forked.title! : target.title,
            // Project 会话同时绑定执行 Workspace 与协作 Project；只沿用明确的执行现场。
            workspaceId: target.workspaceId,
            organizationId: forked.organizationId ?? target.organizationId,
            agentId: forked.agentId ?? target.agentId,
            projectId: forked.projectId ?? target.projectId,
            sessionId: forked.id
        ))
    }

    private func startNewTask() {
        onOpenConversation(ConversationTarget(
            title: target.title,
            workspaceId: target.workspaceId,
            organizationId: target.organizationId,
            agentId: sessionInfo?.agentId ?? target.agentId,
            projectId: sessionInfo?.projectId ?? target.projectId,
            startsNewSession: true
        ))
    }

    private func requestArchive() {
        guard !isArchiving else { return }
        if let reason = ConversationArchivePolicy.blockedReason(
            isStreaming: vm?.isStreaming == true,
            authoritativeStatus: vm?.authoritativeRunStatus ?? sessionInfo?.runState?.status
        ) {
            archiveBlockedReason = reason
            return
        }
        showArchiveConfirmation = true
    }

    private func handleResourceNavigation(_ notification: Notification) {
        guard let info = notification.userInfo,
              let resourceType = info["resource_type"] as? String,
              let resourceId = info["resource_id"] as? String else { return }

        // 多会话并开时 NotificationCenter 会广播到所有 ConversationScreen。
        // payload 若带 session / space 归属则必须匹配本屏，避免串台。
        if let sessionId = Self.navigationString(info["session_id"])
            ?? Self.navigationString(info["sessionId"]) {
            let currentSessionId = vm?.sessionId
            guard let currentSessionId, sessionId == currentSessionId else { return }
        }
        if let spaceId = Self.navigationString(info["space_id"])
            ?? Self.navigationString(info["workspace_id"])
            ?? Self.navigationString(info["spaceId"]) {
            guard spaceId == target.workspaceId else { return }
        }

        let title = info["title"] as? String
            ?? info["resource_name"] as? String
            ?? info["label"] as? String
        let locationHint = info["location_hint"] as? String
            ?? Self.navigationLocationHint(from: info)
        let request = SpaceResourceOpenRequest(
            resourceType: resourceType,
            resourceId: resourceId,
            title: title,
            locationHint: locationHint
        )
        pendingWorkbenchOpenRequest = request
        presentWorkbench(opening: request)
    }

    private static func navigationString(_ raw: Any?) -> String? {
        guard let value = raw as? String else { return nil }
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    private func archiveCurrentSession() async {
        guard !isArchiving, let sessionId = vm?.sessionId else { return }
        if let reason = ConversationArchivePolicy.blockedReason(
            isStreaming: vm?.isStreaming == true,
            authoritativeStatus: vm?.authoritativeRunStatus ?? sessionInfo?.runState?.status
        ) {
            archiveBlockedReason = reason
            return
        }

        guard let fallbackContext = ConversationArchiveContext.resolving(
            sessionId: sessionId,
            authoritativeOrganizationId: nil,
            cachedOrganizationId: sessionInfo?.organizationId,
            fallbackOrganizationId: target.organizationId,
            authoritativeSpaceId: nil,
            cachedSpaceId: sessionInfo?.workspaceId,
            fallbackSpaceId: target.workspaceId
        ) else {
            archiveError = "无法确认会话归属，请重新进入会话后重试。"
            return
        }

        isArchiving = true
        archiveError = nil
        defer { isArchiving = false }
        do {
            let archived = try await ConversationMenuService().archive(sessionId: sessionId)
            let context = ConversationArchiveContext.resolving(
                sessionId: sessionId,
                authoritativeOrganizationId: archived.organizationId,
                cachedOrganizationId: sessionInfo?.organizationId,
                fallbackOrganizationId: target.organizationId,
                authoritativeSpaceId: archived.workspaceId,
                cachedSpaceId: sessionInfo?.workspaceId,
                fallbackSpaceId: target.workspaceId
            ) ?? fallbackContext
            ConversationArchivePropagation.publishSucceeded(context)
            onBack()
        } catch {
            guard !error.isCancellation else { return }
            archiveError = error.localizedDescription
        }
    }

    private func renameSession(_ title: String) async throws -> ChatSession {
        guard let current = vm else { throw APIError.apiError("当前会话尚未就绪") }
        let updated = try await ChatSessionResolver.rename(sessionId: current.sessionId, title: title)
        sessionInfo = updated
        sessionAgentId = updated.agentId ?? sessionAgentId
        return updated
    }

    /// 乐观更新当前会话的 Agent；失败时回滚，且不改 Workspace 默认绑定。
    ///
    /// 与 Electron 一致：正在执行的轮次保持原运行快照，排队消息和下一轮读取新绑定。
    private func switchSessionAgent(
        sessionId: String,
        to agent: ComposerTaskAgentOption
    ) async {
        guard canChangeExecutionAgent, agent.id != currentAgentId else { return }
        let previousAgentId = sessionAgentId
        let previousFace = RecentSessionsStore.shared.executionAgentFace(for: sessionId)
        // 一点击就改外面列表脸，并 sticky 挡住 pop 后的旧列表重拉；
        // 不要等 PUT / 发消息 / 回复结束——那是用户抱怨的时序。
        let avatarRaw = agent.avatarPreset?.rawValue
            ?? nonEmpty(agent.avatar)
            ?? AgentAvatarPreset.generalAssistant.rawValue
        RecentSessionsStore.shared.updateExecutionAgent(
            sessionId: sessionId,
            agentId: agent.id,
            agentName: agent.name,
            agentAvatar: avatarRaw
        )
        sessionAgentId = agent.id
        vm?.executionAgentId = agent.id
        isSwitchingAgent = true
        defer { isSwitchingAgent = false }

        do {
            let updated = try await ChatSessionResolver.switchAgent(
                sessionId: sessionId,
                agentId: agent.id
            )
            sessionInfo = updated
            sessionAgentId = updated.agentId ?? agent.id
            vm?.executionAgentId = sessionAgentId
            // PUT 成功后再钉一次（agentId 以服务端为准），sticky 继续挡到列表追上。
            RecentSessionsStore.shared.updateExecutionAgent(
                sessionId: sessionId,
                agentId: sessionAgentId ?? agent.id,
                agentName: agent.name,
                agentAvatar: avatarRaw
            )
            await applyPreferredModel(for: agent.id)
            showTransientConfirmation("已切换到 \(agent.name)")
        } catch {
            sessionAgentId = previousAgentId
            vm?.executionAgentId = previousAgentId
            RecentSessionsStore.shared.revertExecutionAgent(
                sessionId: sessionId,
                agentId: previousFace?.agentId ?? previousAgentId,
                agentName: previousFace?.agentName,
                agentAvatar: previousFace?.agentAvatar
            )
            composerError = "切换 Agent 失败：\(error.localizedDescription)"
        }
    }

    private func handleErrorAction(_ action: ChatErrorAction, message: ChatMessage) {
        switch action {
        case .retry:
            retryAfterError(message)
        case .switchModel:
            Task {
                await modelStore.ensureLoaded()
                guard !modelStore.availableModels.isEmpty else {
                    composerError = modelStore.loadError ?? L10n.ErrorRecovery.noModels
                    return
                }
                showErrorModelSelector = true
            }
        case .recharge:
            showBillingWallet = true
        case .relogin:
            showReloginConfirm = true
        case .newConversation:
            Task { await startFreshConversationAfterError(message) }
        }
    }

    private func retryAfterError(_ message: ChatMessage) {
        guard let vm,
              let errorIndex = vm.messages.firstIndex(where: {
                  $0.id == message.id || $0.identityKeys.contains(message.effectiveId)
              }),
              let userMessage = vm.messages[..<errorIndex].last(where: {
                  $0.isRetryableUserMessage
              }) else {
            composerError = L10n.ErrorRecovery.retrySourceMissing
            return
        }

        let resend = {
            let blocks = userMessage.resendBlockPayloads
            let accepted = vm.send(
                userMessage.text,
                modelId: selectedModel?.id,
                agentMode: vm.agentMode,
                blocks: blocks.isEmpty ? nil : blocks
            )
            if accepted {
                scrollToBottomToken += 1
            } else {
                composerError = vm.actionError ?? L10n.ErrorRecovery.retryFailed
            }
        }

        guard PrivacyConsentStore.shared.hasAcceptedAISharing else {
            guard let retryModel = resolvedSendModel else {
                composerError = "没有可用模型：请在管理后台配置并激活聊天模型后重试。"
                return
            }
            requestAISharingConsent(for: retryModel, action: resend)
            return
        }
        resend()
    }

    private func startFreshConversationAfterError(_: ChatMessage) async {
        // “新开对话”只切入新的本地草稿页；不能在这里预建空 Session，否则会绕过
        // W0-B 的首发事务，也会留下没有真实首条消息的服务端会话。
        onOpenConversation(ConversationTarget(
            title: target.title,
            workspaceId: target.workspaceId,
            organizationId: target.organizationId,
            agentId: target.agentId,
            projectId: target.projectId,
            startsNewSession: true
        ))
    }

    private func showTransientConfirmation(_ message: String, duration: Double = 1.5) {
        copyConfirmation = message
        copyConfirmationTask?.cancel()
        copyConfirmationTask = Task { @MainActor in
            try? await Task.sleep(for: .milliseconds(Int64(duration * 1_000)))
            copyConfirmation = nil
        }
    }

    private func focusMessageRow(_ rowId: String) {
        scrollTargetMessageId = rowId
        highlightedMessageId = rowId
        messageHighlightTask?.cancel()
        messageHighlightTask = Task { @MainActor in
            try? await Task.sleep(for: .milliseconds(1800))
            guard highlightedMessageId == rowId else { return }
            highlightedMessageId = nil
        }
    }

    private func switchToSession(_ sessionId: String) async {
        vm?.stopSession()
        modelSelectionGeneration += 1
        runtimeSettingsGeneration += 1
        isSwitchingModel = false
        selectedModelId = nil
        selectedContextTierId = nil
        selectedThinkingMode = nil
        editingMessageId = nil
        editingMessageSubmittingId = nil
        editingMessageError = nil
        pendingEditResend = nil
        draft = ""
        composerResetToken += 1
        attachmentManager.clear(contextId: currentAttachmentContextId, deactivateUploaded: true)
        attachmentUploadContextId = nil
        contextRefs.removeAll()
        // 切换前先回到入口默认作用域；若读取新会话快照成功会立即被其冻结
        // Workspace / Project 覆盖，失败时也不会误沿用上一条会话的执行位置。
        sessionInfo = nil
        adoptExecutionScope(.entry(
            workspaceId: target.workspaceId,
            projectId: target.projectId,
            organizationId: target.organizationId
        ))
        await loadSessionInfo(sessionId: sessionId, fallback: target.agentId)
        let scope = executionScope
        let model = ConversationViewModel(
            sessionId: sessionId,
            workspaceId: scope.workspaceId,
            organizationId: scope.organizationId,
            projectId: scope.projectId
        )
        model.executionAgentId = sessionAgentId ?? target.agentId
        vm = model
        bindQueuedSendReceiptHandler(to: model)
        loadState = .ready
        await model.startSession()
        await ChatModelStore.shared.ensureLoaded()
        scrollToBottomToken += 1
    }

    private var currentAttachmentContextId: String {
        attachmentUploadContextId
            ?? vm?.sessionId
            ?? target.sessionId
            ?? (target.startsNewSession ? draftSessionCoordinator.draftId : nil)
            ?? ""
    }

    private func attachmentUploadScope() -> UploadScope? {
        let contextId = currentAttachmentContextId
        let scope = AttachmentUploadScopeResolver.resolve(
            contextId: contextId,
            targetOrganizationId: target.startsNewSession ? nil : target.organizationId,
            draftOrganizationId: target.startsNewSession
                ? draftSessionCoordinator.draft.organizationId
                : nil,
            sessionOrganizationId: sessionInfo?.organizationId,
            workspaceOrganizationId: workspace.selectedOrganizationId
        )
        guard let scope else { return nil }
        attachmentUploadContextId = contextId
        return scope
    }

    private func bindCapsuleVoiceHandlers() {
        capsuleVoiceController.onTap = { [self] in
            handleCapsuleReturnToConversation()
        }
        capsuleVoiceController.onNeedsConsent = { [self] in
            if let model = ChatModelStore.shared.sendableModel()
                ?? ChatModelStore.shared.availableModels.first {
                requestAISharingConsent(for: model) {
                    capsuleVoiceController.noteConsentGrantedFirstTime()
                    workbenchVoiceNotice = L10n.Privacy.aiVoiceConsentHoldAgain
                }
            } else {
                workbenchVoiceNotice = "没有可用模型，暂无法开启语音指令。"
                capsuleVoiceController.noteConsentGrantedFirstTime()
            }
        }
        capsuleVoiceController.onFreezeFocus = { [self] in
            refreshCurrentFocusSnapshot()
            return taskSurfaceCoordinator.currentFocusSnapshot
        }
        capsuleVoiceController.onReadyToSubmit = { [self] text, focus in
            sendCapsuleVoiceCommand(text, frozenFocus: focus)
        }
        capsuleVoiceController.onNotice = { [self] message in
            workbenchVoiceNotice = message
        }
        capsuleVoiceController.textComposerDisabledReason = { [self] in
            executionScopeHardBlockReason
                ?? RemoteExecutionNoticePresentation.composerDisabledReason(
                    for: remoteExecutionState
                )
        }
        capsuleVoiceController.onTextSend = { [self] text in
            sendCapsuleTextCommand(text)
        }
    }

    private func bindQueuedSendReceiptHandler(to viewModel: ConversationViewModel) {
        viewModel.onQueuedSendReceipt = { [self] queueId, receipt in
            // 仅推进胶囊语音那条 pending；普通 Composer 发送的 ACK 不改胶囊 notice。
            guard taskSurfaceCoordinator.pendingVoiceQueueId == queueId else { return }
            taskSurfaceCoordinator.advanceVoiceDispatchReceipt(queueId: queueId, to: receipt)
            switch receipt {
            case .accepted:
                workbenchVoiceNotice = receipt.userFacingMessage
                capsuleVoiceController.reset()
            case .failed(let reason):
                workbenchVoiceNotice = reason
                // 失败保留可恢复 transcript；用户可再次按住重试。
                capsuleVoiceController.noteSubmitFailed(reason: reason)
            case .persisted, .queued, .blocked:
                workbenchVoiceNotice = receipt.userFacingMessage
            }
        }
    }

    private func handleCapsuleVoiceInputRequest(_ request: VoiceInputRequest?) {
        guard let request else { return }
        // 胶囊已改为真·按住说话；仅 Composer 兼容路径仍走 sheet。
        guard request == .composer else {
            taskSurfaceCoordinator.clearVoiceInputRequest()
            return
        }
        voiceInputPreferDirectSend = false
        if !PrivacyConsentStore.shared.hasAcceptedAISharing {
            if let model = ChatModelStore.shared.sendableModel()
                ?? ChatModelStore.shared.availableModels.first {
                requestAISharingConsent(for: model) { [self] in
                    workbenchVoiceNotice = L10n.Privacy.aiVoiceConsentHoldAgain
                }
            }
            taskSurfaceCoordinator.clearVoiceInputRequest()
            return
        }
        showVoiceInput = true
        taskSurfaceCoordinator.clearVoiceInputRequest()
    }

    private func handleVoiceResult(_ result: ChatVoiceResult) {
        voiceInputPreferDirectSend = false
        switch result {
        case .fillDraft(let text):
            draft = text
        case .sendDirectly(let text):
            draft = text
            Task { await sendCurrentDraft() }
        case .cancelled:
            break
        }
    }

    /// 胶囊迷你文字条：与语音同源入队门禁，不改 Composer 草稿、不强制跳整页。
    private func sendCapsuleTextCommand(_ text: String) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }

        if let hardBlock = executionScopeHardBlockReason
            ?? RemoteExecutionNoticePresentation.composerDisabledReason(
                for: remoteExecutionState
            ) {
            workbenchVoiceNotice = hardBlock
            return
        }

        refreshCurrentFocusSnapshot()
        let focus = taskSurfaceCoordinator.currentFocusSnapshot
        // 复用胶囊纯文本策略：无附件、不改草稿。
        let request = ConversationSubmissionRequest.capsuleVoice(
            transcript: trimmed,
            focusSnapshot: focus
        )
        guard request.source == .capsuleVoice,
              !request.shouldMutateComposerDraft,
              !request.includesComposerBlocks else { return }

        guard let viewModel = vm else {
            workbenchVoiceNotice = "会话尚未就绪，请稍后再试。"
            return
        }
        bindQueuedSendReceiptHandler(to: viewModel)

        switch ConversationSubmission.gate(
            hitlPending: viewModel.hitl.pendingCount > 0,
            isPaused: viewModel.isPaused,
            billingBlocked: viewModel.billingBlockedTitle != nil || viewModel.billingBlockedMessage != nil,
            hasSendableModel: ChatModelStore.shared.sendableModelId() != nil
        ) {
        case .block(let reason):
            workbenchVoiceNotice = reason
            return
        case .allow:
            break
        }

        let surfaceBefore = taskSurfaceCoordinator.compactSurface
        let modeBefore = taskSurfaceCoordinator.viewMode
        let pathBefore = workbenchNavigationState.path

        let receipt = viewModel.enqueue(
            request.text,
            blocks: nil,
            focusSnapshot: request.focusSnapshot
        ) ?? .failed(reason: "未能发送消息")

        if taskSurfaceCoordinator.compactSurface != surfaceBefore {
            taskSurfaceCoordinator.selectCompactSurface(surfaceBefore)
        }
        if taskSurfaceCoordinator.viewMode != modeBefore {
            taskSurfaceCoordinator.setViewMode(modeBefore)
        }
        if workbenchNavigationState.path != pathBefore {
            workbenchNavigationState.path = pathBefore
        }

        switch receipt {
        case .persisted, .queued, .accepted:
            capsuleVoiceController.dismissTextComposer()
            workbenchVoiceNotice = receipt.userFacingMessage
        case .blocked(let reason), .failed(let reason):
            workbenchVoiceNotice = receipt.userFacingMessage.isEmpty ? reason : receipt.userFacingMessage
        }
    }

    /// 胶囊语音指令：仅 transcript + 冻结 Focus；零污染 Composer；原地反馈。
    /// Focus 必须来自按住起录时的冻结快照；禁止读当前页 live fallback。
    private func sendCapsuleVoiceCommand(
        _ transcript: String,
        frozenFocus: FocusSnapshot? = nil
    ) {
        let trimmed = transcript.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }

        if let hardBlock = executionScopeHardBlockReason
            ?? RemoteExecutionNoticePresentation.composerDisabledReason(
                for: remoteExecutionState
            ) {
            workbenchVoiceNotice = hardBlock
            capsuleVoiceController.noteSubmitFailed(reason: hardBlock)
            taskSurfaceCoordinator.recordVoiceDispatchReceipt(.blocked(reason: hardBlock))
            return
        }

        guard let focus = frozenFocus ?? capsuleVoiceController.frozenFocus else {
            workbenchVoiceNotice = "焦点已失效，请重新按住说话"
            capsuleVoiceController.noteSubmitFailed(reason: "焦点已失效，请重新按住说话")
            return
        }
        let request = ConversationSubmissionRequest.capsuleVoice(
            transcript: trimmed,
            focusSnapshot: focus
        )
        guard request.source == .capsuleVoice,
              !request.shouldMutateComposerDraft,
              !request.includesComposerBlocks else { return }

        guard let viewModel = vm else {
            workbenchVoiceNotice = "会话尚未就绪，指令已保留在转写结果中。"
            capsuleVoiceController.noteSubmitFailed(reason: "会话尚未就绪")
            return
        }
        bindQueuedSendReceiptHandler(to: viewModel)

        switch ConversationSubmission.gate(
            hitlPending: viewModel.hitl.pendingCount > 0,
            isPaused: viewModel.isPaused,
            billingBlocked: viewModel.billingBlockedTitle != nil || viewModel.billingBlockedMessage != nil,
            hasSendableModel: ChatModelStore.shared.sendableModelId() != nil
        ) {
        case .block(let reason):
            workbenchVoiceNotice = reason
            capsuleVoiceController.noteSubmitFailed(reason: reason)
            taskSurfaceCoordinator.recordVoiceDispatchReceipt(.blocked(reason: reason))
            return
        case .allow:
            break
        }

        let surfaceBefore = taskSurfaceCoordinator.compactSurface
        let modeBefore = taskSurfaceCoordinator.viewMode
        let pathBefore = workbenchNavigationState.path

        let receipt = viewModel.enqueue(
            request.text,
            blocks: nil,
            focusSnapshot: request.focusSnapshot
        ) ?? .failed(reason: "未能提交语音指令")

        // 发送后不得改变 surface / viewMode / 资源 path。
        if taskSurfaceCoordinator.compactSurface != surfaceBefore {
            taskSurfaceCoordinator.selectCompactSurface(surfaceBefore)
        }
        if taskSurfaceCoordinator.viewMode != modeBefore {
            taskSurfaceCoordinator.setViewMode(modeBefore)
        }
        if workbenchNavigationState.path != pathBefore {
            workbenchNavigationState.path = pathBefore
        }

        switch receipt {
        case .persisted, .queued:
            // 保留 transcript 直至 ACK「已送达」；失败时可恢复重试。
            taskSurfaceCoordinator.recordVoiceDispatchReceipt(receipt)
            workbenchVoiceNotice = receipt.userFacingMessage
        case .blocked(let reason), .failed(let reason):
            taskSurfaceCoordinator.recordVoiceDispatchReceipt(receipt)
            workbenchVoiceNotice = receipt.userFacingMessage
            capsuleVoiceController.noteSubmitFailed(reason: reason)
        case .accepted:
            taskSurfaceCoordinator.recordVoiceDispatchReceipt(receipt)
            workbenchVoiceNotice = receipt.userFacingMessage
            capsuleVoiceController.reset()
        }
    }

    private func refreshCurrentFocusSnapshot() {
        let snapshot = FocusSnapshot.projecting(
            navigationState: workbenchNavigationState,
            spaceId: target.workspaceId,
            viewMode: taskSurfaceCoordinator.viewMode,
            isCompactLayout: taskSurfaceCoordinator.isCompactLayout,
            compactSurface: taskSurfaceCoordinator.compactSurface
        )
        taskSurfaceCoordinator.updateFocusSnapshot(snapshot)
        FocusProbe.dump(
            snapshot: snapshot,
            navigation: workbenchNavigationState,
            compactSurface: taskSurfaceCoordinator.compactSurface,
            viewMode: taskSurfaceCoordinator.viewMode
        )
    }

    // MARK: - 新任务草稿恢复

    private var draftPersistenceKey: ConversationDraftPersistenceKey {
        ConversationDraftPersistenceKey(
            text: draft,
            modelId: selectedModelId,
            contextTierId: selectedContextTierId,
            thinkingMode: selectedThinkingMode?.rawValue,
            agentMode: draftAgentMode,
            approvalMode: draftApprovalMode,
            agentId: draftSessionCoordinator.agentId,
            attachmentSignatures: attachmentManager.attachments.map {
                "\($0.id)|\($0.status.rawValue)|\($0.fileId ?? "")"
            },
            contextSignatures: contextRefs.map {
                "\($0.id)|\($0.type.rawValue)|\($0.resourceId)"
            }
        )
    }

    private var draftScope: ConversationDraftScope? {
        guard target.startsNewSession else { return nil }
        // 跟当前草稿执行现场，而不是入口 target——Folder 切换后持久化/恢复都要落在新 Workspace。
        return try? ConversationDraftScope(
            organizationId: draftSessionCoordinator.draft.organizationId,
            workspaceId: draftSessionCoordinator.draft.workspaceId,
            projectId: draftSessionCoordinator.draft.projectId
        )
    }

    private func restoreDraftIfAvailable() async {
        guard target.startsNewSession,
              let draftStore,
              let scope = draftScope,
              let snapshot = try? await draftStore.load(scope: scope) else {
            return
        }

        guard draftSessionCoordinator.restore(
            draftId: snapshot.draftId,
            agentId: snapshot.agentId,
            pendingSessionId: snapshot.pendingSessionId
        ) else {
            return
        }

        selectedModelId = snapshot.modelId
        selectedContextTierId = snapshot.contextTierId
        selectedThinkingMode = ChatModelThinkingMode.parse(snapshot.thinkingMode)
        draftAgentMode = snapshot.agentMode.rawValue
        draftApprovalMode = snapshot.approvalMode
            .clamped(permitsRelaxedApproval: workspace.allowMemberYolo)
            .rawValue
        attachmentUploadContextId = snapshot.draftId
        attachmentManager.restoreUploadedAttachments(
            snapshot.attachments.map { $0.composerAttachment() }
        )

        let restoredRefs = snapshot.contextReferences.map { $0.mentionContextRef() }
        contextRefs = restoredRefs
        for incomingRef in target.initialContextRefs where !contextRefs.contains(where: { $0.id == incomingRef.id }) {
            contextRefs.append(incomingRef)
        }

        let restoredText = snapshot.text.trimmingCharacters(in: .whitespacesAndNewlines)
        let incomingText = target.initialMessage?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        switch (restoredText.isEmpty, incomingText.isEmpty, restoredText == incomingText) {
        case (true, false, _):
            draft = incomingText
        case (false, false, false):
            // 两份内容都属于用户输入；合并而不静默覆盖，并让用户在发送前仍可编辑。
            draft = "\(restoredText)\n\n\(incomingText)"
        default:
            draft = restoredText
        }
        if !target.initialContextResources.isEmpty {
            contextResources = target.initialContextResources
        }
        didSeedInitialDraft = true
    }

    private func makeDraftSnapshot(pendingSessionId: String? = nil) -> ConversationDraftSnapshot? {
        guard target.startsNewSession,
              !draftWasConsumed,
              let scope = draftScope else {
            return nil
        }
        return ConversationDraftSnapshot(
            draftId: draftSessionCoordinator.draftId,
            scope: scope,
            text: draft,
            agentId: draftSessionCoordinator.agentId,
            modelId: selectedModelId,
            contextTierId: selectedContextTierId,
            thinkingMode: selectedThinkingMode?.rawValue,
            agentMode: ChatAgentMode.resolve(draftAgentMode),
            approvalMode: (
                ChatApprovalMode.resolve(draftApprovalMode) ?? .alwaysAsk
            ).clamped(permitsRelaxedApproval: workspace.allowMemberYolo),
            pendingSessionId: pendingSessionId ?? draftSessionCoordinator.sessionId,
            attachments: attachmentManager.attachments.compactMap(
                ConversationDraftAttachmentReference.init(attachment:)
            ),
            contextReferences: contextRefs.map(
                ConversationDraftContextReference.init(contextRef:)
            )
        )
    }

    private func scheduleDraftPersistence() {
        guard let draftStore,
              let snapshot = makeDraftSnapshot() else {
            return
        }
        draftPersistenceTask?.cancel()
        draftPersistenceTask = Task {
            try? await Task.sleep(for: .milliseconds(350))
            guard !Task.isCancelled else { return }
            _ = try? await draftStore.save(snapshot)
        }
    }

    private func persistDraftNow(pendingSessionId: String? = nil) async {
        guard let draftStore,
              let snapshot = makeDraftSnapshot(pendingSessionId: pendingSessionId) else {
            return
        }
        draftPersistenceTask?.cancel()
        _ = try? await draftStore.save(snapshot)
    }

    private func persistDraftBeforeLeaving() {
        guard let draftStore,
              let snapshot = makeDraftSnapshot() else {
            return
        }
        draftPersistenceTask?.cancel()
        draftPersistenceTask = Task {
            _ = try? await draftStore.save(snapshot)
        }
    }

    private func consumePersistedDraft() async {
        draftPersistenceTask?.cancel()
        draftWasConsumed = true
        guard let draftStore, let scope = draftScope else { return }
        try? await draftStore.markSessionCreated(scope: scope)
    }

    private func discardDraftAndClose() async {
        draftPersistenceTask?.cancel()
        if let sessionId = draftSessionCoordinator.sessionId {
            let _: ApiEnvelope<String?>? = try? await APIClient.shared.delete(
                path: Endpoints.Chat.session(sessionId)
            )
        }
        if let draftStore, let scope = draftScope {
            try? await draftStore.discard(scope: scope)
        }
        draftWasConsumed = true
        attachmentManager.clear(contextId: currentAttachmentContextId, deactivateUploaded: true)
        onBack()
    }

    // MARK: - Session 解析

    private func resolveSession() async {
        loadState = .loading
        do {
            seedInitialDraftIfNeeded()

            // 新建对话先呈现本地草稿，不在打开页面时制造空 Session 或订阅空会话。
            if target.startsNewSession, target.sessionId == nil {
                vm = nil
                loadState = .ready
                await ChatModelStore.shared.ensureLoaded()
                await refreshSpaceRuntimeStatus()
                return
            }

            let sessionId: String
            if let preResolved = target.sessionId {
                sessionId = preResolved
            } else {
                sessionId = try await ChatSessionResolver.resolve(
                    workspaceId: target.workspaceId,
                    organizationId: target.organizationId
                )
            }
            await loadSessionInfo(sessionId: sessionId, fallback: target.agentId)
            let scope = executionScope
            let model = ConversationViewModel(
                sessionId: sessionId,
                workspaceId: scope.workspaceId,
                organizationId: scope.organizationId,
                projectId: scope.projectId
            )
            model.executionAgentId = sessionAgentId ?? target.agentId
            vm = model
            loadState = .ready

            // 进已有会话：单通道常驻订阅 + 历史回放（startSession 内先 seed history 再订阅 live）。
            await model.startSession()

            if let messageId = target.messageId, !messageId.isEmpty {
                if let rowId = await model.focusMessage(messageId) {
                    focusMessageRow(rowId)
                } else {
                    scrollToBottomToken += 1
                    showTransientConfirmation(
                        L10n.Notifications.messageUnavailableFallback,
                        duration: 2.5
                    )
                }
            }

            // 确保模型目录就绪：发送需带真实 model_id（自动发送 / 用户首发都依赖它）。
            await modelStore.ensureLoaded()
            await refreshSpaceRuntimeStatus()

            // ➕ 新建对话：进入后自动发送首条消息（仅一次）。
            let first = target.initialMessage?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            let initialBlocks = target.initialContextRefs.map { $0.blockPayload() }
            if !didSendInitial, !first.isEmpty || !initialBlocks.isEmpty {
                didSendInitial = true
                guard executionScopeHardBlockReason == nil,
                      !remoteExecutionState.blocksComposer else {
                    draft = first
                    return
                }
                guard let sendModel = resolvedSendModel else {
                    draft = first
                    composerError = "没有可用模型：请在管理后台配置并激活聊天模型后重试。"
                    return
                }
                guard PrivacyConsentStore.shared.hasAcceptedAISharing else {
                    draft = first
                    requestAISharingConsent(for: sendModel) {
                        model.send(
                            first,
                            modelId: sendModel.id,
                            agentMode: model.agentMode,
                            approvalMode: model.approvalMode,
                            blocks: initialBlocks.isEmpty ? nil : initialBlocks
                        )
                        scrollToBottomToken += 1
                    }
                    return
                }
                model.send(
                    first,
                    modelId: sendModel.id,
                    agentMode: model.agentMode,
                    approvalMode: model.approvalMode,
                    blocks: initialBlocks.isEmpty ? nil : initialBlocks
                )
                scrollToBottomToken += 1
            }
        } catch {
            loadState = .failed("会话加载失败：\(error.localizedDescription)")
        }
    }

    private func seedInitialDraftIfNeeded() {
        guard !didSeedInitialDraft else { return }
        didSeedInitialDraft = true
        draft = target.initialMessage ?? ""
        contextRefs = target.initialContextRefs
        if !target.initialContextResources.isEmpty {
            contextResources = target.initialContextResources
        }
    }

    /// Agent 列表复用 MyAgentsStore：同组织已缓存则秒显，不再每次进对话重打 /agents。
    /// 停用项仍保留，选择器诚实标「不可用」。preferred_model_id 仍按需读详情。
    private func loadAgentCandidates() async {
        await myAgentsStore.ensureLoaded(organizationId: target.organizationId)

        guard myAgentsStore.loadedOrganizationId == target.organizationId else {
            agentPreferredModelIds = [:]
            return
        }

        let agents = myAgentsStore.agents
        if draftSessionCoordinator.agentId == nil,
           let defaultAgent = agents.first(where: { $0.isDefault == true }) ?? agents.first {
            _ = draftSessionCoordinator.selectAgent(id: defaultAgent.id)
        }
        if let currentAgentId {
            await loadPreferredModel(for: currentAgentId)
        }
    }

    /// 列表契约刻意不含 preferred_model_id；仅在当前选中 Agent 上按需读取详情，避免 N+1。
    @discardableResult
    private func loadPreferredModel(for agentId: String) async -> String? {
        if preferredModelAgentIdsLoaded.contains(agentId) {
            return agentPreferredModelIds[agentId]
        }
        preferredModelAgentIdsLoaded.insert(agentId)
        do {
            let detail: AgentPreferredModel = try await APIClient.shared.get(
                path: Endpoints.Agent.detail(agentId)
            )
            if let modelId = detail.preferredModelId?.trimmingCharacters(in: .whitespacesAndNewlines),
               !modelId.isEmpty {
                agentPreferredModelIds[agentId] = modelId
            }
        } catch {
            // 详情失败时保持“未提供”，不把组织默认模型冒充成 Agent 默认。
        }
        return agentPreferredModelIds[agentId]
    }

    /// Agent 与其偏好模型构成一次用户选择：已有会话持久化模型，草稿会话冻结到首条消息。
    private func applyPreferredModel(for agentId: String) async {
        let preferredModelId = await loadPreferredModel(for: agentId)
        let nextModelId = ConversationModelSelectionPolicy.modelIdAfterAgentChange(
            preferredModelId: preferredModelId,
            currentModelId: selectedModel?.id,
            availableModelIds: Set(modelStore.availableModels.map(\.id))
        )
        guard nextModelId != selectedModel?.id,
              let nextModelId,
              let model = modelStore.availableModels.first(where: { $0.id == nextModelId }) else {
            return
        }
        await selectModel(model)
    }

    private func loadSessionInfo(sessionId: String, fallback: String?) async {
        sessionInfoLoadGeneration += 1
        let generation = sessionInfoLoadGeneration
        do {
            let session: ChatSession = try await APIClient.shared.get(
                path: Endpoints.Chat.session(sessionId)
            )
            guard generation == sessionInfoLoadGeneration else { return }
            sessionInfo = session
            selectedModelId = ConversationModelSelectionPolicy.restoredModelId(
                currentModelId: session.currentModelId,
                defaultModelId: session.defaultModelId,
                catalogDefaultModelId: modelStore.currentModel()?.id
            )
            applyRuntimeSettingsFromSession(session)
            adoptExecutionScope(session.executionScope(fallback: .entry(
                workspaceId: target.workspaceId,
                projectId: target.projectId,
                organizationId: target.organizationId
            )))
            sessionAgentId = session.agentId ?? fallback ?? sessionAgentId
            vm?.executionAgentId = sessionAgentId
        } catch {
            guard generation == sessionInfoLoadGeneration else { return }
            // 未拿到 Session 快照时只保留入口已知 Agent，不用 Workspace 默认值冒充会话事实。
            sessionAgentId = fallback ?? sessionAgentId
            vm?.executionAgentId = sessionAgentId
        }
    }

    private func applyRuntimeSettingsFromSession(_ session: ChatSession) {
        let model = modelStore.availableModels.first(where: { $0.id == selectedModelId })
            ?? selectedModel
        // 无 catalog 模型时仍保留 session 原值，避免空模型把意图夹空。
        guard let model else {
            selectedContextTierId = session.contextTierId
            selectedThinkingMode = session.modelParamOverrides?.thinkingMode
            return
        }
        let next = ComposerRuntimeSettingsProjection.clampedSelection(
            model: model,
            selectedTierId: session.contextTierId,
            selectedThinkingMode: session.modelParamOverrides?.thinkingMode
        )
        selectedContextTierId = next.contextTierId
        selectedThinkingMode = next.thinkingMode
    }

    private func applyClampedRuntimeSettings(for model: ChatModel) {
        let next = ComposerRuntimeSettingsProjection.clampedSelection(
            model: model,
            selectedTierId: selectedContextTierId,
            selectedThinkingMode: selectedThinkingMode
        )
        selectedContextTierId = next.contextTierId
        selectedThinkingMode = next.thinkingMode
    }

    /// 新会话选择属于草稿；已有会话选择写回 Session，供 Electron/iOS 共同恢复。
    private func selectModel(_ model: ChatModel) async {
        let hasActiveRun = vm?.isStreaming == true || vm?.canCancel == true
        guard ConversationModelSelectionPolicy.canSelect(
            hasActiveRun: hasActiveRun,
            isSwitchingModel: isSwitchingModel
        ) else { return }
        guard let sessionId = vm?.sessionId else {
            selectedModelId = model.id
            applyClampedRuntimeSettings(for: model)
            showTransientConfirmation(L10n.ErrorRecovery.modelSwitched(model.displayName))
            return
        }

        modelSelectionGeneration += 1
        let generation = modelSelectionGeneration
        isSwitchingModel = true
        defer {
            if generation == modelSelectionGeneration {
                isSwitchingModel = false
            }
        }
        do {
            let clamped = ComposerRuntimeSettingsProjection.clampedSelection(
                model: model,
                selectedTierId: selectedContextTierId,
                selectedThinkingMode: selectedThinkingMode
            )
            let response = try await ChatSessionResolver.switchModel(
                sessionId: sessionId,
                modelId: model.id,
                contextTierId: clamped.contextTierId
            )
            guard generation == modelSelectionGeneration,
                  vm?.sessionId == sessionId else { return }
            selectedModelId = response.currentModelId
            selectedContextTierId = clamped.contextTierId
            selectedThinkingMode = clamped.thinkingMode
            if let thinkingMode = clamped.thinkingMode,
               model.thinkingCapability != nil {
                do {
                    let overrides = try await ChatSessionResolver.updateModelParams(
                        sessionId: sessionId,
                        thinkingMode: thinkingMode,
                        preserving: sessionInfo?.modelParamOverrides
                    )
                    selectedThinkingMode = overrides.thinkingMode ?? thinkingMode
                } catch {
                    composerError = "思考强度写入失败：\(error.localizedDescription)"
                }
            }
            await loadSessionInfo(sessionId: sessionId, fallback: sessionAgentId)
            guard generation == modelSelectionGeneration,
                  vm?.sessionId == sessionId else { return }
            showTransientConfirmation(L10n.ErrorRecovery.modelSwitched(model.displayName))
        } catch {
            guard generation == modelSelectionGeneration,
                  vm?.sessionId == sessionId else { return }
            composerError = "模型切换失败：\(error.localizedDescription)"
        }
    }

    private func selectContextTier(_ tierId: String) async {
        guard let model = selectedModel, model.canSelectContextTier else { return }
        guard model.selectableContextTiers.contains(where: { $0.id == tierId }) else { return }
        selectedContextTierId = tierId
        guard let sessionId = vm?.sessionId else { return }

        runtimeSettingsGeneration += 1
        let generation = runtimeSettingsGeneration
        do {
            let persisted = try await ChatSessionResolver.switchContextTier(
                sessionId: sessionId,
                tierId: tierId
            )
            guard generation == runtimeSettingsGeneration,
                  vm?.sessionId == sessionId else { return }
            selectedContextTierId = persisted ?? tierId
        } catch {
            guard generation == runtimeSettingsGeneration,
                  vm?.sessionId == sessionId else { return }
            composerError = "上下文长度更新失败：\(error.localizedDescription)"
            await loadSessionInfo(sessionId: sessionId, fallback: sessionAgentId)
        }
    }

    private func selectThinkingMode(_ mode: ChatModelThinkingMode) async {
        guard let capability = selectedModel?.thinkingCapability,
              capability.modes.contains(mode) else { return }
        selectedThinkingMode = mode
        guard let sessionId = vm?.sessionId else { return }

        runtimeSettingsGeneration += 1
        let generation = runtimeSettingsGeneration
        do {
            let overrides = try await ChatSessionResolver.updateModelParams(
                sessionId: sessionId,
                thinkingMode: mode,
                preserving: sessionInfo?.modelParamOverrides
            )
            guard generation == runtimeSettingsGeneration,
                  vm?.sessionId == sessionId else { return }
            selectedThinkingMode = overrides.thinkingMode ?? mode
            // 刷新快照，确保后续 merge 能读到最新 performance_profile。
            await loadSessionInfo(sessionId: sessionId, fallback: sessionAgentId)
        } catch {
            guard generation == runtimeSettingsGeneration,
                  vm?.sessionId == sessionId else { return }
            composerError = "思考强度更新失败：\(error.localizedDescription)"
            await loadSessionInfo(sessionId: sessionId, fallback: sessionAgentId)
        }
    }

    /// 草稿本地冻结的运行设置，在建 session / 首发后立刻写回。
    private func flushDraftRuntimeSettings(sessionId: String) async {
        if let model = selectedModel, model.canSelectContextTier,
           let tierId = selectedContextTierId {
            do {
                let persisted = try await ChatSessionResolver.switchContextTier(
                    sessionId: sessionId,
                    tierId: tierId
                )
                selectedContextTierId = persisted ?? tierId
            } catch {
                composerError = "上下文长度写入失败：\(error.localizedDescription)"
            }
        }
        if let model = selectedModel, model.thinkingCapability != nil,
           let mode = selectedThinkingMode {
            do {
                let overrides = try await ChatSessionResolver.updateModelParams(
                    sessionId: sessionId,
                    thinkingMode: mode,
                    preserving: sessionInfo?.modelParamOverrides
                )
                selectedThinkingMode = overrides.thinkingMode ?? mode
            } catch {
                composerError = "思考强度写入失败：\(error.localizedDescription)"
            }
        }
    }

    // MARK: - Space runtime status

    private func adoptExecutionScope(_ scope: ConversationExecutionScope) {
        guard executionScope != scope else { return }
        executionScope = scope
        executionWorkspaceName = nil
        executionDeviceName = nil
        executionDeviceStatus = nil
        executionScopeHardBlockReason = nil
        remoteExecutionState = .ready
    }

    private func monitorSpaceRuntimeStatus() async {
        while !Task.isCancelled {
            await refreshSpaceRuntimeStatus()
            let interval: Duration = executionScopeHardBlockReason == nil && remoteExecutionState == .ready
                ? .seconds(30)
                : .seconds(10)
            try? await Task.sleep(for: interval)
        }
    }

    private func refreshSpaceRuntimeStatus() async {
        let scope = executionScope
        guard !scope.workspaceId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            executionWorkspaceName = nil
            executionDeviceName = nil
            executionDeviceStatus = nil
            remoteExecutionState = .ready
            executionScopeHardBlockReason = "未选择有效 Workspace，暂时无法发送任务。"
            return
        }
        do {
            // 不用 fetchWorkspaceAsSpace：它映射成 Space 后会丢掉 device_online。
            let summary: WorkspaceSummary = try await APIClient.shared.get(
                path: Endpoints.Context.workspace(scope.workspaceId)
            )
            guard scope == executionScope else { return }
            let space = summary.asSpace()
            guard space.isExecutionSpace else {
                executionWorkspaceName = nil
                executionDeviceName = nil
                executionDeviceStatus = nil
                remoteExecutionState = .ready
                executionScopeHardBlockReason = "会话未绑定有效 Workspace，暂时无法发送任务。"
                return
            }
            executionWorkspaceName = space.name
            executionScopeHardBlockReason = nil
            guard let deviceId = summary.deviceId, !deviceId.isEmpty else {
                executionDeviceName = nil
                executionDeviceStatus = nil
                remoteExecutionState = .workspaceNeedsDevice
                return
            }
            // device_online 与 RuntimeDevice.isAvailableForExecution 同义（后端 online/busy 视为可达），
            // 且随本次响应返回，比设备列表更新。设备名仍只在设备对象上，优先读 WS 事件维护的本地缓存。
            if let cached = workspace.devicesById[deviceId] {
                executionDeviceName = cached.name
                executionDeviceStatus = cached.status
                remoteExecutionState = (summary.deviceOnline ?? cached.isAvailableForExecution)
                    ? .ready
                    : .deviceUnavailable
                return
            }
            let device = try await fetchRuntimeDevice(
                deviceId: deviceId,
                organizationId: scope.organizationId
            )
            guard scope == executionScope else { return }
            executionDeviceName = device?.name
            executionDeviceStatus = device?.status
            remoteExecutionState = (summary.deviceOnline ?? device?.isAvailableForExecution ?? false)
                ? .ready
                : .deviceUnavailable
        } catch {
            guard scope == executionScope else { return }
            if isInvalidExecutionWorkspace(error) {
                executionWorkspaceName = nil
                executionDeviceName = nil
                executionDeviceStatus = nil
                remoteExecutionState = .ready
                executionScopeHardBlockReason = "会话未绑定有效 Workspace，暂时无法发送任务。"
                return
            }
            // 设备状态探测是展示层的补充，不是会话授权事实。已有会话已从服务端
            // session 快照恢复了冻结 Workspace；一次瞬时网络失败不能把它误判成
            // “未确认执行位置”并阻断发送，最终可执行性仍由服务端发送链路裁决。
            // 若此前已得到明确的离线/未绑定结论，则保留该提示，等待下一轮轮询刷新。
        }
    }

    private func fetchRuntimeDevice(
        deviceId: String,
        organizationId: String
    ) async throws -> RuntimeDevice? {
        let response: RuntimeDeviceListResponse = try await APIClient.shared.get(
            path: Endpoints.Context.devices,
            query: ["organization_id": organizationId]
        )
        return response.devices.first(where: { $0.id == deviceId })
    }

    private func isInvalidExecutionWorkspace(_ error: Error) -> Bool {
        guard case let APIError.serverError(statusCode, _) = error else { return false }
        return [400, 403, 404, 410].contains(statusCode)
    }

    // MARK: - WS 状态

    private var sessionReadyIndicatorColor: Color {
        SessionReadyIndicatorPolicy.showsReady(
            gatewayConnected: gateway.state == .connected,
            remoteExecutionState: remoteExecutionState
        ) ? .tt.bgSuccess : .tt.textTertiary
    }

    private var sessionReadyIndicatorAccessibilityText: String {
        SessionReadyIndicatorPolicy.showsReady(
            gatewayConnected: gateway.state == .connected,
            remoteExecutionState: remoteExecutionState
        ) ? "执行就绪" : "执行未就绪"
    }

    /// gateway 级别异常态 → 顶部状态条配置。正常 / 首次连接态不打扰（靠 toolbar 圆点表达）。
    private var terminalConnectionBannerInfo: (style: StatusBanner.Style, icon: String, text: String, showsProgress: Bool)? {
        switch gateway.state {
        case .reconnectGaveUp:
            return (.critical, "wifi.slash", "连接已断开，请检查网络", false)
        case .authFailed:
            return (.critical, "person.crop.circle.badge.exclamationmark", "登录已失效，请重新登录", false)
        case .disconnected, .connecting, .authenticating, .connected, .reconnecting:
            return nil
        }
    }

    private var connectionBannerInfo: (style: StatusBanner.Style, icon: String, text: String, showsProgress: Bool)? {
        switch gateway.state {
        case let .reconnecting(attempt):
            return (.warning, "wifi.exclamationmark", "网络不稳，重连中…（第 \(attempt) 次）", true)
        case .reconnectGaveUp:
            return (.critical, "wifi.slash", "连接已断开，请检查网络", false)
        case .authFailed:
            return (.critical, "person.crop.circle.badge.exclamationmark", "登录已失效，请重新登录", false)
        case .connected, .connecting, .authenticating, .disconnected:
            return nil
        }
    }

    private var cameraAccessIssueMessage: String {
        cameraAccessIssue?.message ?? L10n.Camera.unavailableMessage
    }
}

enum CameraAccessAction: Equatable {
    case presentCamera
    case requestPermission
    case showPermissionDenied
    case showRestricted
    case showUnavailable
}

func cameraAccessAction(
    cameraAvailable: Bool,
    authorizationStatus: AVAuthorizationStatus
) -> CameraAccessAction {
    guard cameraAvailable else { return .showUnavailable }

    switch authorizationStatus {
    case .authorized:
        return .presentCamera
    case .notDetermined:
        return .requestPermission
    case .denied:
        return .showPermissionDenied
    case .restricted:
        return .showRestricted
    @unknown default:
        return .showPermissionDenied
    }
}

private enum CameraAccessIssue {
    case permissionDenied
    case restricted
    case unavailable

    var title: String {
        switch self {
        case .permissionDenied, .restricted:
            return L10n.Camera.permissionTitle
        case .unavailable:
            return L10n.Camera.unavailableTitle
        }
    }

    var message: String {
        switch self {
        case .permissionDenied:
            return L10n.Camera.permissionMessage
        case .restricted:
            return L10n.Camera.restrictedMessage
        case .unavailable:
            return L10n.Camera.unavailableMessage
        }
    }

    var offersSettings: Bool {
        switch self {
        case .permissionDenied, .restricted:
            return true
        case .unavailable:
            return false
        }
    }
}

private struct OutgoingQueueStrip: View {
    let messages: [QueuedOutgoingMessage]
    let agentBusy: Bool
    let onRetry: (String) -> Void
    let onRemoveUnsent: (String) -> Void
    let onHideAcceptedTracking: (String) -> Void

    private var visibleMessages: [QueuedOutgoingMessage] {
        OutgoingQueuePolicy.stripMessages(messages, agentBusy: agentBusy)
    }

    var body: some View {
        if let first = visibleMessages.first {
            let presentation = OutgoingQueuePolicy.presentation(
                for: first.status,
                queueCount: visibleMessages.count
            )
            VStack(alignment: .leading, spacing: 0) {
                HStack(spacing: TTSpacing.xs) {
                    Circle()
                        .fill(color(for: presentation.tone).opacity(0.85))
                        .frame(width: 5, height: 5)
                    Text(presentation.title)
                        .font(.tt.caption)
                        .foregroundStyle(.tt.textSecondary)
                        .lineLimit(1)
                    Spacer(minLength: 0)
                }
                .padding(.horizontal, TTSpacing.md)
                .padding(.top, TTSpacing.xs)
                .padding(.bottom, 2)

                let rows = VStack(spacing: 0) {
                    ForEach(Array(visibleMessages.enumerated()), id: \.element.id) { index, message in
                        queueRow(message, index: index, last: index == visibleMessages.count - 1)
                    }
                }
                if visibleMessages.count > 3 {
                    ScrollView {
                        rows
                    }
                    .frame(maxHeight: 96)
                } else {
                    rows
                }
            }
            .background(
                RoundedRectangle(cornerRadius: TTRadius.sm, style: .continuous)
                    .fill(color(for: presentation.tone).opacity(0.07))
            )
        }
    }

    private func queueRow(_ message: QueuedOutgoingMessage, index: Int, last: Bool) -> some View {
        let presentation = OutgoingQueuePolicy.presentation(
            for: message.status,
            queueCount: visibleMessages.count
        )
        return VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .center, spacing: TTSpacing.xs) {
                Text("\(index + 1)")
                    .font(.tt.caption)
                    .monospacedDigit()
                    .foregroundStyle(.tt.textTertiary)
                    .frame(width: 12, alignment: .trailing)
                VStack(alignment: .leading, spacing: 0) {
                    Text(message.previewText)
                        .font(.tt.meta)
                        .foregroundStyle(.tt.textPrimary)
                        .lineLimit(1)
                    if let error = message.lastError, !error.isEmpty {
                        Text(
                            OutgoingQueuePolicy.displayDetail(
                                lastError: error,
                                fallback: presentation.fallbackDetail
                            )
                        )
                        .font(.tt.caption)
                        .foregroundStyle(.tt.textTertiary)
                        .lineLimit(1)
                    }
                }
                Spacer(minLength: TTSpacing.xs)
                actionButton(presentation.actions.primaryAction, id: message.id, presentation: presentation)
                actionButton(presentation.actions.secondaryAction, id: message.id, presentation: presentation)
            }
            .padding(.horizontal, TTSpacing.md)
            .padding(.vertical, 3)
            if !last {
                Divider().opacity(0.35)
            }
        }
    }

    @ViewBuilder
    private func actionButton(
        _ action: OutgoingQueueLocalAction?,
        id: String,
        presentation: OutgoingQueuePresentation
    ) -> some View {
        if let action {
            Button(presentation.label(for: action)) {
                switch action {
                case .retry:
                    onRetry(id)
                case .removeUnsent:
                    onRemoveUnsent(id)
                case .hideAcceptedTracking:
                    onHideAcceptedTracking(id)
                }
            }
            .font(.tt.caption)
            .foregroundStyle(action == .hideAcceptedTracking ? .tt.textTertiary : .tt.textAccent)
            .buttonStyle(.plain)
            .padding(.horizontal, TTSpacing.xs)
            .padding(.vertical, TTSpacing.xs)
            .contentShape(Rectangle())
        }
    }

    private func color(for tone: OutgoingQueueTone) -> Color {
        switch tone {
        case .accent: return .tt.textAccent
        case .warning: return .tt.textWarning
        case .critical: return .tt.textCritical
        }
    }
}

private extension ChatMessage {
    var isRetryableUserMessage: Bool {
        guard role == .user, !isPushNotification else { return false }
        let hasText = !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        let hasReplayableBlocks = blocks.contains {
            if case .attachment = $0 { return true }
            if case .contextRef = $0 { return true }
            return false
        }
        guard hasText || hasReplayableBlocks else { return false }
        return blocks.allSatisfy {
            switch $0 {
            case .text, .attachment, .contextRef:
                return true
            case .thinking, .tool, .richContent:
                return false
            }
        }
    }

    var isEditableResendUserMessage: Bool {
        guard role == .user,
              !isCompactionSummary,
              !isPushNotification,
              !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return false }
        return blocks.allSatisfy {
            switch $0 {
            case .text, .attachment, .contextRef:
                return true
            case .thinking, .tool, .richContent:
                return false
            }
        }
    }

    var resendBlockPayloads: [[String: Any]] {
        editResendDraftBlocks.map(\.payload)
    }

    var editResendDraftBlocks: [EditResendDraftBlock] {
        blocks.compactMap { block -> EditResendDraftBlock? in
            switch block {
            case .text:
                return nil
            case let .attachment(attachment):
                return EditResendDraftBlock(
                    source: .attachment(attachment.id),
                    payload: attachment.editResendPayload
                )
            case let .contextRef(ref):
                return EditResendDraftBlock(
                    source: .contextRef(ref.id),
                    payload: ref.editResendPayload
                )
            case .thinking, .tool, .richContent:
                return nil
            }
        }
    }

    var editResendComposerAttachments: [ComposerLocalAttachment] {
        blocks.compactMap { block in
            guard case let .attachment(attachment) = block else { return nil }
            return attachment.editResendComposerAttachment
        }
    }

    var editResendComposerContextRefs: [MentionContextRef] {
        blocks.compactMap { block in
            guard case let .contextRef(ref) = block else { return nil }
            return ref.editResendComposerContextRef
        }
    }

    var copyableText: String {
        let textContent = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if !textContent.isEmpty { return textContent }
        let parts = blocks.compactMap { block -> String? in
            switch block {
            case let .thinking(segment):
                return segment.text.isEmpty ? nil : segment.text
            case let .tool(tool):
                return [tool.name, tool.inputJson, tool.resultText ?? ""]
                    .filter { !$0.isEmpty }
                    .joined(separator: "\n")
            case let .attachment(attachment):
                return attachment.filename
            case let .richContent(block):
                return [block.title, block.summary].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: "\n")
            case let .contextRef(block):
                return [block.label, block.preview].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: "\n")
            case .text:
                return nil
            }
        }
        return parts.joined(separator: "\n\n").trimmingCharacters(in: .whitespacesAndNewlines)
    }
}

private extension AttachmentBlock {
    var editResendPayload: [String: Any] {
        var payload: [String: Any] = [
            "type": kind == .image ? "image" : "file",
            "filename": filename,
        ]
        if let mimeType { payload["mime_type"] = mimeType }
        if let size { payload["size"] = size }
        if let fileId { payload["file_id"] = fileId }
        if let url, !url.isEmpty {
            payload["url"] = url
            payload["remote_url"] = url
        }
        return payload
    }

    var editResendComposerAttachment: ComposerLocalAttachment {
        ComposerLocalAttachment(
            id: id,
            name: filename,
            kind: kind == .image ? .photo : .file,
            byteCount: size,
            mimeType: mimeType,
            url: nil,
            isTemporary: false,
            status: .ready,
            progress: 1,
            fileId: fileId,
            remoteURL: url
        )
    }
}

private extension ContextRefBlock {
    var editResendPayload: [String: Any] {
        var payload: [String: Any] = [
            "type": type,
            "label": label,
            "preview": preview ?? label,
        ]
        let normalizedType = type.lowercased()
        let resolvedTableId = tableId
            ?? (normalizedType == "table_selection" || normalizedType == "table" ? resourceId : nil)
        let resolvedDocId = docId
            ?? (["doc_selection", "document", "doc"].contains(normalizedType) ? resourceId : nil)
        if let resourceId = fieldIds.first ?? resourceId, !resourceId.isEmpty {
            payload["resource_id"] = resourceId
        }
        if let resolvedTableId, !resolvedTableId.isEmpty {
            payload["table_id"] = resolvedTableId
        }
        if let resolvedDocId, !resolvedDocId.isEmpty {
            payload["doc_id"] = resolvedDocId
        }
        if !rowIds.isEmpty { payload["row_ids"] = rowIds }
        if !fieldIds.isEmpty { payload["field_ids"] = fieldIds }
        if let url, !url.isEmpty { payload["url"] = url }
        if let spaceId, !spaceId.isEmpty { payload["space_id"] = spaceId }
        if let spaceName, !spaceName.isEmpty { payload["space_name"] = spaceName }
        if let locationHint, !locationHint.isEmpty { payload["location_hint"] = locationHint }
        return payload
    }

    var editResendComposerContextRef: MentionContextRef {
        let normalizedType = type.lowercased()
        let contextType: ContextRefType
        switch normalizedType {
        case "table_selection":
            contextType = fieldIds.isEmpty ? .table : .field
        case "doc_selection", "doc":
            contextType = .document
        case "code_file":
            contextType = .code
        case "goal":
            contextType = .tracker
        case "canvas":
            contextType = .whiteboard
        default:
            contextType = ContextRefType.fromItemType(normalizedType)
        }

        let resolvedResourceId: String
        switch contextType {
        case .field:
            resolvedResourceId = fieldIds.first ?? resourceId ?? label
        case .table:
            resolvedResourceId = tableId ?? resourceId ?? label
        case .document:
            resolvedResourceId = docId ?? resourceId ?? label
        default:
            resolvedResourceId = resourceId ?? docId ?? tableId ?? url ?? label
        }
        return MentionContextRef(
            id: id,
            type: contextType,
            resourceId: resolvedResourceId,
            label: label,
            preview: preview,
            spaceId: spaceId,
            spaceName: spaceName,
            tableId: tableId
        )
    }
}

// MARK: - 输入辅助

enum ChatVoiceResult {
    case fillDraft(String)
    case sendDirectly(String)
    case cancelled
}
