import { useRef } from 'react'
import type React from 'react'
import {
  Code2,
  FileInput,
  History,
  MoreHorizontal,
  Pencil,
  Redo2,
  RefreshCw,
  Settings,
  Share2,
  Send,
  Trash2,
  Undo2,
  Upload,
} from 'lucide-react'
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@tabtin/smartsheet-ui'

export interface GridToolbarMoreMenuProps {
  manageFieldsText: string
  exportText: string
  importText?: string
  apiInfoText?: string
  detailEditText?: string
  canDetailEdit?: boolean
  onShowFieldManagement?: () => void
  onShowExportDialog?: () => void
  onShowImportDialog?: () => void
  onOpenApiInfo?: () => void
  onOpenDetailEdit?: () => void
  refreshText?: string
  undoText?: string
  redoText?: string
  tableHistoryText?: string
  deleteSelectedText?: string
  shareText?: string
  sendToIMText?: string
  requestEditAccessText?: string
  onRefresh?: () => void | Promise<void>
  onUndo?: () => void | Promise<void>
  onRedo?: () => void | Promise<void>
  onOpenTableHistory?: () => void
  onDeleteSelected?: () => void
  onShare?: () => void
  onSendToIM?: () => void
  onRequestEditAccess?: () => void
  canUndo?: boolean
  canRedo?: boolean
  isUndoing?: boolean
  isRedoing?: boolean
  isRefreshing?: boolean
  hasSelectedRows?: boolean
  isReadonly?: boolean
  canShare?: boolean
  showRefreshInMenu?: boolean
  showUndoInMenu?: boolean
  showRedoInMenu?: boolean
  showTableHistoryInMenu?: boolean
  showDeleteSelectedInMenu?: boolean
  showShareInMenu?: boolean
  showSendToIMInMenu?: boolean
  showRequestEditAccessInMenu?: boolean
}

export const GridToolbarMoreMenu: React.FC<GridToolbarMoreMenuProps> = ({
  manageFieldsText,
  exportText,
  importText,
  apiInfoText,
  detailEditText,
  canDetailEdit = false,
  onShowFieldManagement,
  onShowExportDialog,
  onShowImportDialog,
  onOpenApiInfo,
  onOpenDetailEdit,
  refreshText,
  undoText,
  redoText,
  tableHistoryText,
  deleteSelectedText,
  shareText,
  sendToIMText,
  requestEditAccessText,
  onRefresh,
  onUndo,
  onRedo,
  onOpenTableHistory,
  onDeleteSelected,
  onShare,
  onSendToIM,
  onRequestEditAccess,
  canUndo = false,
  canRedo = false,
  isUndoing = false,
  isRedoing = false,
  isRefreshing = false,
  hasSelectedRows = false,
  isReadonly = false,
  canShare = false,
  showRefreshInMenu = false,
  showUndoInMenu = false,
  showRedoInMenu = false,
  showTableHistoryInMenu = false,
  showDeleteSelectedInMenu = false,
  showShareInMenu = false,
  showSendToIMInMenu = false,
  showRequestEditAccessInMenu = false,
}) => {
  const skipCloseAutoFocusRef = useRef(false)
  const clearSkipCloseAutoFocusTimerRef = useRef<number | null>(null)

  const openAfterMenuClose = (callback?: () => void) => {
    if (!callback) return
    skipCloseAutoFocusRef.current = true
    if (clearSkipCloseAutoFocusTimerRef.current) {
      window.clearTimeout(clearSkipCloseAutoFocusTimerRef.current)
    }
    window.setTimeout(callback, 0)
    clearSkipCloseAutoFocusTimerRef.current = window.setTimeout(() => {
      skipCloseAutoFocusRef.current = false
      clearSkipCloseAutoFocusTimerRef.current = null
    }, 500)
  }

  const showDetailEditItem =
    Boolean(onOpenDetailEdit) && canDetailEdit && Boolean(detailEditText)
  const showApiInfoItem =
    Boolean(onOpenApiInfo) && Boolean(apiInfoText)
  const showResponsiveActions =
    showRefreshInMenu ||
    showUndoInMenu ||
    showRedoInMenu ||
    showTableHistoryInMenu ||
    showDeleteSelectedInMenu ||
    showShareInMenu ||
    showSendToIMInMenu ||
    showRequestEditAccessInMenu

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" className="h-8 px-3">
          <MoreHorizontal className="h-3.5 w-3.5" />
        </Button>
      </DropdownMenuTrigger>

      <DropdownMenuContent
        align="end"
        sideOffset={4}
        onCloseAutoFocus={(event) => {
          if (!skipCloseAutoFocusRef.current) return
          event.preventDefault()
        }}
      >
        {showRefreshInMenu && onRefresh && refreshText && (
          <DropdownMenuItem
            disabled={isRefreshing}
            onSelect={() => void onRefresh()}
          >
            <RefreshCw className="h-4 w-4" />
            <span>{refreshText}</span>
          </DropdownMenuItem>
        )}

        {showUndoInMenu && onUndo && undoText && (
          <DropdownMenuItem
            disabled={!canUndo || isUndoing}
            onSelect={() => void onUndo()}
          >
            <Undo2 className="h-4 w-4" />
            <span>{undoText}</span>
          </DropdownMenuItem>
        )}

        {showRedoInMenu && onRedo && redoText && (
          <DropdownMenuItem
            disabled={!canRedo || isRedoing}
            onSelect={() => void onRedo()}
          >
            <Redo2 className="h-4 w-4" />
            <span>{redoText}</span>
          </DropdownMenuItem>
        )}

        {showTableHistoryInMenu && onOpenTableHistory && tableHistoryText && (
          <DropdownMenuItem
            onSelect={onOpenTableHistory}
          >
            <History className="h-4 w-4" />
            <span>{tableHistoryText}</span>
          </DropdownMenuItem>
        )}

        {showDeleteSelectedInMenu && hasSelectedRows && !isReadonly && onDeleteSelected && deleteSelectedText && (
          <DropdownMenuItem
            className="text-destructive focus:text-destructive"
            onSelect={onDeleteSelected}
          >
            <Trash2 className="h-4 w-4" />
            <span>{deleteSelectedText}</span>
          </DropdownMenuItem>
        )}

        {showShareInMenu && canShare && onShare && shareText && (
          <DropdownMenuItem
            onSelect={onShare}
          >
            <Share2 className="h-4 w-4" />
            <span>{shareText}</span>
          </DropdownMenuItem>
        )}

        {showSendToIMInMenu && onSendToIM && sendToIMText && (
          <DropdownMenuItem
            onSelect={onSendToIM}
          >
            <Send className="h-4 w-4" />
            <span>{sendToIMText}</span>
          </DropdownMenuItem>
        )}

        {showRequestEditAccessInMenu && onRequestEditAccess && requestEditAccessText && (
          <DropdownMenuItem
            className="text-primary focus:text-primary"
            onSelect={onRequestEditAccess}
          >
            <Pencil className="h-4 w-4" />
            <span>{requestEditAccessText}</span>
          </DropdownMenuItem>
        )}

        {showResponsiveActions && (
          <DropdownMenuSeparator />
        )}

        {showDetailEditItem && (
          <DropdownMenuItem onSelect={onOpenDetailEdit}>
            <Pencil className="h-4 w-4" />
            <span>{detailEditText}</span>
          </DropdownMenuItem>
        )}

        {showDetailEditItem && (onShowFieldManagement && !isReadonly || showApiInfoItem || onShowExportDialog || onShowImportDialog) && (
          <DropdownMenuSeparator />
        )}

        {onShowFieldManagement && !isReadonly && (
          <DropdownMenuItem onSelect={onShowFieldManagement}>
            <Settings className="h-4 w-4" />
            <span>{manageFieldsText}</span>
          </DropdownMenuItem>
        )}

        {showApiInfoItem && (
          <DropdownMenuItem onSelect={onOpenApiInfo}>
            <Code2 className="h-4 w-4" />
            <span>{apiInfoText}</span>
          </DropdownMenuItem>
        )}

        {(onShowExportDialog || onShowImportDialog) && (
          <DropdownMenuSeparator />
        )}

        {onShowImportDialog && !isReadonly && importText && (
          <DropdownMenuItem onSelect={onShowImportDialog}>
            <FileInput className="h-4 w-4" />
            <span>{importText}</span>
          </DropdownMenuItem>
        )}

        {onShowExportDialog && (
          <DropdownMenuItem onSelect={() => openAfterMenuClose(onShowExportDialog)}>
            <Upload className="h-4 w-4" />
            <span>{exportText}</span>
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
