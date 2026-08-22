/**
 * SpaceSidebarGlobal —— shell 第二列内容面板（上下文面板）。
 *
 * 一级导航已上移到窄栏（ActivityRail）；本组件只按当前域渲染内容：
 *   - 任务域（agent）→ 顶栏（新任务 / 技能库 / 自动化 / 导入数据）+ Workspace 会话列表
 *   - 消息域（im）→ 会话列表 + 通讯录
 *   - AI 分身域（agents）→ 分身列表 + 顶栏动作
 *   - 云文档域（cloud-docs）→ 文档/表格资源列表（SidebarCloudDocsPanel）
 *   - 项目域（project 沉浸）→ 当前 Project 头 + Project 会话列表
 *   - 我的（me）→ 设置导航（SidebarMePanel）
 *
 * 导航派发 / 未读徽标 / 激活判定全部收口在 primaryNavigation.ts，与窄栏同源。
 * 未登录时整栏被登录/注册表单接管（GuestSidebar；此时窄栏不渲染）。
 */

import React, { Activity, useCallback } from 'react'
import { cn } from '@utils/cn'
import { useTranslation } from 'react-i18next'
import { useAuthStore, selectIsAuthenticated } from '@stores/useAuthStore'
import { SidebarConversationList } from '@components/context-space/SidebarConversationList'
import { SidebarMePanel } from './SidebarMePanel'
import { SidebarIMPanel } from './SidebarIMPanel'
import { SidebarAgentsPanel } from './SidebarAgentsPanel'
import { SidebarCloudDocsPanel } from './SidebarCloudDocsPanel'
import { isCloudDocsScopeKey, parseCloudDocsScopeKey } from './cloudDocsDomain'
import { CurrentProjectHeader } from './CurrentProjectHeader'
import { SpaceSwitcherPopover } from '@components/sidebar/SpaceSwitcherPopover'
import {
  SIDEBAR_SURFACE,
  SIDEBAR_META,
  SIDEBAR_TEXT_PRIMARY,
} from './sidebarUi'
import { SidebarMenuItem } from './SidebarMenuItem'
import { usePrimaryNavigation } from './primaryNavigation'
import { SidebarTaskPrimaryNav } from './SidebarTaskPrimaryNav'
import { SHELL_SIDEBAR_PANEL_TOP_CLASS } from './shellUi'

const LazySidebarAuthInline = React.lazy(() =>
  import('@components/auth').then(m => ({ default: m.SidebarAuthInline }))
)

// 协作列表页（gallery）的第二列：项目卡片导航。lazy 隔离 2000 行的 Project 面板，
// 不进入非项目场景的加载链。
const LazyProjectSidebarContent = React.lazy(() =>
  import('./ProjectWorkspacePanel').then(m => ({ default: m.ProjectSidebarContent }))
)

// ── 未登录侧边栏（登录/注册表单） ──
//
// 未登录态：直接 inline 渲染登录 / 注册表单（不弹 Dialog），让用户在侧边栏
// 完成 auth 流程的同时，主区域始终保留产品介绍。**注意：本组件只用于未登录
// 态**——已登录但还没选 Space 的场景由 SpaceSidebarGlobal 自己处理（agent 域
// 中部显示"选个工作空间开始"占位文案）。

const GuestSidebar: React.FC = () => (
  <div className={SIDEBAR_SURFACE}>
    <React.Suspense
      fallback={
        <div className="flex-1 flex items-center justify-center">
          <span className={SIDEBAR_META}>…</span>
        </div>
      }
    >
      <LazySidebarAuthInline />
    </React.Suspense>
  </div>
)

// 已登录但无执行目标时，任务域中部的引导占位。
//
// 冷启动 / 无 Space 时，通过这里的 SpaceSwitcherPopover 让用户选择已有 Space 或新建 Space 进入。
// 一旦选中某个执行目标，任务域就切到对应 workspace 的桌面 / 对话内容。
const NoSpaceAgentPlaceholder: React.FC<{ isLoading?: boolean }> = ({ isLoading = false }) => {
  const { t } = useTranslation(['sidebar'])
  return (
    <div className={cn('flex flex-1 items-center justify-center px-5 text-center', SHELL_SIDEBAR_PANEL_TOP_CLASS)}>
      <div className="flex flex-col items-center gap-3">
        {isLoading ? (
          <span
            aria-hidden
            className="block h-5 w-5 rounded-full border-2 border-border border-t-accent animate-spin"
          />
        ) : null}
        <span className={cn(SIDEBAR_TEXT_PRIMARY, 'text-muted-foreground/80')}>
          {isLoading
            ? t('sidebar:loadingAgents', { defaultValue: '正在加载工作空间...' })
            : t('sidebar:selectAgent', { defaultValue: '选择一个工作空间开始工作' })}
        </span>
        {!isLoading ? (
          <>
            <SpaceSwitcherPopover currentSpaceId={null} side="bottom" align="center">
              <SidebarMenuItem className="mx-0 justify-center px-3" label={t('sidebar:chooseAgent', { defaultValue: '选择 / 新建工作空间' })} />
            </SpaceSwitcherPopover>
          </>
        ) : null}
      </div>
    </div>
  )
}

// ── Main Component ──

interface SpaceSidebarGlobalProps {
  executionSpaceId: string | null
  workspaceScopeKey: string | null
  isAgentListLoading?: boolean
  sidebarContentPortalRef: React.RefCallback<HTMLDivElement> | React.RefObject<HTMLDivElement | null>
  surface?: 'card' | 'embedded'
}

export function resolveSidebarSurfaceClassName(surface: 'card' | 'embedded'): string {
  return surface === 'card'
    ? SIDEBAR_SURFACE
    : 'relative flex h-full min-h-0 min-w-0 flex-col overflow-hidden no-drag bg-transparent'
}

export const SidebarActivitySurface: React.FC<{
  visible: boolean
  children: React.ReactNode
}> = ({ visible, children }) => (
  <Activity mode={visible ? 'visible' : 'hidden'}>
    {children}
  </Activity>
)

export function shouldShowPersonalTaskSidebar(input: {
  effectiveMainNavTab: ReturnType<typeof usePrimaryNavigation>['effectiveMainNavTab']
  activeAppPage: ReturnType<typeof usePrimaryNavigation>['activeAppPage']
  isProjectNavActive: boolean
}): boolean {
  const { effectiveMainNavTab, activeAppPage, isProjectNavActive } = input
  if (effectiveMainNavTab === 'me') return false
  if (effectiveMainNavTab === 'cloud-docs') return false
  if (effectiveMainNavTab === 'im') return false
  if (effectiveMainNavTab === 'agents') return false
  if (activeAppPage === 'collaboration') return false
  return !isProjectNavActive
}

export const SpaceSidebarGlobal: React.FC<SpaceSidebarGlobalProps> = ({
  executionSpaceId,
  workspaceScopeKey,
  isAgentListLoading = false,
  sidebarContentPortalRef,
  surface = 'card',
}) => {
  const isAuthenticated = useAuthStore(selectIsAuthenticated)
  const {
    effectiveMainNavTab,
    activeAppPage,
    isProjectNavActive,
    personalConversationSpaceId,
    projectConversationSpaceId,
    selectedProjectSpace,
    handlePrimaryNavigation,
    setSidebarMode,
    handleExitProject,
    activePrimaryNavId,
  } = usePrimaryNavigation({ executionSpaceId })

  const effectiveWorkspaceScopeKey =
    workspaceScopeKey ?? (personalConversationSpaceId ? `conversation:draft:${personalConversationSpaceId}` : null)
  const handleOpenConversationWorkspace = useCallback(
    () => setSidebarMode('conversations'),
    [setSidebarMode],
  )
  const handleTaskModuleNavigate = useCallback(
    (target: 'new-task' | 'automation' | 'skills' | 'import-data') =>
      handlePrimaryNavigation(target),
    [handlePrimaryNavigation],
  )

  // 未登录 → 整个侧栏被登录/注册表单接管。
  if (!isAuthenticated) {
    return <GuestSidebar />
  }

  const surfaceClassName = resolveSidebarSurfaceClassName(surface)
  const newTaskDisabled = !personalConversationSpaceId
  const cloudDocsScope = workspaceScopeKey && isCloudDocsScopeKey(workspaceScopeKey)
    ? parseCloudDocsScopeKey(workspaceScopeKey)
    : null
  const isPersonalTaskSidebarVisible = shouldShowPersonalTaskSidebar({
    effectiveMainNavTab,
    activeAppPage,
    isProjectNavActive,
  })

  const taskPrimaryNav = (
    <div className={SHELL_SIDEBAR_PANEL_TOP_CLASS}>
      <SidebarTaskPrimaryNav
        activePrimaryNavId={activePrimaryNavId}
        newTaskDisabled={newTaskDisabled}
        onNavigate={handleTaskModuleNavigate}
      />
    </div>
  )

  const agentConversationContent = (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="min-h-0 flex-1 overflow-hidden">
        {personalConversationSpaceId && effectiveWorkspaceScopeKey ? (
          <SidebarConversationList
            spaceId={personalConversationSpaceId}
            tabScopeKey={effectiveWorkspaceScopeKey}
            onOpenConversationWorkspace={handleOpenConversationWorkspace}
          />
        ) : (
          <NoSpaceAgentPlaceholder isLoading={isAgentListLoading} />
        )}
      </div>
    </div>
  )

  return (
    <div className={surfaceClassName}>
      {/* 顶部拖拽带已由 ShellTopBar（实体标题栏行）接管；全局搜索入口在顶栏居中。 */}

      {/* 应用侧栏资源树仍保持挂载，但不再混入左侧任务树。 */}
      <div ref={sidebarContentPortalRef} className="hidden" aria-hidden />

      <SidebarActivitySurface visible={isPersonalTaskSidebarVisible}>
        {taskPrimaryNav}
        <div className="flex min-h-0 flex-1 flex-col">
          {agentConversationContent}
        </div>
      </SidebarActivitySurface>

      {!isPersonalTaskSidebarVisible && (
        effectiveMainNavTab === 'me' ? (
          <div className={cn('flex flex-1 min-h-0 flex-col', SHELL_SIDEBAR_PANEL_TOP_CLASS)}>
            <SidebarMePanel />
          </div>
        ) : effectiveMainNavTab === 'cloud-docs' ? (
          <div
            className={cn('flex min-h-0 flex-1 flex-col overflow-hidden', SHELL_SIDEBAR_PANEL_TOP_CLASS)}
            data-testid="cloud-docs-sidebar"
          >
            {cloudDocsScope && workspaceScopeKey ? (
              <SidebarCloudDocsPanel
                organizationId={cloudDocsScope.organizationId}
                tabScopeKey={workspaceScopeKey}
                resourceHostSpaceId={executionSpaceId ?? personalConversationSpaceId}
              />
            ) : (
              <NoSpaceAgentPlaceholder isLoading={isAgentListLoading} />
            )}
          </div>
        ) : effectiveMainNavTab === 'im' ? (
          <div className={cn('flex flex-1 min-h-0 flex-col', SHELL_SIDEBAR_PANEL_TOP_CLASS)}>
            <SidebarIMPanel />
          </div>
        ) : effectiveMainNavTab === 'agents' ? (
          <div className={cn('flex flex-1 min-h-0 flex-col', SHELL_SIDEBAR_PANEL_TOP_CLASS)} data-testid="agents-sidebar">
            <SidebarAgentsPanel />
          </div>
        ) : activeAppPage === 'collaboration' ? (
          <div className={cn('flex min-h-0 flex-1 flex-col', SHELL_SIDEBAR_PANEL_TOP_CLASS)} data-testid="collaboration-hub-sidebar">
            <React.Suspense fallback={null}>
              <LazyProjectSidebarContent />
            </React.Suspense>
          </div>
        ) : isProjectNavActive ? (
          <div className={cn('flex min-h-0 flex-1 flex-col', SHELL_SIDEBAR_PANEL_TOP_CLASS)} data-testid="project-immersive-sidebar">
            {selectedProjectSpace ? (
              <CurrentProjectHeader
                projectName={selectedProjectSpace.name}
                onExit={handleExitProject}
              />
            ) : null}
            <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
              {projectConversationSpaceId && effectiveWorkspaceScopeKey ? (
                <SidebarConversationList
                  spaceId={projectConversationSpaceId}
                  tabScopeKey={effectiveWorkspaceScopeKey}
                  onOpenConversationWorkspace={handleOpenConversationWorkspace}
                />
              ) : (
                <NoSpaceAgentPlaceholder isLoading={isAgentListLoading} />
              )}
            </div>
          </div>
        ) : null
      )}
    </div>
  )
}

SpaceSidebarGlobal.displayName = 'SpaceSidebarGlobal'
