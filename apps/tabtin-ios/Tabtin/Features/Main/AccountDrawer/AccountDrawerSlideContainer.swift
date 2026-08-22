import SwiftUI
import UIKit

/// 用 UIKit transform 跟手推挤主壳，避免 DragGesture 每帧写 SwiftUI `@State` 重绘整棵 TabView。
/// 蒙层也挂在同一 panel 上，跟位移绑定，避免 `isOpen` 与 transform 不同步时全屏灰罩 / 侧栏字样漏出。
struct AccountDrawerSlideContainer<Content: View>: UIViewControllerRepresentable {
    var isOpen: Bool
    var drawerWidth: CGFloat
    var allowsEdgeOpen: Bool
    var onRequestOpen: () -> Void
    var onRequestClose: () -> Void
    @ViewBuilder var content: () -> Content

    func makeCoordinator() -> Coordinator {
        Coordinator()
    }

    func makeUIViewController(context: Context) -> AccountDrawerSlideViewController {
        let controller = AccountDrawerSlideViewController()
        let host = UIHostingController(rootView: content())
        host.view.backgroundColor = UIColor(Color.tt.bgCanvasDefault)
        host.safeAreaRegions = [.container, .keyboard]
        context.coordinator.host = host
        controller.onInteractionEnded = { [weak coordinator = context.coordinator] in
            coordinator?.flushPendingContent()
        }
        controller.embed(host)
        controller.drawerWidth = drawerWidth
        controller.allowsEdgeOpen = allowsEdgeOpen
        controller.onRequestOpen = onRequestOpen
        controller.onRequestClose = onRequestClose
        controller.setOpen(isOpen, animated: false)
        return controller
    }

    func updateUIViewController(_ controller: AccountDrawerSlideViewController, context: Context) {
        context.coordinator.updateContent(content(), deferred: controller.isInteractivelyDragging)
        controller.drawerWidth = drawerWidth
        controller.allowsEdgeOpen = allowsEdgeOpen
        controller.onRequestOpen = onRequestOpen
        controller.onRequestClose = onRequestClose

        let animated = context.transaction.animation != nil && !context.transaction.disablesAnimations
        controller.setOpen(isOpen, animated: animated)
    }

    @MainActor
    final class Coordinator {
        var host: UIHostingController<Content>?
        private var pendingContent: Content?

        func updateContent(_ content: Content, deferred: Bool) {
            guard !deferred else {
                pendingContent = content
                return
            }
            pendingContent = nil
            host?.rootView = content
        }

        func flushPendingContent() {
            guard let pendingContent else { return }
            self.pendingContent = nil
            host?.rootView = pendingContent
        }
    }
}

private final class AccountDrawerPassthroughRootView: UIView {
    override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? {
        let hitView = super.hitTest(point, with: event)
        // panel 的 transform 会让揭示区不再命中子视图；根层本身也必须放行，
        // 才能让后方 SwiftUI 侧栏接收点击。不能用目标 offset 硬算穿透区，
        // 否则 spring 动画期间触摸区域会领先于视觉位置。
        return hitView === self ? nil : hitView
    }
}

final class AccountDrawerSlideViewController: UIViewController, UIGestureRecognizerDelegate {
#if DEBUG
    struct DebugSnapshot {
        let drawerWidth: CGFloat
        let currentOffset: CGFloat
        let panelTranslationX: CGFloat
        let scrimAlpha: CGFloat
        let rootBackgroundAlpha: CGFloat
        let revealPointPassesThrough: Bool
        let revealHitView: String
        let panelFrameInRoot: CGRect
        let presentationOffset: CGFloat
        let desiredOpen: Bool
        let isAnimating: Bool
    }
#endif

    var drawerWidth: CGFloat = 300 {
        didSet {
            guard !isInteractivelyDragging, oldValue != drawerWidth else { return }
            animationGeneration += 1
            isAnimating = false
            animationTargetOpen = nil
            panel.layer.removeAllAnimations()
            scrimView.layer.removeAllAnimations()
            applyInteractiveOffset(desiredOpen ? drawerWidth : min(currentOffset, drawerWidth))
        }
    }

    var allowsEdgeOpen = true {
        didSet { updateGestureAvailability() }
    }

    var onRequestOpen: (() -> Void)?
    var onRequestClose: (() -> Void)?
    var onInteractionEnded: (() -> Void)?

    private(set) var isInteractivelyDragging = false

    private let panel = UIView()
    private let scrimView = UIView()
    private var currentOffset: CGFloat = 0
    private var offsetAtPanBegin: CGFloat = 0
    private var desiredOpen = false
    private var lastExternalOpen = false
    private var externalOpenAtDragBegin = false
    private var pendingExternalOpen: Bool?
    private var animationGeneration = 0
    private var isAnimating = false
    private var animationTargetOpen: Bool?

    private var closePanGesture: UIPanGestureRecognizer?
    private var edgePanGesture: UIScreenEdgePanGestureRecognizer?

#if DEBUG
    func debugSnapshot() -> DebugSnapshot {
        loadViewIfNeeded()
        view.layoutIfNeeded()
        let revealPoint = CGPoint(
            x: max(1, drawerWidth * 0.5),
            y: max(1, view.safeAreaInsets.top + 22)
        )
        let hitView = view.hitTest(revealPoint, with: nil)
        return DebugSnapshot(
            drawerWidth: drawerWidth,
            currentOffset: currentOffset,
            panelTranslationX: panel.transform.tx,
            scrimAlpha: scrimView.alpha,
            rootBackgroundAlpha: view.backgroundColor?.cgColor.alpha ?? 0,
            revealPointPassesThrough: hitView == nil,
            revealHitView: hitView.map { String(describing: type(of: $0)) } ?? "nil",
            panelFrameInRoot: panel.convert(panel.bounds, to: view),
            presentationOffset: presentationOffset(),
            desiredOpen: desiredOpen,
            isAnimating: isAnimating
        )
    }
#endif

    override func loadView() {
        view = AccountDrawerPassthroughRootView()
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        // 根层必须透明：主壳 panel 右移后，空出的区域用于展示后方侧栏。
        // 关闭态由不透明 panel 自身完整遮盖侧栏，不依赖根背景兜底。
        let canvas = UIColor(Color.tt.bgCanvasDefault)
        view.backgroundColor = .clear
        view.isOpaque = false
        panel.backgroundColor = canvas
        panel.frame = view.bounds
        view.addSubview(panel)

        scrimView.backgroundColor = UIColor.black.withAlphaComponent(0.28)
        scrimView.alpha = 0
        scrimView.frame = panel.bounds
        scrimView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        scrimView.isUserInteractionEnabled = false
        panel.addSubview(scrimView)

        let scrimTap = UITapGestureRecognizer(target: self, action: #selector(handleScrimTap))
        scrimView.addGestureRecognizer(scrimTap)

        let closePan = UIPanGestureRecognizer(target: self, action: #selector(handleClosePan(_:)))
        closePan.delegate = self
        closePan.cancelsTouchesInView = false
        view.addGestureRecognizer(closePan)
        closePanGesture = closePan

        let edgePan = UIScreenEdgePanGestureRecognizer(target: self, action: #selector(handleEdgePan(_:)))
        edgePan.edges = .left
        edgePan.delegate = self
        view.addGestureRecognizer(edgePan)
        edgePanGesture = edgePan
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        // 布局变化后保持当前位移，防止 SwiftUI 刷新把 transform 打回 identity。
        // 带 transform 时写 frame 的结果未定义；用 bounds + center 保持未变换几何。
        panel.bounds = view.bounds
        panel.center = CGPoint(x: view.bounds.midX, y: view.bounds.midY)
        panel.transform = CGAffineTransform(translationX: currentOffset, y: 0)
        updateScrim()
    }

    func embed(_ host: UIViewController) {
        loadViewIfNeeded()
        addChild(host)
        if scrimView.superview === panel {
            panel.insertSubview(host.view, belowSubview: scrimView)
        } else {
            panel.addSubview(host.view)
        }
        host.view.backgroundColor = UIColor(Color.tt.bgCanvasDefault)
        host.view.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            host.view.topAnchor.constraint(equalTo: panel.topAnchor),
            host.view.bottomAnchor.constraint(equalTo: panel.bottomAnchor),
            host.view.leadingAnchor.constraint(equalTo: panel.leadingAnchor),
            host.view.trailingAnchor.constraint(equalTo: panel.trailingAnchor),
        ])
        host.didMove(toParent: self)
    }

    func setOpen(_ open: Bool, animated: Bool) {
        lastExternalOpen = open
        if isInteractivelyDragging {
            // 外部状态可能在一次手势里先变化又恢复；恢复时必须清掉旧目标。
            pendingExternalOpen = open == externalOpenAtDragBegin ? nil : open
            return
        }
        settle(toOpen: open, animated: animated)
    }

    private func applyInteractiveOffset(_ offset: CGFloat) {
        let clamped = min(max(offset, 0), max(drawerWidth, 1))
        currentOffset = clamped
        panel.transform = CGAffineTransform(translationX: clamped, y: 0)
        updateScrim()
        updateGestureAvailability()
    }

    private func settle(toOpen open: Bool, animated: Bool, velocity: CGFloat = 0) {
        desiredOpen = open
        let target = open ? drawerWidth : 0

        // SwiftUI 在 UIKit settle 期间可能因状态同步或无关刷新再次下发同一目标。
        // 相同目标保持幂等，避免 spring 被不断从 presentation frame 重启。
        if isAnimating, animationTargetOpen == open {
            return
        }

        let alreadyAtTarget = abs(currentOffset - target) < 0.5
            && abs(panel.transform.tx - target) < 0.5
        if alreadyAtTarget, !isAnimating {
            updateGestureAvailability()
            return
        }

        animationGeneration += 1
        let generation = animationGeneration

        guard animated, !UIAccessibility.isReduceMotionEnabled else {
            isAnimating = false
            animationTargetOpen = nil
            panel.layer.removeAllAnimations()
            scrimView.layer.removeAllAnimations()
            applyInteractiveOffset(target)
            return
        }

        isAnimating = true
        animationTargetOpen = open
        let remainingDistance = target - currentOffset
        let initialVelocity = abs(remainingDistance) > 0.5
            ? min(max(velocity / remainingDistance, -8), 8)
            : 0
        currentOffset = target
        updateGestureAvailability()

        let damping: CGFloat = target < 1 ? 0.92 : 0.86
        let duration: TimeInterval = target < 1 ? 0.32 : 0.36
        UIView.animate(
            withDuration: duration,
            delay: 0,
            usingSpringWithDamping: damping,
            initialSpringVelocity: initialVelocity,
            options: [.allowUserInteraction, .beginFromCurrentState]
        ) {
            self.panel.transform = CGAffineTransform(translationX: target, y: 0)
            self.updateScrim()
        } completion: { [weak self] finished in
            guard let self, self.animationGeneration == generation else { return }
            guard finished, self.animationTargetOpen == open else {
                self.isAnimating = false
                self.animationTargetOpen = nil
                self.updateScrim()
                return
            }
            self.isAnimating = false
            self.animationTargetOpen = nil
            self.currentOffset = target
            self.updateScrim()
            self.updateGestureAvailability()
        }
    }

    private func updateGestureAvailability() {
        // 跟手过程中不要中途禁用手势，否则 edge/close pan 会被系统直接 cancel。
        guard !isInteractivelyDragging else { return }
        edgePanGesture?.isEnabled = allowsEdgeOpen && currentOffset < 0.5
        closePanGesture?.isEnabled = currentOffset > 0.5
    }

    private func updateScrim() {
        let progress = min(max(currentOffset / max(drawerWidth, 1), 0), 1)
        scrimView.alpha = progress
        // 关闭动画期间视觉蒙层仍在，不能提前把点击透给主壳。
        scrimView.isUserInteractionEnabled = desiredOpen
            || isAnimating
            || isInteractivelyDragging
            || progress > 0.05
    }

    @objc private func handleScrimTap() {
        guard !isInteractivelyDragging, currentOffset > 0.5 else { return }
        settleFromUser(toOpen: false)
    }

    @objc private func handleEdgePan(_ gesture: UIScreenEdgePanGestureRecognizer) {
        guard allowsEdgeOpen || isInteractivelyDragging else { return }
        let translation = gesture.translation(in: view).x
        let velocity = gesture.velocity(in: view).x

        switch gesture.state {
        case .began:
            beginInteractiveDrag()
        case .changed:
            guard isInteractivelyDragging else { return }
            applyInteractiveOffset(offsetAtPanBegin + translation)
        case .ended:
            finishDrag(opening: true, velocity: velocity)
        case .cancelled, .failed:
            cancelDrag()
        default:
            break
        }
    }

    @objc private func handleClosePan(_ gesture: UIPanGestureRecognizer) {
        let translation = gesture.translation(in: view).x
        let velocity = gesture.velocity(in: view).x

        switch gesture.state {
        case .began:
            guard presentationOffset() > 0.5 else { return }
            beginInteractiveDrag()
        case .changed:
            guard isInteractivelyDragging else { return }
            applyInteractiveOffset(offsetAtPanBegin + translation)
        case .ended:
            guard isInteractivelyDragging else { return }
            finishDrag(opening: false, velocity: velocity)
        case .cancelled, .failed:
            guard isInteractivelyDragging else { return }
            cancelDrag()
        default:
            break
        }
    }

    private func beginInteractiveDrag() {
        animationGeneration += 1
        let visualOffset = presentationOffset()
        panel.layer.removeAllAnimations()
        scrimView.layer.removeAllAnimations()
        isAnimating = false
        animationTargetOpen = nil
        isInteractivelyDragging = true
        externalOpenAtDragBegin = lastExternalOpen
        pendingExternalOpen = nil
        offsetAtPanBegin = visualOffset
        applyInteractiveOffset(visualOffset)
    }

    private func presentationOffset() -> CGFloat {
        let offset = panel.layer.presentation()?.frame.minX
            ?? panel.convert(panel.bounds, to: view).minX
        return min(max(offset, 0), max(drawerWidth, 1))
    }

    private func finishDrag(opening: Bool, velocity: CGFloat) {
        let shouldOpen: Bool
        if opening {
            shouldOpen = currentOffset > drawerWidth * 0.35 || velocity > 500
        } else {
            shouldOpen = !(currentOffset < drawerWidth * 0.78 || velocity < -500)
        }

        completeInteractiveDrag(toOpen: pendingExternalOpen ?? shouldOpen, velocity: velocity)
    }

    private func cancelDrag() {
        completeInteractiveDrag(
            toOpen: pendingExternalOpen ?? externalOpenAtDragBegin,
            velocity: 0
        )
    }

    private func completeInteractiveDrag(toOpen open: Bool, velocity: CGFloat) {
        isInteractivelyDragging = false
        pendingExternalOpen = nil
        settleFromUser(toOpen: open, velocity: velocity)
        onInteractionEnded?()
    }

    private func settleFromUser(toOpen open: Bool, velocity: CGFloat = 0) {
        settle(toOpen: open, animated: true, velocity: velocity)
        guard lastExternalOpen != open else { return }
        // 用户意图已经提交；不要等 SwiftUI 下一轮回灌才更新手势基准。
        lastExternalOpen = open
        if open {
            onRequestOpen?()
        } else {
            onRequestClose?()
        }
    }

    func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
        let visualOffset = presentationOffset()
        if gestureRecognizer === edgePanGesture {
            return allowsEdgeOpen && visualOffset < drawerWidth - 0.5
        }
        if gestureRecognizer === closePanGesture {
            guard visualOffset > 0.5, let pan = gestureRecognizer as? UIPanGestureRecognizer else {
                return false
            }
            let velocity = pan.velocity(in: view)
            return abs(velocity.x) > abs(velocity.y) && velocity.x < 0
        }
        return true
    }

    func gestureRecognizer(
        _ gestureRecognizer: UIGestureRecognizer,
        shouldRecognizeSimultaneouslyWith otherGestureRecognizer: UIGestureRecognizer
    ) -> Bool {
        // 边缘打开不与列表竖滑抢；关闭时可与内容共存。
        gestureRecognizer === closePanGesture
    }
}
