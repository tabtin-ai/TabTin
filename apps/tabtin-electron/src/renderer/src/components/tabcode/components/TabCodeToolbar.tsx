/**
 * TabCode 顶栏（遗留）
 *
 * 主路径已改为整面板通栏底栏 `TabCodeStatusBar`，本组件不再挂载。
 * 仍导出 `ViewMode` / `GitFlowSwitchProps` 供文件树与 LocalDirAutoPane 使用。
 */

import React from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowDown, PanelLeftClose, PanelLeft } from 'lucide-react'
import { Switch } from '@tabtin/smartsheet-ui'
import type { GitBranchMeta } from '@shared/git-types'

export type ViewMode = 'all' | 'changes' | 'unstaged' | 'staged'

/** 目录是 Git 仓库时，让用户随时关掉「Git 流程模式」切回普通文件浏览视图。 */
export interface GitFlowSwitchProps {
  checked: boolean
  onChange: (checked: boolean) => void
}

interface TabCodeToolbarProps {
  branch: string | null
  branchMeta?: GitBranchMeta
  diffStat: { files: number; insertions: number; deletions: number } | null
  isGitRepo: boolean
  onOpenBranchOperations?: () => void
  sidebarCollapsed?: boolean
  onToggleSidebar?: () => void
  gitFlowSwitch?: GitFlowSwitchProps
  /** ：当前浏览的 rootPath 是否为 linked worktree（非主工作树）。 */
  isLinkedWorktree?: boolean
}

export const TabCodeToolbar: React.FC<TabCodeToolbarProps> = ({
  branch,
  branchMeta,
  diffStat,
  isGitRepo,
  onOpenBranchOperations,
  sidebarCollapsed = false,
  onToggleSidebar,
  gitFlowSwitch,
  isLinkedWorktree = false,
}) => {
  const { t } = useTranslation('tabcode')

  return (
    <div className="flex items-center gap-1 px-2 py-1 @container/tabcode-toolbar">
      <div className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden">
        {onToggleSidebar && (
          <button
            type="button"
            className="rounded p-1 text-muted-foreground/60 transition-colors hover:bg-muted/40 hover:text-foreground"
            onClick={onToggleSidebar}
            title={
              sidebarCollapsed
                ? t('toolbar.expandSidebar')
                : t('toolbar.collapseSidebar')
            }
            aria-label={
              sidebarCollapsed
                ? t('toolbar.expandSidebar')
                : t('toolbar.collapseSidebar')
            }
            aria-pressed={sidebarCollapsed}
          >
            {sidebarCollapsed ? (
              <PanelLeft className="h-3.5 w-3.5" />
            ) : (
              <PanelLeftClose className="h-3.5 w-3.5" />
            )}
          </button>
        )}

        {isGitRepo && (
          <>
            {diffStat && diffStat.files > 0 && (
              <span
                className="shrink-0 whitespace-nowrap text-caption text-muted-foreground/80 tabular-nums"
                title={t('toolbar.filesChanged')}
              >
                <span className="font-medium text-foreground/80">{diffStat.files}</span>
                <span className="mx-0.5 hidden @[280px]:inline">{t('toolbar.filesChanged')}</span>
                {diffStat.insertions > 0 && (
                  <span className="text-success/80">+{diffStat.insertions}</span>
                )}
                {diffStat.deletions > 0 && (
                  <span className="ml-0.5 text-destructive/80">-{diffStat.deletions}</span>
                )}
              </span>
            )}

            {branch && (
              <button
                type="button"
                className="inline-flex min-w-0 shrink items-center gap-1 rounded-full bg-muted/30 px-1.5 py-px text-caption text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
                onClick={onOpenBranchOperations}
                title={t('toolbar.switchBranch')}
                aria-label={t('toolbar.switchBranch')}
              >
                <span className="max-w-[100px] truncate @[320px]:max-w-[240px]" title={branch}>
                  {branch}
                </span>
                {branchMeta && branchMeta.behind > 0 && (
                  <span
                    className="flex items-center gap-0.5 text-warning"
                    title={t('toolbar.behindUpstream', { count: branchMeta.behind })}
                  >
                    <ArrowDown className="h-2.5 w-2.5" />
                    <span className="text-caption tabular-nums">{branchMeta.behind}</span>
                  </span>
                )}
              </button>
            )}

            {isLinkedWorktree && (
              <span
                className="hidden shrink-0 whitespace-nowrap rounded-full bg-muted/30 px-1.5 py-px text-caption text-muted-foreground/80 @[360px]:inline"
                title={t('toolbar.linkedWorktreeIndicator')}
              >
                {t('toolbar.linkedWorktreeIndicator')}
              </span>
            )}
          </>
        )}

        {gitFlowSwitch && (
          <div
            className="ml-auto flex shrink-0 items-center gap-1"
            title={t('toolbar.gitFlowModeHint')}
          >
            <span className="hidden text-caption text-muted-foreground/80 @[320px]:inline">
              {t('toolbar.gitFlowMode')}
            </span>
            <Switch
              checked={gitFlowSwitch.checked}
              onCheckedChange={gitFlowSwitch.onChange}
              aria-label={t('toolbar.gitFlowMode')}
            />
          </div>
        )}
      </div>
    </div>
  )
}
