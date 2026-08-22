import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const runProjectionBySessionId: Record<string, { busy: boolean; queuedRunIds: string[]; source: string; lastSyncAt: number }> = {}
const runStateBySessionId: Record<string, { lastHeartbeatAt?: number; startedAt?: number; endedAt?: number | null }> = {}
const removeStreamingSession = vi.fn()
const endSessionRun = vi.fn()
const reconcileFromServer = vi.fn()

function setBusy(sid: string): void {
  runProjectionBySessionId[sid] = { busy: true, queuedRunIds: [], source: 'event', lastSyncAt: Date.now() }
}

vi.mock('@/stores/chat/useChatStore', () => ({
  useChatStore: {
    getState: () => ({
      removeStreamingSession,
      reconcileFromServer,
    }),
  },
}))

vi.mock('@/stores/useChatRuntimeStore', () => ({
  useChatRuntimeStore: {
    getState: () => ({ runStateBySessionId, runProjectionBySessionId }),
  },
}))

vi.mock('@/stores/chat/stream/handlers/sessionCleanup', () => ({
  endSessionRun: (...args: unknown[]) => endSessionRun(...(args as [])),
}))

const listMock = vi.fn(async () => ({ messages: [] as unknown[] }))
vi.mock('@/services/chatApi', () => ({
  getChatClient: () => ({ messages: { list: listMock } }),
}))

const fetchSessionStatus = vi.fn(async () => ({ status: 'idle' as const }))
vi.mock('@/services/chatExtraApi', () => ({
  fetchSessionStatus: (...args: unknown[]) => fetchSessionStatus(...(args as [])),
}))

const markSessionFresh = vi.fn()
const markSessionStale = vi.fn()
vi.mock('@/services/sessionFreshness', () => ({
  markSessionFresh: (...a: unknown[]) => markSessionFresh(...(a as [])),
  markSessionStale: (...a: unknown[]) => markSessionStale(...(a as [])),
  reconcileSessionMessages: vi.fn(async () => undefined),
}))

let localRuntimeAvailable = false
vi.mock('@services/localAgentClient', () => ({
  isLocalRuntimeAvailable: () => localRuntimeAvailable,
}))

vi.mock('@tabtin/smartsheet-ui/toast', () => ({ toast: vi.fn() }))
vi.mock('@/i18n', () => ({ default: { t: (_k: string, o?: { defaultValue?: string }) => o?.defaultValue ?? _k } }))
vi.mock('@/utils/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), log: vi.fn() }),
}))
vi.mock('@/services/agentService/sessionMessages', () => ({
  getSessionMessagesFacade: () => ({ captureEpoch: () => 1 }),
}))

import { startSessionReconcileWatcher } from '../sessionReconcileWatcher'

const SID = 's1'

function flushMicrotasks() {
  return Promise.resolve().then(() => Promise.resolve())
}

describe('sessionReconcileWatcher', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    localRuntimeAvailable = false
    for (const k of Object.keys(runProjectionBySessionId)) delete runProjectionBySessionId[k]
    for (const k of Object.keys(runStateBySessionId)) delete runStateBySessionId[k]
    removeStreamingSession.mockClear()
    endSessionRun.mockClear()
    reconcileFromServer.mockClear()
    fetchSessionStatus.mockClear()
    fetchSessionStatus.mockResolvedValue({ status: 'idle' as const })
    markSessionFresh.mockClear()
    markSessionStale.mockClear()
    listMock.mockClear()
    listMock.mockResolvedValue({ messages: [] })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('#6529 心跳超时且后端 idle + 前端仍 streaming → endSessionRun（写 endedAt），不只 removeStreamingSession', async () => {
    setBusy(SID)
    runStateBySessionId[SID] = { lastHeartbeatAt: Date.now() - 120_000, startedAt: Date.now() - 120_000, endedAt: null }

    const detach = startSessionReconcileWatcher(SID)
    await vi.advanceTimersByTimeAsync(15_000)
    await flushMicrotasks()

    expect(fetchSessionStatus).toHaveBeenCalledWith(SID)
    expect(endSessionRun).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: SID,
        status: 'cancelled',
        removeStreamingSession,
      }),
    )
    // 禁止旧路径：只清 busy 不停表
    expect(removeStreamingSession).not.toHaveBeenCalled()
    detach()
  })

  it('#6529 后端 hitl_waiting → 保持 run 开启（不 endSessionRun / 不 removeStreamingSession）', async () => {
    setBusy(SID)
    runStateBySessionId[SID] = { lastHeartbeatAt: Date.now() - 120_000, startedAt: Date.now() - 120_000, endedAt: null }
    fetchSessionStatus.mockResolvedValue({ status: 'hitl_waiting' as const })

    const detach = startSessionReconcileWatcher(SID)
    await vi.advanceTimersByTimeAsync(15_000)
    await flushMicrotasks()

    expect(fetchSessionStatus).toHaveBeenCalledWith(SID)
    expect(endSessionRun).not.toHaveBeenCalled()
    expect(removeStreamingSession).not.toHaveBeenCalled()
    detach()
  })

  it('本地 Runtime 接管时直接 no-op（不打后端）', async () => {
    localRuntimeAvailable = true
    setBusy(SID)
    runStateBySessionId[SID] = { lastHeartbeatAt: Date.now() - 120_000, startedAt: Date.now() - 120_000 }

    const detach = startSessionReconcileWatcher(SID)
    await vi.advanceTimersByTimeAsync(15_000)
    await flushMicrotasks()

    expect(fetchSessionStatus).not.toHaveBeenCalled()
    expect(endSessionRun).not.toHaveBeenCalled()
    detach()
  })

  it('心跳正常（未超时）不触发对账', async () => {
    setBusy(SID)
    runStateBySessionId[SID] = { lastHeartbeatAt: Date.now(), startedAt: Date.now() }

    const detach = startSessionReconcileWatcher(SID)
    await vi.advanceTimersByTimeAsync(15_000)
    await flushMicrotasks()

    expect(fetchSessionStatus).not.toHaveBeenCalled()
    detach()
  })

  it('detach 后停止轮询', async () => {
    setBusy(SID)
    runStateBySessionId[SID] = { lastHeartbeatAt: Date.now() - 120_000, startedAt: Date.now() - 120_000 }

    const detach = startSessionReconcileWatcher(SID)
    detach()
    await vi.advanceTimersByTimeAsync(60_000)
    await flushMicrotasks()

    expect(fetchSessionStatus).not.toHaveBeenCalled()
  })
})
