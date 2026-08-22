/**
 * FolderHeader - 文件夹头部组件
 *
 * 包含面包屑导航、刷新按钮等操作
 */

import React, { useEffect, useRef, useState } from 'react'
import {
  RefreshCw,
  FolderOpen,
  Copy,
  Check,
  ChevronRight,
  Home,
  FilePlus,
  FolderPlus,
  Search,
  PanelLeft,
  PanelLeftClose,
} from 'lucide-react'
import { Switch, toast } from '@tabtin/smartsheet-ui'
import { cn } from '@utils/cn'
import type { FolderContextKind } from './types'
import { getBaseName } from './utils'
import { copyToClipboard } from '@components/shared/file-ops'
import { useTranslation } from 'react-i18next'

/** 目录是 Git 仓库、由 `LocalDirAutoPane` 托管时透传——让用户能从普通视图重新打开 Git 流程模式。 */
export interface GitFlowSwitchProps {
  checked: boolean
  onChange: (checked: boolean) => void
}

interface FolderHeaderProps {
  rootPath: string
  kind: FolderContextKind
  title: string
  isRefreshing: boolean
  onRefresh: () => void
  onOpenInFinder?: () => void
  onStartNewFile?: () => void
  onStartNewFolder?: () => void
  onToggleSearch?: () => void
  searchActive?: boolean
  sidebarCollapsed?: boolean
  onToggleSidebar?: () => void
  className?: string
  gitFlowSwitch?: GitFlowSwitchProps
}

const PathBreadcrumb: React.FC<{
  rootPath: string
  kind: FolderContextKind
  title: string
  fallbackTitle: string
}> = ({ rootPath, kind, title, fallbackTitle }) => {
  const displayName = title || getBaseName(rootPath) || fallbackTitle

  return (
    <div className="flex items-center gap-0.5 text-caption text-muted-foreground/60 min-w-0 flex-1">
      <span className="shrink-0">
        {kind === 'sandbox' ? (
          <Home className="h-3 w-3 opacity-50" />
        ) : (
          <FolderOpen className="h-3 w-3 opacity-50" />
        )}
      </span>
      <ChevronRight className="h-2.5 w-2.5 shrink-0 opacity-40" />
      <span className="truncate font-medium text-foreground/80" title={rootPath}>
        {displayName}
      </span>
    </div>
  )
}

export const FolderHeader: React.FC<FolderHeaderProps> = ({
  rootPath,
  kind,
  title,
  isRefreshing,
  onRefresh,
  onOpenInFinder,
  onStartNewFile,
  onStartNewFolder,
  onToggleSearch,
  searchActive,
  sidebarCollapsed = false,
  onToggleSidebar,
  className,
  gitFlowSwitch,
}) => {
  const { t } = useTranslation('context')
  const [pathCopied, setPathCopied] = useState(false)
  const copyResetRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    return () => {
      if (copyResetRef.current) clearTimeout(copyResetRef.current)
    }
  }, [])

  const handleCopyPath = async () => {
    const ok = await copyToClipboard(rootPath)
    if (ok) {
      setPathCopied(true)
      toast({ title: t('folder.labels.pathCopied', { defaultValue: '路径已复制' }) })
      if (copyResetRef.current) clearTimeout(copyResetRef.current)
      copyResetRef.current = setTimeout(() => setPathCopied(false), 2000)
      return
    }
    toast({
      title: t('folder.labels.copyPathFailed', { defaultValue: '复制路径失败' }),
      variant: 'destructive',
    })
  }

  return (
    <div className={cn('px-3 py-2', className)}>
      <div className="flex items-center gap-2">
        <PathBreadcrumb
          rootPath={rootPath}
          kind={kind}
          title={title}
          fallbackTitle={t('folder.labels.defaultTitle')}
        />

        <div className="flex items-center gap-1 shrink-0">
          {onToggleSidebar && (
            <button
              type="button"
              className="rounded-md p-1.5 text-muted-foreground/60 transition-colors hover:bg-muted/40 hover:text-foreground"
              onClick={onToggleSidebar}
              title={
                sidebarCollapsed
                  ? t('folder.labels.expandSidebar', { defaultValue: '展开侧栏' })
                  : t('folder.labels.collapseSidebar', { defaultValue: '折叠侧栏' })
              }
              aria-label={
                sidebarCollapsed
                  ? t('folder.labels.expandSidebar', { defaultValue: '展开侧栏' })
                  : t('folder.labels.collapseSidebar', { defaultValue: '折叠侧栏' })
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
          {onStartNewFile && (
            <button
              type="button"
              className="p-1.5 rounded-md text-muted-foreground/60 hover:text-foreground hover:bg-muted/40 transition-colors"
              onClick={onStartNewFile}
              title={t('fileOps.newFile', { defaultValue: '新建文件' })}
            >
              <FilePlus className="h-3.5 w-3.5" />
            </button>
          )}
          {onStartNewFolder && (
            <button
              type="button"
              className="p-1.5 rounded-md text-muted-foreground/60 hover:text-foreground hover:bg-muted/40 transition-colors"
              onClick={onStartNewFolder}
              title={t('fileOps.newFolder', { defaultValue: '新建文件夹' })}
            >
              <FolderPlus className="h-3.5 w-3.5" />
            </button>
          )}
          {onToggleSearch && (
            <button
              type="button"
              className={cn(
                'p-1.5 rounded-md transition-colors',
                searchActive
                  ? 'text-primary bg-primary/10'
                  : 'text-muted-foreground/60 hover:text-foreground hover:bg-muted/40',
              )}
              onClick={onToggleSearch}
              title={t('folder.labels.search', { defaultValue: '搜索' })}
            >
              <Search className="h-3.5 w-3.5" />
            </button>
          )}
          <button
            type="button"
            className={cn(
              'p-1.5 rounded-md transition-colors active:scale-95',
              pathCopied
                ? 'text-success bg-success/10'
                : 'text-muted-foreground/60 hover:text-foreground hover:bg-muted/40 active:bg-muted/60',
            )}
            onClick={handleCopyPath}
            title={
              pathCopied
                ? t('folder.labels.pathCopied', { defaultValue: '路径已复制' })
                : t('folder.labels.copyPath')
            }
            aria-label={t('folder.labels.copyPath')}
          >
            {pathCopied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
          </button>
          {onOpenInFinder && (
            <button
              type="button"
              className="p-1.5 rounded-md text-muted-foreground/60 hover:text-foreground hover:bg-muted/40 transition-colors"
              onClick={onOpenInFinder}
              title={t('folder.labels.openInFinder')}
            >
              <FolderOpen className="h-3.5 w-3.5" />
            </button>
          )}
          <button
            type="button"
            className="p-1.5 rounded-md text-muted-foreground/60 hover:text-foreground hover:bg-muted/40 transition-colors disabled:opacity-40"
            onClick={onRefresh}
            disabled={isRefreshing}
            title={t('folder.labels.refresh')}
          >
            <RefreshCw className={cn('h-3.5 w-3.5', isRefreshing && 'animate-spin')} />
          </button>
        </div>

        {gitFlowSwitch && (
          <div
            className="ml-1 flex shrink-0 items-center gap-1.5"
            title={t('folder.labels.gitFlowModeHint')}
          >
            <span className="text-caption text-muted-foreground/80">
              {t('folder.labels.gitFlowMode')}
            </span>
            <Switch
              checked={gitFlowSwitch.checked}
              onCheckedChange={gitFlowSwitch.onChange}
              aria-label={t('folder.labels.gitFlowMode')}
            />
          </div>
        )}
      </div>
    </div>
  )
}

FolderHeader.displayName = 'FolderHeader'
