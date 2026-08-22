/**
 * Streaming content store — zero-Zustand overhead channel for live chunk content.
 *
 * During streaming, onChunk writes here (O(1) Map.set) instead of doing an O(n)
 * updateSessionMessages().  MessageBubble reads via useSyncExternalStore.
 * On stream end, the final content is merged back into messagesBySessionId once,
 * then cleared from this store.
 *
 * 采用 per-session listener 机制：每次 chunk 只通知正在流式输出的
 * session 的订阅者，避免 100+ 个 MessageBubble 全量唤醒。
 */

import { useCallback, useSyncExternalStore } from 'react'
import { ensureClosedFences } from './markdownStreamUtils'
import { createSelectionGuard } from './selectionGuard'

interface StreamingEntry {
  messageId: string
  content: string
}

const store = new Map<string, StreamingEntry>()
const sessionListeners = new Map<string, Set<() => void>>()
const globalListeners = new Set<() => void>()

function notifySession(sessionId: string) {
  sessionListeners.get(sessionId)?.forEach(l => l())
  if (globalListeners.size > 0) globalListeners.forEach(l => l())
}

const guard = createSelectionGuard((sessionId) => {
  notifySession(sessionId)
})

// --- GC 依赖注入 ---

let _getStreamingSessions: (() => Set<string>) | null = null

/**
 * 初始化 streamingContent 的外部依赖。
 * 应在 store 初始化时调用一次，消除 GC 对 useChatStore 的动态 import。
 * ：busy 集合来自执行态单一投影（getBusySessionIds），不再依赖影子 map。
 */
export function initStreamingContent(deps: {
  getStreamingSessions: () => Set<string>
}) {
  _getStreamingSessions = deps.getStreamingSessions
}

export const streamingContent = {
  set(sessionId: string, messageId: string, content: string) {
    const safeContent = ensureClosedFences(content)
    store.set(sessionId, { messageId, content: safeContent })

    if (guard.defer(sessionId)) {
      return
    }

    notifySession(sessionId)
  },

  clear(sessionId: string) {
    guard.clearSession(sessionId)
    if (store.has(sessionId)) {
      store.delete(sessionId)
      notifySession(sessionId)
    }
  },

  clearAll() {
    guard.cleanup()
    if (store.size > 0) {
      const affectedSessions = [...store.keys()]
      store.clear()
      for (const sid of affectedSessions) {
        sessionListeners.get(sid)?.forEach(l => l())
      }
      if (globalListeners.size > 0) globalListeners.forEach(l => l())
    }
  },

  get(sessionId: string): StreamingEntry | undefined {
    return store.get(sessionId)
  },

  /** 全局订阅（兼容旧调用方） */
  subscribe(cb: () => void) {
    globalListeners.add(cb)
    return () => { globalListeners.delete(cb) }
  },

  /** per-session 订阅，只在该 session 的流式内容变化时触发 */
  subscribeSession(sessionId: string, cb: () => void) {
    let set = sessionListeners.get(sessionId)
    if (!set) {
      set = new Set()
      sessionListeners.set(sessionId, set)
    }
    set.add(cb)
    return () => {
      set!.delete(cb)
      if (set!.size === 0) sessionListeners.delete(sessionId)
    }
  },

  /**
   * 启动 GC 定时器，清理不再处于 streaming 状态的残留 entry。
   * 返回 cleanup 函数，应在组件 unmount / HMR 时调用以避免泄漏。
   *
   * 要求：调用前必须先调用 initStreamingContent 注入依赖。
   */
  startGC(intervalMs = 5 * 60_000): () => void {
    const id = setInterval(() => {
      if (store.size === 0) return
      if (!_getStreamingSessions) {
        console.warn('[streamingContent] GC skipped: initStreamingContent not called')
        return
      }
      try {
        const streamingSessions = _getStreamingSessions()
        for (const key of store.keys()) {
          if (!streamingSessions.has(key)) {
            store.delete(key)
            notifySession(key)
          }
        }
      } catch (err) {
        console.warn('[streamingContent] GC cycle skipped:', err)
      }
    }, intervalMs)
    return () => clearInterval(id)
  },
}

/**
 * React hook — returns the streaming content for a specific message,
 * or null if this message is not currently streaming.
 *
 * 使用 per-session 订阅，只有当前 session 的流式内容变化时才触发 re-render。
 * getSnapshot 返回原始类型（string | null），useSyncExternalStore 的
 * Object.is 比较可正确检测变化。
 */
export function useStreamingContent(
  sessionId: string | null,
  messageId: string,
): string | null {
  const subscribe = useCallback(
    (cb: () => void) =>
      sessionId ? streamingContent.subscribeSession(sessionId, cb) : () => {},
    [sessionId],
  )

  const getSnapshot = useCallback(() => {
    if (!sessionId) return null
    const entry = store.get(sessionId)
    return entry?.messageId === messageId ? entry.content : null
  }, [sessionId, messageId])

  return useSyncExternalStore(subscribe, getSnapshot)
}
