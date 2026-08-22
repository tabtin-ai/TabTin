// 「图正在成形」点云的跨端一致性校验（无需 Xcode / 模拟器 / 真机）。
//
// 用途
//   把 iOS 端的 `MediaImageShapingCloud`（纯数学，不依赖 SwiftUI / UIKit）在 macOS 上原生编译，
//   逐点比对 Electron 侧生成的基准 fixture。真机 XCTest 是正式验收；这个脚本是没接设备时的兜底，
//   也是改完 painter 想立刻知道「形对不对」的最快回路。
//
// 怎么跑（仓库根目录）
//   swiftc -O -o /tmp/tabtin-verify-shaping-cloud \
//     apps/tabtin-ios/scripts/verify-shaping-cloud.swift \
//     apps/tabtin-ios/Tabtin/Features/Conversation/MediaImageShapingCloud.swift \
//     && /tmp/tabtin-verify-shaping-cloud
//
//   可选：把 fixture 路径作为第一个参数传进来，缺省按 `#filePath` 推仓库根。
//
// fixture 从哪来
//   packages/agent-orb/fixtures/morph-shaping-64.json，由
//     node packages/agent-orb/scripts/emit-morph-fixture.mjs
//   生成。上游 painter 或 `shaping` 预设一改就重跑该脚本，再跑本校验。
//
// 退出码：0 = 全部在 1e-4 容差内；1 = 有超差点（会打印最大误差与出错的 t / 点序号）。

import Foundation

@main
struct VerifyShapingCloud {
    static let tolerance: CGFloat = 1e-4

    static func main() {
        let path = CommandLine.arguments.count > 1
            ? CommandLine.arguments[1]
            : defaultFixturePath()

        guard let data = FileManager.default.contents(atPath: path) else {
            fail("读不到 fixture：\(path)")
        }
        guard
            let root = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
            let frames = root["frames"] as? [[String: Any]]
        else {
            fail("fixture 不是预期的 JSON 结构：\(path)")
        }

        let expectedDotCount = root["dotCount"] as? Int ?? -1
        let expectedSpeed = number(root["speed"]) ?? .nan
        let expectedPresetSize = number(root["presetSize"]) ?? .nan

        print("fixture: \(path)")
        print("dotCount=\(expectedDotCount) speed=\(expectedSpeed) presetSize=\(expectedPresetSize) frames=\(frames.count)")

        var problems: [String] = []
        if expectedDotCount != MediaImageShapingCloud.dotCount {
            problems.append("dotCount 不符：fixture \(expectedDotCount) vs 实现 \(MediaImageShapingCloud.dotCount)")
        }
        if abs(expectedSpeed - MediaImageShapingCloud.speed) > 1e-9 {
            problems.append("speed 不符：fixture \(expectedSpeed) vs 实现 \(MediaImageShapingCloud.speed)")
        }
        if abs(expectedPresetSize - MediaImageShapingCloud.presetSize) > 1e-9 {
            problems.append("presetSize 不符：fixture \(expectedPresetSize) vs 实现 \(MediaImageShapingCloud.presetSize)")
        }

        var worstError: CGFloat = 0
        var worstWhere = "—"

        for frame in frames {
            let t = number(frame["t"]) ?? .nan
            let tScaled = number(frame["tScaled"]) ?? .nan
            guard let expectedDots = frame["dots"] as? [[String: Any]] else {
                problems.append("t=\(t) 缺 dots")
                continue
            }
            let dots = MediaImageShapingCloud.dots(t: tScaled)
            guard dots.count == expectedDots.count else {
                problems.append("t=\(t) 点数不符：fixture \(expectedDots.count) vs 实现 \(dots.count)")
                continue
            }
            var frameWorst: CGFloat = 0
            for (i, expected) in expectedDots.enumerated() {
                for (field, got, want) in [
                    ("x", dots[i].x, number(expected["x"]) ?? .nan),
                    ("y", dots[i].y, number(expected["y"]) ?? .nan),
                    ("r", dots[i].r, number(expected["r"]) ?? .nan),
                ] {
                    let delta = abs(got - want)
                    if delta > frameWorst { frameWorst = delta }
                    if delta > worstError {
                        worstError = delta
                        worstWhere = "t=\(t) dot[\(i)].\(field)"
                    }
                    if !(delta <= tolerance) {
                        problems.append(
                            "t=\(t) dot[\(i)].\(field) 超差：实现 \(got) vs fixture \(want)（差 \(delta)）"
                        )
                    }
                }
            }
            print(String(format: "  t=%.6g tScaled=%.6g dots=%d 最大误差=%.3e", Double(t), Double(tScaled), dots.count, Double(frameWorst)))
        }

        print(String(format: "全局最大误差 %.3e @ %@（容差 %.0e）", Double(worstError), worstWhere, Double(tolerance)))

        if problems.isEmpty {
            print("✅ 点云与 Electron 基准一致")
            exit(0)
        }
        for p in problems.prefix(20) { print("❌ \(p)") }
        if problems.count > 20 { print("… 另有 \(problems.count - 20) 条") }
        exit(1)
    }

    private static func number(_ any: Any?) -> CGFloat? {
        (any as? NSNumber).map { CGFloat($0.doubleValue) }
    }

    /// `#filePath` = <repo>/apps/tabtin-ios/scripts/verify-shaping-cloud.swift，往上三层即仓库根。
    private static func defaultFixturePath() -> String {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("packages/agent-orb/fixtures/morph-shaping-64.json")
            .path
    }

    private static func fail(_ message: String) -> Never {
        print("❌ \(message)")
        exit(1)
    }
}
