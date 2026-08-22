/**
 * Runtime 日志缓冲共享类型（BR-8 WS-B）。
 *
 * ⚠️ electron-free / 零副作用：本目录只声明数据结构 + 纯缓冲逻辑，
 * 不 import 任何运行时（不碰 electron / playwright / 两端 route），
 * 可被 Electron / Daemon 两端的 BrowserContext 实现共同喂数据。
 */

/**
 * 双端统一的 CDP 事件形状，与 `BrowserContext.onCDPEvent(handler)` 的
 * handler 入参完全一致——Electron（WebContents debugger）与 Daemon
 * （Playwright CDPSession）发来的事件都归一成这个形状，于是同一份缓冲
 * 逻辑两端通用（P3 Electron 收编到同缓冲时无需改动本模块）。
 */
export interface CDPLogEvent {
  method: string;
  params: Record<string, unknown>;
}

/** record 时可携带的可选上下文（如关联的 run 会话 id）。 */
export interface RuntimeLogContext {
  runId?: string;
}
