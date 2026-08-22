import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatMessage } from '@tabtin/chat-client'

vi.mock('../messageBlocks', () => ({
  hydrateSessionBlocksFromJson: vi.fn((messages: unknown[]) => ({
    messages,
    hydratedMids: [],
    changed: false,
  })),
}))

vi.mock('../../execution/sessionRunProjection', () => ({
  isSessionBusy: () => false,
}))

vi.mock('../messageCache', () => ({
  cacheMessages: vi.fn(),
}))

vi.mock('@/services/agentService/sessionMessages', () => ({
  getSessionMessagesFacade: () => ({
    getMessages: () => [],
    advanceWatermark: vi.fn(),
  }),
}))

vi.mock('../../session/utils/evictSessionData', () => ({
  evictChatStoreSessionData: () => ({}),
  evictChatStoreSessionDataBatch: () => ({}),
}))

vi.mock('../../../useChatRuntimeStore', () => ({
  useChatRuntimeStore: { getState: () => ({ evictSession: vi.fn() }) },
}))

vi.mock('../../../useWsConnectionStore', () => ({
  useWsConnectionStore: { getState: () => ({ removeSuspendedSession: vi.fn() }) },
}))

vi.mock('@/stores/chat/domain/messageTimelineOrder', () => ({
  sortMessagesForTimeline: <T,>(messages: T[]) => messages,
}))

import {
  registerRestoringSessionProvider,
} from '@/services/agentService/messageWriteGate'
import { createMessageCacheActions } from '../messageCacheSlice'

type Root = {
  messagesBySessionId: Record<string, ChatMessage[]>
  sessions: []
  sessionsBySpaceId: Record<string, never>
  sessionsHydrated: boolean
  currentSessionId: string | null
  currentSessionIdBySpaceId: Record<string, never>
  draftSessionBySpaceId: Record<string, never>
  restoringSessionId: string | null
  pendingApprovalBySessionId: Record<string, never>
  pendingAskUserBySessionId: Record<string, never>
}

describe('messageCacheSlice.rebindMessageIds ', () => {
  let state: Root

  beforeEach(() => {
    state = {
      messagesBySessionId: {},
      sessions: [],
      sessionsBySpaceId: {},
      sessionsHydrated: false,
      currentSessionId: null,
      currentSessionIdBySpaceId: {},
      draftSessionBySpaceId: {},
      restoringSessionId: null,
      pendingApprovalBySessionId: {},
      pendingAskUserBySessionId: {},
    }
  })

  function actions() {
    return createMessageCacheActions(
      () => state,
      (partial) => {
        const next = typeof partial === 'function' ? partial(state) : partial
        Object.assign(state, next)
      },
    )
  }

  it('local-* → UUID 且无 client_event_id 时回写 client_event_id', () => {
    const localId = 'local-4b016503-1783998941-cd'
    state.messagesBySessionId['s1'] = [
      {
        id: localId,
        role: 'assistant',
        content: '',
        created_at: '2026-07-14T03:15:40.000Z',
      } as ChatMessage,
    ]

    actions().rebindMessageIds('s1', [[localId, 'server-assistant-acked']])

    const msg = state.messagesBySessionId['s1'][0]
    expect(msg.id).toBe('server-assistant-acked')
    expect(msg.client_event_id).toBe(localId)
  })

  it('已有 client_event_id 时不覆盖', () => {
    state.messagesBySessionId['s1'] = [
      {
        id: 'local-abc-1',
        role: 'assistant',
        content: '',
        created_at: '2026-07-14T03:15:40.000Z',
        client_event_id: 'already-set',
      } as ChatMessage,
    ]

    actions().rebindMessageIds('s1', [['local-abc-1', 'server-uuid']])

    const msg = state.messagesBySessionId['s1'][0]
    expect(msg.id).toBe('server-uuid')
    expect(msg.client_event_id).toBe('already-set')
  })

  it('user 重绑仍标记 sendStatus=sent', () => {
    state.messagesBySessionId['s1'] = [
      {
        id: 'local-user-1',
        role: 'user',
        content: 'hi',
        created_at: '2026-07-14T03:15:40.000Z',
      } as ChatMessage,
    ]

    actions().rebindMessageIds('s1', [['local-user-1', 'server-user']])

    const msg = state.messagesBySessionId['s1'][0] as ChatMessage & { sendStatus?: string }
    expect(msg.id).toBe('server-user')
    expect(msg.client_event_id).toBe('local-user-1')
    expect(msg.sendStatus).toBe('sent')
  })
})

describe('upsertObservedUserMessage ·  runtime arrival 回写', () => {
  let state: Root

  beforeEach(() => {
    state = {
      messagesBySessionId: {},
      sessions: [],
      sessionsBySpaceId: {},
      sessionsHydrated: false,
      currentSessionId: null,
      currentSessionIdBySpaceId: {},
      draftSessionBySpaceId: {},
      restoringSessionId: null,
      pendingApprovalBySessionId: {},
      pendingAskUserBySessionId: {},
    }
  })

  function actions() {
    return createMessageCacheActions(
      () => state,
      (partial) => {
        const next = typeof partial === 'function' ? partial(state) : partial
        Object.assign(state, next)
      },
    )
  }

  it('identity 命中时回写 runtime arrival_seq，不再 no-op', () => {
    state.messagesBySessionId['s1'] = [
      {
        id: 'client-u2',
        role: 'user',
        content: '今天天气怎么样',
        created_at: '2026-08-07T05:00:01.000Z',
        content_blocks_json: [{ type: 'text', text: '今天天气怎么样' }],
        metadata: { client_message_id: 'client-u2' },
        sendStatus: 'sending',
      } as ChatMessage,
    ]

    actions().upsertObservedUserMessage('s1', {
      id: 'client-u2',
      role: 'user',
      content: '今天天气怎么样',
      created_at: '2026-08-07T05:00:05.000Z',
      client_event_id: 'client-u2',
      content_blocks_json: [{
        type: 'text',
        text: '今天天气怎么样',
        arrival_seq: 9_000,
      }],
      metadata: { client_message_id: 'client-u2', client_event_id: 'client-u2' },
    } as ChatMessage)

    const msg = state.messagesBySessionId['s1'][0] as ChatMessage & { sendStatus?: string }
    expect(msg.id).toBe('client-u2')
    expect(msg.sendStatus).toBe('sending')
    expect(msg.created_at).toBe('2026-08-07T05:00:05.000Z')
    expect((msg.content_blocks_json?.[0] as { arrival_seq?: number }).arrival_seq).toBe(9_000)
  })
})

describe('#9066 ensureAssistantMessage blocked while restoring', () => {
  let state: Root

  beforeEach(() => {
    state = {
      messagesBySessionId: { s1: [] },
      sessions: [],
      sessionsBySpaceId: {},
      sessionsHydrated: false,
      currentSessionId: 's1',
      currentSessionIdBySpaceId: {},
      draftSessionBySpaceId: {},
      restoringSessionId: 's1',
      pendingApprovalBySessionId: {},
      pendingAskUserBySessionId: {},
    }
    registerRestoringSessionProvider((sid) => state.restoringSessionId === sid)
  })

  it('restoring 期间不追加空 assistant 壳', () => {
    const actions = createMessageCacheActions(
      () => state,
      (partial) => {
        const next = typeof partial === 'function' ? partial(state) : partial
        Object.assign(state, next)
      },
    )

    actions.ensureAssistantMessage('s1', {
      id: 'a-empty',
      role: 'assistant',
      content: '',
      created_at: '2026-08-04T00:00:00.000Z',
    } as ChatMessage)

    expect(state.messagesBySessionId.s1).toEqual([])
  })

  it('restoring 结束后可建壳', () => {
    state.restoringSessionId = null
    const actions = createMessageCacheActions(
      () => state,
      (partial) => {
        const next = typeof partial === 'function' ? partial(state) : partial
        Object.assign(state, next)
      },
    )

    actions.ensureAssistantMessage('s1', {
      id: 'a-ok',
      role: 'assistant',
      content: '',
      created_at: '2026-08-04T00:00:00.000Z',
    } as ChatMessage)

    expect(state.messagesBySessionId.s1.map((m) => m.id)).toEqual(['a-ok'])
  })
})
