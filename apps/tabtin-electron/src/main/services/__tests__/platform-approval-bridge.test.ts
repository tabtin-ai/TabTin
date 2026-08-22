/**
 * platform-approval-bridge 单测：三档记忆语义。
 *
 * 回归点：
 *  - thread（本对话内允许）必须按 sessionId 隔离，切换对话不命中（ 后续）。
 *  - always（一直允许）写入会话 ApprovalMemoStore（→ Django approval_memo），
 *    出现在「已记住的授权」列表、跨对话生效（ 收口）。
 *  - once 不记忆；isStrict 永不命中。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ApprovalMemoStore } from '@tabtin/agent-runtime/permissions'

/** 每个 session 一份内存 memo store 模拟（always cache 全局可见，模拟 Django 同源）。 */
const alwaysStore = new Map<string, { decision: string; scope_description?: string }>()
const putAlwaysMock = vi.fn((key: string, entry: { decision: string; scope_description?: string }) => {
  alwaysStore.set(key, entry)
})

function makeMemoStore(): ApprovalMemoStore {
  return {
    getAlways: (key: string) => (alwaysStore.get(key) as unknown as ReturnType<ApprovalMemoStore['getAlways']>) ?? null,
    putAlways: putAlwaysMock,
    getThread: () => null,
    putThread: vi.fn(),
    clearThread: vi.fn(),
  } as unknown as ApprovalMemoStore
}

const getStoreMock = vi.fn<(id: string) => ApprovalMemoStore | null>(() => makeMemoStore())

vi.mock('../ApprovalScopeCache', () => ({
  approvalScopeCache: {
    getCacheKey: (actionType: string, detail?: string) =>
      detail ? `${actionType}:${detail}` : actionType,
  },
}))

vi.mock('../logger', () => ({
  createLogger: () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}))

async function loadBridge() {
  const bridge = await import('../platform-approval-bridge')
  bridge.registerPlatformMemoStoreResolver(() => makeMemoStore())
  return bridge
}

describe('platform-approval-bridge', () => {
  const SESSION_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  const SESSION_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

  beforeEach(() => {
    vi.resetModules()
    alwaysStore.clear()
    putAlwaysMock.mockClear()
    getStoreMock.mockReset().mockImplementation(() => makeMemoStore())
  })

  it('thread scope 只在记忆所在对话命中，切换对话不生效', async () => {
    const bridge = await loadBridge()

    bridge.recordPlatformApproval('browser.open', 'thread', true, 'example.com', SESSION_A)

    expect(bridge.isPlatformActionApproved('browser.open', false, 'example.com', SESSION_A)).toBe(true)
    expect(bridge.isPlatformActionApproved('browser.open', false, 'example.com', SESSION_B)).toBe(false)
    expect(bridge.isPlatformActionApproved('browser.open', false, 'example.com')).toBe(false)
    // thread 不写 always memo
    expect(putAlwaysMock).not.toHaveBeenCalled()
  })

  it('clearPlatformThreadApprovals 清掉本对话 thread 记忆', async () => {
    const bridge = await loadBridge()

    bridge.recordPlatformApproval('browser.open', 'thread', true, 'example.com', SESSION_A)
    expect(bridge.isPlatformActionApproved('browser.open', false, 'example.com', SESSION_A)).toBe(true)

    bridge.clearPlatformThreadApprovals(SESSION_A)
    expect(bridge.isPlatformActionApproved('browser.open', false, 'example.com', SESSION_A)).toBe(false)
  })

  it('always scope 写入 ApprovalMemoStore（进入「已记住的授权」），跨对话生效', async () => {
    const bridge = await loadBridge()

    bridge.recordPlatformApproval('browser.open', 'always', true, 'example.com', SESSION_A)

    expect(putAlwaysMock).toHaveBeenCalledTimes(1)
    const [key, entry] = putAlwaysMock.mock.calls[0]
    expect(key).toBe('platform::browser.open:example.com')
    expect(entry).toMatchObject({ decision: 'allow' })
    expect(entry.scope_description).toContain('总是允许')

    // always 命中跨对话（同源 Django approval_memo）
    expect(bridge.isPlatformActionApproved('browser.open', false, 'example.com', SESSION_B)).toBe(true)
  })

  it('once scope 不记忆', async () => {
    const bridge = await loadBridge()

    bridge.recordPlatformApproval('browser.open', 'once', true, 'example.com', SESSION_A)
    expect(putAlwaysMock).not.toHaveBeenCalled()
    expect(bridge.isPlatformActionApproved('browser.open', false, 'example.com', SESSION_A)).toBe(false)
  })

  it('isStrict 永不命中缓存', async () => {
    const bridge = await loadBridge()

    bridge.recordPlatformApproval('browser.open', 'always', true, 'example.com', SESSION_A)
    expect(bridge.isPlatformActionApproved('browser.open', true, 'example.com', SESSION_A)).toBe(false)
  })

  it('无 sessionId 时 always 无处持久化，不写 memo', async () => {
    const bridge = await loadBridge()

    bridge.recordPlatformApproval('browser.open', 'always', true, 'example.com', null)
    expect(putAlwaysMock).not.toHaveBeenCalled()
  })
})
