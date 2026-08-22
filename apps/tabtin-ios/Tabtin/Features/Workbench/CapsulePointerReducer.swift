import CoreGraphics
import Foundation

enum CapsulePointerMetrics {
    static let dragThreshold: CGFloat = 12
    static let menuHoldMs: Int = 420
}

enum CapsulePointerPhase: Equatable, Sendable {
    case idle
    case pressing
    case dragging
    case menuOpen
}

enum CapsuleMenuSelection: Equatable, Sendable {
    case text
    case voice
}

enum CapsulePointerEvent: Equatable, Sendable {
    case touchBegan
    case touchMoved(dx: CGFloat, dy: CGFloat)
    case touchEnded
    case touchCancelled
    case holdElapsed(ms: Int)
    case selectMenu(CapsuleMenuSelection)
    case dismissMenu
}

/// 单次手势周期内 reducer 产出的副作用，供 UI 层消费（回对话 / 持久化拖拽 / 开菜单等）。
enum CapsulePointerOutcome: Equatable, Sendable {
    case tap
    case dragEnd
    case menuOpened
    case menuSelection(CapsuleMenuSelection)
    case menuDismissed
}

/// 工作台胶囊指针语义：短按展开对话、超阈值直接拖拽胶囊、静止长按出输入菜单；
/// 三路互斥，长按打开菜单后不再切换成迁位手势。
struct CapsulePointerReducer: Equatable, Sendable {
    private(set) var phase: CapsulePointerPhase = .idle
    private(set) var pendingOutcome: CapsulePointerOutcome?

    private var accumulatedDx: CGFloat = 0
    private var accumulatedDy: CGFloat = 0

    mutating func handle(_ event: CapsulePointerEvent) {
        pendingOutcome = nil

        switch event {
        case .touchBegan:
            guard phase == .idle else { return }
            phase = .pressing
            accumulatedDx = 0
            accumulatedDy = 0

        case let .touchMoved(dx, dy):
            switch phase {
            case .pressing:
                accumulatedDx += dx
                accumulatedDy += dy
                if dragDistance > CapsulePointerMetrics.dragThreshold {
                    phase = .dragging
                }
            case .dragging:
                accumulatedDx += dx
                accumulatedDy += dy
            case .menuOpen:
                break
            case .idle:
                break
            }

        case let .holdElapsed(ms):
            guard phase == .pressing, ms >= CapsulePointerMetrics.menuHoldMs else { return }
            phase = .menuOpen
            pendingOutcome = .menuOpened

        case .touchEnded:
            switch phase {
            case .pressing:
                phase = .idle
                pendingOutcome = .tap
            case .dragging:
                phase = .idle
                pendingOutcome = .dragEnd
            case .idle, .menuOpen:
                break
            }

        case .touchCancelled:
            phase = .idle
            accumulatedDx = 0
            accumulatedDy = 0

        case let .selectMenu(selection):
            guard phase == .menuOpen else { return }
            phase = .idle
            pendingOutcome = .menuSelection(selection)

        case .dismissMenu:
            guard phase == .menuOpen else { return }
            phase = .idle
            pendingOutcome = .menuDismissed
        }
    }

    private var dragDistance: CGFloat {
        hypot(accumulatedDx, accumulatedDy)
    }
}
