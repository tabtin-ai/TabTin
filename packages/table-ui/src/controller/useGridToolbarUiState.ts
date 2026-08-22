import { useCallback, useState } from 'react'

export interface EmojiPickerPosition {
  x: number
  y: number
}

export interface GridToolbarUiState {
  searchQuery: string
  setSearchQuery: (value: string) => void
  isRefreshConfigOpen: boolean
  setRefreshConfigOpen: (open: boolean) => void
  showImportDialog: boolean
  setShowImportDialog: (open: boolean) => void
  showExportDialog: boolean
  setShowExportDialog: (open: boolean) => void
  showFieldManagement: boolean
  setShowFieldManagement: (open: boolean) => void
  showCreateRecordDialog: boolean
  setShowCreateRecordDialog: (open: boolean) => void
  showDeleteConfirm: boolean
  setShowDeleteConfirm: (open: boolean) => void
  isEditingTableName: boolean
  editingTableName: string
  setEditingTableName: (value: string) => void
  beginTableNameEditing: (tableName: string) => void
  cancelTableNameEditing: () => void
  finishTableNameEditing: () => void
  showEmojiPicker: boolean
  emojiPickerPosition: EmojiPickerPosition | null
  openEmojiPicker: (position: EmojiPickerPosition) => void
  closeEmojiPicker: () => void
}

export const useGridToolbarUiState = (): GridToolbarUiState => {
  const [searchQuery, setSearchQuery] = useState('')
  const [isRefreshConfigOpen, setRefreshConfigOpen] = useState(false)
  const [showImportDialog, setShowImportDialog] = useState(false)
  const [showExportDialog, setShowExportDialog] = useState(false)
  const [showFieldManagement, setShowFieldManagement] = useState(false)
  const [showCreateRecordDialog, setShowCreateRecordDialog] = useState(false)
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)
  const [isEditingTableName, setIsEditingTableName] = useState(false)
  const [editingTableName, setEditingTableName] = useState('')
  const [showEmojiPicker, setShowEmojiPicker] = useState(false)
  const [emojiPickerPosition, setEmojiPickerPosition] = useState<EmojiPickerPosition | null>(null)

  const beginTableNameEditing = useCallback((tableName: string) => {
    setEditingTableName(tableName)
    setIsEditingTableName(true)
  }, [])

  const cancelTableNameEditing = useCallback(() => {
    setIsEditingTableName(false)
    setEditingTableName('')
  }, [])

  const finishTableNameEditing = useCallback(() => {
    setIsEditingTableName(false)
  }, [])

  const openEmojiPicker = useCallback((position: EmojiPickerPosition) => {
    setEmojiPickerPosition(position)
    setShowEmojiPicker(true)
  }, [])

  const closeEmojiPicker = useCallback(() => {
    setShowEmojiPicker(false)
  }, [])

  return {
    searchQuery,
    setSearchQuery,
    isRefreshConfigOpen,
    setRefreshConfigOpen,
    showImportDialog,
    setShowImportDialog,
    showExportDialog,
    setShowExportDialog,
    showFieldManagement,
    setShowFieldManagement,
    showCreateRecordDialog,
    setShowCreateRecordDialog,
    showDeleteConfirm,
    setShowDeleteConfirm,
    isEditingTableName,
    editingTableName,
    setEditingTableName,
    beginTableNameEditing,
    cancelTableNameEditing,
    finishTableNameEditing,
    showEmojiPicker,
    emojiPickerPosition,
    openEmojiPicker,
    closeEmojiPicker,
  }
}
