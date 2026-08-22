import CoreGraphics
import Foundation
import SwiftUI

/// 对齐 Electron `chatCapsuleMorph.ts` 与 demo HTML 的 morph 时序常量。
enum TaskSurfaceMorphTiming {
    static let durationMs = 420
    static let ghostFadeMs = 140
    static let pendingTTLMs = 1000
    /// 手机待命圆圈 ↔ 完整胶囊几何变形。
    static let phoneCapsuleMorphMs = 260
    /// `cubic-bezier(0.77, 0, 0.175, 1)`
    static let easingControlPoints: (CGFloat, CGFloat, CGFloat, CGFloat) = (0.77, 0, 0.175, 1)
    static let railCornerRadius: CGFloat = 12

    static var durationSeconds: TimeInterval { Double(durationMs) / 1000 }
    static var ghostFadeSeconds: TimeInterval { Double(ghostFadeMs) / 1000 }
    static var pendingTTLSeconds: TimeInterval { Double(pendingTTLMs) / 1000 }
}

enum TaskSurfaceMorphDirection: String, Equatable, Sendable {
    case toCapsule = "to-capsule"
    case toRail = "to-rail"
}

/// Split ⇄ App-focus 共享元素 ghost 状态机（纯逻辑，不持有真实对话内容）。
///
/// - 工作台 / 对话实例保持挂载；本类型只管理几何 ghost 的 pending / 播放 / 反向。
/// - Reduce Motion：不捕获、立即清场，由调用方瞬间切换布局并保证焦点。
/// - 快速切第三态：抬 `transitionGeneration`，同时清 active/pending/hide，旧回调不得改 hide。
@MainActor
final class TaskSurfaceMorphCoordinator {
    private struct PendingMorph {
        let direction: TaskSurfaceMorphDirection
        let from: CGRect
        let capturedAt: Date
        let generation: Int
    }

    private struct ActiveGhost {
        let direction: TaskSurfaceMorphDirection
        let from: CGRect
        let to: CGRect
        let startedAt: Date
        let generation: Int
    }

    private var pending: PendingMorph?
    private var active: ActiveGhost?
    private var capsuleRevealUntil: Date?
    private var railRevealUntil: Date?
    /// 每次 beginTransition 递增；旧 yield 回调必须校验后才能写 hide / ghost。
    private(set) var transitionGeneration = 0

    var hasActiveGhost: Bool { active != nil }

    var pendingFromRect: CGRect? { pending?.from }

    var activeGhostSnapshot: (direction: TaskSurfaceMorphDirection, from: CGRect, to: CGRect, startedAt: Date, generation: Int)? {
        guard let active else { return nil }
        return (active.direction, active.from, active.to, active.startedAt, active.generation)
    }

    func isCurrentTransition(_ generation: Int) -> Bool {
        generation == transitionGeneration
    }

    /// 布局变化前调用。返回将要播放的方向；Reduce Motion 或非 morph 路径返回 nil。
    @discardableResult
    func beginTransition(
        from previous: TaskViewMode,
        to next: TaskViewMode,
        railRect: CGRect?,
        capsuleRect: CGRect?,
        reduceMotion: Bool,
        now: Date = .now
    ) -> TaskSurfaceMorphDirection? {
        transitionGeneration += 1
        let generation = transitionGeneration
        let interrupted = cancelActiveMorph(at: now)

        if reduceMotion {
            clearAllMorphState()
            return nil
        }

        guard previous != next else {
            clearAllMorphState()
            return nil
        }

        if previous == .split, next == .appFocus {
            let from = interrupted ?? railRect
            guard let from, from.width >= 1, from.height >= 1 else {
                clearAllMorphState()
                return nil
            }
            pending = PendingMorph(
                direction: .toCapsule,
                from: from,
                capturedAt: now,
                generation: generation
            )
            capsuleRevealUntil = now.addingTimeInterval(TaskSurfaceMorphTiming.durationSeconds)
            railRevealUntil = nil
            return .toCapsule
        }

        if previous == .appFocus, next == .split {
            let from = interrupted ?? capsuleRect
            guard let from, from.width >= 1, from.height >= 1 else {
                clearAllMorphState()
                return nil
            }
            pending = PendingMorph(
                direction: .toRail,
                from: from,
                capturedAt: now,
                generation: generation
            )
            railRevealUntil = now.addingTimeInterval(TaskSurfaceMorphTiming.durationSeconds)
            capsuleRevealUntil = nil
            return .toRail
        }

        // 切到 chat-focus 等第三态：立即清场，禁止旧 hide 把 rail/胶囊长期透明。
        clearAllMorphState()
        return nil
    }

    func hasPending(direction: TaskSurfaceMorphDirection, at now: Date = .now) -> Bool {
        guard let pending, pending.direction == direction else { return false }
        guard pending.generation == transitionGeneration else { return false }
        return now.timeIntervalSince(pending.capturedAt) <= TaskSurfaceMorphTiming.pendingTTLSeconds
    }

    /// morph 期间只保留 ghost 一个视觉实体：源与目标 chrome 都隐藏，避免双影。
    func shouldHideCapsule(at now: Date = .now) -> Bool {
        if active != nil { return true }
        if hasPending(direction: .toCapsule, at: now) { return true }
        if hasPending(direction: .toRail, at: now) { return true }
        if let until = capsuleRevealUntil, now < until { return true }
        return false
    }

    func shouldHideRail(at now: Date = .now) -> Bool {
        if active != nil { return true }
        if hasPending(direction: .toRail, at: now) { return true }
        if hasPending(direction: .toCapsule, at: now) { return true }
        if let until = railRevealUntil, now < until { return true }
        return false
    }

    /// 目标布局就绪后消费一次 pending 并进入 active ghost。
    @discardableResult
    func consume(
        direction: TaskSurfaceMorphDirection,
        targetRect: CGRect,
        now: Date = .now,
        generation: Int? = nil
    ) -> Bool {
        if let generation, !isCurrentTransition(generation) { return false }
        guard let pending else { return false }
        guard pending.direction == direction else { return false }
        guard pending.generation == transitionGeneration else {
            self.pending = nil
            return false
        }
        self.pending = nil
        guard now.timeIntervalSince(pending.capturedAt) <= TaskSurfaceMorphTiming.pendingTTLSeconds else {
            return false
        }
        let safeTo = (targetRect.width >= 1 && targetRect.height >= 1) ? targetRect : pending.from
        let revealUntil = now.addingTimeInterval(TaskSurfaceMorphTiming.durationSeconds)
        switch direction {
        case .toCapsule:
            capsuleRevealUntil = max(capsuleRevealUntil ?? revealUntil, revealUntil)
            railRevealUntil = nil
        case .toRail:
            railRevealUntil = max(railRevealUntil ?? revealUntil, revealUntil)
            capsuleRevealUntil = nil
        }
        active = ActiveGhost(
            direction: direction,
            from: pending.from,
            to: safeTo,
            startedAt: now,
            generation: transitionGeneration
        )
        return true
    }

    /// 中途反向：取消当前 ghost，返回插值后的当前几何（供下一趟 from）。
    @discardableResult
    func cancelActiveMorph(at now: Date = .now) -> CGRect? {
        guard let active else { return nil }
        let elapsed = now.timeIntervalSince(active.startedAt)
        let linear = min(1, max(0, elapsed / TaskSurfaceMorphTiming.durationSeconds))
        let t = Self.cubicBezierProgress(linear)
        let current = Self.lerp(active.from, active.to, t: t)
        self.active = nil
        return current
    }

    /// ghost 主动画 + fade 结束后清场，实体 rail/capsule 可立即露出。
    func completeGhost(at now: Date = .now, generation: Int? = nil) {
        _ = now
        if let generation, !isCurrentTransition(generation) { return }
        active = nil
        capsuleRevealUntil = nil
        railRevealUntil = nil
    }

    private func clearAllMorphState() {
        pending = nil
        active = nil
        capsuleRevealUntil = nil
        railRevealUntil = nil
    }

    // MARK: - Easing / lerp（与 Electron ghost 帧对齐的近似）

    static func lerp(_ from: CGRect, _ to: CGRect, t: CGFloat) -> CGRect {
        CGRect(
            x: from.minX + (to.minX - from.minX) * t,
            y: from.minY + (to.minY - from.minY) * t,
            width: from.width + (to.width - from.width) * t,
            height: from.height + (to.height - from.height) * t
        )
    }

    /// 对 cubic-bezier(0.77, 0, 0.175, 1) 做牛顿迭代求 y(t)。
    static func cubicBezierProgress(_ x: CGFloat) -> CGFloat {
        let (x1, y1, x2, y2) = TaskSurfaceMorphTiming.easingControlPoints
        var t = x
        for _ in 0..<5 {
            let currentX = cubicBezier(t, 0, x1, x2, 1)
            let dx = cubicBezierDerivative(t, 0, x1, x2, 1)
            if abs(dx) < 1e-6 { break }
            t -= (currentX - x) / dx
            t = min(1, max(0, t))
        }
        return cubicBezier(t, 0, y1, y2, 1)
    }

    private static func cubicBezier(
        _ t: CGFloat,
        _ p0: CGFloat,
        _ p1: CGFloat,
        _ p2: CGFloat,
        _ p3: CGFloat
    ) -> CGFloat {
        let u = 1 - t
        return u * u * u * p0
            + 3 * u * u * t * p1
            + 3 * u * t * t * p2
            + t * t * t * p3
    }

    private static func cubicBezierDerivative(
        _ t: CGFloat,
        _ p0: CGFloat,
        _ p1: CGFloat,
        _ p2: CGFloat,
        _ p3: CGFloat
    ) -> CGFloat {
        let u = 1 - t
        return 3 * u * u * (p1 - p0)
            + 6 * u * t * (p2 - p1)
            + 3 * t * t * (p3 - p2)
    }
}

// MARK: - Preference keys / Ghost view

struct TaskSurfaceRailFrameKey: PreferenceKey {
    static let defaultValue: CGRect = .zero
    static func reduce(value: inout CGRect, nextValue: () -> CGRect) {
        let next = nextValue()
        if next.width >= 1, next.height >= 1 { value = next }
    }
}

struct TaskSurfaceCapsuleFrameKey: PreferenceKey {
    static let defaultValue: CGRect = .zero
    static func reduce(value: inout CGRect, nextValue: () -> CGRect) {
        let next = nextValue()
        if next.width >= 1, next.height >= 1 { value = next }
    }
}

struct TaskSurfaceMorphGhostPresentation: Equatable, Identifiable {
    /// 快速反向时用于 SwiftUI 强制重建，避免 ghost 动画串台。
    let id: String
    let direction: TaskSurfaceMorphDirection
    let from: CGRect
    let to: CGRect
    let generation: Int

    init(
        id: String = UUID().uuidString,
        direction: TaskSurfaceMorphDirection,
        from: CGRect,
        to: CGRect,
        generation: Int = 0
    ) {
        self.id = id
        self.direction = direction
        self.from = from
        self.to = to
        self.generation = generation
    }
}

/// 几何 ghost：无真实对话内容；优先 transform/opacity，避免每帧改 layout frame。
struct TaskSurfaceMorphGhostView: View {
    let presentation: TaskSurfaceMorphGhostPresentation
    let containerGlobal: CGRect
    let onFinished: () -> Void

    @State private var progress: CGFloat = 0
    @State private var opacity: CGFloat = 1

    var body: some View {
        let from = presentation.from
        let to = presentation.to
        let eased = TaskSurfaceMorphCoordinator.cubicBezierProgress(progress)
        let scaleX = from.width > 0.5 ? to.width / from.width : 1
        let scaleY = from.height > 0.5 ? to.height / from.height : 1
        let currentScaleX = 1 + (scaleX - 1) * eased
        let currentScaleY = 1 + (scaleY - 1) * eased
        let dx = (to.midX - from.midX) * eased
        let dy = (to.midY - from.midY) * eased
        let radiusFrom: CGFloat = presentation.direction == .toCapsule
            ? TaskSurfaceMorphTiming.railCornerRadius
            : from.height / 2
        let radiusTo: CGFloat = presentation.direction == .toCapsule
            ? to.height / 2
            : TaskSurfaceMorphTiming.railCornerRadius
        // 圆角按视觉高度缩放，避免 scale 后半径看起来错误。
        let visualHeight = max(from.height * currentScaleY, 1)
        let radiusProgress = radiusFrom + (radiusTo - radiusFrom) * eased
        let radius = min(radiusProgress, visualHeight / 2)

        RoundedRectangle(cornerRadius: radius, style: .continuous)
            .fill(Color.tt.bgCanvasDefault)
            .overlay {
                RoundedRectangle(cornerRadius: radius, style: .continuous)
                    .strokeBorder(Color.tt.borderLight, lineWidth: 1)
            }
            .shadow(color: Color.black.opacity(0.08), radius: 12, y: 4)
            .frame(width: max(from.width, 1), height: max(from.height, 1))
            .scaleEffect(x: currentScaleX, y: currentScaleY, anchor: .center)
            .position(
                x: from.midX - containerGlobal.minX + dx,
                y: from.midY - containerGlobal.minY + dy
            )
            .opacity(opacity)
            .allowsHitTesting(false)
            .onAppear {
                progress = 0
                opacity = 1
                withAnimation(
                    .timingCurve(0.77, 0, 0.175, 1, duration: TaskSurfaceMorphTiming.durationSeconds)
                ) {
                    progress = 1
                } completion: {
                    withAnimation(.easeOut(duration: TaskSurfaceMorphTiming.ghostFadeSeconds)) {
                        opacity = 0
                    } completion: {
                        onFinished()
                    }
                }
            }
    }
}
