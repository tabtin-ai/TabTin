/**
 * terminalRegistry - 终端实例清理注册表
 *
 * 轻量级模块，不引入 @xterm/xterm。
 * XTerminal 创建实例时注册 dispose 回调，
 * TerminalPanePortalLayer 在需要清理时调用，无需静态导入 xterm。
 */

type DisposeFn = () => void
const disposeRegistry = new Map<string, DisposeFn>()

export function registerTerminalDispose(sessionId: string, fn: DisposeFn): void {
  disposeRegistry.set(sessionId, fn)
}

export function unregisterTerminalDispose(sessionId: string): void {
  disposeRegistry.delete(sessionId)
}

export function destroyTerminalSession(sessionId: string): void {
  const fn = disposeRegistry.get(sessionId)
  if (fn) {
    fn()
    disposeRegistry.delete(sessionId)
  }
}

/** @deprecated 使用 destroyTerminalSession 代替 */
export const disposeTerminalSession = destroyTerminalSession
