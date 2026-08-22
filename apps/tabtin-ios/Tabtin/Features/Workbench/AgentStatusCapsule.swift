import SwiftUI

/// 工作台面（含资源详情）悬浮的 Agent 状态胶囊。
///
/// 可见性由 ``TaskSurfaceCoordinator.capsuleVisibility`` 判定；本视图只负责展示。
/// 指针手势（短按展开对话 / 拖拽落点 / 长按双列菜单）由 ``CapsulePositionedHost`` 承接。
/// - 轻点：展开对话并尽量定位轮次 / HITL
/// - 拖拽：贴左右边 + 持久化 yRatio
/// - 长按：系统菜单「文字 / 语音」；语音用 HUD「取消 / 发送」收尾
/// - 尺寸正典：完整态 48pt 高 / 32pt 头像 / maxWidth 360；微缩态同径圆圈
/// - 布局对齐 Electron `AgentChatCapsule` placement（side + yRatio），非通栏底栏
struct AgentStatusCapsule: View {
    let agentName: String
    var avatarKey: String? = nil
    var avatarURL: String? = nil
    let runState: AgentRunPresentationState
    let completedTodoCount: Int
    let totalTodoCount: Int
    let voiceController: CapsuleVoiceCommandController

    static let height: CGFloat = 48
    static let avatarSize: CGFloat = 32
    static let maxWidth: CGFloat = 360
    /// 与 demo `.capsule-host` inset 对齐。
    static let hostInset: CGFloat = 14

    var pendingApproval: Bool = false
    var pendingAnswer: Bool = false

    var body: some View {
        let status = TaskCapsuleStatus.resolve(
            TaskCapsuleStatus.input(
                from: runState,
                pendingApproval: pendingApproval,
                pendingAnswer: pendingAnswer
            )
        )
        let copy = AgentStatusCapsuleCopy(status: status, runState: runState)
        capsuleChrome(copy: copy)
            // morph from/to 采集可见胶囊 chrome，禁止扩满 Host。
            .background {
                GeometryReader { proxy in
                    Color.clear.preference(
                        key: TaskSurfaceCapsuleFrameKey.self,
                        value: proxy.frame(in: .global)
                    )
                }
            }
            .contentShape(Capsule())
            // 指针手势改由 CapsulePositionedHost（短按/拖拽/长按菜单）。
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(accessibilityLabelText(copy: copy))
            .accessibilityHint("轻点展开对话，拖动调整位置，长按打开文字或语音菜单")
            .accessibilityAddTraits(.isButton)
            .accessibilityAction(named: Text(L10n.Agent.capsuleA11yReturnChat)) {
                voiceController.onTap?()
            }
            .modifier(CapsuleVoiceAccessibilityActions(voiceController: voiceController))
    }

    private func capsuleChrome(copy: AgentStatusCapsuleCopy) -> some View {
        HStack(spacing: 10) {
            CapsuleAgentAvatar(
                avatarKey: avatarKey,
                avatarURL: avatarURL,
                size: Self.avatarSize
            )

            VStack(alignment: .leading, spacing: 2) {
                Text(agentName)
                    .font(.tt.captionMedium)
                    .fontWeight(.medium)
                    .foregroundStyle(.tt.textPrimary)
                    .lineLimit(1)
                HStack(spacing: 5) {
                    CapsuleStatusDot(color: copy.color, animated: copy.isBusy)
                    Text(statusLineText(copy: copy))
                        .font(.tt.captionMedium)
                        .foregroundStyle(.tt.textSecondary)
                        .lineLimit(1)
                    if totalTodoCount > 0 {
                        Text("\(completedTodoCount)/\(totalTodoCount)")
                            .font(.tt.captionMedium)
                            .foregroundStyle(.tt.textTertiary)
                            .padding(.horizontal, 4)
                            .padding(.vertical, 1)
                            .background(.tt.bgSubtle, in: Capsule())
                            .accessibilityLabel("待办进度 \(completedTodoCount) 分之 \(totalTodoCount)")
                    }
                }
            }
            .frame(maxWidth: 270, alignment: .leading)
        }
        .padding(.leading, 8)
        .padding(.trailing, 12)
        .frame(height: Self.height)
        .frame(maxWidth: Self.maxWidth, alignment: .leading)
        .fixedSize(horizontal: true, vertical: false)
        .background(
            (voiceController.isCancelArmed
                ? Color.tt.bgCritical.opacity(0.12)
                : Color.tt.bgCanvasDefault.opacity(0.96)),
            in: Capsule()
        )
        .overlay {
            Capsule().strokeBorder(
                voiceBorderColor(copy: copy),
                lineWidth: voiceController.isRecordingVisually || copy.emphasizesUserAttention ? 1 : 0.5
            )
        }
        .overlay {
            // 按住阈值进度环（对齐 demo hold-progress）。
            if voiceController.isPressingVisually {
                CapsuleHoldProgressRing()
            }
        }
        .shadow(
            color: Color.black.opacity(voiceController.isRecordingVisually ? 0.14 : 0.10),
            radius: voiceController.isRecordingVisually ? 16 : 12,
            y: 4
        )
        .overlay {
            if voiceController.isRecordingVisually, !voiceController.isCancelArmed {
                Capsule()
                    .strokeBorder(Color.tt.textAccent.opacity(0.28), lineWidth: 4)
                    .padding(-4)
            }
        }
        .scaleEffect(voiceController.isRecordingVisually ? 0.97 : 1)
        .animation(.easeOut(duration: 0.12), value: voiceController.isRecordingVisually)
        .animation(.easeOut(duration: 0.12), value: voiceController.isCancelArmed)
        .animation(.easeOut(duration: 0.12), value: voiceController.isPressingVisually)
    }

    private func statusLineText(copy: AgentStatusCapsuleCopy) -> String {
        if let subtitle = copy.subtitle, !subtitle.isEmpty {
            return "\(copy.title) · \(subtitle)"
        }
        return copy.title
    }

    private func accessibilityLabelText(copy: AgentStatusCapsuleCopy) -> String {
        var parts = ["\(agentName)，\(copy.title)"]
        if let subtitle = copy.subtitle {
            parts.append(subtitle)
        }
        if totalTodoCount > 0 {
            parts.append("待办 \(completedTodoCount)/\(totalTodoCount)")
        }
        return parts.joined(separator: "，")
    }

    private func voiceBorderColor(copy: AgentStatusCapsuleCopy) -> Color {
        if voiceController.isCancelArmed {
            return Color.tt.textCritical.opacity(0.7)
        }
        if voiceController.isRecordingVisually {
            return copy.color.opacity(0.65)
        }
        return copy.emphasizesUserAttention ? copy.color.opacity(0.55) : .tt.borderLight
    }

}

// MARK: - Status Dot / Hold Progress

private struct CapsuleStatusDot: View {
    let color: Color
    let animated: Bool

    var body: some View {
        ZStack {
            if animated {
                Circle()
                    .fill(color.opacity(0.28))
                    .frame(width: 10, height: 10)
                    .modifier(CapsulePulseModifier())
            }
            Circle()
                .fill(color)
                .frame(width: 6, height: 6)
        }
        .frame(width: 10, height: 10)
        .accessibilityHidden(true)
    }
}

private struct CapsulePulseModifier: ViewModifier {
    @State private var pulsing = false

    func body(content: Content) -> some View {
        content
            .scaleEffect(pulsing ? 1.55 : 1)
            .opacity(pulsing ? 0.15 : 0.55)
            .onAppear {
                withAnimation(.easeInOut(duration: 0.7).repeatForever(autoreverses: true)) {
                    pulsing = true
                }
            }
    }
}

/// 按住 520ms 阈值的描边进度（clip 自左向右填满）。
private struct CapsuleHoldProgressRing: View {
    @State private var progress: CGFloat = 0

    var body: some View {
        Capsule()
            .strokeBorder(Color.tt.textAccent.opacity(0.55), lineWidth: 2)
            .padding(-3)
            .mask(
                GeometryReader { proxy in
                    Rectangle()
                        .frame(width: max(proxy.size.width * progress, 2))
                        .frame(maxHeight: .infinity, alignment: .leading)
                }
            )
            .allowsHitTesting(false)
            .onAppear {
                progress = 0
                withAnimation(.linear(duration: Double(CapsuleHoldToTalkMetrics.holdDurationMs) / 1000)) {
                    progress = 1
                }
            }
    }
}

/// 微缩态：仿 iOS 辅助触控的小圆环（32pt 头像视觉，命中区 ≥44pt）。
struct MiniAgentStatusCapsule: View {
    let agentName: String
    var avatarKey: String? = nil
    var avatarURL: String? = nil
    let runState: AgentRunPresentationState
    let voiceController: CapsuleVoiceCommandController
    var pendingApproval: Bool = false
    var pendingAnswer: Bool = false

    private static let visualDiameter: CGFloat = AgentStatusCapsule.avatarSize
    private static let hitDiameter: CGFloat = 44

    var body: some View {
        let status = TaskCapsuleStatus.resolve(
            TaskCapsuleStatus.input(
                from: runState,
                pendingApproval: pendingApproval,
                pendingAnswer: pendingAnswer
            )
        )
        let copy = AgentStatusCapsuleCopy(status: status, runState: runState)
        ZStack {
            Circle()
                .fill(.ultraThinMaterial)
                .frame(width: Self.hitDiameter, height: Self.hitDiameter)
            Circle()
                .strokeBorder(
                    voiceController.isRecordingVisually
                        ? (voiceController.isCancelArmed ? Color.tt.textCritical : copy.color)
                        : .tt.borderLight,
                    lineWidth: voiceController.isRecordingVisually ? 1.5 : 0.5
                )
                .frame(width: Self.hitDiameter, height: Self.hitDiameter)
            CapsuleAgentAvatar(
                avatarKey: avatarKey,
                avatarURL: avatarURL,
                size: Self.visualDiameter
            )
        }
        .frame(width: Self.hitDiameter, height: Self.hitDiameter)
        // morph from/to 采集可见圆圈 chrome，禁止扩满 Host。
        .background {
            GeometryReader { proxy in
                Color.clear.preference(
                    key: TaskSurfaceCapsuleFrameKey.self,
                    value: proxy.frame(in: .global)
                )
            }
        }
        .overlay(alignment: .bottomTrailing) {
            Image(systemName: copy.icon)
                .font(.tt.iconCaption)
                .foregroundStyle(copy.color)
                .padding(3)
                .background(.tt.bgCanvasDefault, in: Circle())
        }
        .shadow(color: Color.black.opacity(0.12), radius: 8, y: 3)
        .opacity(voiceController.isRecordingVisually ? 1 : 0.92)
        .scaleEffect(voiceController.isRecordingVisually ? 1.05 : 1)
        .contentShape(Circle())
        // 指针手势改由 CapsulePositionedHost（短按/拖拽/长按菜单）。
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(agentName)，\(copy.title)")
        .accessibilityHint("轻点展开对话，拖动调整位置，长按打开文字或语音菜单")
        .accessibilityAddTraits(.isButton)
        .accessibilityAction(named: Text(L10n.Agent.capsuleA11yReturnChat)) {
            voiceController.onTap?()
        }
        .modifier(CapsuleVoiceAccessibilityActions(voiceController: voiceController))
        .animation(.easeOut(duration: 0.12), value: voiceController.isRecordingVisually)
    }
}

/// VoiceOver：空闲「开始语音指令」；录音中「结束并发送 / 取消语音」。
private struct CapsuleVoiceAccessibilityActions: ViewModifier {
    let voiceController: CapsuleVoiceCommandController

    @ViewBuilder
    func body(content: Content) -> some View {
        if voiceController.isVoiceControlSessionActive || voiceController.isRecordingVisually {
            content
                .accessibilityAction(named: Text(L10n.Agent.capsuleA11yEndAndSend)) {
                    voiceController.submitAccessibilityVoiceCommand()
                }
                .accessibilityAction(named: Text(L10n.Agent.capsuleA11yCancelVoice)) {
                    voiceController.cancelAccessibilityVoiceCommand()
                }
        } else {
            content
                .accessibilityAction(named: Text(L10n.Agent.capsuleA11yStartVoice)) {
                    voiceController.beginAccessibilityVoiceCommand()
                }
        }
    }
}

/// 工作台原生 sheet 的胶囊层级栈。SwiftUI `zIndex` 不能跨 UIKit presentation，
/// 所以每一层 sheet 都重新挂载同一胶囊；栈只允许最上层宿主可见和可交互。
@MainActor @Observable
final class WorkbenchCapsuleLayerCoordinator {
    private(set) var layerIDs: [UUID] = []

    func mount(_ id: UUID) {
        guard !layerIDs.contains(id) else { return }
        layerIDs.append(id)
    }

    func unmount(_ id: UUID) {
        layerIDs.removeAll { $0 == id }
    }

    func isTopLayer(_ id: UUID) -> Bool {
        layerIDs.last == id
    }
}

private struct WorkbenchCapsuleLayerCoordinatorKey: EnvironmentKey {
    static let defaultValue: WorkbenchCapsuleLayerCoordinator? = nil
}

extension EnvironmentValues {
    var workbenchCapsuleLayerCoordinator: WorkbenchCapsuleLayerCoordinator? {
        get { self[WorkbenchCapsuleLayerCoordinatorKey.self] }
        set { self[WorkbenchCapsuleLayerCoordinatorKey.self] = newValue }
    }
}

private struct CapsuleHITLCoordinatorEnvironmentKey: EnvironmentKey {
    static let defaultValue: HITLCoordinator? = nil
}

extension EnvironmentValues {
    /// 当前会话唯一的 HITL 协调器。系统 sheet 会继承该环境值，因此根工作台、iPad 浮窗和
    /// App/detail 原生弹窗里的胶囊都执行同一份 pending 与提交去重状态。
    var capsuleHITLCoordinator: HITLCoordinator? {
        get { self[CapsuleHITLCoordinatorEnvironmentKey.self] }
        set { self[CapsuleHITLCoordinatorEnvironmentKey.self] = newValue }
    }
}

private struct WorkbenchCapsuleTopLayerModifier: ViewModifier {
    @Environment(\.workbenchCapsuleLayerCoordinator) private var inheritedCoordinator
    @State private var layerID = UUID()

    let coordinator: WorkbenchCapsuleLayerCoordinator?
    let hidesCapsule: Bool

    private var resolvedCoordinator: WorkbenchCapsuleLayerCoordinator? {
        coordinator ?? inheritedCoordinator
    }

    private var showsTopLayer: Bool {
        resolvedCoordinator?.isTopLayer(layerID) == true
            && !hidesCapsule
    }

    func body(content: Content) -> some View {
        content
            .overlay {
                if showsTopLayer {
                    AgentStatusCapsuleHost(forcesWorkbenchVisibility: true)
                        .zIndex(1_000)
                }
            }
            .overlay(alignment: .top) {
                if showsTopLayer {
                    CapsuleVoiceDispatchNotice()
                        .padding(.horizontal, TTSpacing.md)
                        .padding(.top, TTSpacing.md)
                        .zIndex(1_000)
                }
            }
            .onAppear {
                resolvedCoordinator?.mount(layerID)
            }
            .onDisappear {
                resolvedCoordinator?.unmount(layerID)
            }
    }
}

extension View {
    /// 仅在工作台注入了 coordinator 时生效；独立云盘页调用仍保持原布局。
    func workbenchCapsuleTopLayer(
        coordinator: WorkbenchCapsuleLayerCoordinator? = nil,
        hidesCapsule: Bool = false
    ) -> some View {
        modifier(WorkbenchCapsuleTopLayerModifier(
            coordinator: coordinator,
            hidesCapsule: hidesCapsule
        ))
    }
}

/// 单一宿主：圆圈 ↔ 完整胶囊由同一挂点承载，避免 inset/overlay 双实例对切。
/// 定位由 ``CapsulePositionedHost`` 按 side+yRatio 落点；手机待命圆圈 ↔ 胶囊：260ms 几何变形。
struct AgentStatusCapsuleHost: View {
    var forcesWorkbenchVisibility = false

    @Environment(TaskSurfaceCoordinator.self) private var coordinator
    @Environment(CapsuleVoiceCommandController.self) private var voiceController
    @Environment(\.capsuleHITLCoordinator) private var hitlCoordinator
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        let info = coordinator.capsuleVisibility(
            forcesWorkbenchVisibility: forcesWorkbenchVisibility
        )
        let capsuleStatus = TaskCapsuleStatus.resolve(
            TaskCapsuleStatus.input(
                from: info.runState,
                queuedCount: info.runState.queuedCount,
                pendingApproval: info.pendingApproval,
                pendingAnswer: info.pendingAnswer
            )
        )
        let onboardingSuppressed = info.pendingApproval || info.pendingAnswer
        let hideForMorph = coordinator.hidesCapsuleForMorph
        let morphAnimation: Animation? = reduceMotion
            ? nil
            : .timingCurve(0.77, 0, 0.175, 1, duration: Double(TaskSurfaceMorphTiming.phoneCapsuleMorphMs) / 1000)
        ZStack(alignment: .bottom) {
            Group {
                switch info.presentation {
                case .full:
                    CapsulePositionedHost(
                        onTap: { voiceController.onTap?() },
                        onTextRequested: {
                            voiceController.presentTextComposer()
                        },
                        onVoiceHandoffBegin: {
                            voiceController.beginMenuVoiceHandoff()
                        },
                        onVoiceHandoffComplete: {
                            voiceController.completeMenuVoiceHandoff()
                        },
                        onboardingReplySuggested: capsuleStatus == .complete,
                        onboardingSuppressed: onboardingSuppressed,
                        voiceControlSessionActive: voiceController.isVoiceControlSessionActive,
                        accessory: positionedHITLAccessory
                    ) { side in
                        VStack(
                            alignment: side == .left ? .leading : .trailing,
                            spacing: TTSpacing.sm
                        ) {
                            CapsuleVoiceListeningHud(voiceController: voiceController)
                            AgentStatusCapsule(
                                agentName: info.agentName,
                                avatarKey: info.avatarKey,
                                avatarURL: info.avatarURL,
                                runState: info.runState,
                                completedTodoCount: info.completedTodoCount,
                                totalTodoCount: info.totalTodoCount,
                                voiceController: voiceController,
                                pendingApproval: info.pendingApproval,
                                pendingAnswer: info.pendingAnswer
                            )
                        }
                    }
                    .transition(.opacity.combined(with: .scale(scale: 0.96, anchor: .bottomTrailing)))
                case .mini:
                    CapsulePositionedHost(
                        onTap: { voiceController.onTap?() },
                        onTextRequested: {
                            voiceController.presentTextComposer()
                        },
                        onVoiceHandoffBegin: {
                            voiceController.beginMenuVoiceHandoff()
                        },
                        onVoiceHandoffComplete: {
                            voiceController.completeMenuVoiceHandoff()
                        },
                        onboardingReplySuggested: capsuleStatus == .complete,
                        onboardingSuppressed: onboardingSuppressed,
                        voiceControlSessionActive: voiceController.isVoiceControlSessionActive,
                        accessory: positionedHITLAccessory
                    ) { side in
                        VStack(
                            alignment: side == .left ? .leading : .trailing,
                            spacing: TTSpacing.sm
                        ) {
                            CapsuleVoiceListeningHud(voiceController: voiceController)
                            MiniAgentStatusCapsule(
                                agentName: info.agentName,
                                avatarKey: info.avatarKey,
                                avatarURL: info.avatarURL,
                                runState: info.runState,
                                voiceController: voiceController,
                                pendingApproval: info.pendingApproval,
                                pendingAnswer: info.pendingAnswer
                            )
                        }
                    }
                    .transition(.opacity.combined(with: .scale(scale: 0.92, anchor: .bottomTrailing)))
                case .hidden:
                    EmptyView()
                }
            }
            // morph ghost 播放期间隐藏实体胶囊，避免与 ghost 双影；chrome 仍各自上报真实 frame。
            .opacity(hideForMorph ? 0 : 1)
            .allowsHitTesting(!hideForMorph && info.shouldShow && !voiceController.isTextComposerPresented)
            // 稳定 identity：presentation 变化时用明确 id，快速反向不会串动画。
            .id("capsule-host-\(info.presentation)")
            .animation(morphAnimation, value: info.presentation)

            if voiceController.isTextComposerPresented {
                Color.black.opacity(0.18)
                    .ignoresSafeArea()
                    .contentShape(Rectangle())
                    .onTapGesture { voiceController.dismissTextComposer() }
                    .transition(.opacity)

                CapsuleTextComposerBar(
                    disabledReason: voiceController.resolvedTextComposerDisabledReason(),
                    onSend: { text in
                        voiceController.submitTextComposer(text)
                    },
                    onCancel: {
                        voiceController.dismissTextComposer()
                    }
                )
                .padding(.horizontal, TTSpacing.md)
                .padding(.bottom, TTSpacing.sm)
                .transition(
                    reduceMotion
                        ? .opacity
                        : .move(edge: .bottom).combined(with: .opacity)
                )
            }
        }
        .animation(
            reduceMotion ? .easeOut(duration: 0.12) : .spring(response: 0.38, dampingFraction: 0.86),
            value: voiceController.isTextComposerPresented
        )
        .animation(
            reduceMotion ? .easeOut(duration: 0.12) : .spring(response: 0.36, dampingFraction: 0.86),
            value: voiceController.showsVoiceHud
        )
    }

    private var positionedHITLAccessory: (
        (CapsuleDockSide, CapsuleHITLBubbleGeometry.Edge, CGSize) -> AnyView
    )? {
        guard let hitlCoordinator else { return nil }
        return { side, edge, maximumSize in
            AnyView(
                CapsuleHITLBubbleHost(
                    coordinator: hitlCoordinator,
                    side: side,
                    edge: edge,
                    maximumSize: maximumSize,
                    onOpenConversation: { voiceController.onTap?() }
                )
            )
        }
    }

}

/// 胶囊旁的非模态 HITL 气泡。它只读取 Coordinator 的 pending，不另存“已处理”状态：
/// retryable 错误会保留原卡，ACK / 多端 resolved 后才随 pending 一起离场。
private struct CapsuleHITLBubbleHost: View {
    @Bindable var coordinator: HITLCoordinator
    let side: CapsuleDockSide
    let edge: CapsuleHITLBubbleGeometry.Edge
    let maximumSize: CGSize
    let onOpenConversation: () -> Void

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        Group {
            if let presentation = CapsuleHITLBubbleProjection.presentation(
                for: coordinator.pending,
                canResolve: coordinator.canResolvePending
            ) {
                CapsuleHITLBubble(
                    presentation: presentation,
                    isSubmitting: coordinator.isSubmitting,
                    submitError: coordinator.submitError,
                    maximumSize: maximumSize,
                    onAction: { perform($0, promptId: presentation.id) }
                )
                .id(presentation.id)
                .transition(bubbleTransition)
            }
        }
        .animation(
            reduceMotion
                ? .easeOut(duration: 0.14)
                : .spring(response: 0.34, dampingFraction: 0.84),
            value: coordinator.pending?.id
        )
    }

    private var transformAnchor: UnitPoint {
        switch (side, edge) {
        case (.left, .above): return .bottomLeading
        case (.right, .above): return .bottomTrailing
        case (.left, .below): return .topLeading
        case (.right, .below): return .topTrailing
        }
    }

    private var bubbleTransition: AnyTransition {
        guard !reduceMotion else { return .opacity }
        let towardCapsuleOffset: CGFloat = edge == .above ? 10 : -10
        return .asymmetric(
            insertion: .opacity
                .combined(with: .scale(scale: 0.72, anchor: transformAnchor))
                .combined(with: .offset(x: 0, y: towardCapsuleOffset)),
            removal: .opacity
                .combined(with: .scale(scale: 0.8, anchor: transformAnchor))
                .combined(with: .offset(x: 0, y: towardCapsuleOffset))
        )
    }

    private func perform(_ intent: CapsuleHITLBubbleIntent, promptId: String) {
        if case .openConversation = intent {
            onOpenConversation()
            return
        }
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
        Task {
            await coordinator.submitCapsuleHITLIntent(intent, promptId: promptId)
        }
    }
}

private struct CapsuleHITLBubble: View {
    let presentation: CapsuleHITLBubblePresentation
    let isSubmitting: Bool
    let submitError: String?
    let maximumSize: CGSize
    let onAction: (CapsuleHITLBubbleIntent) -> Void

    private var kindTitle: String {
        switch presentation.kind {
        case .approval: return L10n.Agent.capsuleHITLApprovalKind
        case .choice: return L10n.Agent.capsuleHITLChoiceKind
        }
    }

    private var hint: String {
        switch presentation.kind {
        case .approval: return L10n.Agent.capsuleHITLApprovalHint
        case .choice: return L10n.Agent.capsuleHITLChoiceHint
        }
    }

    var body: some View {
        bubbleContents
        .frame(width: maximumSize.width)
        .background(
            .tt.bgCanvasDefault,
            in: RoundedRectangle(cornerRadius: 20, style: .continuous)
        )
        .overlay {
            RoundedRectangle(cornerRadius: 20, style: .continuous)
                .strokeBorder(.tt.borderLight, lineWidth: 0.5)
        }
        .shadow(color: Color.black.opacity(0.13), radius: 14, y: 5)
        .accessibilityElement(children: .contain)
        .accessibilityLabel(kindTitle)
        .accessibilityHint(hint)
    }

    private var bubbleContents: some View {
        VStack(alignment: .leading, spacing: TTSpacing.md) {
            HStack(spacing: TTSpacing.xs) {
                Text(kindTitle)
                    .font(.tt.captionSemibold)
                    .foregroundStyle(.tt.textAccent)
                    .accessibilityAddTraits(.isHeader)
                Spacer(minLength: TTSpacing.xs)
                if isSubmitting {
                    ProgressView()
                        .controlSize(.small)
                    Text(L10n.Agent.capsuleHITLSubmitting)
                        .font(.tt.caption)
                        .foregroundStyle(.tt.textTertiary)
                }
            }

            if let title = presentation.title, !title.isEmpty {
                Text(title)
                    .font(.tt.subtitleSemibold)
                    .foregroundStyle(.tt.textPrimary)
                    .lineLimit(2)
                    .fixedSize(horizontal: false, vertical: true)
            }

            Text(presentation.message)
                .font(.tt.body)
                .foregroundStyle(.tt.textSecondary)
                .lineLimit(5)
                .fixedSize(horizontal: false, vertical: true)

            if let submitError {
                VStack(alignment: .leading, spacing: 2) {
                    Label(submitError, systemImage: "exclamationmark.triangle.fill")
                        .font(.tt.captionMedium)
                        .foregroundStyle(.tt.textCritical)
                    Text(L10n.Agent.capsuleHITLErrorRetryHint)
                        .font(.tt.caption)
                        .foregroundStyle(.tt.textSecondary)
                }
                .fixedSize(horizontal: false, vertical: true)
            }

            LazyVGrid(
                columns: [GridItem(.adaptive(minimum: 88), spacing: TTSpacing.sm)],
                alignment: .leading,
                spacing: TTSpacing.sm
            ) {
                ForEach(presentation.actions) { action in
                    actionButton(action)
                }
            }
        }
        .padding(TTSpacing.lg)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func actionButton(_ action: CapsuleHITLBubbleAction) -> some View {
        Button(role: action.role == .destructive ? .destructive : nil) {
            onAction(action.intent)
        } label: {
            Text(action.title)
                .font(.tt.captionSemibold)
                .multilineTextAlignment(.center)
                .frame(maxWidth: .infinity, minHeight: 48)
                .padding(.horizontal, TTSpacing.sm)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .foregroundStyle(actionForeground(action.role))
        .background(actionBackground(action.role), in: Capsule())
        .overlay {
            if action.role == .destructive {
                Capsule().strokeBorder(.tt.borderLight, lineWidth: 1)
            }
        }
        .disabled(isSubmitting)
        .accessibilityLabel(action.title)
        .accessibilityHint(isSubmitting ? L10n.Agent.capsuleHITLSubmitting : "")
    }

    private func actionForeground(_ role: CapsuleHITLBubbleActionRole) -> Color {
        switch role {
        case .primary: return .tt.textOnAccent
        case .destructive: return .tt.textSecondary
        case .secondary: return .tt.textAccent
        }
    }

    private func actionBackground(_ role: CapsuleHITLBubbleActionRole) -> Color {
        switch role {
        case .primary: return .tt.bgAccent
        case .destructive, .secondary: return .clear
        }
    }
}

// MARK: - Copy

struct AgentStatusCapsuleCopy: Equatable, Sendable {
    let icon: String
    let title: String
    let subtitle: String?
    let colorName: CapsuleStatusColor
    let emphasizesUserAttention: Bool
    let isBusy: Bool

    enum CapsuleStatusColor: Equatable, Sendable {
        case warning
        case accent
        case success
        case critical
        case secondary
    }

    var color: Color {
        switch colorName {
        case .warning: return .tt.textWarning
        case .accent: return .tt.textAccent
        case .success: return .tt.textSuccess
        case .critical: return .tt.textCritical
        case .secondary: return .tt.textSecondary
        }
    }

    init(status: TaskCapsuleStatusKind, runState: AgentRunPresentationState) {
        let unreadCount: Int = {
            if case let .completed(hasUnread) = runState.phase, hasUnread {
                return max(runState.unreadReplyCount, 1)
            }
            // queued 态也可能带未读文案以外的计数；complete 外用 0。
            return status == .complete ? max(runState.unreadReplyCount, 1) : 0
        }()
        title = TaskCapsuleStatus.statusTitle(
            status,
            queuedCount: runState.queuedCount,
            unreadCount: unreadCount
        )
        switch status {
        case .needsApproval, .needsAnswer:
            icon = "exclamationmark.bubble.fill"
            if case let .waitingForUser(count) = runState.phase {
                subtitle = "\(count) 项待处理"
            } else {
                subtitle = nil
            }
            colorName = .warning
            emphasizesUserAttention = true
            isBusy = false
        case .recovering:
            icon = "arrow.trianglehead.2.clockwise"
            subtitle = nil
            colorName = .warning
            emphasizesUserAttention = false
            isBusy = true
        case .thinking, .preparing, .planningNext:
            icon = "brain"
            subtitle = nil
            colorName = .accent
            emphasizesUserAttention = false
            isBusy = true
        case .working:
            icon = "wrench.and.screwdriver.fill"
            subtitle = runState.currentAction
            colorName = .accent
            emphasizesUserAttention = false
            isBusy = true
        case .finishing:
            icon = "text.bubble.fill"
            subtitle = nil
            colorName = .accent
            emphasizesUserAttention = false
            isBusy = true
        case .queued:
            icon = "clock.fill"
            subtitle = nil
            colorName = .accent
            emphasizesUserAttention = false
            isBusy = true
        case .paused:
            icon = "pause.circle.fill"
            subtitle = runState.currentAction
            colorName = .warning
            emphasizesUserAttention = false
            isBusy = false
        case .complete:
            icon = "checkmark.circle.fill"
            subtitle = "查看完整结果"
            colorName = .success
            emphasizesUserAttention = false
            isBusy = false
        case .error:
            icon = "exclamationmark.triangle.fill"
            subtitle = runState.failureReason
            colorName = .critical
            emphasizesUserAttention = true
            isBusy = false
        case .stopped:
            icon = "stop.circle.fill"
            subtitle = nil
            colorName = .secondary
            emphasizesUserAttention = false
            isBusy = false
        case .ready:
            icon = "sparkles"
            subtitle = nil
            colorName = .secondary
            emphasizesUserAttention = false
            isBusy = false
        }
    }

    /// 兼容旧调用点：从 runState 投影。
    init(runState: AgentRunPresentationState) {
        let status = TaskCapsuleStatus.resolve(TaskCapsuleStatus.input(from: runState))
        self.init(status: status, runState: runState)
    }
}

/// 菜单语音 HUD：正在聆听 / 识别中 + 实时转写；latch 路径用「取消 / 发送」按钮收尾。
struct CapsuleVoiceListeningHud: View {
    let voiceController: CapsuleVoiceCommandController

    var body: some View {
        if voiceController.showsVoiceHud {
            VStack(alignment: .leading, spacing: 10) {
                HStack(spacing: 10) {
                    Image(systemName: hudIcon)
                        .font(.tt.iconBody)
                        .foregroundStyle(.white)
                        .frame(width: 34, height: 34)
                        .background(hudIconBackground, in: Circle())

                    VStack(alignment: .leading, spacing: 2) {
                        Text(hudTitle)
                            .font(.tt.captionMedium)
                            .fontWeight(.semibold)
                            .foregroundStyle(.tt.textPrimary)
                            .lineLimit(1)
                        Text(hudTranscript)
                            .font(.tt.captionMedium)
                            .foregroundStyle(.tt.textSecondary)
                            .lineLimit(2)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }

                if voiceController.showsVoiceActionButtons {
                    HStack(spacing: 8) {
                        Button {
                            voiceController.cancelAccessibilityVoiceCommand()
                        } label: {
                            Text(L10n.Agent.capsuleVoiceCancel)
                                .font(.tt.captionMedium)
                                .fontWeight(.semibold)
                                .foregroundStyle(.tt.textPrimary)
                                .frame(maxWidth: .infinity)
                                .padding(.vertical, 8)
                                .background(.tt.bgSubtle, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel(L10n.Agent.capsuleA11yCancelVoice)

                        Button {
                            voiceController.submitAccessibilityVoiceCommand()
                        } label: {
                            Text(L10n.Agent.capsuleVoiceSend)
                                .font(.tt.captionMedium)
                                .fontWeight(.semibold)
                                .foregroundStyle(.white)
                                .frame(maxWidth: .infinity)
                                .padding(.vertical, 8)
                                .background(.tt.textAccent, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel(L10n.Agent.capsuleA11yEndAndSend)
                    }
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 10)
            .frame(maxWidth: 330)
            .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: 16, style: .continuous)
                    .strokeBorder(.tt.borderLight, lineWidth: 0.5)
            }
            .shadow(color: Color.black.opacity(0.12), radius: 14, y: 4)
            .transition(
                .asymmetric(
                    insertion: .opacity.combined(with: .scale(scale: 0.97, anchor: .bottomTrailing)),
                    removal: .opacity
                )
            )
            .allowsHitTesting(voiceController.showsVoiceActionButtons)
            .accessibilityElement(children: voiceController.showsVoiceActionButtons ? .contain : .ignore)
            .accessibilityLabel("\(hudTitle)，\(hudTranscript)")
            .accessibilityAddTraits(.updatesFrequently)
        }
    }

    private var hudTitle: String {
        switch voiceController.phase {
        case .pressing:
            return "按住说话"
        case .cancelling:
            return "即将取消"
        case .processing:
            return "正在识别"
        case .recording:
            return "正在聆听"
        default:
            return "正在聆听"
        }
    }

    private var hudTranscript: String {
        switch voiceController.phase {
        case .pressing:
            return "继续按住开始录音…"
        case .cancelling:
            return "没有发送任何内容"
        case .processing:
            let text = voiceController.liveTranscript.trimmingCharacters(in: .whitespacesAndNewlines)
            return text.isEmpty ? "继续整理…" : text
        case .recording:
            let text = voiceController.liveTranscript.trimmingCharacters(in: .whitespacesAndNewlines)
            if text.isEmpty {
                return voiceController.isLatchedFromMenu
                    ? L10n.Agent.capsuleVoiceListeningHint
                    : "开始说话…"
            }
            return text
        default:
            return voiceController.liveTranscript
        }
    }

    private var hudIcon: String {
        switch voiceController.phase {
        case .cancelling:
            return "xmark"
        case .processing:
            return "ellipsis"
        default:
            return "mic.fill"
        }
    }

    private var hudIconBackground: Color {
        switch voiceController.phase {
        case .cancelling:
            return .tt.textCritical
        case .processing:
            return .tt.textSecondary
        default:
            return .tt.textAccent
        }
    }
}

/// 工作台顶部诚实回执：已保存 / 已排队 / 已送达 / 阻断。
struct CapsuleVoiceDispatchNotice: View {
    @Environment(TaskSurfaceCoordinator.self) private var coordinator

    var body: some View {
        if let receipt = coordinator.lastVoiceDispatchReceipt {
            Text(receipt.userFacingMessage)
                .font(.tt.captionMedium)
                .foregroundStyle(.tt.textPrimary)
                .padding(.horizontal, TTSpacing.md)
                .padding(.vertical, TTSpacing.sm)
                .background(.ultraThinMaterial, in: Capsule())
                .overlay {
                    Capsule().strokeBorder(.tt.borderLight, lineWidth: 0.5)
                }
                .onTapGesture {
                    coordinator.clearVoiceDispatchReceipt()
                }
                .accessibilityLabel(receipt.userFacingMessage)
                .transition(.move(edge: .top).combined(with: .opacity))
        }
    }
}
