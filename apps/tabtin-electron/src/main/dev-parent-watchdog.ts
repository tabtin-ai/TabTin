/**
 * Dev 模式父进程 watchdog
 *
 * 解决的问题：
 * `electron-vite dev` 的进程结构是「electron-vite (node 父) ──spawn──> electron (子)」。
 * 父进程退出时（被 vite-plugin-checker 整死、Ctrl-C 没传到子进程、import 期 fatal
 * 等）并不会 kill 子进程——electron 主进程会变成孤儿继续跑，但 vite dev server 已经
 * 没了，renderer 加载 `http://localhost:5175/` 一直 ERR_CONNECTION_REFUSED 白屏。
 *
 * 用户 ⌘Q 想退又会触发 `exit-guard` 给 renderer 发 IPC——renderer 没 JS 没 handler
 * → 必然等满 30s 弹原生 fallback。形成"开发体验灾难"。
 *
 * 本模块只在 dev 模式启用：
 * - 启动时记下 `process.ppid`
 * - 每 `intervalMs`（默认 2000ms）用 `process.kill(ppid, 0)` 探活
 *   （信号 0 只查 PID 存在性，不实际发信号）
 * - 父进程不存在 → 调 `app.exit(0)` **绕过 before-quit / exit-guard** 立即退出
 *
 * 为什么用 `app.exit(0)` 而不是 `app.quit()`：
 *   `app.quit()` 会触发 `before-quit` → `exit-guard.ask` → IPC 发给 renderer →
 *   renderer 已废 → 等 30s 弹 fallback。本末倒置。
 *   dev 模式下父进程消失意味着 renderer 100% 不可用，强制退出是正确选择，
 *   PTY / CLI sock 等 cleanup 跳过可接受（重启 dev 即可）。
 *
 * 不在 production 启用：
 *   prod 模式 main 进程的 parent 是 Finder / launchctl / 用户 shell，杀那个父进程
 *   不该意味着退应用。
 *
 * 跨平台：`process.kill(pid, 0)` 在 Linux / macOS / Windows 上行为一致——存在返回
 * true，不存在抛 ESRCH。
 *
 * 已知 corner case（不防）：
 *   父进程刚死、PID 立刻被新进程复用——短窗口概率极低，dev 体验不防。
 */

export interface DevParentWatchdogLogger {
  info: (...args: unknown[]) => void
  warn: (...args: unknown[]) => void
}

export interface DevParentWatchdogOptions {
  log: DevParentWatchdogLogger
  /** 探活间隔；默认 2000ms */
  intervalMs?: number
  /** 父进程 PID 提供方；测试注入用，默认 `process.ppid` */
  getParentPid?: () => number | undefined
  /** PID 存在性检查；默认走 `process.kill(pid, 0)` */
  isProcessAlive?: (pid: number) => boolean
  /** 触发退出；默认走 `app.exit(0)`，测试可注入 spy */
  exitProcess?: () => void
  /** 计时器调度；测试可注入 fake timer */
  setInterval?: (handler: () => void, ms: number) => ReturnType<typeof setInterval>
  clearInterval?: (handle: ReturnType<typeof setInterval>) => void
}

const DEFAULT_INTERVAL_MS = 2_000

/**
 * 默认 PID 存活探测：`process.kill(pid, 0)`。
 * 不要直接内联——测试要注入替换。
 */
const defaultIsProcessAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * 启动 dev parent watchdog。
 * 返回一个 dispose 函数，调用后停止探活（生产 / 无父进程 / ppid=1 等情况下 dispose 是 no-op）。
 */
export function startDevParentWatchdog(options: DevParentWatchdogOptions): () => void {
  const log = options.log
  const getParentPid = options.getParentPid ?? (() => process.ppid)
  const isAlive = options.isProcessAlive ?? defaultIsProcessAlive
  const exitProcess = options.exitProcess ?? (() => {
    // 在生产代码里默认走 app.exit；为避免顶层 import electron 影响测试，
    // 这里惰性 require，并降级到 process.exit（虽然 dev 场景不该走到这）。
    try {
      const electron = require('electron') as { app?: { exit?: (code: number) => void } }
      if (electron.app?.exit) {
        electron.app.exit(0)
        return
      }
    } catch {
      // ignore
    }
    process.exit(0)
  })
  const setIntervalFn = options.setInterval ?? setInterval
  const clearIntervalFn = options.clearInterval ?? clearInterval
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS

  const ppid = getParentPid()
  if (!ppid) {
    log.info(`[dev-watchdog] 跳过（ppid=${ppid ?? 'undefined'}）`)
    return () => {}
  }
  // dev Electron 一旦被 init/launchd 接管，说明启动链路已经断开。
  // 此时继续留着只会在 Dock 里堆出旧图标，直接退出更符合 dev 预期。
  if (ppid <= 1) {
    log.warn(`[dev-watchdog] 父进程已是 init/launchd（ppid=${ppid}），立即退出 main 进程`)
    exitProcess()
    return () => {}
  }

  log.info(`[dev-watchdog] 已启动（ppid=${ppid}, intervalMs=${intervalMs}）`)
  const handle = setIntervalFn(() => {
    if (isAlive(ppid)) return
    log.warn(`[dev-watchdog] 父进程已消失（ppid=${ppid}），立即退出 main 进程`)
    clearIntervalFn(handle)
    exitProcess()
  }, intervalMs)

  // node Timer.unref：watchdog 不应阻塞进程退出（万一别的路径退出，让事件循环空了能正常结束）
  if (typeof handle === 'object' && handle && 'unref' in handle && typeof handle.unref === 'function') {
    handle.unref()
  }

  return () => clearIntervalFn(handle)
}
