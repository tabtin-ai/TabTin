import { act, renderHook } from '@testing-library/react'
import { vi } from 'vitest'
import { useGridToolbarController } from '../useGridToolbarController'

type TestRow = { id?: string; record_id?: string; row_id?: string; __rowType?: string }

const createControllerInput = () => ({
  selectedTable: {
    id: 'table-1',
    name: 'Tasks',
    field_count: 3,
    schema_history_id: 'schema-1',
    default_source_url: 'https://example.com',
  },
  fieldsCount: 2,
  selectedRows: [{ id: 'r1' }, { id: 'r2' }] as TestRow[],
  totalRowsCount: 12,
  setRecordSearchQuery: vi.fn(),
  loadRecordsByTable: vi.fn().mockResolvedValue(undefined),
  refreshCurrentView: vi.fn().mockResolvedValue(undefined),
  deleteRecord: vi.fn().mockResolvedValue(true),
  bulkDeleteRecords: vi.fn().mockResolvedValue({ ok: true, deletedIds: ['r1', 'r2'], failedIds: [], errors: [] }),
  setSelectedRows: vi.fn(),
  updateTable: vi.fn().mockResolvedValue(undefined),
  setTableFontStyle: vi.fn(),
  setTableFontWeight: vi.fn(),
  setTableFontSize: vi.fn(),
})

describe('useGridToolbarController', () => {
  it('应提供正确的派生状态并完成搜索/删除/改名命令编排', async () => {
    const input = createControllerInput()

    const { result } = renderHook(() => useGridToolbarController(input))

    expect(result.current.selectedRowsCount).toBe(2)
    expect(result.current.totalRows).toBe(12)
    expect(result.current.totalColumns).toBe(2)
    expect(result.current.canDetailEdit).toBe(false)

    await act(async () => {
      await result.current.searchRecords('hello')
    })
    expect(input.setRecordSearchQuery).toHaveBeenCalledWith('hello')
    expect(input.loadRecordsByTable).toHaveBeenCalledWith('table-1', {
      page: 1,
      search: 'hello',
    })

    await act(async () => {
      await result.current.deleteSelectedRecords()
    })
    expect(input.bulkDeleteRecords).toHaveBeenCalledWith(['r1', 'r2'])
    expect(input.setSelectedRows).toHaveBeenCalledWith([])
    expect(input.refreshCurrentView).toHaveBeenCalled()

    await act(async () => {
      const submitResult = await result.current.submitTableName('  Tasks v2  ')
      expect(submitResult).toBe('updated')
    })
    expect(input.updateTable).toHaveBeenCalledWith('table-1', { name: 'Tasks v2' })
  })

  it('批量删除无成功 ID 时不应清空选中或刷新视图', async () => {
    const input = createControllerInput()
    input.bulkDeleteRecords.mockResolvedValue({ ok: false, deletedIds: [], failedIds: ['r1', 'r2'], errors: ['failed'] })

    const { result } = renderHook(() => useGridToolbarController(input))

    await act(async () => {
      const deleted = await result.current.deleteSelectedRecords()
      expect(deleted).toBe(false)
    })

    expect(input.bulkDeleteRecords).toHaveBeenCalledWith(['r1', 'r2'])
    expect(input.setSelectedRows).not.toHaveBeenCalled()
    expect(input.refreshCurrentView).not.toHaveBeenCalled()
  })

  it('单选删除应兼容只带 row_id 的选中行', async () => {
    const input = createControllerInput()
    input.selectedRows = [{ row_id: 'r-row-only' }]

    const { result } = renderHook(() => useGridToolbarController(input))

    await act(async () => {
      const deleted = await result.current.deleteSelectedRecords()
      expect(deleted).toBe(true)
    })

    expect(input.deleteRecord).toHaveBeenCalledWith('r-row-only')
    expect(input.setSelectedRows).toHaveBeenCalledWith([])
    expect(input.refreshCurrentView).toHaveBeenCalled()
  })

  it('批量删除应兼容 record_id / row_id fallback', async () => {
    const input = createControllerInput()
    input.selectedRows = [{ record_id: 'r-record' }, { row_id: 'r-row' }]

    const { result } = renderHook(() => useGridToolbarController(input))

    await act(async () => {
      const deleted = await result.current.deleteSelectedRecords()
      expect(deleted).toBe(true)
    })

    expect(input.bulkDeleteRecords).toHaveBeenCalledWith(['r-record', 'r-row'])
  })

  it('批量删除应跳过草稿和分组等特殊行', async () => {
    const input = createControllerInput()
    input.selectedRows = [
      { id: '__draft_row__', row_id: '__draft_row__', __rowType: 'draft' },
      { id: 'r-real' },
      { id: '__group__todo', __rowType: 'group_header' },
    ]

    const { result } = renderHook(() => useGridToolbarController(input))

    await act(async () => {
      const deleted = await result.current.deleteSelectedRecords()
      expect(deleted).toBe(true)
    })

    expect(input.bulkDeleteRecords).toHaveBeenCalledWith(['r-real'])
  })

  it('应接受新的字体与字重选项', () => {
    const input = createControllerInput()
    const { result } = renderHook(() => useGridToolbarController(input))

    act(() => {
      result.current.handleFontStyleChange('mono')
      result.current.handleFontStyleChange('rounded')
      result.current.handleFontWeightChange('thin')
      result.current.handleFontWeightChange('semibold')
    })

    expect(input.setTableFontStyle).toHaveBeenNthCalledWith(1, 'mono')
    expect(input.setTableFontStyle).toHaveBeenNthCalledWith(2, 'rounded')
    expect(input.setTableFontWeight).toHaveBeenNthCalledWith(1, 'thin')
    expect(input.setTableFontWeight).toHaveBeenNthCalledWith(2, 'semibold')
  })

  it('改名接口明确失败时返回 failed', async () => {
    const input = createControllerInput()
    input.updateTable.mockResolvedValue(null)

    const { result } = renderHook(() => useGridToolbarController(input))

    await act(async () => {
      const submitResult = await result.current.submitTableName('Tasks v2')
      expect(submitResult).toBe('failed')
    })
  })
})
