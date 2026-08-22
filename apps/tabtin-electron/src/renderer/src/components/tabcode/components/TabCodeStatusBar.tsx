/**
 * TabCode 整面板通栏底栏：展开/收起侧栏、分支、远端同步、Worktree、视图切换。
 * 替代原顶栏 Toolbar；跨侧栏与内容区全宽，侧栏折叠时仍可见并可展开。
 * Fetch / Pull / Push 在分支旁同步菜单中，不再放在 Git 标签顶栏。
 */

import React, { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@tabtin/smartsheet-ui'
import {
  ArrowDown,
  ArrowUp,
  Diff,
  GitBranch,
  History,
  Loader2,
  MoreHorizontal,
  PanelLeft,
  PanelLeftClose,
  RefreshCw,
} from 'lucide-react'
import type { GitBranchMeta } from '@shared/git-types'
import { cn } from '@utils/cn'
import {
  canPushBranch,
  getPushDisabledReasonKey,
} from './git-workflow/gitRemoteSync'

const ICON_ACTION =
  'flex h-6 w-6 shrink-0 items-center justify-center rounded-interactive text-muted-foreground/60 transition-colors hover:bg-muted/40 hover:text-foreground disabled:opacity-40'

export interface TabCodeStatusBarProps {
  isGitRepo: boolean
  branch: string | null
  branchMeta?: GitBranchMeta
  isLinkedWorktree?: boolean
  sidebarCollapsed?: boolean
  onOpenBranchOperations?: () => void
  onFetch?: () => void
  onPull?: () => void
  onPush?: () => void
  /** 底栏同步菜单进行中的动作：fetch / pull / push */
  syncActionKey?: string | null
  onOpenWorktree?: () => void
  /** 打开完整 Changes 审阅面；统计与 Changes「当前变更」同口径。 */
  onOpenChanges?: () => void
  changeStats?: { insertions: number; deletions: number } | null
  onOpenHistory?: () => void
  onToggleSidebar?: () => void
  /** 方案 A：切到普通文件浏览（关掉代码工作台） */
  onSwitchToFileBrowser?: () => void
  className?: string
}

export const TabCodeStatusBar: React.FC<TabCodeStatusBarProps> = ({
  isGitRepo,
  branch,
  branchMeta,
  isLinkedWorktree = false,
  sidebarCollapsed = false,
  onOpenBranchOperations,
  onFetch,
  onPull,
  onPush,
  syncActionKey = null,
  onOpenWorktree,
  onOpenChanges,
  changeStats,
  onOpenHistory,
  onToggleSidebar,
  onSwitchToFileBrowser,
  className,
}) => {
  const { t } = useTranslation('tabcode')

  const sidebarToggleLabel = sidebarCollapsed
    ? t('toolbar.expandSidebar')
    : t('toolbar.collapseSidebar')

  const pushDisabledReason = useMemo(() => {
    if (!branchMeta) return null
    const key = getPushDisabledReasonKey(branchMeta)
    if (!key) return null
    if (key === 'gitFlow.pushDisabledBehind') {
      return t(key, { count: branchMeta.behind })
    }
    return t(key)
  }, [branchMeta, t])

  const canPush = branchMeta ? canPushBranch(branchMeta) : false
  const showSyncMenu = Boolean(isGitRepo && branch && (onFetch || onPull || onPush))
  const isSyncing = Boolean(syncActionKey)

  return (
    <div
      className={cn(
        'flex min-w-0 shrink-0 items-center gap-1.5 px-2 py-1 @container/tabcode-statusbar',
        className,
      )}
    >
      {onToggleSidebar && (
        <button
          type="button"
          className={ICON_ACTION}
          onClick={onToggleSidebar}
          title={sidebarToggleLabel}
          aria-label={sidebarToggleLabel}
          aria-pressed={sidebarCollapsed}
        >
          {sidebarCollapsed ? (
            <PanelLeft className="h-3.5 w-3.5" />
          ) : (
            <PanelLeftClose className="h-3.5 w-3.5" />
          )}
        </button>
      )}

      {isGitRepo && branch && (
        <button
          type="button"
          className="inline-flex min-w-0 max-w-[240px] items-center gap-1.5 rounded-full bg-muted/30 px-2 py-0.5 text-caption text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground @[480px]:max-w-[360px] @[720px]:max-w-[480px]"
          onClick={onOpenBranchOperations}
          title={branch}
          aria-label={t('toolbar.switchBranch')}
        >
          <GitBranch className="h-3 w-3 shrink-0" />
          <span className="min-w-0 truncate font-medium text-foreground/80">
            {branch}
          </span>
          {branchMeta && branchMeta.ahead > 0 && (
            <span
              className="flex shrink-0 items-center gap-0.5 tabular-nums"
              title={t('gitFlow.aheadUpstream', { count: branchMeta.ahead })}
            >
              <ArrowUp className="h-2.5 w-2.5" />
              {branchMeta.ahead}
            </span>
          )}
          {branchMeta && branchMeta.behind > 0 && (
            <span
              className="flex shrink-0 items-center gap-0.5 text-warning tabular-nums"
              title={t('toolbar.behindUpstream', { count: branchMeta.behind })}
            >
              <ArrowDown className="h-2.5 w-2.5" />
              {branchMeta.behind}
            </span>
          )}
        </button>
      )}

      {showSyncMenu && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className={ICON_ACTION}
              disabled={isSyncing}
              title={t('gitFlow.syncStatus')}
              aria-label={t('gitFlow.syncStatus')}
              aria-busy={isSyncing}
            >
              {isSyncing ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <RefreshCw className="h-3.5 w-3.5" />
              )}
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="min-w-[140px]">
            {onFetch && (
              <DropdownMenuItem
                disabled={isSyncing}
                onSelect={() => onFetch()}
              >
                {syncActionKey === 'fetch' ? (
                  <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                ) : null}
                {t('gitFlow.fetch')}
              </DropdownMenuItem>
            )}
            {onPull && (
              <DropdownMenuItem
                disabled={isSyncing}
                onSelect={() => onPull()}
              >
                {syncActionKey === 'pull' ? (
                  <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                ) : null}
                {t('gitFlow.pull')}
              </DropdownMenuItem>
            )}
            {onPush && (
              <DropdownMenuItem
                disabled={isSyncing || !canPush}
                title={pushDisabledReason ?? undefined}
                onSelect={() => {
                  if (isSyncing || !canPush) return
                  onPush()
                }}
              >
                {syncActionKey === 'push' ? (
                  <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                ) : null}
                {t('gitFlow.push')}
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      )}

      {isGitRepo && isLinkedWorktree && (
        <span
          className="hidden shrink-0 whitespace-nowrap rounded-full bg-muted/30 px-1.5 py-px text-caption text-muted-foreground/80 @[360px]:inline"
          title={t('toolbar.linkedWorktreeIndicator')}
        >
          {t('toolbar.linkedWorktreeIndicator')}
        </span>
      )}

      <span className="flex-1" />

      {isGitRepo && onOpenChanges && (
        <button
          type="button"
          className="flex h-6 shrink-0 items-center gap-1 rounded-interactive px-1.5 text-caption text-muted-foreground/80 transition-colors hover:bg-muted/40 hover:text-foreground"
          onClick={onOpenChanges}
          title={t('toolbar.openChanges')}
          aria-label={t('toolbar.openChanges')}
        >
          <Diff className="h-3.5 w-3.5" />
          <span>{t('toolbar.changes')}</span>
          {changeStats && changeStats.insertions > 0 && (
            <span className="tabular-nums text-success/80">
              +{changeStats.insertions}
            </span>
          )}
          {changeStats && changeStats.deletions > 0 && (
            <span className="tabular-nums text-destructive/80">
              -{changeStats.deletions}
            </span>
          )}
        </button>
      )}

      {isGitRepo && onOpenHistory && (
        <button
          type="button"
          className="flex h-6 shrink-0 items-center gap-1 rounded-interactive px-1.5 text-caption text-muted-foreground/80 transition-colors hover:bg-muted/40 hover:text-foreground"
          onClick={onOpenHistory}
          title={t('toolbar.gitHistory')}
          aria-label={t('toolbar.gitHistory')}
        >
          <History className="h-3.5 w-3.5" />
          <span className="hidden @[320px]:inline">{t('toolbar.gitHistory')}</span>
        </button>
      )}

      {isGitRepo && onOpenWorktree && (
        <button
          type="button"
          className="flex h-6 shrink-0 items-center gap-1 rounded-interactive px-1.5 text-caption text-muted-foreground/80 transition-colors hover:bg-muted/40 hover:text-foreground"
          onClick={onOpenWorktree}
          title={t('gitFlow.worktreePanel')}
          aria-label={t('gitFlow.worktreePanel')}
        >
          <GitBranch className="h-3.5 w-3.5" />
          <span className="hidden @[320px]:inline">{t('gitFlow.worktreePanel')}</span>
        </button>
      )}

      {onSwitchToFileBrowser && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className={ICON_ACTION}
              title={t('toolbar.moreActions')}
              aria-label={t('toolbar.moreActions')}
            >
              <MoreHorizontal className="h-3.5 w-3.5" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-[160px]">
            <DropdownMenuItem onSelect={() => onSwitchToFileBrowser()}>
              {t('toolbar.switchToFileBrowser')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  )
}

export default TabCodeStatusBar
