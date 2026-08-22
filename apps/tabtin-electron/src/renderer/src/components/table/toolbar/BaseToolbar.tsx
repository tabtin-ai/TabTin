import React, { useState } from 'react'
import { RefreshCw, Undo2, Redo2, Search, History } from 'lucide-react'
import {
  Button,
  Separator,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
  cn,
  Input,
} from '@tabtin/smartsheet-ui'
import { useTranslation } from 'react-i18next'
import { useUndoRedoContext } from '@components/view/UndoRedoContext'

const isMac =
  typeof navigator !== 'undefined' && /Mac|iPod|iPhone|iPad/.test(navigator.userAgent)
const MOD_KEY = isMac ? '⌘' : 'Ctrl+'

function ToolbarTooltip({
  content,
  children,
}: {
  content: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="inline-flex">{children}</span>
        </TooltipTrigger>
        <TooltipContent>{content}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

export interface BaseToolbarProps {
  onRefresh?: () => void | Promise<void>
  /** 搜索回调；不传则不显示搜索框 */
  onSearch?: (query: string) => void
  searchQuery?: string
  searchPlaceholder?: string
  /** 搜索功能暂未就绪时显示的提示 */
  searchDisabledHint?: string
  /** 打开表格级版本历史 */
  onOpenTableHistory?: () => void
  /** 只读模式：禁用撤销/重做等写操作 */
  isReadonly?: boolean
  children?: React.ReactNode
  className?: string
}

export const BaseToolbar: React.FC<BaseToolbarProps> = ({
  onRefresh,
  onSearch,
  searchQuery = '',
  searchPlaceholder,
  searchDisabledHint,
  onOpenTableHistory,
  isReadonly = false,
  children,
  className,
}) => {
  const { t } = useTranslation('table')
  const undoRedo = useUndoRedoContext()
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const [localSearch, setLocalSearch] = useState(searchQuery)

  const handleRefresh = async () => {
    if (!onRefresh || isRefreshing) return
    setIsRefreshing(true)
    try {
      await onRefresh()
    } finally {
      setIsRefreshing(false)
    }
  }

  const handleSearchChange = (value: string) => {
    setLocalSearch(value)
    onSearch?.(value)
  }

  const handleSearchToggle = () => {
    if (searchOpen) {
      setSearchOpen(false)
      setLocalSearch('')
      onSearch?.('')
    } else {
      setSearchOpen(true)
    }
  }

  return (
    <div className={cn('border-b border-border/60 bg-background', className)}>
      <div className="flex h-8 items-center gap-1.5 px-2 sm:px-3 md:px-3">
        <div className="min-w-0 flex-1 overflow-hidden">
          {children}
        </div>

        <div className="flex shrink-0 items-center gap-1">
          {/* 搜索 */}
          {onSearch ? (
            searchOpen ? (
              <Input
                autoFocus
                value={localSearch}
                onChange={e => handleSearchChange(e.target.value)}
                placeholder={searchPlaceholder ?? String(t('toolbar.searchPlaceholder'))}
                className="h-7 w-40 text-body"
                onKeyDown={e => {
                  if (e.key === 'Escape') handleSearchToggle()
                }}
              />
            ) : (
              <ToolbarTooltip content={String(t('toolbar.search'))}>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={handleSearchToggle}
                  className="h-7 px-2"
                >
                  <Search className="h-3.5 w-3.5" />
                </Button>
              </ToolbarTooltip>
            )
          ) : searchDisabledHint ? (
            <ToolbarTooltip content={searchDisabledHint}>
              <Button
                variant="ghost"
                size="sm"
                disabled
                className="h-7 px-2 opacity-50"
              >
                <Search className="h-3.5 w-3.5" />
              </Button>
            </ToolbarTooltip>
          ) : null}

          {onRefresh && (
            <>
              <Separator orientation="vertical" className="mx-0.5 h-4" />
              <ToolbarTooltip content={String(t('toolbar.refresh'))}>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={isRefreshing}
                  onClick={() => void handleRefresh()}
                  className="h-7 px-2"
                >
                  <RefreshCw className={cn('h-3.5 w-3.5', isRefreshing && 'animate-spin')} />
                </Button>
              </ToolbarTooltip>
            </>
          )}

          {undoRedo && !isReadonly && (
            <>
              <Separator orientation="vertical" className="mx-0.5 h-4" />
              <ToolbarTooltip content={`${String(t('toolbar.undo'))} (${MOD_KEY}Z)`}>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => void undoRedo.handleUndo()}
                  disabled={!undoRedo.canUndo || undoRedo.isUndoing}
                  className="h-7 px-2"
                >
                  <Undo2 className="h-3.5 w-3.5" />
                </Button>
              </ToolbarTooltip>

              <ToolbarTooltip
                content={`${String(t('toolbar.redo'))} (${MOD_KEY}${isMac ? '⇧Z' : 'Y'})`}
              >
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => void undoRedo.handleRedo()}
                  disabled={!undoRedo.canRedo || undoRedo.isRedoing}
                  className="h-7 px-2"
                >
                  <Redo2 className="h-3.5 w-3.5" />
                </Button>
              </ToolbarTooltip>
            </>
          )}

          {onOpenTableHistory && (
            <>
              <Separator orientation="vertical" className="mx-0.5 h-4" />
              <ToolbarTooltip content={String(t('toolbar.tableHistory'))}>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={onOpenTableHistory}
                  className="h-7 px-2"
                >
                  <History className="h-3.5 w-3.5" />
                </Button>
              </ToolbarTooltip>
            </>
          )}

        </div>
      </div>
    </div>
  )
}
