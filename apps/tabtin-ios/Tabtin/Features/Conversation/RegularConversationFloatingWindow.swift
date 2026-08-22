import SwiftUI

/// iPad regular-width conversation window placement.
///
/// `yRatio` describes the capsule anchor along the usable viewport edge:
/// `0` is the top safe margin and `1` is the bottom safe margin. Geometry clamps
/// persisted or gesture-produced values before resolving a frame.
struct RegularConversationFloatingPlacement: Equatable, Sendable {
    enum Side: Equatable, Sendable {
        case left
        case right
    }

    var side: Side
    var yRatio: CGFloat

    static let `default` = Self(side: .right, yRatio: 1)
}

/// Visual and layout constants shared by the view and its geometry contract.
enum RegularConversationFloatingWindowMetrics {
    static let idealSize = CGSize(width: 420, height: 560)
    static let totalHorizontalMargin: CGFloat = 48
    static let verticalReserve: CGFloat = 140
    static let safeMargin: CGFloat = 24

    static let cornerRadius: CGFloat = TTRadius.xl
    /// Electron's compact toolbar is 40pt. iPad uses a 44pt row so every native
    /// button also meets Apple's minimum pointer and touch target.
    static let electronToolbarHeight: CGFloat = 40
    static let toolbarHeight: CGFloat = 44
    static let minimumHitTarget: CGFloat = 44

    static let borderWidth: CGFloat = 0.75
    static let shadowOpacity: CGFloat = 0.16
    static let shadowRadius: CGFloat = 24
    static let shadowY: CGFloat = 12
}

/// Pure geometry resolver mirroring Electron's `AgentChatOverlay` placement:
/// size the ideal window, pin it to the capsule side, center it around the
/// capsule's persisted y-ratio, then clamp the complete card into the safe area.
enum RegularConversationFloatingWindowGeometry {
    struct Layout: Equatable, Sendable {
        var frame: CGRect
        /// Transform origin in the floating window's local coordinate space.
        var transformOrigin: CGPoint

        var transformOriginUnitPoint: UnitPoint {
            guard frame.width > 0, frame.height > 0 else { return .center }
            return UnitPoint(
                x: RegularConversationFloatingWindowGeometry.clamp(
                    transformOrigin.x / frame.width,
                    lower: 0,
                    upper: 1
                ),
                y: RegularConversationFloatingWindowGeometry.clamp(
                    transformOrigin.y / frame.height,
                    lower: 0,
                    upper: 1
                )
            )
        }
    }

    static func resolve(
        viewport: CGSize,
        placement: RegularConversationFloatingPlacement
    ) -> Layout {
#if DEBUG
        _ = geometryContract
#endif
        return resolveUnchecked(viewport: viewport, placement: placement)
    }

    private static func resolveUnchecked(
        viewport: CGSize,
        placement: RegularConversationFloatingPlacement
    ) -> Layout {
        let viewportWidth = finiteNonnegative(viewport.width)
        let viewportHeight = finiteNonnegative(viewport.height)
        let width = min(
            RegularConversationFloatingWindowMetrics.idealSize.width,
            max(0, viewportWidth - RegularConversationFloatingWindowMetrics.totalHorizontalMargin)
        )
        let height = min(
            RegularConversationFloatingWindowMetrics.idealSize.height,
            max(0, viewportHeight - RegularConversationFloatingWindowMetrics.verticalReserve)
        )

        // On a regular viewport this is exactly 24pt. The fallback only keeps
        // malformed or transient zero-size layouts finite while rotation settles.
        let horizontalMargin = min(
            RegularConversationFloatingWindowMetrics.safeMargin,
            max(0, (viewportWidth - width) / 2)
        )
        let verticalMargin = min(
            RegularConversationFloatingWindowMetrics.safeMargin,
            max(0, (viewportHeight - height) / 2)
        )

        let minX = horizontalMargin
        let maxX = max(minX, viewportWidth - horizontalMargin - width)
        let minY = verticalMargin
        let maxY = max(minY, viewportHeight - verticalMargin - height)

        let ratio = clamp(
            placement.yRatio.isFinite ? placement.yRatio : 0.5,
            lower: 0,
            upper: 1
        )
        let anchorX = placement.side == .left ? minX : maxX + width
        let anchorY = verticalMargin + max(0, viewportHeight - 2 * verticalMargin) * ratio
        let frameX = placement.side == .left ? minX : maxX
        let frameY = clamp(anchorY - height / 2, lower: minY, upper: maxY)
        let frame = CGRect(x: frameX, y: frameY, width: width, height: height)

        return Layout(
            frame: frame,
            transformOrigin: CGPoint(
                x: clamp(anchorX - frame.minX, lower: 0, upper: width),
                y: clamp(anchorY - frame.minY, lower: 0, upper: height)
            )
        )
    }

    private static func finiteNonnegative(_ value: CGFloat) -> CGFloat {
        value.isFinite ? max(0, value) : 0
    }

    private static func clamp(_ value: CGFloat, lower: CGFloat, upper: CGFloat) -> CGFloat {
        max(lower, min(upper, value))
    }

#if DEBUG
    /// Lightweight, target-free geometry contract. It runs on the resolver's
    /// first use, so the component keeps its sizing and anchoring invariants even
    /// before this isolated file is registered in the Xcode test target.
    private static let geometryContract: Void = {
        let left = resolveUnchecked(
            viewport: CGSize(width: 1_024, height: 768),
            placement: .init(side: .left, yRatio: 0.5)
        )
        assert(approximatelyEqual(left.frame, CGRect(x: 24, y: 104, width: 420, height: 560)))
        assert(approximatelyEqual(left.transformOrigin, CGPoint(x: 0, y: 280)))

        let right = resolveUnchecked(
            viewport: CGSize(width: 1_024, height: 768),
            placement: .init(side: .right, yRatio: 0.5)
        )
        assert(approximatelyEqual(right.frame, CGRect(x: 580, y: 104, width: 420, height: 560)))
        assert(approximatelyEqual(right.transformOrigin, CGPoint(x: 420, y: 280)))

        let constrained = resolveUnchecked(
            viewport: CGSize(width: 400, height: 600),
            placement: .init(side: .right, yRatio: 0.5)
        )
        assert(approximatelyEqual(constrained.frame, CGRect(x: 24, y: 70, width: 352, height: 460)))
        assert(approximatelyEqual(constrained.transformOrigin, CGPoint(x: 352, y: 230)))

        let top = resolveUnchecked(
            viewport: CGSize(width: 1_024, height: 768),
            placement: .init(side: .left, yRatio: -1)
        )
        assert(approximatelyEqual(top.frame.minY, 24))
        assert(approximatelyEqual(top.transformOrigin.y, 0))

        let bottom = resolveUnchecked(
            viewport: CGSize(width: 1_024, height: 768),
            placement: .init(side: .right, yRatio: 2)
        )
        assert(approximatelyEqual(bottom.frame.maxY, 744))
        assert(approximatelyEqual(bottom.transformOrigin.y, 560))

        let nonfinite = resolveUnchecked(
            viewport: CGSize(width: CGFloat.infinity, height: CGFloat.nan),
            placement: .init(side: .left, yRatio: CGFloat.nan)
        )
        assert(nonfinite.frame.origin.x.isFinite)
        assert(nonfinite.frame.origin.y.isFinite)
        assert(nonfinite.frame.width.isFinite)
        assert(nonfinite.frame.height.isFinite)
    }()

    private static func approximatelyEqual(_ lhs: CGFloat, _ rhs: CGFloat) -> Bool {
        abs(lhs - rhs) < 0.001
    }

    private static func approximatelyEqual(_ lhs: CGPoint, _ rhs: CGPoint) -> Bool {
        approximatelyEqual(lhs.x, rhs.x) && approximatelyEqual(lhs.y, rhs.y)
    }

    private static func approximatelyEqual(_ lhs: CGRect, _ rhs: CGRect) -> Bool {
        approximatelyEqual(lhs.origin, rhs.origin)
            && approximatelyEqual(lhs.width, rhs.width)
            && approximatelyEqual(lhs.height, rhs.height)
    }
#endif
}

/// A regular-width, non-modal conversation surface matching Electron's
/// `AgentChatOverlay`. Mount it in an existing root overlay, not a sheet or
/// full-screen cover: this view intentionally draws no scrim and leaves all
/// pixels outside the card available to the workbench beneath it.
struct RegularConversationFloatingWindow<Content: View>: View {
    let isPresented: Bool
    let placement: RegularConversationFloatingPlacement
    let onCollapse: () -> Void
    let onBackToSplit: (() -> Void)?
    let onFrameChange: ((CGRect) -> Void)?
    private let content: Content

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    init(
        isPresented: Bool,
        placement: RegularConversationFloatingPlacement,
        onCollapse: @escaping () -> Void,
        onBackToSplit: (() -> Void)? = nil,
        onFrameChange: ((CGRect) -> Void)? = nil,
        @ViewBuilder content: () -> Content
    ) {
        self.isPresented = isPresented
        self.placement = placement
        self.onCollapse = onCollapse
        self.onBackToSplit = onBackToSplit
        self.onFrameChange = onFrameChange
        self.content = content()
    }

    var body: some View {
        GeometryReader { proxy in
            let layout = RegularConversationFloatingWindowGeometry.resolve(
                viewport: proxy.size,
                placement: placement
            )

            // regular / compact 的唯一判定由 TaskSurfaceCoordinator 与宿主策略负责。
            // 这里不能再次读取 sheet-local size class，否则多任务尺寸切换时可能出现
            // 状态已 floating、胶囊已隐藏，但窗口被本地环境门禁吞掉的黑洞。
            if isPresented, layout.frame.width > 0, layout.frame.height > 0 {
                floatingCard
                    .frame(width: layout.frame.width, height: layout.frame.height)
                    .position(x: layout.frame.midX, y: layout.frame.midY)
                    .onGeometryChange(for: CGRect.self) { cardProxy in
                        cardProxy.frame(in: .global)
                    } action: { frame in
                        onFrameChange?(frame)
                    }
                    .transition(windowTransition(anchor: layout.transformOriginUnitPoint))
                    .zIndex(1)
            }
        }
    }

    private var floatingCard: some View {
        let shape = RoundedRectangle(
            cornerRadius: RegularConversationFloatingWindowMetrics.cornerRadius,
            style: .continuous
        )

        return VStack(spacing: 0) {
            toolbar
            content
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .clipped()
        }
        .background(Color.tt.bgCanvasDefault)
        .clipShape(shape)
        .overlay {
            shape.strokeBorder(
                Color.tt.borderLight.opacity(0.82),
                lineWidth: RegularConversationFloatingWindowMetrics.borderWidth
            )
        }
        .shadow(
            color: Color.black.opacity(RegularConversationFloatingWindowMetrics.shadowOpacity),
            radius: RegularConversationFloatingWindowMetrics.shadowRadius,
            y: RegularConversationFloatingWindowMetrics.shadowY
        )
        // SwiftUI has no non-modal `dialog` accessibility role. A named
        // containing element preserves the dialog grouping without applying
        // `.isModal`, so VoiceOver can still reach the workbench behind it.
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Agent 对话窗口")
        .accessibilityHint("对话框。背景中的工作台仍可操作。")
        .accessibilityIdentifier("regular-conversation-floating-window")
    }

    private var toolbar: some View {
        HStack(spacing: TTSpacing.xs) {
            Spacer(minLength: 0)

            if let onBackToSplit {
                toolbarButton(
                    systemName: "rectangle.split.2x1",
                    label: "回到分屏",
                    hint: "关闭悬浮窗口并回到分屏对话",
                    action: onBackToSplit
                )
                .accessibilitySortPriority(2)
            }

            toolbarButton(
                systemName: "chevron.down",
                label: "收起对话",
                hint: "将对话收回工作台胶囊",
                action: onCollapse
            )
            .accessibilitySortPriority(1)
        }
        .padding(.horizontal, TTSpacing.xs)
        .frame(height: RegularConversationFloatingWindowMetrics.toolbarHeight)
        .background(Color.tt.bgCanvasDefault)
        .overlay(alignment: .bottom) {
            Rectangle()
                .fill(Color.tt.borderLight.opacity(0.72))
                .frame(height: 0.5)
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("对话窗口工具栏")
    }

    private func toolbarButton(
        systemName: String,
        label: String,
        hint: String,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            Image(systemName: systemName)
                .font(.tt.iconCaption)
                .foregroundStyle(.tt.iconSecondary)
                .frame(
                    width: RegularConversationFloatingWindowMetrics.minimumHitTarget,
                    height: RegularConversationFloatingWindowMetrics.minimumHitTarget
                )
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .hoverEffect(.highlight)
        .accessibilityLabel(label)
        .accessibilityHint(hint)
    }

    private func windowTransition(anchor: UnitPoint) -> AnyTransition {
        if reduceMotion {
            return .opacity.animation(.easeOut(duration: 0.12))
        }

        let identity = RegularConversationFloatingWindowTransitionModifier(
            opacity: 1,
            scale: 1,
            yOffset: 0,
            anchor: anchor
        )
        let insertion = AnyTransition.modifier(
            active: RegularConversationFloatingWindowTransitionModifier(
                opacity: 0,
                scale: 0.92,
                yOffset: 10,
                anchor: anchor
            ),
            identity: identity
        )
        .animation(.timingCurve(0.23, 1, 0.32, 1, duration: 0.24))
        let removal = AnyTransition.modifier(
            active: RegularConversationFloatingWindowTransitionModifier(
                opacity: 0,
                scale: 0.95,
                yOffset: 8,
                anchor: anchor
            ),
            identity: identity
        )
        .animation(.easeOut(duration: 0.16))

        return .asymmetric(insertion: insertion, removal: removal)
    }
}

private struct RegularConversationFloatingWindowTransitionModifier: ViewModifier {
    let opacity: CGFloat
    let scale: CGFloat
    let yOffset: CGFloat
    let anchor: UnitPoint

    func body(content: Content) -> some View {
        content
            .opacity(opacity)
            .scaleEffect(scale, anchor: anchor)
            .offset(y: yOffset)
    }
}
