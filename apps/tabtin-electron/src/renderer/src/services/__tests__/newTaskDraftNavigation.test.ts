import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  ensureLocalWorkspaceForOrganization,
  ensureSpaceSelectedWithFeedback,
} = vi.hoisted(() => ({
  ensureLocalWorkspaceForOrganization: vi.fn(async () => undefined),
  ensureSpaceSelectedWithFeedback: vi.fn(async () => true),
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

vi.mock('@/utils/featureFlags', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/utils/featureFlags')>()
  return {
    ...actual,
    PROJECTS_UI_ENABLED: true,
  }
})

vi.mock('@/services/spaceNavigation', () => ({
  ensureSpaceSelectedWithFeedback: (...args: unknown[]) =>
    ensureSpaceSelectedWithFeedback(...args),
}))

vi.mock('@components/sidebar/ensureLocalWorkspace', () => ({
  ensureLocalWorkspaceForOrganization: (...args: unknown[]) =>
    ensureLocalWorkspaceForOrganization(...args),
}))

import { useOrganizationStore } from '@stores/useOrganizationStore'
import { useSpaceStore } from '@stores/useSpaceStore'
import { useSpaceListStore } from '@stores/useSpaceListStore'
import { useSpaceViewPrefsStore } from '@stores/useSpaceViewPrefsStore'
import { useMainNavStore } from '@stores/useMainNavStore'
import { useAppPageStore } from '@stores/useAppPageStore'
import { useChatStore } from '@stores/chat/useChatStore'
import { useAuthStore } from '@stores/useAuthStore'
import { useIMStore } from '@stores/useIMStore'
import { useSettingsSpaceStore } from '@stores/useSettingsSpaceStore'
import { useProjectWorkspaceSelectionStore } from '@components/layout/projectWorkspaceSelectionStore'
import { useSpaceContextTabsStore } from '@stores/useSpaceContextTabsStore'
import { useContextInjectionStore } from '@stores/useContextInjectionStore'
import {
  ensurePersonalNewTaskSpaceId,
  navigateToNewTask,
  openCreatedWorkspaceAsNewTask,
  resolveNewTaskConversationTarget,
} from '../newTaskDraftNavigation'

beforeEach(() => {
  ensureLocalWorkspaceForOrganization.mockReset()
  ensureLocalWorkspaceForOrganization.mockResolvedValue(undefined)
  ensureSpaceSelectedWithFeedback.mockReset()
  ensureSpaceSelectedWithFeedback.mockResolvedValue(true)
  useOrganizationStore.setState({
    selectedOrganization: { id: 'org-1' },
  } as never)
  useAuthStore.setState({
    user: { id: 'user-1' },
  } as never)
  useSpaceStore.setState({
    spaces: [
      {
        id: 'ws-1',
        name: '个人现场',
        organization_id: 'org-1',
        type: 'workspace',
        is_archived: false,
      },
      {
        id: 'team-1',
        name: '上山',
        organization_id: 'org-1',
        type: 'team_space',
        is_archived: false,
      },
    ],
    selectedSpace: {
      id: 'ws-1',
      name: '个人现场',
      organization_id: 'org-1',
      type: 'workspace',
    },
  } as never)
  useSpaceListStore.setState({
    selectedSpaceId: 'workspace:ws-1',
    activateSpace: vi.fn(),
  } as never)
  useMainNavStore.setState({ currentTab: 'agent' })
  useAppPageStore.setState({ activePage: null, activeProjectId: null })
  useProjectWorkspaceSelectionStore.setState({ selectedProjectId: null })
  useSpaceViewPrefsStore.setState({
    lastUsedWorkspaceIdByOrganization: { 'org-1': 'ws-1' },
    sidebarModeByOrganizationUser: {},
  } as never)
  useChatStore.setState({
    startDraftSessionForSpace: vi.fn(),
    setDraftExecutionSpaceForWorkspace: vi.fn(),
    draftSessionBySpaceId: {},
    currentSessionIdBySpaceId: {},
  } as never)
  useIMStore.setState({
    closeIM: vi.fn(),
    setCurrentConversation: vi.fn(),
  } as never)
  useSettingsSpaceStore.setState({
    closeSettings: vi.fn(),
  } as never)
  useSpaceContextTabsStore.setState({
    itemsBySpace: {},
    tabOrderBySpace: {},
    activeKeyBySpace: {},
    displayKeyBySpace: {},
  })
  useContextInjectionStore.setState({
    activeScopeId: null,
    contextRefsByScopeId: {
      '__draft__:ws-1': [{
        id: 'old',
        type: 'doc_selection',
        resourceId: 'old-doc',
        label: '旧引用',
      }],
    },
  })
})

describe('ensurePersonalNewTaskSpaceId', () => {
  it('已有个人 Workspace 时直接复用', async () => {
    await expect(ensurePersonalNewTaskSpaceId('org-1')).resolves.toBe('ws-1')
    expect(ensureLocalWorkspaceForOrganization).not.toHaveBeenCalled()
  })

  it('个人 Workspace 缺失时恢复后重新解析', async () => {
    useSpaceStore.setState({ spaces: [], selectedSpace: null } as never)
    useSpaceListStore.setState({ selectedSpaceId: null } as never)
    useSpaceViewPrefsStore.setState({
      lastUsedWorkspaceIdByOrganization: {},
    } as never)
    ensureLocalWorkspaceForOrganization.mockImplementationOnce(async () => {
      useSpaceStore.setState({
        spaces: [{
          id: 'ws-recovered',
          name: '恢复的个人现场',
          organization_id: 'org-1',
          type: 'workspace',
          is_archived: false,
        }],
        selectedSpace: null,
      } as never)
    })

    await expect(ensurePersonalNewTaskSpaceId('org-1')).resolves.toBe('ws-recovered')
    expect(ensureLocalWorkspaceForOrganization).toHaveBeenCalledWith('org-1', { force: true })
  })
})

describe('resolveNewTaskConversationTarget', () => {
  it('个人 Agent 工作面落到当前执行工作空间', () => {
    expect(resolveNewTaskConversationTarget()).toEqual({
      spaceId: 'ws-1',
      isProjectNavActive: false,
    })
  })

  it('Project 沉浸时落到当前 Project，并标记 isProjectNavActive', () => {
    // 沉浸态 SSoT 是 app-page（openProjectPage 恒 setCurrentTab('agent')）
    useAppPageStore.setState({ activePage: 'project', activeProjectId: 'team-1' })
    useProjectWorkspaceSelectionStore.setState({ selectedProjectId: 'team-1' })

    expect(resolveNewTaskConversationTarget()).toEqual({
      spaceId: 'team-1',
      isProjectNavActive: true,
    })
  })
})

describe('ensurePersonalNewTaskSpaceId', () => {
  it('个人 Workspace 缺失时强制恢复后返回新空间', async () => {
    useSpaceStore.setState({ spaces: [], selectedSpace: null } as never)
    useSpaceListStore.setState({ selectedSpaceId: null } as never)
    ensureLocalWorkspaceForOrganization.mockImplementation(async () => {
      useSpaceStore.setState({
        spaces: [{
          id: 'restored-ws',
          name: '恢复现场',
          organization_id: 'org-1',
          type: 'workspace',
          is_archived: false,
        }],
      } as never)
    })

    await expect(ensurePersonalNewTaskSpaceId('org-1')).resolves.toBe('restored-ws')
    expect(ensureLocalWorkspaceForOrganization).toHaveBeenCalledWith(
      'org-1',
      { force: true },
    )
  })
})

describe('navigateToNewTask', () => {
  it('清旧草稿引用后进入 conversations 草稿态', () => {
    navigateToNewTask('ws-1', { isProjectNavActive: false })

    expect(useSettingsSpaceStore.getState().closeSettings).toHaveBeenCalled()
    expect(useIMStore.getState().closeIM).toHaveBeenCalled()
    expect(useSpaceListStore.getState().activateSpace).toHaveBeenCalledWith('ws-1')
    expect(useMainNavStore.getState().currentTab).toBe('agent')
    expect(useSpaceViewPrefsStore.getState().getSidebarMode('org-1', 'user-1')).toBe('conversations')
    expect(useChatStore.getState().startDraftSessionForSpace).toHaveBeenCalledWith(
      'ws-1',
      true,
      { draftScopeKey: 'conversation:draft:ws-1' },
    )
    expect(useContextInjectionStore.getState().contextRefsByScopeId['__draft__:ws-1']).toEqual([])
    expect(useChatStore.getState().setDraftExecutionSpaceForWorkspace).toHaveBeenCalledWith(
      'conversation:draft:ws-1',
      null,
    )
  })

  it('从技能库全屏页进入新任务会 closeAppPage', () => {
    useAppPageStore.setState({ activePage: 'skill', activeProjectId: null })
    navigateToNewTask('ws-1', { isProjectNavActive: false })
    expect(useAppPageStore.getState().activePage).toBeNull()
  })

  it('与侧栏新任务一致：即便从 Project 发起也回到 Agent 主导航', () => {
    const setCurrentTab = vi.fn((tab: 'agent' | 'project') => {
      useMainNavStore.setState({ currentTab: tab })
    })
    useMainNavStore.setState({ setCurrentTab: setCurrentTab as never, currentTab: 'project' })

    navigateToNewTask('team-1', { isProjectNavActive: true })

    // resolveNewTaskMainNavTab 现恒返回 agent（Project 上下文由 app-page 承载）
    expect(setCurrentTab).toHaveBeenCalledWith('agent')
    expect(useMainNavStore.getState().currentTab).toBe('agent')
  })
})

describe('openCreatedWorkspaceAsNewTask ', () => {
  it('选中成功后进入新任务草稿态', async () => {
    const ok = await openCreatedWorkspaceAsNewTask('ws-new', {
      organizationId: 'org-1',
    })

    expect(ok).toBe(true)
    expect(ensureSpaceSelectedWithFeedback).toHaveBeenCalledWith(
      'ws-new',
      expect.objectContaining({ organizationId: 'org-1' }),
    )
    expect(useSpaceListStore.getState().activateSpace).toHaveBeenCalledWith('ws-new')
    expect(useChatStore.getState().startDraftSessionForSpace).toHaveBeenCalledWith(
      'ws-new',
      true,
      { draftScopeKey: 'conversation:draft:ws-new' },
    )
  })

  it('选中失败时不进草稿', async () => {
    ensureSpaceSelectedWithFeedback.mockResolvedValueOnce(false)

    const ok = await openCreatedWorkspaceAsNewTask('ws-new')

    expect(ok).toBe(false)
    expect(useChatStore.getState().startDraftSessionForSpace).not.toHaveBeenCalled()
  })
})

describe('ensurePersonalNewTaskSpaceId', () => {
  it('解析并选中个人新任务工作空间', async () => {
    const spaceId = await ensurePersonalNewTaskSpaceId('org-1')

    expect(spaceId).toBe('ws-1')
    expect(ensureSpaceSelectedWithFeedback).toHaveBeenCalledWith(
      'ws-1',
      expect.objectContaining({ organizationId: 'org-1' }),
    )
  })

  it('选中失败时返回 null', async () => {
    ensureSpaceSelectedWithFeedback.mockResolvedValueOnce(false)

    await expect(ensurePersonalNewTaskSpaceId('org-1')).resolves.toBeNull()
  })
})
