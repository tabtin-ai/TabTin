import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * sessionFreshness 单测（ 阶段0 重写）。
 *
 * 架构变迁：merge / 写回 / epoch 门控 / 落库缓存早已从本 service 下沉到
 * store 的 `reconcileFromServer`。本 service 现在只负责
 * **fetch 分页 + 指数退避重试 + freshness 维护 + 委托写回**。因此测试的
 * 接缝也从「mock useChatStore.applyReconciledMessages + messageSyncAction.merge
 * + cacheMessages」迁移到「mock messageWriteGate.reconcileServerMessages
 * （注入的写回 provider）+ getSessionMessagesFacade.captureEpoch」。
 *
 * 真正的 merge / epoch 丢弃逻辑在 store 层的 reconcileFromServer 单测覆盖，
 * 这里只验证本 service 是否正确驱动 fetch、按 provider 返回决定 fresh / stale。
 */

const mockState = vi.hoisted(() => ({
  listFn: vi.fn() as ReturnType<typeof vi.fn>,
  syncTs: null as string | null,
  reconcileFn: vi.fn() as ReturnType<typeof vi.fn>,
  capturedEpoch: 7,
  messagesBySessionId: {} as Record<string, unknown[]>,
}))

vi.mock('@tabtin/chat-client', () => {
  class ChatAPIError extends Error {
    code?: string
    trace_id?: string
    detail?: unknown

    constructor(
      message: string,
      public statusCode: number,
      public response?: unknown,
      extras?: { code?: string; trace_id?: string; detail?: unknown },
    ) {
      super(message)
      this.name = 'ChatAPIError'
      this.code = extras?.code
      this.trace_id = extras?.trace_id
      this.detail = extras?.detail
    }
  }
  return { ChatAPIError }
})

vi.mock('@/services/chatClientSingleton', () => ({
  getChatClientInstance: () => ({
    messages: { list: mockState.listFn },
  }),
}))

vi.mock('@/stores/chat/messages/messageCache', () => ({
  getSessionSyncTimestamp: vi.fn(async () => mockState.syncTs),
  cacheMessages: vi.fn(),
}))

// 新接缝①：消息门面只用到 captureEpoch（fetch 前捕获 epoch，写回时门控比对）。
vi.mock('@/services/agentService/sessionMessages', () => ({
  getSessionMessagesFacade: () => ({
    captureEpoch: () => mockState.capturedEpoch,
  }),
}))

// 新接缝②：写回 + 读消息经 messageWriteGate 注入 provider（依赖倒置，斩 store↔service 环）。
vi.mock('@/services/agentService/messageWriteGate', () => ({
  reconcileServerMessages: (...args: unknown[]) => mockState.reconcileFn(...args),
  readSessionMessages: (sid: string) => mockState.messagesBySessionId[sid] ?? [],
}))

// HITL 面板派生对账有自己的单测（hitlMessageReconcile.test.ts），这里 mock 掉
// 避免拖入 hitlStreamHandlers 的 i18n / 通知等重依赖。
vi.mock('@/stores/chat/hitl/handlers/hitlMessageReconcile', () => ({
  reconcileHitlPanelsFromMessages: vi.fn(),
}))

let ensureSessionFresh: typeof import('../sessionFreshness').ensureSessionFresh
let _resetInFlightForTesting: typeof import('../sessionFreshness')._resetInFlightForTesting
let _setRetryDelaysForTesting: typeof import('../sessionFreshness')._setRetryDelaysForTesting
let useSessionFreshnessStore: typeof import('@/stores/useSessionFreshnessStore').useSessionFreshnessStore
let ChatAPIError: typeof import('@tabtin/chat-client').ChatAPIError

beforeEach(async () => {
  vi.resetModules()
  mockState.listFn = vi.fn()
  mockState.syncTs = null
  mockState.capturedEpoch = 7
  mockState.messagesBySessionId = {}
  // 默认写回 provider：把本次 fetch 到的消息全部视为新增（changed），不丢弃。
  mockState.reconcileFn = vi.fn((_sid: string, _epoch: number, fresh: unknown[]) => ({
    changed: fresh.length > 0,
    newCount: fresh.length,
    dropped: false,
  }))

  // dynamic import 保证 ChatAPIError 和 service 内部用同一份模块实例
  // （vi.resetModules() 后 instanceof 检查依赖单例同源）
  const errorMod = await import('@tabtin/chat-client')
  ChatAPIError = errorMod.ChatAPIError

  const svcMod = await import('../sessionFreshness')
  ensureSessionFresh = svcMod.ensureSessionFresh
  _resetInFlightForTesting = svcMod._resetInFlightForTesting
  _setRetryDelaysForTesting = svcMod._setRetryDelaysForTesting
  _resetInFlightForTesting()
  _setRetryDelaysForTesting([0, 0, 0])

  const storeMod = await import('@/stores/useSessionFreshnessStore')
  useSessionFreshnessStore = storeMod.useSessionFreshnessStore
  useSessionFreshnessStore.getState().reset()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('ensureSessionFresh — happy path', () => {
  it('成功同步：把 fetch 到的消息 + 捕获的 epoch 交给写回 provider，返回其 newCount 并 markFresh', async () => {
    mockState.listFn.mockResolvedValueOnce({
      messages: [{ id: 'm1' }],
      server_timestamp: '2026-06-25T00:00:00.000Z',
    })

    const newCount = await ensureSessionFresh('s1', { retry: false })

    expect(newCount).toBe(1)
    expect(mockState.reconcileFn).toHaveBeenCalledWith('s1', 7, [{ id: 'm1' }], {
      advanceWatermark: true,
      syncWatermark: '2026-06-25T00:00:00.000Z',
    })
    expect(useSessionFreshnessStore.getState().isFresh('s1')).toBe(true)
  })

  it('返回的 messages 为空：仍委托 provider（走 watermark-only 分支），newCount=0，markFresh', async () => {
    mockState.listFn.mockResolvedValueOnce({ messages: [] })

    const newCount = await ensureSessionFresh('s1', { retry: false })

    expect(newCount).toBe(0)
    expect(mockState.reconcileFn).toHaveBeenCalledWith('s1', 7, [], expect.objectContaining({ advanceWatermark: true }))
    expect(useSessionFreshnessStore.getState().isFresh('s1')).toBe(true)
  })

  it('#6514 对账一律拉最新页 + upsert，默认推进 watermark（不再 forceFullLatest / hold 水位）', async () => {
    mockState.syncTs = '2026-06-24T23:00:00.000Z'
    mockState.listFn.mockResolvedValueOnce({
      messages: [{ id: 'm1' }, { id: 'm2' }],
      has_more: true,
      server_timestamp: '2026-06-25T00:00:00.000Z',
    })
    mockState.reconcileFn.mockReturnValue({ changed: true, newCount: 2, dropped: false })

    const newCount = await ensureSessionFresh('s1', { retry: false })

    expect(newCount).toBe(2)
    expect(mockState.listFn).toHaveBeenCalledTimes(1)
    expect(mockState.listFn).toHaveBeenCalledWith('s1', {
      limit: 100,
      before: '00000000-0000-0000-0000-000000000000',
    })
    expect(mockState.reconcileFn).toHaveBeenCalledWith(
      's1',
      7,
      [{ id: 'm1' }, { id: 'm2' }],
      { advanceWatermark: true, syncWatermark: '2026-06-25T00:00:00.000Z' },
    )
  })

  it('#6514 advanceWatermark=false 且 changed=false 仍 markFresh（不再因 full latest 标 stale）', async () => {
    mockState.listFn.mockResolvedValueOnce({
      messages: [{ id: 'existing' }],
      server_timestamp: '2026-06-25T00:00:00.000Z',
    })
    mockState.reconcileFn.mockReturnValue({ changed: false, newCount: 0, dropped: false })

    const newCount = await ensureSessionFresh('s1', {
      force: true,
      retry: false,
      advanceWatermark: false,
    })

    expect(newCount).toBe(0)
    expect(useSessionFreshnessStore.getState().isFresh('s1')).toBe(true)
  })

  it('#2822 写回被权威丢弃（provider 返回 dropped）→ 本次未对齐，标 stale', async () => {
    mockState.listFn.mockResolvedValueOnce({
      messages: [{ id: 'kept' }, { id: 'reverted-stale' }],
      server_timestamp: '2026-06-25T00:00:00.000Z',
    })
    // store 层 reconcileFromServer 经 epoch 门控判定过期投影 → dropped=true
    mockState.reconcileFn.mockReturnValue({ changed: true, newCount: 1, dropped: true })

    const newCount = await ensureSessionFresh('s1', { force: true, retry: false })

    expect(newCount).toBe(1)
    expect(useSessionFreshnessStore.getState().isStale('s1')).toBe(true)
  })

  it('已 fresh 的 session 默认跳过 sync', async () => {
    useSessionFreshnessStore.getState().markFresh('s1')

    const newCount = await ensureSessionFresh('s1')
    expect(newCount).toBe(0)
    expect(mockState.listFn).not.toHaveBeenCalled()
    expect(mockState.reconcileFn).not.toHaveBeenCalled()
  })

  it('force=true 即使 fresh 也会重新 sync', async () => {
    useSessionFreshnessStore.getState().markFresh('s1')
    mockState.listFn.mockResolvedValueOnce({ messages: [{ id: 'm1' }] })

    await ensureSessionFresh('s1', { force: true, retry: false })
    expect(mockState.listFn).toHaveBeenCalledTimes(1)
  })
})

describe('ensureSessionFresh — in-flight dedup', () => {
  it('并发调用复用同一个 in-flight Promise', async () => {
    let resolveList: (v: unknown) => void = () => {}
    mockState.listFn.mockImplementationOnce(
      () => new Promise((r) => { resolveList = r }),
    )

    const p1 = ensureSessionFresh('s1', { force: true, retry: false })
    const p2 = ensureSessionFresh('s1', { force: true, retry: false })

    // ensureSessionFresh 内部还要 await getSessionSyncTimestamp 等 microtask；
    // 让事件循环跑一轮再检查 mock 调用次数。
    await new Promise((r) => setTimeout(r, 0))

    expect(mockState.listFn).toHaveBeenCalledTimes(1)

    resolveList({ messages: [{ id: 'm1' }] })
    const [r1, r2] = await Promise.all([p1, p2])
    expect(r1).toBe(1)
    expect(r2).toBe(1)
  })
})

describe('ensureSessionFresh — retry on retryable errors', () => {
  it('5xx 错误自动重试，最终成功', async () => {
    mockState.listFn
      .mockRejectedValueOnce(new ChatAPIError('boom', 500))
      .mockRejectedValueOnce(new ChatAPIError('boom', 503))
      .mockResolvedValueOnce({ messages: [{ id: 'm1' }] })

    const newCount = await ensureSessionFresh('s1', { retry: true, silentOnError: false })

    expect(newCount).toBe(1)
    expect(mockState.listFn).toHaveBeenCalledTimes(3)
    expect(useSessionFreshnessStore.getState().isFresh('s1')).toBe(true)
  })

  it('Network error（statusCode=0 无 code）自动重试', async () => {
    mockState.listFn
      .mockRejectedValueOnce(new ChatAPIError('network', 0))
      .mockResolvedValueOnce({ messages: [{ id: 'm1' }] })

    await ensureSessionFresh('s1', { retry: true, silentOnError: false })

    expect(mockState.listFn).toHaveBeenCalledTimes(2)
  })

  it('429 限流自动重试', async () => {
    mockState.listFn
      .mockRejectedValueOnce(new ChatAPIError('rate limited', 429))
      .mockResolvedValueOnce({ messages: [{ id: 'm1' }] })

    await ensureSessionFresh('s1', { retry: true, silentOnError: false })

    expect(mockState.listFn).toHaveBeenCalledTimes(2)
  })

  it('TypeError（fetch 网络错误）自动重试', async () => {
    const networkErr = new TypeError('Failed to fetch')
    mockState.listFn
      .mockRejectedValueOnce(networkErr)
      .mockResolvedValueOnce({ messages: [{ id: 'm1' }] })

    await ensureSessionFresh('s1', { retry: true, silentOnError: false })

    expect(mockState.listFn).toHaveBeenCalledTimes(2)
  })

  it('3 次重试都失败 → 抛错并标记 stale', async () => {
    const err = new ChatAPIError('persistent 500', 500)
    mockState.listFn.mockRejectedValue(err)

    await expect(
      ensureSessionFresh('s1', { retry: true, silentOnError: false }),
    ).rejects.toThrow('persistent 500')

    // 1 次原始 + 3 次重试
    expect(mockState.listFn).toHaveBeenCalledTimes(4)
    expect(useSessionFreshnessStore.getState().isStale('s1')).toBe(true)
    expect(useSessionFreshnessStore.getState().getEntry('s1')?.failureCount).toBe(1)
  })
})

describe('ensureSessionFresh — non-retryable errors', () => {
  it('401 不重试，直接抛错并标记 stale', async () => {
    mockState.listFn.mockRejectedValueOnce(new ChatAPIError('unauth', 401))

    await expect(
      ensureSessionFresh('s1', { retry: true, silentOnError: false }),
    ).rejects.toThrow('unauth')
    expect(mockState.listFn).toHaveBeenCalledTimes(1)
    expect(useSessionFreshnessStore.getState().isStale('s1')).toBe(true)
  })

  it('404 不重试，返回 0 视为成功（session 已删），不触达写回 provider', async () => {
    mockState.listFn.mockRejectedValueOnce(new ChatAPIError('not found', 404))

    const newCount = await ensureSessionFresh('s1', { retry: true, silentOnError: false })
    expect(newCount).toBe(0)
    expect(mockState.listFn).toHaveBeenCalledTimes(1)
    expect(mockState.reconcileFn).not.toHaveBeenCalled()
    expect(useSessionFreshnessStore.getState().isFresh('s1')).toBe(true)
  })

  it('403 不重试，抛错并标记 stale', async () => {
    mockState.listFn.mockRejectedValueOnce(new ChatAPIError('forbidden', 403))

    await expect(
      ensureSessionFresh('s1', { retry: true, silentOnError: false }),
    ).rejects.toThrow('forbidden')
    expect(mockState.listFn).toHaveBeenCalledTimes(1)
    expect(useSessionFreshnessStore.getState().isStale('s1')).toBe(true)
  })

  it('envelope 业务错（statusCode=0 + code）不重试', async () => {
    const businessErr = new ChatAPIError('business', 0, undefined, {
      code: 'SOFT_FAIL',
    })
    mockState.listFn.mockRejectedValueOnce(businessErr)

    await expect(
      ensureSessionFresh('s1', { retry: true, silentOnError: false }),
    ).rejects.toThrow('business')
    expect(mockState.listFn).toHaveBeenCalledTimes(1)
    expect(useSessionFreshnessStore.getState().isStale('s1')).toBe(true)
  })
})

describe('ensureSessionFresh — silentOnError', () => {
  it('silentOnError=true 时失败返回 0，不抛错', async () => {
    mockState.listFn.mockRejectedValueOnce(new ChatAPIError('forbidden', 403))

    const newCount = await ensureSessionFresh('s1', {
      retry: false,
      silentOnError: true,
    })
    expect(newCount).toBe(0)
    expect(useSessionFreshnessStore.getState().isStale('s1')).toBe(true)
  })

  it('silentOnError 默认开启', async () => {
    mockState.listFn.mockRejectedValueOnce(new ChatAPIError('forbidden', 403))

    const newCount = await ensureSessionFresh('s1', { retry: false })
    expect(newCount).toBe(0)
  })
})

describe('ensureSessionFresh — retry=false', () => {
  it('5xx 时若 retry=false 则不重试，立即抛错', async () => {
    mockState.listFn.mockRejectedValueOnce(new ChatAPIError('boom', 500))

    await expect(
      ensureSessionFresh('s1', { retry: false, silentOnError: false }),
    ).rejects.toThrow('boom')
    expect(mockState.listFn).toHaveBeenCalledTimes(1)
  })
})
