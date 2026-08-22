import { beforeEach, describe, expect, it, vi } from 'vitest'

const toast = vi.fn()
const navigateToNewTask = vi.fn()
const resolveNewTaskConversationTarget = vi.fn()
const setChatSidePanelCollapsed = vi.fn()
const setAppFocusChatOverlayOpen = vi.fn()
const setTaskViewModeForScope = vi.fn()
const getTaskViewMode = vi.fn()
const setCurrentTab = vi.fn()
const activateSpace = vi.fn()
const closeIM = vi.fn()
const setCurrentConversation = vi.fn()
const closeSettings = vi.fn()
const setSidebarModeForOrganizationUser = vi.fn()

const mainNavState = {
  currentTab: 'agent' as string,
}

vi.mock('@tabtin/smartsheet-ui', () => ({
  toast: (...args: unknown[]) => toast(...args),
}))

vi.mock('@/i18n', () => ({
  default: {
    t: (_key: string, opts?: { defaultValue?: string }) => opts?.defaultValue ?? _key,
  },
}))

vi.mock('@/services/newTaskDraftNavigation', () => ({
  navigateToNewTask: (...args: unknown[]) => navigateToNewTask(...args),
  resolveNewTaskConversationTarget: (...args: unknown[]) => resolveNewTaskConversationTarget(...args),
}))

vi.mock('@components/layout/primaryNavigation', () => ({
  resolveNewTaskMainNavTab: () => 'agent',
}))

vi.mock('@/stores/useUIStore', () => ({
  useUIStore: {
    getState: () => ({
      setChatSidePanelCollapsed,
      setAppFocusChatOverlayOpen,
    }),
  },
}))

vi.mock('@/stores/useSpaceViewPrefsStore', () => ({
  useSpaceViewPrefsStore: {
    getState: () => ({
      getTaskViewMode,
      setTaskViewModeForScope,
      setSidebarModeForOrganizationUser,
    }),
  },
}))

vi.mock('@/stores/useMainNavStore', () => ({
  useMainNavStore: {
    getState: () => ({
      currentTab: mainNavState.currentTab,
      setCurrentTab,
    }),
  },
}))

vi.mock('@/stores/useSpaceListStore', () => ({
  useSpaceListStore: {
    getState: () => ({
      activateSpace,
    }),
  },
}))

vi.mock('@/stores/useIMStore', () => ({
  useIMStore: {
    getState: () => ({
      closeIM,
      setCurrentConversation,
    }),
  },
}))

vi.mock('@/stores/useSettingsSpaceStore', () => ({
  useSettingsSpaceStore: {
    getState: () => ({
      closeSettings,
    }),
  },
}))

vi.mock('@/stores/useOrganizationStore', () => ({
  useOrganizationStore: {
    getState: () => ({
      selectedOrganization: { id: 'org-1' },
    }),
  },
}))

vi.mock('@/stores/useAuthStore', () => ({
  useAuthStore: {
    getState: () => ({
      user: { id: 'user-1' },
    }),
  },
}))

vi.mock('@/utils/logger', () => {
  const stub = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }
  return {
    createLogger: () => stub,
    logger: stub,
  }
})

const chatState = {
  currentSessionId: null as string | null,
  currentSessionIdBySpaceId: {} as Record<string, string | null>,
  draftSessionBySpaceId: {} as Record<string, boolean>,
}

vi.mock('@/stores/chat/useChatStore', () => ({
  useChatStore: {
    getState: () => chatState,
    setState: (partial: Partial<typeof chatState>) => {
      Object.assign(chatState, partial)
    },
  },
}))

import { useContextInjectionStore } from '../../stores/useContextInjectionStore'
import {
  deliverContextInjectToChat,
  resolveContextInjectDeliveryTarget,
} from '../deliverContextInjectToChat'

const CODE_PAYLOAD = {
  type: 'code_file' as const,
  resourceId: 'file-id-1',
  label: 'main.ts',
  preview: 'export const x = 1',
  meta: { filePath: '/Users/secret/project/main.ts', rootPath: '/Users/secret/project' },
}

beforeEach(() => {
  vi.clearAllMocks()
  useContextInjectionStore.setState({
    activeScopeId: null,
    contextRefsByScopeId: {},
  })
  chatState.currentSessionId = null
  chatState.currentSessionIdBySpaceId = {}
  chatState.draftSessionBySpaceId = {}
  mainNavState.currentTab = 'agent'
  resolveNewTaskConversationTarget.mockReturnValue({
    spaceId: 'space-1',
    isProjectNavActive: false,
  })
  getTaskViewMode.mockReturnValue('split')
})

describe('resolveContextInjectDeliveryTarget', () => {
  it('有 activeScope 时优先返回 active-scope', () => {
    useContextInjectionStore.getState().setActiveScope('session-live')
    chatState.currentSessionId = 'session-other'

    expect(resolveContextInjectDeliveryTarget()).toEqual({
      ok: true,
      mode: 'active-scope',
      composerScopeId: 'session-live',
      tabScopeKey: 'conversation:session-live',
    })
  })

  it('无 activeScope 但有当前 session 时路由到 current-session', () => {
    chatState.currentSessionId = 'session-abc'
    chatState.currentSessionIdBySpaceId = { 'space-1': 'session-abc' }

    expect(resolveContextInjectDeliveryTarget()).toEqual({
      ok: true,
      mode: 'current-session',
      composerScopeId: 'session-abc',
      tabScopeKey: 'conversation:session-abc',
      spaceId: 'space-1',
    })
  })

  it('切换工作空间的过渡帧不把引用错投到全局旧会话', () => {
    chatState.currentSessionId = 'session-from-old-space'
    chatState.currentSessionIdBySpaceId = { 'space-1': 'session-for-current-space' }

    expect(resolveContextInjectDeliveryTarget()).toEqual({
      ok: true,
      mode: 'current-session',
      composerScopeId: 'session-for-current-space',
      tabScopeKey: 'conversation:session-for-current-space',
      spaceId: 'space-1',
    })
  })

  it('无 activeScope / session 但有草稿时路由到 current-draft', () => {
    chatState.draftSessionBySpaceId = { 'space-1': true }
    chatState.currentSessionIdBySpaceId = { 'space-1': null }

    expect(resolveContextInjectDeliveryTarget()).toEqual({
      ok: true,
      mode: 'current-draft',
      composerScopeId: '__draft__:space-1',
      tabScopeKey: 'conversation:draft:space-1',
      spaceId: 'space-1',
    })
  })

  it('draft 标记与 prefetch 隐藏 session 并存时仍优先 current-draft', () => {
    chatState.draftSessionBySpaceId = { 'space-1': true }
    chatState.currentSessionId = 'session-prefetched'
    chatState.currentSessionIdBySpaceId = { 'space-1': 'session-prefetched' }

    expect(resolveContextInjectDeliveryTarget()).toEqual({
      ok: true,
      mode: 'current-draft',
      composerScopeId: '__draft__:space-1',
      tabScopeKey: 'conversation:draft:space-1',
      spaceId: 'space-1',
    })
  })

  it('完全无会话时进入 new-task-draft', () => {
    expect(resolveContextInjectDeliveryTarget()).toEqual({
      ok: true,
      mode: 'new-task-draft',
      composerScopeId: '__draft__:space-1',
      tabScopeKey: 'conversation:draft:space-1',
      spaceId: 'space-1',
      isProjectNavActive: false,
    })
  })

  it('找不到工作空间时失败', () => {
    resolveNewTaskConversationTarget.mockReturnValue({
      spaceId: null,
      isProjectNavActive: false,
    })
    expect(resolveContextInjectDeliveryTarget()).toEqual({
      ok: false,
      reason: 'no-workspace',
    })
  })
})

describe('deliverContextInjectToChat', () => {
  it('activeScopeId=null 时不静默丢失：写入当前 session 并恢复可见对话', () => {
    chatState.currentSessionId = 'session-abc'
    chatState.currentSessionIdBySpaceId = { 'space-1': 'session-abc' }
    getTaskViewMode.mockReturnValue('app-focus')

    const result = deliverContextInjectToChat(CODE_PAYLOAD)

    expect(result).toEqual({
      ok: true,
      mode: 'current-session',
      scopeId: 'session-abc',
      tabScopeKey: 'conversation:session-abc',
    })
    expect(useContextInjectionStore.getState().contextRefsByScopeId['session-abc']).toHaveLength(1)
    expect(useContextInjectionStore.getState().contextRefsByScopeId['session-abc'][0]).toMatchObject({
      type: 'code_file',
      resourceId: 'file-id-1',
      label: 'main.ts',
    })
    expect(useContextInjectionStore.getState().activeScopeId).toBe('session-abc')
    expect(setChatSidePanelCollapsed).toHaveBeenCalledWith(false)
    expect(setTaskViewModeForScope).not.toHaveBeenCalled()
    expect(setAppFocusChatOverlayOpen).toHaveBeenCalledWith('conversation:session-abc', true)
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({
      title: '已加入对话',
      description: 'main.ts',
    }))
    expect(navigateToNewTask).not.toHaveBeenCalled()
  })

  it('已有 active scope 且已在任务域：只注入、不建新任务、不切主导航', () => {
    useContextInjectionStore.getState().setActiveScope('session-live')
    mainNavState.currentTab = 'agent'

    const result = deliverContextInjectToChat(CODE_PAYLOAD)

    expect(result).toEqual({
      ok: true,
      mode: 'active-scope',
      scopeId: 'session-live',
    })
    expect(useContextInjectionStore.getState().contextRefsByScopeId['session-live']).toHaveLength(1)
    expect(setTaskViewModeForScope).not.toHaveBeenCalled()
    expect(navigateToNewTask).not.toHaveBeenCalled()
    expect(setCurrentTab).not.toHaveBeenCalled()
    expect(toast).not.toHaveBeenCalled()
  })

  it('云文档域注入当前 session：切回任务域并展开对话，避免只 toast 看不见引用', () => {
    mainNavState.currentTab = 'cloud-docs'
    chatState.currentSessionId = 'session-abc'
    chatState.currentSessionIdBySpaceId = { 'space-1': 'session-abc' }

    const result = deliverContextInjectToChat(CODE_PAYLOAD)

    expect(result).toEqual({
      ok: true,
      mode: 'current-session',
      scopeId: 'session-abc',
      tabScopeKey: 'conversation:session-abc',
    })
    expect(navigateToNewTask).not.toHaveBeenCalled()
    expect(setCurrentTab).toHaveBeenCalledWith('agent')
    expect(activateSpace).toHaveBeenCalledWith('space-1')
    expect(closeIM).toHaveBeenCalled()
    expect(setSidebarModeForOrganizationUser).toHaveBeenCalledWith(
      'org-1',
      'user-1',
      'conversations',
    )
    expect(setChatSidePanelCollapsed).toHaveBeenCalledWith(false)
    expect(useContextInjectionStore.getState().contextRefsByScopeId['session-abc']).toHaveLength(1)
  })

  it('云文档域即便有 activeScope 也要切回任务域', () => {
    mainNavState.currentTab = 'cloud-docs'
    useContextInjectionStore.getState().setActiveScope('session-live')

    deliverContextInjectToChat(CODE_PAYLOAD)

    expect(navigateToNewTask).not.toHaveBeenCalled()
    expect(setCurrentTab).toHaveBeenCalledWith('agent')
    expect(activateSpace).toHaveBeenCalledWith('space-1')
    expect(setChatSidePanelCollapsed).toHaveBeenCalledWith(false)
  })

  it('隐藏后投递再打开：引用留在 session scope，展开胶囊面板后可被 composer 读到', () => {
    chatState.currentSessionId = 'session-hidden'
    chatState.currentSessionIdBySpaceId = { 'space-1': 'session-hidden' }
    getTaskViewMode.mockReturnValue('app-focus')

    deliverContextInjectToChat(CODE_PAYLOAD)

    // 模拟 ChatPanel 重新挂载：读同一 scope 的 refs
    const refs = useContextInjectionStore.getState().contextRefsByScopeId['session-hidden']
    expect(refs).toHaveLength(1)
    expect(refs[0].label).toBe('main.ts')
    expect(setTaskViewModeForScope).not.toHaveBeenCalled()
    expect(setAppFocusChatOverlayOpen).toHaveBeenCalledWith('conversation:session-hidden', true)
  })

  it('app-focus 下投递不再打断布局，改为展开胶囊悬浮面板', () => {
    chatState.currentSessionId = 's1'
    chatState.currentSessionIdBySpaceId = { 'space-1': 's1' }
    getTaskViewMode.mockReturnValue('app-focus')

    deliverContextInjectToChat({ type: 'code-selection', label: 'foo.ts', payload: {} } as never)

    // mock 模式下等价于：taskViewMode 保持 app-focus，并展开胶囊悬浮面板
    expect(setTaskViewModeForScope).not.toHaveBeenCalled()
    expect(setAppFocusChatOverlayOpen).toHaveBeenCalledWith('conversation:s1', true)
  })

  it('无会话时进入新任务草稿', () => {
    const result = deliverContextInjectToChat(CODE_PAYLOAD)

    expect(navigateToNewTask).toHaveBeenCalledWith('space-1', { isProjectNavActive: false })
    expect(result).toEqual({
      ok: true,
      mode: 'new-task-draft',
      spaceId: 'space-1',
      composerScopeId: '__draft__:space-1',
      tabScopeKey: 'conversation:draft:space-1',
    })
    expect(useContextInjectionStore.getState().contextRefsByScopeId['__draft__:space-1']).toHaveLength(1)
    expect(useContextInjectionStore.getState().activeScopeId).toBe('__draft__:space-1')
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({
      title: '已创建新任务并加入引用',
    }))
  })

  it('首次注入 → prefetch 隐藏 session → 折叠清空 activeScope → 再次注入仍留在 draft 并展开胶囊', () => {
    // 1) 新任务首次投递
    const first = deliverContextInjectToChat({
      ...CODE_PAYLOAD,
      type: 'document',
      resourceId: 'doc-1',
      label: '首份文档',
    })
    expect(first).toMatchObject({
      ok: true,
      mode: 'new-task-draft',
      composerScopeId: '__draft__:space-1',
    })

    // 2) prefetch 预建隐藏 session，同时保留 draft 标记
    chatState.draftSessionBySpaceId = { 'space-1': true }
    chatState.currentSessionIdBySpaceId = { 'space-1': 'session-prefetched' }
    chatState.currentSessionId = null

    // 3) 折叠 ChatPanel：卸载清理 activeScope
    useContextInjectionStore.getState().setActiveScope(null)
    getTaskViewMode.mockReturnValue('app-focus')
    vi.clearAllMocks()
    getTaskViewMode.mockReturnValue('app-focus')
    resolveNewTaskConversationTarget.mockReturnValue({
      spaceId: 'space-1',
      isProjectNavActive: false,
    })

    // 4) 折叠后再投递：不得错投 session 桶
    const second = deliverContextInjectToChat({
      ...CODE_PAYLOAD,
      type: 'file',
      resourceId: 'file-2',
      label: '折叠后文件',
    })

    expect(second).toEqual({
      ok: true,
      mode: 'current-draft',
      scopeId: '__draft__:space-1',
      spaceId: 'space-1',
      tabScopeKey: 'conversation:draft:space-1',
    })
    const draftRefs = useContextInjectionStore.getState().contextRefsByScopeId['__draft__:space-1']
    expect(draftRefs).toHaveLength(2)
    expect(draftRefs.map((ref: { label: string }) => ref.label)).toEqual(['首份文档', '折叠后文件'])
    expect(useContextInjectionStore.getState().contextRefsByScopeId['session-prefetched']).toBeUndefined()
    expect(setAppFocusChatOverlayOpen).toHaveBeenCalledWith('conversation:draft:space-1', true)
    expect(setChatSidePanelCollapsed).toHaveBeenCalledWith(false)
    expect(navigateToNewTask).not.toHaveBeenCalled()
  })

  it('缺工作空间时失败可感知', () => {
    resolveNewTaskConversationTarget.mockReturnValue({
      spaceId: null,
      isProjectNavActive: false,
    })

    const result = deliverContextInjectToChat(CODE_PAYLOAD)

    expect(result).toEqual({ ok: false, reason: 'no-workspace' })
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({
      variant: 'destructive',
      title: '无法加入对话',
    }))
    expect(useContextInjectionStore.getState().contextRefsByScopeId).toEqual({})
  })

  it('诊断日志不泄露文件路径内容', async () => {
    const { createLogger } = await import('../../utils/logger')
    const stub = createLogger('x') as unknown as {
      info: ReturnType<typeof vi.fn>
      warn: ReturnType<typeof vi.fn>
    }
    chatState.currentSessionId = 'session-abc'
    chatState.currentSessionIdBySpaceId = { 'space-1': 'session-abc' }

    deliverContextInjectToChat(CODE_PAYLOAD)

    const logged = JSON.stringify([...(stub.info.mock.calls), ...(stub.warn.mock.calls)])
    expect(logged).not.toContain('/Users/secret')
    expect(logged).not.toContain('project/main.ts')
  })
})
