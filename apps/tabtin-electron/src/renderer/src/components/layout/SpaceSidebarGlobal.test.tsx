import React, { useRef } from 'react'
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import {
  SidebarActivitySurface,
  resolveSidebarSurfaceClassName,
  shouldShowPersonalTaskSidebar,
} from './SpaceSidebarGlobal'
import { resetNewTaskDraftUi } from './resetNewTaskDraftUi'
import {
  resolveActivePrimaryNavId,
  resolveEffectiveMainNavTab,
  resolveLastOpenedConversationId,
  resolveMessagesNavigationPlan,
  resolveNewTaskMainNavTab,
  resolveProjectDesktopExecutionSpaceId,
  resolveSelectedProjectSpace,
  showAppsHome,
} from './primaryNavigation'
import { resolveActivityRailActive, resolveVisibleRailDomainIds } from './ActivityRail'
import { useCanvasLayoutStore } from '@stores/useCanvasLayoutStore'
import { useSpaceContextTabsStore } from '@stores/useSpaceContextTabsStore'
import { useSpaceViewPrefsStore } from '@stores/useSpaceViewPrefsStore'
import { useWorkbenchSurfaceStore } from '@stores/useWorkbenchSurfaceStore'
import { useSpaceActivity } from './SpaceActivityContext'

describe('sidebar surface consistency', () => {
  it('card 模式保留 p-2；embedded 无外层 padding，行级 mx-1.5 承担内间距', () => {
    expect(resolveSidebarSurfaceClassName('card')).toContain('p-2')
    expect(resolveSidebarSurfaceClassName('embedded')).not.toContain('p-2')
    expect(resolveSidebarSurfaceClassName('embedded')).toContain('bg-transparent')
  })
})

describe('SidebarActivitySurface', () => {
  const isHiddenByDisplayNone = (element: HTMLElement): boolean => {
    let current: HTMLElement | null = element
    while (current) {
      if (current.style.display === 'none') return true
      current = current.parentElement
    }
    return false
  }

  const PersistentPanel: React.FC = () => {
    const mountToken = useRef(Symbol('sidebar-mount'))
    const { isForeground } = useSpaceActivity()
    return (
      <div
        data-testid="persistent-sidebar"
        data-is-foreground={String(isForeground)}
      >
        {String(mountToken.current)}
      </div>
    )
  }

  it('从其他域回到任务首页时保持侧栏实例和虚拟器前台语义', () => {
    const { rerender } = render(
      <SidebarActivitySurface visible>
        <PersistentPanel />
      </SidebarActivitySurface>,
    )
    const initialPanel = screen.getByTestId('persistent-sidebar')
    expect(initialPanel.getAttribute('data-is-foreground')).toBe('true')

    rerender(
      <SidebarActivitySurface visible={false}>
        <PersistentPanel />
      </SidebarActivitySurface>,
    )
    expect(isHiddenByDisplayNone(initialPanel)).toBe(true)
    expect(initialPanel.getAttribute('data-is-foreground')).toBe('true')

    rerender(
      <SidebarActivitySurface visible>
        <PersistentPanel />
      </SidebarActivitySurface>,
    )

    expect(screen.getByTestId('persistent-sidebar')).toBe(initialPanel)
    expect(isHiddenByDisplayNone(initialPanel)).toBe(false)
    expect(initialPanel.getAttribute('data-is-foreground')).toBe('true')
  })
})

describe('shouldShowPersonalTaskSidebar', () => {
  it('只在个人任务域展示长期会话侧栏', () => {
    expect(shouldShowPersonalTaskSidebar({
      effectiveMainNavTab: 'agent',
      activeAppPage: null,
      isProjectNavActive: false,
    })).toBe(true)

    expect(shouldShowPersonalTaskSidebar({
      effectiveMainNavTab: 'agent',
      activeAppPage: 'automation',
      isProjectNavActive: false,
    })).toBe(true)

    for (const effectiveMainNavTab of ['me', 'cloud-docs', 'im', 'agents'] as const) {
      expect(shouldShowPersonalTaskSidebar({
        effectiveMainNavTab,
        activeAppPage: null,
        isProjectNavActive: false,
      })).toBe(false)
    }

    expect(shouldShowPersonalTaskSidebar({
      effectiveMainNavTab: 'agent',
      activeAppPage: 'collaboration',
      isProjectNavActive: false,
    })).toBe(false)
    expect(shouldShowPersonalTaskSidebar({
      effectiveMainNavTab: 'agent',
      activeAppPage: 'project',
      isProjectNavActive: true,
    })).toBe(false)
  })
})

describe('SpaceSidebarGlobal project desktop handoff', () => {
  const spaces = [
    {
      id: 'team-space-1',
      name: 'Launch Plan',
      organization_id: 'wt-1',
      type: 'team_space',
      execution_space_id: null,
      is_archived: false,
    },
    {
      id: 'project-workspace-1',
      name: 'Launch 工作空间',
      organization_id: 'wt-1',
      type: 'workspace',
      project_id: 'team-space-1',
      is_archived: false,
    },
  ]

  it('从Project 项目页切桌面时，使用Project 对应的工作空间', () => {
    const executionSpaceId = resolveProjectDesktopExecutionSpaceId({
      mode: 'desktop',
      isProjectNavActive: true,
      selectedProjectId: 'team-space-1',
      organizationId: 'wt-1',
      spaces,
    })

    expect(executionSpaceId).toBe('project-workspace-1')
  })

  it('非项目页或非桌面模式不触发执行 Space handoff', () => {
    expect(resolveProjectDesktopExecutionSpaceId({
      mode: 'conversations',
      isProjectNavActive: true,
      selectedProjectId: 'team-space-1',
      organizationId: 'wt-1',
      spaces,
    })).toBe(null)

    expect(resolveProjectDesktopExecutionSpaceId({
      mode: 'desktop',
      isProjectNavActive: false,
      selectedProjectId: 'team-space-1',
      organizationId: 'wt-1',
      spaces,
    })).toBe(null)
  })

  it('没有 organization 或执行绑定时不跨团队 fallback', () => {
    expect(resolveProjectDesktopExecutionSpaceId({
      mode: 'desktop',
      isProjectNavActive: true,
      selectedProjectId: 'team-space-1',
      organizationId: null,
      spaces,
    })).toBe(null)

    expect(resolveProjectDesktopExecutionSpaceId({
      mode: 'desktop',
      isProjectNavActive: true,
      selectedProjectId: 'team-space-2',
      organizationId: 'wt-1',
      spaces: [
        {
          id: 'team-space-2',
          organization_id: 'wt-1',
          type: 'team_space',
          execution_space_id: null,
          is_archived: false,
        },
      ],
    })).toBe(null)
  })
})

describe('resolveLastOpenedConversationId', () => {
  const conversations = [
    { id: 'conv-a', organization_id: 'org-a' },
    { id: 'conv-b', organization_id: 'org-b' },
  ]

  it('只恢复当前 organization 最近打开且仍存在的会话', () => {
    expect(resolveLastOpenedConversationId({
      organizationId: 'org-a',
      lastOpenedConversationIdByOrganization: { 'org-a': 'conv-a', 'org-b': 'conv-b' },
      conversations,
    })).toBe('conv-a')

    expect(resolveLastOpenedConversationId({
      organizationId: 'org-a',
      lastOpenedConversationIdByOrganization: { 'org-a': 'conv-b' },
      conversations,
    })).toBe(null)

    expect(resolveLastOpenedConversationId({
      organizationId: 'org-a',
      lastOpenedConversationIdByOrganization: { 'org-a': 'deleted-conv' },
      conversations,
    })).toBe(null)
  })
})

describe('resolveMessagesNavigationPlan', () => {
  const conversations = [
    { id: 'conv-a', organization_id: 'org-a' },
  ]

  it('当前已有会话时优先 activateConversation', () => {
    expect(resolveMessagesNavigationPlan({
      organizationId: 'org-a',
      currentConversationId: 'conv-a',
      lastOpenedConversationIdByOrganization: {},
      conversations,
    })).toEqual({ action: 'activate-conversation', conversationId: 'conv-a' })
  })

  it('无当前会话时回退到组织记忆的上次会话', () => {
    expect(resolveMessagesNavigationPlan({
      organizationId: 'org-a',
      currentConversationId: null,
      lastOpenedConversationIdByOrganization: { 'org-a': 'conv-a' },
      conversations,
    })).toEqual({ action: 'activate-conversation', conversationId: 'conv-a' })
  })

  it('无可恢复会话时落 empty-inbox（只钉消息 tab）', () => {
    expect(resolveMessagesNavigationPlan({
      organizationId: 'org-a',
      currentConversationId: null,
      lastOpenedConversationIdByOrganization: {},
      conversations,
    })).toEqual({ action: 'empty-inbox' })
  })
})

describe('resolveEffectiveMainNavTab', () => {
  it('Projects 关闭时把 Project / 协作残留 tab 回退到 Agent', () => {
    expect(resolveEffectiveMainNavTab({
      mainNavTab: 'project',
      projectsEnabled: false,
    })).toBe('agent')

    expect(resolveEffectiveMainNavTab({
      mainNavTab: 'collaboration',
      projectsEnabled: false,
    })).toBe('agent')
  })

  it('开关打开或非协作 tab 时保留原 tab', () => {
    expect(resolveEffectiveMainNavTab({
      mainNavTab: 'im',
      projectsEnabled: false,
    })).toBe('im')

    expect(resolveEffectiveMainNavTab({
      mainNavTab: 'collaboration',
      projectsEnabled: true,
    })).toBe('collaboration')

    expect(resolveEffectiveMainNavTab({
      mainNavTab: 'me',
      projectsEnabled: false,
    })).toBe('me')
  })
})

describe('resolveVisibleRailDomainIds', () => {
  it('Projects 关闭时只隐藏项目域，任务 / 消息 / AI 分身仍在', () => {
    const ids = resolveVisibleRailDomainIds({ projectsEnabled: false })
    expect(ids).not.toContain('projects')
    expect(ids).toEqual(['tasks', 'messages', 'agents', 'cloud-docs'])
  })

  it('Projects 打开时五大域齐全', () => {
    expect(resolveVisibleRailDomainIds({ projectsEnabled: true }))
      .toEqual(['tasks', 'messages', 'agents', 'cloud-docs', 'projects'])
  })
})

describe('resolveActivityRailActive', () => {
  it('app-page 归并到域粒度：协作/Project 沉浸 → 项目；AI 分身 → agents 域；自动化/技能 → 任务', () => {
    expect(resolveActivityRailActive({
      effectiveMainNavTab: 'agent',
      activeAppPage: 'collaboration',
    })).toBe('projects')
    expect(resolveActivityRailActive({
      effectiveMainNavTab: 'agent',
      activeAppPage: 'project',
    })).toBe('projects')
    expect(resolveActivityRailActive({
      effectiveMainNavTab: 'agents',
      activeAppPage: null,
    })).toBe('agents')
    for (const page of ['skill', 'automation'] as const) {
      expect(resolveActivityRailActive({
        effectiveMainNavTab: 'agent',
        activeAppPage: page,
      })).toBe('tasks')
    }
  })

  it('设置态最优先：按 category 高亮组织/个人头像，而非残留 app-page', () => {
    expect(resolveActivityRailActive({
      effectiveMainNavTab: 'me',
      activeAppPage: 'skill',
      settingsCategory: 'organization',
    })).toBe('organization')
    expect(resolveActivityRailActive({
      effectiveMainNavTab: 'me',
      activeAppPage: 'skill',
      settingsCategory: 'profile',
    })).toBe('profile')
    expect(resolveActivityRailActive({
      effectiveMainNavTab: 'me',
      activeAppPage: 'automation',
      settingsCategory: 'device',
    })).toBeNull()
  })

  it('无 app-page 时按一级 tab 归域：me→设置锚点、im→消息、agents→AI 分身、agent（含工作台）→任务', () => {
    expect(resolveActivityRailActive({
      effectiveMainNavTab: 'me',
      activeAppPage: null,
      settingsCategory: 'profile',
    })).toBe('profile')
    expect(resolveActivityRailActive({
      effectiveMainNavTab: 'im',
      activeAppPage: null,
    })).toBe('messages')
    expect(resolveActivityRailActive({
      effectiveMainNavTab: 'cloud-docs',
      activeAppPage: null,
    })).toBe('cloud-docs')
    expect(resolveActivityRailActive({
      effectiveMainNavTab: 'agents',
      activeAppPage: null,
    })).toBe('agents')
    // 工作台（desktop）是任务域的一个工作面：agent 态恒归任务域。
    expect(resolveActivityRailActive({
      effectiveMainNavTab: 'agent',
      activeAppPage: null,
    })).toBe('tasks')
  })
})

describe('resolveNewTaskMainNavTab', () => {
  it('Project 内发起新任务时仍回到 Agent 工作面（Project 上下文由 app-page 承载）', () => {
    expect(resolveNewTaskMainNavTab(true)).toBe('agent')
  })

  it('个人 Space 发起新任务时进入 Agent 工作面', () => {
    expect(resolveNewTaskMainNavTab(false)).toBe('agent')
  })
})

describe('resolveSelectedProjectSpace', () => {
  const spaces = [
    {
      id: 'team-space-1',
      name: '上山',
      organization_id: 'org-1',
      type: 'team_space',
      is_archived: false,
    },
    {
      id: 'team-space-2',
      name: '海边',
      organization_id: 'org-1',
      type: 'team_space',
      is_archived: false,
    },
    {
      id: 'workspace-1',
      name: '个人现场',
      organization_id: 'org-1',
      type: 'workspace',
      is_archived: false,
    },
  ]

  it('仅在 Project 导航激活时解析当前项目', () => {
    expect(resolveSelectedProjectSpace({
      isProjectNavActive: false,
      selectedProjectId: 'team-space-1',
      organizationId: 'org-1',
      spaces,
    })).toBeNull()
  })

  it('优先选中 selectedProjectId，否则回退组织内第一个 Project', () => {
    expect(resolveSelectedProjectSpace({
      isProjectNavActive: true,
      selectedProjectId: 'team-space-2',
      organizationId: 'org-1',
      spaces,
    })?.id).toBe('team-space-2')

    expect(resolveSelectedProjectSpace({
      isProjectNavActive: true,
      selectedProjectId: null,
      organizationId: 'org-1',
      spaces,
    })).toMatchObject({ id: 'team-space-1', name: '上山' })
  })
})

describe('resolveActivePrimaryNavId', () => {
  it.each(['agent', 'project'] as const)(
    '%s 中的零消息新任务都保持一级入口选中',
    (effectiveMainNavTab) => {
      expect(resolveActivePrimaryNavId({
        effectiveMainNavTab,
        isProjectNavActive: effectiveMainNavTab === 'project',
        effectiveActiveModuleTab: 'conversations',
        isNewTaskWelcomeActive: true,
      })).toBe('new-task')
    },
  )

  it('正式任务不冒充新任务；desktop 归任务域，不在更多菜单高亮', () => {
    expect(resolveActivePrimaryNavId({
      effectiveMainNavTab: 'agent',
      isProjectNavActive: false,
      effectiveActiveModuleTab: 'conversations',
      isNewTaskWelcomeActive: false,
    })).toBeNull()
    expect(resolveActivePrimaryNavId({
      effectiveMainNavTab: 'agent',
      isProjectNavActive: false,
      effectiveActiveModuleTab: 'desktop',
      isNewTaskWelcomeActive: false,
    })).toBeNull()
  })

  it('agents 域打开时高亮 agents，且压过 app-page 残留', () => {
    expect(resolveActivePrimaryNavId({
      effectiveMainNavTab: 'agents',
      isProjectNavActive: false,
      effectiveActiveModuleTab: 'conversations',
      isNewTaskWelcomeActive: true,
    })).toBe('agents')
  })

  it('app-page 打开 skill/automation 时高亮对应任务域次级入口', () => {
    expect(resolveActivePrimaryNavId({
      effectiveMainNavTab: 'agent',
      isProjectNavActive: false,
      effectiveActiveModuleTab: 'conversations',
      isNewTaskWelcomeActive: true,
      activeAppPage: 'skill',
    })).toBe('skills')
  })

  it('关掉 skill/automation 全屏页后，若仍是新任务欢迎态则高亮新任务', () => {
    expect(resolveActivePrimaryNavId({
      effectiveMainNavTab: 'agent',
      isProjectNavActive: false,
      effectiveActiveModuleTab: 'conversations',
      isNewTaskWelcomeActive: true,
      activeAppPage: null,
    })).toBe('new-task')
  })

  it('app-page 打开 automation / collaboration 时高亮对应主导航', () => {
    expect(resolveActivePrimaryNavId({
      effectiveMainNavTab: 'agent',
      isProjectNavActive: false,
      effectiveActiveModuleTab: 'conversations',
      isNewTaskWelcomeActive: false,
      activeAppPage: 'automation',
    })).toBe('automation')
    expect(resolveActivePrimaryNavId({
      effectiveMainNavTab: 'agent',
      isProjectNavActive: false,
      effectiveActiveModuleTab: 'conversations',
      isNewTaskWelcomeActive: false,
      activeAppPage: 'import',
    })).toBe('import-data')
    expect(resolveActivePrimaryNavId({
      effectiveMainNavTab: 'agent',
      isProjectNavActive: false,
      effectiveActiveModuleTab: 'conversations',
      isNewTaskWelcomeActive: false,
      activeAppPage: 'external-archives',
    })).toBe('external-history')
    expect(resolveActivePrimaryNavId({
      effectiveMainNavTab: 'agent',
      isProjectNavActive: false,
      effectiveActiveModuleTab: 'conversations',
      isNewTaskWelcomeActive: false,
      activeAppPage: 'collaboration',
    })).toBe('collaboration')
  })
})

describe('primary navigation workspace reset', () => {
  it('点击应用只回到应用首页，不删除桌面已有标签', () => {
    const scopeKey = 'desktop:organization:org-1:user:user-1'
    useSpaceContextTabsStore.setState(state => ({
      activeKeyBySpace: { ...state.activeKeyBySpace, [scopeKey]: 'tabdata:table-1' },
      tabOrderBySpace: { ...state.tabOrderBySpace, [scopeKey]: ['tabdata:table-1'] },
      itemsBySpace: {
        ...state.itemsBySpace,
        [scopeKey]: {
          'tabdata:table-1': {
            type: 'tabdata',
            id: 'table-1',
            tabKey: 'tabdata:table-1',
            title: '表格',
          },
        },
      },
    }))

    showAppsHome(scopeKey)

    expect(useSpaceContextTabsStore.getState().activeKeyBySpace[scopeKey]).toBeNull()
    expect(useSpaceContextTabsStore.getState().itemsBySpace[scopeKey]?.['tabdata:table-1']).toBeTruthy()
    expect(useWorkbenchSurfaceStore.getState().lastActiveSurfaceBySpace[scopeKey]).toBe('desktop')
    useSpaceContextTabsStore.getState().clearSpaceTabs(scopeKey)
  })

  it('点击新任务清空旧草稿的标签、分屏和三态，不影响正式任务', () => {
    const draftScopeKey = 'conversation:draft:space-1'
    const sessionScopeKey = 'conversation:session-1'
    useSpaceContextTabsStore.setState(state => ({
      activeKeyBySpace: {
        ...state.activeKeyBySpace,
        [draftScopeKey]: 'tabdoc:doc-draft',
        [sessionScopeKey]: 'tabdoc:doc-session',
      },
      tabOrderBySpace: {
        ...state.tabOrderBySpace,
        [draftScopeKey]: ['tabdoc:doc-draft'],
        [sessionScopeKey]: ['tabdoc:doc-session'],
      },
      itemsBySpace: {
        ...state.itemsBySpace,
        [draftScopeKey]: {
          'tabdoc:doc-draft': {
            type: 'tabdoc',
            id: 'doc-draft',
            tabKey: 'tabdoc:doc-draft',
            title: '草稿文档',
          },
        },
      },
    }))
    useCanvasLayoutStore.setState(state => ({
      spaceGroups: {
        ...state.spaceGroups,
        [draftScopeKey]: [{ id: 'group-1', panes: [] }],
      },
    }) as never)
    useSpaceViewPrefsStore.setState(state => ({
      taskViewModeByScopeKey: {
        ...state.taskViewModeByScopeKey,
        [draftScopeKey]: 'app-focus',
        [sessionScopeKey]: 'split',
      },
      canvasCollapsedByScopeKey: {
        ...state.canvasCollapsedByScopeKey,
        [draftScopeKey]: false,
      },
    }))

    resetNewTaskDraftUi('space-1')

    expect(useSpaceContextTabsStore.getState().itemsBySpace[draftScopeKey]).toBeUndefined()
    expect(useCanvasLayoutStore.getState().spaceGroups[draftScopeKey]).toBeUndefined()
    expect(useSpaceViewPrefsStore.getState().taskViewModeByScopeKey[draftScopeKey]).toBeUndefined()
    expect(useSpaceViewPrefsStore.getState().taskViewModeByScopeKey[sessionScopeKey]).toBe('split')
    expect(useWorkbenchSurfaceStore.getState().lastActiveSurfaceBySpace[draftScopeKey]).toBe('desktop')

    useSpaceContextTabsStore.getState().clearSpaceTabs(sessionScopeKey)
    useSpaceViewPrefsStore.getState().clearTaskViewModeForScope(sessionScopeKey)
  })
})
