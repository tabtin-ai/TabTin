import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentStreamEvents } from '@tabtin/ws-gateway-client'
import { StreamEvents } from '@tabtin/agent-wire'
import type { ChatMessage } from '@tabtin/chat-client'
import type { RunState } from '../../../shared/types'

const { mockAgentError } = vi.hoisted(() => ({
  mockAgentError: vi.fn(),
}))

const { mockCleanupSessionOnTerminal } = vi.hoisted(() => ({
  mockCleanupSessionOnTerminal: vi.fn(() => false),
}))

const { mockUpdateSessionMessages } = vi.hoisted(() => ({
  mockUpdateSessionMessages: vi.fn(),
}))

const hitlStoreAccessMock = vi.hoisted(() => ({
  access: null as import('../../../shared/storeAccessRegistry').HitlStoreAccess | null,
}))

const { mockUseChatStoreSetState } = vi.hoisted(() => ({
  mockUseChatStoreSetState: vi.fn(),
}))

const { mockStreamWarn, mockStreamDebug } = vi.hoisted(() => ({
  mockStreamWarn: vi.fn(),
  mockStreamDebug: vi.fn(),
}))

const { mockEnsureSessionFreshDetailed } = vi.hoisted(() => ({
  mockEnsureSessionFreshDetailed: vi.fn().mockResolvedValue({ changed: true, newCount: 1 }),
}))

const { mockUpsertObservedUserMessageImpl } = vi.hoisted(() => ({
  mockUpsertObservedUserMessageImpl: (sessionId: string, message: ChatMessage) => {
    mockUpdateSessionMessages(sessionId, (prev) => {
      const identity = message.client_event_id ?? message.id
      const exists = prev.some((m) => {
        if (m.id === message.id || m.id === identity) return true
        if (message.client_event_id && m.client_event_id === message.client_event_id) return true
        const meta = m.metadata as Record<string, unknown> | null | undefined
        if (typeof meta !== 'object' || meta === null) return false
        return meta.client_event_id === identity
          || meta.client_message_id === identity
          || (message.client_event_id
            ? meta.client_event_id === message.client_event_id || meta.client_message_id === message.client_event_id
            : false)
      })
      return exists ? prev : [...prev, message]
    })
  },
}))

const { mockUpsertObservedUserMessage } = vi.hoisted(() => ({
  mockUpsertObservedUserMessage: vi.fn((sessionId: string, message: ChatMessage) => {
    mockUpsertObservedUserMessageImpl(sessionId, message)
  }),
}))

//  streaming 自愈：默认 true（会话在 streaming，不触发自愈路径），
// 具体测试按需覆盖为 false 模拟「abort 后按钮已消失但 run 还在发事件」。
const { mockIsSessionStreaming } = vi.hoisted(() => ({
  mockIsSessionStreaming: vi.fn(() => true),
}))

const messagesBySessionIdState = vi.hoisted(() => ({} as Record<string, ChatMessage[]>))

vi.mock('@/services/systemNotification', () => ({
  SystemNotification: {
    agentError: mockAgentError,
    agentCompleted: vi.fn(),
    agentInterrupted: vi.fn(),
    agentSessionInterrupted: vi.fn(),
    agentHitlWaiting: vi.fn(),
  },
}))

vi.mock('@/utils/logger', () => ({
  logger: {
    debug: mockStreamDebug,
    info: vi.fn(),
    warn: mockStreamWarn,
    error: vi.fn(),
  },
  createLogger: () => ({
    debug: mockStreamDebug,
    info: vi.fn(),
    warn: mockStreamWarn,
    error: vi.fn(),
  }),
}))

vi.mock('../sessionCleanup', () => ({
  cleanupSessionOnTerminal: mockCleanupSessionOnTerminal,
}))

vi.mock('@/i18n', () => ({
  default: {
    t: (_key: string, fallback?: { defaultValue?: string }) => fallback?.defaultValue ?? _key,
  },
}))

vi.mock('@stores/chat/useChatStore', () => ({
  useChatStore: {
    getState: () => ({
      messagesBySessionId: messagesBySessionIdState,
      updateSessionMessages: mockUpdateSessionMessages,
      getSessionById: vi.fn(() => ({ id: 'session-1' })),
      removeHostPendingByClientEventId: vi.fn(() => null),
      reconcileHostPendingWithRunSync: vi.fn(),
      rewriteSessionMessages: (sid: string, _reason: string, updater: (prev: unknown[]) => unknown[]) => mockUpdateSessionMessages(sid, updater),
      ensureAssistantMessage: (sessionId: string, message: ChatMessage) => {
        mockUpdateSessionMessages(sessionId, (prev) =>
          prev.some((m) => m.id === message.id) ? prev : [...prev, message])
      },
      mergeSubagentMessages: (
        sessionId: string,
        toStoreMessage: (message: ChatMessage) => ChatMessage,
        incoming: ChatMessage[],
      ) => {
        mockUpdateSessionMessages(sessionId, (prev) => {
          const mapped = incoming.map(toStoreMessage)
          const seen = new Set(prev.map((m) => m.id))
          const appended = mapped.filter((m) => !seen.has(m.id))
          return appended.length > 0 ? [...prev, ...appended] : prev
        })
      },
    }),
    setState: mockUseChatStoreSetState,
  },
}))

vi.mock('@/services/sessionFreshness', () => ({
  ensureSessionFreshDetailed: mockEnsureSessionFreshDetailed,
  reconcileSessionMessages: mockEnsureSessionFreshDetailed,
}))

vi.mock('../../../shared/storeAccessRegistry', () => ({
  getChatStoreCallbacks: () => ({
    rewriteSessionMessages: (sid: string, _reason: string, updater: (prev: unknown[]) => unknown[]) => mockUpdateSessionMessages(sid, updater),
    linkServerMessageId: (sessionId: string, localMessageId: string, serverId: string) => {
      mockUpdateSessionMessages(sessionId, (prev: ChatMessage[]) => {
        const idx = prev.findIndex((m) => m.id === localMessageId)
        if (idx < 0) return prev
        const target = prev[idx]
        const metadata = (typeof target.metadata === 'object' && target.metadata !== null)
          ? target.metadata as Record<string, unknown>
          : {}
        if (metadata.message_id === serverId) return prev
        const next = [...prev]
        next[idx] = { ...target, metadata: { ...metadata, message_id: serverId } }
        return next
      })
    },
    rebindMessageIds: (sessionId: string, pairs: Array<[string, string]>) => {
      mockUpdateSessionMessages(sessionId, (prev: ChatMessage[]) => {
        const map = new Map(pairs)
        return prev.map((m) => {
          const nextId = map.get(m.id)
          return nextId ? { ...m, id: nextId } : m
        })
      })
    },
    upsertObservedUserMessage: mockUpsertObservedUserMessage,
    getCurrentSessionId: () => 'session-1',
    isSessionBusy: mockIsSessionStreaming,
  }),
  getHitlStoreAccess: () => hitlStoreAccessMock.access,
  registerHitlStoreAccess: (access: typeof hitlStoreAccessMock.access) => {
    hitlStoreAccessMock.access = access
  },
  __resetHitlStoreAccessForTest: () => {
    hitlStoreAccessMock.access = null
  },
}))

import type { StreamHandlerStore } from '../streamHandlerTypes'
import { createStreamMessageHandler } from '../streamMessageHandler'
import { __resetToolCallArgsBuffersForTests } from '../toolCallArgsBufferStore'
import { __resetStreamEventDedupForTest } from '../streamEventDedup'
import {
  clearWithdrawalPending,
  isWithdrawalPending,
  markAbortRequested,
  markWithdrawalPending,
  __resetAbortGraceForTest,
} from '../abortGrace'
import { markRunSuperseded, __resetSupersededRunsForTest } from '../supersededRuns'
import {
  __resetMessageWriteGateForTest,
  expectSelfRollbackBroadcast,
  registerSessionMessagesReader,
} from '@/services/agentService/messageWriteGate'
import { _resetTitleGenerationDedupeForTests } from '../../../messages/actions/titleGenerationDedupe'

describe('streamMessageHandler', () => {
  let store: StreamHandlerStore

  beforeEach(() => {
    vi.clearAllMocks()
    mockCleanupSessionOnTerminal.mockReturnValue(false)
    mockUpdateSessionMessages.mockReset()
    mockUpdateSessionMessages.mockImplementation((_sessionId, updater) => updater([]))
    mockUpsertObservedUserMessage.mockReset()
    mockUpsertObservedUserMessage.mockImplementation(mockUpsertObservedUserMessageImpl)
    mockUseChatStoreSetState.mockReset()
    mockStreamWarn.mockReset()
    mockStreamDebug.mockReset()
    // Widget Wave 2.5：清掉跨测试的 toolCallArgsDelta in-memory buffer，
    // 否则上个测试的 buffer 让"首条 delta 应触发 placeholder 创建"判断失效。
    __resetToolCallArgsBuffersForTests()
    // ：清掉跨测试的 arrival_seq 去重缓存，避免上个测试的 arrival_seq
    // 让本测试同值事件被误判为重复丢弃。
    __resetStreamEventDedupForTest()
    // ：清掉跨测试的 abort 宽限期登记 + 恢复默认 streaming=true。
    __resetAbortGraceForTest()
    // 作废旧流 denylist：清掉跨测试残留的 superseded run_id 登记。
    __resetSupersededRunsForTest()
    // ：清掉消息写入权威的 provider / 广播期望，避免跨测试误判本机驱动。
    __resetMessageWriteGateForTest()
    _resetTitleGenerationDedupeForTests()
    mockIsSessionStreaming.mockReturnValue(true)
    for (const key of Object.keys(messagesBySessionIdState)) {
      delete messagesBySessionIdState[key]
    }
    messagesBySessionIdState['session-1'] = []

    store = {
      agentSteps: [],
      agentStepsBySessionId: {},
      toolEvents: [],
      toolEventsBySessionId: {},
      assistantEvents: [],
      assistantEventsBySessionId: {},
      runState: {
        runId: null,
        phase: 'planning',
        startedAt: Date.now(),
        endedAt: null,
        completedToolCalls: 0,
        totalToolCalls: 0,
      },
      runStateBySessionId: {
        'session-1': {
          runId: null,
          phase: 'planning',
          startedAt: Date.now(),
          endedAt: null,
          completedToolCalls: 0,
          totalToolCalls: 0,
        },
      },
      sessions: [],
      todosBySessionId: {},
      agentModeBySessionId: {},
      subagentRunsBySessionId: {},
      cancellingBySessionId: {},
      messageMetaBySessionId: {},
      contentBlocksLastSeqBySessionId: {},
      updateRunStateForSession: (sessionId: string, partial: Partial<RunState>) => {
        store.runStateBySessionId[sessionId] = {
          ...store.runStateBySessionId[sessionId],
          ...partial,
        }
      },
      setCancellingForSession: vi.fn(),
      clearActiveSubmittedMessage: vi.fn(),
      pushAgentStepForSession: vi.fn(),
      updateAgentStepForSession: vi.fn(),
      upsertToolEventForSession: vi.fn(),
      getEffectiveToolEventForSession: vi.fn(() => undefined),
      upsertAssistantEventForSession: vi.fn(),
      messageStart: vi.fn(),
      contentBlockDelta: vi.fn(),
      resetAssistantDeltasForSession: vi.fn(),
      upsertSubagentRunForSession: vi.fn(),
      setTodosForSession: vi.fn(),
      appendRichContentBlocks: vi.fn(),
      upsertRichContentBlocksByToolCallId: vi.fn(),
      clearRichContentBlocks: vi.fn(),
      pushSnapshotForSession: vi.fn(),
      markStreamingWidgetsInterruptedAndClearOthers: vi.fn(),
    } as unknown as StreamHandlerStore
  })

  function makeHandler(generateTitle = vi.fn().mockResolvedValue({ accepted: true })) {
    return createStreamMessageHandler({
      sessionId: 'session-1',
      get: () => store,
      set: (partial) => {
        const next = typeof partial === 'function' ? partial(store) : partial
        Object.assign(store, next)
      },
      addStreamingSession: vi.fn(),
      removeStreamingSession: vi.fn(),
      client: {
        sessions: {
          get: vi.fn().mockResolvedValue({ id: 'session-1' }),
          generateTitle,
        },
      },
      updateSessionTokenUsageInCaches: vi.fn(),
      updateSessionInCaches: vi.fn(),
      onLifecycleEnd: vi.fn(),
    })
  }

  it('LLM_SNAPSHOT response 进入本地 snapshot store', () => {
    const handler = makeHandler()

    handler({
      type: StreamEvents.LLM_SNAPSHOT,
      payload: {
        runId: 'run-1',
        iterationId: 'run-1:0',
        iteration: 0,
        phase: 'response',
        model: 'test-model',
        response: { format: 'text', contentPreview: 'ok', charCount: 2 },
      },
    })

    expect(store.pushSnapshotForSession).toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({
        runId: 'run-1',
        iterationId: 'run-1:0',
        phase: 'response',
      }),
    )
  })

  it('lifecycle error 优先使用 detail/error_message 传给统一终态清理和通知', () => {
    const handler = createStreamMessageHandler({
      sessionId: 'session-1',
      spaceId: 'space-1',
      spaceName: 'Space A',
      sessionTitle: 'Session A',
      get: () => store,
      set: (partial) => {
        const next = typeof partial === 'function' ? partial(store) : partial
        Object.assign(store, next)
      },
      addStreamingSession: vi.fn(),
      removeStreamingSession: vi.fn(),
      client: { sessions: { get: vi.fn().mockResolvedValue({ id: 'session-1' }), generateTitle: vi.fn().mockResolvedValue({ title: 'Session' }) } },
      updateSessionTokenUsageInCaches: vi.fn(),
      updateSessionInCaches: vi.fn(),
      onLifecycleEnd: vi.fn(),
    })

    handler({
      type: AgentStreamEvents.LIFECYCLE,
      payload: {
        phase: 'error',
        detail: 'daemon crashed',
      },
    })

    expect(mockCleanupSessionOnTerminal).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'session-1',
        status: 'error',
        errorMessage: 'daemon crashed',
      }),
    )
    expect(mockAgentError).toHaveBeenCalledWith(
      expect.objectContaining({
        body: 'daemon crashed',
      }),
    )
  })

  it('message_committed 会话内无 live 消息时触发唯一 upsert 对账', async () => {
    const handler = makeHandler()

    handler({
      type: 'agent.stream.message_committed',
      payload: {
        message_id: 'msg-1',
        server_id: 'msg-1',
      },
    })

    await vi.waitFor(() => {
      expect(mockEnsureSessionFreshDetailed).toHaveBeenCalledWith('session-1', {
        force: true,
        retry: false,
        silentOnError: true,
        reason: 'message-committed',
      })
    })
  })

  it('#6768 message_persisted 不再触发生成标题（与落库解耦）', async () => {
    const generateTitle = vi.fn().mockResolvedValue({ accepted: true })
    const userMsg: ChatMessage = {
      id: 'temp-user-1',
      role: 'user',
      content: '帮我写周报',
      created_at: '2026-07-22T00:00:00.000Z',
      client_event_id: 'cid-user-1',
    }
    messagesBySessionIdState['session-1'] = [userMsg]
    registerSessionMessagesReader((sid) =>
      sid === 'session-1' ? messagesBySessionIdState['session-1'] ?? [] : [],
    )
    const handler = makeHandler(generateTitle)

    handler({
      type: 'agent.stream.message_persisted',
      payload: {
        message_ids: [{ client_event_id: 'cid-user-1', server_id: 'srv-user-1' }],
      },
    })

    await Promise.resolve()
    expect(generateTitle).not.toHaveBeenCalled()
  })

  it('#6768 message_committed(role=user) 不再触发生成标题', async () => {
    const generateTitle = vi.fn().mockResolvedValue({ accepted: true })
    messagesBySessionIdState['session-1'] = [{
      id: 'local-u1',
      role: 'user',
      content: '开个会',
      created_at: '2026-07-22T00:00:00.000Z',
    }]
    registerSessionMessagesReader((sid) =>
      sid === 'session-1' ? messagesBySessionIdState['session-1'] ?? [] : [],
    )
    const handler = makeHandler(generateTitle)

    handler({
      type: 'agent.stream.message_committed',
      payload: {
        message_id: 'local-u1',
        server_id: 'srv-u1',
        role: 'user',
        message_kind: 'llm',
      },
    })

    await Promise.resolve()
    expect(generateTitle).not.toHaveBeenCalled()
  })

  it('#2822 message_committed 会话内已有 live 消息时收窄为定向 id 对账，不整页重拉', async () => {
    registerSessionMessagesReader((sid) =>
      sid === 'session-1'
        ? [{ id: 'local-msg-1', role: 'assistant', content: 'hi', created_at: '', metadata: {} } as ChatMessage]
        : [],
    )
    const handler = makeHandler()

    handler({
      type: 'agent.stream.message_committed',
      payload: {
        message_id: 'local-msg-1',
        server_id: 'server-uuid-1',
      },
    })

    // 不整页重拉
    await Promise.resolve()
    expect(mockEnsureSessionFreshDetailed).not.toHaveBeenCalled()

    // 定向 patch：本地 live 消息补 metadata.message_id = server_id
    expect(mockUpdateSessionMessages).toHaveBeenCalledTimes(1)
    const updater = mockUpdateSessionMessages.mock.calls[0][1] as (prev: ChatMessage[]) => ChatMessage[]
    const patched = updater([
      { id: 'local-msg-1', role: 'assistant', content: 'hi', created_at: '', metadata: {} } as ChatMessage,
    ])
    expect((patched[0].metadata as Record<string, unknown>).message_id).toBe('server-uuid-1')
  })

  it('#2822 ROLLBACK 发起端（已登记自发广播期望）跳过整页重拉', async () => {
    expectSelfRollbackBroadcast('session-1')
    const handler = makeHandler()

    handler({
      type: 'agent.stream.rollback',
      payload: { rollback_state: { revert_active: true } },
    })

    await Promise.resolve()
    expect(mockEnsureSessionFreshDetailed).not.toHaveBeenCalled()
  })

  it('#2822 /  ROLLBACK 观察端走唯一 upsert 对账（非整包替换）', async () => {
    const handler = makeHandler()

    handler({
      type: 'agent.stream.rollback',
      payload: { rollback_state: { revert_active: true } },
    })

    await vi.waitFor(() => {
      expect(mockEnsureSessionFreshDetailed).toHaveBeenCalledWith('session-1', expect.objectContaining({
        force: true,
        reason: 'rollback-broadcast',
      }))
      expect(mockEnsureSessionFreshDetailed.mock.calls[0][1]).not.toHaveProperty('forceFullLatest')
    })
  })

  it('push-notification USER 事件写入消息列表并标记系统通知 metadata', async () => {
    const handler = makeHandler()

    handler({
      type: AgentStreamEvents.USER,
      payload: {
        client_event_id: 'push-user-1',
        content: 'A background sub-agent finished while you were doing other work:',
        triggered_by: 'push-notification',
      },
    })

    expect(mockUpdateSessionMessages).toHaveBeenCalledTimes(1)
    const [sessionId, updater] = mockUpdateSessionMessages.mock.calls[0]
    expect(sessionId).toBe('session-1')
    const next = updater([])
    expect(next).toHaveLength(1)
    expect(next[0]).toMatchObject({
      id: 'push-user-1',
      role: 'system',
      content: 'A background sub-agent finished while you were doing other work:',
      metadata: {
        triggered_by: 'push-notification',
        client_event_id: 'push-user-1',
      },
    })
    expect(updater(next)).toBe(next)
  })

  it('普通 USER 观察事件写入消息列表并按 client_event_id 去重', () => {
    const handler = makeHandler()

    handler({
      type: AgentStreamEvents.USER,
      payload: {
        message_id: 'server-user-1',
        client_event_id: 'client-user-1',
        content: 'hello from another device',
        blocks_json: [{ type: 'text', text: 'hello from another device' }],
      },
    })

    expect(mockUpdateSessionMessages).toHaveBeenCalledTimes(1)
    const [sessionId, updater] = mockUpdateSessionMessages.mock.calls[0]
    expect(sessionId).toBe('session-1')

    const existing: ChatMessage[] = [{
      id: 'temp-user-local',
      role: 'user',
      content: 'hello from another device',
      created_at: '2026-06-25T00:00:00.000Z',
      client_event_id: 'client-user-1',
      metadata: { client_message_id: 'client-user-1' },
    }]
    expect(updater(existing)).toBe(existing)

    const next = updater([])
    expect(next).toHaveLength(1)
    expect(next[0]).toMatchObject({
      id: 'server-user-1',
      role: 'user',
      content: 'hello from another device',
      metadata: {
        client_event_id: 'client-user-1',
        client_message_id: 'client-user-1',
      },
      content_blocks_json: [{ type: 'text', text: 'hello from another device' }],
    })
    expect(updater(next)).toBe(next)
  })

  it('内部注入 USER 事件在 renderer store 记录为 system', () => {
    const handler = makeHandler()

    handler({
      type: AgentStreamEvents.USER,
      payload: {
        message_id: 'env-system-1',
        content: '<context type="environment">now</context>',
        message_kind: 'environment_context',
      },
    })

    const [, updater] = mockUpdateSessionMessages.mock.calls[0]
    expect(updater([])[0]).toMatchObject({
      id: 'env-system-1',
      role: 'system',
      message_kind: 'environment_context',
    })
  })

  it('#1896 跨源去重：同一 arrival_seq 的 USER 事件只处理一次（IPC+WS 双路）', () => {
    const handler = makeHandler()
    const evt = {
      type: AgentStreamEvents.USER,
      payload: {
        message_id: 'server-user-dup',
        client_event_id: 'client-user-dup',
        content: 'cross-source once',
        blocks_json: [{ type: 'text', text: 'cross-source once' }],
        arrival_seq: 777777,
      },
    }
    handler(evt) // IPC 先到
    handler(evt) // WS 后到同一 arrival_seq → 入口丢弃
    expect(mockUpdateSessionMessages).toHaveBeenCalledTimes(1)
  })

  it('#4584 跨源去重：同一 event_id 的事件只处理一次（IPC 包装 + WS 原始双路）', () => {
    const handler = makeHandler()
    const evt = {
      type: AgentStreamEvents.USER,
      payload: {
        message_id: 'server-user-eid',
        client_event_id: 'client-user-eid',
        content: 'same event_id once',
        blocks_json: [{ type: 'text', text: 'same event_id once' }],
        event_id: 'emission-abc',
      },
    }
    handler(evt) // 先到
    handler(evt) // 同 event_id → 入口丢弃
    expect(mockUpdateSessionMessages).toHaveBeenCalledTimes(1)
  })

  it('#4584 event_id 优先于 arrival_seq：同 event_id 但不同 arrival_seq 仍只处理一次', () => {
    const handler = makeHandler()
    const make = (arrivalSeq: number) => ({
      type: AgentStreamEvents.USER,
      payload: {
        message_id: 'server-user-eid2',
        client_event_id: 'client-user-eid2',
        content: 'event_id wins',
        blocks_json: [{ type: 'text', text: 'event_id wins' }],
        event_id: 'emission-def',
        arrival_seq: arrivalSeq,
      },
    })
    // 同一逻辑发射被两路重新 stamp 出不同 arrival_seq（模拟包装重造），但 event_id 相同
    handler(make(1000))
    handler(make(2000))
    expect(mockUpdateSessionMessages).toHaveBeenCalledTimes(1)
  })

  it('#1896 无 arrival_seq 的事件不去重（放行）', () => {
    const handler = makeHandler()
    const evt = {
      type: AgentStreamEvents.USER,
      payload: {
        message_id: 'server-user-noseq',
        client_event_id: 'client-user-noseq',
        content: 'no arrival_seq',
        blocks_json: [{ type: 'text', text: 'no arrival_seq' }],
      },
    }
    handler(evt)
    handler(evt)
    // 无 arrival_seq → 入口不拦截，两次都进入 handler（USER 自身按 client_event_id
    // 在 updateSessionMessages updater 内幂等，但本断言只验证入口未丢弃）。
    expect(mockUpdateSessionMessages).toHaveBeenCalledTimes(2)
  })

  it('#1896 不同 arrival_seq 的事件都处理（不误杀 retry / 新事件）', () => {
    const handler = makeHandler()
    const make = (seq: number, id: string) => ({
      type: AgentStreamEvents.USER,
      payload: {
        message_id: id,
        client_event_id: id,
        content: id,
        blocks_json: [{ type: 'text', text: id }],
        arrival_seq: seq,
      },
    })
    handler(make(1000, 'a'))
    handler(make(1001, 'b'))
    expect(mockUpdateSessionMessages).toHaveBeenCalledTimes(2)
  })

  it('普通 USER 观察事件即使只有 blocks 也会写入消息列表', () => {
    const handler = makeHandler()
    const blocks = [{ type: 'context_ref', label: '产品文档' }]

    handler({
      type: AgentStreamEvents.USER,
      payload: {
        client_event_id: 'remote-user-blocks',
        content: '',
        blocks_json: blocks,
      },
    })

    expect(mockUpdateSessionMessages).toHaveBeenCalledTimes(1)
    const updater = mockUpdateSessionMessages.mock.calls[0]?.[1]
    const next = updater?.([])
    expect(next).toHaveLength(1)
    expect(next?.[0]).toMatchObject({
      id: 'remote-user-blocks',
      role: 'user',
      content: '',
      content_blocks_json: blocks,
    })
  })

  it('本机 USER echo 命中 temp user 的 client_message_id 时不重复插入', () => {
    const handler = makeHandler()

    handler({
      type: AgentStreamEvents.USER,
      payload: {
        client_event_id: 'client-message-1',
        content: '本机已乐观显示的消息',
      },
    })

    const updater = mockUpdateSessionMessages.mock.calls[0]?.[1]
    const existing = [{
      id: 'temp-user-1',
      role: 'user',
      content: '本机已乐观显示的消息',
      created_at: '2026-06-25T00:00:00.000Z',
      metadata: { client_message_id: 'client-message-1' },
    }] as ChatMessage[]

    expect(updater?.(existing)).toBe(existing)
  })

  it('push-notification USER 事件必须同步写入，避免后续 assistant 先入列', () => {
    const handler = makeHandler()

    handler({
      type: AgentStreamEvents.USER,
      payload: {
        client_event_id: 'push-user-sync',
        content: 'A background sub-agent finished while you were doing other work:',
        triggered_by: 'push-notification',
      },
    })

    expect(mockUpdateSessionMessages).toHaveBeenCalledTimes(1)
    const updater = mockUpdateSessionMessages.mock.calls[0]?.[1]
    const next = updater?.([])
    expect(next?.[0]).toMatchObject({
      id: 'push-user-sync',
      metadata: { triggered_by: 'push-notification' },
    })
  })

  it('continuation USER 事件写入 triggered_by，供时间线隐藏续跑提示', () => {
    const handler = makeHandler()

    handler({
      type: AgentStreamEvents.USER,
      payload: {
        client_event_id: 'continuation-user-sync',
        content: '上一轮回复失败了。请直接根据已有对话继续完成回复，不要让用户重复刚才的问题。',
        triggered_by: 'continuation',
      },
    })

    expect(mockUpdateSessionMessages).toHaveBeenCalledTimes(1)
    const updater = mockUpdateSessionMessages.mock.calls[0]?.[1]
    const next = updater?.([])
    expect(next?.[0]).toMatchObject({
      id: 'continuation-user-sync',
      metadata: { triggered_by: 'continuation' },
    })
  })

  it('push-notification USER 后紧跟 assistant message_start 时，消息数组保持 push 在前', () => {
    let messages: ChatMessage[] = []
    mockUpdateSessionMessages.mockImplementation((_sessionId, updater) => {
      messages = updater(messages)
    })
    const handler = makeHandler()

    handler({
      type: AgentStreamEvents.USER,
      payload: {
        client_event_id: 'push-user-order',
        content: 'A background sub-agent finished while you were doing other work:',
        triggered_by: 'push-notification',
      },
    })
    handler({
      type: 'agent.stream.message_start',
      payload: {
        protocol_version: 'v2',
        min_compatible_version: 'v2',
        trace_id: 'trace-order',
        _seq: 1,
        thread_id: 'session-1',
        message_id: 'assistant-after-push',
        role: 'assistant',
        model_id: 'claude-3-7-sonnet',
        model_name: 'Claude 3.7 Sonnet',
        started_at: '2026-06-08T08:00:01.000Z',
        run_id: 'run-order',
        message_kind: 'llm',
      },
    })

    expect(messages.map(message => message.id)).toEqual(['push-user-order', 'assistant-after-push'])
  })

  //  /  streaming 状态自愈：abortStream 乐观清掉 streaming 后，若底层
  // abort 静默失败、run 继续发 content-block，宽限期外必须恢复渲染并清 cancelling。
  // busy 状态只由 run_sync 负责，message_start/content-block 不再调用 addStreamingSession。
  describe('#3406 streaming 自愈', () => {
    function makeHandlerWithSpies() {
      const addStreamingSession = vi.fn()
      const handler = createStreamMessageHandler({
        sessionId: 'session-1',
        get: () => store,
        set: (partial) => {
          const next = typeof partial === 'function' ? partial(store) : partial
          Object.assign(store, next)
        },
        addStreamingSession,
        removeStreamingSession: vi.fn(),
        client: { sessions: { get: vi.fn().mockResolvedValue({ id: 'session-1' }), generateTitle: vi.fn().mockResolvedValue({ title: 'Session' }) } },
        updateSessionTokenUsageInCaches: vi.fn(),
        updateSessionInCaches: vi.fn(),
        onLifecycleEnd: vi.fn(),
      })
      return { handler, addStreamingSession }
    }

    const messageStartEvent = (seq: number) => ({
      type: 'agent.stream.message_start',
      payload: {
        protocol_version: 'v2',
        min_compatible_version: 'v2',
        trace_id: `trace-heal-${seq}`,
        _seq: seq,
        thread_id: 'session-1',
        message_id: `assistant-heal-${seq}`,
        role: 'assistant',
        model_id: 'claude-3-7-sonnet',
        model_name: 'Claude 3.7 Sonnet',
        started_at: '2026-07-07T03:21:37.000Z',
        run_id: 'run-heal',
        message_kind: 'llm',
      },
    })

    it('非 streaming 会话收到 message_start 且不在宽限期 → 渲染但不写 busy', () => {
      mockIsSessionStreaming.mockReturnValue(false)
      const { handler, addStreamingSession } = makeHandlerWithSpies()

      handler(messageStartEvent(1))

      expect(addStreamingSession).not.toHaveBeenCalled()
      expect(store.messageStart).toHaveBeenCalled()
    })

    it('abort 宽限期内收到 message_start → 不自愈且不写入 content-block（pre-stream 停干净）', () => {
      mockIsSessionStreaming.mockReturnValue(false)
      markAbortRequested('session-1')
      const { handler, addStreamingSession } = makeHandlerWithSpies()

      handler(messageStartEvent(2))

      expect(addStreamingSession).not.toHaveBeenCalled()
      expect(store.messageStart).not.toHaveBeenCalled()
    })

    it('撤回投影超过 5 秒后收到 late thinking 仍不重建 assistant', () => {
      mockIsSessionStreaming.mockReturnValue(false)
      store.cancellingBySessionId['session-1'] = true
      markAbortRequested('session-1')
      markWithdrawalPending('session-1')
      const now = Date.now()
      const dateNow = vi.spyOn(Date, 'now').mockReturnValue(now + 6_000)
      const { handler, addStreamingSession } = makeHandlerWithSpies()

      handler({
        type: 'agent.stream.content_block_start',
        payload: {
          protocol_version: 'v2',
          min_compatible_version: 'v2',
          trace_id: 'late-withdraw-trace',
          _seq: 20,
          thread_id: 'session-1',
          message_id: 'late-assistant',
          index: 0,
          content_block: { type: 'thinking', thinking: 'late' },
        },
      })

      expect(isWithdrawalPending('session-1')).toBe(true)
      expect(addStreamingSession).not.toHaveBeenCalled()
      expect(store.messageStart).not.toHaveBeenCalled()
      clearWithdrawalPending('session-1')
      dateNow.mockRestore()
    })

    it('宽限期外仍 cancelling 时 content 到达 → abort miss 自愈：清 cancelling 并渲染但不写 busy', () => {
      mockIsSessionStreaming.mockReturnValue(false)
      store.cancellingBySessionId['session-1'] = true
      const setCancellingForSession = vi.fn((sid: string, value: boolean) => {
        store.cancellingBySessionId[sid] = value
      })
      store.setCancellingForSession = setCancellingForSession
      const { handler, addStreamingSession } = makeHandlerWithSpies()

      handler({
        type: 'agent.stream.content_block_delta',
        payload: {
          protocol_version: 'v2',
          min_compatible_version: 'v2',
          trace_id: 'trace-cancel-tail',
          _seq: 10,
          thread_id: 'session-1',
          message_id: 'assistant-cancel-tail',
          index: 0,
          delta: { type: 'text_delta', text: 'should-resume' },
        },
      })

      expect(setCancellingForSession).toHaveBeenCalledWith('session-1', false)
      expect(addStreamingSession).not.toHaveBeenCalled()
      expect(store.contentBlockDelta).toHaveBeenCalled()
    })

    it('宽限期外仍 cancelling 时 message_start → 清 cancelling、渲染但不写 busy', () => {
      mockIsSessionStreaming.mockReturnValue(false)
      store.cancellingBySessionId['session-1'] = true
      const setCancellingForSession = vi.fn((sid: string, value: boolean) => {
        store.cancellingBySessionId[sid] = value
      })
      store.setCancellingForSession = setCancellingForSession
      const { handler, addStreamingSession } = makeHandlerWithSpies()

      handler(messageStartEvent(4))

      expect(addStreamingSession).not.toHaveBeenCalled()
      expect(setCancellingForSession).toHaveBeenCalledWith('session-1', false)
      expect(store.messageStart).toHaveBeenCalled()
    })

    it('会话仍在 streaming → 不重复 addStreamingSession', () => {
      mockIsSessionStreaming.mockReturnValue(true)
      const { handler, addStreamingSession } = makeHandlerWithSpies()

      handler(messageStartEvent(3))

      expect(addStreamingSession).not.toHaveBeenCalled()
    })

  })

  // 作废旧流拦截：中断后被顶替 run 的尾部 content-block 事件按 run_id 丢弃，
  // 不再新建 assistant 气泡 / 灌内容（消息错乱根因修复）。
  describe('superseded run 尾部事件丢弃', () => {
    function makeHandlerLocal() {
      return createStreamMessageHandler({
        sessionId: 'session-1',
        get: () => store,
        set: (partial) => {
          const next = typeof partial === 'function' ? partial(store) : partial
          Object.assign(store, next)
        },
        addStreamingSession: vi.fn(),
        removeStreamingSession: vi.fn(),
        client: { sessions: { get: vi.fn().mockResolvedValue({ id: 'session-1' }), generateTitle: vi.fn().mockResolvedValue({ title: 'Session' }) } },
        updateSessionTokenUsageInCaches: vi.fn(),
        updateSessionInCaches: vi.fn(),
        onLifecycleEnd: vi.fn(),
      })
    }

    const startEvent = (runId: string) => ({
      type: 'agent.stream.message_start',
      payload: {
        protocol_version: 'v2',
        min_compatible_version: 'v2',
        trace_id: `trace-${runId}`,
        _seq: 1,
        thread_id: 'session-1',
        message_id: `assistant-${runId}`,
        role: 'assistant',
        model_id: 'claude-3-7-sonnet',
        model_name: 'Claude 3.7 Sonnet',
        started_at: '2026-07-07T03:21:37.000Z',
        run_id: runId,
        message_kind: 'llm',
      },
    })

    it('run_id 已登记 superseded → message_start 被丢弃，不新建 assistant 气泡', () => {
      markRunSuperseded('session-1', 'run-old')
      makeHandlerLocal()(startEvent('run-old'))
      // contentBlockHandler.handleMessageStart 建气泡走 useChatStore.updateSessionMessages；
      // 被丢弃则一次都不会调。
      expect(mockUpdateSessionMessages).not.toHaveBeenCalled()
    })

    it('新流 run_id（未 superseded）→ message_start 正常通过，建 assistant 气泡', () => {
      markRunSuperseded('session-1', 'run-old')
      makeHandlerLocal()(startEvent('run-new'))
      expect(mockUpdateSessionMessages).toHaveBeenCalled()
    })

    it('content-block 事件只带 trace_id（无 run_id）也按 trace_id 丢弃', () => {
      // envelope-emitter 只在 message_start 贴 run_id，其余 content-block 事件仅带
      // trace_id（= run_id）。denylist 必须认 trace_id，否则旧流内容照样渲染。
      markRunSuperseded('session-1', 'run-old')
      makeHandlerLocal()({
        type: 'agent.stream.message_start',
        payload: {
          protocol_version: 'v2',
          min_compatible_version: 'v2',
          trace_id: 'run-old', // trace_id === run_id；此事件不带 run_id
          _seq: 2,
          thread_id: 'session-1',
          message_id: 'assistant-trace-only',
          role: 'assistant',
          model_id: 'claude-3-7-sonnet',
          model_name: 'Claude 3.7 Sonnet',
          started_at: '2026-07-07T03:21:37.000Z',
          message_kind: 'llm',
        },
      })
      expect(mockUpdateSessionMessages).not.toHaveBeenCalled()
    })
  })

  // W4 协议（2026-05-26）：排队态用独立 SUBAGENT_QUEUED 事件 status='queued'，
  // SUBAGENT_STARTED 永远表示"已激活、开始跑"status='running'，COMPLETED 收尾。
  // 历史 W4 前用 SUBAGENT_STARTED + payload.status='queued' → 'pending'
  // 的兜底死代码随 W4 review P1-E 一并清理，本测试也升级到 W4 协议。
  it('SUBAGENT_QUEUED → STARTED → COMPLETED 协议序列产生 queued → running → completed 状态变迁', () => {
    store.upsertSubagentRunForSession = vi.fn((sessionId: string, run) => {
      const prev = store.subagentRunsBySessionId[sessionId] ?? []
      const merged = prev.find(item => item.subagentRunId === run.subagentRunId)
        ? prev.map(item => item.subagentRunId === run.subagentRunId ? { ...item, ...run } : item)
        : [run, ...prev]
      store.subagentRunsBySessionId[sessionId] = merged
    })

    const handler = makeHandler()
    handler({
      type: AgentStreamEvents.SUBAGENT_QUEUED,
      payload: {
        subagent_run_id: 'sub-1',
        label: '协作角色 · 研究员',
        queue_position: 2,
      },
    })
    handler({
      type: AgentStreamEvents.SUBAGENT_STARTED,
      payload: {
        subagent_run_id: 'sub-1',
        label: '协作角色 · 研究员',
      },
    })
    handler({
      type: AgentStreamEvents.SUBAGENT_COMPLETED,
      payload: {
        subagent_run_id: 'sub-1',
        status: 'completed',
        summary: '找到了 3 个候选实现点',
      },
    })

    const runs = store.subagentRunsBySessionId['session-1'] ?? []
    expect(runs[0]).toMatchObject({
      subagentRunId: 'sub-1',
      status: 'completed',
      summary: '找到了 3 个候选实现点',
    })
    expect(store.upsertSubagentRunForSession).toHaveBeenNthCalledWith(
      1,
      'session-1',
      expect.objectContaining({
        subagentRunId: 'sub-1',
        status: 'queued',
      }),
    )
    expect(store.upsertSubagentRunForSession).toHaveBeenNthCalledWith(
      2,
      'session-1',
      expect.objectContaining({
        subagentRunId: 'sub-1',
        status: 'running',
      }),
    )
  })

  // PRD §4.18 v3.3 review D1：SUBAGENT_STREAM_EVENT 必须早返路由到
  // subagentStreamHandler（写 live store），**不**落进 subagentHandler 的
  // `startsWith('agent.stream.subagent_')` 通配 → statusMap silent ignore。
  // 这条守门测试锁住 dispatch 顺序——有人把通配提前重构时立即报红。
  it('SUBAGENT_STREAM_EVENT 路由到 live store，不调 upsertSubagentRunForSession（metadata 路径）', async () => {
    const { useSubagentLiveStore, flushSubagentLiveBatch } = await import('../../../../subagentLive')
    useSubagentLiveStore.getState().clear()

    const handler = makeHandler()
    handler({
      type: AgentStreamEvents.SUBAGENT_STREAM_EVENT,
      payload: {
        subagent_run_id: 'sub-stream-1',
        parent_run_id: null,
        subagent_chain: ['sub-stream-1'],
        child_event: {
          type: 'agent.stream.message_start',
          payload: { message_id: 'm-1', role: 'assistant' },
        },
      },
    })
    flushSubagentLiveBatch()

    // 写进了 live store
    const liveEntry = useSubagentLiveStore.getState().runsByRunId['sub-stream-1']
    expect(liveEntry).toBeTruthy()
    expect(liveEntry?.messages).toHaveLength(1)

    // **关键**：没走 metadata 路径（subagentHandler 的 upsertSubagentRunForSession）
    expect(store.upsertSubagentRunForSession).not.toHaveBeenCalled()

    useSubagentLiveStore.getState().clear()
  })

  // ─── Widget Wave 3 — cancel/error/terminated widget 保留 ─────────
  //
  // **W4.5 第二波 B2 物理删 RICH_CONTENT listener**：
  //   - daemon 0 处真 emit `agent.stream.rich_content`，工具产出统一走
  //     ContentBlock `tabtin_rich_content` 块（content_block_start/delta/stop
  //     三件套）。原 RICH_CONTENT widget upsert/append/in-flight FIFO 兜底
  //     测试 3 个随 listener 物理删——对应的 widget placeholder/final 字段
  //     合并逻辑迁到 contentBlockHandler 镜像分支（`event.block.type ===
  //     'tabtin_rich_content'`），由 contentBlockHandler.test.ts §4.5 W4a
  //     R2-P0-2 完整覆盖。
  //   - 本 describe 保留 Wave 3 lifecycle widget interrupt 行为（lifecycle
  //     phase=end/cancelled/error/terminated → 标 widget interrupted）——
  //     这些路径与 RICH_CONTENT 协议事件无关，仍由 lifecycleHandler 直接
  //     驱动 `markStreamingWidgetsInterruptedAndClearOthers` store action。
  describe('Widget Wave 3 — cancel/error/terminated widget 保留', () => {
    // ─── Widget Wave 3（RFC §五 3.6）—— cancel/error/terminated widget 保留 ───
    //
    // 业务目的：用户主动 cancel 时已渲染的 widget SVG 不应消失，而是带"已中断"
    // 标识保留可见。lifecycleHandler 的终态分支不再调 clearRichContentBlocks 全清，
    // 改成调 markStreamingWidgetsInterruptedAndClearOthers——widget 保留 + 标记
    // interrupted；非 widget kind 仍清空兼容旧行为。
    it('Wave 3 — lifecycle phase=end + cancelling=true → mark widget interrupted with cancelled', () => {
      const handler = makeHandler()
      // 先触发 cancelling 状态（用户按 cancel 后 phase=cancelling 事件已到）
      store.cancellingBySessionId['session-1'] = true
      handler({
        type: AgentStreamEvents.LIFECYCLE,
        payload: { phase: 'end' },
      })
      expect(store.markStreamingWidgetsInterruptedAndClearOthers).toHaveBeenCalledWith(
        'session-1',
        'cancelled',
      )
      // 旧 clearRichContentBlocks 路径应**不再被调**——widget 保留
      expect(store.clearRichContentBlocks).not.toHaveBeenCalled()
    })

    it('Wave 3 — lifecycle phase=error → mark widget interrupted with error', () => {
      const handler = makeHandler()
      handler({
        type: AgentStreamEvents.LIFECYCLE,
        payload: { phase: 'error', detail: 'something broke' },
      })
      expect(store.markStreamingWidgetsInterruptedAndClearOthers).toHaveBeenCalledWith(
        'session-1',
        'error',
      )
    })

    it('Wave 3 — lifecycle phase=terminated → mark widget interrupted with terminated', () => {
      const handler = makeHandler()
      handler({
        type: AgentStreamEvents.LIFECYCLE,
        payload: { phase: 'terminated' },
      })
      expect(store.markStreamingWidgetsInterruptedAndClearOthers).toHaveBeenCalledWith(
        'session-1',
        'terminated',
      )
    })

    it('Wave 3 — lifecycle phase=end 正常完成（非 cancel）→ mark with unknown（store 内幂等不影响 final widget）', () => {
      const handler = makeHandler()
      handler({
        type: AgentStreamEvents.LIFECYCLE,
        payload: { phase: 'end' },
      })
      // phase=end 且未 cancel → 'unknown'（实际 store action 内部对带 finalCode
      // 的 widget block 不会显示 interrupted UI，是兜底机制）
      expect(store.markStreamingWidgetsInterruptedAndClearOthers).toHaveBeenCalledWith(
        'session-1',
        'unknown',
      )
    })

    // Wave 4a 清理：原"端到端 placeholder→final"测试通过 TOOL_CALL_ARGS_DELTA
    // 触发 placeholder——已迁到 contentBlockHandler.test.ts §1.4 + §4。
    // W4.5 第二波 B2：final widget block 由 ContentBlock `tabtin_rich_content`
    // 块的 content_block_start 镜像驱动 upsert（contentBlockHandler 内），
    // RICH_CONTENT listener 已物理删——不再需要在 streamMessageHandler 内
    // 测试 final widget 合并。
  })

  // Wave 4a 清理（v2 §3.5.1 协议迁移）：
  //
  // 原 CONTENT_RESET describe（"clears assistant deltas for the run / skips
  // when run_id missing / marks last thinking step done"）随 W4a B 节物理删除——
  // dispatcher 不再 listen `AgentStreamEvents.CONTENT_RESET`，行为迁移到
  // `sendMessageAction.handleAssistantAbort`（监听 `message_delta(stop_reason='aborted')`），
  // 测试覆盖在 contentBlockHandler.test.ts §2.4。
  //
  // 原 Widget Wave 2.5 真流式 placeholder 注入 5 个 case（TOOL_CALL_ARGS_DELTA 触发）
  // 也随 W4a 物理删除——placeholder 注入逻辑迁到 contentBlockHandler 的
  // `handleContentBlockStart`（用 `event.block.id` 这一 LLM 原生 id 而非 envelope id），
  // 测试覆盖在 contentBlockHandler.test.ts §1.4 + §4。
  //
  // W4.5 第二波 B2 清理：原 3 个 RICH_CONTENT widget upsert/append/in-flight FIFO
  // 兜底测试随 listener 物理删——daemon 0 处真 emit，工具产出走 ContentBlock
  // `tabtin_rich_content` 块，由 contentBlockHandler 镜像逻辑承接 placeholder
  // 合并（contentBlockHandler.test.ts §4.5 W4a R2-P0-2 已覆盖）。

  // ── W4.5-A3 W4a-L28：dispatch 路由验证 ───────────────────────────
  // 关键：streamMessageHandler 必须把这 5 个事件路由到正确的子 handler，
  // 而不是落到 default 兜底。subagentHandler / systemHandler 内部行为由
  // 各自的 .test.ts 单独覆盖；本组只验"事件 → handler"路由完整性，防止
  // 重构 dispatcher 时漏接（silent drop 二代）。
  describe('W4.5-A3 W4a-L28：4 个事件 dispatch 路由完整性', () => {
    // W4.5 第三波 C1（2026-05-13）：原 TOOL_TIMEOUT 路由 case 已删除——wire 层
    // `StreamEvents.TOOL_TIMEOUT` 物理删，systemHandler 内 TOOL_TIMEOUT case 也删。
    // streamMessageHandler 不再 listen TOOL_TIMEOUT 事件类型。

    it('SUBAGENT_HITL_REQUIRED 路由到 subagentHandler → push agentStep system_notice', () => {
      const handler = makeHandler()
      handler({
        type: AgentStreamEvents.SUBAGENT_HITL_REQUIRED,
        payload: {
          subagent_run_id: 'sub-hitl-1',
          approval_id: 'apr-1',
          label: '研究员',
          prompt: '准备读敏感文件',
        },
      })
      expect(store.pushAgentStepForSession).toHaveBeenCalledTimes(1)
      const stepArg = (store.pushAgentStepForSession as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][1] as Record<string, unknown>
      expect(stepArg.noticeType).toBe('subagent_hitl_required')
      // 关键：原实现会把 HITL 事件错当成 SUBAGENT_STARTED 走 fallback path 写
      // SubagentRun.status='running'——本测试守住"不污染状态机"。
      expect(store.upsertSubagentRunForSession).not.toHaveBeenCalled()
    })

    it('SUBAGENT_QUEUED 路由到 subagentHandler → upsert SubagentRun status=queued', () => {
      const handler = makeHandler()
      handler({
        type: AgentStreamEvents.SUBAGENT_QUEUED,
        payload: {
          subagent_run_id: 'sub-q-1',
          label: '执行者',
        },
      })
      expect(store.upsertSubagentRunForSession).toHaveBeenCalledTimes(1)
      const runArg = (store.upsertSubagentRunForSession as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][1] as Record<string, unknown>
      expect(runArg.subagentRunId).toBe('sub-q-1')
      expect(runArg.status).toBe('queued')
    })

    it('SUBAGENT_MODEL_CALL 路由到 subagentHandler → 仅 observability，不动 store', () => {
      const handler = makeHandler()
      handler({
        type: AgentStreamEvents.SUBAGENT_MODEL_CALL,
        payload: {
          subagent_run_id: 'sub-m-1',
          model: 'claude-sonnet-4-20250514',
          iteration: 2,
        },
      })
      // 关键：原实现会把 MODEL_CALL 事件错当成 fallback 写 SubagentRun.status='running'
      // 覆盖已 completed 的子 Agent。本测试守住"observability 不污染状态机"。
      expect(store.upsertSubagentRunForSession).not.toHaveBeenCalled()
      expect(store.pushAgentStepForSession).not.toHaveBeenCalled()
    })

    it('SPEAKER_PUSH_MESSAGE 显式路由到 subagentHandler（不在 subagent_ 前缀里也接住）', () => {
      const handler = makeHandler()
      handler({
        type: AgentStreamEvents.SPEAKER_PUSH_MESSAGE,
        payload: {
          speaker_id: 'spkr-alice',
          content: '我完成了第一阶段。',
        },
      })
      expect(store.pushAgentStepForSession).toHaveBeenCalledTimes(1)
      const stepArg = (store.pushAgentStepForSession as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][1] as Record<string, unknown>
      expect(stepArg.noticeType).toBe('speaker_push_message')
    })
  })

  describe('#1434：HITL stream 事件路由', () => {
    it('approval_requested 经 streamMessageHandler 写入 pendingApproval', () => {
      const pending: Record<string, unknown> = {}
      hitlStoreAccessMock.access = {
        getState: () => ({
          pendingApprovalBySessionId: pending as never,
          approvalSubmittingBySessionId: {},
          pendingAskUserBySessionId: {},
          askUserSubmittingBySessionId: {},
        }),
        applyState: (partial) => {
          const slice = {
            pendingApprovalBySessionId: pending,
            approvalSubmittingBySessionId: {},
            pendingAskUserBySessionId: {},
            askUserSubmittingBySessionId: {},
          }
          const patch = typeof partial === 'function' ? partial(slice as never) : partial
          if (patch.pendingApprovalBySessionId) {
            Object.assign(pending, patch.pendingApprovalBySessionId)
          }
        },
        injectSystemMessage: vi.fn(),
        patchMessages: vi.fn(),
        rewriteSessionMessages: vi.fn((_sid, _reason, updater) => { updater([]) }),
        upsertHitlBubble: vi.fn(),
      }

      const handler = makeHandler()
      handler({
        type: 'agent.stream.approval_requested',
        payload: {
          batch_id: 'batch-stream-1',
          action_requests: [{ request_id: 'r1', tool_name: 'test_tool' }],
        },
      })

      expect(pending['session-1']).toMatchObject({ batchId: 'batch-stream-1' })
    })
  })
})
