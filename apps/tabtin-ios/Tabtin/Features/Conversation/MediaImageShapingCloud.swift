import CoreGraphics
import Foundation

/// 点云单点（逻辑坐标系，边长 `MediaImageShapingCloud.presetSize`）。
struct ShapingDot: Equatable, Sendable {
    let x: CGFloat
    let y: CGFloat
    let r: CGFloat
}

/// 「图正在成形」点云：24 个点沿闭合曲线均匀分布，曲线在 圆 → 三角 → 方 之间循环变形。
///
/// 移植自 `packages/agent-orb/src/painter.ts` 的 `drawMorph`（`shaping` 纹理 / 64 档预设）。
/// 数值与时序逐字对齐上游，跨端一致性由 `packages/agent-orb/fixtures/morph-shaping-64.json`
/// 钉死；改这里必须同时过 `MediaImageShapingCloudTests`，否则三端会画出三个「看着差不多」的形。
enum MediaImageShapingCloud {
    /// 上游逻辑画布边长。渲染层按 实际边长 / presetSize 缩放，不改这里的数。
    static let presetSize: CGFloat = 64
    /// 预设走时倍率：`dots(t:)` 的入参是「秒 × speed」后的相位。
    static let speed: CGFloat = 2.405

    // 以下四个来自 `resolveOrbPreset('shaping', 64)` 的解析结果，勿手调——
    // 它们是 BASE_OPTS 经 count / size 系数缩放后的产物，单独改一个就和上游脱钩。
    private static let iconD: CGFloat = 0.702
    private static let rDot: CGFloat = 0.008295
    private static let rMin: CGFloat = 0.25
    private static let spread: CGFloat = 1.45

    private static let hold: CGFloat = 1.4
    private static let morphTime: CGFloat = 0.9
    private static let cycle: CGFloat = hold + morphTime
    private static let shapeCount = 3
    private static let samples = 160

    /// 恒为 24。上游 `Math.round(34 * iconD)`，与渲染层无关，暴露出来供断言与预分配。
    static let dotCount: Int = max(6, Int((34 * iconD).rounded()))

    /// 减弱动效下钉死的静帧相位。
    ///
    /// 与 Electron `driveReducedMotionFrame` 的 `0.6 × preset.speed` 同值：两端必须一致，
    /// 否则同一张卡在桌面和手机上冻在不同形状，用户会当成两个不同的状态。
    static let reducedMotionPhase: CGFloat = 0.6 * speed

    private struct Point: Sendable {
        let x: CGFloat
        let y: CGFloat
    }

    /// 闭合折线的「按弧长采样」包装：变形过程中点距始终均匀，否则角点附近会堆点。
    private struct Polyline: Sendable {
        let pts: [Point]
        let seg: [CGFloat]
        let total: CGFloat

        init(_ pts: [Point]) {
            let n = pts.count
            var seg: [CGFloat] = []
            var total: CGFloat = 0
            for i in 0..<n {
                let a = pts[i]
                let b = pts[(i + 1) % n]
                let d = hypot(b.x - a.x, b.y - a.y)
                seg.append(d)
                total += d
            }
            self.pts = pts
            self.seg = seg
            self.total = total
        }

        func point(at u: CGFloat) -> Point {
            let n = pts.count
            var want = u * total
            var i = 0
            while want > seg[i] && i < n - 1 {
                want -= seg[i]
                i += 1
            }
            let a = pts[i]
            let b = pts[(i + 1) % n]
            let f = seg[i] != 0 ? min(1, want / seg[i]) : 0
            return Point(x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f)
        }
    }

    private static let triangle = Polyline([
        Point(x: 0, y: -0.26),
        Point(x: 0.24, y: 0.16),
        Point(x: -0.24, y: 0.16),
    ])

    private static let square = Polyline([
        Point(x: 0, y: -0.2),
        Point(x: 0.2, y: -0.2),
        Point(x: 0.2, y: 0.2),
        Point(x: -0.2, y: 0.2),
        Point(x: -0.2, y: -0.2),
    ])

    private static func shapePoint(index: Int, u: CGFloat) -> Point {
        switch index {
        case 0:
            let a = -CGFloat.pi / 2 + u * 2 * .pi
            return Point(x: cos(a) * 0.24, y: sin(a) * 0.24)
        case 1:
            return triangle.point(at: u)
        default:
            return square.point(at: u)
        }
    }

    private static func smoothstep(_ x: CGFloat) -> CGFloat {
        x * x * (3 - 2 * x)
    }

    /// 一帧点云。`t` 已是「秒 × `speed`」后的相位。
    static func dots(t: CGFloat) -> [ShapingDot] {
        let span = cycle * CGFloat(shapeCount)
        // Swift 的 % 对负数返回负值、对 inf/NaN 返回 NaN；两者都会让下面的 Int(floor(...)) 陷阱式崩溃。
        // 归一到 [0, span) 后负相位继续走同一轮回，非有限输入退回轮回起点。
        var c: CGFloat = 0
        if t.isFinite {
            c = t.truncatingRemainder(dividingBy: span)
            if c < 0 { c += span }
        }
        let idx = min(shapeCount - 1, max(0, Int((c / cycle).rounded(.down))))
        let local = c - CGFloat(idx) * cycle
        let blend = local > hold ? smoothstep((local - hold) / morphTime) : 0

        let next = (idx + 1) % shapeCount
        var path: [Point] = []
        path.reserveCapacity(samples)
        for i in 0..<samples {
            let u = CGFloat(i) / CGFloat(samples)
            let a = shapePoint(index: idx, u: u)
            let b = shapePoint(index: next, u: u)
            path.append(
                Point(
                    x: (a.x + (b.x - a.x) * blend) * spread,
                    y: (a.y + (b.y - a.y) * blend) * spread
                )
            )
        }

        var seg: [CGFloat] = []
        seg.reserveCapacity(samples)
        var total: CGFloat = 0
        for i in 0..<samples {
            let a = path[i]
            let b = path[(i + 1) % samples]
            let d = hypot(b.x - a.x, b.y - a.y)
            seg.append(d)
            total += d
        }

        let breath = 1 + 0.02 * sin(local * 3.1)
        let size = presetSize
        let half = size / 2
        // 两层钳制都保留：内层是 painter 的下限，外层是 collectDots 的 rMin。
        let radius = max(rMin, max(0.35, rDot * 1.35 * spread * size))

        var out: [ShapingDot] = []
        out.reserveCapacity(dotCount)
        // cursor / walked 在整个循环里连续推进——这是沿曲线走的弧长游标，每点重置会退化成等参采样。
        var cursor = 0
        var walked: CGFloat = 0
        for i in 0..<dotCount {
            let want = (CGFloat(i) / CGFloat(dotCount)) * total
            while walked + seg[cursor] < want && cursor < samples - 1 {
                walked += seg[cursor]
                cursor += 1
            }
            let a = path[cursor]
            let b = path[(cursor + 1) % samples]
            let f = seg[cursor] != 0 ? min(1, (want - walked) / seg[cursor]) : 0
            let px = (a.x + (b.x - a.x) * f) * breath
            let py = (a.y + (b.y - a.y) * f) * breath
            out.append(ShapingDot(x: half + px * size, y: half + py * size, r: radius))
        }
        return out
    }
}
