import React from 'react'
import { ArrowDownAZ, Check, ChevronRight, Clock } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@components/ui'
import { cn } from '@utils/cn'
import {
  SIDEBAR_ICON,
  SIDEBAR_MENU_ICON_STROKE,
  SIDEBAR_SECTION_HEADER,
  SIDEBAR_SECTION_LABEL,
} from '@components/layout/sidebarUi'
import type { WorkspaceListSortMode } from '@/utils/workspace-list-sort'

export interface SessionSpaceSectionHeaderProps {
  spaceSectionTitle?: string
  count?: number
  collapsed?: boolean
  onToggleCollapse?: () => void
  showWorkspaceSortControl: boolean
  workspaceListSortMode: WorkspaceListSortMode
  setWorkspaceListSortMode: (mode: WorkspaceListSortMode) => void
  createSpaceAction?: React.ReactNode
  t: (key: string, opts?: Record<string, unknown>) => string
}

export const SessionSpaceSectionHeader: React.FC<SessionSpaceSectionHeaderProps> = ({
  spaceSectionTitle,
  count,
  collapsed = false,
  onToggleCollapse,
  showWorkspaceSortControl,
  workspaceListSortMode,
  setWorkspaceListSortMode,
  createSpaceAction,
  t,
}) => (
  <div className={cn(SIDEBAR_SECTION_HEADER, 'flex flex-shrink-0 items-center gap-1')}>
    <button
      type="button"
      className="group flex min-w-0 flex-1 cursor-pointer items-center gap-1 rounded-interactive text-left transition-colors hover:bg-foreground/[0.03] disabled:cursor-default disabled:hover:bg-transparent dark:hover:bg-foreground/[0.05]"
      onClick={onToggleCollapse}
      aria-expanded={!collapsed}
      aria-label={collapsed
        ? t('sessionList.expandSpaceSection', { defaultValue: `展开 ${spaceSectionTitle ?? '工作空间'} 分组` })
        : t('sessionList.collapseSpaceSection', { defaultValue: `收起 ${spaceSectionTitle ?? '工作空间'} 分组` })}
      title={collapsed
        ? t('sessionList.expandSpaceSection', { defaultValue: `展开 ${spaceSectionTitle ?? '工作空间'} 分组` })
        : t('sessionList.collapseSpaceSection', { defaultValue: `收起 ${spaceSectionTitle ?? '工作空间'} 分组` })}
      disabled={!onToggleCollapse}
    >
      <span className={cn(SIDEBAR_SECTION_LABEL, 'min-w-0 flex-1')}>
        {spaceSectionTitle ?? t('sessionList.spaceSectionTitle', { defaultValue: 'Spaces' })}
        {typeof count === 'number' ? (
          <span className="ml-1 font-normal text-muted-foreground/50">({count})</span>
        ) : null}
      </span>
      <ChevronRight
        className={cn(
          'h-3.5 w-3.5 shrink-0 text-muted-foreground/60 transition-transform',
          !collapsed && 'rotate-90',
        )}
        strokeWidth={SIDEBAR_MENU_ICON_STROKE}
        aria-hidden
      />
    </button>
    {showWorkspaceSortControl ? (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="shrink-0 h-5 w-5 flex items-center justify-center rounded-interactive text-muted-foreground/60 hover:bg-foreground/[0.03] hover:text-foreground transition-colors"
            title={t('sessionList.workspaceSortLabel', { defaultValue: '工作空间排序' })}
            aria-label={t('sessionList.workspaceSortLabel', { defaultValue: '工作空间排序' })}
          >
            {workspaceListSortMode === 'activity' ? (
              <Clock className={SIDEBAR_ICON} strokeWidth={SIDEBAR_MENU_ICON_STROKE} />
            ) : (
              <ArrowDownAZ className={SIDEBAR_ICON} strokeWidth={SIDEBAR_MENU_ICON_STROKE} />
            )}
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent side="bottom" align="end" className="w-44">
          {([
            {
              mode: 'name' as WorkspaceListSortMode,
              label: t('sessionList.workspaceSortByName', { defaultValue: '按名称' }),
            },
            {
              mode: 'activity' as WorkspaceListSortMode,
              label: t('sessionList.workspaceSortByActivity', { defaultValue: '按最近活跃' }),
            },
          ]).map(option => (
            <DropdownMenuItem
              key={option.mode}
              onSelect={() => setWorkspaceListSortMode(option.mode)}
              className="flex items-center justify-between gap-2"
            >
              <span>{option.label}</span>
              {workspaceListSortMode === option.mode ? (
                <Check className={SIDEBAR_ICON} strokeWidth={SIDEBAR_MENU_ICON_STROKE} />
              ) : null}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    ) : null}
    {createSpaceAction ? (
      <div className="shrink-0">
        {createSpaceAction}
      </div>
    ) : null}
  </div>
)
