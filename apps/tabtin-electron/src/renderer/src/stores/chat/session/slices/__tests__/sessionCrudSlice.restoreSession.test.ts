/**
 * restoreSession 回归测试。
 *
 * 归档管理面板此前只能查看/永久删除已归档会话，没有恢复入口——本 action
 * 补上恢复路径：`PUT status=active`，成功后把会话写回 sessionsBySpaceId
 * （已在桶里则替换，否则 prepend），当前激活 space 同步刷新 sessions 视图。
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

function makeSession(id: string, spaceId: string, status: string = 'active'): ChatSession {
  return { id, space_id: spaceId, title: `session-${id}`, status } as unknown as ChatSession
}

describe('restoreSession（：归档会话恢复）', () => {
  const SPACE = 'space-team-1'
  let state: {
    sessions: ChatSession[]
    sessionsBySpaceId: Record<string, ChatSession[]>
    trackerRunCountBySpaceId: Record<string, number | null>
    isLoading: boolean
  }
  const updateMock = vi.fn()

  const get = () => ({ ...state }) as unknown as SessionCrudStore

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
      getChatClient: () => ({ sessions: { list: vi.fn(), update: updateMock } }) as never,
      resolveActiveSpaceId: () => activeSpaceId,
      emptySessions: [],
    },
  )

  beforeEach(() => {
    state = { sessions: [], sessionsBySpaceId: {}, trackerRunCountBySpaceId: {}, isLoading: false }
    updateMock.mockReset()
    set.mockClear()
  })

  it('调用后端 PUT status=active', async () => {
    const restored = makeSession('s-archived', SPACE, 'active')
    updateMock.mockResolvedValue(restored)

    await makeActions().restoreSession(SPACE, 's-archived')

    expect(updateMock).toHaveBeenCalledWith('s-archived', { status: 'active' })
  })

  it('恢复成功：会话 prepend 回桶，并同步当前激活 space 的 sessions 视图', async () => {
    const existing = [makeSession('s1', SPACE)]
    state.sessionsBySpaceId[SPACE] = existing
    state.sessions = existing
    const restored = makeSession('s-archived', SPACE, 'active')
    updateMock.mockResolvedValue(restored)

    await makeActions().restoreSession(SPACE, 's-archived')

    expect(state.sessionsBySpaceId[SPACE]).toEqual([restored, ...existing])
    expect(state.sessions).toEqual([restored, ...existing])
  })

  it('非当前激活 space：只写桶，不覆盖 sessions 视图', async () => {
    const existing = [makeSession('s1', SPACE)]
    state.sessionsBySpaceId[SPACE] = existing
    state.sessions = existing
    const restored = makeSession('s-archived', SPACE, 'active')
    updateMock.mockResolvedValue(restored)

    await makeActions(null).restoreSession(SPACE, 's-archived')

    expect(state.sessionsBySpaceId[SPACE]).toEqual([restored, ...existing])
    expect(state.sessions).toEqual(existing)
  })

  it('会话已在桶里（重复恢复）：原地替换而不是重复插入', async () => {
    const stale = makeSession('s-archived', SPACE, 'archived')
    state.sessionsBySpaceId[SPACE] = [stale]
    state.sessions = [stale]
    const restored = makeSession('s-archived', SPACE, 'active')
    updateMock.mockResolvedValue(restored)

    await makeActions().restoreSession(SPACE, 's-archived')

    expect(state.sessionsBySpaceId[SPACE]).toEqual([restored])
  })

  it('后端更新失败：不改本地状态，异常向上抛出', async () => {
    state.sessionsBySpaceId[SPACE] = []
    updateMock.mockRejectedValue(new Error('network down'))

    await expect(makeActions().restoreSession(SPACE, 's-archived')).rejects.toThrow('network down')
    expect(state.sessionsBySpaceId[SPACE]).toEqual([])
  })
})

describe('viewArchivedSession（：查看≠取消归档）', () => {
  const SPACE = 'space-team-1'
  const upsertMock = vi.fn()
  const selectMock = vi.fn()
  const setCurrentMock = vi.fn()
  let state: {
    sessions: ChatSession[]
    sessionsBySpaceId: Record<string, ChatSession[]>
    upsertSessionInSpace: typeof upsertMock
    selectSession: typeof selectMock
    setCurrentSessionForSpace: typeof setCurrentMock
  }

  const get = () => ({ ...state }) as unknown as SessionCrudStore
  const set = vi.fn()

  const makeActions = () => createSessionCrudActions(
    get as never,
    set as never,
    {
      getChatClient: () => ({ sessions: { update: vi.fn() } }) as never,
      resolveActiveSpaceId: () => SPACE,
      emptySessions: [],
    },
  )

  beforeEach(() => {
    upsertMock.mockReset()
    selectMock.mockReset()
    setCurrentMock.mockReset()
    selectMock.mockResolvedValue(undefined)
    state = {
      sessions: [],
      sessionsBySpaceId: {},
      upsertSessionInSpace: upsertMock,
      selectSession: selectMock,
      setCurrentSessionForSpace: setCurrentMock,
    }
    set.mockClear()
  })

  it('不调用 PUT status=active，只钉住缓存并 select', async () => {
    const archived = makeSession('s-archived', SPACE, 'archived')
    const updateMock = vi.fn()
    const actions = createSessionCrudActions(
      get as never,
      set as never,
      {
        getChatClient: () => ({ sessions: { update: updateMock } }) as never,
        resolveActiveSpaceId: () => SPACE,
        emptySessions: [],
      },
    )

    await actions.viewArchivedSession(SPACE, archived)

    expect(updateMock).not.toHaveBeenCalled()
    expect(upsertMock).toHaveBeenCalledWith(SPACE, expect.objectContaining({
      id: 's-archived',
      status: 'archived',
    }))
    expect(selectMock).toHaveBeenCalledWith(SPACE, 's-archived')
    expect(setCurrentMock).toHaveBeenCalledWith(SPACE, 's-archived', true)
  })

  it('select 失败时向上抛出', async () => {
    selectMock.mockRejectedValue(new Error('select failed'))
    await expect(
      makeActions().viewArchivedSession(SPACE, makeSession('s-archived', SPACE, 'archived')),
    ).rejects.toThrow('select failed')
  })
})
