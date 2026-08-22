import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SkillsModuleLifecycle } from '../skills-module-lifecycle'

type FakeModule = { id: string }

function createHarness(opts?: {
  userId?: string | undefined | (() => Promise<string | undefined>)
  initImpl?: (userId: string) => Promise<FakeModule>
}) {
  const timers: Array<{ id: ReturnType<typeof setTimeout>; fn: () => void; ms: number }> = []
  let nextTimerId = 1
  const authListeners = new Set<() => void>()
  const reconnectListeners = new Set<() => void>()
  const logs: { level: 'info' | 'warn'; message: string }[] = []
  const disposeCalls: string[] = []
  const orphanCalls: string[] = []
  const initCalls: string[] = []

  let currentUserId: string | undefined =
    typeof opts?.userId === 'function' ? undefined : opts?.userId

  const resolveUserId =
    typeof opts?.userId === 'function'
      ? opts.userId
      : async () => currentUserId

  const initImpl =
    opts?.initImpl ??
    (async (userId: string) => {
      initCalls.push(userId)
      return { id: `mod-${userId}` }
    })

  const lifecycle = new SkillsModuleLifecycle<FakeModule>({
    resolveUserId,
    initModule: initImpl,
    disposeModule: async () => {
      disposeCalls.push('dispose')
    },
    disposeOrphan: async (mod) => {
      orphanCalls.push(mod.id)
    },
    onAuthChanged: (cb) => {
      authListeners.add(cb)
      return () => {
        authListeners.delete(cb)
      }
    },
    onReconnect: (cb) => {
      reconnectListeners.add(cb)
      return () => {
        reconnectListeners.delete(cb)
      }
    },
    logger: {
      info: (message) => {
        logs.push({ level: 'info', message })
      },
      warn: (message) => {
        logs.push({ level: 'warn', message })
      },
    },
    retry: { baseMs: 100, maxMs: 400, maxAttempts: 3 },
    schedule: (fn, ms) => {
      const id = nextTimerId++ as unknown as ReturnType<typeof setTimeout>
      timers.push({ id, fn, ms })
      return id
    },
    clearSchedule: (handle) => {
      const idx = timers.findIndex((t) => t.id === handle)
      if (idx >= 0) timers.splice(idx, 1)
    },
  })

  return {
    lifecycle,
    logs,
    initCalls,
    disposeCalls,
    orphanCalls,
    timers,
    setUserId: (id: string | undefined) => {
      currentUserId = id
    },
    emitAuthChanged: () => {
      for (const cb of [...authListeners]) cb()
    },
    emitReconnect: () => {
      for (const cb of [...reconnectListeners]) cb()
    },
    flushNextTimer: async () => {
      const next = timers.shift()
      if (!next) throw new Error('no timer scheduled')
      next.fn()
      await Promise.resolve()
      await Promise.resolve()
    },
  }
}

describe('SkillsModuleLifecycle ', () => {
  beforeEach(() => {
    vi.useRealTimers()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('启动早于鉴权 hydrate 时会退避补试，并在读到用户后初始化', async () => {
    const h = createHarness({ userId: undefined })
    h.lifecycle.start()
    await vi.waitFor(() => expect(h.timers.length).toBe(1))
    expect(h.initCalls).toEqual([])
    expect(h.lifecycle.getModule()).toBeNull()

    h.setUserId('user-a')
    await h.flushNextTimer()
    await vi.waitFor(() => {
      expect(h.initCalls).toEqual(['user-a'])
    })
    expect(h.lifecycle.getModule()).toEqual({ id: 'mod-user-a' })
    expect(h.lifecycle.getBoundUserId()).toBe('user-a')
  })

  it('启动时已登录则 host-start 直接 init', async () => {
    const h = createHarness({ userId: 'user-cached' })
    h.lifecycle.start()
    await vi.waitFor(() => {
      expect(h.initCalls).toEqual(['user-cached'])
    })
    expect(h.lifecycle.getModule()).toEqual({ id: 'mod-user-cached' })
  })

  it('init 失败后按退避重试，最终成功', async () => {
    let attempts = 0
    const h = createHarness({
      userId: 'user-a',
      initImpl: async (userId) => {
        attempts += 1
        if (attempts < 3) {
          throw new Error(`boom-${attempts}`)
        }
        return { id: `mod-${userId}` }
      },
    })

    h.lifecycle.start()
    await vi.waitFor(() => {
      expect(h.timers.length).toBe(1)
    })
    expect(h.lifecycle.getModule()).toBeNull()

    await h.flushNextTimer()
    await vi.waitFor(() => {
      expect(h.timers.length).toBe(1)
    })

    await h.flushNextTimer()
    await vi.waitFor(() => {
      expect(h.lifecycle.getModule()).toEqual({ id: 'mod-user-a' })
    })
    expect(attempts).toBe(3)
  })

  it('断线重连在 module 为空时触发 re-init', async () => {
    let shouldFail = true
    const h = createHarness({
      userId: 'user-a',
      initImpl: async (userId) => {
        if (shouldFail) throw new Error('transient')
        return { id: `mod-${userId}` }
      },
    })

    h.lifecycle.start()
    await vi.waitFor(() => expect(h.timers.length).toBe(1))
    // 耗尽重试
    await h.flushNextTimer()
    await vi.waitFor(() => expect(h.timers.length).toBe(1))
    await h.flushNextTimer()
    await vi.waitFor(() => expect(h.timers.length).toBe(1))
    await h.flushNextTimer()
    await vi.waitFor(() =>
      expect(h.logs.some((l) => l.message.includes('retry exhausted'))).toBe(true),
    )

    shouldFail = false
    h.emitReconnect()
    await vi.waitFor(() => {
      expect(h.lifecycle.getModule()).toEqual({ id: 'mod-user-a' })
    })
  })

  it('登出时 teardown 并 dispose；切账号时重建', async () => {
    const h = createHarness({ userId: 'user-a' })
    h.lifecycle.start()
    await vi.waitFor(() => expect(h.lifecycle.getModule()).toEqual({ id: 'mod-user-a' }))

    h.setUserId(undefined)
    h.emitAuthChanged()
    await vi.waitFor(() => {
      expect(h.lifecycle.getModule()).toBeNull()
      expect(h.disposeCalls.length).toBeGreaterThanOrEqual(1)
    })

    h.setUserId('user-b')
    h.emitAuthChanged()
    await vi.waitFor(() => {
      expect(h.lifecycle.getModule()).toEqual({ id: 'mod-user-b' })
      expect(h.lifecycle.getBoundUserId()).toBe('user-b')
    })
  })

  it('stop 取消订阅并清理 timer', async () => {
    const h = createHarness({
      userId: 'user-a',
      initImpl: async () => {
        throw new Error('fail')
      },
    })
    h.lifecycle.start()
    await vi.waitFor(() => expect(h.timers.length).toBe(1))

    await h.lifecycle.stop()
    expect(h.timers.length).toBe(0)
    expect(h.lifecycle.getModule()).toBeNull()

    h.emitAuthChanged()
    h.emitReconnect()
    await Promise.resolve()
    expect(h.timers.length).toBe(0)
  })

  it('init 进行中登出：丢弃过期 handle，不写回 module', async () => {
    let releaseInit: ((mod: FakeModule) => void) | undefined
    const h = createHarness({
      userId: 'user-a',
      initImpl: () =>
        new Promise<FakeModule>((resolve) => {
          releaseInit = resolve
        }),
    })

    h.lifecycle.start()
    await vi.waitFor(() => expect(releaseInit).toBeTypeOf('function'))
    expect(h.lifecycle.getModule()).toBeNull()

    h.setUserId(undefined)
    h.emitAuthChanged()
    await vi.waitFor(() =>
      expect(h.logs.some((l) => l.message.includes('teardown (logout)'))).toBe(true),
    )

    releaseInit!({ id: 'mod-stale' })
    await vi.waitFor(() => {
      expect(h.orphanCalls).toContain('mod-stale')
    })
    expect(h.lifecycle.getModule()).toBeNull()
    expect(h.lifecycle.getBoundUserId()).toBeNull()
  })
})
