import {
  useCallback,
  useEffect,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type RefObject,
} from 'react'
import { toast } from '@tabtin/smartsheet-ui'
import type { TableGridRow } from '@tabtin/table-engine'
import type { GridToolbarControllerResult } from '@tabtin/table-ui'
import type { Table } from '@tabtin/table-core'
import type { GridToolbarUiState } from '@tabtin/table-ui'
import { tableStore } from '@stores/useTableStore'
import { DUPLICATE_NAME_ERROR_TITLE, isDuplicateNameErrorMessage } from '@/lib/duplicateNameError'

interface UseGridToolbarInteractionsInput {
  selectedTable: Table | null
  selectedRows: TableGridRow[]
  uiState: GridToolbarUiState
  gridToolbarController: GridToolbarControllerResult
  tableNameInputRef: RefObject<HTMLInputElement | null>
  emojiButtonRef: RefObject<HTMLDivElement | null>
  onAddRow?: () => void
}

export const useGridToolbarInteractions = ({
  selectedTable,
  selectedRows,
  uiState,
  gridToolbarController,
  tableNameInputRef,
  emojiButtonRef,
  onAddRow,
}: UseGridToolbarInteractionsInput) => {
  const showTableNameUpdateErrorToast = useCallback((errorMessage?: string | null) => {
    const normalizedMessage = errorMessage?.trim()
    const isDuplicateNameError = isDuplicateNameErrorMessage(normalizedMessage)
      || normalizedMessage === '更新表格失败'
      || normalizedMessage === 'update table failed'
    toast({
      title: isDuplicateNameError
        ? DUPLICATE_NAME_ERROR_TITLE
        : normalizedMessage || '更新表格失败',
      description: isDuplicateNameError ? undefined : normalizedMessage || undefined,
      variant: 'destructive',
    })
  }, [])

  const handleSearch = useCallback(
    (query: string) => {
      uiState.setSearchQuery(query)
    },
    [uiState.setSearchQuery]
  )

  const handleRefresh = useCallback(async () => {
    try {
      await gridToolbarController.refreshView()
    } catch {
      // 刷新失败由请求层统一处理。
    }
  }, [gridToolbarController])

  const handleAddRow = useCallback(() => {
    if (onAddRow) {
      onAddRow()
      return
    }
    uiState.setShowCreateRecordDialog(true)
  }, [onAddRow, uiState.setShowCreateRecordDialog])

  const handleDeleteSelected = useCallback(() => {
    uiState.setShowDeleteConfirm(true)
  }, [uiState.setShowDeleteConfirm])

  const handleConfirmDelete = useCallback(async () => {
    try {
      const deleted = await gridToolbarController.deleteSelectedRecords()
      if (deleted) {
        uiState.setShowDeleteConfirm(false)
      }
    } catch {
      // 删除失败由上层异常链路统一处理。
    }
  }, [gridToolbarController, selectedRows.length, uiState.setShowDeleteConfirm])

  const handleTableNameClick = useCallback(() => {
    if (!selectedTable) {
      return
    }
    uiState.beginTableNameEditing(selectedTable.name)
  }, [selectedTable, uiState.beginTableNameEditing])

  const handleTableNameSubmit = useCallback(async () => {
    try {
      const result = await gridToolbarController.submitTableName(uiState.editingTableName)
      if (result === 'updated') {
        // 成功路径仅关闭编辑态。
      } else if (result === 'failed') {
        const errorMessage = tableStore.getState().error
        showTableNameUpdateErrorToast(errorMessage)
      }
      uiState.finishTableNameEditing()
    } catch (error) {
      showTableNameUpdateErrorToast(error instanceof Error ? error.message : undefined)
      uiState.finishTableNameEditing()
    }
  }, [
    gridToolbarController,
    showTableNameUpdateErrorToast,
    uiState.editingTableName,
    uiState.finishTableNameEditing,
  ])

  const handleTableNameCancel = useCallback(() => {
    uiState.cancelTableNameEditing()
  }, [uiState.cancelTableNameEditing])

  const handleTableNameKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLInputElement>) => {
      if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
        event.preventDefault()
        void handleTableNameSubmit()
      } else if (event.key === 'Escape') {
        event.preventDefault()
        handleTableNameCancel()
      }
    },
    [handleTableNameCancel, handleTableNameSubmit]
  )

  const handleEmojiClick = useCallback(
    (event: ReactMouseEvent) => {
      event.stopPropagation()
      if (!emojiButtonRef.current) {
        return
      }
      const rect = emojiButtonRef.current.getBoundingClientRect()
      uiState.openEmojiPicker({
        x: rect.left,
        y: rect.bottom + 4,
      })
    },
    [emojiButtonRef, uiState.openEmojiPicker]
  )

  const handleEmojiSelect = useCallback(
    async (emoji: string) => {
      try {
        const updated = await gridToolbarController.updateTableIcon(emoji)
        if (updated) {
          uiState.closeEmojiPicker()
        }
      } catch {
        // 失败态由请求层统一处理。
      }
    },
    [gridToolbarController, uiState.closeEmojiPicker]
  )

  useEffect(() => {
    if (!uiState.isEditingTableName || !tableNameInputRef.current) {
      return
    }
    tableNameInputRef.current.focus()
    tableNameInputRef.current.select()
  }, [uiState.isEditingTableName, tableNameInputRef])

  useEffect(() => {
    if (!uiState.showEmojiPicker) {
      return
    }

    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as HTMLElement
      if (target.closest('.emoji-picker-menu')) {
        return
      }
      uiState.closeEmojiPicker()
    }

    document.addEventListener('click', handleClickOutside, true)
    return () => {
      document.removeEventListener('click', handleClickOutside, true)
    }
  }, [uiState.showEmojiPicker, uiState.closeEmojiPicker])

  return {
    handleSearch,
    handleRefresh,
    handleAddRow,
    handleDeleteSelected,
    handleConfirmDelete,
    handleTableNameClick,
    handleTableNameSubmit,
    handleTableNameKeyDown,
    handleEmojiClick,
    handleEmojiSelect,
  }
}
