/**
 * Unit tests for `apps/tabtin-electron/src/preload/auth-token-dedup.ts`
 *
 * 验收：
 *   1. in-flight Promise dedup —— 并发调用只触发一次底层 IPC
 *   2. 短 TTL cache —— 短窗口内重复调用复用缓存（不再调 IPC）
 *   3. TTL 过后再次调用会发新 IPC
 *   4. `auth:token-refreshed-signal` 失效缓存
 *   5. `auth:force-logout` 失效缓存
 *   6. IPC 失败不缓存（下次重试）
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ── Hoisted mock state ─────────────────────────────────────────────────
const { ipcMockState } = vi.hoisted(() => ({
  ipcMockState: {
    invokeHandler: null as ((channel: string, ...args: unknown[]) => unknown | Promise<unknown>) | null,
    invokeCallCount: 0 as number,
    onListeners: new Map<string, Array<(...args: unknown[]) => void>>(),
  },
}))

vi.mock('electron', () => ({
  ipcRenderer: {
    invoke: async (channel: string, ...args: unknown[]) => {
      ipcMockState.invokeCallCount += 1
      if (!ipcMockState.invokeHandler) {
        throw new Error(`[test] No invokeHandler set for "${channel}"`)
      }
      return ipcMockState.invokeHandler(channel, ...args)
    },
    send: () => {},
    on: (channel: string, listener: (...args: unknown[]) => void) => {
      const list = ipcMockState.onListeners.get(channel) ?? []
      list.push(listener)
      ipcMockState.onListeners.set(channel, list)
    },
    removeListener: (channel: string, listener: (...args: unknown[]) => void) => {
      const list = ipcMockState.onListeners.get(channel)
      if (!list) return
      const idx = list.indexOf(listener)
      if (idx >= 0) list.splice(idx, 1)
    },
  },
}))

import {
  __testing,
  getAccessTokenDeduped,
  installAuthTokenInvalidationListeners,
} from '../auth-token-dedup'

function emit(channel: string, ...args: unknown[]): void {
  const list = ipcMockState.onListeners.get(channel) ?? []
  for (const listener of [...list]) listener(...args)
}

beforeEach(() => {
  __testing.reset()
  ipcMockState.invokeHandler = null
  ipcMockState.invokeCallCount = 0
  ipcMockState.onListeners.clear()
})

afterEach(() => {
  __testing.reset()
})

describe('getAccessTokenDeduped', () => {
  it('并发调用复用同一个 inflight Promise，只触发一次 IPC', async () => {
    ipcMockState.invokeHandler = async () => ({ success: true, token: 'tok-A' })

    const [r1, r2, r3, r4, r5] = await Promise.all([
      getAccessTokenDeduped(),
      getAccessTokenDeduped(),
      getAccessTokenDeduped(),
      getAccessTokenDeduped(),
      getAccessTokenDeduped(),
    ])

    expect(ipcMockState.invokeCallCount).toBe(1)
    expect(r1).toEqual({ success: true, token: 'tok-A' })
    expect(r1).toBe(r2)
    expect(r1).toBe(r3)
    expect(r1).toBe(r4)
    expect(r1).toBe(r5)
  })

  it('短 TTL 内串行重复调用直接命中缓存（不发新 IPC）', async () => {
    ipcMockState.invokeHandler = async () => ({ success: true, token: 'tok-B' })

    const r1 = await getAccessTokenDeduped()
    expect(ipcMockState.invokeCallCount).toBe(1)

    const r2 = await getAccessTokenDeduped()
    expect(ipcMockState.invokeCallCount).toBe(1)

    const r3 = await getAccessTokenDeduped()
    expect(ipcMockState.invokeCallCount).toBe(1)

    expect(r1).toEqual({ success: true, token: 'tok-B' })
    expect(r2).toBe(r1)
    expect(r3).toBe(r1)
  })

  it('TTL 过后会发起新 IPC', async () => {
    let nextToken = 'tok-1'
    ipcMockState.invokeHandler = async () => ({ success: true, token: nextToken })

    vi.useFakeTimers()
    try {
      const r1 = await getAccessTokenDeduped()
      expect(ipcMockState.invokeCallCount).toBe(1)
      expect(r1.token).toBe('tok-1')

      // 推进过 TTL
      vi.setSystemTime(Date.now() + __testing.TTL_MS + 10)

      nextToken = 'tok-2'
      const r2 = await getAccessTokenDeduped()
      expect(ipcMockState.invokeCallCount).toBe(2)
      expect(r2.token).toBe('tok-2')
    } finally {
      vi.useRealTimers()
    }
  })

  it('`auth:token-refreshed-signal` 立即失效缓存', async () => {
    ipcMockState.invokeHandler = async () => ({ success: true, token: 'tok-C' })
    installAuthTokenInvalidationListeners()

    const r1 = await getAccessTokenDeduped()
    expect(ipcMockState.invokeCallCount).toBe(1)
    expect(r1.token).toBe('tok-C')

    // 模拟主进程广播 token 已刷新
    emit('auth:token-refreshed-signal')

    // 缓存失效后下一次调用要重新发 IPC
    ipcMockState.invokeHandler = async () => ({ success: true, token: 'tok-D' })
    const r2 = await getAccessTokenDeduped()
    expect(ipcMockState.invokeCallCount).toBe(2)
    expect(r2.token).toBe('tok-D')
  })

  it('`auth:force-logout` 立即失效缓存', async () => {
    ipcMockState.invokeHandler = async () => ({ success: true, token: 'tok-E' })
    installAuthTokenInvalidationListeners()

    await getAccessTokenDeduped()
    expect(ipcMockState.invokeCallCount).toBe(1)

    emit('auth:force-logout')

    ipcMockState.invokeHandler = async () => ({ success: true, token: null })
    const r2 = await getAccessTokenDeduped()
    expect(ipcMockState.invokeCallCount).toBe(2)
    expect(r2.token).toBeNull()
  })

  it('IPC 失败时不缓存，下次调用会重试', async () => {
    let shouldFail = true
    ipcMockState.invokeHandler = async () => {
      if (shouldFail) throw new Error('boom')
      return { success: true, token: 'tok-recovered' }
    }

    await expect(getAccessTokenDeduped()).rejects.toThrow('boom')
    expect(ipcMockState.invokeCallCount).toBe(1)

    // 失败 + inflight 已清理，再次调用会重新发 IPC
    shouldFail = false
    const r2 = await getAccessTokenDeduped()
    expect(ipcMockState.invokeCallCount).toBe(2)
    expect(r2.token).toBe('tok-recovered')
  })

  it('installAuthTokenInvalidationListeners 重入安全（多次调用只装一次监听器）', () => {
    installAuthTokenInvalidationListeners()
    installAuthTokenInvalidationListeners()
    installAuthTokenInvalidationListeners()

    const refreshedListeners = ipcMockState.onListeners.get('auth:token-refreshed-signal') ?? []
    const logoutListeners = ipcMockState.onListeners.get('auth:force-logout') ?? []
    expect(refreshedListeners.length).toBe(1)
    expect(logoutListeners.length).toBe(1)
  })
})
