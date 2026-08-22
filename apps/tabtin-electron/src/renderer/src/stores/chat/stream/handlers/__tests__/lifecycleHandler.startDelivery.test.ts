/**
 * ：lifecycle phase=start 清 sending 的行为断言（非源码嗅探）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatMessage } from '@tabtin/chat-client'
import type { HandlerContext } from '../streamHandlerTypes'

const storeState = {
  messagesBySessionId: {} as Record<string, ChatMessage[]>,
  patchMessageById: (
    sessionId: string,
    messageId: string,
    patcher: (message: ChatMessage) => ChatMessage,
  ) => {
    const prev = storeState.messagesBySessionId[sessionId] ?? []
    storeState.messagesBySessionId = {
      ...storeState.messagesBySessionId,
      [sessionId]: prev.map((m) => (m.id === messageId ? patcher(m) : m)),
    }
  },
}

vi.mock('@stores/chat/useChatStore', () => ({
  useChatStore: Object.assign(
    (selector?: (s: typeof storeState) => unknown) => (
      typeof selector === 'function' ? selector(storeState) : storeState
    ),
    { getState: () => storeState },
  ),
}))

vi.mock('@/i18n', () => ({
  default: { t: (key: string) => key },
}))

vi.mock('../lifecycleTerminalNotify', () => ({
  ackLifecycleSessionViewedIfPresent: vi.fn(),
  emitOrAckLifecycleTerminalNotification: vi.fn(),
}))

vi.mock('../sessionCleanup', () => ({
  cleanupSessionOnTerminal: vi.fn(),
}))

vi.mock('../assistantSessionState', () => ({
  clearActiveThinking: vi.fn(),
  clearAssistantErrorMeta: vi.fn(),
}))

vi.mock('../errorHandler', () => ({
  handleError: vi.fn(),
}))

vi.mock('../toolCallArgsBufferStore', () => ({
  clearToolCallArgsBuffers: vi.fn(),
  gcStaleToolCallArgsBuffers: vi.fn(),
}))

vi.mock('../../messages/messageCache', () => ({
  cacheMessages: vi.fn(),
}))

vi.mock('../../messages/actions/titleGenerationDedupe', () => ({
  defaultShouldGenerateTitle: () => false,
  requestTitleGenerationOnce: vi.fn(),
}))

vi.mock('../../execution/sessionRunProjection', () => ({
  isSessionBusy: () => false,
}))

vi.mock('../../execution/chatTelemetry', () => ({
  trackChatTelemetry: vi.fn(),
}))

vi.mock('@/services/compactNotificationSummary', () => ({
  compactNotificationSummary: (s: string) => s,
}))

vi.mock('@/utils/chatSessionTokenUsage', () => ({
  extractChatSessionTokenUsage: () => ({}),
  omitMonotonicTokenFields: (v: unknown) => v,
}))

import { handleLifecycleEvent } from '../lifecycleHandler'

const CLIENT_ID = '11111111-1111-4111-8111-111111111111'
const RUN_ID = '9796076a-2faa-48ba-957b-ea76667a05be'
const SESSION_ID = 'session-1'

function makeCtx(overrides: Partial<HandlerContext> = {}): HandlerContext {
  const updateRunStateForSession = vi.fn()
  return {
    sessionId: SESSION_ID,
    spaceId: 'space-1',
    sessionTitle: '',
    notifyPrefix: '',
    get: () => ({
      agentStepsBySessionId: { [SESSION_ID]: [] },
      updateAgentStepForSession: vi.fn(),
      updateRunStateForSession,
    }),
    addStreamingSession: vi.fn(),
    removeStreamingSession: vi.fn(),
    client: {} as HandlerContext['client'],
    updateSessionTokenUsageInCaches: vi.fn(),
    updateSessionInCaches: vi.fn(),
    onLifecycleEnd: vi.fn(),
    ...overrides,
  } as unknown as HandlerContext
}

describe('handleLifecycleEvent phase=start · ', () => {
  beforeEach(() => {
    storeState.messagesBySessionId = {
      [SESSION_ID]: [
        {
          id: 'temp-user-1',
          role: 'user',
          content: '建一张表',
          created_at: '2026-07-22T00:00:00.000Z',
          metadata: { client_message_id: CLIENT_ID },
          sendStatus: 'sending',
        } as ChatMessage,
      ],
    }
  })

  it('携带 source_client_event_id 时标 sent（即使 run_id 不同）', () => {
    const ctx = makeCtx()
    handleLifecycleEvent(
      {
        type: 'agent.stream.lifecycle',
        payload: {
          phase: 'start',
          run_id: RUN_ID,
          source_client_event_id: CLIENT_ID,
        },
      },
      ctx,
    )
    const user = storeState.messagesBySessionId[SESSION_ID][0] as ChatMessage & {
      sendStatus?: string
    }
    expect(user.sendStatus).toBe('sent')
    expect(ctx.addStreamingSession).toHaveBeenCalledWith(SESSION_ID, RUN_ID)
  })

  it('仅有 run_id 时不标 sent（禁止错键）', () => {
    const ctx = makeCtx()
    handleLifecycleEvent(
      {
        type: 'agent.stream.lifecycle',
        payload: {
          phase: 'start',
          run_id: RUN_ID,
        },
      },
      ctx,
    )
    const user = storeState.messagesBySessionId[SESSION_ID][0] as ChatMessage & {
      sendStatus?: string
    }
    expect(user.sendStatus).toBe('sending')
  })
})
