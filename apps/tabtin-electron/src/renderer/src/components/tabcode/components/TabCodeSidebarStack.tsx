/**
 * TabCode 左侧目录 / Git / 搜索标签页。
 *
 * 非激活面板仍保持挂载，避免 FileTree 的 fs:watch 因切换标签而中断，
 * 并保留搜索面板的输入与结果状态。
 */

import React, { useId } from 'react'
import { useTranslation } from 'react-i18next'
import { Files, GitCommitHorizontal, Search } from 'lucide-react'
import { cn } from '@utils/cn'
import type { TabCodeSidebarTab } from '../hooks/useTabCodeStore'

export type { TabCodeSidebarTab }

export interface TabCodeSidebarStackProps {
  fileTree: React.ReactNode
  /** 非 Git 仓库时省略，不渲染 Git 标签。 */
  gitPanel?: React.ReactNode
  searchPanel: React.ReactNode
  activeTab: TabCodeSidebarTab
  onActiveTabChange: (tab: TabCodeSidebarTab) => void
  className?: string
}

export const TabCodeSidebarStack: React.FC<TabCodeSidebarStackProps> = ({
  fileTree,
  gitPanel,
  searchPanel,
  activeTab,
  onActiveTabChange,
  className,
}) => {
  const { t } = useTranslation('tabcode')
  const tabId = useId()
  const filesTabId = `${tabId}-files-tab`
  const filesPanelId = `${tabId}-files-panel`
  const gitTabId = `${tabId}-git-tab`
  const gitPanelId = `${tabId}-git-panel`
  const searchTabId = `${tabId}-search-tab`
  const searchPanelId = `${tabId}-search-panel`
  const showGit = gitPanel != null

  return (
    <div className={cn('flex h-full min-h-0 flex-col', className)}>
      <div
        role="tablist"
        aria-label={t('sidebar.tools', '代码工具')}
        className="flex h-8 shrink-0 border-b border-border/30 px-1.5"
      >
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'files'}
          aria-controls={filesPanelId}
          id={filesTabId}
          tabIndex={activeTab === 'files' ? 0 : -1}
          onClick={() => onActiveTabChange('files')}
          className={cn(
            'relative flex min-w-0 flex-1 items-center justify-center gap-1 px-1.5 text-caption font-medium transition-colors',
            activeTab === 'files'
              ? 'text-foreground after:absolute after:inset-x-1.5 after:bottom-0 after:h-0.5 after:bg-primary'
              : 'text-muted-foreground/60 hover:text-muted-foreground/80',
          )}
        >
          <Files className="h-3.5 w-3.5 shrink-0" />
          <span className="truncate">{t('sidebar.filesSection', '目录')}</span>
        </button>
        {showGit && (
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'git'}
            aria-controls={gitPanelId}
            id={gitTabId}
            tabIndex={activeTab === 'git' ? 0 : -1}
            onClick={() => onActiveTabChange('git')}
            className={cn(
              'relative flex min-w-0 flex-1 items-center justify-center gap-1 px-1.5 text-caption font-medium transition-colors',
              activeTab === 'git'
                ? 'text-foreground after:absolute after:inset-x-1.5 after:bottom-0 after:h-0.5 after:bg-primary'
                : 'text-muted-foreground/60 hover:text-muted-foreground/80',
            )}
          >
            <GitCommitHorizontal className="h-3.5 w-3.5 shrink-0" />
            <span className="truncate">{t('sidebar.gitSection', 'Git')}</span>
          </button>
        )}
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'search'}
          aria-controls={searchPanelId}
          id={searchTabId}
          tabIndex={activeTab === 'search' ? 0 : -1}
          onClick={() => onActiveTabChange('search')}
          className={cn(
            'relative flex min-w-0 flex-1 items-center justify-center gap-1 px-1.5 text-caption font-medium transition-colors',
            activeTab === 'search'
              ? 'text-foreground after:absolute after:inset-x-1.5 after:bottom-0 after:h-0.5 after:bg-primary'
              : 'text-muted-foreground/60 hover:text-muted-foreground/80',
          )}
        >
          <Search className="h-3.5 w-3.5 shrink-0" />
          <span className="truncate">{t('sidebar.searchSection', '搜索')}</span>
        </button>
      </div>

      <div
        id={filesPanelId}
        role="tabpanel"
        aria-labelledby={filesTabId}
        hidden={activeTab !== 'files'}
        className="min-h-0 flex-1 overflow-hidden"
      >
        {fileTree}
      </div>
      {showGit && (
        <div
          id={gitPanelId}
          role="tabpanel"
          aria-labelledby={gitTabId}
          hidden={activeTab !== 'git'}
          className="min-h-0 flex-1 overflow-hidden"
        >
          {gitPanel}
        </div>
      )}
      <div
        id={searchPanelId}
        role="tabpanel"
        aria-labelledby={searchTabId}
        hidden={activeTab !== 'search'}
        className="min-h-0 flex-1 overflow-hidden"
      >
        {searchPanel}
      </div>
    </div>
  )
}

export default TabCodeSidebarStack
