import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'

const mocks = vi.hoisted(() => ({
  listAgents: vi.fn(),
  selectAgent: vi.fn(),
  updateSessionInCaches: vi.fn(),
  updateSession: vi.fn(),
  loadAgent: vi.fn(),
  session: {
    id: 'session-1',
    agent_id: 'agent-1',
    organization_id: 'org-session',
  } as { id: string; agent_id: string; organization_id?: string } | undefined,
  chatState: {
    draftSessionBySpaceId: {} as Record<string, boolean>,
    currentSessionIdBySpaceId: {} as Record<string, string | null>,
    messagesBySessionId: {} as Record<string, unknown[]>,
  },
}))

vi.mock('@tabtin/app-shell', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tabtin/app-shell')>()
  return {
    ...actual,
    AgentApiService: {
      listAgents: mocks.listAgents,
    },
  }
})

vi.mock('@/stores/useOrganizationStore', () => ({
  useOrganizationStore: (selector: (state: { selectedOrganization: { id: string } }) => unknown) =>
    selector({ selectedOrganization: { id: 'org-1' } }),
}))

vi.mock('@/stores/useSpaceStore', () => {
  const state = {
    selectedAgent: { id: 'agent-global', name: '全局 Agent' },
    selectedSpace: { id: 'space-1' },
    selectAgent: mocks.selectAgent,
    agentCache: {
      'agent-1': { id: 'agent-1', name: '小豆子' },
    },
    loadAgent: mocks.loadAgent,
  }
  const store = (selector: (s: typeof state) => unknown) => selector(state)
  return {
    useSpaceStore: Object.assign(store, {
      getState: () => state,
    }),
  }
})

vi.mock('@/stores/chat/useChatStore', () => {
  const store = (selector: (state: {
    getSessionById: () => typeof mocks.session
    updateSessionInCaches: typeof mocks.updateSessionInCaches
    draftSessionBySpaceId: typeof mocks.chatState.draftSessionBySpaceId
    currentSessionIdBySpaceId: typeof mocks.chatState.currentSessionIdBySpaceId
    messagesBySessionId: typeof mocks.chatState.messagesBySessionId
  }) => unknown) => selector({
    getSessionById: () => mocks.session,
    updateSessionInCaches: mocks.updateSessionInCaches,
    ...mocks.chatState,
  })
  return {
    useChatStore: Object.assign(store, {
      getState: () => ({
        getSessionById: () => mocks.session,
        updateSessionInCaches: mocks.updateSessionInCaches,
        ...mocks.chatState,
      }),
    }),
  }
})

vi.mock('@/services/chatApi', () => ({
  getChatClient: () => ({
    sessions: {
      update: mocks.updateSession,
    },
  }),
}))

vi.mock('@components/ui', () => ({
  toast: {
    error: vi.fn(),
  },
}))

import { useAgentIdentitySelection } from '../useAgentIdentitySelection'
import {
  recordDraftAgentIntent,
} from '@/stores/chat/session/draftMessage'
import {
  __resetDraftMessageSessionCoordinatorForTests,
  beginDraftMessageSession,
} from '@/stores/chat/session/draftMessageSessionCoordinator'

const AGENTS = [
  { id: 'agent-1', name: '小豆子' },
  { id: 'agent-2', name: '干活' },
]

describe('useAgentIdentitySelection', () => {
  beforeEach(() => {
    __resetDraftMessageSessionCoordinatorForTests()
    mocks.session = {
      id: 'session-1',
      agent_id: 'agent-1',
      organization_id: 'org-session',
    }
    mocks.listAgents.mockReset().mockResolvedValue(AGENTS)
    mocks.selectAgent.mockReset()
    mocks.updateSessionInCaches.mockReset()
    mocks.updateSession.mockReset().mockResolvedValue({
      id: 'session-1',
      agent_id: 'agent-2',
    })
    mocks.loadAgent.mockReset().mockResolvedValue(null)
    mocks.chatState.draftSessionBySpaceId = {}
    mocks.chatState.currentSessionIdBySpaceId = {}
    mocks.chatState.messagesBySessionId = {}
  })

  it('#7086 已落库会话按 session.agent_id 展示；canChangeAgent 时可写库换 Agent', async () => {
    const { result } = renderHook(() => useAgentIdentitySelection('session-1', true))

    await waitFor(() => {
      expect(result.current.currentAgent?.id).toBe('agent-1')
      expect(result.current.agents).toHaveLength(2)
    })
    expect(mocks.listAgents).toHaveBeenCalledWith('org-session')

    await act(async () => {
      await result.current.selectIdentity('agent-2')
    })

    expect(mocks.updateSession).toHaveBeenCalledWith('session-1', {
      agent_id: 'agent-2',
    })
    // 先乐观写缓存，再落服务端回包；不改全局 selectedAgent
    expect(mocks.updateSessionInCaches.mock.calls[0]).toEqual([
      'session-1',
      { agent_id: 'agent-2' },
    ])
    expect(mocks.updateSessionInCaches).toHaveBeenCalledWith('session-1', {
      id: 'session-1',
      agent_id: 'agent-2',
    })
    expect(mocks.selectAgent).not.toHaveBeenCalled()
  })

  it('#7462 正式会话切 Agent 失败时回滚乐观缓存且不写全局 selectedAgent', async () => {
    mocks.updateSession.mockRejectedValueOnce(new Error('network'))
    const { result } = renderHook(() => useAgentIdentitySelection('session-1', true))

    await waitFor(() => {
      expect(result.current.agents).toHaveLength(2)
    })

    await act(async () => {
      await result.current.selectIdentity('agent-2')
    })

    expect(mocks.updateSessionInCaches.mock.calls[0]).toEqual([
      'session-1',
      { agent_id: 'agent-2' },
    ])
    expect(mocks.updateSessionInCaches.mock.calls.at(-1)).toEqual([
      'session-1',
      { agent_id: 'agent-1' },
    ])
    expect(mocks.selectAgent).not.toHaveBeenCalled()
  })

  it('草稿态无预建时只更新 selectedAgent，不修改会话', async () => {
    mocks.session = undefined
    const { result } = renderHook(() => useAgentIdentitySelection(null, true))

    await waitFor(() => {
      expect(result.current.agents).toHaveLength(2)
    })

    await act(async () => {
      await result.current.selectIdentity('agent-2')
    })

    expect(mocks.selectAgent).toHaveBeenCalledWith(AGENTS[1])
    expect(mocks.updateSession).not.toHaveBeenCalled()
    expect(mocks.updateSessionInCaches).not.toHaveBeenCalled()
  })

  it('prefetch 后草稿切 Agent：同步隐藏空 session 的 agent_id', async () => {
    mocks.session = undefined
    mocks.chatState.draftSessionBySpaceId = { 'space-1': true }
    mocks.chatState.currentSessionIdBySpaceId = { 'space-1': 'sess-hidden' }
    mocks.chatState.messagesBySessionId = { 'sess-hidden': [] }
    mocks.updateSession.mockResolvedValue({
      id: 'sess-hidden',
      agent_id: 'agent-2',
    })

    const { result } = renderHook(() => useAgentIdentitySelection(null, {
      showIdentity: true,
      canChangeAgent: true,
    }))

    await waitFor(() => {
      expect(result.current.agents).toHaveLength(2)
    })

    await act(async () => {
      await result.current.selectIdentity('agent-2')
    })

    expect(mocks.selectAgent).toHaveBeenCalledWith(AGENTS[1])
    expect(mocks.updateSession).toHaveBeenCalledWith('sess-hidden', {
      agent_id: 'agent-2',
    })
  })

  it('canChangeAgent=false 时 selectIdentity 不写会话（团队 Space 锁死）', async () => {
    const { result } = renderHook(() => useAgentIdentitySelection('session-1', {
      showIdentity: true,
      canChangeAgent: false,
    }))

    await waitFor(() => {
      expect(result.current.currentAgent?.id).toBe('agent-1')
    })

    await act(async () => {
      await result.current.selectIdentity('agent-2')
    })

    expect(mocks.updateSession).not.toHaveBeenCalled()
    expect(mocks.selectAgent).not.toHaveBeenCalled()
  })

  it('正式会话身份优先 session.agent_id，不回落全局 selectedAgent', async () => {
    const { result } = renderHook(() => useAgentIdentitySelection('session-1', {
      showIdentity: true,
      canChangeAgent: false,
    }))

    await waitFor(() => {
      expect(result.current.currentAgentId).toBe('agent-1')
      expect(result.current.currentAgent?.name).toBe('小豆子')
    })
    expect(result.current.currentAgentId).not.toBe('agent-global')
  })

  it('reloadAgents 可主动刷新列表', async () => {
    const { result } = renderHook(() => useAgentIdentitySelection('session-1', true))
    await waitFor(() => expect(result.current.agents).toHaveLength(2))

    mocks.listAgents.mockResolvedValueOnce([
      ...AGENTS,
      { id: 'agent-3', name: '新分身' },
    ])

    await act(async () => {
      await result.current.reloadAgents()
    })

    expect(result.current.agents).toHaveLength(3)
    expect(result.current.agents[2]?.name).toBe('新分身')
  })

  it('组织切换时清空旧列表并进入 loading', async () => {
    const { result, rerender } = renderHook(
      ({ sessionId }) => useAgentIdentitySelection(sessionId, true),
      { initialProps: { sessionId: 'session-1' as string | null } },
    )
    await waitFor(() => expect(result.current.agents).toHaveLength(2))

    mocks.listAgents.mockImplementation(() => new Promise(() => {}))
    mocks.session = {
      id: 'session-1',
      agent_id: 'agent-1',
      organization_id: 'org-other',
    }
    rerender({ sessionId: 'session-1' })

    await waitFor(() => {
      expect(result.current.agents).toHaveLength(0)
      expect(result.current.isLoading).toBe(true)
    })
    expect(mocks.listAgents).toHaveBeenCalledWith('org-other')
  })

  it('后台 reloadAgents 失败时保留旧列表', async () => {
    const { result } = renderHook(() => useAgentIdentitySelection('session-1', true))
    await waitFor(() => expect(result.current.agents).toHaveLength(2))

    mocks.listAgents.mockRejectedValueOnce(new Error('network'))
    await act(async () => {
      await result.current.reloadAgents()
    })

    expect(result.current.agents).toHaveLength(2)
    expect(result.current.isLoading).toBe(false)
  })

  it('后台 reloadAgents 不置 isLoading（避免禁用选择器触发器）', async () => {
    let resolveReload: ((value: typeof AGENTS) => void) | undefined
    mocks.listAgents
      .mockResolvedValueOnce(AGENTS)
      .mockImplementationOnce(() => new Promise((resolve) => {
        resolveReload = resolve
      }))

    const { result } = renderHook(() => useAgentIdentitySelection('session-1', true))
    await waitFor(() => expect(result.current.agents).toHaveLength(2))
    expect(result.current.isLoading).toBe(false)

    let reloadPromise: Promise<void> | undefined
    await act(async () => {
      reloadPromise = result.current.reloadAgents()
    })
    expect(result.current.isLoading).toBe(false)

    await act(async () => {
      resolveReload?.([
        ...AGENTS,
        { id: 'agent-3', name: '新分身' },
      ])
      await reloadPromise
    })
    expect(result.current.agents).toHaveLength(3)
    expect(result.current.isLoading).toBe(false)
  })

  it('local-pending 用草稿 episode 身份快照，不依赖 session record（ E）', async () => {
    mocks.session = undefined
    beginDraftMessageSession('conversation:draft:workspace-1', { agentId: 'agent-1' })
    recordDraftAgentIntent('conversation:draft:workspace-1', 'agent-1')
    // agentCache 已有 agent-1；全局 selectedAgent 是无关的 agent-global
    const { result } = renderHook(() => useAgentIdentitySelection('local-pending-abc', {
      showIdentity: true,
      canChangeAgent: true,
      draftScopeKey: 'conversation:draft:workspace-1',
    }))

    await waitFor(() => {
      expect(result.current.currentAgentId).toBe('agent-1')
      expect(result.current.currentAgent?.name).toBe('小豆子')
    })
    expect(result.current.identityPlaceholder).toBeNull()
  })

  it('已建会话 load 失败显示可诊断占位，不回落 selectedAgent（ E）', async () => {
    mocks.session = undefined
    mocks.loadAgent.mockResolvedValue(null)
    const { result } = renderHook(() => useAgentIdentitySelection('session-missing', {
      showIdentity: true,
      canChangeAgent: false,
    }))

    await waitFor(() => {
      expect(result.current.currentAgent).toBeNull()
      expect(result.current.identityPlaceholder?.kind).toBe('load_failed')
    })
    expect(result.current.currentAgentId).toBeNull()
    expect(result.current.currentAgentId).not.toBe('agent-global')
  })

  it('会话 Agent 更新期间拒绝第二个并发切换', async () => {
    let finishUpdate: ((value: { id: string; agent_id: string }) => void) | undefined
    mocks.updateSession.mockImplementation(() => new Promise((resolve) => {
      finishUpdate = resolve
    }))
    const { result } = renderHook(() => useAgentIdentitySelection('session-1', true))
    await waitFor(() => expect(result.current.agents).toHaveLength(2))

    let firstUpdate: Promise<void> | undefined
    await act(async () => {
      firstUpdate = result.current.selectIdentity('agent-2')
      await result.current.selectIdentity('agent-2')
    })
    expect(mocks.updateSession).toHaveBeenCalledTimes(1)

    await act(async () => {
      finishUpdate?.({ id: 'session-1', agent_id: 'agent-2' })
      await firstUpdate
    })
  })
})
