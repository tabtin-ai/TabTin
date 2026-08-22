// ════════════════════════════════════════════════════════════════════
// W4.5 第二波 B3 · `isStreamEventId` 跨语言契约 SSOT（Swift 占位实现）
//
// Source: packages/agent-wire/src/cross-lang-validators/isStreamEventId.ts
// Fixture: packages/agent-wire/src/cross-lang-fixtures/wave45-isStreamEventId.json
//
// W5 iOS 实施 Agent 启动时：
//   import @ TabTin.Wire / 或直接 vendor in 本文件到 apps/tabtin-ios/。
//
//   **两个使用点都必须经过本 validator**（缺一不可，缺一会产生不同形态的
//   续传沉默失效）：
//
//   ① 冷启动持久化：`LastEventIdPersistence`（待 W5 实现）写
//      UserDefaults 前调本 validator —— 否则 `evt_<uuid>` 老协议 cursor
//      污染存储，下次冷启动 backend `_handle_resume` 走 replay=0 沉默
//      路径，**用户感知不到 cursor 失效**。
//   ② 运行时内存追踪：`WebSocketService.lastEventIdPerTopic`（参见
//      apps/tabtin-ios/.../WebSocket/WebSocketService.swift:57，**当前未做
//      过滤** —— W5 必须补上）写入前调本 validator —— 否则网断 30s 重连
//      `sendResume` 把 `evt_*` 当 cursor 发给 backend，backend `_handle_resume`
//      replay=0，**用户看到"网络恢复但丢一段"**。
//
//   持久化层在本 validator 之上还应做一道**语义合理性检查**（譬如 head 位
//   数 ≥ 13 验证是 ms 时间戳形态，防 `0-0`/`1-0` 这种语法合法但语义可疑
//   的极小 stream id 触发 backend XRANGE replay storm，那是
//   LastEventIdPersistence 的事，不在本契约范围）。
//
// 4 端等价规则：
//   仅当字符串严格匹配 ^[0-9]+-[0-9]+$（ASCII-only digits + 单 dash 分隔
//   + 两侧均非空）时返回 true。
//
// 实现要点：
//   - 必须用 ASCII digit set 显式枚举，**禁止用 `c.isNumber`** —— Swift
//     的 `Character.isNumber` 会接受 Unicode 数字（全角 / 阿拉伯-印度），
//     与 fixture 冲突。
//   - 用 `components(separatedBy:)` 而不是 `split(separator:omittingEmptySubsequences:)`
//     的默认行为，避免 "-" / "1-" / "-0" 这类带空段 case 漏判。
//
// 注意：本文件不是 wire-codegen 自动生成的（codegen 基于 stream-content-block.ts
// zod SSOT，本契约不是结构化数据 schema 而是函数行为契约）。属于"手写常驻
// 占位"，放在 generated/swift/ 路径以便 W5 直接 vendor in。
// ════════════════════════════════════════════════════════════════════

import Foundation

public enum StreamEventIdValidator {
    /// ASCII 0..9 字符集 —— 严格 ASCII-only，不会接受 Unicode 等价物
    /// （全角 U+FF10..U+FF19 / 阿拉伯-印度 U+0660..U+0669 等）。
    private static let asciiDigits: Set<Character> = [
        "0", "1", "2", "3", "4", "5", "6", "7", "8", "9",
    ]

    /// 判断给定字符串是否为 Redis Stream ID 形态（`<digits>-<digits>`，严格 ASCII）。
    ///
    /// 与 TS `packages/agent-wire/src/cross-lang-validators/isStreamEventId.ts`
    /// 字节级等价。所有 case 详见 wave45-isStreamEventId.json fixture。
    public static func isStreamEventId(_ id: String) -> Bool {
        guard !id.isEmpty else { return false }
        let parts = id.components(separatedBy: "-")
        guard parts.count == 2 else { return false }
        let head = parts[0]
        let tail = parts[1]
        guard !head.isEmpty, !tail.isEmpty else { return false }
        return head.allSatisfy { asciiDigits.contains($0) }
            && tail.allSatisfy { asciiDigits.contains($0) }
    }
}
