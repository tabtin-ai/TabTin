import SwiftUI

/// 系统静态 LaunchScreen 后的原生接力层。
///
/// 视觉与已通过的移动端 HTML 样片保持同一时间轴，但不在冷启动关键路径创建 WebView，
/// 也不依赖网络资源。下层 RootView 会并行完成会话恢复与运行时初始化。
struct LaunchSplashView: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.colorScheme) private var colorScheme
    let startedAt: Date

    var body: some View {
        TimelineView(.animation(minimumInterval: 1.0 / 60.0, paused: reduceMotion)) { context in
            let elapsed = reduceMotion ? 2.5 : context.date.timeIntervalSince(startedAt)
            LaunchSplashFrame(elapsed: elapsed, isDark: colorScheme == .dark)
        }
        .ignoresSafeArea()
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("正在准备你的工作现场")
        .accessibilityAddTraits(.updatesFrequently)
    }
}

private struct LaunchSplashFrame: View {
    let elapsed: TimeInterval
    let isDark: Bool

    private var ink: Color { isDark ? .white : Color(red: 32 / 255, green: 32 / 255, blue: 28 / 255) }
    private var paper: Color { isDark ? .black : .white }
    private var visualOpacity: Double { ramp(elapsed, from: 0, to: 0.28) * rampDown(elapsed, from: 3.74, to: 4.16) }
    private var ready: Bool { elapsed >= 2.86 }

    var body: some View {
        GeometryReader { proxy in
            let shortSide = min(proxy.size.width, proxy.size.height)
            let isPad = proxy.size.width >= 600
            let visualSize = isPad
                ? min(shortSide * (proxy.size.width > proxy.size.height ? 0.48 : 0.52), 500)
                : min(max(proxy.size.width * 0.74, 252), 332)
            let verticalOffset = isPad ? -proxy.size.height * 0.035 : -proxy.size.height * 0.025

            ZStack {
                paper

                VStack(spacing: isPad ? 40 : 32) {
                    LaunchSplashArtwork(
                        elapsed: elapsed,
                        ink: ink,
                        paper: paper,
                        opacity: visualOpacity
                    )
                    .frame(width: visualSize, height: visualSize)

                    VStack(spacing: 12) {
                        Text(ready ? "工作现场已就绪" : "正在准备你的工作现场")
                            .font(.system(size: isPad ? 20 : 16, weight: .semibold))
                            .tracking(-0.3)
                            .foregroundStyle(ink)

                        HStack(spacing: 6) {
                            ForEach(0..<3, id: \.self) { index in
                                Circle()
                                    .fill(ink)
                                    .frame(width: 4, height: 4)
                                    .opacity(dotOpacity(index: index))
                            }
                        }
                    }
                    .opacity(ramp(elapsed, from: 0.62, to: 1.06) * rampDown(elapsed, from: 3.82, to: 4.14))
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .offset(y: verticalOffset)
            }
        }
    }

    private func dotOpacity(index: Int) -> Double {
        let local = (elapsed - 0.82 - Double(index) * 0.11).truncatingRemainder(dividingBy: 0.66)
        guard local >= 0 else { return 0.2 }
        let pulse = 1 - abs(local / 0.66 * 2 - 1)
        return 0.2 + pulse * 0.6
    }
}

private struct LaunchSplashArtwork: View {
    let elapsed: TimeInterval
    let ink: Color
    let paper: Color
    let opacity: Double

    var body: some View {
        Canvas { context, size in
            let center = CGPoint(x: size.width / 2, y: size.height / 2)
            let unit = size.width / 360

            strokeCircle(context: &context, center: center, radius: 154 * unit, color: ink.opacity(0.16), width: 1.5)
            strokeCircle(context: &context, center: center, radius: 119 * unit, color: ink, width: 3.2)
            strokeCircle(
                context: &context,
                center: center,
                radius: 84 * unit,
                color: ink.opacity(0.34),
                width: 1.5,
                dash: [5 * unit, 6 * unit]
            )

            let spinnerOpacity = ramp(elapsed, from: 1.76, to: 2.15) * rampDown(elapsed, from: 2.78, to: 3.6)
            if spinnerOpacity > 0 {
                let rotation = spinnerRotation(elapsed)
                var spinner = Path()
                spinner.addArc(
                    center: center,
                    radius: 154 * unit,
                    startAngle: .degrees(rotation - 90),
                    endAngle: .degrees(rotation),
                    clockwise: false
                )
                context.stroke(
                    spinner,
                    with: .color(ink.opacity(spinnerOpacity)),
                    style: StrokeStyle(lineWidth: 8 * unit, lineCap: .butt)
                )
            }

            drawTin(context: &context, center: center, unit: unit)
        }
        .opacity(opacity)
    }

    private func drawTin(context: inout GraphicsContext, center: CGPoint, unit: CGFloat) {
        let enter = ramp(elapsed, from: 0.26, to: 1.02)
        let scale = 0.78 + enter * 0.22
        let floatY = elapsed >= 1.34 && elapsed <= 2.32
            ? -4 * sin((elapsed - 1.34) / 0.98 * .pi) * unit
            : 0
        let bodyWidth = 60 * unit * scale
        let bodyHeight = 44 * unit * scale
        let bodyTop = center.y - bodyHeight * 0.18 + floatY
        let bodyRect = CGRect(
            x: center.x - bodyWidth / 2,
            y: bodyTop,
            width: bodyWidth,
            height: bodyHeight
        )
        let body = Path(roundedRect: bodyRect, cornerRadius: 13 * unit * scale)
        context.fill(body, with: .color(paper))
        context.stroke(body, with: .color(ink), lineWidth: 5 * unit * scale)

        let antennaBottom = bodyRect.minY
        let antennaTop = antennaBottom - 12 * unit * scale
        var antenna = Path()
        antenna.move(to: CGPoint(x: center.x, y: antennaBottom))
        antenna.addLine(to: CGPoint(x: center.x, y: antennaTop))
        context.stroke(antenna, with: .color(ink), style: StrokeStyle(lineWidth: 5 * unit * scale, lineCap: .round))
        let knob = CGRect(
            x: center.x - 5.5 * unit * scale,
            y: antennaTop - 10.5 * unit * scale,
            width: 11 * unit * scale,
            height: 11 * unit * scale
        )
        context.fill(Path(ellipseIn: knob), with: .color(ink))

        let eyeScaleY = blinkScale(elapsed)
        let eyeY = bodyRect.minY + 22 * unit * scale
        for xOffset in [-10.0, 10.0] {
            let eyeRect = CGRect(
                x: center.x + xOffset * unit * scale - 5 * unit * scale,
                y: eyeY - 5 * unit * scale * eyeScaleY,
                width: 10 * unit * scale,
                height: 10 * unit * scale * eyeScaleY
            )
            context.fill(Path(ellipseIn: eyeRect), with: .color(ink))
        }
    }

    private func strokeCircle(
        context: inout GraphicsContext,
        center: CGPoint,
        radius: CGFloat,
        color: Color,
        width: CGFloat,
        dash: [CGFloat] = []
    ) {
        let rect = CGRect(x: center.x - radius, y: center.y - radius, width: radius * 2, height: radius * 2)
        context.stroke(
            Path(ellipseIn: rect),
            with: .color(color),
            style: StrokeStyle(lineWidth: width, dash: dash)
        )
    }
}

private func ramp(_ value: TimeInterval, from start: TimeInterval, to end: TimeInterval) -> Double {
    guard end > start else { return value >= end ? 1 : 0 }
    return min(max((value - start) / (end - start), 0), 1)
}

private func rampDown(_ value: TimeInterval, from start: TimeInterval, to end: TimeInterval) -> Double {
    1 - ramp(value, from: start, to: end)
}

private func spinnerRotation(_ elapsed: TimeInterval) -> Double {
    if elapsed <= 2.78 {
        return 220 * easeInOutCubic(ramp(elapsed, from: 1.76, to: 2.78))
    }
    return 220 + 200 * easeOutQuart(ramp(elapsed, from: 2.78, to: 3.6))
}

private func easeInOutCubic(_ progress: Double) -> Double {
    progress < 0.5
        ? 4 * progress * progress * progress
        : 1 - pow(-2 * progress + 2, 3) / 2
}

private func easeOutQuart(_ progress: Double) -> Double {
    1 - pow(1 - progress, 4)
}

private func blinkScale(_ elapsed: TimeInterval) -> Double {
    guard elapsed >= 1.98, elapsed <= 2.16 else { return 1 }
    let midpoint = 2.07
    let distance = abs(elapsed - midpoint) / 0.09
    return 0.08 + min(distance, 1) * 0.92
}
