/**
 * createSession 回归：草稿态发首条消息时不应把全局 isLoading 置 true。
 *
 * 现象：空对话发第一条 → createSession 短暂 isLoading=true → MessageList
 * 在 messages.length===0 时渲染 MessageListSkeleton（灰色气泡阴影占位）→
 * 会话创建完成后立刻消失，形成闪一下的蒙层。
 *
 * createSession 产出的永远是空会话，没有历史消息可加载；isLoading 只应服务
 * selectSession / loadSessions 等「拉已有内容」路径。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ChatMessage, ChatSession } from '@tabtin/chat-client'
import {
  applyProvisionedSessionPointer,
  createSessionLifecycleAction,
  invalidateSessionProvisionGeneration,
  _resetSessionProvisionLatchesForTests,
  type SessionLifecycleStore,
} from '../sessionLifecycleAction'
import { resolveConversationDraftScopeKey } from '../../draftMessageLegacyAdapter'
import {
  __resetDraftMessageSessionCoordinatorForTests,
  beginDraftMessageSession,
  cancelDraftMessageSessionByScopeKey,
} from '../../draftMessageSessionCoordinator'
import { findBoundLocalPendingForDraftMessage } from '../../draftSession'

vi.mock('../../../execution/chatTelemetry', () => ({
  trackChatTelemetry: vi.fn(),
}))

vi.mock('@/services/rehomeConversationScopeLayout', () => ({
  rehomeConversationScopeLayout: vi.fn(),
  rehomeConversationScopeLayoutAfterProvision: vi.fn(),
}))

const mockSelectAgent = vi.fn()
const spaceStoreState = {
  selectedAgent: {
    id: 'agent-1',
    organization_id: 'org-1',
    is_active: true,
  } as {
    id: string
    organization_id: string
    is_active: boolean
  } | null,
  selectedSpace: null as {
    id: string
    type?: string
    organization_id: string
    project_id?: string | null
  } | null,
  spaces: [] as Array<{
    id: string
    type?: string
    organization_id: string
    project_id?: string | null
  }>,
  selectAgent: mockSelectAgent,
}
const mockListAgents = vi.fn()

vi.mock('@stores/useSpaceStore', () => ({
  useSpaceStore: {
    getState: () => spaceStoreState,
  },
}))

vi.mock('@tabtin/app-shell', () => ({
  AgentApiService: {
    listAgents: (...args: unknown[]) => mockListAgents(...args),
  },
  // workspaceContextState → cloudDocsDomain → context tabs 侧载需要
  registerResetAction: vi.fn(),
}))

function makeSession(id: string, spaceId: string): ChatSession {
  return { id, space_id: spaceId, title: '新对话' } as unknown as ChatSession
}

function makeUserMessage(id: string, sessionId: string): ChatMessage {
  return {
    id,
    session_id: sessionId,
    role: 'user',
    content: 'hello from draft send',
  } as unknown as ChatMessage
}

describe('createSessionLifecycleAction', () => {
  const SPACE = 'space-draft-1'
  let state: SessionLifecycleStore
  const createMock = vi.fn()
  const quickStartMock = vi.fn()

  const get = () => state
  const set = vi.fn((partial: unknown) => {
    const patch = typeof partial === 'function'
      ? (partial as (s: SessionLifecycleStore) => Partial<SessionLifecycleStore>)(state)
      : (partial as Partial<SessionLifecycleStore>)
    state = { ...state, ...patch }
  })

  const makeActions = (withQuickStart = false) =>
    createSessionLifecycleAction(get, set as never, {
      getChatClient: () => ({
        sessions: withQuickStart
          ? { create: createMock, quickStart: quickStartMock }
          : { create: createMock },
      }) as never,
      resolveActiveSpaceId: () => SPACE,
      emptySessions: [],
    })

  beforeEach(() => {
    _resetSessionProvisionLatchesForTests()
    __resetDraftMessageSessionCoordinatorForTests()
    state = {
      currentSessionId: null,
      draftSessionBySpaceId: { [SPACE]: true },
      messagesBySessionId: {},
      sessions: [],
      sessionsBySpaceId: { [SPACE]: [] },
      currentSessionIdBySpaceId: { [SPACE]: null },
      checkpointsBySessionId: {},
      lastContextSyncFingerprintBySessionId: {},
    }
    createMock.mockReset()
    quickStartMock.mockReset()
    set.mockClear()
    spaceStoreState.selectedAgent = {
      id: 'agent-1',
      organization_id: 'org-1',
      is_active: true,
    }
    spaceStoreState.selectedSpace = {
      id: SPACE,
      type: 'workspace',
      organization_id: 'org-1',
    }
    spaceStoreState.spaces = [spaceStoreState.selectedSpace]
    mockListAgents.mockReset().mockResolvedValue([])
    mockSelectAgent.mockReset().mockImplementation((agent) => {
      spaceStoreState.selectedAgent = agent
    })
  })

  describe('createSession（草稿首发不闪 skeleton）', () => {

  it('创建进行中不把 isLoading 置 true（避免空列表 MessageListSkeleton 闪现）', async () => {
    let resolveCreate: (value: ChatSession) => void = () => {}
    createMock.mockReturnValue(
      new Promise<ChatSession>((resolve) => {
        resolveCreate = resolve
      }),
    )

    const actions = makeActions()
    const pending = actions.createSession(SPACE, 'org-1')

    // 等 createSession 进入 await client.sessions.create 之后
    await vi.waitFor(() => expect(createMock).toHaveBeenCalledTimes(1))
    expect(createMock).toHaveBeenCalledWith(
      SPACE,
      'org-1',
      undefined,
      { agentId: 'agent-1', workspaceId: SPACE },
    )

    const loadingTrueCalls = set.mock.calls.filter(([arg]) => {
      if (typeof arg !== 'object' || arg === null) return false
      return (arg as { isLoading?: boolean }).isLoading === true
    })
    expect(loadingTrueCalls).toHaveLength(0)

    resolveCreate(makeSession('s-new', SPACE))
    await pending

    const loadingTouches = set.mock.calls.filter(([arg]) => {
      if (typeof arg === 'function') {
        const patch = arg(state)
        return patch != null && typeof patch === 'object' && 'isLoading' in patch
      }
      return typeof arg === 'object' && arg !== null && 'isLoading' in arg
    })
    expect(loadingTouches).toHaveLength(0)
    expect(state.currentSessionId).toBe('s-new')
    expect(state.messagesBySessionId['s-new']).toEqual([])
  })

  it('团队 Space 建会话使用当前成员的 Project Workspace', async () => {
    spaceStoreState.spaces = [{
      id: SPACE,
      type: 'team_space',
      organization_id: 'org-1',
    }, {
      id: 'workspace-member',
      type: 'workspace',
      organization_id: 'org-1',
      project_id: SPACE,
    }]
    spaceStoreState.selectedSpace = spaceStoreState.spaces[0]
    createMock.mockResolvedValue(makeSession('s-team', SPACE))

    await makeActions().createSession(SPACE, 'org-1')

    expect(createMock).toHaveBeenCalledWith(
      SPACE,
      'org-1',
      undefined,
      { agentId: 'agent-1', workspaceId: 'workspace-member', projectId: SPACE },
    )
  })

  it('纯 Workspace 冷启动时加载组织默认 Agent 后创建会话', async () => {
    spaceStoreState.selectedAgent = null
    spaceStoreState.selectedSpace = {
      id: SPACE,
      type: 'workspace',
      organization_id: 'org-1',
    }
    spaceStoreState.spaces = [spaceStoreState.selectedSpace]
    mockListAgents.mockResolvedValue([{
      id: 'agent-default',
      name: 'Default Agent',
      organization_id: 'org-1',
      is_active: true,
    }])
    createMock.mockResolvedValue(makeSession('s-cold', SPACE))

    await makeActions().createSession(SPACE, 'org-1')

    expect(mockListAgents).toHaveBeenCalledWith('org-1')
    expect(createMock).toHaveBeenCalledWith(
      SPACE,
      'org-1',
      undefined,
      { agentId: 'agent-default', workspaceId: SPACE },
    )
  })

  it('切换 Organization 后不会复用旧组织的 selectedAgent', async () => {
    spaceStoreState.selectedAgent = {
      id: 'agent-old-org',
      organization_id: 'org-old',
      is_active: true,
    }
    mockListAgents.mockResolvedValue([{
      id: 'agent-org-1',
      organization_id: 'org-1',
      is_active: true,
    }])
    createMock.mockResolvedValue(makeSession('s-org', SPACE))

    await makeActions().createSession(SPACE, 'org-1')

    expect(createMock).toHaveBeenCalledWith(
      SPACE,
      'org-1',
      undefined,
      { agentId: 'agent-org-1', workspaceId: SPACE },
    )
  })

  it('selectedAgent 已停用时改用组织内可用 Agent', async () => {
    spaceStoreState.selectedAgent = {
      id: 'agent-inactive',
      organization_id: 'org-1',
      is_active: false,
    }
    mockListAgents.mockResolvedValue([{
      id: 'agent-active',
      organization_id: 'org-1',
      is_active: true,
    }])
    createMock.mockResolvedValue(makeSession('s-active', SPACE))

    await makeActions().createSession(SPACE, 'org-1')

    expect(createMock).toHaveBeenCalledWith(
      SPACE,
      'org-1',
      undefined,
      { agentId: 'agent-active', workspaceId: SPACE },
    )
  })
  })

  describe('ensureSessionForSpace 竞态 ', () => {
    it('并发首发（双击等）：合并同一 in-flight，只建一次会话且消息仍可见', async () => {
      let resolveQuickStart: (value: {
        session: ChatSession
        context_fingerprint?: string | null
      }) => void = () => {}
      quickStartMock.mockReturnValue(
        new Promise((resolve) => {
          resolveQuickStart = resolve
        }),
      )

      const actions = makeActions(true)
      const firstPending = actions.ensureSessionForSpace(SPACE, 'org-1', undefined, {
        trigger: 'pre_send',
        preferQuickStart: true,
        contextPayload: { current_space_id: SPACE },
      })
      await vi.waitFor(() => expect(quickStartMock).toHaveBeenCalledTimes(1))

      const sendPending = actions.ensureSessionForSpace(SPACE, 'org-1', undefined, {
        trigger: 'pre_send',
        preferQuickStart: true,
      })

      resolveQuickStart({
        session: makeSession('sess-A', SPACE),
        context_fingerprint: 'fp-1',
      })

      const [firstResult, sendResult] = await Promise.all([firstPending, sendPending])

      expect(createMock).not.toHaveBeenCalled()
      expect(quickStartMock).toHaveBeenCalledTimes(1)
      expect(firstResult.sessionId).toBe('sess-A')
      expect(sendResult.sessionId).toBe('sess-A')
      // ：pre_send 退出草稿态，全局 current 切到新会话
      expect(state.currentSessionId).toBe('sess-A')
      expect(state.currentSessionIdBySpaceId[SPACE]).toBe('sess-A')
      expect(state.draftSessionBySpaceId[SPACE]).toBeUndefined()

      const userMsg = makeUserMessage('msg-user-1', 'sess-A')
      state = {
        ...state,
        messagesBySessionId: {
          ...state.messagesBySessionId,
          'sess-A': [userMsg],
        },
      }
      const visible = state.messagesBySessionId[state.currentSessionId!] ?? []
      expect(visible.some(m => m.id === 'msg-user-1')).toBe(true)
    })

    it('迟到的第二次 ensure 不得清空已有消息', async () => {
      quickStartMock.mockResolvedValue({
        session: makeSession('sess-A', SPACE),
        context_fingerprint: null,
      })
      createMock.mockResolvedValue(makeSession('sess-B', SPACE))

      const actions = makeActions(true)
      await actions.ensureSessionForSpace(SPACE, 'org-1', undefined, {
        trigger: 'pre_send',
        preferQuickStart: true,
      })

      const userMsg = makeUserMessage('msg-user-1', 'sess-A')
      state = {
        ...state,
        messagesBySessionId: {
          ...state.messagesBySessionId,
          'sess-A': [userMsg],
        },
      }

      const again = await actions.ensureSessionForSpace(SPACE, 'org-1', undefined, {
        trigger: 'pre_send',
        preferQuickStart: true,
      })
      expect(again.sessionId).toBe('sess-A')
      expect(again.mode).toBe('existing')
      expect(quickStartMock).toHaveBeenCalledTimes(1)
      expect(createMock).not.toHaveBeenCalled()
      expect(state.messagesBySessionId['sess-A']?.[0]?.id).toBe('msg-user-1')
    })
  })

  describe('#7064 reset generation 迟到 provision', () => {
    it('invalidate 后迟到 quickStart 不得写 pointer', async () => {
      let resolveQuickStart!: (value: unknown) => void
      quickStartMock.mockImplementation(
        () => new Promise((resolve) => { resolveQuickStart = resolve }),
      )
      const actions = makeActions(true)
      const pending = actions.ensureSessionForSpace(SPACE, 'org-1', undefined, {
        trigger: 'pre_send',
        preferQuickStart: true,
        expectedDraftMessageId: 'ep-will-reset',
      })
      await vi.waitFor(() => expect(quickStartMock).toHaveBeenCalled())

      invalidateSessionProvisionGeneration()
      resolveQuickStart({
        session: makeSession('sess-stale-after-reset', SPACE),
        context_fingerprint: 'fp-stale',
      })
      const result = await pending
      expect(result.sessionId).toBe('sess-stale-after-reset')
      expect(state.currentSessionIdBySpaceId[SPACE]).toBeNull()
      expect(state.sessionsBySpaceId[SPACE] ?? []).toHaveLength(0)
    })

    it('E1 pending → invalidate → E2 必须新开 provision（create/quickStart×2）；E1 resolve 不写，E2 只写 E2', async () => {
      let resolveE1!: (value: unknown) => void
      let resolveE2!: (value: unknown) => void
      quickStartMock
        .mockImplementationOnce(() => new Promise((resolve) => { resolveE1 = resolve }))
        .mockImplementationOnce(() => new Promise((resolve) => { resolveE2 = resolve }))

      const scope = resolveConversationDraftScopeKey({ legacyExecutionHostId: SPACE })!
      const epE2 = beginDraftMessageSession(scope)

      const actions = makeActions(true)
      const e1 = actions.ensureSessionForSpace(SPACE, 'org-1', undefined, {
        trigger: 'pre_send',
        preferQuickStart: true,
        expectedDraftMessageId: 'ep-e1-stale-token',
      })
      await vi.waitFor(() => expect(quickStartMock).toHaveBeenCalledTimes(1))

      invalidateSessionProvisionGeneration()

      const e2 = actions.ensureSessionForSpace(SPACE, 'org-1', undefined, {
        trigger: 'pre_send',
        preferQuickStart: true,
        expectedDraftMessageId: epE2.draftMessageId,
      })
      // 真 deferred：E2 不得复用 E1 promise，必须第二次启动 quickStart
      await vi.waitFor(() => expect(quickStartMock).toHaveBeenCalledTimes(2))

      resolveE1({
        session: makeSession('sess-e1-stale', SPACE),
        context_fingerprint: 'fp-e1',
      })
      await e1
      expect(state.currentSessionIdBySpaceId[SPACE]).toBeNull()
      expect(state.sessionsBySpaceId[SPACE] ?? []).toHaveLength(0)

      resolveE2({
        session: makeSession('sess-e2', SPACE),
        context_fingerprint: 'fp-e2',
      })
      const e2Result = await e2
      expect(e2Result.sessionId).toBe('sess-e2')
      expect(state.currentSessionIdBySpaceId[SPACE]).toBe('sess-e2')
      expect(state.sessionsBySpaceId[SPACE]?.map((s) => s.id)).toEqual(['sess-e2'])
      expect(state.sessionsBySpaceId[SPACE]?.some((s) => s.id === 'sess-e1-stale')).toBe(false)
    })

    it('reset/logout 同款：E1 pending → invalidate → E2 starts×2 → E1 不写 → E2 只写', async () => {
      let resolveE1!: (value: unknown) => void
      let resolveE2!: (value: unknown) => void
      createMock
        .mockImplementationOnce(() => new Promise((resolve) => { resolveE1 = resolve }))
        .mockImplementationOnce(() => new Promise((resolve) => { resolveE2 = resolve }))

      const actions = makeActions(true)
      const e1 = actions.ensureSessionForSpace(SPACE, 'org-1', undefined, {
        trigger: 'pre_send',
        preferQuickStart: false,
      })
      await vi.waitFor(() => expect(createMock).toHaveBeenCalledTimes(1))

      // 模拟 store.reset → invalidateSessionProvisionGeneration
      invalidateSessionProvisionGeneration()

      const e2 = actions.ensureSessionForSpace(SPACE, 'org-1', undefined, {
        trigger: 'explicit',
        preferQuickStart: false,
      })
      await vi.waitFor(() => expect(createMock).toHaveBeenCalledTimes(2))

      resolveE1(makeSession('sess-logout-stale', SPACE))
      await e1
      expect(state.currentSessionIdBySpaceId[SPACE]).toBeNull()

      resolveE2(makeSession('sess-after-logout', SPACE))
      const e2Result = await e2
      expect(e2Result.sessionId).toBe('sess-after-logout')
      expect(state.currentSessionIdBySpaceId[SPACE]).toBe('sess-after-logout')
      expect(state.sessionsBySpaceId[SPACE]?.map((s) => s.id)).toEqual(['sess-after-logout'])
    })
  })

  describe('#7324 prefetch retainDraft + 单槽复用', () => {
    it('retainDraft：写 Space 指针，保留 draft，不切全局 current', () => {
      const nextState: SessionLifecycleStore = {
        ...state,
        currentSessionId: null,
        draftSessionBySpaceId: { [SPACE]: true },
        currentSessionIdBySpaceId: { [SPACE]: null },
      }
      const patch = applyProvisionedSessionPointer(
        nextState,
        SPACE,
        makeSession('sess-hidden', SPACE),
        true,
        [],
        { retainDraftMessage: true },
      )
      expect(patch.currentSessionId).toBeNull()
      expect(patch.currentSessionIdBySpaceId?.[SPACE]).toBe('sess-hidden')
      expect(patch.draftSessionBySpaceId?.[SPACE]).toBe(true)
    })

    it('ensureSession prefetch：复用桶内空会话，不调 create/quickStart', async () => {
      const empty = makeSession('empty-slot', SPACE)
      state = {
        ...state,
        currentSessionId: null,
        draftSessionBySpaceId: { [SPACE]: true },
        currentSessionIdBySpaceId: { [SPACE]: null },
        sessionsBySpaceId: { [SPACE]: [{ ...empty, message_count: 0 }] },
      }
      const actions = makeActions(true)
      const result = await actions.ensureSessionForSpace(SPACE, 'org-1', undefined, {
        trigger: 'prefetch',
        preferQuickStart: true,
        retainDraftMessage: true,
      })
      expect(result.sessionId).toBe('empty-slot')
      expect(result.mode).toBe('existing')
      expect(createMock).not.toHaveBeenCalled()
      expect(quickStartMock).not.toHaveBeenCalled()
      expect(state.currentSessionId).toBeNull()
      expect(state.currentSessionIdBySpaceId[SPACE]).toBe('empty-slot')
      expect(state.draftSessionBySpaceId[SPACE]).toBe(true)
    })
  })

  describe('#7064 applyProvisionedSessionPointer episode 绑定', () => {
    const draftScopeKey = resolveConversationDraftScopeKey({
      legacyExecutionHostId: SPACE,
    })!

    it('D. stale episode：只挂列表，不覆盖历史指针、不迁 pending', () => {
      const ep = beginDraftMessageSession(draftScopeKey)
      const pendingId = 'local-pending-stale'
      bindDraftSessionToMessage(draftScopeKey, pendingId, {
        draftMessageId: ep.draftMessageId,
        phase: 'sending',
      })
      cancelDraftMessageSessionByScopeKey(draftScopeKey)

      const historical = 'sess-historical'
      const nextState: SessionLifecycleStore = {
        ...state,
        currentSessionId: historical,
        currentSessionIdBySpaceId: { [SPACE]: historical },
        messagesBySessionId: {
          [pendingId]: [makeUserMessage('u1', pendingId)],
          [historical]: [makeUserMessage('h1', historical)],
        },
      }
      const patch = applyProvisionedSessionPointer(
        nextState,
        SPACE,
        makeSession('sess-orphan', SPACE),
        true,
        [],
        { expectedDraftMessageId: ep.draftMessageId },
      )
      expect(patch.currentSessionId).toBeUndefined()
      expect(patch.currentSessionIdBySpaceId).toBeUndefined()
      expect(patch.messagesBySessionId?.[pendingId]?.[0]?.id).toBe('u1')
      expect(patch.messagesBySessionId?.[historical]?.[0]?.id).toBe('h1')
      expect(patch.sessionsBySpaceId?.[SPACE]?.some((s) => s.id === 'sess-orphan')).toBe(true)
      expect(getDraftSessionBySessionId(pendingId)).toBeUndefined()
    })

    it('E. active episode：按 episode 找 pending 并 rehome，不读全局 current 外 scope pending', () => {
      const ep = beginDraftMessageSession(draftScopeKey)
      const pendingId = 'local-pending-owned'
      bindDraftSessionToMessage(draftScopeKey, pendingId, {
        draftMessageId: ep.draftMessageId,
        phase: 'sending',
      })
      expect(findBoundLocalPendingForDraftMessage(ep.draftMessageId)).toBe(pendingId)

      const nextState: SessionLifecycleStore = {
        ...state,
        // 全局 current 是外 draft scope 的 pending——不得被误迁
        currentSessionId: 'local-pending-foreign',
        messagesBySessionId: {
          [pendingId]: [makeUserMessage('owned', pendingId)],
          'local-pending-foreign': [makeUserMessage('foreign', 'local-pending-foreign')],
        },
      }
      const patch = applyProvisionedSessionPointer(
        nextState,
        SPACE,
        makeSession('sess-real', SPACE),
        true,
        [],
        { expectedDraftMessageId: ep.draftMessageId },
      )
      expect(patch.messagesBySessionId?.['sess-real']?.[0]?.id).toBe('owned')
      expect(patch.messagesBySessionId?.[pendingId]).toBeUndefined()
      expect(patch.messagesBySessionId?.['local-pending-foreign']?.[0]?.id).toBe('foreign')
      expect(getDraftSessionBySessionId('sess-real')?.draftMessageId).toBe(ep.draftMessageId)
      expect(patch.currentSessionIdBySpaceId?.[SPACE]).toBe('sess-real')
    })

    it('ownership 冲突：rehome 失败则无 message/pointer 迁移', () => {
      const scopeA = 'conversation:draft:project-a'
      const scopeB = 'conversation:draft:workspace-b'
      const epA = beginDraftMessageSession(scopeA)
      const epB = beginDraftMessageSession(scopeB)
      const pendingId = 'local-pending-conflict'
      bindDraftSessionToMessage(scopeA, pendingId, {
        draftMessageId: epA.draftMessageId,
        phase: 'sending',
      })
      // 真 session 已被 B 占用 → rehome 失败
      bindDraftSessionToMessage(scopeB, 'sess-taken', {
        draftMessageId: epB.draftMessageId,
      })

      const nextState: SessionLifecycleStore = {
        ...state,
        currentSessionId: pendingId,
        currentSessionIdBySpaceId: { [SPACE]: null },
        draftSessionBySpaceId: { [SPACE]: true },
        messagesBySessionId: {
          [pendingId]: [makeUserMessage('owned', pendingId)],
        },
      }
      const patch = applyProvisionedSessionPointer(
        nextState,
        SPACE,
        makeSession('sess-taken', SPACE),
        true,
        [],
        { expectedDraftMessageId: epA.draftMessageId },
      )
      // 列表可挂；不得迁消息 / 不得写指针
      expect(patch.sessionsBySpaceId?.[SPACE]?.some((s) => s.id === 'sess-taken')).toBe(true)
      expect(patch.messagesBySessionId?.[pendingId]?.[0]?.id).toBe('owned')
      expect(patch.messagesBySessionId?.['sess-taken']).toEqual([])
      expect(patch.currentSessionIdBySpaceId).toBeUndefined()
      expect(patch.currentSessionId).toBeUndefined()
      expect(getDraftSessionBySessionId(pendingId)?.draftMessageId).toBe(epA.draftMessageId)
      expect(getDraftSessionBySessionId('sess-taken')?.draftMessageId).toBe(epB.draftMessageId)
    })
  })
})
