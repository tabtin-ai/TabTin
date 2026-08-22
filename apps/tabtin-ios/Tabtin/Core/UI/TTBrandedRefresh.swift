import SwiftUI

private enum TTBrandedRefreshPhase: Equatable {
    case idle
    case refreshing
}

public extension View {
    /// 保留系统下拉手势与刷新任务，只将系统指示器覆盖为 TabTin 品牌反馈。
    func ttBrandedRefreshable(action: @escaping @Sendable () async -> Void) -> some View {
        modifier(TTBrandedRefreshModifier(action: action))
    }
}

private struct TTBrandedRefreshModifier: ViewModifier {
    private let threshold: CGFloat = 82
    private let indicatorSize: CGFloat = 72
    let action: @Sendable () async -> Void

    @State private var pullDistance: CGFloat = 0
    @State private var phase: TTBrandedRefreshPhase = .idle

    func body(content: Content) -> some View {
        content
            .onScrollGeometryChange(for: CGFloat.self) { geometry in
                max(0, -(geometry.contentOffset.y + geometry.contentInsets.top))
            } action: { _, distance in
                guard phase == .idle else { return }
                pullDistance = distance
            }
            .refreshable {
                phase = .refreshing
                await action()
                phase = .idle
                pullDistance = 0
            }
            .overlay(alignment: .top) {
                TTBrandedRefreshIndicator(
                    pullProgress: min(max(pullDistance / threshold, 0), 1.25),
                    phase: phase
                )
                .frame(width: indicatorSize, height: indicatorSize)
                .offset(y: indicatorOffset)
                .opacity(indicatorOpacity)
                .allowsHitTesting(false)
                .accessibilityHidden(true)
            }
            // 负向入场只允许发生在列表自身范围内，不能越过上方的次级功能栏。
            .clipped()
    }

    private var indicatorOffset: CGFloat {
        guard phase == .idle else { return 8 }
        return -indicatorSize + indicatorSize * min(pullDistance / threshold, 1)
    }

    private var indicatorOpacity: Double {
        phase == .idle ? min(max(pullDistance / 16, 0), 1) : 1
    }
}

private struct TTBrandedRefreshIndicator: View {
    let pullProgress: CGFloat
    let phase: TTBrandedRefreshPhase

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        TimelineView(.animation(
            minimumInterval: 1 / 60,
            paused: phase != .refreshing || reduceMotion
        )) { timeline in
            Canvas { context, size in
                draw(
                    context: &context,
                    size: size,
                    time: timeline.date.timeIntervalSinceReferenceDate
                )
            }
        }
    }

    private func draw(context: inout GraphicsContext, size: CGSize, time: TimeInterval) {
        let unit = min(size.width, size.height) / 72
        let progress = min(max(pullProgress, 0), 1)
        let ink = Color.tt.textPrimary
        let paper = Color.tt.bgCanvasDefault
        let center = point(36, 36, unit: unit)

        context.fill(
            Path(ellipseIn: rect(centerX: 36, centerY: 36, radius: 35, unit: unit)),
            with: .color(paper)
        )

        context.stroke(
            Path(ellipseIn: rect(centerX: 36, centerY: 36, radius: 31, unit: unit)),
            with: .color(ink.opacity(0.18 * progress)),
            lineWidth: 1.2 * unit
        )

        let middleCircle = Path(ellipseIn: rect(centerX: 36, centerY: 36, radius: 24, unit: unit))
            .trimmedPath(from: 0, to: progress)
        context.stroke(
            middleCircle,
            with: .color(ink.opacity(0.92 * progress)),
            style: StrokeStyle(lineWidth: 2 * unit, lineCap: .round)
        )

        context.stroke(
            Path(ellipseIn: rect(centerX: 36, centerY: 36, radius: 17, unit: unit)),
            with: .color(ink.opacity(0.34 * progress)),
            style: StrokeStyle(
                lineWidth: 1.2 * unit,
                dash: [3 * unit, 4 * unit]
            )
        )

        if phase == .refreshing, !reduceMotion {
            let angle = nonLinearRotation(time: time)
            var spinnerContext = context
            spinnerContext.translateBy(x: center.x, y: center.y)
            spinnerContext.rotate(by: .degrees(angle))
            spinnerContext.translateBy(x: -center.x, y: -center.y)

            var spinner = Path()
            spinner.addArc(
                center: center,
                radius: 28 * unit,
                startAngle: .degrees(-90),
                endAngle: .degrees(22),
                clockwise: false
            )
            spinnerContext.stroke(
                spinner,
                with: .color(ink),
                style: StrokeStyle(lineWidth: 6 * unit, lineCap: .butt)
            )
        }

        let tinAlpha = phase == .idle ? 0.3 * progress : 1
        let bodyRect = CGRect(x: 24.6 * unit, y: 30.4 * unit, width: 23.8 * unit, height: 14.3 * unit)
        let body = Path(roundedRect: bodyRect, cornerRadius: 5.2 * unit)
        context.fill(body, with: .color(paper))
        context.stroke(
            body,
            with: .color(ink.opacity(tinAlpha)),
            lineWidth: 2 * unit
        )

        strokeLine(
            context: &context,
            from: point(36.5, 30.4, unit: unit),
            to: point(36.5, 26.5, unit: unit),
            color: ink.opacity(tinAlpha),
            width: 2 * unit
        )
        context.fill(
            Path(ellipseIn: rect(centerX: 36.5, centerY: 24.8, radius: 2.2, unit: unit)),
            with: .color(ink.opacity(tinAlpha))
        )

        let blinkScale = phase == .refreshing && !reduceMotion ? eyeScale(time: time) : 1
        for x in [32.5, 40.5] {
            let eyeRect = CGRect(
                x: (x - 2) * unit,
                y: (37.6 - 2 * blinkScale) * unit,
                width: 4 * unit,
                height: 4 * blinkScale * unit
            )
            context.fill(Path(ellipseIn: eyeRect), with: .color(ink.opacity(tinAlpha)))
        }

    }

    private func nonLinearRotation(time: TimeInterval) -> Double {
        let duration = 0.93
        let cycle = time / duration
        let completed = floor(cycle)
        let local = cycle - completed
        let eased = 1 - pow(1 - local, 4)
        return 360 * (completed + eased)
    }

    private func eyeScale(time: TimeInterval) -> CGFloat {
        let local = (time.truncatingRemainder(dividingBy: 0.93)) / 0.93
        guard local > 0.62, local < 0.76 else { return 1 }
        let distance = abs(local - 0.69) / 0.07
        return max(0.08, CGFloat(distance))
    }

    private func point(_ x: CGFloat, _ y: CGFloat, unit: CGFloat) -> CGPoint {
        CGPoint(x: x * unit, y: y * unit)
    }

    private func rect(centerX: CGFloat, centerY: CGFloat, radius: CGFloat, unit: CGFloat) -> CGRect {
        CGRect(
            x: (centerX - radius) * unit,
            y: (centerY - radius) * unit,
            width: radius * 2 * unit,
            height: radius * 2 * unit
        )
    }

    private func strokeLine(
        context: inout GraphicsContext,
        from: CGPoint,
        to: CGPoint,
        color: Color,
        width: CGFloat
    ) {
        var path = Path()
        path.move(to: from)
        path.addLine(to: to)
        context.stroke(
            path,
            with: .color(color),
            style: StrokeStyle(lineWidth: width, lineCap: .round)
        )
    }
}
