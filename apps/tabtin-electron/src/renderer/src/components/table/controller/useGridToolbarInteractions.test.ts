import React from 'react'
import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useGridToolbarInteractions } from './useGridToolbarInteractions'
import { DUPLICATE_NAME_ERROR_TITLE } from '@/lib/duplicateNameError'

const { toastMock, tableErrorRef } = vi.hoisted(() => ({
  toastMock: vi.fn(),
  tableErrorRef: { current: '更新表格失败' as string | null },
}))

vi.mock('@tabtin/smartsheet-ui', () => ({
  toast: toastMock,
}))

vi.mock('@stores/useTableStore', () => ({
  tableStore: {
    getState: () => ({ error: tableErrorRef.current }),
  },
}))

function makeUiState() {
  return {
    editingTableName: '已有表格',
    isEditingTableName: false,
    showEmojiPicker: false,
    setSearchQuery: vi.fn(),
    setShowCreateRecordDialog: vi.fn(),
    setShowDeleteConfirm: vi.fn(),
    beginTableNameEditing: vi.fn(),
    finishTableNameEditing: vi.fn(),
    cancelTableNameEditing: vi.fn(),
    openEmojiPicker: vi.fn(),
    closeEmojiPicker: vi.fn(),
  }
}

describe('useGridToolbarInteractions table rename errors', () => {
  beforeEach(() => {
    toastMock.mockReset()
    tableErrorRef.current = '更新表格失败'
  })

  it('表名提交失败但只拿到泛化错误时展示统一重名提示', async () => {
    const uiState = makeUiState()
    const gridToolbarController = {
      submitTableName: vi.fn().mockResolvedValue('failed'),
      refreshView: vi.fn(),
      deleteSelectedRecords: vi.fn(),
      updateTableIcon: vi.fn(),
    }

    const { result } = renderHook(() =>
      useGridToolbarInteractions({
        selectedTable: { id: 'table-1', name: '打卡777' } as any,
        selectedRows: [],
        uiState: uiState as any,
        gridToolbarController: gridToolbarController as any,
        tableNameInputRef: React.createRef<HTMLInputElement>(),
        emojiButtonRef: React.createRef<HTMLDivElement>(),
      }),
    )

    await act(async () => {
      await result.current.handleTableNameSubmit()
    })

    expect(toastMock).toHaveBeenCalledWith({
      title: DUPLICATE_NAME_ERROR_TITLE,
      description: undefined,
      variant: 'destructive',
    })
    expect(uiState.finishTableNameEditing).toHaveBeenCalledTimes(1)
  })

  it('提供直接新增行回调时不打开创建记录弹窗', () => {
    const uiState = makeUiState()
    const onAddRow = vi.fn()
    const gridToolbarController = {
      submitTableName: vi.fn(),
      refreshView: vi.fn(),
      deleteSelectedRecords: vi.fn(),
      updateTableIcon: vi.fn(),
    }

    const { result } = renderHook(() =>
      useGridToolbarInteractions({
        selectedTable: { id: 'table-1', name: '打卡777' } as any,
        selectedRows: [],
        uiState: uiState as any,
        gridToolbarController: gridToolbarController as any,
        tableNameInputRef: React.createRef<HTMLInputElement>(),
        emojiButtonRef: React.createRef<HTMLDivElement>(),
        onAddRow,
      }),
    )

    act(() => {
      result.current.handleAddRow()
    })

    expect(onAddRow).toHaveBeenCalledTimes(1)
    expect(uiState.setShowCreateRecordDialog).not.toHaveBeenCalled()
  })
})
