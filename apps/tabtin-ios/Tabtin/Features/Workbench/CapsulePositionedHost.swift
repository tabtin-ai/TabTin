import SwiftUI
import UIKit

/// 按持久化 placement 定位胶囊。
///
/// 手势分工：短按展开对话；直接拖动胶囊并在松手后吸附；静止长按弹输入菜单。
///
/// 菜单选「语音」后：先延时交接再进入 latch 录音；录音中锁定短按/拖拽/菜单，
/// 取消与发送由 HUD 按钮完成（不再上滑取消）。
struct CapsulePositionedHost<Content: View>: View {
    var onTap: (() -> Void)?
    var onTextRequested: (() -> Void)?
    var onVoiceRequested: (() -> Void)?
    var onVoiceHandoffBegin: (() -> Void)?
    var onVoiceHandoffComplete: (() -> Void)?
    /// 完整结果等自然回复节点优先教学长按；HITL 等更高优先级浮层出现时由调用方抑制。
    var onboardingReplySuggested = false
    var onboardingSuppressed = false
    /// 录音中为 true：吞掉拖拽与短按，避免挪胶囊或误回对话。
    var voiceControlSessionActive: Bool = false
    /// 与胶囊同坐标系、但不进入 capsule chrome 测量的兄弟层（HITL 气泡等）。
    /// 独立测量保证出现/消失不会改变持久化 yRatio。
    var accessory: ((
        _ side: CapsuleDockSide,
        _ edge: CapsuleHITLBubbleGeometry.Edge,
        _ maximumSize: CGSize
    ) -> AnyView)? = nil
    /// `side` 供内容按贴边对齐（语音 HUD 等宽气泡勿把左侧胶囊挤向中间）。
    @ViewBuilder let content: (_ side: CapsuleDockSide) -> Content

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    @State private var placement: CapsulePlacement = CapsulePlacementStore.load()
    @State private var reducer = CapsulePointerReducer()
    @State private var viewport: CGSize = .zero
    @State private var gestureOrigin: CGPoint?
    @State private var lastTranslation: CGSize = .zero
    @State private var liveOrigin: CGPoint?
    @State private var measuredSize: CGSize = CGSize(
        width: AgentStatusCapsule.avatarSize + 16,
        height: AgentStatusCapsule.height
    )
    @State private var accessorySize: CGSize = .zero
    @State private var voiceHandoffTask: Task<Void, Never>?
    @State private var holdTask: Task<Void, Never>?
    @State private var onboardingTask: Task<Void, Never>?
    @State private var onboardingDismissTask: Task<Void, Never>?
    @State private var menuVisible = false
    @State private var onboardingProgress = CapsuleOnboardingStore.load()
    @State private var onboardingPrompt: CapsuleOnboardingAction?

    private var isDragging: Bool {
        reducer.phase == .dragging
    }

    private var isLifted: Bool {
        reducer.phase == .menuOpen
    }

    var body: some View {
        ZStack(alignment: .topLeading) {
            GeometryReader { proxy in
                Color.clear
                    .preference(key: CapsuleViewportSizeKey.self, value: proxy.size)
            }
            .allowsHitTesting(false)

            let origin = resolvedOrigin
            if onboardingPrompt == .tap,
               !menuVisible,
               !voiceControlSessionActive,
               !onboardingSuppressed,
               !reduceTransparency {
                Color.black.opacity(0.10)
                    .allowsHitTesting(false)
                    .transition(.opacity)
                    .zIndex(0.5)
            }

            if menuVisible {
                Color.clear
                    .contentShape(Rectangle())
                    .onTapGesture { dismissMenu() }
                    .zIndex(2)
            }

            if let accessory {
                let bubblePlacement = resolvedAccessoryPlacement
                let maximumSize = resolvedAccessoryMaximumSize
                accessory(placement.side, bubblePlacement.edge, maximumSize)
                    .frame(
                        maxWidth: maximumSize.width
                    )
                    .onGeometryChange(for: CGSize.self) { proxy in
                        proxy.size
                    } action: { size in
                        accessorySize = size
                    }
                    .opacity(
                        resolvedAccessorySize.width > 1
                            && resolvedAccessorySize.height > 1
                            && !menuVisible
                            && !voiceControlSessionActive
                            ? 1
                            : 0
                    )
                    .allowsHitTesting(
                        resolvedAccessorySize.width > 1
                            && resolvedAccessorySize.height > 1
                            && !menuVisible
                            && !voiceControlSessionActive
                    )
                    .offset(x: bubblePlacement.frame.minX, y: bubblePlacement.frame.minY)
                    .zIndex(2)
            }

            content(placement.side)
                .background(
                    GeometryReader { child in
                        Color.clear.preference(
                            key: CapsuleChromeSizeKey.self,
                            value: child.size
                        )
                    }
                )
                .scaleEffect(isLifted ? 1.06 : (isDragging ? 1.03 : 1))
                .shadow(
                    color: Color.black.opacity(isLifted ? 0.22 : (isDragging ? 0.18 : 0.10)),
                    radius: isLifted ? 20 : (isDragging ? 18 : 12),
                    y: isLifted ? 8 : 4
                )
                .offset(x: origin.x, y: origin.y)
                .gesture(pointerGesture)
                .animation(.spring(response: 0.35, dampingFraction: 0.82), value: placement)
                .animation(.easeOut(duration: 0.12), value: isLifted)
                .zIndex(isDragging || voiceControlSessionActive || menuVisible ? 3 : 1)

            if let onboardingPrompt,
               !menuVisible,
               !voiceControlSessionActive,
               !onboardingSuppressed {
                CapsuleOnboardingHint(
                    action: onboardingPrompt,
                    onSkip: skipOnboarding
                )
                .frame(width: 216)
                .offset(x: onboardingHintOrigin.x, y: onboardingHintOrigin.y)
                .transition(onboardingHintTransition)
                .zIndex(2)
            }

            if menuVisible {
                CapsuleActionMenu(
                    onText: { selectMenu(.text) },
                    onVoice: { selectMenu(.voice) }
                )
                .frame(width: 184, height: 58)
                .offset(x: actionMenuOrigin.x, y: actionMenuOrigin.y)
                .transition(.scale(scale: 0.94, anchor: .bottom).combined(with: .opacity))
                .zIndex(4)
            }
        }
        .onPreferenceChange(CapsuleViewportSizeKey.self) { size in
            guard size.width > 1, size.height > 1 else { return }
            viewport = size
        }
        .onPreferenceChange(CapsuleChromeSizeKey.self) { size in
            guard size.width > 1, size.height > 1 else { return }
            measuredSize = size
        }
        .onAppear(perform: beginOnboardingAppearance)
        .onChange(of: onboardingReplySuggested) { _, _ in
            scheduleOnboardingPrompt(recordAppearance: false)
        }
        .onChange(of: onboardingSuppressed) { _, suppressed in
            if suppressed {
                dismissOnboardingPrompt()
            } else {
                scheduleOnboardingPrompt(recordAppearance: false)
            }
        }
        .onChange(of: voiceControlSessionActive) { _, active in
            if active {
                dismissOnboardingPrompt()
            } else {
                scheduleOnboardingPrompt(recordAppearance: false)
            }
        }
        .onDisappear {
            voiceHandoffTask?.cancel()
            voiceHandoffTask = nil
            holdTask?.cancel()
            holdTask = nil
            onboardingTask?.cancel()
            onboardingTask = nil
            onboardingDismissTask?.cancel()
            onboardingDismissTask = nil
        }
    }

    private var resolvedOrigin: CGPoint {
        if let liveOrigin { return liveOrigin }
        guard viewport.width > 1, viewport.height > 1 else {
            return .zero
        }
        return CapsulePlacementGeometry.position(
            for: placement,
            viewport: viewport,
            capsuleSize: measuredSize
        )
    }

    private var resolvedAccessoryPlacement: CapsuleHITLBubbleGeometry.Placement {
        guard viewport.width > 1, viewport.height > 1 else {
            return CapsuleHITLBubbleGeometry.Placement(
                frame: CGRect(origin: resolvedOrigin, size: resolvedAccessorySize),
                edge: .above
            )
        }
        return CapsuleHITLBubbleGeometry.placement(
            viewport: CGRect(origin: .zero, size: viewport),
            capsuleFrame: CGRect(origin: resolvedOrigin, size: measuredSize),
            bubbleSize: resolvedAccessorySize,
            side: placement.side
        )
    }

    private var resolvedAccessoryMaximumSize: CGSize {
        guard viewport.width > 1, viewport.height > 1 else { return .zero }
        return CapsuleHITLBubbleGeometry.maximumSize(
            viewport: CGRect(origin: .zero, size: viewport),
            capsuleFrame: CGRect(origin: resolvedOrigin, size: measuredSize)
        )
    }

    private var resolvedAccessorySize: CGSize {
        CapsuleHITLAccessoryMeasurement.resolvedSize(
            measured: accessorySize,
            maximum: resolvedAccessoryMaximumSize
        )
    }

    private var actionMenuOrigin: CGPoint {
        let menuWidth: CGFloat = 184
        let menuHeight: CGFloat = 58
        let gap = TTSpacing.md
        let centeredX = resolvedOrigin.x + measuredSize.width / 2 - menuWidth / 2
        let x = min(max(TTSpacing.sm, centeredX), max(TTSpacing.sm, viewport.width - menuWidth - TTSpacing.sm))
        let above = resolvedOrigin.y - menuHeight - gap
        let y = above >= TTSpacing.sm
            ? above
            : min(viewport.height - menuHeight - TTSpacing.sm, resolvedOrigin.y + measuredSize.height + gap)
        return CGPoint(x: x, y: y)
    }

    private var onboardingHintOrigin: CGPoint {
        let hintSize = CGSize(width: 216, height: 72)
        let gap = TTSpacing.sm
        let centeredX = resolvedOrigin.x + measuredSize.width / 2 - hintSize.width / 2
        let x = min(
            max(TTSpacing.sm, centeredX),
            max(TTSpacing.sm, viewport.width - hintSize.width - TTSpacing.sm)
        )
        let above = resolvedOrigin.y - hintSize.height - gap
        let y = above >= TTSpacing.sm
            ? above
            : min(
                max(TTSpacing.sm, viewport.height - hintSize.height - TTSpacing.sm),
                resolvedOrigin.y + measuredSize.height + gap
            )
        return CGPoint(x: x, y: y)
    }

    private var onboardingHintTransition: AnyTransition {
        reduceMotion
            ? .opacity
            : .scale(scale: 0.92, anchor: .bottom).combined(with: .opacity)
    }

    private var pointerGesture: some Gesture {
        DragGesture(
            minimumDistance: 0,
            coordinateSpace: .global
        )
            .onChanged(handlePointerChanged)
            .onEnded(handlePointerEnded)
    }

    private func handlePointerChanged(_ value: DragGesture.Value) {
        guard !voiceControlSessionActive, viewport.width > 1, viewport.height > 1 else { return }
        if reducer.phase == .idle {
            dismissOnboardingPrompt()
            beginPointerCycle()
        }

        let delta = CGSize(
            width: value.translation.width - lastTranslation.width,
            height: value.translation.height - lastTranslation.height
        )
        var next = reducer
        next.handle(.touchMoved(dx: delta.width, dy: delta.height))

        if next.phase == .dragging {
            holdTask?.cancel()
            holdTask = nil
        }
        switch next.phase {
        case .dragging:
            if let gestureOrigin {
                liveOrigin = CGPoint(
                    x: gestureOrigin.x + value.translation.width,
                    y: gestureOrigin.y + value.translation.height
                )
            }
        case .idle, .pressing, .menuOpen:
            break
        }

        reducer = next
        lastTranslation = value.translation
    }

    private func handlePointerEnded(_: DragGesture.Value) {
        guard !voiceControlSessionActive else { return }
        holdTask?.cancel()
        holdTask = nil

        var next = reducer
        next.handle(.touchEnded)
        let outcome = next.pendingOutcome
        reducer = next

        switch outcome {
        case .tap:
            markOnboardingLearned(.tap)
            liveOrigin = nil
            onTap?()
            resetPointerTracking(keepMenuState: false)
        case .dragEnd:
            markOnboardingLearned(.drag)
            persistLivePlacement()
            resetPointerTracking(keepMenuState: false)
        case .none where reducer.phase == .menuOpen:
            resetPointerTracking(keepMenuState: true)
        default:
            liveOrigin = nil
            resetPointerTracking(keepMenuState: false)
        }
    }

    private func beginPointerCycle() {
        if menuVisible { dismissMenu() }
        var next = CapsulePointerReducer()
        next.handle(.touchBegan)
        reducer = next
        gestureOrigin = CapsulePlacementGeometry.position(
            for: placement,
            viewport: viewport,
            capsuleSize: measuredSize
        )
        lastTranslation = .zero

        holdTask?.cancel()
        holdTask = Task { @MainActor in
            try? await Task.sleep(for: .milliseconds(CapsulePointerMetrics.menuHoldMs))
            guard !Task.isCancelled, reducer.phase == .pressing else { return }
            var held = reducer
            held.handle(.holdElapsed(ms: CapsulePointerMetrics.menuHoldMs))
            reducer = held
            guard held.pendingOutcome == .menuOpened else { return }
            markOnboardingLearned(.hold)
            UIImpactFeedbackGenerator(style: .medium).impactOccurred()
            withAnimation(.easeOut(duration: 0.14)) {
                menuVisible = true
            }
        }
    }

    private func persistLivePlacement() {
        let raw = liveOrigin ?? CapsulePlacementGeometry.position(
            for: placement,
            viewport: viewport,
            capsuleSize: measuredSize
        )
        let docked = CapsulePlacementGeometry.dockedPosition(
            from: raw,
            viewport: viewport,
            capsuleSize: measuredSize
        )
        let snapped = CapsulePlacementGeometry.placement(
            from: docked,
            viewport: viewport,
            capsuleSize: measuredSize
        )
        placement = snapped
        CapsulePlacementStore.save(snapped)
        liveOrigin = nil
    }

    private func selectMenu(_ selection: CapsuleMenuSelection) {
        var next = reducer
        next.handle(.selectMenu(selection))
        reducer = next
        withAnimation(.easeOut(duration: 0.12)) { menuVisible = false }
        resetPointerTracking(keepMenuState: false)
        switch selection {
        case .text:
            voiceHandoffTask?.cancel()
            voiceHandoffTask = nil
            onTextRequested?()
        case .voice:
            scheduleVoiceHandoff()
        }
    }

    private func dismissMenu() {
        var next = reducer
        next.handle(.dismissMenu)
        reducer = next
        withAnimation(.easeOut(duration: 0.12)) { menuVisible = false }
        resetPointerTracking(keepMenuState: false)
    }

    private func resetPointerTracking(keepMenuState: Bool) {
        holdTask?.cancel()
        holdTask = nil
        gestureOrigin = nil
        lastTranslation = .zero
        if !keepMenuState {
            reducer = CapsulePointerReducer()
        }
    }

    private func scheduleVoiceHandoff() {
        voiceHandoffTask?.cancel()
        onVoiceHandoffBegin?()
        let delayMs = reduceMotion ? 0 : CapsuleHoldToTalkMetrics.menuVoiceHandoffDelayMs
        voiceHandoffTask = Task { @MainActor in
            if delayMs > 0 {
                try? await Task.sleep(for: .milliseconds(delayMs))
            }
            guard !Task.isCancelled else { return }
            if let onVoiceHandoffComplete {
                onVoiceHandoffComplete()
            } else {
                onVoiceRequested?()
            }
        }
    }

    private func beginOnboardingAppearance() {
        scheduleOnboardingPrompt(recordAppearance: true)
    }

    private func scheduleOnboardingPrompt(recordAppearance: Bool) {
        onboardingTask?.cancel()
        if recordAppearance {
            onboardingProgress.recordAppearance()
            CapsuleOnboardingStore.save(onboardingProgress)
        }
        guard !onboardingSuppressed, !voiceControlSessionActive else { return }
        onboardingTask = Task { @MainActor in
            try? await Task.sleep(for: .milliseconds(1_200))
            guard !Task.isCancelled,
                  !menuVisible,
                  !voiceControlSessionActive,
                  !onboardingSuppressed,
                  let prompt = onboardingProgress.nextPrompt(
                    replySuggested: onboardingReplySuggested
                  )
            else { return }
            onboardingProgress.markPromptShown(prompt)
            CapsuleOnboardingStore.save(onboardingProgress)
            withAnimation(reduceMotion ? .easeOut(duration: 0.14) : .spring(response: 0.32, dampingFraction: 0.9)) {
                onboardingPrompt = prompt
            }
            scheduleOnboardingDismiss()
        }
    }

    private func dismissOnboardingPrompt() {
        onboardingTask?.cancel()
        onboardingTask = nil
        onboardingDismissTask?.cancel()
        onboardingDismissTask = nil
        guard onboardingPrompt != nil else { return }
        withAnimation(.easeOut(duration: reduceMotion ? 0.1 : 0.16)) {
            onboardingPrompt = nil
        }
    }

    private func scheduleOnboardingDismiss() {
        onboardingDismissTask?.cancel()
        onboardingDismissTask = Task { @MainActor in
            try? await Task.sleep(for: .milliseconds(4_500))
            guard !Task.isCancelled else { return }
            dismissOnboardingPrompt()
        }
    }

    private func markOnboardingLearned(_ action: CapsuleOnboardingAction) {
        onboardingProgress.markLearned(action)
        CapsuleOnboardingStore.save(onboardingProgress)
        dismissOnboardingPrompt()
    }

    private func skipOnboarding() {
        onboardingProgress.skipAll()
        CapsuleOnboardingStore.save(onboardingProgress)
        dismissOnboardingPrompt()
    }
}

private struct CapsuleOnboardingHint: View {
    let action: CapsuleOnboardingAction
    let onSkip: () -> Void

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var demonstratesGesture = false

    var body: some View {
        HStack(spacing: TTSpacing.sm) {
            Image(systemName: systemImage)
                .font(.tt.iconBodyMedium)
                .foregroundStyle(.tt.iconAccent)
                .frame(width: 28, height: 28)
                .scaleEffect(demonstratesGesture && action != .drag ? 0.86 : 1)
                .offset(x: demonstratesGesture && action == .drag ? 10 : 0)

            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(.tt.bodySemibold)
                    .foregroundStyle(.tt.textPrimary)
                Text(detail)
                    .font(.tt.meta)
                    .foregroundStyle(.tt.textSecondary)
                    .lineLimit(2)
            }

            Spacer(minLength: 0)

            Button(L10n.Agent.capsuleOnboardingSkip, action: onSkip)
                .buttonStyle(.plain)
                .font(.tt.metaMedium)
                .foregroundStyle(.tt.textSecondary)
        }
        .padding(.horizontal, TTSpacing.md)
        .padding(.vertical, TTSpacing.sm)
        .background(.thinMaterial, in: RoundedRectangle(cornerRadius: TTRadius.md))
        .overlay {
            RoundedRectangle(cornerRadius: TTRadius.md)
                .stroke(.tt.borderLight, lineWidth: 0.5)
        }
        .shadow(color: Color.black.opacity(0.14), radius: 14, y: 5)
        .accessibilityElement(children: .combine)
        .onAppear {
            guard !reduceMotion else { return }
            withAnimation(.easeInOut(duration: 0.52).repeatCount(2, autoreverses: true)) {
                demonstratesGesture = true
            }
        }
    }

    private var systemImage: String {
        switch action {
        case .tap: "hand.tap.fill"
        case .drag: "arrow.left.and.right"
        case .hold: "hand.point.up.left.fill"
        }
    }

    private var title: String {
        switch action {
        case .tap: L10n.Agent.capsuleOnboardingTapTitle
        case .drag: L10n.Agent.capsuleOnboardingDragTitle
        case .hold: L10n.Agent.capsuleOnboardingHoldTitle
        }
    }

    private var detail: String {
        switch action {
        case .tap: L10n.Agent.capsuleOnboardingTapDetail
        case .drag: L10n.Agent.capsuleOnboardingDragDetail
        case .hold: L10n.Agent.capsuleOnboardingHoldDetail
        }
    }
}

private struct CapsuleActionMenu: View {
    let onText: () -> Void
    let onVoice: () -> Void

    var body: some View {
        HStack(spacing: 0) {
            action(
                title: L10n.Agent.capsuleMenuText,
                accessibilityLabel: L10n.Agent.capsuleMenuTextA11y,
                systemImage: "text.bubble",
                action: onText
            )
            Divider()
                .padding(.vertical, TTSpacing.sm)
            action(
                title: L10n.Agent.capsuleMenuVoice,
                accessibilityLabel: L10n.Agent.capsuleMenuVoiceA11y,
                systemImage: "mic.fill",
                action: onVoice
            )
        }
        .padding(TTSpacing.xs)
        .background(.thinMaterial, in: RoundedRectangle(cornerRadius: TTRadius.md))
        .overlay {
            RoundedRectangle(cornerRadius: TTRadius.md)
                .stroke(.tt.borderLight, lineWidth: 0.5)
        }
        .shadow(color: Color.black.opacity(0.16), radius: 18, y: 8)
    }

    private func action(
        title: String,
        accessibilityLabel: String,
        systemImage: String,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            VStack(spacing: TTSpacing.xs) {
                Image(systemName: systemImage)
                    .font(.tt.iconBodyMedium)
                Text(title)
                    .font(.tt.metaMedium)
            }
            .foregroundStyle(.tt.textPrimary)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(accessibilityLabel)
    }
}

private struct CapsuleChromeSizeKey: PreferenceKey {
    static let defaultValue: CGSize = .zero
    static func reduce(value: inout CGSize, nextValue: () -> CGSize) {
        let next = nextValue()
        if next.width > 1, next.height > 1 {
            value = next
        }
    }
}

private struct CapsuleViewportSizeKey: PreferenceKey {
    static let defaultValue: CGSize = .zero
    static func reduce(value: inout CGSize, nextValue: () -> CGSize) {
        let next = nextValue()
        if next.width > 1, next.height > 1 {
            value = next
        }
    }
}
