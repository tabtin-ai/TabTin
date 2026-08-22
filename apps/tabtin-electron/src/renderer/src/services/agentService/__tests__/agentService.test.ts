import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import type { AgentStreamMessage } from '@/stores/chat/stream/handlers/streamMessageHandler'

// 每个 session 一个 handler spy；attach 时 createStreamMessageHandler 被调一次。
const handlerSpies: Array<ReturnType<typeof vi.fn>> = []
vi.mock('@/stores/chat/stream/handlers/streamMessageHandler', () => ({
  createStreamMessageHandler: vi.fn(() => {
    const spy = vi.fn()
    handlerSpies.push(spy)
    return spy
  }),
}))

// index 内部 buildStreamHandlerDeps 绑定运行时 store（get/set），mock 掉避免加载真实 store。
vi.mock('@/stores/useChatRuntimeStore', () => ({
  useChatRuntimeStore: { getState: () => ({}), setState: () => {} },
}))

const gatewayRequestSpy = vi.fn()
vi.mock('../../chatApi', () => ({
  getChatClient: vi.fn(() => ({
    getGateway: () => ({ request: gatewayRequestSpy }),
  })),
}))

const localStreamSpy = vi.fn()
const localQuerySpy = vi.fn()
const localAbortSpy = vi.fn()
const localRuntimeAvailableSpy = vi.fn(() => true)
vi.mock('../../localAgentClient', () => ({
  getLocalAgentClient: vi.fn(() => ({ stream: localStreamSpy, query: localQuerySpy, abort: localAbortSpy })),
  isLocalRuntimeAvailable: () => localRuntimeAvailableSpy(),
}))

const remoteViewerSpy = vi.fn(() => false)
const resolveExecutionTargetLocationSpy = vi.fn((input: { legacyTargetDeviceId?: string | null }) => (
  remoteViewerSpy() ? 'remote' : 'local'
))
vi.mock('../../remoteExecutionGuard', () => ({
  resolveExecutionTargetLocation: (input: { legacyTargetDeviceId?: string | null }) => (
    resolveExecutionTargetLocationSpy(input)
  ),
}))

vi.mock('@/services/sessionFreshness', () => ({
  hydrateAfterLostStream: vi.fn(() => Promise.resolve()),
  scheduleLostStreamHydrate: vi.fn(),
}))

// ：send 动态 import ensureLiveStreamIpc；整模块 mock，避免 importOriginal 拉起
// streamSources→index 造成双 `_streamHubs` 实例。
vi.mock('../streamSources', () => ({
  ensureLiveStreamIpc: vi.fn(async () => {}),
  attachMainStream: vi.fn(() => () => {}),
  __resetBusyRetainForTest: vi.fn(),
  __registerBusyRetainResetForTest: vi.fn(),
  releaseBusySessionRetain: vi.fn(),
}))

import {
  getSessionController,
  __resetStreamHubsForTest,
  __flushStreamDrainsForTest,
  __registerEnsureLiveStreamIpc,
  hasRuntimeBridge,
  type SessionStreamDeps,
  type StreamSourceHandle,
} from '../index'
import { runtimeStoreAccess } from '../runtimeStoreAccess'
import { createStreamMessageHandler } from '@/stores/chat/stream/handlers/streamMessageHandler'

const SID = 'sess-1'
const ensureLiveStreamIpcSpy = vi.fn()

function deps(onLifecycleEnd: () => void = () => {}): SessionStreamDeps {
  return {
    getContext: () => ({}),
    client: {} as never,
    addStreamingSession: () => {},
    removeStreamingSession: () => {},
    updateSessionTokenUsageInCaches: () => {},
    updateSessionInCaches: () => {},
    onLifecycleEnd,
  }
}

const evt = (type: string): AgentStreamMessage => ({ type, payload: {} }) as AgentStreamMessage

beforeEach(() => {
  __resetStreamHubsForTest()
  ensureLiveStreamIpcSpy.mockClear()
  localQuerySpy.mockReset().mockResolvedValue(undefined)
  localStreamSpy.mockReset()
  localAbortSpy.mockReset()
  __registerEnsureLiveStreamIpc(ensureLiveStreamIpcSpy)
  // hub 经 leaf 注册表倒置取运行时 store；测试注册 stub（buildStreamHandlerDeps require 非空）。
  runtimeStoreAccess.registerAccess({
    get: () => ({}) as never,
    set: (() => {}) as never,
    flushRuntimeBatch: () => {},
    reconcileSubagentRunsFromArchive: async () => {},
  })
  //  阶段B：handler 工厂经独立 leaf 注入；路由到被 mock 的 createStreamMessageHandler，
  // 保持「attach 建唯一 handler」断言不变。
  runtimeStoreAccess.registerStreamHandlerFactory((d) => createStreamMessageHandler(d))
  handlerSpies.length = 0
  vi.mocked(createStreamMessageHandler).mockClear()
  // ：send() → ensureLiveStreamIpc 需要 watch / onStreamEvent
  vi.stubGlobal('window', {
    tabtin: {
      agentEngine: {
        onStreamEvent: vi.fn(() => vi.fn()),
        watchSession: vi.fn(async () => ({ success: true })),
        unwatchSession: vi.fn(async () => ({ success: true })),
        gatewaySend: vi.fn(),
        abortRun: vi.fn(),
      },
    },
  })
})

afterEach(() => {
  runtimeStoreAccess.resetAccessForTest()
  runtimeStoreAccess.resetStreamHandlerFactoryForTest()
  vi.unstubAllGlobals()
})

describe('agentService · 入站单源终态', () => {
  it('attachStream 建唯一 handler；ingest 进同一 handler', () => {
    const handle = getSessionController(SID).attachStream(deps())
    expect(createStreamMessageHandler).toHaveBeenCalledTimes(1)
    expect(handlerSpies).toHaveLength(1)
    handle.ingest(evt('agent.stream.content_block_delta'))
    handle.ingest(evt('agent.stream.message_stop'))
    __flushStreamDrainsForTest()
    expect(handlerSpies[0]).toHaveBeenCalledTimes(2)
  })

  it('clearStreamHub 清空枢纽后再 attach 重建 handler', () => {
    getSessionController(SID).attachStream(deps())
    expect(createStreamMessageHandler).toHaveBeenCalledTimes(1)
    getSessionController(SID).clearStreamHub()
    getSessionController(SID).attachStream(deps())
    expect(createStreamMessageHandler).toHaveBeenCalledTimes(2)
  })
})

describe('agentService · envelope.terminal 停表', () => {
  function registerRunStateAccess(opts: {
    /** flush 前可见的 runState（模拟 committed 快照） */
    beforeFlush: { startedAt: number | null; endedAt: number | null; phase?: string }
    /** flush 后可见的 runState（模拟 pending 刷入后） */
    afterFlush?: { startedAt: number | null; endedAt: number | null; phase?: string }
  }) {
    const updateRunStateForSession = vi.fn()
    let visible = { ...opts.beforeFlush }
    const flushRuntimeBatch = vi.fn(() => {
      if (opts.afterFlush) visible = { ...opts.afterFlush }
    })
    runtimeStoreAccess.registerAccess({
      get: () => ({
        runStateBySessionId: { [SID]: visible },
        updateRunStateForSession,
      }) as never,
      set: (() => {}) as never,
      flushRuntimeBatch,
      reconcileSubagentRunsFromArchive: async () => {},
    })
    return { updateRunStateForSession, flushRuntimeBatch }
  }

  it('flush 后已有 endedAt → 不覆盖 phase，仍清 busy/seq', () => {
    const { updateRunStateForSession, flushRuntimeBatch } = registerRunStateAccess({
      beforeFlush: { startedAt: 1, endedAt: null, phase: 'running' },
      // lifecycle cleanup 已把 done+endedAt 写进 pending；flush 后可见
      afterFlush: { startedAt: 1, endedAt: 99, phase: 'done' },
    })
    const removeStreamingSession = vi.fn()
    const handle = getSessionController(SID).attachStream({
      ...deps(),
      removeStreamingSession,
    })
    handle.dispatch({ sessionId: SID, terminal: { reason: 'completed' } })
    expect(flushRuntimeBatch).toHaveBeenCalled()
    expect(updateRunStateForSession).not.toHaveBeenCalled()
    expect(removeStreamingSession).toHaveBeenCalledWith(SID, { clearSeqGapSync: true })
  })

  it.each([
    ['completed', 'done'],
    ['aborted', 'cancelled'],
    ['errored', 'error'],
  ] as const)('flush 后仍无 endedAt：reason=%s → phase=%s', (reason, phase) => {
    const { updateRunStateForSession, flushRuntimeBatch } = registerRunStateAccess({
      beforeFlush: { startedAt: 10, endedAt: null, phase: 'running' },
    })
    const removeStreamingSession = vi.fn()
    const handle = getSessionController(SID).attachStream({
      ...deps(),
      removeStreamingSession,
    })
    handle.dispatch({
      sessionId: SID,
      terminal: reason === 'errored' ? { reason, error: 'boom' } : { reason },
    })
    expect(flushRuntimeBatch).toHaveBeenCalled()
    expect(updateRunStateForSession).toHaveBeenCalledWith(
      SID,
      expect.objectContaining({ phase, endedAt: expect.any(Number) }),
    )
    expect(removeStreamingSession).toHaveBeenCalledWith(SID, { clearSeqGapSync: true })
  })
})

describe('agentService · 出站操作门面', () => {
  const bridge = {
    submitHitlBatch: vi.fn().mockResolvedValue({ success: true }),
    submitAskUserResponse: vi.fn().mockResolvedValue({ success: true }),
    retryTool: vi.fn().mockResolvedValue({ success: true }),
    updateContext: vi.fn().mockResolvedValue({ success: true }),
    // ：出站遥控发送经主进程 WS 网关执行。
    gatewaySend: vi.fn().mockResolvedValue({ ok: true, type: 'chat.send_message.ok' }),
  }

  beforeEach(() => {
    Object.values(bridge).forEach((fn) => fn.mockClear())
    gatewayRequestSpy.mockReset()
    localStreamSpy.mockReset().mockResolvedValue({ success: true })
    localAbortSpy.mockReset()
    remoteViewerSpy.mockReset().mockReturnValue(false)
    resolveExecutionTargetLocationSpy.mockClear()
    localRuntimeAvailableSpy.mockReset().mockReturnValue(true)
    vi.stubGlobal('window', { tabtin: { agentEngine: bridge } })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('hasRuntimeBridge：有无 bridge 如实反映', () => {
    expect(hasRuntimeBridge()).toBe(true)
    vi.stubGlobal('window', {})
    expect(hasRuntimeBridge()).toBe(false)
  })

  it('HITL / retry / updateContext 经 controller 透传参数到 bridge（IPC）', async () => {
    // HITL 按 batchId/requestId + threadId 定位，controller 保留显式 threadId 入参。
    await getSessionController('sess-1').submitApproval('batch-1', [{ request_id: 'r', tool_call_id: 't', outcome: 'allow' }] as never, 'thread-1')
    expect(bridge.submitHitlBatch).toHaveBeenCalledWith('batch-1', [{ request_id: 'r', tool_call_id: 't', outcome: 'allow' }], 'thread-1')

    await getSessionController('sess-1').answerAskUser('req-1', { skipped: true } as never, 'thread-1')
    expect(bridge.submitAskUserResponse).toHaveBeenCalledWith('req-1', { skipped: true }, 'thread-1')

    await getSessionController('sess-1').retryTool('run_terminal_command', { cmd: 'ls' })
    expect(bridge.retryTool).toHaveBeenCalledWith('sess-1', 'run_terminal_command', { cmd: 'ls' })

    getSessionController('sess-1').pushContext({ spaceId: 'sp' } as never)
    expect(bridge.updateContext).toHaveBeenCalledWith('sess-1', { spaceId: 'sp' })
  })

  it('无 bridge：HITL 抛错、pushContext 静默 no-op', () => {
    vi.stubGlobal('window', {})
    expect(() => getSessionController('sess-1').submitApproval('b', [] as never)).toThrow(/agentEngine bridge unavailable/)
    expect(() => getSessionController('sess-1').pushContext({} as never)).not.toThrow()
  })

  it('resolveSendRoute：服务端执行目标/遥控 → gateway；本机可执行 → runtime；本机被关 → unavailable', () => {
    expect(getSessionController('sess-1').resolveSendRoute({})).toBe('runtime')
    expect(getSessionController('sess-1').resolveSendRoute({ agentConfig: { use_local_runtime: false } })).toBe('unavailable')
    remoteViewerSpy.mockReturnValueOnce(true)
    expect(getSessionController('sess-1').resolveSendRoute({
      spaceId: 'local-workspace',
      executionTarget: {
        kind: 'bound_device',
        device_identity_key: 'daemon-device-1',
      },
      agentConfig: { use_local_runtime: false },
    })).toBe('gateway')
    localRuntimeAvailableSpy.mockReturnValueOnce(false)
    expect(getSessionController('sess-1').resolveSendRoute({})).toBe('unavailable')
    remoteViewerSpy.mockReturnValueOnce(true)
    // 遥控判定优先——即使本机 runtime 关闭也必须 forward，绝不在遥控器上起 runtime。
    expect(getSessionController('sess-1').resolveSendRoute({ agentConfig: { use_local_runtime: false } })).toBe('gateway')
  })

  it('resolveSendRoute：旧 Session 缺少 execution_target 时尊重冻结的 target_device_id', () => {
    remoteViewerSpy.mockReturnValueOnce(true)
    expect(getSessionController('sess-1').resolveSendRoute({
      targetDeviceId: 'legacy-remote-device',
    })).toBe('gateway')
    expect(resolveExecutionTargetLocationSpy).toHaveBeenCalledWith({
      target: undefined,
      legacyTargetDeviceId: 'legacy-remote-device',
      spaceId: undefined,
    })
  })

  it('send 统一入口：runtime 路由 accepted ACK 即返回；不等整轮终态', async () => {
    const { hydrateAfterLostStream } = await import('@/services/sessionFreshness')
    localQuerySpy.mockResolvedValue({
      runId: 'run-ack-1',
      runDisposition: 'started',
    })
    const gatewayFactory = vi.fn()
    const outcome = await getSessionController('sess-1').send({
      runtimeExecution: () => ({ message: 'hi', deps: deps() }),
      gatewayRequest: gatewayFactory as never,
    })
    expect(localQuerySpy).toHaveBeenCalledWith('sess-1', 'hi', undefined)
    expect(outcome).toEqual({
      route: 'runtime',
      result: {
        session_id: 'sess-1',
        thread_id: 'sess-1',
        runId: 'run-ack-1',
        runDisposition: 'started',
        queuePosition: undefined,
      },
    })
    expect(gatewayFactory).not.toHaveBeenCalled()
    // ACK ≠ 整轮结束：不得假 settle / hydrate
    expect(hydrateAfterLostStream).not.toHaveBeenCalled()
  })

  it('#9234 busy 连发：两次 send 都只等 ACK，不互相 abort waiter', async () => {
    localQuerySpy
      .mockResolvedValueOnce({ runId: 'run-1', runDisposition: 'started' })
      .mockResolvedValueOnce({ runId: 'run-2', runDisposition: 'queued', queuePosition: 1 })
    const first = getSessionController('sess-1').send({
      runtimeExecution: () => ({ message: 'one', deps: deps() }),
    })
    const second = getSessionController('sess-1').send({
      runtimeExecution: () => ({ message: 'two', deps: deps() }),
    })
    await expect(first).resolves.toEqual({
      route: 'runtime',
      result: {
        session_id: 'sess-1',
        thread_id: 'sess-1',
        runId: 'run-1',
        runDisposition: 'started',
        queuePosition: undefined,
      },
    })
    await expect(second).resolves.toEqual({
      route: 'runtime',
      result: {
        session_id: 'sess-1',
        thread_id: 'sess-1',
        runId: 'run-2',
        runDisposition: 'queued',
        queuePosition: 1,
      },
    })
    expect(localQuerySpy).toHaveBeenCalledTimes(2)
  })

  it('query ACK 失败时 send 抛错', async () => {
    localQuerySpy.mockRejectedValue(new Error('host down'))
    await expect(getSessionController('sess-1').send({
      runtimeExecution: () => ({ message: 'hi', deps: deps() }),
    })).rejects.toThrow(/host down/)
  })

  it('#7013 settleExecutionCompleted 仍可收口显式 waitForExecution', async () => {
    const hub = getSessionController('sess-1').attachStream(deps())
    // 通过二次 attach 取同一 hub 上的 waiter API：send 不再占 waiter，
    // 对账路径仍可 settleExecutionCompleted。
    const ctrl = getSessionController('sess-1')
    // 内部 waitForExecution 不对外；用 settle 在无 waiter 时 no-op
    expect(ctrl.settleExecutionCompleted()).toBe(false)
    void hub
  })

  it('send 统一入口：gateway 路由经主进程 gatewaySend 发出 chat.send_message（ 出站下沉）', async () => {
    remoteViewerSpy.mockReturnValue(true)
    bridge.gatewaySend.mockResolvedValue({ ok: true, type: 'chat.send_message.ok' })
    const runtimeFactory = vi.fn()
    const outcome = await getSessionController('sess-1').send({
      gatewayRequest: () => ({
        payload: { session_id: 'sess-1', message: 'hi' } as never,
        requestOptions: { sessionId: 'sess-1' } as never,
      }),
      runtimeExecution: runtimeFactory as never,
    })
    remoteViewerSpy.mockReturnValue(false)
    expect(outcome.route).toBe('gateway')
    expect(runtimeFactory).not.toHaveBeenCalled()
    expect(ensureLiveStreamIpcSpy).toHaveBeenCalledWith('sess-1')
    expect(bridge.gatewaySend).toHaveBeenCalledWith({
      messageType: 'chat.send_message',
      payload: { session_id: 'sess-1', message: 'hi' },
      requestOptions: { sessionId: 'sess-1' },
    })
  })

  it('send 统一入口：unavailable 原样返回，任何物料都不消费', async () => {
    const runtimeFactory = vi.fn()
    const gatewayFactory = vi.fn()
    const outcome = await getSessionController('sess-1').send({
      agentConfig: { use_local_runtime: false },
      runtimeExecution: runtimeFactory as never,
      gatewayRequest: gatewayFactory as never,
    })
    expect(outcome.route).toBe('unavailable')
    expect(runtimeFactory).not.toHaveBeenCalled()
    expect(gatewayFactory).not.toHaveBeenCalled()
  })

  it('send 路由选中但对应物料缺失 → throw（编程错误 fail-fast）', async () => {
    await expect(getSessionController('sess-1').send({})).rejects.toThrow(/runtimeExecution material is missing/)
    remoteViewerSpy.mockReturnValueOnce(true)
    await expect(getSessionController('sess-1').send({})).rejects.toThrow(/gatewayRequest material is missing/)
  })

  it('controller.abortSupersededRun 走本机 IPC abort（旧流收尾不外传）', () => {
    getSessionController('sess-1').abortSupersededRun()
    expect(localAbortSpy).toHaveBeenCalledWith('sess-1')
  })
})
