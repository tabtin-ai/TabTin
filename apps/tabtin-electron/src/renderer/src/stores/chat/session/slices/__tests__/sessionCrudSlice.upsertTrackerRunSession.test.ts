/**
 * upsertTrackerRunSession 回归：单条注入不得标 trackerRunLoaded。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
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

function makeTrackerSession(id: string, spaceId: string): ChatSession {
  return {
    id,
    space_id: spaceId,
    title: `[Tracker] ${id}`,
    tracker_run: {
      run_id: `run-${id}`,
      run_index: 1,
      run_status: 'completed',
      tracker_id: 'tracker-1',
      tracker_name: 'test',
    },
  } as unknown as ChatSession
}

describe('upsertTrackerRunSession ', () => {
  const SPACE = 'space-1'
  let state: {
    sessions: ChatSession[]
    sessionsBySpaceId: Record<string, ChatSession[]>
    trackerRunSessionsBySpaceId: Record<string, ChatSession[]>
    trackerRunCountBySpaceId: Record<string, number>
    trackerRunLoadedBySpaceId: Record<string, boolean>
    trackerRunErrorBySpaceId: Record<string, string | null>
  }

  const get = () => state as unknown as SessionCrudStore
  const set = vi.fn((partial: unknown) => {
    const patch = typeof partial === 'function'
      ? (partial as (s: typeof state) => Partial<typeof state>)(state)
      : partial as Partial<typeof state>
    state = { ...state, ...patch }
  })

  const makeActions = () => createSessionCrudActions(
    get as never,
    set as never,
    {
      getChatClient: () => ({ sessions: { list: vi.fn() } }) as never,
      resolveActiveSpaceId: () => SPACE,
      emptySessions: [],
    },
  )

  beforeEach(() => {
    state = {
      sessions: [],
      sessionsBySpaceId: {},
      trackerRunSessionsBySpaceId: {},
      trackerRunCountBySpaceId: {},
      trackerRunLoadedBySpaceId: {},
      trackerRunErrorBySpaceId: {},
    }
    set.mockClear()
  })

  it('注入单条 session，且不把 trackerRunLoaded 标为 true', () => {
    const session = makeTrackerSession('s1', SPACE)
    makeActions().upsertTrackerRunSession(SPACE, session)

    expect(state.trackerRunSessionsBySpaceId[SPACE]?.map(s => s.id)).toEqual(['s1'])
    expect(state.trackerRunCountBySpaceId[SPACE]).toBe(1)
    expect(state.trackerRunLoadedBySpaceId[SPACE]).toBeUndefined()
  })

  it('已完整 loaded 时 upsert 不清除 loaded 标志', () => {
    state.trackerRunLoadedBySpaceId[SPACE] = true
    state.trackerRunSessionsBySpaceId[SPACE] = [makeTrackerSession('s0', SPACE)]
    state.trackerRunCountBySpaceId[SPACE] = 1

    makeActions().upsertTrackerRunSession(SPACE, makeTrackerSession('s1', SPACE))

    expect(state.trackerRunLoadedBySpaceId[SPACE]).toBe(true)
    expect(state.trackerRunSessionsBySpaceId[SPACE]?.map(s => s.id)).toEqual(['s1', 's0'])
  })

  it('注入 Tracker Run 时清理普通会话桶里的同 id 污染项', () => {
    const polluted = makeTrackerSession('s1', SPACE)
    state.sessions = [polluted]
    state.sessionsBySpaceId[SPACE] = [polluted]

    makeActions().upsertTrackerRunSession(SPACE, makeTrackerSession('s1', SPACE))

    expect(state.sessions).toEqual([])
    expect(state.sessionsBySpaceId[SPACE]).toEqual([])
    expect(state.trackerRunSessionsBySpaceId[SPACE]?.map(s => s.id)).toEqual(['s1'])
  })

  it('会话归属变化时从其它 Tracker 桶移除同 id 旧快照', () => {
    state.trackerRunSessionsBySpaceId['old-space'] = [
      makeTrackerSession('s1', 'old-space'),
    ]

    makeActions().upsertTrackerRunSession(SPACE, makeTrackerSession('s1', SPACE))

    expect(state.trackerRunSessionsBySpaceId['old-space']).toEqual([])
    expect(state.trackerRunSessionsBySpaceId[SPACE]?.map(s => s.id)).toEqual(['s1'])
  })
})
