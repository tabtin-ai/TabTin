/**
 * ：服务端 403/404 时清除已渲染本地/IDB/内存正文，停止继续展示私有 session。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ChatSession, ChatMessage } from '@tabtin/chat-client'
import {
  createSessionCrudActions,
  isSessionAccessDeniedError,
  type SessionCrudStore,
} from '../sessionCrudSlice'

vi.mock('@/utils/logger', () => ({
  logger: { log: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  createLogger: () => ({ log: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}))
vi.mock('../../../execution/chatTelemetry', () => ({ trackChatTelemetry: vi.fn() }))
vi.mock('../../../stream/handlers/historyRestoreHelper', () => ({
  restoreRuntimeStateFromHistory: () => ({ agentSteps: [], toolEvents: [], agentMode: null }),
}))
vi.mock('../../utils/evictSessionData', () => ({ evictChatStoreSessionData: vi.fn(() => ({})) }))
vi.mock('../../../messages/messageCache', () => ({
  getCachedMessages: vi.fn(async () => undefined),
  cacheMessages: vi.fn(),
  appendCachedMessages: vi.fn(),
  touchSessionMeta: vi.fn(),
  clearSessionCache: vi.fn(async () => undefined),
}))
vi.mock('../../../messages/actions/titleGenerationDedupe', () => ({ requestTitleGenerationOnce: vi.fn() }))
vi.mock('../../../../useChatSplitStore', () => ({ useChatSplitStore: { getState: () => ({}) } }))
vi.mock('../../../../useSpaceContextTabsStore', () => ({ useSpaceContextTabsStore: { getState: () => ({}) } }))

const evictSessionMock = vi.fn()
vi.mock('../../../../useChatRuntimeStore', () => ({
  useChatRuntimeStore: {
    getState: () => ({
      reconcileSubagentRunsFromArchive: vi.fn(),
      evictSession: evictSessionMock,
    }),
    setState: vi.fn(),
  },
}))
vi.mock('../../../../useSessionReadStore', () => ({
  useSessionReadStore: { getState: () => ({ markViewed: vi.fn() }) },
}))
vi.mock('@/services/sessionFreshness', () => ({ markSessionFresh: vi.fn(), markSessionStale: vi.fn() }))
vi.mock('@tabtin/smartsheet-ui/toast', () => ({ toast: vi.fn() }))
vi.mock('@/i18n', () => ({ default: { t: (k: string) => k } }))
vi.mock('@/services/localAgentClient', () => ({ isLocalRuntimeAvailable: () => true }))
vi.mock('@/services/localTranscript', async (importActual) => {
  const actual = await importActual<typeof import('@/services/localTranscript')>()
  return { ...actual, hasLocalTranscript: vi.fn(async () => true), readLocalTranscript: vi.fn() }
})

import { clearSessionCache } from '../../../messages/messageCache'
import { readLocalTranscript } from '@/services/localTranscript'

function makeSession(id: string, spaceId: string): ChatSession {
  return { id, space_id: spaceId, title: `session-${id}`, title_is_default: false } as unknown as ChatSession
}

describe('#6853 session access denied purge', () => {
  const SPACE = 'space-1'
  const SESSION = 'session-private'

  type State = {
    sessions: ChatSession[]
    sessionsBySpaceId: Record<string, ChatSession[]>
    currentSessionId: string | null
    currentSessionIdBySpaceId: Record<string, string | null>
    messagesBySessionId: Record<string, ChatMessage[]>
    hasMoreBySessionId: Record<string, boolean>
    checkpointsBySessionId: Record<string, Record<string, string>>
    lastContextSyncFingerprintBySessionId: Record<string, string>
    isLoading: boolean
  }
  let state: State

  const setSessionMessages = vi.fn((sessionId: string, messages: ChatMessage[]) => {
    state.messagesBySessionId = { ...state.messagesBySessionId, [sessionId]: messages }
  })
  const setSpaceSessions = vi.fn((spaceId: string, sessions: ChatSession[]) => {
    state.sessionsBySpaceId = { ...state.sessionsBySpaceId, [spaceId]: sessions }
    state.sessions = sessions
  })
  const setCurrentSessionForSpace = vi.fn((spaceId: string, sessionId: string | null) => {
    state.currentSessionIdBySpaceId = { ...state.currentSessionIdBySpaceId, [spaceId]: sessionId }
    state.currentSessionId = sessionId
  })

  const get = () => ({
    ...state,
    setSessionMessages,
    applyLoadedMessages: (sid: string, messages: ChatMessage[]) => setSessionMessages(sid, messages),
    hydrateFromCache: (sid: string, messages: ChatMessage[]) => setSessionMessages(sid, messages),
    clearSessionMessages: (sid: string) => setSessionMessages(sid, []),
    setSpaceSessions,
    setCurrentSessionForSpace,
  }) as unknown as SessionCrudStore

  const set = vi.fn((partial: unknown) => {
    const patch = typeof partial === 'function'
      ? (partial as (s: State) => Partial<State>)(state)
      : partial as Partial<State>
    state = { ...state, ...patch }
  })

  const listMock = vi.fn()
  const makeActions = () => createSessionCrudActions(get as never, set as never, {
    getChatClient: () => ({ messages: { list: listMock } }) as never,
    resolveActiveSpaceId: () => SPACE,
    emptySessions: [],
  })

  beforeEach(() => {
    state = {
      sessions: [makeSession(SESSION, SPACE)],
      sessionsBySpaceId: { [SPACE]: [makeSession(SESSION, SPACE)] },
      currentSessionId: SESSION,
      currentSessionIdBySpaceId: { [SPACE]: SESSION },
      messagesBySessionId: {},
      hasMoreBySessionId: {},
      checkpointsBySessionId: {},
      lastContextSyncFingerprintBySessionId: {},
      isLoading: false,
    }
    setSessionMessages.mockClear()
    setSpaceSessions.mockClear()
    setCurrentSessionForSpace.mockClear()
    evictSessionMock.mockClear()
    listMock.mockReset()
    vi.mocked(readLocalTranscript).mockReset()
    vi.mocked(clearSessionCache).mockClear()
  })

  it('isSessionAccessDeniedError 识别 403/404/NOT_FOUND', () => {
    expect(isSessionAccessDeniedError({ statusCode: 404, code: 'NOT_FOUND' })).toBe(true)
    expect(isSessionAccessDeniedError({ statusCode: 403, code: 'FORBIDDEN' })).toBe(true)
    expect(isSessionAccessDeniedError({ code: 'NOT_FOUND' })).toBe(true)
    expect(isSessionAccessDeniedError({ message: 'Error: NOT_FOUND' })).toBe(true)
    expect(isSessionAccessDeniedError({ statusCode: 500 })).toBe(false)
    expect(isSessionAccessDeniedError(new Error('network'))).toBe(false)
  })

  it('selectSession：本地 transcript 渲染后 enrich 404 会清空正文与会话桶', async () => {
    vi.mocked(readLocalTranscript).mockResolvedValue([
      { id: 'u1', role: 'user', content: '私有正文不应留下', created_at: '2026-07-14T00:00:00.000Z' },
    ] as ChatMessage[])
    listMock.mockRejectedValue({ statusCode: 404, code: 'NOT_FOUND', message: '会话不存在' })

    await makeActions().selectSession(SPACE, SESSION)
    // enrich 是 fire-and-forget；等微任务把 purge 跑完
    await vi.waitFor(() => {
      expect(state.messagesBySessionId[SESSION]).toEqual([])
    })

    expect(clearSessionCache).toHaveBeenCalledWith(SESSION)
    expect(evictSessionMock).toHaveBeenCalledWith(SESSION)
    expect(setSpaceSessions).toHaveBeenCalled()
    const lastBucket = setSpaceSessions.mock.calls.at(-1)?.[1] as ChatSession[]
    expect(lastBucket.find(s => s.id === SESSION)).toBeUndefined()
  })
})
