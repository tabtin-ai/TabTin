import Foundation
import os

#if DEBUG
import QuartzCore

/// 性能度量基建（仅 DEBUG）。重构 §6/§11「Phase 2 性能门禁」三条基线指标的统一采集点：
///
///   1. **冷启动 → 可交互**（cold-start-to-interactive）：`markColdStart()` → `markInteractive(_:)`。
///   2. **首 token 时间（TTFT）**：本机发送 `markTurnSent()` → 首个可见 token `markFirstToken()`。
///   3. **流式期间主线程最大 stall + stall 次数**：`beginStreamWindow()`/`endStreamWindow()` 划定一轮
///      流式区间，看门狗在窗口内累计最大阻塞时长与次数，收尾打印汇总。
///
/// 设计取向（对齐旧项目 PerfTrace 口径，并修掉新项目原 Timer 版的数据竞争）：
/// - `mark(_:)` 打点（绝对时间 + 距上点 Δ），定位交互卡顿节点。
/// - **后台队列看门狗**：每 `interval` 派空任务到主线程测往返延迟（≈ 主线程当时被阻塞时长），
///   超 `threshold` 打印 STALL。比「主线程 Timer 比对 gap」更准，且无 `@Sendable` 捕获可变量的数据竞争。
/// - `OSSignposter` 区间/事件：供 Instruments 在**真机**上做 fps（Animation Hitches）/ 火焰图深挖
///   （滚动 60fps 门禁仍需真机 Instruments，看门狗只能给主线程 stall，给不了渲染帧率）。
///
/// 所有可变状态受 `lock` 保护，跨「主线程打点」与「后台看门狗」两侧访问安全，故 `nonisolated(unsafe)`。
enum PerfTrace {
    private static let logger = Logger(subsystem: "com.tabtin.mobile", category: "perf")
    private static let signposter = OSSignposter(subsystem: "com.tabtin.mobile", category: "perf")
    private static let lock = NSLock()

    // MARK: - 打点

    nonisolated(unsafe) private static var lastMarkAt: CFTimeInterval = 0

    /// 在关键交互节点打点，打印绝对时间戳 + 距上一个点的间隔（ms）。
    static func mark(_ label: String) {
        let now = CACurrentMediaTime()
        lock.lock()
        let delta = lastMarkAt == 0 ? 0 : (now - lastMarkAt) * 1000
        lastMarkAt = now
        lock.unlock()
        logger.log("[PERF] \(label, privacy: .public) (Δ\(Int(delta))ms)")
    }

    // MARK: - 冷启动 → 可交互

    nonisolated(unsafe) private static var coldStartAt: CFTimeInterval = 0
    nonisolated(unsafe) private static var interactiveReported = false

    /// App 进程入口最早处调用（`TabtinApp.init` 首行），记录冷启动基准时刻。
    static func markColdStart() {
        lock.lock(); coldStartAt = CACurrentMediaTime(); interactiveReported = false; lock.unlock()
    }

    /// 首个可交互界面渲染时调用（如主 Tab 首次 onAppear），仅报一次。
    static func markInteractive(_ label: String = "interactive") {
        let now = CACurrentMediaTime()
        lock.lock()
        defer { lock.unlock() }
        guard coldStartAt > 0, !interactiveReported else { return }
        interactiveReported = true
        let ms = Int((now - coldStartAt) * 1000)
        signposter.emitEvent("ColdStartToInteractive")
        logger.log("[PERF][COLD] cold-start → \(label, privacy: .public): \(ms)ms")
    }

    // MARK: - TTFT（首 token 时间）

    /// pendingSentAt > 0 且未上报 ⇒ 等待本机这轮的首 token。观测别端轮次不会调 `markTurnSent`，
    /// 故不会误报；纯净基线测量请在空闲会话里单独发一条（排队并发场景的 TTFT 不保证精确，见类注释）。
    nonisolated(unsafe) private static var pendingSentAt: CFTimeInterval = 0
    nonisolated(unsafe) private static var ttftReported = false

    /// 本机发送一轮时调用（`send()`）：记发送时刻，重置「首 token 未上报」。
    static func markTurnSent() {
        lock.lock(); pendingSentAt = CACurrentMediaTime(); ttftReported = false; lock.unlock()
    }

    /// 收到本轮首个可见 token（首个 appendText / thinking）时调用，幂等：仅本机发送后第一次有效。
    static func markFirstToken() {
        let now = CACurrentMediaTime()
        lock.lock()
        defer { lock.unlock() }
        guard pendingSentAt > 0, !ttftReported else { return }
        ttftReported = true
        let ms = Int((now - pendingSentAt) * 1000)
        signposter.emitEvent("TTFT")
        logger.log("[PERF][TTFT] send → first token: \(ms)ms")
    }

    // MARK: - 流式窗口（主线程 maxStall + stall 次数）

    private struct StreamWindow {
        let startedAt: CFTimeInterval
        var maxStallMs: Int = 0
        var stallCount: Int = 0
    }

    nonisolated(unsafe) private static var window: StreamWindow?
    nonisolated(unsafe) private static var windowSignpost: OSSignpostIntervalState?

    /// 一轮流式开始（首个 delta，`isStreamingActive` 0→1）时调用。重复调用忽略。
    static func beginStreamWindow() {
        lock.lock()
        defer { lock.unlock() }
        guard window == nil else { return }
        window = StreamWindow(startedAt: CACurrentMediaTime())
        windowSignpost = signposter.beginInterval("StreamWindow")
    }

    /// 一轮流式收尾（`done`/`error`）时调用，打印 TTFT 之外的两条窗口指标。
    static func endStreamWindow() {
        lock.lock()
        let win = window
        let token = windowSignpost
        window = nil
        windowSignpost = nil
        lock.unlock()
        guard let win else { return }
        if let token { signposter.endInterval("StreamWindow", token) }
        let durMs = Int((CACurrentMediaTime() - win.startedAt) * 1000)
        logger.log("[PERF][STREAM] duration=\(durMs)ms maxStall=\(win.maxStallMs)ms stalls=\(win.stallCount)")
    }

    /// 看门狗回灌：把一次主线程阻塞计入当前流式窗口（若有）。
    private static func recordStall(_ ms: Int) {
        lock.lock()
        defer { lock.unlock() }
        guard window != nil else { return }
        window!.stallCount += 1
        window!.maxStallMs = max(window!.maxStallMs, ms)
    }

    // MARK: - 主线程看门狗

    /// 后台队列每 `interval` 秒派空任务到主线程测往返延迟；≥ `threshold` 打印 STALL 并计入流式窗口。
    static func installMainThreadWatchdog(
        interval: TimeInterval = 0.1,
        threshold: TimeInterval = 0.25
    ) {
        let queue = DispatchQueue(label: "com.tabtin.perf.watchdog", qos: .utility)
        func schedule() {
            queue.asyncAfter(deadline: .now() + interval) {
                let dispatchedAt = CACurrentMediaTime()
                DispatchQueue.main.async {
                    let waitedMs = Int((CACurrentMediaTime() - dispatchedAt) * 1000)
                    if waitedMs >= Int(threshold * 1000) {
                        logger.warning("[PERF][STALL] main thread blocked for \(waitedMs)ms")
                        recordStall(waitedMs)
                    }
                    schedule()
                }
            }
        }
        schedule()
        logger.log("[PERF] main-thread watchdog started (threshold=\(Int(threshold * 1000))ms)")
    }
}

#else
/// Release：全部 no-op，零开销（`@inline(__always)`）。
enum PerfTrace {
    @inline(__always) static func mark(_ label: String) {}
    @inline(__always) static func markColdStart() {}
    @inline(__always) static func markInteractive(_ label: String = "interactive") {}
    @inline(__always) static func markTurnSent() {}
    @inline(__always) static func markFirstToken() {}
    @inline(__always) static func beginStreamWindow() {}
    @inline(__always) static func endStreamWindow() {}
    @inline(__always) static func installMainThreadWatchdog(
        interval: TimeInterval = 0.1,
        threshold: TimeInterval = 0.25
    ) {}
}
#endif
