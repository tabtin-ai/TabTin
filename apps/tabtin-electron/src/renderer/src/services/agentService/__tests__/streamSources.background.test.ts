import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { IpcStreamEnvelope } from '@shared/ipc-stream'
import type { AgentStreamMessage } from '@/stores/chat/stream/handlers/streamMessageHandler'
import type { ConversationStreamDeps } from '../streamSources'
import { runtimeStoreAccess } from '../runtimeStoreAccess'
import { streamControlPorts } from '../streamControlPorts'
import { __resetStreamHubsForTest, __flushStreamDrainsForTest } from '../index'
import { createStreamMessageHandler } from '@/stores/chat/stream/handlers/streamMessageHandler'

/**
 *  单源终态：attachMainStream 挂常驻源，envelope 转交**真实枢纽** `dispatch`。
 * 无活跃轮 → 观察形态（message_persisted 收敛 / HITL 镜像 / ingest / push reconcile /
 * terminal 清 streaming）。本测试覆盖后台 push（观察形态），经真实枢纽驱动。
 */

const handlerSpy = vi.fn()
vi.mock('@/stores/chat/stream/handlers/streamMessageHandler', () => ({
  createStreamMessageHandler: vi.fn(() => handlerSpy),
}))
vi.mock('@/stores/useChatRuntimeStore', () => ({
  useChatRuntimeStore: { getState: () => ({}), setState: vi.fn() },
}))
vi.mock('@/stores/chat/execution/sessionRunReconcile', () => ({
  reconcileSessionRunState: vi.fn(() => Promise.resolve(false)),
}))

const {
  capturedStreamListeners,
  mockUnsubscribe,
  reconcileArchiveSpy,
} = vi.hoisted(() => ({
  capturedStreamListeners: [] as Array<(data: unknown) => void>,
  mockUnsubscribe: vi.fn(),
  reconcileArchiveSpy: vi.fn(),
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

function envelope(sessionId: string, event: AgentStreamMessage): IpcStreamEnvelope<AgentStreamMessage> {
  return { sessionId, event }
}

interface BaseOptions {
  sessionId: string
  spaceId?: string
  removeStreamingSession: ReturnType<typeof vi.fn>
}

function makeBaseOptions(overrides: Partial<BaseOptions> = {}): BaseOptions {
  return {
    sessionId: 'session-1',
    removeStreamingSession: vi.fn(),
    ...overrides,
  }
}

function toDeps(opts: BaseOptions): ConversationStreamDeps {
  return {
    getContext: () => ({ spaceId: opts.spaceId }),
    client: { sessions: { get: vi.fn() } } as never,
    addStreamingSession: vi.fn(),
    removeStreamingSession: opts.removeStreamingSession,
    updateSessionTokenUsageInCaches: vi.fn(),
    updateSessionInCaches: vi.fn(),
  }
}

async function attach(opts: BaseOptions): Promise<() => void> {
  const { attachMainStream } = await import('../streamSources')
  return attachMainStream(opts.sessionId, toDeps(opts))
}

function drive(event: unknown): void {
  capturedStreamListeners[0](event)
  __flushStreamDrainsForTest()
}

describe('attachMainStream · 观察形态分发（后台 push / 无活跃轮）', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    capturedStreamListeners.length = 0
    handlerSpy.mockClear()
    await import('../streamSources')
    __resetStreamHubsForTest()
    streamControlPorts.resetForTest()
    streamControlPorts.register({ handleSeqGapControl: vi.fn() })
    runtimeStoreAccess.resetAccessForTest()
    runtimeStoreAccess.resetStreamHandlerFactoryForTest()
    runtimeStoreAccess.registerAccess({
      get: () => ({}) as never,
      set: (() => {}) as never,
      flushRuntimeBatch: () => {},
      reconcileSubagentRunsFromArchive: (sid, opts) => {
        reconcileArchiveSpy(sid, opts)
        return Promise.resolve()
      },
    })
    runtimeStoreAccess.registerStreamHandlerFactory((d) => createStreamMessageHandler(d))
    installTabtinApi()
  })

  it('消费本 session 的后台 push 事件（观察形态 ingest）', async () => {
    await attach(makeBaseOptions())
    const event: AgentStreamMessage = {
      type: 'agent.stream.lifecycle',
      payload: { phase: 'start', run_id: 'run-push' },
    }
    drive(envelope('session-1', event))
    expect(handlerSpy).toHaveBeenCalledWith(event)
  }, 20_000)

  it('push notification 到达即触发子 Agent 对账 reconcile', async () => {
    await attach(makeBaseOptions({ spaceId: 'space-1' }))
    const pushUser: AgentStreamMessage = {
      type: 'agent.stream.user',
      payload: {
        client_event_id: 'push-user-1',
        triggered_by: 'push-notification',
        content: '<task-notification kind="subagent-completed" />',
      },
    }
    drive(envelope('session-1', pushUser))
    expect(handlerSpy).toHaveBeenCalledWith(pushUser)
    expect(reconcileArchiveSpy).toHaveBeenCalledWith('session-1', { spaceId: 'space-1' })
  })

  it('无条件投递全部事件（含 streaming 翻转后 + 后续 message_start）', async () => {
    await attach(makeBaseOptions())
    const start: AgentStreamMessage = { type: 'agent.stream.lifecycle', payload: { phase: 'start', run_id: 'run-push' } }
    const messageStart: AgentStreamMessage = { type: 'agent.stream.message_start', payload: { message_id: 'assistant-1', role: 'assistant' } }
    const end: AgentStreamMessage = { type: 'agent.stream.lifecycle', payload: { phase: 'end', run_id: 'run-push' } }
    const afterTerminal: AgentStreamMessage = { type: 'agent.stream.message_start', payload: { message_id: 'local-run-after-terminal', role: 'assistant' } }

    drive(envelope('session-1', start))
    drive(envelope('session-1', messageStart))
    drive(envelope('session-1', end))
    drive(envelope('session-1', afterTerminal))

    expect(handlerSpy).toHaveBeenCalledTimes(4)
    expect(handlerSpy).toHaveBeenNthCalledWith(1, start)
    expect(handlerSpy).toHaveBeenNthCalledWith(4, afterTerminal)
  })

  it('message_persisted 与其它事件一样进入共享 handler', async () => {
    await attach(makeBaseOptions())
    const persistedEvent = {
      type: 'agent.stream.message_persisted',
      payload: {
        message_ids: [
          { client_event_id: 'push-user-1', server_id: 'server-user-1' },
          { client_event_id: 'assistant-client-1', server_id: 'server-assistant-1' },
        ],
      },
    }
    drive(envelope('session-1', persistedEvent as AgentStreamMessage))
    expect(handlerSpy).toHaveBeenCalledWith(persistedEvent)
  })

  it('普通 user 事件不触发 archive reconcile', async () => {
    await attach(makeBaseOptions())
    const normalUser: AgentStreamMessage = {
      type: 'agent.stream.user',
      payload: { client_event_id: 'user-1', content: 'hello' },
    }
    drive(envelope('session-1', normalUser))
    expect(handlerSpy).toHaveBeenCalledWith(normalUser)
    expect(reconcileArchiveSpy).not.toHaveBeenCalled()
  })

  it('无活跃轮收到 terminal sentinel 时清理 streaming 状态', async () => {
    const opts = makeBaseOptions()
    await attach(opts)
    drive(envelope('session-1', { type: 'agent.stream.lifecycle', payload: { phase: 'start', run_id: 'run-push' } }))
    drive({ sessionId: 'session-1', terminal: { reason: 'errored' } })
    expect(opts.removeStreamingSession).toHaveBeenCalledWith('session-1', { clearSeqGapSync: true })
  })
})
