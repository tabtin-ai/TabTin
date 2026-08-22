import { renderHook, act } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useDataGridFieldContextMenu } from './useDataGridFieldContextMenu'

const tableCoreMocks = vi.hoisted(() => ({
  deleteField: vi.fn().mockResolvedValue(undefined),
  updateField: vi.fn().mockResolvedValue(undefined),
  setPrimaryField: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@components/view/UndoRedoContext', () => ({
  useUndoRedoContext: () => null,
}))

vi.mock('@tabtin/table-core', () => ({
  FieldApiService: {
    deleteField: tableCoreMocks.deleteField,
    updateField: tableCoreMocks.updateField,
    setPrimaryField: tableCoreMocks.setPrimaryField,
  },
  isPrimaryFieldAllowedType: (fieldType: string | undefined) =>
    Boolean(
      fieldType &&
        ['text', 'number', 'select', 'url', 'email', 'phone'].includes(fieldType),
    ),
}))

const makeParams = (overrides: Partial<Parameters<typeof useDataGridFieldContextMenu>[0]> = {}) => ({
  fields: [],
  currentView: { id: 'view-1' } as Parameters<typeof useDataGridFieldContextMenu>[0]['currentView'],
  selectedTableId: 'table-1',
  loadFields: vi.fn().mockResolvedValue(undefined),
  loadViews: vi.fn().mockResolvedValue(true),
  refreshCurrentView: vi.fn().mockResolvedValue(undefined),
  updateView: vi.fn().mockResolvedValue(undefined),
  translate: (key: string) => key,
  isPersonalViewEnabled: false,
  ...overrides,
})

describe('useDataGridFieldContextMenu', () => {
  const field = {
    id: 'field-copy',
    table_id: 'table-1',
    name: '标题 副本',
    field_type: 'text',
    is_primary: false,
  } as Parameters<ReturnType<typeof useDataGridFieldContextMenu>['handleDeleteField']>[0]

  beforeEach(() => {
    tableCoreMocks.deleteField.mockReset()
    tableCoreMocks.deleteField.mockResolvedValue(undefined)
    tableCoreMocks.updateField.mockReset()
    tableCoreMocks.updateField.mockResolvedValue(undefined)
    tableCoreMocks.setPrimaryField.mockReset()
    tableCoreMocks.setPrimaryField.mockResolvedValue(undefined)
  })

  it('刷新字段结构时重新加载当前 view 元数据', async () => {
    const params = makeParams()
    const { result } = renderHook(() => useDataGridFieldContextMenu(params))

    await act(async () => {
      await result.current.refreshFieldsAndView()
    })

    expect(params.loadFields).toHaveBeenCalledWith('table-1')
    expect(params.loadViews).toHaveBeenCalledWith('table-1')
    expect(params.refreshCurrentView).not.toHaveBeenCalled()
  })

  it('没有当前 view 时保留旧的记录刷新路径', async () => {
    const params = makeParams({ currentView: null })
    const { result } = renderHook(() => useDataGridFieldContextMenu(params))

    await act(async () => {
      await result.current.refreshFieldsAndView()
    })

    expect(params.loadFields).toHaveBeenCalledWith('table-1')
    expect(params.loadViews).not.toHaveBeenCalled()
    expect(params.refreshCurrentView).toHaveBeenCalledTimes(1)
  })

  it('REST 删除字段后刷新字段和当前 view', async () => {
    const params = makeParams()
    const { result } = renderHook(() => useDataGridFieldContextMenu(params))

    act(() => {
      result.current.handleDeleteField(field)
    })
    await act(async () => {
      await result.current.handleConfirmDeleteField()
    })

    expect(tableCoreMocks.deleteField).toHaveBeenCalledWith('field-copy')
    expect(params.loadFields).toHaveBeenCalledWith('table-1')
    expect(params.loadViews).toHaveBeenCalledWith('table-1')
  })

  it('协作删除字段先走 REST 真删除，再镜像 runtime 并刷新字段结构', async () => {
    const deleteFieldForRuntime = vi.fn()
    const params = makeParams({
      isCollabSyncActive: true,
      deleteFieldForRuntime,
    })
    const { result } = renderHook(() => useDataGridFieldContextMenu(params))

    act(() => {
      result.current.handleDeleteField(field)
    })
    await act(async () => {
      await result.current.handleConfirmDeleteField()
    })

    expect(tableCoreMocks.deleteField).toHaveBeenCalledWith('field-copy')
    expect(deleteFieldForRuntime).toHaveBeenCalledWith('field-copy')
    expect(params.loadFields).toHaveBeenCalledWith('table-1')
    expect(params.loadViews).toHaveBeenCalledWith('table-1')
    expect(params.refreshCurrentView).not.toHaveBeenCalled()
  })

  it('REST 删除失败时不写 runtime，也不刷新字段结构', async () => {
    tableCoreMocks.deleteField.mockRejectedValueOnce(new Error('delete failed'))
    const deleteFieldForRuntime = vi.fn()
    const params = makeParams({
      isCollabSyncActive: true,
      deleteFieldForRuntime,
    })
    const { result } = renderHook(() => useDataGridFieldContextMenu(params))

    act(() => {
      result.current.handleDeleteField(field)
    })
    await act(async () => {
      await result.current.handleConfirmDeleteField()
    })

    expect(deleteFieldForRuntime).not.toHaveBeenCalled()
    expect(params.loadFields).not.toHaveBeenCalled()
    expect(params.loadViews).not.toHaveBeenCalled()
    expect(result.current.showFieldDeleteConfirm).toBe(true)
  })

  it('设为主字段走 setPrimaryField，并在成功后刷新表与字段', async () => {
    const refreshTable = vi.fn().mockResolvedValue({ id: 'table-1', schema_version: 7 })
    const params = makeParams({
      selectedTableSchemaVersion: 6,
      refreshTable,
    })
    const { result } = renderHook(() => useDataGridFieldContextMenu(params))

    await act(async () => {
      await result.current.handleSetPrimaryField(field)
    })

    expect(tableCoreMocks.setPrimaryField).toHaveBeenCalledWith(
      'field-copy',
      expect.objectContaining({
        getExpectedSchemaVersion: expect.any(Function),
        refreshSchemaVersion: expect.any(Function),
      }),
    )
    expect(params.loadFields).toHaveBeenCalledWith('table-1')
    expect(refreshTable).toHaveBeenCalledWith('table-1')
  })

  it('runtime 镜像失败时仍刷新字段结构并关闭确认弹窗', async () => {
    const deleteFieldForRuntime = vi.fn(() => {
      throw new Error('runtime mirror failed')
    })
    const params = makeParams({
      isCollabSyncActive: true,
      deleteFieldForRuntime,
    })
    const { result } = renderHook(() => useDataGridFieldContextMenu(params))

    act(() => {
      result.current.handleDeleteField(field)
    })
    await act(async () => {
      await result.current.handleConfirmDeleteField()
    })

    expect(tableCoreMocks.deleteField).toHaveBeenCalledWith('field-copy')
    expect(deleteFieldForRuntime).toHaveBeenCalledWith('field-copy')
    expect(params.loadFields).toHaveBeenCalledWith('table-1')
    expect(params.loadViews).toHaveBeenCalledWith('table-1')
    expect(result.current.showFieldDeleteConfirm).toBe(false)
  })
})
