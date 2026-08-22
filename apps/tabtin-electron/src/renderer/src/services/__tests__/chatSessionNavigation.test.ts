/**
 * chatSessionNavigation Wave 3 扩展测试：messageId / highlightTerms / loadContextWindow 透传
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const {
  mockEnsureSpaceSelected,
  mockLoadSessions,
  mockSelectSession,
  mockScrollToMessage,
  mockSetSpaceSessions,
  mockUpsertTrackerRunSession,
  mockSetActiveKey,
  mockCloseMemo,
  mockSetCurrentTab,
  mockCloseAppPage,
  mockAddPreset,
  mockGetSession,
  appPageState,
  chatState,
} = vi.hoisted(() => ({
  mockEnsureSpaceSelected: vi.fn().mockResolvedValue(true),
  mockLoadSessions: vi.fn().mockResolvedValue(undefined),
  mockSelectSession: vi.fn().mockResolvedValue(undefined),
  mockScrollToMessage: vi.fn(),
  mockSetSpaceSessions: vi.fn(),
  mockUpsertTrackerRunSession: vi.fn(),
  mockSetActiveKey: vi.fn(),
  mockCloseMemo: vi.fn(),
  mockSetCurrentTab: vi.fn(),
  mockCloseAppPage: vi.fn(),
  mockAddPreset: vi.fn(),
  mockGetSession: vi.fn(),
  appPageState: {
    activePage: null as 'skill' | 'automation' | 'collaboration' | 'project' | null,
  },
  chatState: {
    sessionsBySpaceId: {} as Record<string, Array<{ id: string; space_id?: string | null; tracker_run?: unknown }>>,
    trackerRunSessionsBySpaceId: {} as Record<string, Array<{ id: string; space_id?: string | null; tracker_run?: unknown }>>,
    messagesBySessionId: {} as Record<string, Array<{ id: string; role: string }>>,
  },
}))

vi.mock('@/services/spaceNavigation', () => ({
  ensureSpaceSelectedWithFeedback: mockEnsureSpaceSelected,
}))

vi.mock('@stores/chat/useChatStore', () => ({
  DEFAULT_CONTEXT_WINDOW_SIZE: 20,
  useChatStore: {
    getState: () => ({
      ...chatState,
      loadSessions: mockLoadSessions,
      selectSession: (
        spaceId: string,
        sessionId: string,
        options?: { draftScopeKey?: unknown; sharedAccess?: unknown; initialMessagePage?: unknown },
      ) => options?.draftScopeKey || options?.sharedAccess || options?.initialMessagePage
        ? mockSelectSession(spaceId, sessionId, options)
        : mockSelectSession(spaceId, sessionId),
      scrollToMessage: mockScrollToMessage,
      setSpaceSessions: mockSetSpaceSessions,
      upsertTrackerRunSession: mockUpsertTrackerRunSession,
    }),
  },
}))

vi.mock('@/services/chatApi', () => ({
  getChatClient: () => ({
    sessions: {
      get: (sessionId: string, options?: unknown) => options === undefined
        ? mockGetSession(sessionId)
        : mockGetSession(sessionId, options),
    },
  }),
}))

vi.mock('@stores/useSpaceContextTabsStore', () => ({
  useSpaceContextTabsStore: { getState: () => ({ setActiveKey: mockSetActiveKey }) },
}))

vi.mock('@stores/useUIStore', () => ({
  useUIStore: { getState: () => ({ closeMemo: mockCloseMemo }) },
}))

vi.mock('@stores/useMainNavStore', () => ({
  useMainNavStore: { getState: () => ({ setCurrentTab: mockSetCurrentTab }) },
}))

vi.mock('@stores/useAppPageStore', () => ({
  useAppPageStore: {
    getState: () => ({
      activePage: appPageState.activePage,
      closeAppPage: mockCloseAppPage,
    }),
  },
}))

vi.mock('@stores/useComposerPresetStore', () => ({
  useComposerPresetStore: { getState: () => ({ addPreset: mockAddPreset }) },
}))

vi.mock('@/i18n', () => ({
  default: { t: (k: string, d?: { defaultValue?: string }) => d?.defaultValue ?? k },
}))

vi.mock('@/utils/logger', () => ({
  logger: { debug: vi.fn(), error: vi.fn(), warn: vi.fn(), info: vi.fn() },
  createLogger: () => ({ debug: vi.fn(), error: vi.fn(), warn: vi.fn(), info: vi.fn() }),
}))

vi.mock('@tabtin/smartsheet-ui/toast', () => ({
  toast: { error: vi.fn(), info: vi.fn() },
}))

vi.mock('@tabtin/chat-client', () => {
  class ChatAPIError extends Error {
    statusCode: number
    constructor(message: string, statusCode: number) {
      super(message)
      this.name = 'ChatAPIError'
      this.statusCode = statusCode
    }
  }
  return { ChatAPIError }
})

import { enterChatSession } from '../chatSessionNavigation'
import { toast } from '@tabtin/smartsheet-ui/toast'
import { ChatAPIError } from '@tabtin/chat-client'
import {
  getOpenChatSessionIntent,
  resetOpenChatSessionIntentForTests,
} from '@/stores/chat/session/openChatSessionIntent'

describe('enterChatSession - Wave 3 messageId 透传', () => {
  beforeEach(() => {
    chatState.sessionsBySpaceId = {
      'space-1': [{ id: 'sess-1', space_id: 'space-1' }],
    }
    chatState.trackerRunSessionsBySpaceId = {}
    chatState.messagesBySessionId = {}
    appPageState.activePage = null
    mockEnsureSpaceSelected.mockResolvedValue(true)
    mockLoadSessions.mockClear()
    mockSelectSession.mockClear()
    mockScrollToMessage.mockClear()
    mockSetSpaceSessions.mockClear()
    mockUpsertTrackerRunSession.mockClear()
    mockSetActiveKey.mockClear()
    mockCloseAppPage.mockClear()
    mockGetSession.mockResolvedValue({ id: 'sess-1', space_id: 'space-1' })
    resetOpenChatSessionIntentForTests()
  })

  afterEach(() => {
    vi.clearAllMocks()
    resetOpenChatSessionIntentForTests()
  })

  it('未传 messageId：不触发 scrollToMessage', async () => {
    const seq = await enterChatSession('space-1', 'sess-1')
    expect(seq).toBeGreaterThan(0)
    expect(mockLoadSessions).toHaveBeenCalledWith('space-1', undefined)
    expect(mockSelectSession).toHaveBeenCalledWith('space-1', 'sess-1')
    expect(mockScrollToMessage).not.toHaveBeenCalled()
    expect(mockSetCurrentTab).toHaveBeenCalledWith('agent')
  })

  it('回看执行记录时定位到第一条用户消息，不落在对话底部', async () => {
    chatState.messagesBySessionId = {
      'sess-1': [
        { id: 'system-1', role: 'system' },
        { id: 'user-1', role: 'user' },
        { id: 'assistant-1', role: 'assistant' },
      ],
    }

    const seq = await enterChatSession('space-1', 'sess-1', {
      initialScroll: 'first-message',
    })

    expect(seq).toBeGreaterThan(0)
    expect(mockScrollToMessage).toHaveBeenCalledWith('sess-1', 'user-1', {
      highlight: false,
      highlightTerms: undefined,
      loadContextWindow: 20,
    })
  })

  it('进会话不再动工作台标签（：原 setActiveKey(spaceId, null) 死桶写已删除）', async () => {
    const seq = await enterChatSession('space-1', 'sess-1')

    expect(seq).toBeGreaterThan(0)
    expect(mockSetActiveKey).not.toHaveBeenCalled()
    expect(mockSelectSession).toHaveBeenCalledWith('space-1', 'sess-1')
  })

  it('续接入口可以要求 selectSession 直接加载最新消息页', async () => {
    const seq = await enterChatSession('space-1', 'sess-1', {
      initialMessagePage: 'latest',
    })

    expect(seq).toBeGreaterThan(0)
    expect(mockSelectSession).toHaveBeenCalledWith('space-1', 'sess-1', {
      draftScopeKey: undefined,
      sharedAccess: undefined,
      initialMessagePage: 'latest',
    })
  })

  it('自动化等全屏 App 页内进会话会 closeAppPage，否则聊天 rail 挂不上', async () => {
    appPageState.activePage = 'automation'

    const seq = await enterChatSession('space-1', 'sess-1')

    expect(seq).toBeGreaterThan(0)
    expect(mockCloseAppPage).toHaveBeenCalledOnce()
    expect(mockCloseAppPage.mock.invocationCallOrder[0]).toBeLessThan(
      mockSelectSession.mock.invocationCallOrder[0],
    )
  })

  it('技能库全屏页进会话同样 closeAppPage', async () => {
    appPageState.activePage = 'skill'

    const seq = await enterChatSession('space-1', 'sess-1')

    expect(seq).toBeGreaterThan(0)
    expect(mockCloseAppPage).toHaveBeenCalledOnce()
  })

  it('Project 沉浸进会话不 closeAppPage，保留画布并排聊天 rail', async () => {
    appPageState.activePage = 'project'

    const seq = await enterChatSession('space-1', 'sess-1')

    expect(seq).toBeGreaterThan(0)
    expect(mockCloseAppPage).not.toHaveBeenCalled()
    expect(mockSelectSession).toHaveBeenCalledWith('space-1', 'sess-1')
  })

  it('fresh Space 会话桶缺失：先加载 sessions，再选中目标 session', async () => {
    chatState.sessionsBySpaceId = {}
    mockLoadSessions.mockImplementationOnce(async (spaceId: string) => {
      chatState.sessionsBySpaceId = {
        ...chatState.sessionsBySpaceId,
        [spaceId]: [{ id: 'sess-1', space_id: spaceId }],
      }
    })

    const seq = await enterChatSession('space-1', 'sess-1', {
      organizationId: 'organization-1',
    })

    expect(seq).toBeGreaterThan(0)
    expect(mockLoadSessions).toHaveBeenCalledWith('space-1', 'organization-1')
    expect(mockSelectSession).toHaveBeenCalledWith('space-1', 'sess-1')
    expect(mockLoadSessions.mock.invocationCallOrder[0]).toBeLessThan(
      mockSelectSession.mock.invocationCallOrder[0],
    )
    expect(mockSetSpaceSessions).not.toHaveBeenCalled()
  })

  it('目标 session 不在已加载列表时注入主会话桶，避免生命周期回退草稿', async () => {
    chatState.sessionsBySpaceId = {
      'space-1': [{ id: 'other-session', space_id: 'space-1' }],
    }
    mockGetSession.mockResolvedValueOnce({ id: 'sess-1', space_id: 'space-1' })

    const seq = await enterChatSession('space-1', 'sess-1')

    expect(seq).toBeGreaterThan(0)
    expect(mockGetSession).toHaveBeenCalledWith('sess-1')
    expect(mockSetSpaceSessions).toHaveBeenCalledWith(
      'space-1',
      [
        { id: 'sess-1', space_id: 'space-1' },
        { id: 'other-session', space_id: 'space-1' },
      ],
      false,
    )
    expect(mockSelectSession).toHaveBeenCalledWith('space-1', 'sess-1')
  })

  it('目标 Tracker Run session 不在列表时注入 tracker 分桶，不污染主会话桶', async () => {
    chatState.sessionsBySpaceId = {
      'space-1': [],
    }
    const trackerSession = {
      id: 'tracker-session',
      space_id: 'space-1',
      tracker_run: { id: 'run-1' },
    }
    mockGetSession.mockResolvedValueOnce(trackerSession)

    const seq = await enterChatSession('space-1', 'tracker-session')

    expect(seq).toBeGreaterThan(0)
    expect(mockUpsertTrackerRunSession).toHaveBeenCalledWith('space-1', trackerSession)
    expect(mockSetSpaceSessions).not.toHaveBeenCalled()
    expect(mockSelectSession).toHaveBeenCalledWith('space-1', 'tracker-session')
  })

  it('session 详情 Space 不匹配时不注入任何分桶，但仍尝试选择目标 session', async () => {
    chatState.sessionsBySpaceId = {
      'space-1': [],
    }
    mockGetSession.mockResolvedValueOnce({ id: 'sess-1', space_id: 'other-space' })

    const seq = await enterChatSession('space-1', 'sess-1')

    expect(seq).toBeGreaterThan(0)
    expect(mockSetSpaceSessions).not.toHaveBeenCalled()
    expect(mockUpsertTrackerRunSession).not.toHaveBeenCalled()
    expect(mockSelectSession).toHaveBeenCalledWith('space-1', 'sess-1')
  })

  it('loadSessions 失败后仍用 session 详情注入并继续进入会话', async () => {
    chatState.sessionsBySpaceId = {}
    mockLoadSessions.mockRejectedValueOnce(new Error('network down'))
    mockGetSession.mockResolvedValueOnce({ id: 'sess-1', space_id: 'space-1' })

    const seq = await enterChatSession('space-1', 'sess-1', {
      organizationId: 'organization-1',
    })

    expect(seq).toBeGreaterThan(0)
    expect(mockLoadSessions).toHaveBeenCalledWith('space-1', 'organization-1')
    expect(mockSetSpaceSessions).toHaveBeenCalledWith(
      'space-1',
      [{ id: 'sess-1', space_id: 'space-1' }],
      false,
    )
    expect(mockSelectSession).toHaveBeenCalledWith('space-1', 'sess-1')
  })

  it('messageId + highlightMessage + highlightTerms + loadContextWindow 全部透传到 scrollToMessage', async () => {
    const seq = await enterChatSession('space-1', 'sess-1', {
      messageId: 'msg-9',
      highlightMessage: true,
      highlightTerms: ['性能', '缓存'],
      loadContextWindow: 30,
    })
    expect(seq).toBeGreaterThan(0)
    expect(mockScrollToMessage).toHaveBeenCalledWith('sess-1', 'msg-9', {
      highlight: true,
      highlightTerms: ['性能', '缓存'],
      loadContextWindow: 30,
    })
  })

  it('未传 highlightMessage 时默认 true（PRD 3.5）', async () => {
    await enterChatSession('space-1', 'sess-1', { messageId: 'msg-1' })
    expect(mockScrollToMessage).toHaveBeenCalledWith('sess-1', 'msg-1', {
      highlight: true,
      highlightTerms: undefined,
      loadContextWindow: 20,
    })
  })

  it('显式 highlightMessage=false 透传', async () => {
    await enterChatSession('space-1', 'sess-1', {
      messageId: 'msg-1',
      highlightMessage: false,
    })
    expect(mockScrollToMessage).toHaveBeenCalledWith('sess-1', 'msg-1', {
      highlight: false,
      highlightTerms: undefined,
      loadContextWindow: 20,
    })
  })

  it('Space 选中失败：返回 0 并不调 scrollToMessage', async () => {
    mockEnsureSpaceSelected.mockResolvedValueOnce(false)
    const seq = await enterChatSession('space-X', 'sess-1', { messageId: 'msg-1' })
    expect(seq).toBe(0)
    expect(mockScrollToMessage).not.toHaveBeenCalled()
  })

  it('selectSession 抛错：返回 0 并不调 scrollToMessage', async () => {
    mockSelectSession.mockRejectedValueOnce(new Error('boom'))
    const seq = await enterChatSession('space-1', 'sess-1', { messageId: 'msg-1' })
    expect(seq).toBe(0)
    expect(mockScrollToMessage).not.toHaveBeenCalled()
  })

  it('旧 selectSession 在新跳转成功后才失败时静默退出，不提示旧错误', async () => {
    chatState.sessionsBySpaceId = {
      'space-a': [{ id: 'sess-a', space_id: 'space-a' }],
      'space-b': [{ id: 'sess-b', space_id: 'space-b' }],
    }
    let rejectFirstSelection!: (error: Error) => void
    const slowFailedSelection = new Promise<void>((_resolve, reject) => {
      rejectFirstSelection = reject
    })
    mockSelectSession.mockImplementationOnce(() => slowFailedSelection)

    const firstEnter = enterChatSession('space-a', 'sess-a')
    await vi.waitFor(() => expect(mockSelectSession).toHaveBeenCalledWith('space-a', 'sess-a'))

    const secondSeq = await enterChatSession('space-b', 'sess-b')
    rejectFirstSelection(new Error('late failure'))
    const firstSeq = await firstEnter

    expect(secondSeq).toBeGreaterThan(0)
    expect(firstSeq).toBe(0)
    expect(mockSelectSession).toHaveBeenNthCalledWith(2, 'space-b', 'sess-b')
    expect(toast.error).not.toHaveBeenCalled()
  })

  it('连续点击时慢 Space 加载不能覆盖后一次跳转', async () => {
    let resolveFirstSpaceSelection!: () => void
    const slowFirstSpaceSelection = new Promise<void>((resolve) => {
      resolveFirstSpaceSelection = resolve
    })
    mockEnsureSpaceSelected
      .mockImplementationOnce(async (_spaceId, options: { isCurrent: () => boolean }) => {
        await slowFirstSpaceSelection
        return options.isCurrent()
      })
      .mockImplementationOnce((_spaceId, options: { isCurrent: () => boolean }) => options.isCurrent())

    const firstEnter = enterChatSession('space-a', 'sess-a')
    const secondSeq = await enterChatSession('space-b', 'sess-b')
    resolveFirstSpaceSelection()
    const firstSeq = await firstEnter

    expect(firstSeq).toBe(0)
    expect(secondSeq).toBeGreaterThan(0)
    expect(mockEnsureSpaceSelected).toHaveBeenCalledTimes(2)
    expect(mockEnsureSpaceSelected).toHaveBeenLastCalledWith('space-b', expect.objectContaining({
      organizationId: undefined,
      failureToast: undefined,
      isCurrent: expect.any(Function),
    }))
    expect(mockSelectSession).toHaveBeenCalledTimes(1)
    expect(mockSelectSession).toHaveBeenCalledWith('space-b', 'sess-b')
  })

  it('verifySessionExists：引用 Space 过期时切换到服务端实际 Space，且不污染旧分桶', async () => {
    chatState.sessionsBySpaceId = {
      'stale-space': [{ id: 'other-session', space_id: 'stale-space' }],
    }
    const actualSession = { id: 'sess-1', space_id: 'actual-space' }
    mockGetSession.mockResolvedValueOnce(actualSession)

    const seq = await enterChatSession('stale-space', 'sess-1', {
      organizationId: 'organization-1',
      verifySessionExists: true,
    })

    expect(seq).toBeGreaterThan(0)
    expect(mockEnsureSpaceSelected).toHaveBeenCalledWith('actual-space', expect.objectContaining({
      organizationId: 'organization-1',
      failureToast: undefined,
      isCurrent: expect.any(Function),
    }))
    expect(mockLoadSessions).toHaveBeenCalledWith('actual-space', 'organization-1')
    expect(mockSetSpaceSessions).toHaveBeenCalledWith('actual-space', [actualSession], false)
    expect(mockSetSpaceSessions).not.toHaveBeenCalledWith(
      'stale-space',
      expect.anything(),
      expect.anything(),
    )
    expect(mockSelectSession).toHaveBeenCalledWith('actual-space', 'sess-1')
  })

  it('v1 共享任务：保留原 Workspace 归属，在接收者当前 Workspace 登记展示会话', async () => {
    chatState.sessionsBySpaceId = {
      'viewer-space': [{ id: 'viewer-session', space_id: 'viewer-space' }],
    }
    const sharedSession = {
      id: 'shared-session',
      space_id: 'owner-workspace',
      workspace_id: 'owner-workspace',
    }
    mockGetSession.mockResolvedValueOnce(sharedSession)

    const sharedAccess = {
      shareId: 'share-1',
      organizationId: 'organization-1',
      workspaceId: 'owner-workspace',
      role: 'grantee' as const,
    }
    const seq = await enterChatSession('viewer-space', 'shared-session', {
      organizationId: 'organization-1',
      verifySessionExists: true,
      sharedAccess,
    })

    expect(seq).toBeGreaterThan(0)
    expect(mockGetSession).toHaveBeenCalledWith('shared-session', { shareId: 'share-1' })
    expect(mockEnsureSpaceSelected).toHaveBeenCalledWith('viewer-space', expect.anything())
    expect(mockSetSpaceSessions).toHaveBeenCalledWith(
      'viewer-space',
      [sharedSession, { id: 'viewer-session', space_id: 'viewer-space' }],
      false,
    )
    expect(mockSelectSession).toHaveBeenCalledWith('viewer-space', 'shared-session', {
      draftScopeKey: undefined,
      sharedAccess,
    })
    expect(sharedSession.workspace_id).toBe('owner-workspace')
  })

  it('verifySessionExists：权威 Tracker metadata 会自愈普通桶中的旧污染项', async () => {
    chatState.sessionsBySpaceId = {
      'space-1': [{ id: 'tracker-session', space_id: 'space-1' }],
    }
    const trackerSession = {
      id: 'tracker-session',
      space_id: 'space-1',
      agent_id: 'agent-1',
      tracker_run: { id: 'run-1' },
    }
    mockGetSession.mockResolvedValueOnce(trackerSession)

    const seq = await enterChatSession('space-1', 'tracker-session', {
      verifySessionExists: true,
    })

    expect(seq).toBeGreaterThan(0)
    expect(mockUpsertTrackerRunSession).toHaveBeenCalledWith('space-1', trackerSession)
    expect(mockSetSpaceSessions).not.toHaveBeenCalled()
    expect(mockSelectSession).toHaveBeenCalledWith('space-1', 'tracker-session')
  })

  it('verifySessionExists 预检失败时按引用降级进入，但不向旧 Space 分桶注入', async () => {
    chatState.sessionsBySpaceId = {
      'stale-space': [{ id: 'other-session', space_id: 'stale-space' }],
    }
    mockGetSession.mockRejectedValueOnce(new Error('network down'))

    const seq = await enterChatSession('stale-space', 'sess-1', {
      verifySessionExists: true,
    })

    expect(seq).toBeGreaterThan(0)
    expect(mockGetSession).toHaveBeenCalledTimes(1)
    expect(mockSetSpaceSessions).not.toHaveBeenCalled()
    expect(mockUpsertTrackerRunSession).not.toHaveBeenCalled()
    expect(mockSelectSession).toHaveBeenCalledWith('stale-space', 'sess-1')
  })

  it('verifySessionExists 的会话详情缺少 Space 时不污染引用 Space 分桶', async () => {
    chatState.sessionsBySpaceId = {
      'stale-space': [{ id: 'other-session', space_id: 'stale-space' }],
    }
    mockGetSession.mockResolvedValueOnce({ id: 'sess-1', space_id: null })

    const seq = await enterChatSession('stale-space', 'sess-1', {
      verifySessionExists: true,
    })

    expect(seq).toBeGreaterThan(0)
    expect(mockSetSpaceSessions).not.toHaveBeenCalled()
    expect(mockUpsertTrackerRunSession).not.toHaveBeenCalled()
    expect(mockSelectSession).toHaveBeenCalledWith('stale-space', 'sess-1')
  })

  it('verifySessionExists + sessions.get 404：toast 会话已删除，不切 Space 或 selectSession', async () => {
    mockGetSession.mockRejectedValueOnce(new ChatAPIError('not found', 404))
    const seq = await enterChatSession('space-1', 'sess-1', {
      verifySessionExists: true,
      sessionNotFoundMessage: '该对话已被删除，无法跳转',
    })
    expect(seq).toBe(0)
    expect(mockGetSession).toHaveBeenCalledWith('sess-1')
    expect(mockEnsureSpaceSelected).not.toHaveBeenCalled()
    expect(mockSelectSession).not.toHaveBeenCalled()
    expect(toast.error).toHaveBeenCalledWith('该对话已被删除，无法跳转')
  })

  it('#10951 选 Space 前就钉住显式打开意图，结束后按 token 清掉', async () => {
    mockEnsureSpaceSelected.mockImplementationOnce(async () => {
      expect(getOpenChatSessionIntent()).toEqual(expect.objectContaining({
        spaceId: 'space-1',
        sessionId: 'sess-1',
      }))
      return true
    })

    const seq = await enterChatSession('space-1', 'sess-1')
    expect(seq).toBeGreaterThan(0)
    expect(getOpenChatSessionIntent()).toBeNull()
  })

  it('#10951 旧导航收尾不能清掉更新的打开意图', async () => {
    let resolveFirstSpace!: () => void
    const slowFirstSpace = new Promise<void>((resolve) => {
      resolveFirstSpace = resolve
    })
    mockEnsureSpaceSelected
      .mockImplementationOnce(async (_spaceId, options: { isCurrent: () => boolean }) => {
        await slowFirstSpace
        return options.isCurrent()
      })
      .mockImplementationOnce((_spaceId, options: { isCurrent: () => boolean }) => options.isCurrent())

    const firstEnter = enterChatSession('space-1', 'sess-a')
    const secondSeq = await enterChatSession('space-1', 'sess-b')
    expect(getOpenChatSessionIntent()).toBeNull()
    resolveFirstSpace()
    const firstSeq = await firstEnter

    expect(firstSeq).toBe(0)
    expect(secondSeq).toBeGreaterThan(0)
    expect(getOpenChatSessionIntent()).toBeNull()
    expect(mockSelectSession).toHaveBeenCalledTimes(1)
    expect(mockSelectSession).toHaveBeenCalledWith('space-1', 'sess-b')
  })

  it('#10951 过期 verifySessionExists 改归属时，不得覆盖后一次导航的 intent', async () => {
    let resolveStaleGet!: (session: { id: string; space_id: string }) => void
    const staleGet = new Promise<{ id: string; space_id: string }>((resolve) => {
      resolveStaleGet = resolve
    })
    mockGetSession.mockImplementationOnce(() => staleGet)

    const staleEnter = enterChatSession('stale-space', 'sess-stale', {
      verifySessionExists: true,
    })
    const winnerSeq = await enterChatSession('space-1', 'sess-1')
    expect(winnerSeq).toBeGreaterThan(0)
    expect(getOpenChatSessionIntent()).toBeNull()

    resolveStaleGet({ id: 'sess-stale', space_id: 'actual-space' })
    expect(await staleEnter).toBe(0)
    expect(getOpenChatSessionIntent()).toBeNull()
    expect(mockSelectSession).toHaveBeenCalledTimes(1)
    expect(mockSelectSession).toHaveBeenCalledWith('space-1', 'sess-1')
    expect(mockEnsureSpaceSelected).not.toHaveBeenCalledWith(
      'actual-space',
      expect.anything(),
    )
  })

  it('#10951 A→B→A 连续进入时最后一次点击的 A 胜出', async () => {
    const spaceWaits: Array<() => void> = []
    mockEnsureSpaceSelected.mockImplementation(async (_spaceId, options: { isCurrent: () => boolean }) => {
      await new Promise<void>((resolve) => { spaceWaits.push(resolve) })
      return options.isCurrent()
    })

    const enterA1 = enterChatSession('space-1', 'sess-a')
    const enterB = enterChatSession('space-1', 'sess-b')
    const enterA2 = enterChatSession('space-1', 'sess-a')

    await vi.waitFor(() => expect(spaceWaits.length).toBe(3))
    spaceWaits[0]()
    spaceWaits[1]()
    spaceWaits[2]()

    expect(await enterA1).toBe(0)
    expect(await enterB).toBe(0)
    expect(await enterA2).toBeGreaterThan(0)
    expect(mockSelectSession).toHaveBeenCalledTimes(1)
    expect(mockSelectSession).toHaveBeenCalledWith('space-1', 'sess-a')
  })
})
