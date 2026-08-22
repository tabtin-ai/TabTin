/**
 * 视图导航事件总线
 *
 * 解决各 store 之间的循环依赖。store 不直接互相 import，
 * 而是通过订阅回调在运行时打通。
 */

type NavigationTarget = 'im' | 'space' | 'settings'

type NavigationListener = (target: NavigationTarget) => void

const listeners = new Set<NavigationListener>()

export function onNavigate(listener: NavigationListener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function emitNavigate(target: NavigationTarget) {
  listeners.forEach((fn) => {
    try { fn(target) } catch { /* 防止单个 listener 异常阻塞其他 */ }
  })
}

export type { NavigationTarget, NavigationListener }
