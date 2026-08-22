/**
 *  侧栏蓝圈专项：后台 busy 会话必须保留终态可达性。
 *
 * 回归场景：会话 A busy → UI 切到 B（detach/unwatch）→ A 终态到达 →
 * A 的 runProjection.busy 应变 idle，且不依赖用户点回 A / 45s sweep。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConversationStreamDeps } from '../streamSources'
import { __resetStreamHubsForTest, __flushStreamDrainsForTest } from '../index'
import { runtimeStoreAccess } from '../runtimeStoreAccess'
import { streamControlPorts } from '../streamControlPorts'
import { useChatRuntimeStore } from '@/stores/useChatRuntimeStore'
import {
  applyRuntimeRunSync,
  isSessionBusy,
  __getProjectionIdleListenerCountForTest,
} from '@/stores/chat/execution/sessionRunProjection'
import { createStreamMessageHandler } from '@/stores/chat/stream/handlers/streamMessageHandler'

function seedBusy(sessionId: string, seq = 1): void {
  applyRuntimeRunSync(sessionId, {
    session_id: sessionId,
    run_id: `run-${seq}`,
    status: 'running',
    seq,
    queued_run_ids: [],
  })
}

const mockWatchSession = vi.fn()
const mockUnwatchSession = vi.fn()
const mockGetState = vi.fn()
const capturedStreamListeners: Array<(data: unknown) => void> = []
const mockUnsubscribe = vi.fn()

const { mockReconcile, handlerSpy } = vi.hoisted(() => ({
  mockReconcile: vi.fn(() => Promise.resolve(true)),
  handlerSpy: vi.fn(),
}))

vi.mock('@/stores/chat/execution/sessionRunReconcile', () => ({
  reconcileSessionRunState: mockReconcile,
}))

vi.mock('@/stores/chat/stream/handlers/streamMessageHandler', () => ({
  createStreamMessageHandler: vi.fn(() => handlerSpy),
}))

function installTabtinApi(): void {
  Object.defineProperty(window, 'tabtin', {
    configurable: true,
    value: {
      agentEngine: {
        onStreamEvent: vi.fn((cb: (data: unknown) => void) => {
          capturedStreamListeners.push(cb)
          return mockUnsubscribe
        }),
        watchSession: mockWatchSession,
        unwatchSession: mockUnwatchSession,
        getState: mockGetState,
      },
    },
  })
}

function deps(_sessionId: string): ConversationStreamDeps {
  return {
    getContext: () => ({}),
    client: { sessions: { get: vi.fn() } } as never,
    addStreamingSession: vi.fn(),
    removeStreamingSession: vi.fn((sid: string) => {
      applyRuntimeRunSync(sid, {
        session_id: sid,
        run_id: null,
        status: 'idle',
        seq: Date.now(),
        queued_run_ids: [],
      })
    }),
    updateSessionTokenUsageInCaches: vi.fn(),
    updateSessionInCaches: vi.fn(),
  }
}

describe('#4985 busy retain：切走后台会话仍可收口侧栏 busy', () => {
  beforeEach(async () => {
    vi.useRealTimers()
    const { __resetBusyRetainForTest } = await import('../streamSources')
    __resetStreamHubsForTest()
    __resetBusyRetainForTest()
    vi.clearAllMocks()
    mockWatchSession.mockResolvedValue({ success: true })
    mockUnwatchSession.mockResolvedValue({ success: true })
    capturedStreamListeners.length = 0
    mockReconcile.mockClear()
    handlerSpy.mockReset()
    useChatRuntimeStore.setState({ runProjectionBySessionId: {}, subagentRunsBySessionId: {} })
    streamControlPorts.resetForTest()
    streamControlPorts.register({ handleSeqGapControl: vi.fn() })
    runtimeStoreAccess.resetAccessForTest()
    runtimeStoreAccess.resetStreamHandlerFactoryForTest()
    runtimeStoreAccess.registerAccess({
      get: () => useChatRuntimeStore.getState() as never,
      set: (() => {}) as never,
      flushRuntimeBatch: () => {},
      reconcileSubagentRunsFromArchive: () => Promise.resolve(),
    })
    runtimeStoreAccess.registerStreamHandlerFactory((d) => createStreamMessageHandler(d))
    installTabtinApi()
  })

  it('A busy → detach(切到 B) 不 unwatch；终态到达后 A idle 且补 unwatch', async () => {
    const { attachMainStream } = await import('../streamSources')
    const sessionA = 'session-a-busy'
    const detachA = attachMainStream(sessionA, deps(sessionA))

    seedBusy(sessionA)
    expect(isSessionBusy(sessionA)).toBe(true)
    expect(mockWatchSession).toHaveBeenCalledWith(sessionA)

    // 用户切到 B：UI unmount A
    detachA()

    // 关键：后台仍 busy 时不得撕掉观察意图，否则 lifecycle.end 进不了投影
    expect(mockUnwatchSession).not.toHaveBeenCalled()
    expect(mockReconcile).toHaveBeenCalledWith(sessionA, 'busy-retain')

    // 终态经仍存活的 IPC listener 到达（本机 publish / 遥控 WS 同源）
    const endEnvelope = {
      sessionId: sessionA,
      event: {
        type: 'agent.stream.lifecycle',
        payload: { phase: 'end', run_id: 'run-a' },
      },
    }
    // 驱动 retain 路径：模拟 handler 收到终态后走 removeStreamingSession → run_sync idle / reconcile
    // （真实链路由 lifecycleHandler 完成；此处用 choke point 验证 retain 释放）
    const listener = capturedStreamListeners[0]
    expect(listener).toBeDefined()
    listener(endEnvelope)
    __flushStreamDrainsForTest()

    // handler 被 mock 为空——直接走投影终态 + retain 释放契约
    applyRuntimeRunSync(sessionA, { session_id: sessionA, run_id: null, status: 'idle', seq: Date.now(), queued_run_ids: [] })
    expect(isSessionBusy(sessionA)).toBe(false)
    await vi.waitFor(() => {
      expect(mockUnwatchSession).toHaveBeenCalledWith(sessionA)
    })
    expect(mockUnsubscribe).toHaveBeenCalled()
  })

  it('lifecycle.start 已入 drain 但投影未 busy → 立即 detach 仍保留观察', async () => {
    const { attachMainStream } = await import('../streamSources')
    const sid = 'session-start-drain-race'
    handlerSpy.mockImplementation((event: { type: string; payload?: { phase?: string } }) => {
      if (event.type === 'agent.stream.lifecycle' && event.payload?.phase === 'start') {
        seedBusy(sid)
      }
    })
    const detach = attachMainStream(sid, deps(sid))

    capturedStreamListeners[0]({
      sessionId: sid,
      event: {
        type: 'agent.stream.lifecycle',
        payload: { phase: 'start', run_id: 'run-race' },
      },
    })
    expect(isSessionBusy(sid)).toBe(false)

    detach()

    expect(mockUnwatchSession).not.toHaveBeenCalled()
    __flushStreamDrainsForTest()
    expect(isSessionBusy(sid)).toBe(true)
  })

  it('success / error / cancel 终态统一释放 busy-retain', async () => {
    const { attachMainStream, releaseBusySessionRetain } = await import('../streamSources')
    for (const phase of ['end', 'error', 'terminated'] as const) {
      __resetStreamHubsForTest()
      const { __resetBusyRetainForTest } = await import('../streamSources')
      __resetBusyRetainForTest()
      vi.clearAllMocks()
      mockWatchSession.mockResolvedValue({ success: true })
      mockUnwatchSession.mockResolvedValue({ success: true })
      capturedStreamListeners.length = 0
      useChatRuntimeStore.setState({ runProjectionBySessionId: {}, subagentRunsBySessionId: {} })
      installTabtinApi()

      const sid = `session-${phase}`
      const detach = attachMainStream(sid, deps(sid))
      seedBusy(sid)
      detach()
      expect(mockUnwatchSession).not.toHaveBeenCalled()

      applyRuntimeRunSync(sid, { session_id: sid, run_id: null, status: 'idle', seq: Date.now(), queued_run_ids: [] })
      releaseBusySessionRetain(sid)
      expect(isSessionBusy(sid)).toBe(false)
      expect(mockUnwatchSession).toHaveBeenCalledWith(sid)
    }
  })

  it('idle detach 仍立即 unwatch（无 busy 不 retain）', async () => {
    const { attachMainStream } = await import('../streamSources')
    const detach = attachMainStream('session-idle', deps('session-idle'))
    detach()
    expect(mockUnwatchSession).toHaveBeenCalledWith('session-idle')
  })

  it('同 session 多 mount：最后一个 UI detach 才 teardown', async () => {
    const { attachMainStream } = await import('../streamSources')
    const firstDetach = attachMainStream('session-multi-mount', deps('session-multi-mount'))
    const secondDetach = attachMainStream('session-multi-mount', deps('session-multi-mount'))

    expect(mockWatchSession).toHaveBeenCalledTimes(1)
    firstDetach()
    expect(mockUnwatchSession).not.toHaveBeenCalled()
    secondDetach()
    expect(mockUnwatchSession).toHaveBeenCalledTimes(1)
  })

  it('#7016 StrictMode：旧 watch 回包不得补偿 unwatch 新挂载', async () => {
    let resolveFirstWatch!: (result: { success: boolean }) => void
    const firstWatch = new Promise<{ success: boolean }>((resolve) => {
      resolveFirstWatch = resolve
    })
    mockWatchSession
      .mockReturnValueOnce(firstWatch)
      .mockResolvedValueOnce({ success: true })

    const { attachMainStream } = await import('../streamSources')
    const firstDetach = attachMainStream('session-strict-remount', deps('session-strict-remount'))
    firstDetach()
    const secondDetach = attachMainStream('session-strict-remount', deps('session-strict-remount'))
    await vi.waitFor(() => expect(mockWatchSession).toHaveBeenCalledTimes(2))
    mockUnwatchSession.mockClear()

    // 旧挂载的 watch 最后才回包。它不能把第二次挂载的同 session watcher 删除。
    resolveFirstWatch({ success: true })
    await Promise.resolve()
    await Promise.resolve()
    expect(mockUnwatchSession).not.toHaveBeenCalled()

    secondDetach()
  })

  it('#7016 send-path recovery：confirmed live 仍幂等重申 watcher', async () => {
    const {
      attachMainStream,
      ensureLiveStreamIpc,
    } = await import('../streamSources')
    const sid = 'session-reassert-watch'
    const streamDeps = deps(sid)
    const detach = attachMainStream(sid, streamDeps)
    await vi.waitFor(() => expect(mockWatchSession).toHaveBeenCalledTimes(1))
    await Promise.resolve()
    await Promise.resolve()

    ensureLiveStreamIpc(sid, streamDeps)
    await vi.waitFor(() => expect(mockWatchSession).toHaveBeenCalledTimes(2))

    detach()
  })

  it('watchSession rejection：不留下假 watcher，并自动重试直至确认', async () => {
    vi.useFakeTimers()
    mockWatchSession
      .mockRejectedValueOnce(new Error('watch IPC failed'))
      .mockResolvedValueOnce({ success: true })
    const { attachMainStream } = await import('../streamSources')
    const detach = attachMainStream('session-watch-retry', deps('session-watch-retry'))

    expect(mockWatchSession).toHaveBeenCalledTimes(1)
    await Promise.resolve()
    await Promise.resolve()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(mockWatchSession).toHaveBeenCalledTimes(2)

    detach()
  })

  it('test reset 模拟 teardown：取消 IPC listener、detach hub 且 unwatch', async () => {
    const { attachMainStream, __resetBusyRetainForTest } = await import('../streamSources')
    attachMainStream('session-reset', deps('session-reset'))
    await Promise.resolve()
    vi.clearAllMocks()

    __resetBusyRetainForTest()

    expect(mockUnwatchSession).toHaveBeenCalledWith('session-reset')
    expect(mockUnsubscribe).toHaveBeenCalled()
  })

  it('test reset 释放并重装 idle listener，不重复累积', async () => {
    const { __resetBusyRetainForTest } = await import('../streamSources')
    const before = __getProjectionIdleListenerCountForTest()
    __resetBusyRetainForTest()
    __resetBusyRetainForTest()
    expect(__getProjectionIdleListenerCountForTest()).toBe(before)
  })

  it('遥控权威 miss：定期受控对账，5 分钟进入可观测超时但绝不猜 idle/unwatch', async () => {
    vi.useFakeTimers()
    const {
      attachMainStream,
      __isBusyRetainedForTest,
      __isBusyRetainTimeoutObservedForTest,
    } = await import('../streamSources')
    const sid = 'session-remote-miss'
    const detach = attachMainStream(sid, deps(sid))
    seedBusy(sid)
    detach()
    expect(__isBusyRetainedForTest(sid)).toBe(true)
    mockReconcile.mockClear()
    mockUnwatchSession.mockClear()

    await vi.advanceTimersByTimeAsync(5 * 60_000)

    expect(mockReconcile).toHaveBeenCalled()
    expect(__isBusyRetainTimeoutObservedForTest(sid)).toBe(true)
    expect(isSessionBusy(sid)).toBe(true)
    expect(mockUnwatchSession).not.toHaveBeenCalled()
  })

  it('orphan queuedRunIds：run_sync queued 后对账可清', async () => {
    const { applyRuntimeRunSync, applyRunReconcile, getSessionRunProjection } = await import(
      '@/stores/chat/execution/sessionRunProjection'
    )
    const sid = 'session-orphan-queue'
    applyRuntimeRunSync(sid, {
      session_id: sid,
      run_id: 'run-active',
      status: 'queued',
      seq: 1,
      queued_run_ids: ['orphan-run'],
    })
    // 当前契约：排队非空 → 仍 busy（与 runtime isBusy 对齐）
    expect(isSessionBusy(sid)).toBe(true)
    expect(getSessionRunProjection(sid)?.queuedRunIds).toEqual(['orphan-run'])
    // 权威 idle 对账可强制收口（含清排队）
    applyRunReconcile(sid, { busy: false, queuedRunIds: [] })
    expect(isSessionBusy(sid)).toBe(false)
  })

  it('#11158 父轮 idle 时子代理仍 pending：不 unwatch；子终态后才拆', async () => {
    const { attachMainStream, releaseBusySessionRetain } = await import('../streamSources')
    const sid = 'session-parent-idle-child-pending'
    useChatRuntimeStore.setState({
      subagentRunsBySessionId: {
        [sid]: [{ subagentRunId: 'child-1', status: 'pending' }],
      },
    })
    const detach = attachMainStream(sid, deps(sid))
    seedBusy(sid)
    detach()
    expect(mockUnwatchSession).not.toHaveBeenCalled()

    applyRuntimeRunSync(sid, {
      session_id: sid,
      run_id: null,
      status: 'idle',
      seq: Date.now(),
      queued_run_ids: [],
    })
    expect(isSessionBusy(sid)).toBe(false)
    expect(mockUnwatchSession).not.toHaveBeenCalled()

    useChatRuntimeStore.setState({
      subagentRunsBySessionId: {
        [sid]: [{ subagentRunId: 'child-1', status: 'completed' }],
      },
    })
    releaseBusySessionRetain(sid)
    expect(mockUnwatchSession).toHaveBeenCalledWith(sid)
  })

  it('#11158 父轮 idle 且 store 尚无子代理：对账完成前不 unwatch', async () => {
    let releaseReconcile!: () => void
    const reconcileGate = new Promise<void>((resolve) => {
      releaseReconcile = resolve
    })
    runtimeStoreAccess.registerAccess({
      get: () => useChatRuntimeStore.getState() as never,
      set: (() => {}) as never,
      flushRuntimeBatch: () => {},
      reconcileSubagentRunsFromArchive: async (sessionId: string) => {
        await reconcileGate
        useChatRuntimeStore.setState({
          subagentRunsBySessionId: {
            [sessionId]: [{ subagentRunId: 'child-late', status: 'pending' }],
          },
        })
      },
    })

    const { attachMainStream, releaseBusySessionRetain } = await import('../streamSources')
    const sid = 'session-parent-idle-store-empty'
    const detach = attachMainStream(sid, deps(sid))
    seedBusy(sid)
    detach()
    expect(mockUnwatchSession).not.toHaveBeenCalled()

    applyRuntimeRunSync(sid, {
      session_id: sid,
      run_id: null,
      status: 'idle',
      seq: Date.now(),
      queued_run_ids: [],
    })
    await Promise.resolve()
    expect(isSessionBusy(sid)).toBe(false)
    expect(mockUnwatchSession).not.toHaveBeenCalled()

    releaseReconcile()
    await vi.waitFor(() => {
      expect(
        useChatRuntimeStore.getState().subagentRunsBySessionId[sid]?.[0]?.status,
      ).toBe('pending')
    })
    expect(mockUnwatchSession).not.toHaveBeenCalled()

    useChatRuntimeStore.setState({
      subagentRunsBySessionId: {
        [sid]: [{ subagentRunId: 'child-late', status: 'completed' }],
      },
    })
    releaseBusySessionRetain(sid)
    expect(mockUnwatchSession).toHaveBeenCalledWith(sid)
  })
})
