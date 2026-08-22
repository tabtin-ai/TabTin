import CoreGraphics
import Foundation

enum CapsuleDockSide: String, Equatable, Sendable {
    case left
    case right
}

struct CapsulePlacement: Equatable, Sendable {
    var side: CapsuleDockSide
    /// 0 = 可拖区域顶部，1 = 底部。
    var yRatio: CGFloat

    static let `default` = CapsulePlacement(side: .right, yRatio: 1)
}

enum CapsulePlacementMetrics {
    static let safeMargin: CGFloat = 14
    /// 额外预留给顶栏 / 导航的硬顶 inset（相对容器）。
    static let hardTopInset: CGFloat = 0
}

enum CapsulePlacementGeometry {
    struct Bounds: Equatable, Sendable {
        var minX: CGFloat
        var maxX: CGFloat
        var minY: CGFloat
        var maxY: CGFloat
    }

    static func clamp(_ value: CGFloat, _ min: CGFloat, _ max: CGFloat) -> CGFloat {
        Swift.max(min, Swift.min(max, value))
    }

    static func resolveBounds(
        viewport: CGSize,
        capsuleSize: CGSize,
        safeMargin: CGFloat = CapsulePlacementMetrics.safeMargin,
        hardTopInset: CGFloat = CapsulePlacementMetrics.hardTopInset
    ) -> Bounds {
        let margin = Swift.max(0, safeMargin)
        let hardMaxX = Swift.max(0, viewport.width - capsuleSize.width)
        let hardMaxY = Swift.max(0, viewport.height - capsuleSize.height)

        let preferredMinX = margin
        let preferredMaxX = viewport.width - margin - capsuleSize.width
        let minX: CGFloat
        let maxX: CGFloat
        if preferredMinX <= preferredMaxX {
            minX = clamp(preferredMinX, 0, hardMaxX)
            maxX = clamp(preferredMaxX, 0, hardMaxX)
        } else {
            minX = 0
            maxX = hardMaxX
        }

        let preferredMinY = hardTopInset + margin
        let preferredMaxY = viewport.height - margin - capsuleSize.height
        let minY: CGFloat
        let maxY: CGFloat
        if preferredMinY <= preferredMaxY {
            minY = clamp(preferredMinY, 0, hardMaxY)
            maxY = clamp(preferredMaxY, 0, hardMaxY)
        } else {
            let hardMin = hardMaxY >= hardTopInset ? hardTopInset : 0
            minY = clamp(hardMin, 0, hardMaxY)
            maxY = hardMaxY
        }

        return Bounds(minX: minX, maxX: maxX, minY: minY, maxY: maxY)
    }

    static func position(
        for placement: CapsulePlacement,
        viewport: CGSize,
        capsuleSize: CGSize,
        safeMargin: CGFloat = CapsulePlacementMetrics.safeMargin,
        hardTopInset: CGFloat = CapsulePlacementMetrics.hardTopInset
    ) -> CGPoint {
        let bounds = resolveBounds(
            viewport: viewport,
            capsuleSize: capsuleSize,
            safeMargin: safeMargin,
            hardTopInset: hardTopInset
        )
        let ratio = clamp(placement.yRatio, 0, 1)
        return CGPoint(
            x: placement.side == .left ? bounds.minX : bounds.maxX,
            y: bounds.minY + (bounds.maxY - bounds.minY) * ratio
        )
    }

    static func placement(
        from position: CGPoint,
        viewport: CGSize,
        capsuleSize: CGSize,
        safeMargin: CGFloat = CapsulePlacementMetrics.safeMargin,
        hardTopInset: CGFloat = CapsulePlacementMetrics.hardTopInset
    ) -> CapsulePlacement {
        let bounds = resolveBounds(
            viewport: viewport,
            capsuleSize: capsuleSize,
            safeMargin: safeMargin,
            hardTopInset: hardTopInset
        )
        let clamped = CGPoint(
            x: clamp(position.x, bounds.minX, bounds.maxX),
            y: clamp(position.y, bounds.minY, bounds.maxY)
        )
        let midX = (bounds.minX + bounds.maxX) / 2
        let rangeY = bounds.maxY - bounds.minY
        return CapsulePlacement(
            side: clamped.x < midX ? .left : .right,
            yRatio: rangeY > 0 ? (clamped.y - bounds.minY) / rangeY : 1
        )
    }

    /// 松手吸附：水平贴最近边，竖直保持当前 y。
    static func dockedPosition(
        from position: CGPoint,
        viewport: CGSize,
        capsuleSize: CGSize,
        safeMargin: CGFloat = CapsulePlacementMetrics.safeMargin,
        hardTopInset: CGFloat = CapsulePlacementMetrics.hardTopInset
    ) -> CGPoint {
        let snapped = placement(
            from: position,
            viewport: viewport,
            capsuleSize: capsuleSize,
            safeMargin: safeMargin,
            hardTopInset: hardTopInset
        )
        return self.position(
            for: snapped,
            viewport: viewport,
            capsuleSize: capsuleSize,
            safeMargin: safeMargin,
            hardTopInset: hardTopInset
        )
    }
}

enum CapsuleHITLBubbleGeometry {
    enum Edge: Equatable, Sendable {
        case above
        case below
    }

    struct Placement: Equatable, Sendable {
        let frame: CGRect
        let edge: Edge
    }

    static let gap: CGFloat = 8
    static let idealWidth: CGFloat = 288

    static func maximumSize(
        viewport: CGRect,
        capsuleFrame: CGRect,
        safeMargin: CGFloat = CapsulePlacementMetrics.safeMargin
    ) -> CGSize {
        let margin = max(0, safeMargin)
        let safeBounds = viewport.insetBy(dx: margin, dy: margin)
        let roomAbove = max(0, capsuleFrame.minY - gap - safeBounds.minY)
        let roomBelow = max(0, safeBounds.maxY - capsuleFrame.maxY - gap)
        return CGSize(
            width: min(idealWidth, max(0, safeBounds.width)),
            height: max(roomAbove, roomBelow)
        )
    }

    /// 独立计算气泡 frame；胶囊 frame 只作为锚点，不参与 `CapsulePlacementStore` 的
    /// chrome 测量，因此气泡出现/消失不会改写 yRatio 或让胶囊跳位。
    static func placement(
        viewport: CGRect,
        capsuleFrame: CGRect,
        bubbleSize: CGSize,
        side: CapsuleDockSide,
        safeMargin: CGFloat = CapsulePlacementMetrics.safeMargin
    ) -> Placement {
        let margin = max(0, safeMargin)
        let safeBounds = viewport.insetBy(dx: margin, dy: margin)
        let maximumSize = maximumSize(
            viewport: viewport,
            capsuleFrame: capsuleFrame,
            safeMargin: safeMargin
        )
        let constrainedSize = CGSize(
            width: min(max(0, bubbleSize.width), maximumSize.width),
            height: min(max(0, bubbleSize.height), maximumSize.height)
        )
        let alignedX = side == .left
            ? capsuleFrame.minX
            : capsuleFrame.maxX - constrainedSize.width
        let minX = safeBounds.minX
        let maxX = max(minX, safeBounds.maxX - constrainedSize.width)
        let x = CapsulePlacementGeometry.clamp(alignedX, minX, maxX)

        let aboveY = capsuleFrame.minY - gap - constrainedSize.height
        let belowY = capsuleFrame.maxY + gap
        let roomAbove = capsuleFrame.minY - gap - safeBounds.minY
        let roomBelow = safeBounds.maxY - capsuleFrame.maxY - gap
        let edge: Edge = roomAbove >= roomBelow
            ? .above
            : .below
        let desiredY = edge == .above ? aboveY : belowY
        let minY = safeBounds.minY
        let maxY = max(minY, safeBounds.maxY - constrainedSize.height)
        let y = CapsulePlacementGeometry.clamp(desiredY, minY, maxY)

        return Placement(
            frame: CGRect(origin: CGPoint(x: x, y: y), size: constrainedSize),
            edge: edge
        )
    }
}

/// 气泡刚插入 SwiftUI 树时，真实尺寸偏好可能要到下一帧才上报。
/// 先用一个安全的卡片尺寸参与定位，避免“尺寸为零 → 透明 → 永远测不到”的自锁。
enum CapsuleHITLAccessoryMeasurement {
    static let bootstrapHeight: CGFloat = 180

    static func resolvedSize(measured: CGSize, maximum: CGSize) -> CGSize {
        guard maximum.width > 1, maximum.height > 1 else { return .zero }
        if measured.width > 1, measured.height > 1 {
            return CGSize(
                width: min(measured.width, maximum.width),
                height: min(measured.height, maximum.height)
            )
        }
        return CGSize(
            width: maximum.width,
            height: min(bootstrapHeight, maximum.height)
        )
    }
}

/// 按设备本地持久化胶囊贴边位置（side + yRatio）。
@MainActor
enum CapsulePlacementStore {
    private static let defaultsKey = "tt.workbench.capsulePlacement"

    static func load() -> CapsulePlacement {
        guard let data = UserDefaults.standard.data(forKey: defaultsKey),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { return .default }
        let sideRaw = obj["side"] as? String
        let side = CapsuleDockSide(rawValue: sideRaw ?? "") ?? .right
        let ratioValue = obj["yRatio"] as? Double ?? Double(CapsulePlacement.default.yRatio)
        let ratio = CapsulePlacementGeometry.clamp(CGFloat(ratioValue), 0, 1)
        return CapsulePlacement(side: side, yRatio: ratio)
    }

    static func save(_ placement: CapsulePlacement) {
        let payload: [String: Any] = [
            "side": placement.side.rawValue,
            "yRatio": Double(placement.yRatio),
        ]
        if let data = try? JSONSerialization.data(withJSONObject: payload) {
            UserDefaults.standard.set(data, forKey: defaultsKey)
        }
    }
}

enum CapsuleOnboardingAction: String, Codable, Equatable, Sendable {
    case tap
    case drag
    case hold
}

/// 胶囊教学只记录设备本地的发现进度，不跟账号或工作区绑定。
struct CapsuleOnboardingProgress: Codable, Equatable, Sendable {
    var appearanceCount = 0
    var lastPromptAppearance = 0
    var tapLearned = false
    var dragLearned = false
    var holdLearned = false
    var skipped = false

    mutating func recordAppearance() {
        appearanceCount += 1
    }

    func nextPrompt(replySuggested: Bool) -> CapsuleOnboardingAction? {
        guard !skipped, lastPromptAppearance < appearanceCount else { return nil }
        if !tapLearned { return .tap }
        if replySuggested, !holdLearned, appearanceCount >= 2 { return .hold }
        if !dragLearned, appearanceCount >= 2 { return .drag }
        return nil
    }

    mutating func markPromptShown(_: CapsuleOnboardingAction) {
        lastPromptAppearance = appearanceCount
    }

    mutating func markLearned(_ action: CapsuleOnboardingAction) {
        switch action {
        case .tap: tapLearned = true
        case .drag: dragLearned = true
        case .hold: holdLearned = true
        }
    }

    mutating func skipAll() {
        skipped = true
    }
}

@MainActor
enum CapsuleOnboardingStore {
    private static let defaultsKey = "tt.workbench.capsuleOnboarding.v1"

    static func load() -> CapsuleOnboardingProgress {
        guard let data = UserDefaults.standard.data(forKey: defaultsKey),
              let progress = try? JSONDecoder().decode(CapsuleOnboardingProgress.self, from: data)
        else { return CapsuleOnboardingProgress() }
        return progress
    }

    static func save(_ progress: CapsuleOnboardingProgress) {
        guard let data = try? JSONEncoder().encode(progress) else { return }
        UserDefaults.standard.set(data, forKey: defaultsKey)
    }

    static func reset() {
        UserDefaults.standard.removeObject(forKey: defaultsKey)
    }
}
