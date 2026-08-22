/**
 * sessionRunReconcile.test.ts —  /  执行态对账与自愈契约。
 *
 * ：投影 busy 由 run_sync / reconcile override / server run_state 驱动。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const {
  mockCleanupSessionOnTerminal,
  mockSettleExecutionCompleted,
  mockReconcileSessionMessages,
  mockHydrateAfterLostStream,
  mockScheduleLostStreamHydrate,
  mockSessionsGet,
} = vi.hoisted(() => ({
  mockCleanupSessionOnTerminal: vi.fn(() => false),
  mockSettleExecutionCompleted: vi.fn(() => false),
  mockReconcileSessionMessages: vi.fn(async () => undefined),
  mockHydrateAfterLostStream: vi.fn(async () => undefined),
  mockScheduleLostStreamHydrate: vi.fn(),
  mockSessionsGet: vi.fn(),
}))
const { chatStoreState } = vi.hoisted(() => ({
  chatStoreState: {
    addStreamingSession: vi.fn(),
    removeStreamingSession: vi.fn(),
    updateSessionInCaches: vi.fn(),
  },
}))
vi.mock('../../stream/handlers/sessionCleanup', () => ({
  cleanupSessionOnTerminal: mockCleanupSessionOnTerminal,
  endSessionRun: mockCleanupSessionOnTerminal,
}))
vi.mock('@/stores/chat/useChatStore', () => ({
  useChatStore: { getState: () => chatStoreState },
}))
vi.mock('@/services/agentService', () => ({
  hasRuntimeBridge: () => !!window.tabtin?.agentEngine,
  getSessionController: () => ({
    settleExecutionCompleted: mockSettleExecutionCompleted,
  }),
}))
vi.mock('@/services/sessionFreshness', () => ({
  reconcileSessionMessages: mockReconcileSessionMessages,
  hydrateAfterLostStream: mockHydrateAfterLostStream,
  scheduleLostStreamHydrate: mockScheduleLostStreamHydrate,
}))
vi.mock('@/services/chatApi', () => ({
  getChatClient: () => ({
    sessions: { get: mockSessionsGet },
  }),
}))
import { useChatRuntimeStore } from '../../../useChatRuntimeStore'
import {
  reconcileSessionRunState,
  scheduleTerminalRunReconcile,
  __resetReconcileForTest,
  __sweepTickForTest,
} from '../sessionRunReconcile'
import {
  applyRuntimeRunSync,
  applySessionRunStateSnapshot,
  isSessionBusy,
  getSessionRunProjection,
} from '../sessionRunProjection'
import type { ChatSession } from '@tabtin/chat-client'

const SID = 'session-reconcile-test'

const mockGetState = vi.fn()

function installBridge(): void {
  Object.defineProperty(window, 'tabtin', {
    configurable: true,
    value: { agentEngine: { getState: mockGetState } },
  })
}

function seedBusy(sessionId: string, seq = 1, queued: string[] = []): void {
  applyRuntimeRunSync(sessionId, {
    session_id: sessionId,
    run_id: 'run-seed',
    status: queued.length > 0 ? 'queued' : 'running',
    seq,
    queued_run_ids: queued,
  })
}

function applyStaleRunningSnapshot(sessionId: string, runId = 'run-stale'): void {
  applySessionRunStateSnapshot({
    id: sessionId,
    run_state: {
      run_id: runId,
      sequence: 1,
      revision: 2,
      status: 'running',
      queue_depth: 0,
      started_at: '2026-08-03T05:17:25Z',
      state_changed_at: '2026-08-03T05:17:25Z',
      ended_at: null,
      stop_reason: null,
      error_class: null,
      waiting_interaction_id: null,
    },
  } as ChatSession)
}

function terminalRunState(runId = 'run-done') {
  return {
    run_id: runId,
    sequence: 1,
    revision: 3,
    status: 'completed' as const,
    queue_depth: 0,
    started_at: '2026-08-03T05:17:25Z',
    state_changed_at: '2026-08-03T05:18:00Z',
    ended_at: '2026-08-03T05:18:00Z',
    stop_reason: null,
    error_class: null,
    waiting_interaction_id: null,
  }
}

describe('#4985/#9051 sessionRunReconcile', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockSettleExecutionCompleted.mockReturnValue(false)
    mockCleanupSessionOnTerminal.mockReturnValue(false)
    mockSessionsGet.mockReset()
    chatStoreState.updateSessionInCaches.mockImplementation((sessionId: string, patch: Partial<ChatSession>) => {
      applySessionRunStateSnapshot({ id: sessionId, ...patch } as ChatSession)
    })
    vi.useRealTimers()
    __resetReconcileForTest()
    useChatRuntimeStore.setState({ runProjectionBySessionId: {} })
    installBridge()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('权威 busy → 覆写投影（含排队），isSessionBusy 立即一致', async () => {
    mockGetState.mockResolvedValue({ sessionId: SID, busy: true, running: true, queuedRunIds: ['q1'] })
    await reconcileSessionRunState(SID)
    expect(isSessionBusy(SID)).toBe(true)
    expect(getSessionRunProjection(SID)).toMatchObject({ source: 'reconcile', queuedRunIds: ['q1'] })
  })

  it('#6529 权威仍 busy 且误有 endedAt → 清 endedAt 重开表', async () => {
    useChatRuntimeStore.setState({
      runStateBySessionId: {
        [SID]: {
          runId: null,
          phase: 'cancelled',
          startedAt: Date.now() - 10_000,
          endedAt: Date.now() - 1000,
          completedToolCalls: 0,
          totalToolCalls: 0,
        },
      },
    })
    mockGetState.mockResolvedValue({ sessionId: SID, busy: true, running: true, queuedRunIds: [] })
    await reconcileSessionRunState(SID)
    expect(isSessionBusy(SID)).toBe(true)
    expect(useChatRuntimeStore.getState().runStateBySessionId[SID]?.endedAt).toBeNull()
  })

  it('权威 idle + 本机托管 + 投影 busy → 终态收口（不再 drain 前端队）', async () => {
    seedBusy(SID)
    mockGetState.mockResolvedValue({ sessionId: SID, busy: false, running: false, queuedRunIds: [] })
    await reconcileSessionRunState(SID)
    expect(mockCleanupSessionOnTerminal).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: SID,
      status: 'cancelled',
    }))
    expect(isSessionBusy(SID)).toBe(false)
    expect(mockSettleExecutionCompleted).toHaveBeenCalled()
  })

  it('#8805：stale-active 服务端快照下 force_idle 后 busy 稳定为 false', async () => {
    applyStaleRunningSnapshot(SID, 'b83c6e82')
    expect(isSessionBusy(SID)).toBe(true)
    mockGetState.mockResolvedValue({ sessionId: SID, busy: false, running: false, queuedRunIds: [] })
    await reconcileSessionRunState(SID, 'sweep')
    expect(mockCleanupSessionOnTerminal).toHaveBeenCalled()
    expect(isSessionBusy(SID)).toBe(false)
    expect(getSessionRunProjection(SID)?.runtimeBusy).toBe(false)
    expect(getSessionRunProjection(SID)?.authoritativeRunState?.status).toBe('running')
    __resetReconcileForTest()
    await reconcileSessionRunState(SID, 'sweep')
    expect(isSessionBusy(SID)).toBe(false)
  })

  it('#8805：force_idle 时 stale projection 队列也要对齐清空', async () => {
    seedBusy(SID, 1, ['run-queued-stale'])
    expect(getSessionRunProjection(SID)?.queuedRunIds).toEqual(['run-queued-stale'])
    mockGetState.mockResolvedValue({ sessionId: SID, busy: false, running: false, queuedRunIds: [] })
    await reconcileSessionRunState(SID, 'sweep')
    expect(isSessionBusy(SID)).toBe(false)
    expect(getSessionRunProjection(SID)?.queuedRunIds).toEqual([])
  })

  it('#7013/#7016 force_idle 后 scheduleLostStreamHydrate', async () => {
    seedBusy(SID)
    mockSettleExecutionCompleted.mockReturnValue(true)
    mockGetState.mockResolvedValue({ sessionId: SID, busy: false, running: false, queuedRunIds: [] })
    await reconcileSessionRunState(SID)
    expect(mockHydrateAfterLostStream).not.toHaveBeenCalled()
    expect(mockScheduleLostStreamHydrate).toHaveBeenCalledWith(SID, 'reconcile-force-idle')
  })

  it('权威 idle + 投影本来就 idle → 不收口，也不 drain', async () => {
    mockGetState.mockResolvedValue({ sessionId: SID, busy: false, running: false, queuedRunIds: [] })
    await reconcileSessionRunState(SID)
    expect(mockCleanupSessionOnTerminal).not.toHaveBeenCalled()
  })

  it('#9051 方案 A：本机 miss + 投影 busy → HTTP run_state 终态收口', async () => {
    // 远控/旁观只靠 authoritative（不得用 run_sync 污染 runtimeBusy）
    applyStaleRunningSnapshot(SID)
    expect(isSessionBusy(SID)).toBe(true)
    mockGetState.mockResolvedValue({ sessionId: null, busy: false, running: false, queuedRunIds: [] })
    mockSessionsGet.mockResolvedValue({
      id: SID,
      run_state: terminalRunState('b83c6e82'),
    })
    await reconcileSessionRunState(SID, 'busy-retain')
    expect(mockSessionsGet).toHaveBeenCalledWith(SID)
    expect(isSessionBusy(SID)).toBe(false)
    expect(mockCleanupSessionOnTerminal).toHaveBeenCalled()
    expect(mockScheduleLostStreamHydrate).toHaveBeenCalledWith(SID, 'reconcile-remote-http')
  })

  it('#9051 方案 A：本机 miss + HTTP 仍 active → 保持 busy、不 force_idle', async () => {
    applyStaleRunningSnapshot(SID)
    mockGetState.mockResolvedValue({ sessionId: null, busy: false, running: false, queuedRunIds: [] })
    mockSessionsGet.mockResolvedValue({
      id: SID,
      run_state: {
        run_id: 'b83c6e82',
        sequence: 1,
        revision: 4,
        status: 'running',
        queue_depth: 0,
        started_at: '2026-08-03T05:17:25Z',
        state_changed_at: '2026-08-03T05:17:40Z',
        ended_at: null,
        stop_reason: null,
        error_class: null,
        waiting_interaction_id: null,
      },
    })
    await reconcileSessionRunState(SID, 'busy-retain')
    expect(isSessionBusy(SID)).toBe(true)
    expect(mockCleanupSessionOnTerminal).not.toHaveBeenCalled()
  })

  it('busy-retain 本机 idle 仍可收口', async () => {
    seedBusy(SID)
    mockGetState.mockResolvedValue({ sessionId: SID, busy: false, running: false, queuedRunIds: [] })
    await reconcileSessionRunState(SID, 'busy-retain')
    expect(isSessionBusy(SID)).toBe(false)
    expect(mockCleanupSessionOnTerminal).toHaveBeenCalled()
  })

  it('节流：同 session 5s 内第二次对账不发起查询', async () => {
    mockGetState.mockResolvedValue({ sessionId: SID, busy: false, running: false, queuedRunIds: [] })
    const first = await reconcileSessionRunState(SID)
    const second = await reconcileSessionRunState(SID)
    expect(first).toBe(true)
    expect(second).toBe(false)
    expect(mockGetState).toHaveBeenCalledTimes(1)
  })

  it('观察到 lifecycle 终态时绕过常规节流，立即用 Host 权威 idle 收口', async () => {
    seedBusy(SID)
    mockGetState
      .mockResolvedValueOnce({ sessionId: SID, busy: true, running: true, queuedRunIds: [] })
      .mockResolvedValueOnce({ sessionId: SID, busy: false, running: false, queuedRunIds: [] })

    await reconcileSessionRunState(SID, 'manual')
    expect(isSessionBusy(SID)).toBe(true)

    scheduleTerminalRunReconcile(SID)
    await vi.waitFor(() => expect(mockGetState).toHaveBeenCalledTimes(2))
    await vi.waitFor(() => expect(isSessionBusy(SID)).toBe(false))
    expect(mockCleanupSessionOnTerminal).toHaveBeenCalled()
  })

  it('lifecycle 终态先于 Host queue settle 时，只做一次短暂复查并收口', async () => {
    vi.useFakeTimers()
    seedBusy(SID)
    mockGetState
      .mockResolvedValueOnce({ sessionId: SID, busy: true, running: true, queuedRunIds: [] })
      .mockResolvedValueOnce({ sessionId: SID, busy: false, running: false, queuedRunIds: [] })

    scheduleTerminalRunReconcile(SID)
    await vi.advanceTimersByTimeAsync(0)
    expect(mockGetState).toHaveBeenCalledTimes(1)
    expect(isSessionBusy(SID)).toBe(true)

    await vi.advanceTimersByTimeAsync(1_000)
    expect(mockGetState).toHaveBeenCalledTimes(2)
    expect(isSessionBusy(SID)).toBe(false)
    expect(mockCleanupSessionOnTerminal).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(10_000)
    expect(mockGetState).toHaveBeenCalledTimes(2)
  })

  it('无本机 runtime bridge → 直接跳过', async () => {
    Object.defineProperty(window, 'tabtin', { configurable: true, value: undefined })
    const result = await reconcileSessionRunState(SID)
    expect(result).toBe(false)
    expect(mockGetState).not.toHaveBeenCalled()
  })

  it('get-state 抛错不外泄（fire-safe）', async () => {
    seedBusy(SID)
    mockGetState.mockRejectedValue(new Error('ipc broken'))
    await expect(reconcileSessionRunState(SID)).resolves.toBe(true)
    expect(isSessionBusy(SID)).toBe(true)
  })


  it('#9051：本机 miss 时即使 get-state 谎报 busy 也走 HTTP，不写 runtimeBusy', async () => {
    applyStaleRunningSnapshot(SID)
    expect(isSessionBusy(SID)).toBe(true)
    expect(getSessionRunProjection(SID)?.runtimeBusy).toBeNull()
    mockGetState.mockResolvedValue({ sessionId: null, busy: true, running: true, queuedRunIds: ['x'] })
    mockSessionsGet.mockResolvedValue({
      id: SID,
      run_state: terminalRunState('b83c6e82'),
    })
    await reconcileSessionRunState(SID, 'busy-retain')
    expect(mockSessionsGet).toHaveBeenCalledWith(SID)
    expect(getSessionRunProjection(SID)?.runtimeBusy).toBeNull()
    expect(isSessionBusy(SID)).toBe(false)
    expect(mockCleanupSessionOnTerminal).toHaveBeenCalled()
  })

  it('sweep：只对「busy 且投影长时间未更新」的会话发起对账', async () => {
    mockGetState.mockResolvedValue({ sessionId: SID, busy: true, running: true, queuedRunIds: [] })
    seedBusy(SID)
    __sweepTickForTest()
    await Promise.resolve()
    expect(mockGetState).not.toHaveBeenCalled()

    useChatRuntimeStore.setState((s) => ({
      runProjectionBySessionId: {
        ...s.runProjectionBySessionId,
        [SID]: { ...s.runProjectionBySessionId[SID], lastSyncAt: Date.now() - 60_000 },
      },
    }))
    __sweepTickForTest()
    await vi.waitFor(() => expect(mockGetState).toHaveBeenCalledWith({ sessionId: SID }))
  })
})
