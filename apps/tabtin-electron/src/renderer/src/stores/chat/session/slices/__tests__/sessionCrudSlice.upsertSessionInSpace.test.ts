/**
 * upsertSessionInSpace 回归测试（ WS 推送消费端）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ChatSession } from '@tabtin/chat-client'
import { createSessionCrudActions, type SessionCrudStore } from '../sessionCrudSlice'

vi.mock('@/utils/logger', () => ({
  logger: { log: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  createLogger: () => ({ log: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}))

vi.mock('../../../execution/chatTelemetry', () => ({
  trackChatTelemetry: vi.fn(),
}))

vi.mock('@/stores/chat/domain/messageSyncAction', () => ({
  mergeMessagesFromServer: (_current: unknown, incoming: unknown) => ({ messages: incoming }),
}))
vi.mock('../../../stream/handlers/historyRestoreHelper', () => ({ restoreRuntimeStateFromHistory: vi.fn() }))
vi.mock('../../utils/evictSessionData', () => ({ evictChatStoreSessionData: vi.fn(() => ({})) }))
vi.mock('../../../messages/messageCache', () => ({
  getCachedMessages: vi.fn(),
  cacheMessages: vi.fn(),
  appendCachedMessages: vi.fn(),
  touchSessionMeta: vi.fn(),
}))
vi.mock('../../../messages/actions/titleGenerationDedupe', () => ({ requestTitleGenerationOnce: vi.fn() }))
vi.mock('../../../../useChatSplitStore', () => ({ useChatSplitStore: { getState: () => ({}) } }))
vi.mock('../../../../useSpaceContextTabsStore', () => ({ useSpaceContextTabsStore: { getState: () => ({}) } }))
vi.mock('../../../../useChatRuntimeStore', () => ({ useChatRuntimeStore: { getState: () => ({}) } }))
vi.mock('../../../../useSessionReadStore', () => ({ useSessionReadStore: { getState: () => ({}) } }))
vi.mock('@/services/sessionFreshness', () => ({ markSessionFresh: vi.fn(), markSessionStale: vi.fn() }))
vi.mock('@tabtin/smartsheet-ui/toast', () => ({ toast: vi.fn() }))
vi.mock('@/i18n', () => ({ default: { t: (k: string) => k } }))

function makeSession(id: string, spaceId: string): ChatSession {
  return { id, space_id: spaceId, title: `session-${id}` } as unknown as ChatSession
}

describe('upsertSessionInSpace', () => {
  const SPACE = 'space-team-1'
  let state: {
    sessions: ChatSession[]
    sessionsBySpaceId: Record<string, ChatSession[]>
    trackerRunCountBySpaceId: Record<string, number | null>
    isLoading: boolean
  }
  const setSpaceSessions = vi.fn((spaceId: string, sessions: ChatSession[], syncCurrent?: boolean) => {
    state.sessionsBySpaceId = { ...state.sessionsBySpaceId, [spaceId]: sessions }
    if (syncCurrent) state.sessions = sessions
  })

  const get = () => ({
    ...state,
    setSpaceSessions,
  }) as unknown as SessionCrudStore

  const set = vi.fn((partial: unknown) => {
    const patch = typeof partial === 'function'
      ? (partial as (s: typeof state) => Partial<typeof state>)(state)
      : partial as Partial<typeof state>
    state = { ...state, ...patch }
  })

  const makeActions = (activeSpaceId: string | null = SPACE) => createSessionCrudActions(
    get as never,
    set as never,
    {
      getChatClient: () => ({ sessions: { list: vi.fn() } }) as never,
      resolveActiveSpaceId: () => activeSpaceId,
      emptySessions: [],
    },
  )

  beforeEach(() => {
    state = { sessions: [], sessionsBySpaceId: {}, trackerRunCountBySpaceId: {}, isLoading: false }
    setSpaceSessions.mockClear()
    set.mockClear()
  })

  it('桶未加载时用新会话初始化桶', () => {
    makeActions().upsertSessionInSpace(SPACE, makeSession('s-new', SPACE))
    expect(setSpaceSessions).toHaveBeenCalledWith(
      SPACE,
      [makeSession('s-new', SPACE)],
      true,
    )
  })

  it('已加载桶：prepend 新会话并 sync 当前 space 视图', () => {
    const existing = [makeSession('s1', SPACE)]
    state.sessionsBySpaceId[SPACE] = existing

    makeActions().upsertSessionInSpace(SPACE, makeSession('s-new', SPACE))

    expect(setSpaceSessions).toHaveBeenCalledWith(
      SPACE,
      [makeSession('s-new', SPACE), ...existing],
      true,
    )
  })

  it('非当前激活 space：只写桶不同步 sessions 视图', () => {
    const existing = [makeSession('s1', SPACE)]
    state.sessionsBySpaceId[SPACE] = existing

    makeActions(null).upsertSessionInSpace(SPACE, makeSession('s-new', SPACE))

    expect(setSpaceSessions).toHaveBeenCalledWith(
      SPACE,
      [makeSession('s-new', SPACE), ...existing],
      false,
    )
  })

  it('重复 session id 去重', () => {
    state.sessionsBySpaceId[SPACE] = [makeSession('s1', SPACE)]

    makeActions().upsertSessionInSpace(SPACE, makeSession('s1', SPACE))

    expect(setSpaceSessions).not.toHaveBeenCalled()
  })
})
