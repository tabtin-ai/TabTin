import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { IpcStreamEnvelope } from '@shared/ipc-stream'
import type { AgentStreamMessage } from '@/stores/chat/stream/handlers/streamMessageHandler'
import type { ConversationStreamDeps } from '../streamSources'
import { runtimeStoreAccess } from '../runtimeStoreAccess'
import { streamControlPorts } from '../streamControlPorts'
import { __resetStreamHubsForTest, __flushStreamDrainsForTest } from '../index'
import { createStreamMessageHandler } from '@/stores/chat/stream/handlers/streamMessageHandler'

/**
 *  单源终态：渲染进程不区分来源，来源分发收口到 `SessionStreamHub.dispatch`。
 * control 帧走控制端口；所有业务事件（含 HITL）无条件进入共享 handler。
 */

const handlerSpy = vi.fn()
vi.mock('@/stores/chat/stream/handlers/streamMessageHandler', () => ({
  createStreamMessageHandler: vi.fn(() => handlerSpy),
}))
vi.mock('@/stores/useChatRuntimeStore', () => ({
  useChatRuntimeStore: { getState: () => ({}), setState: () => {} },
}))
vi.mock('@/stores/chat/execution/sessionRunReconcile', () => ({
  reconcileSessionRunState: vi.fn(() => Promise.resolve(false)),
}))

const {
  capturedStreamListeners,
  mockUnsubscribe,
  seqGapSpy,
} = vi.hoisted(() => ({
  capturedStreamListeners: [] as Array<(data: unknown) => void>,
  mockUnsubscribe: vi.fn(),
  seqGapSpy: vi.fn((_sessionId: string) => {}),
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
        watchSession: vi.fn(async () => ({ success: true })),
        unwatchSession: vi.fn(async () => ({ success: true })),
      },
    },
  })
}

function eventEnvelope(sessionId: string, event: AgentStreamMessage): IpcStreamEnvelope<AgentStreamMessage> {
  return { sessionId, event }
}

function toDeps(): ConversationStreamDeps {
  return {
    getContext: () => ({ spaceId: 'space-1' }),
    client: { sessions: { get: vi.fn() } } as never,
    addStreamingSession: vi.fn(),
    removeStreamingSession: vi.fn(),
    updateSessionTokenUsageInCaches: vi.fn(),
    updateSessionInCaches: vi.fn(),
  }
}

async function attach(sessionId = 'session-a'): Promise<() => void> {
  const { attachMainStream } = await import('../streamSources')
  return attachMainStream(sessionId, toDeps())
}

describe('attachMainStream · 统一单流', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    capturedStreamListeners.length = 0
    handlerSpy.mockClear()
    // 先加载 streamSources 以登记 busy-retain reset hook，再清 hub
    await import('../streamSources')
    __resetStreamHubsForTest()
    streamControlPorts.resetForTest()
    streamControlPorts.register({ handleSeqGapControl: (sid) => seqGapSpy(sid) })
    runtimeStoreAccess.resetAccessForTest()
    runtimeStoreAccess.resetStreamHandlerFactoryForTest()
    runtimeStoreAccess.registerAccess({
      get: () => ({}) as never,
      set: (() => {}) as never,
      flushRuntimeBatch: () => {},
      reconcileSubagentRunsFromArchive: async () => {},
    })
    runtimeStoreAccess.registerStreamHandlerFactory((d) => createStreamMessageHandler(d))
    installTabtinApi()
  })

  it('control:seq-gap 帧 → 安排补拉（不 ingest）', async () => {
    await attach()
    capturedStreamListeners[0]({ sessionId: 'session-a', control: 'seq-gap' })
    __flushStreamDrainsForTest()
    expect(seqGapSpy).toHaveBeenCalledWith('session-a')
    expect(handlerSpy).not.toHaveBeenCalled()
  })

  it('HITL 事件与其它业务事件一样进入共享 handler', async () => {
    await attach()
    const approval: AgentStreamMessage = {
      type: 'agent.stream.approval_requested',
      payload: { batch_id: 'b1' },
    } as AgentStreamMessage
    capturedStreamListeners[0](eventEnvelope('session-a', approval))
    __flushStreamDrainsForTest()
    expect(handlerSpy).toHaveBeenCalledWith(approval)
  })

  it('普通事件 → ingest 进共享 handler', async () => {
    await attach()
    const event = { type: 'agent.stream.content_block_delta', payload: { message_id: 'm1' } } as AgentStreamMessage
    capturedStreamListeners[0](eventEnvelope('session-a', event))
    __flushStreamDrainsForTest()
    expect(handlerSpy).toHaveBeenCalledWith(event)
  })

  it('非本 session 的 envelope 直接忽略', async () => {
    await attach('session-a')
    capturedStreamListeners[0]({ sessionId: 'session-other', control: 'seq-gap' })
    capturedStreamListeners[0](eventEnvelope('session-other', { type: 'agent.stream.content_block_delta', payload: {} } as AgentStreamMessage))
    __flushStreamDrainsForTest()
    expect(seqGapSpy).not.toHaveBeenCalled()
    expect(handlerSpy).not.toHaveBeenCalled()
  })
})
