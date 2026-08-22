import React from 'react'
import { useTranslation } from 'react-i18next'
import type { TaskViewMode } from './taskLayoutState'
import { cn } from '@utils/cn'
import { CheckpointBrowseTrigger } from '@components/checkpoint/CheckpointBrowseTrigger'
import { SessionCollaborators } from '@components/chat/session/SessionCollaborators'
import {
  TrackerRunBreadcrumb,
  resolveTrackerRunSessionTitle,
} from '@components/chat/tracker/TrackerRunBreadcrumb'
import type { TrackerRunMeta } from '@tabtin/chat-client'
import type { Agent } from '@tabtin/app-shell'
import {
  resolveCurrentAgentDisplay,
  type AgentDisplaySource,
} from '@components/chat/model/resolveAgentDisplayName'
import { CANVAS_TEXT_MICRO } from './canvasUi'
import { SHELL_WORKBENCH_TOP_BAR_HEIGHT_CLASS } from './shellUi'
import { useSessionAccessStore } from '@/stores/chat/session/sessionAccessStore'

/**
 * 正式任务顶栏 Agent 名：与 useCurrentAgentDisplayName 同口径。
 * 禁止 `Agent ${id.slice(0,8)}` 占位。
 */
export function resolveTaskHeaderAgentName(
  sessionAgentId: string | null | undefined,
  agentCache: Record<string, Pick<Agent, 'display_name' | 'name'> | undefined | null>,
  selectedAgent?: AgentDisplaySource | null,
): string | null {
  return resolveCurrentAgentDisplay({
    sessionAgentId,
    selectedAgent,
    agentCache,
  })?.displayName ?? null
}

export interface TaskWorkspaceHeaderProps {
  scopeKey: string
  title: string
  workspaceId?: string | null
  sessionId?: string | null
  activeViewMode: TaskViewMode
  /** Tracker 执行记录会话：改标题、旁挂「查看自动化任务」、隐藏工作区快照 */
  trackerRun?: TrackerRunMeta | null
  className?: string
}

/**
 * 正式任务顶栏（ 重排）：
 * - Agent / Workspace 药丸移除——composer 底部已有同信息，顶栏不重复显示；
 * - Workspace 快照收成标题旁的 icon-only 入口（Tracker 执行记录不展示）；
 * - Tracker 执行记录：标题改为「自动化任务 "x" 的第 n 次记录」，旁挂「查看自动化任务」；
 * - 右侧改为「共享协作区」（被共享人头像叠列 + 共享入口，类文档协同）。
 */
export const TaskWorkspaceHeader: React.FC<TaskWorkspaceHeaderProps> = React.memo(({
  scopeKey: _scopeKey,
  title,
  workspaceId,
  sessionId,
  activeViewMode,
  trackerRun = null,
  className,
}) => {
  const { t } = useTranslation('chat')
  const displayTitle = trackerRun
    ? resolveTrackerRunSessionTitle(trackerRun, t)
    : (title || t('taskWorkspaceHeader.untitledTask'))
  const sharedAccess = useSessionAccessStore(state => (
    sessionId ? state.bySessionId[sessionId] ?? null : null
  ))
  const sharedSource = sharedAccess?.role === 'grantee' ? sharedAccess : null

  return (
    <header
      className={cn(
        'relative z-banner flex shrink-0 items-center gap-3 px-6 no-drag',
        SHELL_WORKBENCH_TOP_BAR_HEIGHT_CLASS,
        className,
      )}
      style={activeViewMode === 'app-focus'
        ? { paddingRight: 'calc(1.5rem + var(--task-view-mode-switch-width, 0px))' }
        : undefined}
      data-testid="task-workspace-header"
    >
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <h1 className="truncate text-subtitle font-semibold text-foreground">
          {displayTitle}
        </h1>
        {trackerRun ? (
          <TrackerRunBreadcrumb trackerRun={trackerRun} />
        ) : workspaceId ? (
          <CheckpointBrowseTrigger
            spaceId={workspaceId}
            sessionId={sessionId}
            className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-interactive text-muted-foreground transition-colors hover:bg-foreground/[0.05] hover:text-foreground no-drag"
          />
        ) : null}
      </div>
      <SessionCollaborators
        sessionId={sessionId}
        spaceId={workspaceId}
        sourceUserId={sharedSource?.ownerUserId}
        sourceDisplayName={sharedSource?.ownerDisplayName}
        sourceOrganizationId={sharedSource?.organizationId}
        className="hidden sm:flex"
      />
    </header>
  )
})

TaskWorkspaceHeader.displayName = 'TaskWorkspaceHeader'

export interface DraftTaskWorkspaceHeaderProps {
  scopeKey: string
  activeViewMode: TaskViewMode
  className?: string
}

/** 新任务预备分屏：Shell 顶栏只覆盖对话列，画板列顶对齐自身 workbench 工具栏。 */
export const DraftTaskWorkspaceHeader: React.FC<DraftTaskWorkspaceHeaderProps> = React.memo(({
  scopeKey: _scopeKey,
  activeViewMode,
  className,
}) => {
  const { t } = useTranslation('chat')

  return (
    <header
      className={cn(
        'relative z-banner flex shrink-0 items-center gap-3 px-6 no-drag',
        SHELL_WORKBENCH_TOP_BAR_HEIGHT_CLASS,
        className,
      )}
      style={activeViewMode === 'app-focus'
        ? { paddingRight: 'calc(1.5rem + var(--task-view-mode-switch-width, 0px))' }
        : undefined}
      data-testid="draft-task-workspace-header"
    >
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <h1 className="truncate text-subtitle font-semibold text-foreground">
            {t('taskWorkspaceHeader.newTask')}
          </h1>
          <span className={cn('shrink-0 rounded-full bg-muted px-2 py-0.5 text-muted-foreground', CANVAS_TEXT_MICRO)}>
            {t('taskWorkspaceHeader.draftBadge')}
          </span>
        </div>
      </div>
    </header>
  )
})

DraftTaskWorkspaceHeader.displayName = 'DraftTaskWorkspaceHeader'
