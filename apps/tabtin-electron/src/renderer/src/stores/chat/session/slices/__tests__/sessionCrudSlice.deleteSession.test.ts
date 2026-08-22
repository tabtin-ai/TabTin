/**
 * ：归档确认后立刻下架；PUT / abort 失败再回滚。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ChatSession } from '@tabtin/chat-client'
import { isSessionShareArchiveConflict } from '../../isSessionShareArchiveConflict'
import {
  createSessionCrudActions,
  type SessionCrudStore,
} from '../sessionCrudSlice'

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
vi.mock('../../../../useChatSplitStore', () => ({
  useChatSplitStore: { getState: () => ({ cleanupDeletedSession: vi.fn() }) },
}))
vi.mock('../../../../useSpaceContextTabsStore', () => ({
  useSpaceContextTabsStore: {
    getState: () => ({ clearOrphanSubagentTabs: vi.fn(), clearSpaceTabs: vi.fn() }),
  },
}))
vi.mock('../../../../useChatRuntimeStore', () => ({
  useChatRuntimeStore: { getState: () => ({ evictSession: vi.fn() }) },
}))
vi.mock('../../../../useSessionReadStore', () => ({
  useSessionReadStore: { getState: () => ({ clearSession: vi.fn() }) },
}))
vi.mock('@/services/sessionFreshness', () => ({ markSessionFresh: vi.fn(), markSessionStale: vi.fn() }))
vi.mock('@tabtin/smartsheet-ui/toast', () => ({ toast: vi.fn() }))
vi.mock('@/i18n', () => ({ default: { t: (k: string) => k } }))

function makeSession(id: string, spaceId: string, status = 'active'): ChatSession {
  return { id, space_id: spaceId, title: `session-${id}`, status } as unknown as ChatSession
}

describe('deleteSession optimistic archive', () => {
  const SPACE = 'space-team-1'
  let state: {
    sessions: ChatSession[]
    sessionsBySpaceId: Record<string, ChatSession[]>
    currentSessionId: string | null
    currentSessionIdBySpaceId: Record<string, string | null>
    trackerRunSessionsBySpaceId: Record<string, ChatSession[]>
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
      getChatClient: () => ({ sessions: { update: updateMock } }) as never,
      resolveActiveSpaceId: () => activeSpaceId,
      emptySessions: [],
    },
  )

  beforeEach(() => {
    Reflect.deleteProperty(window, 'tabtin')
    const first = makeSession('s1', SPACE)
    const second = makeSession('s2', SPACE)
    state = {
      sessions: [first, second],
      sessionsBySpaceId: { [SPACE]: [first, second] },
      currentSessionId: 's1',
      currentSessionIdBySpaceId: { [SPACE]: 's1' },
      trackerRunSessionsBySpaceId: {},
      trackerRunCountBySpaceId: {},
      isLoading: false,
    }
    updateMock.mockReset()
    set.mockClear()
  })

  it('removes the session from the sidebar before PUT resolves', async () => {
    let resolveUpdate: (value: ChatSession) => void = () => {}
    updateMock.mockImplementation(() => new Promise<ChatSession>((resolve) => {
      resolveUpdate = resolve
    }))

    const pending = makeActions().deleteSession(SPACE, 's1')
    expect(state.sessions.map(session => session.id)).toEqual(['s2'])
    expect(state.sessionsBySpaceId[SPACE].map(session => session.id)).toEqual(['s2'])
    expect(state.currentSessionId).toBe('s2')

    await Promise.resolve()
    resolveUpdate(makeSession('s1', SPACE, 'archived'))
    await pending
    expect(updateMock).toHaveBeenCalledWith('s1', { status: 'archived' })
  })

  it('rolls the session back when PUT fails', async () => {
    updateMock.mockRejectedValue(new Error('network'))

    await expect(makeActions().deleteSession(SPACE, 's1')).rejects.toThrow('network')

    expect(state.sessions.map(session => session.id)).toEqual(['s1', 's2'])
    expect(state.currentSessionId).toBe('s1')
  })

  it('beginOptimisticArchive is idempotent with the later deleteSession persist', async () => {
    updateMock.mockResolvedValue(makeSession('s1', SPACE, 'archived'))
    const actions = makeActions()

    expect(actions.beginOptimisticArchive(SPACE, 's1')).toBe(true)
    expect(state.sessions.map(session => session.id)).toEqual(['s2'])
    expect(state.currentSessionId).toBe('s1')

    await actions.deleteSession(SPACE, 's1')
    expect(state.sessions.map(session => session.id)).toEqual(['s2'])
    expect(state.currentSessionId).toBe('s2')
    expect(updateMock).toHaveBeenCalledTimes(1)
  })

  it('does not steal focus if the user switched sessions before a failed persist', async () => {
    let rejectUpdate: (error: Error) => void = () => {}
    updateMock.mockImplementation(() => new Promise<ChatSession>((_resolve, reject) => {
      rejectUpdate = reject
    }))

    const pending = makeActions().deleteSession(SPACE, 's1')
    expect(state.currentSessionId).toBe('s2')
    state.currentSessionId = 's2'
    state.currentSessionIdBySpaceId = { ...state.currentSessionIdBySpaceId, [SPACE]: 's2' }
    const third = makeSession('s3', SPACE)
    state.sessions = [state.sessions[0], third]
    state.sessionsBySpaceId = { [SPACE]: [state.sessions[0], third] }
    state.currentSessionId = 's3'
    state.currentSessionIdBySpaceId = { [SPACE]: 's3' }

    await Promise.resolve()
    rejectUpdate(new Error('network'))
    await expect(pending).rejects.toThrow('network')

    expect(state.currentSessionId).toBe('s3')
    expect(state.sessions.map(session => session.id)).toContain('s1')
  })

  it('restores only the removed tracker row instead of the whole tracker map', async () => {
    const keep = makeSession('keep', 'space-other')
    state.trackerRunSessionsBySpaceId = {
      [SPACE]: [makeSession('s1', SPACE), makeSession('s-tracker', SPACE)],
      'space-other': [keep],
    }
    state.trackerRunCountBySpaceId = { [SPACE]: 2, 'space-other': 1 }
    updateMock.mockRejectedValue(new Error('network'))

    const pending = makeActions().deleteSession(SPACE, 's1')
    const extra = makeSession('extra', 'space-other')
    state.trackerRunSessionsBySpaceId = {
      ...state.trackerRunSessionsBySpaceId,
      'space-other': [keep, extra],
    }
    state.trackerRunCountBySpaceId = { ...state.trackerRunCountBySpaceId, 'space-other': 2 }

    await expect(pending).rejects.toThrow('network')
    expect(state.trackerRunSessionsBySpaceId['space-other'].map(session => session.id)).toEqual(['keep', 'extra'])
    expect(state.trackerRunSessionsBySpaceId[SPACE].map(session => session.id)).toEqual(['s1', 's-tracker'])
    expect(state.trackerRunCountBySpaceId['space-other']).toBe(2)
  })

  it('rolls the session back when stopping a busy host run fails', async () => {
    Object.defineProperty(window, 'tabtin', {
      configurable: true,
      value: {
        agentEngine: {
          getState: vi.fn(async () => ({ busy: true })),
          abortRun: vi.fn(async () => ({
            localHit: false,
            remoteAccepted: false,
            remoteRequested: true,
            remotePublished: false,
          })),
        },
      },
    })

    await expect(makeActions().deleteSession(SPACE, 's1')).rejects.toThrow('停止失败')
    expect(state.sessions.map(session => session.id)).toEqual(['s1', 's2'])
    expect(updateMock).not.toHaveBeenCalled()
  })
})

describe('isSessionShareArchiveConflict', () => {
  it('recognizes share-archive 409 by conflict status plus stop-share hint', () => {
    expect(isSessionShareArchiveConflict({
      statusCode: 409,
      message: '请先停止共享任务再归档',
    })).toBe(true)
    expect(isSessionShareArchiveConflict({
      code: 'CONFLICT',
      response: { message: '请先停止共享任务再归档' },
    })).toBe(true)
    expect(isSessionShareArchiveConflict({ statusCode: 409 })).toBe(false)
    expect(isSessionShareArchiveConflict({
      statusCode: 409,
      message: '已确定执行设备的会话不能切换为 observer',
    })).toBe(false)
    expect(isSessionShareArchiveConflict({ statusCode: 500 })).toBe(false)
  })
})
