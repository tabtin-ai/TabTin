/**
 * loadSessions SWR 语义回归测试（ 前端根因）。
 *
 * 旧行为：sessionsBySpaceId[spaceId] 一旦存在（哪怕空数组）就永久短路，
 * team_space 里其他成员后建的会话本端永远拉不到。
 * 新行为：缓存命中先渲染 + 后台 revalidate 覆盖；无缓存等待服务器；
 * in-flight 去重防止轮询/重复挂载打爆请求。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ChatSession } from '@tabtin/chat-client'
import { createSessionCrudActions, type SessionCrudStore } from '../sessionCrudSlice'
import { __resetSpaceSessionListWriteGateForTest } from '../../spaceSessionListWriteGate'
import { registerDraftSession, releaseDraftSession, resetDraftSessions } from '../../draftSession'

const markViewedAtIfAbsentMock = vi.hoisted(() => vi.fn())
const provisionalHostMocks = vi.hoisted(() => ({
  beginDiscard: vi.fn(),
  completeDiscard: vi.fn(),
}))
const agentEngineMock = vi.hoisted(() => ({
  getState: vi.fn(),
  abortRun: vi.fn(),
}))

vi.mock('@/utils/logger', () => ({
  logger: { log: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  createLogger: () => ({ log: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}))

vi.mock('../../../execution/chatTelemetry', () => ({
  trackChatTelemetry: vi.fn(),
}))
vi.mock('../../provisionalSessionHost', () => ({
  beginProvisionalSessionDiscard: (...args: unknown[]) => provisionalHostMocks.beginDiscard(...args),
  completeProvisionalSessionDiscard: (...args: unknown[]) => provisionalHostMocks.completeDiscard(...args),
}))

// 以下依赖只被 loadSessions 之外的 action 用到；直接 import 会经
// messageSyncAction / historyRestoreHelper 等把 useChatStore 拉进来，
// 形成"测试从 slice 进入"的循环加载（生产从 useChatStore 进入无此问题）。
vi.mock('@/stores/chat/domain/messageSyncAction', () => ({
  mergeMessagesFromServer: (_current: unknown, incoming: unknown) => ({ messages: incoming }),
}))
vi.mock('../../../stream/handlers/historyRestoreHelper', () => ({ restoreRuntimeStateFromHistory: vi.fn() }))
vi.mock('../../utils/evictSessionData', () => ({
  evictChatStoreSessionData: vi.fn(() => ({})),
  evictChatStoreSessionDataBatch: vi.fn(() => ({})),
}))
vi.mock('../../../messages/messageCache', () => ({
  getCachedMessages: vi.fn(),
  cacheMessages: vi.fn(),
  appendCachedMessages: vi.fn(),
  touchSessionMeta: vi.fn(),
}))
vi.mock('../../../messages/actions/titleGenerationDedupe', () => ({ requestTitleGenerationOnce: vi.fn() }))
vi.mock('../../../../useChatSplitStore', () => ({
  useChatSplitStore: {
    setState: vi.fn(),
    getState: () => ({
      cleanupDeletedSession: vi.fn(),
    }),
  },
}))
vi.mock('../../../../useSpaceContextTabsStore', () => ({
  useSpaceContextTabsStore: {
    getState: () => ({
      clearOrphanSubagentTabs: vi.fn(),
      clearSpaceTabs: vi.fn(),
    }),
  },
}))
vi.mock('../../../../useChatRuntimeStore', () => ({
  useChatRuntimeStore: {
    getState: () => ({
      evictSession: vi.fn(),
    }),
  },
}))
vi.mock('../../../../useSessionReadStore', () => ({
  useSessionReadStore: {
    getState: () => ({
      clearSession: vi.fn(),
      markViewedAtIfAbsent: markViewedAtIfAbsentMock,
    }),
  },
}))
vi.mock('@/services/sessionFreshness', () => ({ markSessionFresh: vi.fn(), markSessionStale: vi.fn() }))
vi.mock('@tabtin/smartsheet-ui/toast', () => ({ toast: vi.fn() }))
vi.mock('@/i18n', () => ({ default: { t: (k: string) => k } }))

function makeSession(id: string, spaceId: string): ChatSession {
  return { id, space_id: spaceId, title: `session-${id}` } as unknown as ChatSession
}

function makeSessionWithActivity(id: string, spaceId: string, lastMessageAt: string): ChatSession {
  return {
    id,
    space_id: spaceId,
    title: `session-${id}`,
    last_message_at: lastMessageAt,
    updated_at: '2026-01-01T00:00:00.000Z',
    created_at: '2026-01-01T00:00:00.000Z',
  } as unknown as ChatSession
}

describe('loadSessions（SWR 语义）', () => {
  const SPACE = 'space-team-1'
  let state: {
    sessions: ChatSession[]
    sessionsBySpaceId: Record<string, ChatSession[]>
    trackerRunSessionsBySpaceId: Record<string, ChatSession[]>
    currentSessionIdBySpaceId: Record<string, string | null>
    currentSessionId: string | null
    trackerRunCountBySpaceId: Record<string, number | null>
    excludedAgentMentionSessionIdsBySpaceId: Record<string, string[]>
    messagesBySessionId: Record<string, unknown[]>
    checkpointsBySessionId: Record<string, unknown>
    isLoading: boolean
  }
  const setSpaceSessions = vi.fn((spaceId: string, sessions: ChatSession[]) => {
    state.sessionsBySpaceId = { ...state.sessionsBySpaceId, [spaceId]: sessions }
  })
  const upsertSessionInSpace = vi.fn((spaceId: string, session: ChatSession) => {
    const current = state.sessionsBySpaceId[spaceId] ?? []
    state.sessionsBySpaceId = {
      ...state.sessionsBySpaceId,
      [spaceId]: [session, ...current.filter(item => item.id !== session.id)],
    }
  })
  const listMock = vi.fn()
  const updateMock = vi.fn()
  const deleteMock = vi.fn()

  const get = () => ({
    ...state,
    setSpaceSessions,
    upsertSessionInSpace,
  }) as unknown as SessionCrudStore

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
      getChatClient: () => ({
        sessions: { list: listMock, update: updateMock, delete: deleteMock },
      }) as never,
      resolveActiveSpaceId: () => SPACE,
      emptySessions: [],
    },
  )

  beforeEach(() => {
    __resetSpaceSessionListWriteGateForTest()
    resetDraftSessions()
    state = {
      sessions: [],
      sessionsBySpaceId: {},
      trackerRunSessionsBySpaceId: {},
      currentSessionIdBySpaceId: {},
      currentSessionId: null,
      trackerRunCountBySpaceId: {},
      excludedAgentMentionSessionIdsBySpaceId: {},
      messagesBySessionId: {},
      checkpointsBySessionId: {},
      isLoading: false,
    }
    setSpaceSessions.mockClear()
    upsertSessionInSpace.mockClear()
    listMock.mockReset()
    updateMock.mockReset()
    deleteMock.mockReset()
    agentEngineMock.getState.mockReset()
    agentEngineMock.abortRun.mockReset()
    agentEngineMock.getState.mockResolvedValue({ sessionId: null, busy: false })
    Object.defineProperty(window, 'tabtin', {
      configurable: true,
      value: { agentEngine: agentEngineMock },
    })
    set.mockClear()
    markViewedAtIfAbsentMock.mockClear()
    provisionalHostMocks.beginDiscard.mockReset().mockResolvedValue(true)
    provisionalHostMocks.completeDiscard.mockReset().mockResolvedValue(undefined)
  })

  it('放弃未发送的预建会话时永久删除，不进入归档', async () => {
    const emptySession = makeSession('prefetch-empty', SPACE)
    state.sessions = [emptySession]
    state.sessionsBySpaceId[SPACE] = [emptySession]
    registerDraftSession({
      sessionId: emptySession.id,
      draftMessageId: 'draft-message-1',
      draftScopeKey: 'scope-1',
    })
    releaseDraftSession(emptySession.id)
    deleteMock.mockResolvedValue(undefined)

    makeActions().discardAbandonedEmptySessions({
      sessionIds: [emptySession.id],
      reason: 'draft_cancel',
    })

    expect(state.sessionsBySpaceId[SPACE]).toEqual([emptySession])
    await vi.waitFor(() => expect(deleteMock).toHaveBeenCalledWith(emptySession.id))
    await vi.waitFor(() => expect(state.sessionsBySpaceId[SPACE]).toEqual([]))
    expect(updateMock).not.toHaveBeenCalled()
  })

  it('永久删除失败时保留本地会话并释放 Host 仲裁', async () => {
    const emptySession = makeSession('prefetch-empty', SPACE)
    state.sessions = [emptySession]
    state.sessionsBySpaceId[SPACE] = [emptySession]
    registerDraftSession({
      sessionId: emptySession.id,
      draftMessageId: 'draft-message-1',
      draftScopeKey: 'scope-1',
    })
    releaseDraftSession(emptySession.id)
    deleteMock.mockRejectedValue(new Error('offline'))

    makeActions().discardAbandonedEmptySessions({
      sessionIds: [emptySession.id],
      reason: 'draft_cancel',
    })

    await vi.waitFor(() => expect(deleteMock).toHaveBeenCalledWith(emptySession.id))
    expect(state.sessionsBySpaceId[SPACE]).toEqual([emptySession])
    expect(provisionalHostMocks.completeDiscard).toHaveBeenCalledWith(emptySession.id, false)
  })

  it('无缓存：等待服务器响应后写入列表', async () => {
    const serverSessions = [makeSession('s1', SPACE)]
    listMock.mockResolvedValue({ sessions: serverSessions, tracker_run_count: 0 })

    await makeActions().loadSessions(SPACE, 'wt-1')

    expect(listMock).toHaveBeenCalledWith(expect.objectContaining({
      exclude_agent_mention_sessions: false,
    }))
    expect(state.sessionsBySpaceId[SPACE]).toEqual(serverSessions)
  })

  it('加载历史会话时初始化已读基线，避免远程历史默认显示未读蓝点', async () => {
    const lastMessageAt = '2026-01-02T03:04:05.000Z'
    const serverSessions = [makeSessionWithActivity('remote-history', SPACE, lastMessageAt)]
    listMock.mockResolvedValue({ sessions: serverSessions, tracker_run_count: 0 })

    await makeActions().loadSessions(SPACE, 'wt-1')

    expect(markViewedAtIfAbsentMock).toHaveBeenCalledWith('remote-history', lastMessageAt)
  })

  it('缓存命中（含空列表）：先渲染缓存，后台 revalidate 拉到新会话并覆盖', async () => {
    // 复现  现场：Owner 首拉时列表为空 → 空数组进缓存 → 成员 B 新建会话
    state.sessionsBySpaceId[SPACE] = []
    const memberSession = makeSession('s-member', SPACE)
    let resolveList: (value: unknown) => void = () => {}
    listMock.mockReturnValue(new Promise((resolve) => { resolveList = resolve }))

    const actions = makeActions()
    await actions.loadSessions(SPACE, 'wt-1')

    // 缓存立即渲染（旧行为到此为止；新行为还应已发出后台请求）
    expect(setSpaceSessions).toHaveBeenCalledWith(SPACE, [], true)
    expect(listMock).toHaveBeenCalledTimes(1)

    resolveList({ sessions: [memberSession], tracker_run_count: 0 })
    await vi.waitFor(() => {
      expect(state.sessionsBySpaceId[SPACE]).toEqual([memberSession])
    })
  })

  it('revalidate 静默进行：不把 isLoading 置 true', async () => {
    state.sessionsBySpaceId[SPACE] = [makeSession('s1', SPACE)]
    listMock.mockResolvedValue({ sessions: [makeSession('s1', SPACE)], tracker_run_count: 0 })

    await makeActions().loadSessions(SPACE, 'wt-1')
    await vi.waitFor(() => expect(listMock).toHaveBeenCalledTimes(1))

    const loadingTrueCalls = set.mock.calls.filter(([arg]) =>
      typeof arg === 'object' && arg !== null && (arg as { isLoading?: boolean }).isLoading === true)
    expect(loadingTrueCalls).toHaveLength(0)
  })

  it('in-flight 去重：请求未返回前重复调用不再发请求', async () => {
    state.sessionsBySpaceId[SPACE] = []
    let resolveList: (value: unknown) => void = () => {}
    listMock.mockReturnValue(new Promise((resolve) => { resolveList = resolve }))

    const actions = makeActions()
    await actions.loadSessions(SPACE, 'wt-1')
    await actions.loadSessions(SPACE, 'wt-1')
    await actions.loadSessions(SPACE, 'wt-1')

    expect(listMock).toHaveBeenCalledTimes(1)

    resolveList({ sessions: [], tracker_run_count: 0 })
    await vi.waitFor(() => expect(state.sessionsBySpaceId[SPACE]).toEqual([]))

    // 上一轮结束后可再次 revalidate
    listMock.mockResolvedValue({ sessions: [], tracker_run_count: 0 })
    await actions.loadSessions(SPACE, 'wt-1')
    expect(listMock).toHaveBeenCalledTimes(2)
  })

  it('revalidate 失败：保留旧缓存不清空', async () => {
    const cachedSessions = [makeSession('s1', SPACE)]
    state.sessionsBySpaceId[SPACE] = cachedSessions
    listMock.mockRejectedValue(new Error('network down'))

    await makeActions().loadSessions(SPACE, 'wt-1')
    await vi.waitFor(() => expect(listMock).toHaveBeenCalledTimes(1))

    expect(state.sessionsBySpaceId[SPACE]).toEqual(cachedSessions)
  })

  it('归档墓碑：飞行中的旧 list 不得把已归档 session 写回', async () => {
    const s1 = makeSession('s1', SPACE)
    const s2 = makeSession('s2', SPACE)
    state.sessionsBySpaceId[SPACE] = [s1, s2]
    state.currentSessionIdBySpaceId = { [SPACE]: 's2' }
    state.currentSessionId = 's2'
    let resolveList: (value: unknown) => void = () => {}
    listMock.mockReturnValue(new Promise((resolve) => { resolveList = resolve }))
    updateMock.mockResolvedValue({ id: 's1', status: 'archived' })

    const actions = makeActions()
    // 先发出后台 revalidate（挂起）
    await actions.loadSessions(SPACE, 'wt-1')
    expect(listMock).toHaveBeenCalledTimes(1)

    // 归档 s1：本地列表应变为 [s2]
    await actions.deleteSession(SPACE, 's1')
    expect(state.sessionsBySpaceId[SPACE].map(s => s.id)).toEqual(['s2'])

    // 旧 list 仍含 s1 —— 墓碑 / stale-epoch 必须挡住回写
    resolveList({ sessions: [s1, s2], tracker_run_count: 0 })
    await vi.waitFor(() => {
      expect(state.sessionsBySpaceId[SPACE].map(s => s.id)).toEqual(['s2'])
    })
  })

  it('归档运行中任务前先由 agent-host 停止，再写 archived', async () => {
    const s1 = makeSession('s1', SPACE)
    state.sessionsBySpaceId[SPACE] = [s1]
    updateMock.mockResolvedValue({ id: 's1', status: 'archived' })
    agentEngineMock.getState.mockResolvedValue({ sessionId: 's1', busy: true })
    agentEngineMock.abortRun.mockResolvedValue({
      localHit: true,
      remoteRequested: true,
      remoteAccepted: true,
      remotePublished: 1,
    })

    await makeActions().deleteSession(SPACE, 's1')

    expect(agentEngineMock.getState).toHaveBeenCalledWith({ sessionId: 's1' })
    expect(agentEngineMock.abortRun).toHaveBeenCalledWith('s1')
    expect(updateMock).toHaveBeenCalledWith('s1', { status: 'archived' })
    expect(agentEngineMock.abortRun.mock.invocationCallOrder[0])
      .toBeLessThan(updateMock.mock.invocationCallOrder[0])
  })

  it('agent-host 停止运行中任务失败时不写 archived', async () => {
    const s1 = makeSession('s1', SPACE)
    state.sessionsBySpaceId[SPACE] = [s1]
    agentEngineMock.getState.mockResolvedValue({ sessionId: 's1', busy: true })
    agentEngineMock.abortRun.mockResolvedValue({
      localHit: false,
      remoteRequested: true,
      remoteAccepted: false,
      remotePublished: 0,
    })

    await expect(makeActions().deleteSession(SPACE, 's1'))
      .rejects.toThrow('任务仍在运行，停止失败后不能归档')

    expect(updateMock).not.toHaveBeenCalled()
    expect(state.sessionsBySpaceId[SPACE].map(s => s.id)).toEqual(['s1'])
  })

  it('永久删除 Tracker Run 时同步移出执行记录缓存桶', async () => {
    const run1 = makeSession('run-1', SPACE)
    const run2 = makeSession('run-2', SPACE)
    state.trackerRunSessionsBySpaceId[SPACE] = [run1, run2]
    state.trackerRunCountBySpaceId[SPACE] = 2
    deleteMock.mockResolvedValue(undefined)

    await makeActions().deleteSessionPermanently(SPACE, 'run-1')

    expect(deleteMock).toHaveBeenCalledWith('run-1')
    expect(state.trackerRunSessionsBySpaceId[SPACE].map(session => session.id))
      .toEqual(['run-2'])
    expect(state.trackerRunCountBySpaceId[SPACE]).toBe(1)
  })

  it('本地 upsert 后陈旧 list 不得抹掉新会话', async () => {
    const existing = makeSession('s-old', SPACE)
    state.sessionsBySpaceId[SPACE] = [existing]

    let resolveList: (value: unknown) => void = () => {}
    listMock.mockReturnValue(new Promise((resolve) => { resolveList = resolve }))

    const actions = makeActions()
    await actions.loadSessions(SPACE, 'wt-1')
    expect(listMock).toHaveBeenCalledTimes(1)

    const created = makeSession('s-new', SPACE)
    actions.upsertSessionInSpace(SPACE, created)
    expect(state.sessionsBySpaceId[SPACE].map(s => s.id)).toEqual(['s-new', 's-old'])

    // 飞行中的旧 list 不含 s-new —— epoch 门控应整份丢弃
    resolveList({ sessions: [existing], tracker_run_count: 0 })
    await vi.waitFor(() => expect(listMock).toHaveBeenCalledTimes(1))
    await Promise.resolve()

    expect(state.sessionsBySpaceId[SPACE].map(s => s.id)).toEqual(['s-new', 's-old'])
  })

  it('侧栏明确排除未观察的 mention 会话，同时保留普通本地新建', async () => {
    const existing = makeSession('s-old', SPACE)
    const mention = makeSession('s-mention', SPACE)
    const localCreated = makeSession('s-new', SPACE)
    state.sessionsBySpaceId[SPACE] = [mention, localCreated, existing]
    listMock.mockResolvedValue({
      sessions: [existing],
      excluded_agent_mention_session_ids: [mention.id],
      tracker_run_count: 0,
    })

    await makeActions().loadSessions(SPACE, 'wt-1', {
      excludeAgentMentionSessions: true,
    })
    await vi.waitFor(() => expect(listMock).toHaveBeenCalledTimes(1))

    expect(listMock).toHaveBeenCalledWith(expect.objectContaining({
      exclude_agent_mention_sessions: true,
    }))
    expect(state.sessionsBySpaceId[SPACE].map(session => session.id).sort()).toEqual([
      's-new',
      's-old',
    ])
  })

  it('侧栏明确排除的 mention 不会被 overlay 重新钉回', async () => {
    const mention = makeSession('s-mention', SPACE)
    state.sessionsBySpaceId[SPACE] = [mention]
    const actions = makeActions()
    actions.pinSessionInSpace(SPACE, mention)
    listMock.mockResolvedValue({
      sessions: [],
      excluded_agent_mention_session_ids: [mention.id],
      tracker_run_count: 0,
    })

    await actions.loadSessions(SPACE, 'wt-1', {
      excludeAgentMentionSessions: true,
    })
    await vi.waitFor(() => expect(listMock).toHaveBeenCalledTimes(1))

    expect(state.sessionsBySpaceId[SPACE]).toEqual([])
  })

  it('#11321 默认 list 保留 mention 会话但带上 is_agent_mention_session', async () => {
    const mention = makeSession('s-mention', SPACE)
    listMock.mockResolvedValue({
      sessions: [{ ...mention, is_agent_mention_session: true }],
      excluded_agent_mention_session_ids: [],
      tracker_run_count: 0,
    })

    await makeActions().loadSessions(SPACE, 'wt-1')
    await vi.waitFor(() => expect(listMock).toHaveBeenCalledTimes(1))

    expect(listMock).toHaveBeenCalledWith(expect.objectContaining({
      exclude_agent_mention_sessions: false,
    }))
    expect(state.sessionsBySpaceId[SPACE]).toEqual([
      expect.objectContaining({
        id: mention.id,
        is_agent_mention_session: true,
      }),
    ])
  })

  it('本地 upsert 早于 revalidate：list 滞后时仍按 id 保留本地新建', async () => {
    const existing = makeSession('s-old', SPACE)
    const created = makeSession('s-new', SPACE)
    // 桶内已有本地新建，且尚未被任何成功 list 观察
    state.sessionsBySpaceId[SPACE] = [created, existing]
    listMock.mockResolvedValue({ sessions: [existing], tracker_run_count: 0 })

    await makeActions().loadSessions(SPACE, 'wt-1')
    await vi.waitFor(() => expect(listMock).toHaveBeenCalledTimes(1))

    expect(state.sessionsBySpaceId[SPACE].map(s => s.id).sort()).toEqual(['s-new', 's-old'])
  })
})
