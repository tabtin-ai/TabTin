import React from 'react'
import { useTranslation } from 'react-i18next'
import {
  FilePlus,
  FolderPlus,
  ChevronsDownUp,
  RefreshCw,
  Search,
} from 'lucide-react'
import type { ViewMode } from './TabCodeToolbar'
import { cn } from '@utils/cn'
import { HOTKEYS, hotkeyLabel } from '../utils/hotkeys'

/** 侧栏图标按钮统一：6×6 点击域、交互圆角、hover 只换背景材质 */
const ICON_BUTTON =
  'flex h-6 w-6 shrink-0 items-center justify-center rounded-interactive text-muted-foreground/60 transition-colors hover:bg-muted/40 hover:text-foreground disabled:pointer-events-none disabled:opacity-40'

interface FileTreeToolbarProps {
  onOpenQuickOpen: () => void
  onNewFile: () => void
  onNewFolder: () => void
  viewMode: ViewMode
  isTreeExpanded: boolean
  onCollapseAll: () => void
  onRefresh: () => void
}

export const FileTreeToolbar: React.FC<FileTreeToolbarProps> = ({
  onOpenQuickOpen,
  onNewFile,
  onNewFolder,
  viewMode,
  isTreeExpanded,
  onCollapseAll,
  onRefresh,
}) => {
  const { t } = useTranslation('tabcode')

  return (
    <div className="flex shrink-0 flex-col gap-1 border-b border-border/30 px-2 py-1.5">
      <button
        type="button"
        onClick={onOpenQuickOpen}
        className="flex h-7 w-full items-center gap-1.5 rounded-interactive border border-transparent bg-muted/30 px-1.5 text-left text-body text-muted-foreground/60 outline-none transition-colors hover:bg-muted/50 hover:text-foreground focus:border-ring/30"
        aria-label={t('quickOpen.placeholder')}
      >
        <Search className="h-3.5 w-3.5 shrink-0" />
        <span className="min-w-0 flex-1 truncate">{t('fileTree.searchPlaceholder')}</span>
        <kbd className="shrink-0 rounded border border-border/30 bg-muted/30 px-1 py-0.5 text-caption text-muted-foreground/60">
          {hotkeyLabel(HOTKEYS.quickOpen)}
        </kbd>
      </button>

      <div className="flex items-center gap-1">
        <button
          type="button"
          className={ICON_BUTTON}
          onClick={onNewFile}
          title={t('fileOps.newFile')}
        >
          <FilePlus className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          className={ICON_BUTTON}
          onClick={onNewFolder}
          title={t('fileOps.newFolder')}
        >
          <FolderPlus className="h-3.5 w-3.5" />
        </button>

        <div className="flex-1" />

        {viewMode === 'all' && (
          <button
            type="button"
            className={cn(ICON_BUTTON, 'disabled:opacity-30')}
            onClick={onCollapseAll}
            disabled={!isTreeExpanded}
            title={t('fileTree.collapseAll')}
            aria-label={t('fileTree.collapseAll')}
          >
            <ChevronsDownUp className="h-3.5 w-3.5" />
          </button>
        )}
        <button
          type="button"
          className={ICON_BUTTON}
          onClick={onRefresh}
          title={t('toolbar.refresh')}
          aria-label={t('toolbar.refresh')}
        >
          <RefreshCw className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  )
}
