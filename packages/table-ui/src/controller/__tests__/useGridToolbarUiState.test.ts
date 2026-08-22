import { act, renderHook } from '@testing-library/react'
import { useGridToolbarUiState } from '../useGridToolbarUiState'

describe('useGridToolbarUiState', () => {
  it('应管理 GridToolbar 的对话框和编辑状态', () => {
    const { result } = renderHook(() => useGridToolbarUiState())

    expect(result.current.searchQuery).toBe('')
    expect(result.current.isRefreshConfigOpen).toBe(false)
    expect(result.current.showImportDialog).toBe(false)
    expect(result.current.isEditingTableName).toBe(false)
    expect(result.current.showEmojiPicker).toBe(false)

    act(() => {
      result.current.setSearchQuery('abc')
      result.current.setRefreshConfigOpen(true)
      result.current.setShowImportDialog(true)
      result.current.beginTableNameEditing('Tasks')
      result.current.openEmojiPicker({ x: 10, y: 20 })
    })

    expect(result.current.searchQuery).toBe('abc')
    expect(result.current.isRefreshConfigOpen).toBe(true)
    expect(result.current.showImportDialog).toBe(true)
    expect(result.current.isEditingTableName).toBe(true)
    expect(result.current.editingTableName).toBe('Tasks')
    expect(result.current.showEmojiPicker).toBe(true)
    expect(result.current.emojiPickerPosition).toEqual({ x: 10, y: 20 })

    act(() => {
      result.current.cancelTableNameEditing()
      result.current.closeEmojiPicker()
    })

    expect(result.current.isEditingTableName).toBe(false)
    expect(result.current.editingTableName).toBe('')
    expect(result.current.showEmojiPicker).toBe(false)
  })
})
