import XCTest
@testable import Tabtin

/// 「图正在成形」点云与 Electron 的跨端一致性基准。
///
/// ## 基准数字来源
///
/// 下面 `fixtureFrames` 的每个数字都从
/// `packages/agent-orb/fixtures/morph-shaping-64.json` 机械拷贝而来（六位小数原样保留）。
/// 上游 painter 或 `shaping` 预设一改就重跑
/// `node packages/agent-orb/scripts/emit-morph-fixture.mjs`，再把新数字拷进来——别手敲、别四舍五入。
/// 之所以内联而不读 bundle 资源：省掉往测试 target 塞 resource 的 pbxproj 改动，
/// 那条链路在没有模拟器时无法验证对错，改坏了也发现不了。
///
/// ## 本轮未执行
///
/// XCTest 需要模拟器或真机运行时，用户明确要求本轮不使用模拟器，所以这个文件**没有跑过**，
/// 留给将来有模拟器 / CI 的时候。等价校验本轮由
/// `apps/tabtin-ios/scripts/verify-shaping-cloud.swift` 承担——它在 macOS 上原生编译同一份
/// `MediaImageShapingCloud.swift`，直接读那份 JSON 逐点比对，容差同为 1e-4。
final class MediaImageShapingCloudTests: XCTestCase {
    private struct Dot {
        let x: CGFloat
        let y: CGFloat
        let r: CGFloat
    }

    private struct Frame {
        let t: CGFloat
        let tScaled: CGFloat
        let dots: [Dot]
    }

    private static let fixtureSpeed: CGFloat = 2.405
    private static let fixturePresetSize: CGFloat = 64
    private static let fixtureDotCount = 24

    private static let fixtureFrames: [Frame] = [
        Frame(
            t: 0,
            tScaled: 0,
            dots: [
                Dot(x: 32, y: 9.728, r: 1.039198),
                Dot(x: 37.763446, y: 10.49059, r: 1.039198),
                Dot(x: 43.134078, y: 12.715179, r: 1.039198),
                Dot(x: 47.748682, y: 16.251318, r: 1.039198),
                Dot(x: 51.284821, y: 20.865922, r: 1.039198),
                Dot(x: 53.50941, y: 26.236554, r: 1.039198),
                Dot(x: 54.272, y: 32, r: 1.039198),
                Dot(x: 53.50941, y: 37.763446, r: 1.039198),
                Dot(x: 51.284821, y: 43.134078, r: 1.039198),
                Dot(x: 47.748682, y: 47.748682, r: 1.039198),
                Dot(x: 43.134078, y: 51.284821, r: 1.039198),
                Dot(x: 37.763446, y: 53.50941, r: 1.039198),
                Dot(x: 32, y: 54.272, r: 1.039198),
                Dot(x: 26.236554, y: 53.50941, r: 1.039198),
                Dot(x: 20.865922, y: 51.284821, r: 1.039198),
                Dot(x: 16.251318, y: 47.748682, r: 1.039198),
                Dot(x: 12.715179, y: 43.134078, r: 1.039198),
                Dot(x: 10.49059, y: 37.763446, r: 1.039198),
                Dot(x: 9.728, y: 32, r: 1.039198),
                Dot(x: 10.49059, y: 26.236554, r: 1.039198),
                Dot(x: 12.715179, y: 20.865922, r: 1.039198),
                Dot(x: 16.251318, y: 16.251318, r: 1.039198),
                Dot(x: 20.865922, y: 12.715179, r: 1.039198),
                Dot(x: 26.236554, y: 10.49059, r: 1.039198),
            ]
        ),
        Frame(
            t: 1.443,
            tScaled: 3.470415,
            dots: [
                Dot(x: 32, y: 8.097696, r: 1.039198),
                Dot(x: 34.733819, y: 12.881879, r: 1.039198),
                Dot(x: 37.467637, y: 17.666061, r: 1.039198),
                Dot(x: 40.201456, y: 22.450244, r: 1.039198),
                Dot(x: 42.935274, y: 27.234426, r: 1.039198),
                Dot(x: 45.669093, y: 32.018609, r: 1.039198),
                Dot(x: 48.402911, y: 36.802791, r: 1.039198),
                Dot(x: 51.13673, y: 41.586974, r: 1.039198),
                Dot(x: 53.86789, y: 46.371015, r: 1.039198),
                Dot(x: 48.530562, y: 46.70911, r: 1.039198),
                Dot(x: 43.020375, y: 46.70911, r: 1.039198),
                Dot(x: 37.510187, y: 46.70911, r: 1.039198),
                Dot(x: 32, y: 46.70911, r: 1.039198),
                Dot(x: 26.489813, y: 46.70911, r: 1.039198),
                Dot(x: 20.979625, y: 46.70911, r: 1.039198),
                Dot(x: 15.469438, y: 46.70911, r: 1.039198),
                Dot(x: 10.13211, y: 46.371015, r: 1.039198),
                Dot(x: 12.86327, y: 41.586974, r: 1.039198),
                Dot(x: 15.597089, y: 36.802791, r: 1.039198),
                Dot(x: 18.330907, y: 32.018609, r: 1.039198),
                Dot(x: 21.064726, y: 27.234426, r: 1.039198),
                Dot(x: 23.798544, y: 22.450244, r: 1.039198),
                Dot(x: 26.532363, y: 17.666061, r: 1.039198),
                Dot(x: 29.266181, y: 12.881879, r: 1.039198),
            ]
        ),
        Frame(
            t: 1.9,
            tScaled: 4.5695,
            dots: [
                Dot(x: 32, y: 13.167355, r: 1.039198),
                Dot(x: 38.264169, y: 13.183955, r: 1.039198),
                Dot(x: 44.528339, y: 13.200555, r: 1.039198),
                Dot(x: 50.778741, y: 13.230907, r: 1.039198),
                Dot(x: 50.788216, y: 19.495091, r: 1.039198),
                Dot(x: 50.797691, y: 25.759275, r: 1.039198),
                Dot(x: 50.807166, y: 32.023459, r: 1.039198),
                Dot(x: 50.816641, y: 38.287643, r: 1.039198),
                Dot(x: 50.825357, y: 44.551828, r: 1.039198),
                Dot(x: 50.792574, y: 50.800968, r: 1.039198),
                Dot(x: 44.528383, y: 50.800968, r: 1.039198),
                Dot(x: 38.264191, y: 50.800968, r: 1.039198),
                Dot(x: 32, y: 50.800968, r: 1.039198),
                Dot(x: 25.735809, y: 50.800968, r: 1.039198),
                Dot(x: 19.471617, y: 50.800968, r: 1.039198),
                Dot(x: 13.207426, y: 50.800968, r: 1.039198),
                Dot(x: 13.174643, y: 44.551828, r: 1.039198),
                Dot(x: 13.183359, y: 38.287643, r: 1.039198),
                Dot(x: 13.192834, y: 32.023459, r: 1.039198),
                Dot(x: 13.202309, y: 25.759275, r: 1.039198),
                Dot(x: 13.211784, y: 19.495091, r: 1.039198),
                Dot(x: 13.221259, y: 13.230907, r: 1.039198),
                Dot(x: 19.471661, y: 13.200555, r: 1.039198),
                Dot(x: 25.735831, y: 13.183955, r: 1.039198),
            ]
        ),
        Frame(
            t: 2.3,
            tScaled: 5.5315,
            dots: [
                Dot(x: 32, y: 13.346746, r: 1.039198),
                Dot(x: 38.217751, y: 13.346746, r: 1.039198),
                Dot(x: 44.435502, y: 13.346746, r: 1.039198),
                Dot(x: 50.653254, y: 13.346746, r: 1.039198),
                Dot(x: 50.653254, y: 19.564498, r: 1.039198),
                Dot(x: 50.653254, y: 25.782249, r: 1.039198),
                Dot(x: 50.653254, y: 32, r: 1.039198),
                Dot(x: 50.653254, y: 38.217751, r: 1.039198),
                Dot(x: 50.653254, y: 44.435502, r: 1.039198),
                Dot(x: 50.653254, y: 50.653254, r: 1.039198),
                Dot(x: 44.435502, y: 50.653254, r: 1.039198),
                Dot(x: 38.217751, y: 50.653254, r: 1.039198),
                Dot(x: 32, y: 50.653254, r: 1.039198),
                Dot(x: 25.782249, y: 50.653254, r: 1.039198),
                Dot(x: 19.564498, y: 50.653254, r: 1.039198),
                Dot(x: 13.346746, y: 50.653254, r: 1.039198),
                Dot(x: 13.346746, y: 44.435502, r: 1.039198),
                Dot(x: 13.346746, y: 38.217751, r: 1.039198),
                Dot(x: 13.346746, y: 32, r: 1.039198),
                Dot(x: 13.346746, y: 25.782249, r: 1.039198),
                Dot(x: 13.346746, y: 19.564498, r: 1.039198),
                Dot(x: 13.346746, y: 13.346746, r: 1.039198),
                Dot(x: 19.564498, y: 13.346746, r: 1.039198),
                Dot(x: 25.782249, y: 13.346746, r: 1.039198),
            ]
        ),
        Frame(
            t: 4.6,
            tScaled: 11.063,
            dots: [
                Dot(x: 32, y: 10.983038, r: 1.039198),
                Dot(x: 36.832847, y: 13.448967, r: 1.039198),
                Dot(x: 41.665694, y: 15.914897, r: 1.039198),
                Dot(x: 45.785883, y: 18.941859, r: 1.039198),
                Dot(x: 47.048329, y: 24.218548, r: 1.039198),
                Dot(x: 48.310775, y: 29.495237, r: 1.039198),
                Dot(x: 49.573221, y: 34.771926, r: 1.039198),
                Dot(x: 50.835667, y: 40.048615, r: 1.039198),
                Dot(x: 52.003699, y: 45.327848, r: 1.039198),
                Dot(x: 48.276823, y: 48.621149, r: 1.039198),
                Dot(x: 42.851215, y: 48.621149, r: 1.039198),
                Dot(x: 37.425608, y: 48.621149, r: 1.039198),
                Dot(x: 32, y: 48.621149, r: 1.039198),
                Dot(x: 26.574392, y: 48.621149, r: 1.039198),
                Dot(x: 21.148785, y: 48.621149, r: 1.039198),
                Dot(x: 15.723177, y: 48.621149, r: 1.039198),
                Dot(x: 11.996301, y: 45.327848, r: 1.039198),
                Dot(x: 13.164333, y: 40.048615, r: 1.039198),
                Dot(x: 14.426779, y: 34.771926, r: 1.039198),
                Dot(x: 15.689225, y: 29.495237, r: 1.039198),
                Dot(x: 16.951671, y: 24.218548, r: 1.039198),
                Dot(x: 18.214117, y: 18.941859, r: 1.039198),
                Dot(x: 22.334306, y: 15.914897, r: 1.039198),
                Dot(x: 27.167153, y: 13.448967, r: 1.039198),
            ]
        ),
        Frame(
            t: 6.9,
            tScaled: 16.5945,
            dots: [
                Dot(x: 32, y: 7.389786, r: 1.039198),
                Dot(x: 34.814786, y: 12.31566, r: 1.039198),
                Dot(x: 37.629571, y: 17.241535, r: 1.039198),
                Dot(x: 40.444357, y: 22.16741, r: 1.039198),
                Dot(x: 43.259143, y: 27.093285, r: 1.039198),
                Dot(x: 46.073928, y: 32.01916, r: 1.039198),
                Dot(x: 48.888714, y: 36.945035, r: 1.039198),
                Dot(x: 51.7035, y: 41.87091, r: 1.039198),
                Dot(x: 54.515548, y: 46.796639, r: 1.039198),
                Dot(x: 49.020146, y: 47.144747, r: 1.039198),
                Dot(x: 43.346764, y: 47.144747, r: 1.039198),
                Dot(x: 37.673382, y: 47.144747, r: 1.039198),
                Dot(x: 32, y: 47.144747, r: 1.039198),
                Dot(x: 26.326618, y: 47.144747, r: 1.039198),
                Dot(x: 20.653236, y: 47.144747, r: 1.039198),
                Dot(x: 14.979854, y: 47.144747, r: 1.039198),
                Dot(x: 9.484452, y: 46.796639, r: 1.039198),
                Dot(x: 12.2965, y: 41.87091, r: 1.039198),
                Dot(x: 15.111286, y: 36.945035, r: 1.039198),
                Dot(x: 17.926072, y: 32.01916, r: 1.039198),
                Dot(x: 20.740857, y: 27.093285, r: 1.039198),
                Dot(x: 23.555643, y: 22.16741, r: 1.039198),
                Dot(x: 26.370429, y: 17.241535, r: 1.039198),
                Dot(x: 29.185214, y: 12.31566, r: 1.039198),
            ]
        ),
    ]

    func testMatchesCrossPlatformFixture() {
        XCTAssertEqual(Self.fixturePresetSize, MediaImageShapingCloud.presetSize)
        XCTAssertEqual(Self.fixtureSpeed, MediaImageShapingCloud.speed, accuracy: 1e-9)
        XCTAssertEqual(Self.fixtureDotCount, MediaImageShapingCloud.dotCount)
        XCTAssertEqual(Self.fixtureFrames.count, 6)

        for frame in Self.fixtureFrames {
            let dots = MediaImageShapingCloud.dots(t: frame.tScaled)
            XCTAssertEqual(dots.count, frame.dots.count, "t=\(frame.t) 点数不符")
            for (i, expected) in frame.dots.enumerated() {
                XCTAssertEqual(dots[i].x, expected.x, accuracy: 1e-4, "t=\(frame.t) dot[\(i)].x")
                XCTAssertEqual(dots[i].y, expected.y, accuracy: 1e-4, "t=\(frame.t) dot[\(i)].y")
                XCTAssertEqual(dots[i].r, expected.r, accuracy: 1e-4, "t=\(frame.t) dot[\(i)].r")
            }
        }
    }

    /// 相位映射：`tScaled` 必须等于 `t × speed`，否则渲染层按「秒 × speed」传入会错相位。
    func testFixtureScaledPhaseMatchesSpeed() {
        for frame in Self.fixtureFrames {
            XCTAssertEqual(
                frame.tScaled,
                frame.t * MediaImageShapingCloud.speed,
                accuracy: 1e-6,
                "t=\(frame.t)"
            )
        }
    }

    func testDotCountIsStableAcrossPhase() {
        XCTAssertEqual(MediaImageShapingCloud.dotCount, 24)
        for step in 0...200 {
            let t = CGFloat(step) * 0.0345
            XCTAssertEqual(MediaImageShapingCloud.dots(t: t).count, 24, "t=\(t)")
        }
    }

    /// 减弱动效钉的静帧相位（Electron `driveReducedMotionFrame` 的 0.6 × speed）。
    func testReducedMotionPhaseMatchesElectron() {
        XCTAssertEqual(MediaImageShapingCloud.reducedMotionPhase, 1.443, accuracy: 1e-9)
        let a = MediaImageShapingCloud.dots(t: MediaImageShapingCloud.reducedMotionPhase)
        let b = MediaImageShapingCloud.dots(t: MediaImageShapingCloud.reducedMotionPhase)
        XCTAssertEqual(a, b)
        XCTAssertEqual(a.count, 24)
    }

    /// 负相位与极端输入不得崩、不得产出 NaN——TimelineView 的 date 早于锚点时会传负值。
    func testExtremePhasesStayFinite() {
        let phases: [CGFloat] = [
            -0.001, -1.443, -6.9, -12345.678,
            0, 6.9, 1e6, 1e15,
            .infinity, -.infinity, .nan,
        ]
        for t in phases {
            let dots = MediaImageShapingCloud.dots(t: t)
            XCTAssertEqual(dots.count, 24, "t=\(t)")
            for (i, dot) in dots.enumerated() {
                XCTAssertTrue(dot.x.isFinite, "t=\(t) dot[\(i)].x")
                XCTAssertTrue(dot.y.isFinite, "t=\(t) dot[\(i)].y")
                XCTAssertTrue(dot.r.isFinite, "t=\(t) dot[\(i)].r")
                XCTAssertGreaterThan(dot.r, 0, "t=\(t) dot[\(i)].r")
            }
        }
    }

    /// 一整轮后相位回到起点，取模不漂。
    /// 轮回长度 6.9 = 3 × CYCLE，单位是**相位**而非秒——`dots(t:)` 收的就是已乘过 speed 的相位。
    func testPhaseWrapsAfterFullCycle() {
        let span: CGFloat = 6.9
        let base = MediaImageShapingCloud.dots(t: 0.7)
        let wrapped = MediaImageShapingCloud.dots(t: 0.7 + span)
        for (i, dot) in base.enumerated() {
            XCTAssertEqual(dot.x, wrapped[i].x, accuracy: 1e-6, "dot[\(i)].x")
            XCTAssertEqual(dot.y, wrapped[i].y, accuracy: 1e-6, "dot[\(i)].y")
        }
    }
}
