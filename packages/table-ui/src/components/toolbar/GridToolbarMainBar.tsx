import React, { useState } from 'react'
import { ListPlus, SquarePlus, Trash2, RefreshCw, Undo2, Redo2, History, Share2, Send, Pencil } from 'lucide-react'
import { Button, Separator, Tooltip, TooltipContent, TooltipProvider, TooltipTrigger, cn } from '@tabtin/smartsheet-ui'
import { GridToolbarMoreMenu } from './GridToolbarMoreMenu'
import { GridToolbarSearchButton } from './GridToolbarSearchButton'
import type { ToolbarField } from '../../types'
import type { DataGridSearchScope } from '../grid/DataGridContext'
import { calculateVisibleRightActionCount } from './toolbarLayout'

export { calculateVisibleRightActionCount } from './toolbarLayout'

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

export interface GridToolbarMainBarProps {
  fields: ToolbarField[]
  canDetailEdit: boolean
  hasSelectedRows: boolean
  tableFontStyle: string
  tableFontWeight: string
  tableFontSize: number
  searchQuery: string
  searchScope: DataGridSearchScope
  searchSelectedFieldIds: string[]
  searchHideNotMatchRows: boolean
  searchMatchCount: number
  searchCurrentMatchIndex: number
  searchCurrentField: string | null
  searchTargetId?: string
  searchLimitReached?: boolean
  searchIndexSupported: boolean
  searchIndexEnabled: boolean
  searchIndexAbnormalCount: number
  searchIndexLoading: boolean
  searchIndexActionLoading: boolean
  totalRowsCount?: number
  translate: (key: string, options?: Record<string, unknown>) => string
  onSearch: (query: string) => void
  onSearchScopeChange: (scope: DataGridSearchScope) => void
  onSearchSelectedFieldIdsChange: (fieldIds: string[]) => void
  onSearchHideNotMatchRowsChange: (value: boolean) => void
  onSearchIndexToggle?: (enabled: boolean) => void
  onSearchIndexRepair?: () => void
  onSearchNavigateNext?: () => void
  onSearchNavigatePrev?: () => void
  onAddRow: () => void
  onAddField: () => void
  onRefresh: () => void | Promise<void>
  onDeleteSelected: () => void
  onOpenDetailEdit?: () => void
  onShowFieldManagement?: () => void
  onShowExportDialog?: () => void
  onShowImportDialog?: () => void
  onFontStyleChange?: (value: string) => void
  onFontWeightChange?: (value: string) => void
  onFontSizeChange?: (value: number | string) => void
  canUndo?: boolean
  canRedo?: boolean
  isUndoing?: boolean
  isRedoing?: boolean
  onUndo?: () => void | Promise<void>
  onRedo?: () => void | Promise<void>
  onOpenTableHistory?: () => void
  isReadonly?: boolean
  /** Grid-only record/field creation controls. Non-grid hosts hide them. */
  showCreateActions?: boolean
  /**
   * Slot for the filter/sort/group bar.
   * Each host (Electron / Web) provides its own implementation.
   */
  filterGroupBar?: React.ReactNode
  onShare?: () => void
  /** 发送到私信：与 canShare 解耦，viewer 也可用。 */
  onSendToIM?: () => void
  /**
   * 仅查看角色申请编辑：宿主在 viewer/commenter 时注入；
   * 与 isReadonly（含 collab 临时只读）解耦，避免误显。
   */
  onRequestEditAccess?: () => void
  /**
   * D10: 是否能看见分享按钮——通常 owner/admin 为 true。
   * 缺省 false：即使 onShare 提供，按钮也不显示。
   */
  canShare?: boolean
}

export const GridToolbarMainBar: React.FC<GridToolbarMainBarProps> = ({
  fields,
  canDetailEdit,
  hasSelectedRows,
  searchQuery,
  searchScope,
  searchSelectedFieldIds,
  searchHideNotMatchRows,
  searchMatchCount,
  searchCurrentMatchIndex,
  searchCurrentField,
  searchTargetId,
  searchLimitReached,
  searchIndexSupported,
  searchIndexEnabled,
  searchIndexAbnormalCount,
  searchIndexLoading,
  searchIndexActionLoading,
  totalRowsCount,
  translate,
  onSearch,
  onSearchScopeChange,
  onSearchSelectedFieldIdsChange,
  onSearchHideNotMatchRowsChange,
  onSearchIndexToggle,
  onSearchIndexRepair,
  onSearchNavigateNext,
  onSearchNavigatePrev,
  onAddRow,
  onAddField,
  onRefresh,
  onDeleteSelected,
  onOpenDetailEdit,
  onShowFieldManagement,
  onShowExportDialog,
  onShowImportDialog,
  canUndo = false,
  canRedo = false,
  isUndoing = false,
  isRedoing = false,
  onUndo,
  onRedo,
  onOpenTableHistory,
  isReadonly = false,
  showCreateActions = true,
  filterGroupBar,
  onShare,
  onSendToIM,
  onRequestEditAccess,
  canShare = false,
}) => {
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [searchExpanded, setSearchExpanded] = useState(Boolean(searchQuery))
  const toolbarBodyRef = React.useRef<HTMLDivElement>(null)
  const [visibleRightActionCount, setVisibleRightActionCount] = useState(0)
  const addRecordLabel = translate('table:toolbar.addRecord')
  const addFieldLabel = translate('table:toolbar.addField')
  const isMac =
    typeof navigator !== 'undefined' && /Mac|iPod|iPhone|iPad/.test(navigator.userAgent)
  const modKey = isMac ? '⌘' : 'Ctrl+'
  const rightActions = React.useMemo(
    () => [
      { key: 'refresh', present: true },
      { key: 'undo', present: Boolean(onUndo) },
      { key: 'redo', present: Boolean(onRedo) },
      { key: 'tableHistory', present: Boolean(onOpenTableHistory) },
      { key: 'deleteSelected', present: hasSelectedRows && !isReadonly },
      { key: 'share', present: canShare && Boolean(onShare) },
      { key: 'sendToIM', present: Boolean(onSendToIM) },
      { key: 'requestEditAccess', present: Boolean(onRequestEditAccess) },
    ],
    [
      canShare,
      hasSelectedRows,
      isReadonly,
      onOpenTableHistory,
      onRedo,
      onRequestEditAccess,
      onSendToIM,
      onShare,
      onUndo,
    ],
  )
  const presentRightActions = React.useMemo(
    () => rightActions.filter(action => action.present),
    [rightActions],
  )

  React.useEffect(() => {
    const root = toolbarBodyRef.current
    if (!root || typeof ResizeObserver === 'undefined') {
      return
    }

    const updateVisibleActions = (width: number) => {
      setVisibleRightActionCount(
        calculateVisibleRightActionCount(width, presentRightActions.length, searchExpanded),
      )
    }

    updateVisibleActions(root.getBoundingClientRect().width)
    const observer = new ResizeObserver(entries => {
      const entry = entries[0]
      if (!entry) return
      updateVisibleActions(entry.contentRect.width)
    })
    observer.observe(root)

    return () => observer.disconnect()
  }, [presentRightActions.length, searchExpanded])

  const visibleRightActionKeys = React.useMemo(
    () => new Set(presentRightActions.slice(0, visibleRightActionCount).map(action => action.key)),
    [presentRightActions, visibleRightActionCount],
  )
  const showRefreshInMain = visibleRightActionKeys.has('refresh')
  const showUndoInMain = visibleRightActionKeys.has('undo')
  const showRedoInMain = visibleRightActionKeys.has('redo')
  const showTableHistoryInMain = visibleRightActionKeys.has('tableHistory')
  const showDeleteSelectedInMain = visibleRightActionKeys.has('deleteSelected')
  const showShareInMain = visibleRightActionKeys.has('share')
  const showSendToIMInMain = visibleRightActionKeys.has('sendToIM')
  const showRequestEditAccessInMain = visibleRightActionKeys.has('requestEditAccess')

  return (
    <div
      className="flex h-10 items-center gap-1 px-1 py-1 sm:px-2 md:px-3"
      data-grid-toolbar-main=""
    >
      {!isReadonly && showCreateActions && (
        <ToolbarTooltip content={addRecordLabel}>
          <Button
            variant="ghost"
            size="sm"
            aria-label={addRecordLabel}
            onClick={onAddRow}
            className="h-7 gap-1.5 px-2 text-muted-foreground hover:text-foreground"
          >
            <ListPlus className="h-3.5 w-3.5" />
            <span className="hidden text-body @[560px]/table-toolbar:inline">
              {addRecordLabel}
            </span>
          </Button>
        </ToolbarTooltip>
      )}

      {!isReadonly && showCreateActions && (
        <ToolbarTooltip content={addFieldLabel}>
          <Button
            variant="ghost"
            size="sm"
            aria-label={addFieldLabel}
            onClick={onAddField}
            className="h-7 gap-1.5 px-2 text-muted-foreground hover:text-foreground"
          >
            <SquarePlus className="h-3.5 w-3.5" />
            <span className="hidden text-body @[560px]/table-toolbar:inline">
              {addFieldLabel}
            </span>
          </Button>
        </ToolbarTooltip>
      )}

      {!isReadonly && showCreateActions && (
        <Separator orientation="vertical" className="mx-1 h-4" />
      )}

      <div
        ref={toolbarBodyRef}
        className="flex min-w-0 flex-1 items-center justify-between gap-2 @container/table-toolbar"
      >
        <div
          className={cn(
            'min-w-0 flex-1 overflow-x-auto overflow-y-hidden [scrollbar-width:none] [&::-webkit-scrollbar]:hidden',
            filterGroupBar && '@[560px]/table-toolbar:min-w-56',
          )}
        >
          <div className="w-max min-w-full">{filterGroupBar}</div>
        </div>

        <div className="flex min-w-0 max-w-full items-center gap-1">
          <GridToolbarSearchButton
            searchTargetId={searchTargetId}
            value={searchQuery}
            fields={fields}
            onSearch={onSearch}
            placeholder={translate('table:toolbar.searchPlaceholder')}
            activateLabel={translate('table:toolbar.search')}
            scope={searchScope}
            selectedFieldIds={searchSelectedFieldIds}
            hideNotMatchRows={searchHideNotMatchRows}
            scopeAllFieldsLabel={translate('table:toolbar.searchScopeAllFields')}
            scopeCurrentFieldLabel={translate('table:toolbar.searchScopeFieldSearch')}
            selectedFieldsCountLabel={translate('table:toolbar.searchSelectedFieldsCount')}
            selectFieldsTitle={translate('table:toolbar.searchSelectFieldsTitle')}
            showAllRowsLabel={translate('table:toolbar.searchShowAllRows')}
            hideNotMatchRowsLabel={translate('table:toolbar.searchHideNotMatchRows')}
            navigatePrevLabel={translate('table:toolbar.searchPrev')}
            navigateNextLabel={translate('table:toolbar.searchNext')}
            closeSearchLabel={translate('table:toolbar.searchClose')}
            searchIndexTitle={translate('table:toolbar.searchIndexTitle')}
            searchIndexCheckingLabel={translate('table:toolbar.searchIndexChecking')}
            searchIndexEnableLabel={translate('table:toolbar.searchIndexEnable')}
            searchIndexDisableLabel={translate('table:toolbar.searchIndexDisable')}
            searchIndexRepairLabel={translate('table:toolbar.searchIndexRepair')}
            searchIndexRepairHintLabel={translate('table:toolbar.searchIndexRepairHint')}
            searchIndexUnsupportedLabel={translate('table:toolbar.searchIndexUnsupported')}
            searchIndexStatusEnabledLabel={translate('table:toolbar.searchIndexStatusEnabled')}
            searchIndexStatusDisabledLabel={translate('table:toolbar.searchIndexStatusDisabled')}
            searchIndexSupported={searchIndexSupported}
            searchIndexEnabled={searchIndexEnabled}
            searchIndexAbnormalCount={searchIndexAbnormalCount}
            searchIndexLoading={searchIndexLoading}
            searchIndexActionLoading={searchIndexActionLoading}
            currentFieldLabel={searchCurrentField}
            matchCount={searchMatchCount}
            currentMatchIndex={searchCurrentMatchIndex}
            searchLimitReached={searchLimitReached}
            searchLimitWarning={translate('table:toolbar.searchLimitWarning')}
            onScopeChange={onSearchScopeChange}
            onSelectedFieldIdsChange={onSearchSelectedFieldIdsChange}
            onHideNotMatchRowsChange={onSearchHideNotMatchRowsChange}
            onSearchIndexToggle={onSearchIndexToggle}
            onSearchIndexRepair={onSearchIndexRepair}
            totalRowsCount={totalRowsCount}
            searchIndexSuggestionLabel={translate('table:toolbar.searchIndexSuggestion', { count: totalRowsCount ?? 0 })}
            searchIndexSuggestionEnableLabel={translate('table:toolbar.searchIndexSuggestionEnable')}
            searchIndexSuggestionDismissLabel={translate('table:toolbar.searchIndexSuggestionDismiss')}
            onNavigateNext={onSearchNavigateNext}
            onNavigatePrev={onSearchNavigatePrev}
            onActiveChange={setSearchExpanded}
          />

          <Separator
            orientation="vertical"
            className={cn('mx-1 h-4', !showRefreshInMain && 'hidden')}
          />

          {showRefreshInMain && (
            <ToolbarTooltip content={translate('table:toolbar.refresh')}>
              <Button
                variant="ghost"
                size="sm"
                disabled={isRefreshing}
                onClick={async () => {
                  setIsRefreshing(true)
                  try {
                    await onRefresh()
                  } finally {
                    setIsRefreshing(false)
                  }
                }}
                className="h-7 px-2"
              >
                <RefreshCw className={cn("h-3.5 w-3.5", isRefreshing && "animate-spin")} />
              </Button>
            </ToolbarTooltip>
          )}

          {onUndo && showUndoInMain && (
              <ToolbarTooltip content={`${translate('table:toolbar.undo')} (${modKey}Z)`}>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => void onUndo()}
                  disabled={!canUndo || isUndoing}
                  className="h-7 px-2"
                >
                  <Undo2 className="h-3.5 w-3.5" />
                </Button>
              </ToolbarTooltip>
          )}

          {onRedo && showRedoInMain && (
              <ToolbarTooltip content={`${translate('table:toolbar.redo')} (${modKey}${isMac ? '⇧Z' : 'Y'})`}>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => void onRedo()}
                  disabled={!canRedo || isRedoing}
                  className="h-7 px-2"
                >
                  <Redo2 className="h-3.5 w-3.5" />
                </Button>
              </ToolbarTooltip>
          )}

          {onOpenTableHistory && showTableHistoryInMain && (
              <ToolbarTooltip content={translate('table:toolbar.tableHistory')}>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={onOpenTableHistory}
                  className="h-7 px-2"
                >
                  <History className="h-3.5 w-3.5" />
                </Button>
              </ToolbarTooltip>
          )}

          {hasSelectedRows && !isReadonly && showDeleteSelectedInMain && (
            <Button
              variant="ghost"
              size="sm"
              onClick={onDeleteSelected}
              className="h-7 gap-1.5 px-2 text-destructive hover:bg-destructive/10 hover:text-destructive"
            >
              <Trash2 className="h-3.5 w-3.5" />
              <span className="hidden text-body @[820px]/table-toolbar:inline">
                {translate('table:toolbar.delete')}
              </span>
            </Button>
          )}

          {canShare && onShare && showShareInMain && (
            <>
              <Separator orientation="vertical" className="mx-1 h-4" />
                <ToolbarTooltip content={translate('table:toolbar.share', { defaultValue: '分享' })}>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={onShare}
                    className="h-7 px-2"
                  >
                    <Share2 className="h-3.5 w-3.5" />
                  </Button>
                </ToolbarTooltip>
            </>
          )}

          {onSendToIM && showSendToIMInMain && (
            <ToolbarTooltip content={translate('table:toolbar.sendToIM', { defaultValue: '发送到私信' })}>
              <Button
                variant="ghost"
                size="sm"
                onClick={onSendToIM}
                className="h-7 px-2"
                aria-label={translate('table:toolbar.sendToIM', { defaultValue: '发送到私信' })}
              >
                <Send className="h-3.5 w-3.5" />
              </Button>
            </ToolbarTooltip>
          )}

          {onRequestEditAccess && showRequestEditAccessInMain && (
            <ToolbarTooltip
              content={translate('table:toolbar.requestEditAccess', { defaultValue: '申请编辑权限' })}
            >
              <Button
                variant="ghost"
                size="sm"
                onClick={onRequestEditAccess}
                className="h-7 px-2 text-primary hover:bg-primary/10 hover:text-primary"
                aria-label={translate('table:toolbar.requestEditAccess', { defaultValue: '申请编辑权限' })}
              >
                <Pencil className="h-3.5 w-3.5" />
              </Button>
            </ToolbarTooltip>
          )}

          <Separator orientation="vertical" className="mx-1 h-4" />
          <GridToolbarMoreMenu
            manageFieldsText={translate('table:toolbar.manageFields')}
            exportText={translate('table:toolbar.export')}
            importText={translate('table:toolbar.import')}
            detailEditText={translate('table:toolbar.detailEdit')}
            canDetailEdit={canDetailEdit}
            onOpenDetailEdit={onOpenDetailEdit}
            onShowFieldManagement={isReadonly ? undefined : onShowFieldManagement}
            onShowExportDialog={onShowExportDialog}
            onShowImportDialog={onShowImportDialog}
            refreshText={translate('table:toolbar.refresh')}
            undoText={translate('table:toolbar.undo')}
            redoText={translate('table:toolbar.redo')}
            tableHistoryText={translate('table:toolbar.tableHistory')}
            deleteSelectedText={translate('table:toolbar.delete')}
            shareText={translate('table:toolbar.share', { defaultValue: '分享' })}
            sendToIMText={translate('table:toolbar.sendToIM', { defaultValue: '发送到私信' })}
            requestEditAccessText={translate('table:toolbar.requestEditAccess', {
              defaultValue: '申请编辑权限',
            })}
            onRefresh={async () => {
              setIsRefreshing(true)
              try {
                await onRefresh()
              } finally {
                setIsRefreshing(false)
              }
            }}
            onUndo={onUndo}
            onRedo={onRedo}
            onOpenTableHistory={onOpenTableHistory}
            onDeleteSelected={onDeleteSelected}
            onShare={onShare}
            onSendToIM={onSendToIM}
            onRequestEditAccess={onRequestEditAccess}
            canUndo={canUndo}
            canRedo={canRedo}
            isUndoing={isUndoing}
            isRedoing={isRedoing}
            isRefreshing={isRefreshing}
            hasSelectedRows={hasSelectedRows}
            isReadonly={isReadonly}
            canShare={canShare}
            showRefreshInMenu={!showRefreshInMain}
            showUndoInMenu={Boolean(onUndo) && !showUndoInMain}
            showRedoInMenu={Boolean(onRedo) && !showRedoInMain}
            showTableHistoryInMenu={Boolean(onOpenTableHistory) && !showTableHistoryInMain}
            showDeleteSelectedInMenu={hasSelectedRows && !isReadonly && !showDeleteSelectedInMain}
            showShareInMenu={canShare && Boolean(onShare) && !showShareInMain}
            showSendToIMInMenu={Boolean(onSendToIM) && !showSendToIMInMain}
            showRequestEditAccessInMenu={
              Boolean(onRequestEditAccess) && !showRequestEditAccessInMain
            }
          />
        </div>
      </div>
    </div>
  )
}
