/**
 *  网络栈软自愈单测
 *
 * 覆盖：执行动作（closeAllConnections + clearHostResolverCache）、
 * 10 分钟冷却节流、单个 API 失败不阻断另一个。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const closeAllConnections = vi.fn(async () => {})
const clearHostResolverCache = vi.fn(async () => {})
const registeredHandlers = new Map<string, (...args: unknown[]) => unknown>()

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      registeredHandlers.set(channel, handler)
    }),
    on: vi.fn(),
  },
  session: {
    defaultSession: {
      get closeAllConnections() {
        return closeAllConnections
      },
      get clearHostResolverCache() {
        return clearHostResolverCache
      },
    },
  },
}))

vi.mock('../logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}))

vi.mock('../auth', () => ({
  isTrustedSender: () => true,
  isTinSandboxSender: () => false,
}))

vi.mock('../utils/trace-context', () => ({
  runWithGeneratedTrace: (fn: () => unknown) => fn(),
  getCurrentTraceId: () => 'trace-test',
  stampTraceIntoEnvelope: (envelope: unknown) => envelope,
}))

import { __internal, RECOVERY_COOLDOWN_MS, registerNetworkRecoveryIpc } from '../network-recovery'

describe('network-recovery — closeAllConnections 软自愈', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    __internal.resetCooldown()
    vi.useRealTimers()
  })

  it('首次触发执行 clearHostResolverCache + closeAllConnections', async () => {
    const result = await __internal.recoverNetworkStack('collab_stuck_connecting:test:3')

    expect(result.performed).toBe(true)
    expect(clearHostResolverCache).toHaveBeenCalledTimes(1)
    expect(closeAllConnections).toHaveBeenCalledTimes(1)
  })

  it('冷却期内的重复触发被跳过', async () => {
    await __internal.recoverNetworkStack('first')
    const second = await __internal.recoverNetworkStack('second')

    expect(second.performed).toBe(false)
    expect(second.cooldownRemainingMs).toBeGreaterThan(0)
    expect(second.cooldownRemainingMs).toBeLessThanOrEqual(RECOVERY_COOLDOWN_MS)
    expect(closeAllConnections).toHaveBeenCalledTimes(1)
  })

  it('冷却期结束后允许再次执行', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-05T12:00:00Z'))
    await __internal.recoverNetworkStack('first')

    vi.setSystemTime(new Date('2026-08-05T12:00:00Z').getTime() + RECOVERY_COOLDOWN_MS + 1)
    const second = await __internal.recoverNetworkStack('second')

    expect(second.performed).toBe(true)
    expect(closeAllConnections).toHaveBeenCalledTimes(2)
  })

  it('clearHostResolverCache 失败不阻断 closeAllConnections', async () => {
    clearHostResolverCache.mockRejectedValueOnce(new Error('boom'))

    const result = await __internal.recoverNetworkStack('resolver_fail')

    expect(result.performed).toBe(true)
    expect(closeAllConnections).toHaveBeenCalledTimes(1)
  })

  it('guardedHandle 注册路径：channel 注册、payload 解析、okResponse envelope', async () => {
    registeredHandlers.clear()
    registerNetworkRecoveryIpc()

    const handler = registeredHandlers.get(__internal.CH_RECOVER_STACK)
    expect(handler).toBeTypeOf('function')

    const stubEvent = { senderFrame: { url: 'app://renderer' } }
    const envelope = (await handler!(stubEvent, { reason: 'collab_stuck_connecting:doc-1:3' })) as {
      ok: boolean
      data: { performed: boolean; cooldownRemainingMs: number }
    }

    expect(envelope.ok).toBe(true)
    expect(envelope.data.performed).toBe(true)
    expect(envelope.data.cooldownRemainingMs).toBe(RECOVERY_COOLDOWN_MS)
    expect(closeAllConnections).toHaveBeenCalledTimes(1)

    // 非法 payload：reason 缺失时按 unspecified 处理而非抛错（冷却期内 performed=false）
    const second = (await handler!(stubEvent, undefined)) as {
      ok: boolean
      data: { performed: boolean }
    }
    expect(second.ok).toBe(true)
    expect(second.data.performed).toBe(false)
  })
})
