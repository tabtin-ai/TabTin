import { act, renderHook, waitFor } from '@testing-library/react'
import { vi } from 'vitest'
import { useDataGridEditingController } from '../useDataGridEditingController'
import type { Field, TableRecord } from '../../types'

const createField = (
  id: string,
  name: string,
  fieldType: string = 'text',
  overrides: Partial<Field> = {}
): Field => ({
  id,
  table_id: 'table-1',
  name,
  field_type: fieldType,
  is_primary: false,
  is_hidden: false,
  sort_order: 0,
  created_at: '',
  updated_at: '',
  ...overrides,
})

const createRecord = (id: string, data: Record<string, unknown>): TableRecord => ({
  id,
  table_id: 'table-1',
  created_by_id: 'u1',
  created_at: '',
  updated_at: '',
  data,
})

describe('useDataGridEditingController', () => {
  it('非法数字与邮箱一样 toast 校验失败且不落库', async () => {
    const fields = [createField('f_qty', 'Qty', 'number')]
    const updateRecordMock = vi.fn().mockResolvedValue(createRecord('r1', { Qty: 1 }))
    const notifyMock = vi.fn()

    const { result } = renderHook(() =>
      useDataGridEditingController({
        orderedFields: fields,
        fields,
        selectedTableId: 'table-1',
        useViewData: false,
        firstEditableField: 'Qty',
        gridApiRef: {
          current: {
            getEditingCells: () => [],
            getFocusedCell: () => null,
          } as any,
        },
        viewStoreApi: {
          getState: () => ({
            currentViewRecords: { records: [] },
          }),
        },
        createRecord: vi.fn().mockResolvedValue(null),
        updateRecord: updateRecordMock,
        refreshCurrentView: vi.fn().mockResolvedValue(undefined),
        startPolling: vi.fn(),
        checkIfTriggersAutoField: vi.fn().mockReturnValue([]),
        translate: (key: string) => key,
        notify: notifyMock,
      })
    )

    await act(async () => {
      await result.current.handleCellValueChanged(
        { id: 'r1', row_id: 'r1', Qty: 1 } as any,
        'Qty',
        'abc',
        1,
      )
    })

    expect(updateRecordMock).not.toHaveBeenCalled()
    expect(notifyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'table:error.validationFailed',
        description: 'table:validation.invalid_number',
        variant: 'destructive',
      })
    )
  })

  it('NaN 数字值也走校验失败 toast（不再静默丢弃）', async () => {
    const fields = [createField('f_qty', 'Qty', 'number')]
    const updateRecordMock = vi.fn().mockResolvedValue(createRecord('r1', { Qty: 1 }))
    const notifyMock = vi.fn()

    const { result } = renderHook(() =>
      useDataGridEditingController({
        orderedFields: fields,
        fields,
        selectedTableId: 'table-1',
        useViewData: false,
        firstEditableField: 'Qty',
        gridApiRef: {
          current: {
            getEditingCells: () => [],
            getFocusedCell: () => null,
          } as any,
        },
        viewStoreApi: {
          getState: () => ({
            currentViewRecords: { records: [] },
          }),
        },
        createRecord: vi.fn().mockResolvedValue(null),
        updateRecord: updateRecordMock,
        refreshCurrentView: vi.fn().mockResolvedValue(undefined),
        startPolling: vi.fn(),
        checkIfTriggersAutoField: vi.fn().mockReturnValue([]),
        translate: (key: string) => key,
        notify: notifyMock,
      })
    )

    await act(async () => {
      await result.current.handleCellValueChanged(
        { id: 'r1', row_id: 'r1', Qty: 1 } as any,
        'Qty',
        Number.NaN,
        1,
      )
    })

    expect(updateRecordMock).not.toHaveBeenCalled()
    expect(notifyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'table:error.validationFailed',
        description: 'table:validation.invalid_number',
        variant: 'destructive',
      })
    )
  })

  it('readonly 表格不创建草稿也不提交单元格更新', async () => {
    const fields = [createField('f_name', 'Name')]
    const createRecordMock = vi.fn().mockResolvedValue(createRecord('r1', { Name: 'Alice' }))
    const updateRecordMock = vi.fn().mockResolvedValue(createRecord('r1', { Name: 'Bob' }))

    const { result } = renderHook(() =>
      useDataGridEditingController({
        orderedFields: fields,
        fields,
        selectedTableId: 'table-1',
        useViewData: false,
        firstEditableField: 'Name',
        isReadonly: true,
        gridApiRef: {
          current: {
            getEditingCells: () => [],
            getFocusedCell: () => null,
          } as any,
        },
        viewStoreApi: {
          getState: () => ({
            currentViewRecords: { records: [] },
          }),
        },
        createRecord: createRecordMock,
        updateRecord: updateRecordMock,
        refreshCurrentView: vi.fn().mockResolvedValue(undefined),
        startPolling: vi.fn(),
        checkIfTriggersAutoField: vi.fn().mockReturnValue([]),
        translate: (key: string) => key,
      })
    )

    act(() => {
      result.current.handleAddRowClick()
    })
    expect(result.current.draftRowData).toBeNull()

    await expect(result.current.handleCommitDraftRow()).resolves.toBeNull()

    await act(async () => {
      await result.current.handleCellValueChanged(
        { id: 'r1', row_id: 'r1', Name: 'Alice' } as any,
        'Name',
        'Bob',
        'Alice',
      )
    })

    expect(createRecordMock).not.toHaveBeenCalled()
    expect(updateRecordMock).not.toHaveBeenCalled()
  })

  it('date dynamic defaults submit current timestamps so display can format time', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-09T03:22:33.000Z'))
    try {
      const fields = [
        createField('f_date', 'Submitted', 'date', {
          default_value: { mode: 'created_time' } as any,
          options: {
            formatting: {
              date: 'YYYY-MM-DD',
              time: 'HH:mm:ss',
              timeZone: 'UTC',
            },
          } as any,
        }),
      ]
      const createRecordMock = vi.fn().mockResolvedValue(createRecord('r1', { Submitted: '2026-08-09' }))

      const { result } = renderHook(() =>
        useDataGridEditingController({
          orderedFields: fields,
          fields,
          selectedTableId: 'table-1',
          useViewData: false,
          firstEditableField: 'Submitted',
          gridApiRef: {
            current: {
              getEditingCells: () => [],
              getFocusedCell: () => null,
            } as any,
          },
          viewStoreApi: {
            getState: () => ({
              currentViewRecords: { records: [] },
            }),
          },
          createRecord: createRecordMock,
          updateRecord: vi.fn().mockResolvedValue(null),
          refreshCurrentView: vi.fn().mockResolvedValue(undefined),
          startPolling: vi.fn(),
          checkIfTriggersAutoField: vi.fn().mockReturnValue([]),
          translate: (key: string) => key,
        })
      )

      act(() => {
        result.current.handleAddRowClick()
      })

      expect(result.current.draftRowData?.Submitted).toBe('2026-08-09T03:22:33.000Z')

      await act(async () => {
        await result.current.handleCommitDraftRow()
      })

      expect(createRecordMock).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { f_date: '2026-08-09T03:22:33.000Z' },
          fields: { f_date: '2026-08-09T03:22:33.000Z' },
          fieldKeyType: 'id',
        })
      )
    } finally {
      vi.useRealTimers()
    }
  })

  it('prefills creator defaults in single and multiple user draft cells', () => {
    const fields = [
      createField('f_owner', 'Owner', 'user', {
        default_value: { mode: 'creator' } as any,
      }),
      createField('f_watchers', 'Watchers', 'user', {
        default_value: { mode: 'creator' } as any,
        options: { multiple: true } as any,
      }),
    ]

    const { result } = renderHook(() =>
      useDataGridEditingController({
        orderedFields: fields,
        fields,
        currentUserId: 'user-1',
        selectedTableId: 'table-1',
        useViewData: false,
        firstEditableField: 'Owner',
        gridApiRef: { current: { getEditingCells: () => [], getFocusedCell: () => null } as any },
        viewStoreApi: { getState: () => ({ currentViewRecords: { records: [] } }) },
        createRecord: vi.fn().mockResolvedValue(null),
        updateRecord: vi.fn().mockResolvedValue(null),
        refreshCurrentView: vi.fn().mockResolvedValue(undefined),
        startPolling: vi.fn(),
        checkIfTriggersAutoField: vi.fn().mockReturnValue([]),
        translate: (key: string) => key,
      })
    )

    act(() => result.current.handleAddRowClick())

    expect(result.current.draftRowData).toMatchObject({
      Owner: 'user-1',
      Watchers: ['user-1'],
    })

    act(() => {
      void result.current.handleCellValueChanged(
        result.current.draftRowData!,
        'Owner',
        null,
        'user-1',
      )
    })

    expect(result.current.draftRowData).toMatchObject({ Owner: null })
  })

  it('draft 行离开编辑态后才创建记录', async () => {
    const fields = [createField('f_name', 'Name')]

    const createRecordMock = vi.fn().mockResolvedValue(createRecord('r1', { Name: 'Alice' }))
    const updateRecordMock = vi.fn().mockResolvedValue(null)
    const refreshCurrentViewMock = vi.fn().mockResolvedValue(undefined)
    const startPollingMock = vi.fn()
    const checkIfTriggersAutoFieldMock = vi.fn().mockReturnValue([])

    const { result } = renderHook(() =>
      useDataGridEditingController({
        orderedFields: fields,
        fields,
        selectedTableId: 'table-1',
        useViewData: false,
        firstEditableField: 'Name',
        gridApiRef: {
          current: {
            getEditingCells: () => [],
            getFocusedCell: () => null,
          } as any,
        },
        viewStoreApi: {
          getState: () => ({
            currentViewRecords: { records: [] },
          }),
        },
        createRecord: createRecordMock,
        updateRecord: updateRecordMock,
        refreshCurrentView: refreshCurrentViewMock,
        startPolling: startPollingMock,
        checkIfTriggersAutoField: checkIfTriggersAutoFieldMock,
        translate: (key: string) => key,
      })
    )

    await act(async () => {
      await result.current.handleCellValueChanged(
        {
          id: '__draft_row__',
          row_id: '__draft_row__',
          __rowType: 'draft',
        } as any,
        'Name',
        'Alice',
        ''
      )
    })

    expect(createRecordMock).not.toHaveBeenCalled()

    await act(async () => {
      result.current.handleCellEditingStopped({
        data: {
          id: '__draft_row__',
          row_id: '__draft_row__',
          __rowType: 'draft',
        },
      })
    })

    await waitFor(() => {
      expect(createRecordMock).toHaveBeenCalledTimes(1)
    })
    expect(createRecordMock).toHaveBeenCalledWith(
      expect.objectContaining({
        table_id: 'table-1',
        data: { f_name: 'Alice' },
        fields: { f_name: 'Alice' },
        fieldKeyType: 'id',
      })
    )
    await waitFor(() => {
      expect(result.current.draftRowData).toBeNull()
    })
    expect(updateRecordMock).not.toHaveBeenCalled()
    expect(startPollingMock).not.toHaveBeenCalled()
  })

  it('select 新增选项保存不应被旧 choices 前端校验拦截', async () => {
    const fields = [
      createField('f_status', 'Status', 'single_select', {
        options: { choices: ['Open', 'Closed'] },
      }),
    ]
    const notifyMock = vi.fn()
    const updateRecordMock = vi.fn().mockResolvedValue(createRecord('r1', { Status: 'In Progress' }))

    const { result } = renderHook(() =>
      useDataGridEditingController({
        orderedFields: fields,
        fields,
        selectedTableId: 'table-1',
        useViewData: false,
        firstEditableField: 'Status',
        gridApiRef: {
          current: {
            getEditingCells: () => [],
            getFocusedCell: () => null,
          } as any,
        },
        viewStoreApi: {
          getState: () => ({
            currentViewRecords: { records: [] },
          }),
        },
        createRecord: vi.fn().mockResolvedValue(null),
        updateRecord: updateRecordMock,
        refreshCurrentView: vi.fn().mockResolvedValue(undefined),
        startPolling: vi.fn(),
        checkIfTriggersAutoField: vi.fn().mockReturnValue([]),
        translate: (key: string) => key,
        notify: notifyMock,
      })
    )

    await act(async () => {
      await result.current.handleCellValueChanged(
        {
          id: 'r1',
          row_id: 'r1',
          Status: 'Open',
        } as any,
        'Status',
        'In Progress',
        'Open'
      )
    })

    expect(updateRecordMock).toHaveBeenCalledWith(
      'r1',
      expect.objectContaining({
        data: { f_status: 'In Progress' },
        fields: { f_status: 'In Progress' },
        fieldKeyType: 'id',
      })
    )
    expect(notifyMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ title: 'table:error.validationFailed' })
    )
  })

  it('同一个 draft 单元格失焦时应提交草稿', async () => {
    const fields = [createField('f_name', 'Name'), createField('f_status', 'Status')]

    const createRecordMock = vi.fn().mockResolvedValue(createRecord('r1', { Name: 'Alice' }))

    const { result } = renderHook(() =>
      useDataGridEditingController({
        orderedFields: fields,
        fields,
        selectedTableId: 'table-1',
        useViewData: false,
        firstEditableField: 'Name',
        gridApiRef: {
          current: {
            getEditingCells: () => [],
            getFocusedCell: () => ({
              rowIndex: 0,
              field: 'Name',
            }),
            getDisplayedRowAtIndex: () => ({
              data: {
                id: '__draft_row__',
                row_id: '__draft_row__',
                __rowType: 'draft',
                Name: 'Alice',
              },
            }),
          } as any,
        },
        viewStoreApi: {
          getState: () => ({
            currentViewRecords: { records: [] },
          }),
        },
        createRecord: createRecordMock,
        updateRecord: vi.fn().mockResolvedValue(null),
        refreshCurrentView: vi.fn().mockResolvedValue(undefined),
        startPolling: vi.fn(),
        checkIfTriggersAutoField: vi.fn().mockReturnValue([]),
        translate: (key: string) => key,
      })
    )

    await act(async () => {
      await result.current.handleCellValueChanged(
        {
          id: '__draft_row__',
          row_id: '__draft_row__',
          __rowType: 'draft',
        } as any,
        'Name',
        'Alice',
        ''
      )
    })

    await act(async () => {
      result.current.handleCellEditingStopped({
        data: {
          id: '__draft_row__',
          row_id: '__draft_row__',
          __rowType: 'draft',
        },
        colDef: {
          field: 'Name',
        },
      })
    })

    await waitFor(() => {
      expect(createRecordMock).toHaveBeenCalledTimes(1)
    })
    await waitFor(() => {
      expect(result.current.draftRowData).toBeNull()
    })
  })

  it('切到 draft 行其他字段时不应提前提交草稿', async () => {
    const fields = [createField('f_name', 'Name'), createField('f_status', 'Status')]

    const createRecordMock = vi.fn().mockResolvedValue(createRecord('r1', { Name: 'Alice' }))

    const { result } = renderHook(() =>
      useDataGridEditingController({
        orderedFields: fields,
        fields,
        selectedTableId: 'table-1',
        useViewData: false,
        firstEditableField: 'Name',
        gridApiRef: {
          current: {
            getEditingCells: () => [],
            getFocusedCell: () => ({
              rowIndex: 0,
              field: 'Status',
            }),
            getDisplayedRowAtIndex: () => ({
              data: {
                id: '__draft_row__',
                row_id: '__draft_row__',
                __rowType: 'draft',
                Name: 'Alice',
              },
            }),
          } as any,
        },
        viewStoreApi: {
          getState: () => ({
            currentViewRecords: { records: [] },
          }),
        },
        createRecord: createRecordMock,
        updateRecord: vi.fn().mockResolvedValue(null),
        refreshCurrentView: vi.fn().mockResolvedValue(undefined),
        startPolling: vi.fn(),
        checkIfTriggersAutoField: vi.fn().mockReturnValue([]),
        translate: (key: string) => key,
      })
    )

    await act(async () => {
      await result.current.handleCellValueChanged(
        {
          id: '__draft_row__',
          row_id: '__draft_row__',
          __rowType: 'draft',
        } as any,
        'Name',
        'Alice',
        ''
      )
    })

    act(() => {
      result.current.handleCellEditingStopped({
        data: {
          id: '__draft_row__',
          row_id: '__draft_row__',
          __rowType: 'draft',
        },
        colDef: {
          field: 'Name',
        },
      })
    })

    expect(createRecordMock).not.toHaveBeenCalled()
    expect(result.current.draftRowData?.Name).toBe('Alice')
  })

  it('同字段 editor 自行关闭时不应提前提交草稿', async () => {
    const fields = [createField('f_name', 'Name'), createField('f_status', 'Status')]

    const createRecordMock = vi.fn().mockResolvedValue(createRecord('r1', { Status: '进行中' }))

    const { result } = renderHook(() =>
      useDataGridEditingController({
        orderedFields: fields,
        fields,
        selectedTableId: 'table-1',
        useViewData: false,
        firstEditableField: 'Name',
        gridApiRef: {
          current: {
            getEditingCells: () => [],
            getFocusedCell: () => ({
              rowIndex: 0,
              field: 'Status',
            }),
            getDisplayedRowAtIndex: () => ({
              data: {
                id: '__draft_row__',
                row_id: '__draft_row__',
                __rowType: 'draft',
                Status: '进行中',
              },
            }),
          } as any,
        },
        viewStoreApi: {
          getState: () => ({
            currentViewRecords: { records: [] },
          }),
        },
        createRecord: createRecordMock,
        updateRecord: vi.fn().mockResolvedValue(null),
        refreshCurrentView: vi.fn().mockResolvedValue(undefined),
        startPolling: vi.fn(),
        checkIfTriggersAutoField: vi.fn().mockReturnValue([]),
        translate: (key: string) => key,
      })
    )

    await act(async () => {
      await result.current.handleCellValueChanged(
        {
          id: '__draft_row__',
          row_id: '__draft_row__',
          __rowType: 'draft',
        } as any,
        'Status',
        '进行中',
        ''
      )
    })

    act(() => {
      result.current.handleCellEditingStopped({
        data: {
          id: '__draft_row__',
          row_id: '__draft_row__',
          __rowType: 'draft',
        },
        reason: 'editor',
        colDef: {
          field: 'Status',
        },
      })
    })

    expect(createRecordMock).not.toHaveBeenCalled()
    expect(result.current.draftRowData?.Status).toBe('进行中')
  })

  it('创建失败后再次提交应基于当前草稿重新推导分组上下文', async () => {
    const fields = [createField('f_name', 'Name'), createField('f_status', 'Status')]
    const addRowContext = {
      group_path: '进行中',
      group_values: { Status: '进行中' },
    }
    const buildDraftPrefillValuesMock = vi.fn().mockImplementation((ctx: any) => ctx?.group_values ?? {})
    const buildCreateOrderContextMock = vi.fn().mockImplementation((ctx: any) => ({
      position: 'end',
      group_values: ctx?.group_values,
    }))
    const createRecordMock = vi
      .fn()
      .mockRejectedValueOnce(new Error('create failed'))
      .mockResolvedValueOnce(createRecord('r1', { Name: 'Alice', Status: '已完成' }))

    const { result } = renderHook(() =>
      useDataGridEditingController({
        orderedFields: fields,
        fields,
        selectedTableId: 'table-1',
        useViewData: false,
        firstEditableField: 'Name',
        gridApiRef: {
          current: {
            getEditingCells: () => [],
            getFocusedCell: () => null,
          } as any,
        },
        viewStoreApi: {
          getState: () => ({
            currentViewRecords: { records: [] },
          }),
        },
        createRecord: createRecordMock,
        updateRecord: vi.fn().mockResolvedValue(null),
        refreshCurrentView: vi.fn().mockResolvedValue(undefined),
        startPolling: vi.fn(),
        checkIfTriggersAutoField: vi.fn().mockReturnValue([]),
        translate: (key: string) => key,
        buildDraftPrefillValues: buildDraftPrefillValuesMock,
        buildCreateRecordOrderContext: buildCreateOrderContextMock,
        resolveDraftAddRowContext: (draftRow) => ({
          group_values:
            typeof draftRow.Status === 'string'
              ? { Status: draftRow.Status }
              : undefined,
        }),
      })
    )

    act(() => {
      result.current.handleAddRowClick(addRowContext)
    })

    await act(async () => {
      await result.current.handleCellValueChanged(
        {
          id: '__draft_row__',
          row_id: '__draft_row__',
          __rowType: 'draft',
          Status: '进行中',
        } as any,
        'Name',
        'Alice',
        ''
      )
    })

    await act(async () => {
      await result.current.handleCommitDraftRow()
    })

    expect(result.current.draftAddRowContext).toEqual({
      group_values: { Status: '进行中' },
    })
    expect(result.current.draftRowData?.Status).toBe('进行中')

    await act(async () => {
      await result.current.handleCellValueChanged(
        {
          id: '__draft_row__',
          row_id: '__draft_row__',
          __rowType: 'draft',
          Name: 'Alice',
          Status: '进行中',
        } as any,
        'Status',
        '已完成',
        '进行中'
      )
    })

    await act(async () => {
      await result.current.handleCommitDraftRow()
    })

    expect(buildCreateOrderContextMock).toHaveBeenLastCalledWith({
      group_values: { Status: '已完成' },
    })
    expect(createRecordMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        order_context: {
          position: 'end',
          group_values: { Status: '已完成' },
        },
      })
    )
  })

  it('草稿编辑分组字段时应同步更新展示上下文', async () => {
    const fields = [createField('f_name', 'Name'), createField('f_status', 'Status')]

    const { result } = renderHook(() =>
      useDataGridEditingController({
        orderedFields: fields,
        fields,
        selectedTableId: 'table-1',
        useViewData: false,
        firstEditableField: 'Name',
        gridApiRef: {
          current: {
            getEditingCells: () => [],
            getFocusedCell: () => null,
          } as any,
        },
        viewStoreApi: {
          getState: () => ({
            currentViewRecords: { records: [] },
          }),
        },
        createRecord: vi.fn().mockResolvedValue(null),
        updateRecord: vi.fn().mockResolvedValue(null),
        refreshCurrentView: vi.fn().mockResolvedValue(undefined),
        startPolling: vi.fn(),
        checkIfTriggersAutoField: vi.fn().mockReturnValue([]),
        translate: (key: string) => key,
        buildDraftPrefillValues: (ctx) => ctx?.group_values ?? {},
        resolveDraftAddRowContext: (draftRow) => ({
          group_values:
            typeof draftRow.Status === 'string'
              ? { Status: draftRow.Status }
              : undefined,
        }),
      })
    )

    act(() => {
      result.current.handleAddRowClick({
        group_path: '进行中',
        group_values: { Status: '进行中' },
      })
    })

    await act(async () => {
      await result.current.handleCellValueChanged(
        {
          id: '__draft_row__',
          row_id: '__draft_row__',
          __rowType: 'draft',
          Status: '进行中',
        } as any,
        'Status',
        '已完成',
        '进行中'
      )
    })

    expect(result.current.draftAddRowContext).toEqual({
      group_values: { Status: '已完成' },
    })
  })

  it('draft 更新不应把 grid 事件里的其他行字段带进草稿', async () => {
    const fields = [
      createField('f_name', 'Name'),
      createField('f_status', 'Status'),
      createField('f_city', 'City'),
    ]
    const createRecordMock = vi.fn().mockResolvedValue(createRecord('r1', { Name: 'Alice' }))

    const { result } = renderHook(() =>
      useDataGridEditingController({
        orderedFields: fields,
        fields,
        selectedTableId: 'table-1',
        useViewData: false,
        firstEditableField: 'Name',
        gridApiRef: {
          current: {
            getEditingCells: () => [],
            getFocusedCell: () => null,
          } as any,
        },
        viewStoreApi: {
          getState: () => ({
            currentViewRecords: { records: [] },
          }),
        },
        createRecord: createRecordMock,
        updateRecord: vi.fn().mockResolvedValue(null),
        refreshCurrentView: vi.fn().mockResolvedValue(undefined),
        startPolling: vi.fn(),
        checkIfTriggersAutoField: vi.fn().mockReturnValue([]),
        translate: (key: string) => key,
      })
    )

    act(() => {
      result.current.handleAddRowClick()
    })

    await act(async () => {
      await result.current.handleCellValueChanged(
        {
          id: '__draft_row__',
          row_id: '__draft_row__',
          __rowType: 'draft',
          Name: 'Bob',
          Status: '来自其他行',
          City: '来自其他行',
        } as any,
        'Name',
        'Alice',
        ''
      )
    })

    expect(result.current.draftRowData).toEqual(
      expect.objectContaining({
        __recordId: '__draft_row__',
        __rowType: 'draft',
        Name: 'Alice',
      })
    )
    expect(result.current.draftRowData?.Status).toBeUndefined()
    expect(result.current.draftRowData?.City).toBeUndefined()

    await act(async () => {
      result.current.handleCellEditingStopped({
        data: {
          id: '__draft_row__',
          row_id: '__draft_row__',
          __rowType: 'draft',
        },
      })
    })

    await waitFor(() => {
      expect(createRecordMock).toHaveBeenCalledTimes(1)
    })
    expect(createRecordMock).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { f_name: 'Alice' },
        fields: { f_name: 'Alice' },
      })
    )
  })

  it('取消草稿后延后的 editor 回调不应复活草稿并创建记录', async () => {
    const fields = [createField('f_name', 'Name')]
    const createRecordMock = vi.fn().mockResolvedValue(createRecord('r1', { Name: 'Alice' }))

    const { result } = renderHook(() =>
      useDataGridEditingController({
        orderedFields: fields,
        fields,
        selectedTableId: 'table-1',
        useViewData: false,
        firstEditableField: 'Name',
        gridApiRef: {
          current: {
            getEditingCells: () => [],
            getFocusedCell: () => null,
          } as any,
        },
        viewStoreApi: {
          getState: () => ({
            currentViewRecords: { records: [] },
          }),
        },
        createRecord: createRecordMock,
        updateRecord: vi.fn().mockResolvedValue(null),
        refreshCurrentView: vi.fn().mockResolvedValue(undefined),
        startPolling: vi.fn(),
        checkIfTriggersAutoField: vi.fn().mockReturnValue([]),
        translate: (key: string) => key,
      })
    )

    act(() => {
      result.current.handleAddRowClick()
    })

    const staleHandleCellValueChanged = result.current.handleCellValueChanged
    const staleHandleCellEditingStopped = result.current.handleCellEditingStopped

    act(() => {
      result.current.handleCancelDraftRow()
    })

    await waitFor(() => {
      expect(result.current.draftRowData).toBeNull()
    })

    await act(async () => {
      await staleHandleCellValueChanged(
        {
          id: '__draft_row__',
          row_id: '__draft_row__',
          __rowType: 'draft',
        } as any,
        'Name',
        'Alice',
        ''
      )
    })

    act(() => {
      staleHandleCellEditingStopped({
        data: {
          id: '__draft_row__',
          row_id: '__draft_row__',
          __rowType: 'draft',
        },
      })
    })

    expect(result.current.draftRowData).toBeNull()
    expect(createRecordMock).not.toHaveBeenCalled()

    act(() => {
      result.current.handleAddRowClick()
    })

    await act(async () => {
      await result.current.handleCellValueChanged(
        {
          id: '__draft_row__',
          row_id: '__draft_row__',
          __rowType: 'draft',
        } as any,
        'Name',
        'Bob',
        ''
      )
    })

    act(() => {
      result.current.handleCellEditingStopped({
        data: {
          id: '__draft_row__',
          row_id: '__draft_row__',
          __rowType: 'draft',
        },
      })
    })

    await waitFor(() => {
      expect(createRecordMock).toHaveBeenCalledTimes(1)
    })
    expect(createRecordMock).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { f_name: 'Bob' },
        fields: { f_name: 'Bob' },
      })
    )
  })

  it('只有分组预填值时离开草稿不应创建记录', async () => {
    const fields = [createField('f_name', 'Name'), createField('f_status', 'Status')]
    const createRecordMock = vi.fn().mockResolvedValue(createRecord('r1', {
      Name: 'Alice',
      Status: 'completed',
    }))

    const { result } = renderHook(() =>
      useDataGridEditingController({
        orderedFields: fields,
        fields,
        selectedTableId: 'table-1',
        useViewData: false,
        firstEditableField: 'Name',
        gridApiRef: {
          current: {
            getEditingCells: () => [],
            getFocusedCell: () => null,
          } as any,
        },
        viewStoreApi: {
          getState: () => ({
            currentViewRecords: { records: [] },
          }),
        },
        createRecord: createRecordMock,
        updateRecord: vi.fn().mockResolvedValue(null),
        refreshCurrentView: vi.fn().mockResolvedValue(undefined),
        startPolling: vi.fn(),
        checkIfTriggersAutoField: vi.fn().mockReturnValue([]),
        translate: (key: string) => key,
        buildDraftPrefillValues: (ctx) => ctx?.group_values ?? {},
      })
    )

    act(() => {
      result.current.handleAddRowClick({
        group_values: {
          Status: 'completed',
        },
      })
    })

    expect(result.current.draftRowData?.Status).toBe('completed')

    act(() => {
      result.current.handleCellEditingStopped({
        data: {
          id: '__draft_row__',
          row_id: '__draft_row__',
          __rowType: 'draft',
        },
      })
    })

    await waitFor(() => {
      expect(result.current.draftRowData).toBeNull()
    })
    expect(createRecordMock).not.toHaveBeenCalled()

    act(() => {
      result.current.handleAddRowClick({
        group_values: {
          Status: 'completed',
        },
      })
    })

    await act(async () => {
      await result.current.handleCellValueChanged(
        {
          id: '__draft_row__',
          row_id: '__draft_row__',
          __rowType: 'draft',
        } as any,
        'Name',
        'Alice',
        ''
      )
    })

    act(() => {
      result.current.handleCellEditingStopped({
        data: {
          id: '__draft_row__',
          row_id: '__draft_row__',
          __rowType: 'draft',
        },
      })
    })

    await waitFor(() => {
      expect(createRecordMock).toHaveBeenCalledTimes(1)
    })
    expect(createRecordMock).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          f_name: 'Alice',
          f_status: 'completed',
        },
        fields: {
          f_name: 'Alice',
          f_status: 'completed',
        },
      })
    )
  })

  it('创建后补写失败时应显式提示，避免静默丢值', async () => {
    const fields = [createField('f_name', 'Name'), createField('f_city', 'City')]
    const notifyMock = vi.fn()

    let resolveCreate: ((value: TableRecord | null) => void) | null = null
    const createRecordMock = vi.fn().mockImplementation(
      () =>
        new Promise<TableRecord | null>(resolve => {
          resolveCreate = resolve
        })
    )
    const updateRecordMock = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(createRecord('r1', { Name: 'Alice', City: 'Shanghai' }))

    const { result } = renderHook(() =>
      useDataGridEditingController({
        orderedFields: fields,
        fields,
        selectedTableId: 'table-1',
        useViewData: false,
        firstEditableField: 'Name',
        gridApiRef: {
          current: {
            getEditingCells: () => [],
            getFocusedCell: () => null,
          } as any,
        },
        viewStoreApi: {
          getState: () => ({
            currentViewRecords: { records: [] },
          }),
        },
        createRecord: createRecordMock,
        updateRecord: updateRecordMock,
        refreshCurrentView: vi.fn().mockResolvedValue(undefined),
        startPolling: vi.fn(),
        checkIfTriggersAutoField: vi.fn().mockReturnValue([]),
        translate: (key: string) => key,
        notify: notifyMock,
      })
    )

    await act(async () => {
      await result.current.handleCellValueChanged(
        {
          id: '__draft_row__',
          row_id: '__draft_row__',
          __rowType: 'draft',
        } as any,
        'Name',
        'Alice',
        ''
      )
    })

    await act(async () => {
      void result.current.handleCommitDraftRow()
      await Promise.resolve()
    })

    await waitFor(() => {
      expect(createRecordMock).toHaveBeenCalledTimes(1)
    })

    await act(async () => {
      await result.current.handleCellValueChanged(
        {
          id: '__draft_row__',
          row_id: '__draft_row__',
          __rowType: 'draft',
        } as any,
        'City',
        'Shanghai',
        ''
      )
    })

    await act(async () => {
      resolveCreate?.(createRecord('r1', { Name: 'Alice' }))
      await Promise.resolve()
    })

    await waitFor(() => {
      expect(notifyMock).toHaveBeenCalled()
    })

    const patchFailedNotification = notifyMock.mock.calls
      .map(args => args[0])
      .find((notification: any) => notification?.title === 'table:record.createPatchFailedTitle')

    expect(patchFailedNotification).toBeTruthy()
    expect(patchFailedNotification.action).toBeUndefined()
    expect(updateRecordMock).toHaveBeenCalledTimes(1)
  })

  it('draft 提交中继续输入应在创建后补写，避免丢值', async () => {
    const fields = [createField('f_name', 'Name'), createField('f_city', 'City')]

    let resolveCreate: ((value: TableRecord | null) => void) | null = null
    const createRecordMock = vi.fn().mockImplementation(
      () =>
        new Promise<TableRecord | null>(resolve => {
          resolveCreate = resolve
        })
    )
    const updateRecordMock = vi.fn().mockResolvedValue(createRecord('r1', { Name: 'Alice', City: 'Shanghai' }))
    const refreshCurrentViewMock = vi.fn().mockResolvedValue(undefined)
    const startPollingMock = vi.fn()
    const checkIfTriggersAutoFieldMock = vi.fn().mockReturnValue([])

    const { result } = renderHook(() =>
      useDataGridEditingController({
        orderedFields: fields,
        fields,
        selectedTableId: 'table-1',
        useViewData: false,
        firstEditableField: 'Name',
        gridApiRef: {
          current: {
            getEditingCells: () => [],
            getFocusedCell: () => null,
          } as any,
        },
        viewStoreApi: {
          getState: () => ({
            currentViewRecords: { records: [] },
          }),
        },
        createRecord: createRecordMock,
        updateRecord: updateRecordMock,
        refreshCurrentView: refreshCurrentViewMock,
        startPolling: startPollingMock,
        checkIfTriggersAutoField: checkIfTriggersAutoFieldMock,
        translate: (key: string) => key,
      })
    )

    await act(async () => {
      await result.current.handleCellValueChanged(
        {
          id: '__draft_row__',
          row_id: '__draft_row__',
          __rowType: 'draft',
        } as any,
        'Name',
        'Alice',
        ''
      )
    })

    await act(async () => {
      result.current.handleCellEditingStopped({
        data: {
          id: '__draft_row__',
          row_id: '__draft_row__',
          __rowType: 'draft',
        },
      })
    })

    await waitFor(() => {
      expect(createRecordMock).toHaveBeenCalledTimes(1)
    })
    expect(createRecordMock).toHaveBeenCalledWith(
      expect.objectContaining({
        table_id: 'table-1',
        data: { f_name: 'Alice' },
        fields: { f_name: 'Alice' },
        fieldKeyType: 'id',
      })
    )

    await act(async () => {
      await result.current.handleCellValueChanged(
        {
          id: '__draft_row__',
          row_id: '__draft_row__',
          __rowType: 'draft',
        } as any,
        'City',
        'Shanghai',
        ''
      )
    })

    await act(async () => {
      resolveCreate?.(createRecord('r1', { Name: 'Alice' }))
      await Promise.resolve()
    })

    await waitFor(() => {
      expect(updateRecordMock).toHaveBeenCalledTimes(1)
    })
    expect(updateRecordMock).toHaveBeenCalledWith(
      'r1',
      expect.objectContaining({
        data: { f_city: 'Shanghai' },
        fields: { f_city: 'Shanghai' },
        fieldKeyType: 'id',
      })
    )
    expect(startPollingMock).not.toHaveBeenCalled()
  })

  it('提交已清空本地 draft 后，延后的同值 blur 回调不应重新拉起草稿', async () => {
    vi.useFakeTimers()

    let resolveRefresh: (() => void) | null = null
    const fields = [createField('f_name', 'Name')]
    const createRecordMock = vi.fn().mockResolvedValue(createRecord('r1', { Name: 'Alice' }))
    const refreshCurrentViewMock = vi.fn().mockImplementation(
      () =>
        new Promise<void>(resolve => {
          resolveRefresh = resolve
        })
    )

    const { result } = renderHook(() =>
      useDataGridEditingController({
        orderedFields: fields,
        fields,
        selectedTableId: 'table-1',
        useViewData: true,
        firstEditableField: 'Name',
        gridApiRef: {
          current: {
            getEditingCells: () => [],
            getFocusedCell: () => null,
          } as any,
        },
        viewStoreApi: {
          getState: () => ({
            currentViewRecords: {
              records: [{ id: 'r1' }],
            },
          }),
        },
        createRecord: createRecordMock,
        updateRecord: vi.fn().mockResolvedValue(null),
        refreshCurrentView: refreshCurrentViewMock,
        startPolling: vi.fn(),
        checkIfTriggersAutoField: vi.fn().mockReturnValue([]),
        translate: (key: string) => key,
      })
    )

    await act(async () => {
      await result.current.handleCellValueChanged(
        {
          id: '__draft_row__',
          row_id: '__draft_row__',
          __rowType: 'draft',
        } as any,
        'Name',
        'Alice',
        ''
      )
    })

    await act(async () => {
      await vi.advanceTimersByTimeAsync(600)
    })

    let commitPromise: Promise<void> | undefined
    await act(async () => {
      commitPromise = result.current.handleCommitDraftRow()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(createRecordMock).toHaveBeenCalledTimes(1)
    expect(refreshCurrentViewMock).toHaveBeenCalledTimes(1)
    expect(result.current.draftRowData).toBeNull()

    await act(async () => {
      await result.current.handleCellValueChanged(
        {
          id: '__draft_row__',
          row_id: '__draft_row__',
          __rowType: 'draft',
        } as any,
        'Name',
        'Alice',
        ''
      )
    })

    expect(result.current.draftRowData).toBeNull()

    await act(async () => {
      resolveRefresh?.()
      await Promise.resolve()
      await commitPromise
    })

    vi.useRealTimers()
  })

  it('create 返回后补写进行中继续输入也应在下一轮补写，避免丢值', async () => {
    const fields = [
      createField('f_name', 'Name'),
      createField('f_city', 'City'),
      createField('f_country', 'Country'),
    ]

    let resolveCreate: ((value: TableRecord | null) => void) | null = null
    let resolveFirstPatch: ((value: TableRecord | null) => void) | null = null
    const createRecordMock = vi.fn().mockImplementation(
      () =>
        new Promise<TableRecord | null>(resolve => {
          resolveCreate = resolve
        })
    )
    const updateRecordMock = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<TableRecord | null>(resolve => {
            resolveFirstPatch = resolve
          })
      )
      .mockResolvedValueOnce(
        createRecord('r1', {
          Name: 'Alice',
          City: 'Shanghai',
          Country: 'China',
        })
      )

    const { result } = renderHook(() =>
      useDataGridEditingController({
        orderedFields: fields,
        fields,
        selectedTableId: 'table-1',
        useViewData: false,
        firstEditableField: 'Name',
        gridApiRef: {
          current: {
            getEditingCells: () => [],
            getFocusedCell: () => null,
          } as any,
        },
        viewStoreApi: {
          getState: () => ({
            currentViewRecords: { records: [] },
          }),
        },
        createRecord: createRecordMock,
        updateRecord: updateRecordMock,
        refreshCurrentView: vi.fn().mockResolvedValue(undefined),
        startPolling: vi.fn(),
        checkIfTriggersAutoField: vi.fn().mockReturnValue([]),
        translate: (key: string) => key,
      })
    )

    await act(async () => {
      await result.current.handleCellValueChanged(
        {
          id: '__draft_row__',
          row_id: '__draft_row__',
          __rowType: 'draft',
        } as any,
        'Name',
        'Alice',
        ''
      )
    })

    await act(async () => {
      result.current.handleCellEditingStopped({
        data: {
          id: '__draft_row__',
          row_id: '__draft_row__',
          __rowType: 'draft',
        },
      })
    })

    await waitFor(() => {
      expect(createRecordMock).toHaveBeenCalledTimes(1)
    })

    await act(async () => {
      await result.current.handleCellValueChanged(
        {
          id: '__draft_row__',
          row_id: '__draft_row__',
          __rowType: 'draft',
        } as any,
        'City',
        'Shanghai',
        ''
      )
    })

    await act(async () => {
      resolveCreate?.(createRecord('r1', { Name: 'Alice' }))
      await Promise.resolve()
    })

    await waitFor(() => {
      expect(updateRecordMock).toHaveBeenCalledTimes(1)
    })

    await act(async () => {
      await result.current.handleCellValueChanged(
        {
          id: '__draft_row__',
          row_id: '__draft_row__',
          __rowType: 'draft',
        } as any,
        'Country',
        'China',
        ''
      )
    })

    await act(async () => {
      resolveFirstPatch?.(createRecord('r1', { Name: 'Alice', City: 'Shanghai' }))
      await Promise.resolve()
    })

    await waitFor(() => {
      expect(updateRecordMock).toHaveBeenCalledTimes(2)
    })

    expect(updateRecordMock).toHaveBeenNthCalledWith(
      1,
      'r1',
      expect.objectContaining({
        data: { f_city: 'Shanghai' },
      })
    )
    expect(updateRecordMock).toHaveBeenNthCalledWith(
      2,
      'r1',
      expect.objectContaining({
        data: { f_country: 'China' },
      })
    )
  })

  it('Ctrl/Cmd + Enter 应触发草稿提交', async () => {
    const fields = [createField('f_name', 'Name')]
    const preventDefault = vi.fn()

    const createRecordMock = vi.fn().mockResolvedValue(createRecord('r1', { Name: 'Alice' }))
    const updateRecordMock = vi.fn().mockResolvedValue(null)

    const { result } = renderHook(() =>
      useDataGridEditingController({
        orderedFields: fields,
        fields,
        selectedTableId: 'table-1',
        useViewData: false,
        firstEditableField: 'Name',
        gridApiRef: {
          current: {
            getEditingCells: () => [],
            getFocusedCell: () => null,
            stopEditing: vi.fn(),
          } as any,
        },
        viewStoreApi: {
          getState: () => ({
            currentViewRecords: { records: [] },
          }),
        },
        createRecord: createRecordMock,
        updateRecord: updateRecordMock,
        refreshCurrentView: vi.fn().mockResolvedValue(undefined),
        startPolling: vi.fn(),
        checkIfTriggersAutoField: vi.fn().mockReturnValue([]),
        translate: (key: string) => key,
      })
    )

    await act(async () => {
      await result.current.handleCellValueChanged(
        {
          id: '__draft_row__',
          row_id: '__draft_row__',
          __rowType: 'draft',
        } as any,
        'Name',
        'Alice',
        ''
      )
    })

    act(() => {
      result.current.handleDraftShortcutKeyDown({
        key: 'Enter',
        ctrlKey: true,
        preventDefault,
      })
    })

    await waitFor(() => {
      expect(createRecordMock).toHaveBeenCalledTimes(1)
    })
    expect(preventDefault).toHaveBeenCalled()
  })

  it('草稿行普通 Enter（非 Shift）应提交整行并阻断事件继续传播', async () => {
    const fields = [createField('f_name', 'Name')]
    const preventDefault = vi.fn()
    const stopPropagation = vi.fn()
    const stopEditing = vi.fn()
    const clearFocusedCell = vi.fn()

    const createRecordMock = vi.fn().mockResolvedValue(createRecord('r1', { Name: 'Alice' }))

    const { result } = renderHook(() =>
      useDataGridEditingController({
        orderedFields: fields,
        fields,
        selectedTableId: 'table-1',
        useViewData: false,
        firstEditableField: 'Name',
        gridApiRef: {
          current: {
            getEditingCells: () => [{ rowIndex: 0, rowPinned: null, field: 'Name' }],
            getFocusedCell: () => null,
            stopEditing,
            clearFocusedCell,
          } as any,
        },
        viewStoreApi: {
          getState: () => ({
            currentViewRecords: { records: [] },
          }),
        },
        createRecord: createRecordMock,
        updateRecord: vi.fn().mockResolvedValue(null),
        refreshCurrentView: vi.fn().mockResolvedValue(undefined),
        startPolling: vi.fn(),
        checkIfTriggersAutoField: vi.fn().mockReturnValue([]),
        translate: (key: string) => key,
      })
    )

    await act(async () => {
      await result.current.handleCellValueChanged(
        {
          id: '__draft_row__',
          row_id: '__draft_row__',
          __rowType: 'draft',
        } as any,
        'Name',
        'Alice',
        ''
      )
    })

    act(() => {
      result.current.handleDraftShortcutKeyDown({
        key: 'Enter',
        preventDefault,
        stopPropagation,
      })
    })

    await waitFor(() => {
      expect(createRecordMock).toHaveBeenCalledTimes(1)
    })
    expect(preventDefault).toHaveBeenCalled()
    expect(stopPropagation).toHaveBeenCalled()
    // 编辑态下应先 stopEditing 把编辑器里的值刷进草稿再提交
    expect(stopEditing).toHaveBeenCalled()
    // 提交后不清焦点：isEditing 转 false 后编辑器即不可见，而新记录单元格的「选中态」
    // 由 onRecordCreated 设置；清焦点会把该选中态抹掉，故不应调用。
    expect(clearFocusedCell).not.toHaveBeenCalled()
  })

  it('草稿行 Shift+Enter 不应提交（留给编辑器换行）', async () => {
    const fields = [createField('f_name', 'Name')]
    const preventDefault = vi.fn()
    const stopPropagation = vi.fn()

    const createRecordMock = vi.fn().mockResolvedValue(createRecord('r1', { Name: 'Alice' }))

    const { result } = renderHook(() =>
      useDataGridEditingController({
        orderedFields: fields,
        fields,
        selectedTableId: 'table-1',
        useViewData: false,
        firstEditableField: 'Name',
        gridApiRef: {
          current: {
            getEditingCells: () => [{ rowIndex: 0, rowPinned: null, field: 'Name' }],
            getFocusedCell: () => null,
            stopEditing: vi.fn(),
          } as any,
        },
        viewStoreApi: {
          getState: () => ({
            currentViewRecords: { records: [] },
          }),
        },
        createRecord: createRecordMock,
        updateRecord: vi.fn().mockResolvedValue(null),
        refreshCurrentView: vi.fn().mockResolvedValue(undefined),
        startPolling: vi.fn(),
        checkIfTriggersAutoField: vi.fn().mockReturnValue([]),
        translate: (key: string) => key,
      })
    )

    await act(async () => {
      await result.current.handleCellValueChanged(
        {
          id: '__draft_row__',
          row_id: '__draft_row__',
          __rowType: 'draft',
        } as any,
        'Name',
        'Alice',
        ''
      )
    })

    act(() => {
      result.current.handleDraftShortcutKeyDown({
        key: 'Enter',
        shiftKey: true,
        preventDefault,
        stopPropagation,
      })
    })

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    expect(createRecordMock).not.toHaveBeenCalled()
    expect(preventDefault).not.toHaveBeenCalled()
    expect(stopPropagation).not.toHaveBeenCalled()
  })

  it('草稿行多行文本的普通 Enter 不应提交（留给编辑器换行）', async () => {
    const fields = [createField('f_notes', 'Notes', 'long_text')]
    const preventDefault = vi.fn()
    const stopPropagation = vi.fn()
    const createRecordMock = vi.fn().mockResolvedValue(createRecord('r1', { Notes: 'line 1' }))

    const { result } = renderHook(() =>
      useDataGridEditingController({
        orderedFields: fields,
        fields,
        selectedTableId: 'table-1',
        useViewData: false,
        firstEditableField: 'Notes',
        gridApiRef: {
          current: {
            getEditingCells: () => [{ rowIndex: 0, rowPinned: null, field: 'Notes' }],
            getFocusedCell: () => ({ rowIndex: 0, rowPinned: null, field: 'Notes' }),
            getDisplayedRowAtIndex: () => ({
              data: { id: '__draft_row__', row_id: '__draft_row__', __rowType: 'draft' },
            }),
            stopEditing: vi.fn(),
          } as any,
        },
        viewStoreApi: {
          getState: () => ({ currentViewRecords: { records: [] } }),
        },
        createRecord: createRecordMock,
        updateRecord: vi.fn().mockResolvedValue(null),
        refreshCurrentView: vi.fn().mockResolvedValue(undefined),
        startPolling: vi.fn(),
        checkIfTriggersAutoField: vi.fn().mockReturnValue([]),
        translate: (key: string) => key,
      })
    )

    act(() => result.current.handleAddRowClick())
    act(() => {
      result.current.handleDraftShortcutKeyDown({
        key: 'Enter',
        preventDefault,
        stopPropagation,
      })
    })

    expect(preventDefault).not.toHaveBeenCalled()
    expect(stopPropagation).not.toHaveBeenCalled()
    expect(createRecordMock).not.toHaveBeenCalled()
    expect(result.current.draftRowData?.__rowType).toBe('draft')
  })

  it('从空首列切到后续字段时保留新增草稿', () => {
    const fields = [
      createField('f_title', 'Title'),
      createField('f_notes', 'Notes', 'long_text'),
    ]
    const { result } = renderHook(() =>
      useDataGridEditingController({
        orderedFields: fields,
        fields,
        selectedTableId: 'table-1',
        useViewData: false,
        firstEditableField: 'Title',
        gridApiRef: {
          current: {
            getEditingCells: () => [],
            getFocusedCell: () => ({ rowIndex: 0, rowPinned: null, field: 'Notes' }),
            getDisplayedRowAtIndex: () => ({
              data: { id: '__draft_row__', row_id: '__draft_row__', __rowType: 'draft' },
            }),
            startEditingCell: vi.fn(),
          } as any,
        },
        viewStoreApi: {
          getState: () => ({ currentViewRecords: { records: [] } }),
        },
        createRecord: vi.fn().mockResolvedValue(null),
        updateRecord: vi.fn().mockResolvedValue(null),
        refreshCurrentView: vi.fn().mockResolvedValue(undefined),
        startPolling: vi.fn(),
        checkIfTriggersAutoField: vi.fn().mockReturnValue([]),
        translate: (key: string) => key,
      })
    )

    act(() => result.current.handleAddRowClick())
    act(() => {
      result.current.handleCellEditingStopped({
        data: { id: '__draft_row__', row_id: '__draft_row__', __rowType: 'draft' },
        reason: 'interaction',
        field: 'Title',
        colDef: { field: 'Title' },
      })
    })

    expect(result.current.draftRowData?.__rowType).toBe('draft')
  })

  it('Esc 在非编辑态应取消草稿', async () => {
    const fields = [createField('f_name', 'Name')]
    const preventDefault = vi.fn()

    const { result } = renderHook(() =>
      useDataGridEditingController({
        orderedFields: fields,
        fields,
        selectedTableId: 'table-1',
        useViewData: false,
        firstEditableField: 'Name',
        gridApiRef: {
          current: {
            getEditingCells: () => [],
            getFocusedCell: () => null,
          } as any,
        },
        viewStoreApi: {
          getState: () => ({
            currentViewRecords: { records: [] },
          }),
        },
        createRecord: vi.fn().mockResolvedValue(createRecord('r1', { Name: 'Alice' })),
        updateRecord: vi.fn().mockResolvedValue(null),
        refreshCurrentView: vi.fn().mockResolvedValue(undefined),
        startPolling: vi.fn(),
        checkIfTriggersAutoField: vi.fn().mockReturnValue([]),
        translate: (key: string) => key,
      })
    )

    await act(async () => {
      await result.current.handleCellValueChanged(
        {
          id: '__draft_row__',
          row_id: '__draft_row__',
          __rowType: 'draft',
        } as any,
        'Name',
        'Alice',
        ''
      )
    })

    act(() => {
      result.current.handleDraftShortcutKeyDown({
        key: 'Escape',
        preventDefault,
      })
    })

    expect(preventDefault).toHaveBeenCalled()
    expect(result.current.draftRowData).toBeNull()
  })

  it('无草稿时 Ctrl/Cmd + Enter 应创建草稿行', () => {
    const fields = [createField('f_name', 'Name')]
    const preventDefault = vi.fn()
    const startEditingCell = vi.fn()

    const { result } = renderHook(() =>
      useDataGridEditingController({
        orderedFields: fields,
        fields,
        selectedTableId: 'table-1',
        useViewData: false,
        firstEditableField: 'Name',
        gridApiRef: {
          current: {
            getEditingCells: () => [],
            getFocusedCell: () => null,
            getPinnedBottomRowCount: () => 1,
            getPinnedBottomRow: () => ({
              data: {
                id: '__add_row__',
                row_id: '__add_row__',
                __rowType: 'add',
              },
            }),
            startEditingCell,
          } as any,
        },
        viewStoreApi: {
          getState: () => ({
            currentViewRecords: { records: [] },
          }),
        },
        createRecord: vi.fn().mockResolvedValue(createRecord('r1', { Name: 'Alice' })),
        updateRecord: vi.fn().mockResolvedValue(null),
        refreshCurrentView: vi.fn().mockResolvedValue(undefined),
        startPolling: vi.fn(),
        checkIfTriggersAutoField: vi.fn().mockReturnValue([]),
        translate: (key: string) => key,
      })
    )

    act(() => {
      result.current.handleDraftShortcutKeyDown({
        key: 'Enter',
        ctrlKey: true,
        preventDefault,
      })
    })

    expect(preventDefault).toHaveBeenCalled()
    expect(result.current.draftRowData?.__rowType).toBe('draft')
  })

  it('焦点在 add 行时 Enter 应创建草稿行', () => {
    const fields = [createField('f_name', 'Name')]
    const preventDefault = vi.fn()
    const startEditingCell = vi.fn()

    const { result } = renderHook(() =>
      useDataGridEditingController({
        orderedFields: fields,
        fields,
        selectedTableId: 'table-1',
        useViewData: false,
        firstEditableField: 'Name',
        gridApiRef: {
          current: {
            getEditingCells: () => [],
            getFocusedCell: () => ({
              rowPinned: 'bottom',
              rowIndex: 0,
            }),
            getPinnedBottomRowCount: () => 1,
            getPinnedBottomRow: () => ({
              data: {
                id: '__add_row__',
                row_id: '__add_row__',
                __rowType: 'add',
              },
            }),
            startEditingCell,
          } as any,
        },
        viewStoreApi: {
          getState: () => ({
            currentViewRecords: { records: [] },
          }),
        },
        createRecord: vi.fn().mockResolvedValue(createRecord('r1', { Name: 'Alice' })),
        updateRecord: vi.fn().mockResolvedValue(null),
        refreshCurrentView: vi.fn().mockResolvedValue(undefined),
        startPolling: vi.fn(),
        checkIfTriggersAutoField: vi.fn().mockReturnValue([]),
        translate: (key: string) => key,
      })
    )

    act(() => {
      result.current.handleDraftShortcutKeyDown({
        key: 'Enter',
        preventDefault,
      })
    })

    expect(preventDefault).toHaveBeenCalled()
    expect(result.current.draftRowData?.__rowType).toBe('draft')
  })

  it('焦点在分组 add 行时 Enter 应带上下文创建草稿', () => {
    const fields = [createField('f_name', 'Name'), createField('f_status', 'Status')]
    const preventDefault = vi.fn()
    const buildDraftPrefillValuesMock = vi.fn().mockImplementation((ctx: any) => ({
      Status: ctx?.group_values?.Status,
    }))

    const { result } = renderHook(() =>
      useDataGridEditingController({
        orderedFields: fields,
        fields,
        selectedTableId: 'table-1',
        useViewData: false,
        firstEditableField: 'Name',
        gridApiRef: {
          current: {
            getEditingCells: () => [],
            getFocusedCell: () => ({
              rowIndex: 1,
            }),
            getDisplayedRowAtIndex: () => ({
              data: {
                id: '__group_add__todo',
                row_id: '__group_add__todo',
                __rowType: 'group_add',
                __groupPath: 'Todo',
                __groupValues: {
                  Status: 'Todo',
                },
              },
            }),
            getPinnedBottomRowCount: () => 0,
            startEditingCell: vi.fn(),
          } as any,
        },
        viewStoreApi: {
          getState: () => ({
            currentViewRecords: { records: [] },
          }),
        },
        createRecord: vi.fn().mockResolvedValue(createRecord('r1', { Name: 'Alice' })),
        updateRecord: vi.fn().mockResolvedValue(null),
        refreshCurrentView: vi.fn().mockResolvedValue(undefined),
        startPolling: vi.fn(),
        checkIfTriggersAutoField: vi.fn().mockReturnValue([]),
        translate: (key: string) => key,
        buildDraftPrefillValues: buildDraftPrefillValuesMock,
      })
    )

    act(() => {
      result.current.handleDraftShortcutKeyDown({
        key: 'Enter',
        preventDefault,
      })
    })

    expect(preventDefault).toHaveBeenCalled()
    expect(buildDraftPrefillValuesMock).toHaveBeenCalledWith({
      group_path: 'Todo',
      group_values: {
        Status: 'Todo',
      },
    })
    expect(result.current.draftAddRowContext).toEqual({
      group_path: 'Todo',
      group_values: {
        Status: 'Todo',
      },
    })
    expect(result.current.draftRowData?.Status).toBe('Todo')
  })

  it('焦点在折叠组头时 Enter 应带分组上下文创建草稿', () => {
    const fields = [createField('f_name', 'Name'), createField('f_status', 'Status')]
    const preventDefault = vi.fn()
    const buildDraftPrefillValuesMock = vi.fn().mockImplementation((ctx: any) => ({
      Status: ctx?.group_values?.Status,
    }))

    const { result } = renderHook(() =>
      useDataGridEditingController({
        orderedFields: fields,
        fields,
        selectedTableId: 'table-1',
        useViewData: false,
        firstEditableField: 'Name',
        gridApiRef: {
          current: {
            getEditingCells: () => [],
            getFocusedCell: () => ({
              rowIndex: 0,
            }),
            getDisplayedRowAtIndex: () => ({
              data: {
                id: '__group__todo',
                __rowType: 'group_header',
                __groupCollapsed: true,
                __groupPath: 'Todo',
                __groupValues: {
                  Status: 'Todo',
                },
              },
            }),
            getPinnedBottomRowCount: () => 0,
            startEditingCell: vi.fn(),
          } as any,
        },
        viewStoreApi: {
          getState: () => ({
            currentViewRecords: { records: [] },
          }),
        },
        createRecord: vi.fn().mockResolvedValue(createRecord('r1', { Name: 'Alice' })),
        updateRecord: vi.fn().mockResolvedValue(null),
        refreshCurrentView: vi.fn().mockResolvedValue(undefined),
        startPolling: vi.fn(),
        checkIfTriggersAutoField: vi.fn().mockReturnValue([]),
        translate: (key: string) => key,
        buildDraftPrefillValues: buildDraftPrefillValuesMock,
      })
    )

    act(() => {
      result.current.handleDraftShortcutKeyDown({
        key: 'Enter',
        preventDefault,
      })
    })

    expect(preventDefault).toHaveBeenCalled()
    expect(buildDraftPrefillValuesMock).toHaveBeenCalledWith({
      group_path: 'Todo',
      group_values: {
        Status: 'Todo',
      },
    })
    expect(result.current.draftAddRowContext).toEqual({
      group_path: 'Todo',
      group_values: {
        Status: 'Todo',
      },
    })
    expect(result.current.draftRowData?.Status).toBe('Todo')
  })

  it('焦点在未折叠组头时 Enter 不应创建草稿', () => {
    const fields = [createField('f_name', 'Name'), createField('f_status', 'Status')]
    const preventDefault = vi.fn()

    const { result } = renderHook(() =>
      useDataGridEditingController({
        orderedFields: fields,
        fields,
        selectedTableId: 'table-1',
        useViewData: false,
        firstEditableField: 'Name',
        gridApiRef: {
          current: {
            getEditingCells: () => [],
            getFocusedCell: () => ({
              rowIndex: 0,
            }),
            getDisplayedRowAtIndex: () => ({
              data: {
                id: '__group__todo',
                __rowType: 'group_header',
                __groupCollapsed: false,
                __groupPath: 'Todo',
                __groupValues: {
                  Status: 'Todo',
                },
              },
            }),
            getPinnedBottomRowCount: () => 0,
            startEditingCell: vi.fn(),
          } as any,
        },
        viewStoreApi: {
          getState: () => ({
            currentViewRecords: { records: [] },
          }),
        },
        createRecord: vi.fn().mockResolvedValue(createRecord('r1', { Name: 'Alice' })),
        updateRecord: vi.fn().mockResolvedValue(null),
        refreshCurrentView: vi.fn().mockResolvedValue(undefined),
        startPolling: vi.fn(),
        checkIfTriggersAutoField: vi.fn().mockReturnValue([]),
        translate: (key: string) => key,
        buildDraftPrefillValues: vi.fn(),
      })
    )

    act(() => {
      result.current.handleDraftShortcutKeyDown({
        key: 'Enter',
        preventDefault,
      })
    })

    expect(preventDefault).not.toHaveBeenCalled()
    expect(result.current.draftRowData).toBeNull()
    expect(result.current.draftAddRowContext).toBeNull()
  })

  it('创建草稿时应应用预填充字段', () => {
    const fields = [createField('f_name', 'Name'), createField('f_status', 'Status')]

    const { result } = renderHook(() =>
      useDataGridEditingController({
        orderedFields: fields,
        fields,
        selectedTableId: 'table-1',
        useViewData: false,
        firstEditableField: 'Name',
        gridApiRef: {
          current: {
            getEditingCells: () => [],
            getFocusedCell: () => null,
            getPinnedBottomRowCount: () => 1,
            getPinnedBottomRow: () => ({
              data: {
                id: '__add_row__',
                row_id: '__add_row__',
                __rowType: 'add',
              },
            }),
            startEditingCell: vi.fn(),
          } as any,
        },
        viewStoreApi: {
          getState: () => ({
            currentViewRecords: { records: [] },
          }),
        },
        createRecord: vi.fn().mockResolvedValue(createRecord('r1', { Name: 'Alice' })),
        updateRecord: vi.fn().mockResolvedValue(null),
        refreshCurrentView: vi.fn().mockResolvedValue(undefined),
        startPolling: vi.fn(),
        checkIfTriggersAutoField: vi.fn().mockReturnValue([]),
        translate: (key: string) => key,
        buildDraftPrefillValues: () => ({
          Status: '进行中',
        }),
      })
    )

    act(() => {
      result.current.handleAddRowClick()
    })

    expect(result.current.draftRowData?.__rowType).toBe('draft')
    expect(result.current.draftRowData?.Status).toBe('进行中')
  })

  it('新增行双击触发的连续停编不应立即丢弃空草稿', () => {
    vi.useFakeTimers()
    try {
      const fields = [
        createField('f_name', 'Name', 'text', {
        }),
      ]
      const startEditingCellMock = vi.fn()
      const createRecordMock = vi.fn().mockResolvedValue(createRecord('r1', { Name: 'Alice' }))

      const { result } = renderHook(() =>
        useDataGridEditingController({
          orderedFields: fields,
          fields,
          selectedTableId: 'table-1',
          useViewData: false,
          firstEditableField: 'Name',
          gridApiRef: {
            current: {
              getEditingCells: () => [],
              getFocusedCell: () => null,
              getPinnedBottomRowCount: () => 1,
              getPinnedBottomRow: () => ({
                data: {
                  id: '__draft_row__',
                  row_id: '__draft_row__',
                  __rowType: 'draft',
                },
              }),
              startEditingCell: startEditingCellMock,
            } as any,
          },
          viewStoreApi: {
            getState: () => ({
              currentViewRecords: { records: [] },
            }),
          },
          createRecord: createRecordMock,
          updateRecord: vi.fn().mockResolvedValue(null),
          refreshCurrentView: vi.fn().mockResolvedValue(undefined),
          startPolling: vi.fn(),
          checkIfTriggersAutoField: vi.fn().mockReturnValue([]),
          translate: (key: string) => key,
        })
      )

      act(() => {
        result.current.handleAddRowClick()
      })

      expect(result.current.draftRowData?.__rowType).toBe('draft')

      act(() => {
        result.current.handleCellEditingStopped({
          data: {
            id: '__draft_row__',
            row_id: '__draft_row__',
            __rowType: 'draft',
          },
          reason: 'interaction',
          field: 'Name',
          colDef: {
            field: 'Name',
          },
        })
      })

      expect(result.current.draftRowData?.__rowType).toBe('draft')
      expect(startEditingCellMock).toHaveBeenCalled()
      expect(createRecordMock).not.toHaveBeenCalled()

      act(() => {
        result.current.handleCellEditingStopped({
          data: {
            id: '__draft_row__',
            row_id: '__draft_row__',
            __rowType: 'draft',
          },
        })
      })

      expect(result.current.draftRowData?.__rowType).toBe('draft')
      expect(createRecordMock).not.toHaveBeenCalled()

      act(() => {
        vi.advanceTimersByTime(600)
      })
      act(() => {
        result.current.handleCellEditingStopped({
          data: {
            id: '__draft_row__',
            row_id: '__draft_row__',
            __rowType: 'draft',
          },
        })
      })

      expect(result.current.draftRowData).toBeNull()
      expect(createRecordMock).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('新增行保护窗口过后首次 interaction 停编应丢弃空草稿', () => {
    vi.useFakeTimers()
    try {
      const fields = [
        createField('f_name', 'Name', 'text', {
        }),
      ]
      const createRecordMock = vi.fn().mockResolvedValue(createRecord('r1', { Name: 'Alice' }))

      const { result } = renderHook(() =>
        useDataGridEditingController({
          orderedFields: fields,
          fields,
          selectedTableId: 'table-1',
          useViewData: false,
          firstEditableField: 'Name',
          gridApiRef: {
            current: {
              getEditingCells: () => [],
              getFocusedCell: () => null,
              getPinnedBottomRowCount: () => 1,
              getPinnedBottomRow: () => ({
                data: {
                  id: '__draft_row__',
                  row_id: '__draft_row__',
                  __rowType: 'draft',
                },
              }),
              startEditingCell: vi.fn(),
            } as any,
          },
          viewStoreApi: {
            getState: () => ({
              currentViewRecords: { records: [] },
            }),
          },
          createRecord: createRecordMock,
          updateRecord: vi.fn().mockResolvedValue(null),
          refreshCurrentView: vi.fn().mockResolvedValue(undefined),
          startPolling: vi.fn(),
          checkIfTriggersAutoField: vi.fn().mockReturnValue([]),
          translate: (key: string) => key,
        })
      )

      act(() => {
        result.current.handleAddRowClick()
      })

      act(() => {
        vi.advanceTimersByTime(600)
      })
      act(() => {
        result.current.handleCellEditingStopped({
          data: {
            id: '__draft_row__',
            row_id: '__draft_row__',
            __rowType: 'draft',
          },
          reason: 'interaction',
          field: 'Name',
          colDef: {
            field: 'Name',
          },
        })
      })

      expect(result.current.draftRowData).toBeNull()
      expect(createRecordMock).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('新增草稿保护窗口内已有编辑时仍应正常提交', async () => {
    const fields = [
      createField('f_name', 'Name', 'text', {
      }),
    ]
    const createRecordMock = vi.fn().mockResolvedValue(createRecord('r1', { Name: 'Alice' }))

    const { result } = renderHook(() =>
      useDataGridEditingController({
        orderedFields: fields,
        fields,
        selectedTableId: 'table-1',
        useViewData: false,
        firstEditableField: 'Name',
        gridApiRef: {
          current: {
            getEditingCells: () => [],
            getFocusedCell: () => null,
            getPinnedBottomRowCount: () => 1,
            getPinnedBottomRow: () => ({
              data: {
                id: '__draft_row__',
                row_id: '__draft_row__',
                __rowType: 'draft',
                Name: 'Alice',
              },
            }),
            startEditingCell: vi.fn(),
          } as any,
        },
        viewStoreApi: {
          getState: () => ({
            currentViewRecords: { records: [] },
          }),
        },
        createRecord: createRecordMock,
        updateRecord: vi.fn().mockResolvedValue(null),
        refreshCurrentView: vi.fn().mockResolvedValue(undefined),
        startPolling: vi.fn(),
        checkIfTriggersAutoField: vi.fn().mockReturnValue([]),
        translate: (key: string) => key,
      })
    )

    act(() => {
      result.current.handleAddRowClick()
    })

    await act(async () => {
      await result.current.handleCellValueChanged(
        {
          id: '__draft_row__',
          row_id: '__draft_row__',
          __rowType: 'draft',
        } as any,
        'Name',
        'Alice',
        ''
      )
    })

    act(() => {
      result.current.handleCellEditingStopped({
        data: {
          id: '__draft_row__',
          row_id: '__draft_row__',
          __rowType: 'draft',
          Name: 'Alice',
        },
        reason: 'interaction',
        field: 'Name',
        colDef: {
          field: 'Name',
        },
      })
    })

    await waitFor(() => {
      expect(createRecordMock).toHaveBeenCalledTimes(1)
    })
    expect(createRecordMock).toHaveBeenCalledWith(
      expect.objectContaining({
        table_id: 'table-1',
        data: { f_name: 'Alice' },
        fields: { f_name: 'Alice' },
        fieldKeyType: 'id',
      })
    )
  })

  it('#5859 分组预填后 Enter 显式提交应创建（无需再改其它字段）', async () => {
    const fields = [createField('f_name', 'Name'), createField('f_status', 'Status')]
    const createRecordMock = vi.fn().mockResolvedValue(
      createRecord('r1', { Name: '', Status: '进行中' }),
    )
    const stopEditingMock = vi.fn()

    const { result } = renderHook(() =>
      useDataGridEditingController({
        orderedFields: fields,
        fields,
        selectedTableId: 'table-1',
        useViewData: false,
        firstEditableField: 'Name',
        gridApiRef: {
          current: {
            getEditingCells: () => [{ rowIndex: 0, colKey: 'Status' }],
            getFocusedCell: () => null,
            stopEditing: stopEditingMock,
          } as any,
        },
        viewStoreApi: {
          getState: () => ({
            currentViewRecords: { records: [] },
          }),
        },
        createRecord: createRecordMock,
        updateRecord: vi.fn().mockResolvedValue(null),
        refreshCurrentView: vi.fn().mockResolvedValue(undefined),
        startPolling: vi.fn(),
        checkIfTriggersAutoField: vi.fn().mockReturnValue([]),
        translate: (key: string) => key,
        buildDraftPrefillValues: (ctx) => ctx?.group_values ?? {},
        buildCreateRecordOrderContext: (ctx) => ({
          position: 'end',
          group_values: ctx?.group_values,
        }),
        resolveDraftAddRowContext: (draftRow, addRowContext) => ({
          group_values:
            typeof draftRow.Status === 'string'
              ? { Status: draftRow.Status }
              : addRowContext?.group_values,
        }),
      }),
    )

    act(() => {
      result.current.handleAddRowClick({
        group_path: '进行中',
        group_values: { Status: '进行中' },
      })
    })

    expect(result.current.draftRowData?.Status).toBe('进行中')

    await act(async () => {
      result.current.handleDraftShortcutKeyDown({
        key: 'Enter',
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
      })
      // stopEditing 同步触发的 editingStopped 不得清掉仅预填草稿
      result.current.handleCellEditingStopped({
        data: {
          id: '__draft_row__',
          row_id: '__draft_row__',
          __rowType: 'draft',
          Status: '进行中',
        },
        reason: 'api',
        colDef: { field: 'Status' },
      })
      await Promise.resolve()
    })

    expect(stopEditingMock).toHaveBeenCalled()
    expect(createRecordMock).toHaveBeenCalledWith(
      expect.objectContaining({
        table_id: 'table-1',
        data: { f_status: '进行中' },
        fields: { f_status: '进行中' },
        fieldKeyType: 'id',
        order_context: expect.objectContaining({
          group_values: { Status: '进行中' },
        }),
      }),
    )
  })

  it('分组预填值新增行双击触发的连续停编不应立即丢弃未编辑草稿', () => {
    vi.useFakeTimers()
    try {
      const fields = [
        createField('f_name', 'Name', 'text', {
        }),
        createField('f_status', 'Status'),
      ]
      const startEditingCellMock = vi.fn()
      const createRecordMock = vi.fn().mockResolvedValue(createRecord('r1', {
        Name: 'Alice',
        Status: 'Todo',
      }))

      const { result } = renderHook(() =>
        useDataGridEditingController({
          orderedFields: fields,
          fields,
          selectedTableId: 'table-1',
          useViewData: false,
          firstEditableField: 'Name',
          gridApiRef: {
            current: {
              getEditingCells: () => [],
              getFocusedCell: () => null,
              getPinnedBottomRowCount: () => 1,
              getPinnedBottomRow: () => ({
                data: {
                  id: '__draft_row__',
                  row_id: '__draft_row__',
                  __rowType: 'draft',
                  Status: 'Todo',
                },
              }),
              startEditingCell: startEditingCellMock,
            } as any,
          },
          viewStoreApi: {
            getState: () => ({
              currentViewRecords: { records: [] },
            }),
          },
          createRecord: createRecordMock,
          updateRecord: vi.fn().mockResolvedValue(null),
          refreshCurrentView: vi.fn().mockResolvedValue(undefined),
          startPolling: vi.fn(),
          checkIfTriggersAutoField: vi.fn().mockReturnValue([]),
          translate: (key: string) => key,
          buildDraftPrefillValues: (ctx) => ctx?.group_values ?? {},
        })
      )

      act(() => {
        result.current.handleAddRowClick({
          group_path: 'Todo',
          group_values: { Status: 'Todo' },
        })
      })

      expect(result.current.draftRowData).toEqual(
        expect.objectContaining({
          __rowType: 'draft',
          Status: 'Todo',
        })
      )

      act(() => {
        result.current.handleCellEditingStopped({
          data: {
            id: '__draft_row__',
            row_id: '__draft_row__',
            __rowType: 'draft',
            Status: 'Todo',
          },
          reason: 'interaction',
          field: 'Name',
          colDef: {
            field: 'Name',
          },
        })
      })

      expect(result.current.draftRowData).toEqual(
        expect.objectContaining({
          __rowType: 'draft',
          Status: 'Todo',
        })
      )
      expect(startEditingCellMock).toHaveBeenCalled()
      expect(createRecordMock).not.toHaveBeenCalled()

      act(() => {
        result.current.handleCellEditingStopped({
          data: {
            id: '__draft_row__',
            row_id: '__draft_row__',
            __rowType: 'draft',
            Status: 'Todo',
          },
        })
      })

      expect(result.current.draftRowData).toEqual(
        expect.objectContaining({
          __rowType: 'draft',
          Status: 'Todo',
        })
      )
      expect(createRecordMock).not.toHaveBeenCalled()

      act(() => {
        vi.advanceTimersByTime(600)
      })
      act(() => {
        result.current.handleCellEditingStopped({
          data: {
            id: '__draft_row__',
            row_id: '__draft_row__',
            __rowType: 'draft',
            Status: 'Todo',
          },
        })
      })

      expect(result.current.draftRowData).toBeNull()
      expect(createRecordMock).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('提交草稿时应透传 order_context', async () => {
    const fields = [createField('f_name', 'Name')]

    const createRecordMock = vi.fn().mockResolvedValue(createRecord('r1', { Name: 'Alice' }))
    const orderContext = {
      view_id: 'view-1',
      anchor_record_id: 'record-anchor-1',
      position: 'after' as const,
      group_values: { Status: '进行中' },
    }
    const suppliedOrderContext = {
      view_id: 'view-1',
      anchor_record_id: 'record-anchor-2',
      position: 'before' as const,
    }

    const { result } = renderHook(() =>
      useDataGridEditingController({
        orderedFields: fields,
        fields,
        selectedTableId: 'table-1',
        useViewData: false,
        firstEditableField: 'Name',
        gridApiRef: {
          current: {
            getEditingCells: () => [],
            getFocusedCell: () => null,
          } as any,
        },
        viewStoreApi: {
          getState: () => ({
            currentViewRecords: { records: [] },
          }),
        },
        createRecord: createRecordMock,
        updateRecord: vi.fn().mockResolvedValue(null),
        refreshCurrentView: vi.fn().mockResolvedValue(undefined),
        startPolling: vi.fn(),
        checkIfTriggersAutoField: vi.fn().mockReturnValue([]),
        translate: (key: string) => key,
        buildCreateRecordOrderContext: () => orderContext,
      })
    )

    act(() => {
      result.current.handleAddRowClick({ order_context: suppliedOrderContext })
    })

    await act(async () => {
      await result.current.handleCellValueChanged(
        {
          id: '__draft_row__',
          row_id: '__draft_row__',
          __rowType: 'draft',
        } as any,
        'Name',
        'Alice',
        ''
      )
    })

    await act(async () => {
      await result.current.handleCommitDraftRow()
    })

    await waitFor(() => {
      expect(createRecordMock).toHaveBeenCalledTimes(1)
    })
    expect(createRecordMock).toHaveBeenCalledWith(
      expect.objectContaining({
        table_id: 'table-1',
        data: { f_name: 'Alice' },
        fields: { f_name: 'Alice' },
        fieldKeyType: 'id',
        order_context: suppliedOrderContext,
      })
    )
  })

  it('视图过滤导致记录不可见时应提供查看动作', async () => {
    const fields = [createField('f_name', 'Name')]

    const createRecordMock = vi.fn().mockResolvedValue(createRecord('r-hidden', { Name: 'Alice' }))
    const notifyMock = vi.fn()
    const onRevealHiddenRecordMock = vi.fn()

    const { result } = renderHook(() =>
      useDataGridEditingController({
        orderedFields: fields,
        fields,
        selectedTableId: 'table-1',
        useViewData: true,
        firstEditableField: 'Name',
        gridApiRef: {
          current: {
            getEditingCells: () => [],
            getFocusedCell: () => null,
          } as any,
        },
        viewStoreApi: {
          getState: () => ({
            currentViewRecords: { records: [] },
          }),
        },
        createRecord: createRecordMock,
        updateRecord: vi.fn().mockResolvedValue(null),
        refreshCurrentView: vi.fn().mockResolvedValue(undefined),
        startPolling: vi.fn(),
        checkIfTriggersAutoField: vi.fn().mockReturnValue([]),
        translate: (key: string) => key,
        notify: notifyMock,
        onRevealHiddenRecord: onRevealHiddenRecordMock,
      })
    )

    await act(async () => {
      await result.current.handleCellValueChanged(
        {
          id: '__draft_row__',
          row_id: '__draft_row__',
          __rowType: 'draft',
        } as any,
        'Name',
        'Alice',
        ''
      )
    })

    await act(async () => {
      await result.current.handleCommitDraftRow()
    })

    await waitFor(() => {
      expect(notifyMock).toHaveBeenCalled()
    })

    const hiddenNotification = notifyMock.mock.calls
      .map(args => args[0])
      .find((notification: any) => notification?.description === 'table:record.createdHiddenDesc')

    expect(hiddenNotification).toBeTruthy()
    expect(hiddenNotification.action?.label).toBe('table:record.createdHiddenAction')

    act(() => {
      hiddenNotification.action.onAction()
    })

    expect(onRevealHiddenRecordMock).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'r-hidden',
      })
    )
  })

  it('记录创建后在当前视图可见时应触发定位回调', async () => {
    const fields = [createField('f_name', 'Name')]
    const createdRecord = createRecord('r-visible', { Name: 'Alice' })
    const onRecordCreatedMock = vi.fn()
    const notifyMock = vi.fn()

    const { result } = renderHook(() =>
      useDataGridEditingController({
        orderedFields: fields,
        fields,
        selectedTableId: 'table-1',
        useViewData: true,
        firstEditableField: 'Name',
        gridApiRef: {
          current: {
            getEditingCells: () => [],
            getFocusedCell: () => null,
          } as any,
        },
        viewStoreApi: {
          getState: () => ({
            currentViewRecords: { records: [createdRecord] },
          }),
        },
        createRecord: vi.fn().mockResolvedValue(createdRecord),
        updateRecord: vi.fn().mockResolvedValue(null),
        refreshCurrentView: vi.fn().mockResolvedValue(undefined),
        startPolling: vi.fn(),
        checkIfTriggersAutoField: vi.fn().mockReturnValue([]),
        translate: (key: string) => key,
        notify: notifyMock,
        onRecordCreated: onRecordCreatedMock,
      })
    )

    await act(async () => {
      await result.current.handleCellValueChanged(
        {
          id: '__draft_row__',
          row_id: '__draft_row__',
          __rowType: 'draft',
        } as any,
        'Name',
        'Alice',
        ''
      )
    })

    await act(async () => {
      await result.current.handleCommitDraftRow()
    })

    await waitFor(() => {
      expect(onRecordCreatedMock).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'r-visible',
        })
      )
    })

    const hasHiddenNotification = notifyMock.mock.calls
      .map(args => args[0])
      .some((notification: any) => notification?.description === 'table:record.createdHiddenDesc')

    expect(hasHiddenNotification).toBe(false)
  })

  it('分组 add 行上下文应参与预填充与 order_context 计算', async () => {
    const fields = [createField('f_name', 'Name'), createField('f_status', 'Status')]

    const addRowContext = {
      group_path: '进行中',
      group_values: { Status: '进行中' },
    }

    const buildDraftPrefillValuesMock = vi.fn().mockImplementation((ctx: any) => {
      if (ctx?.group_values) {
        return ctx.group_values
      }
      return {}
    })

    const buildCreateOrderContextMock = vi.fn().mockImplementation((ctx: any) => ({
      position: 'end',
      group_values: ctx?.group_values,
    }))

    const createRecordMock = vi.fn().mockResolvedValue(createRecord('r1', { Name: 'Alice', Status: '进行中' }))

    const { result } = renderHook(() =>
      useDataGridEditingController({
        orderedFields: fields,
        fields,
        selectedTableId: 'table-1',
        useViewData: false,
        firstEditableField: 'Name',
        gridApiRef: {
          current: {
            getEditingCells: () => [],
            getFocusedCell: () => null,
            getPinnedBottomRowCount: () => 1,
            getPinnedBottomRow: () => ({
              data: {
                id: '__draft_row__',
                row_id: '__draft_row__',
                __rowType: 'draft',
              },
            }),
            startEditingCell: vi.fn(),
          } as any,
        },
        viewStoreApi: {
          getState: () => ({
            currentViewRecords: { records: [] },
          }),
        },
        createRecord: createRecordMock,
        updateRecord: vi.fn().mockResolvedValue(null),
        refreshCurrentView: vi.fn().mockResolvedValue(undefined),
        startPolling: vi.fn(),
        checkIfTriggersAutoField: vi.fn().mockReturnValue([]),
        translate: (key: string) => key,
        buildDraftPrefillValues: buildDraftPrefillValuesMock,
        buildCreateRecordOrderContext: buildCreateOrderContextMock,
      })
    )

    act(() => {
      result.current.handleAddRowClick(addRowContext)
    })

    expect(buildDraftPrefillValuesMock).toHaveBeenCalledWith(addRowContext)
    expect(result.current.draftRowData?.Status).toBe('进行中')

    await act(async () => {
      await result.current.handleCellValueChanged(
        {
          id: '__draft_row__',
          row_id: '__draft_row__',
          __rowType: 'draft',
          Status: '进行中',
        } as any,
        'Name',
        'Alice',
        ''
      )
    })

    await act(async () => {
      await result.current.handleCommitDraftRow()
    })

    expect(buildCreateOrderContextMock).toHaveBeenCalledWith(addRowContext)
    expect(createRecordMock).toHaveBeenCalledWith(
      expect.objectContaining({
        table_id: 'table-1',
        data: { f_name: 'Alice', f_status: '进行中' },
        fields: { f_name: 'Alice', f_status: '进行中' },
        fieldKeyType: 'id',
        order_context: {
          position: 'end',
          group_values: { Status: '进行中' },
        },
      })
    )
  })

  it('轮询中途记录出现时应立即结束且触发定位回调', async () => {
    const fields = [createField('f_name', 'Name')]
    const createdRecord = createRecord('r-delayed', { Name: 'Alice' })
    const onRecordCreatedMock = vi.fn()
    const notifyMock = vi.fn()

    let callCount = 0
    const viewStoreApi = {
      getState: () => {
        callCount++
        if (callCount <= 2) return { currentViewRecords: { records: [] } }
        return { currentViewRecords: { records: [createdRecord] } }
      },
    }

    const { result } = renderHook(() =>
      useDataGridEditingController({
        orderedFields: fields,
        fields,
        selectedTableId: 'table-1',
        useViewData: true,
        firstEditableField: 'Name',
        gridApiRef: {
          current: {
            getEditingCells: () => [],
            getFocusedCell: () => null,
          } as any,
        },
        viewStoreApi,
        createRecord: vi.fn().mockResolvedValue(createdRecord),
        updateRecord: vi.fn().mockResolvedValue(null),
        refreshCurrentView: vi.fn().mockResolvedValue(undefined),
        startPolling: vi.fn(),
        checkIfTriggersAutoField: vi.fn().mockReturnValue([]),
        translate: (key: string) => key,
        notify: notifyMock,
        onRecordCreated: onRecordCreatedMock,
      })
    )

    await act(async () => {
      await result.current.handleCellValueChanged(
        {
          id: '__draft_row__',
          row_id: '__draft_row__',
          __rowType: 'draft',
        } as any,
        'Name',
        'Alice',
        ''
      )
    })

    await act(async () => {
      await result.current.handleCommitDraftRow()
    })

    await waitFor(() => {
      expect(onRecordCreatedMock).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'r-delayed' })
      )
    })

    const hasHiddenNotification = notifyMock.mock.calls
      .map(args => args[0])
      .some((n: any) => n?.description === 'table:record.createdHiddenDesc')
    expect(hasHiddenNotification).toBe(false)
  })

  it('补偿同步在较晚窗口内命中时不应误报隐藏通知', async () => {
    vi.useFakeTimers()
    const fields = [createField('f_name', 'Name')]
    const createdRecord = createRecord('r-late-visible', { Name: 'Alice' })
    const onRecordCreatedMock = vi.fn()
    const notifyMock = vi.fn()

    let callCount = 0
    const viewStoreApi = {
      getState: () => {
        callCount++
        if (callCount <= 10) {
          return { currentViewRecords: { records: [] } }
        }
        return { currentViewRecords: { records: [createdRecord] } }
      },
    }

    const { result } = renderHook(() =>
      useDataGridEditingController({
        orderedFields: fields,
        fields,
        selectedTableId: 'table-1',
        useViewData: true,
        firstEditableField: 'Name',
        gridApiRef: {
          current: {
            getEditingCells: () => [],
            getFocusedCell: () => null,
          } as any,
        },
        viewStoreApi,
        createRecord: vi.fn().mockResolvedValue(createdRecord),
        updateRecord: vi.fn().mockResolvedValue(null),
        refreshCurrentView: vi.fn().mockResolvedValue(undefined),
        startPolling: vi.fn(),
        checkIfTriggersAutoField: vi.fn().mockReturnValue([]),
        translate: (key: string) => key,
        notify: notifyMock,
        onRecordCreated: onRecordCreatedMock,
      })
    )

    await act(async () => {
      await result.current.handleCellValueChanged(
        {
          id: '__draft_row__',
          row_id: '__draft_row__',
          __rowType: 'draft',
        } as any,
        'Name',
        'Alice',
        ''
      )
    })

    let commitPromise: Promise<void> | undefined
    act(() => {
      commitPromise = result.current.handleCommitDraftRow()
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1200)
      await commitPromise
    })

    expect(onRecordCreatedMock).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'r-late-visible' })
    )
    const hasHiddenNotification = notifyMock.mock.calls
      .map(args => args[0])
      .some((n: any) => n?.description === 'table:record.createdHiddenDesc')
    expect(hasHiddenNotification).toBe(false)
    vi.useRealTimers()
  })

  it('协作 optimistic 创建不应立刻 refresh 覆盖本地可见记录', async () => {
    const fields = [createField('f_name', 'Name')]
    const createdRecord = {
      id: 'r-collab-local',
      data: { Name: 'Alice' },
      fields: { Name: 'Alice' },
      __optimistic: true,
      __optimisticSource: 'collab',
      __viewOverlayEligible: true,
    } as any
    const refreshCurrentViewMock = vi.fn().mockResolvedValue(undefined)
    const onRecordCreatedMock = vi.fn()
    const notifyMock = vi.fn()

    const viewStoreApi = {
      getState: () => ({
        currentViewRecords: { records: [createdRecord] },
        currentViewEtag: '"4000000000123"',
      }),
      setState: vi.fn(),
    }

    const { result } = renderHook(() =>
      useDataGridEditingController({
        orderedFields: fields,
        fields,
        selectedTableId: 'table-1',
        useViewData: true,
        firstEditableField: 'Name',
        gridApiRef: {
          current: {
            getEditingCells: () => [],
            getFocusedCell: () => null,
          } as any,
        },
        viewStoreApi,
        createRecord: vi.fn().mockResolvedValue(createdRecord),
        updateRecord: vi.fn().mockResolvedValue(null),
        refreshCurrentView: refreshCurrentViewMock,
        startPolling: vi.fn(),
        checkIfTriggersAutoField: vi.fn().mockReturnValue([]),
        translate: (key: string) => key,
        notify: notifyMock,
        onRecordCreated: onRecordCreatedMock,
      })
    )

    await act(async () => {
      await result.current.handleCellValueChanged(
        {
          id: '__draft_row__',
          row_id: '__draft_row__',
          __rowType: 'draft',
        } as any,
        'Name',
        'Alice',
        ''
      )
    })

    await act(async () => {
      await result.current.handleCommitDraftRow()
    })

    expect(refreshCurrentViewMock).not.toHaveBeenCalled()
    expect(onRecordCreatedMock).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'r-collab-local' })
    )
    const hasHiddenNotification = notifyMock.mock.calls
      .map(args => args[0])
      .some((n: any) => n?.description === 'table:record.createdHiddenDesc')
    expect(hasHiddenNotification).toBe(false)
  })

  it('轮询期间 selectedTableId 变化时应中止可见性检查', async () => {
    vi.useFakeTimers()
    const fields = [createField('f_name', 'Name')]
    const createdRecord = createRecord('r-race', { Name: 'Alice' })
    const notifyMock = vi.fn()
    const onRecordCreatedMock = vi.fn()

    const { result, rerender } = renderHook(
      ({ tableId }: { tableId: string }) =>
        useDataGridEditingController({
          orderedFields: fields,
          fields,
          selectedTableId: tableId,
          useViewData: true,
          firstEditableField: 'Name',
          gridApiRef: {
            current: {
              getEditingCells: () => [],
              getFocusedCell: () => null,
            } as any,
          },
          viewStoreApi: {
            getState: () => ({
              currentViewRecords: { records: [] },
            }),
          },
          createRecord: vi.fn().mockResolvedValue(createdRecord),
          updateRecord: vi.fn().mockResolvedValue(null),
          refreshCurrentView: vi.fn().mockResolvedValue(undefined),
          startPolling: vi.fn(),
          checkIfTriggersAutoField: vi.fn().mockReturnValue([]),
          translate: (key: string) => key,
          notify: notifyMock,
          onRecordCreated: onRecordCreatedMock,
        }),
      { initialProps: { tableId: 'table-1' } }
    )

    await act(async () => {
      await result.current.handleCellValueChanged(
        {
          id: '__draft_row__',
          row_id: '__draft_row__',
          __rowType: 'draft',
        } as any,
        'Name',
        'Alice',
        ''
      )
    })

    let commitDone = false
    act(() => {
      void result.current.handleCommitDraftRow().then(() => { commitDone = true })
    })
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    rerender({ tableId: 'table-2' })
    await act(async () => { await vi.advanceTimersByTimeAsync(600) })
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })

    const hasHiddenNotification = notifyMock.mock.calls
      .map(args => args[0])
      .some((n: any) => n?.description === 'table:record.createdHiddenDesc')
    expect(hasHiddenNotification).toBe(false)
    expect(onRecordCreatedMock).not.toHaveBeenCalled()
    vi.useRealTimers()
  })

  it('业务字段名为 id 时草稿使用 __recordId 隔离标识，业务值可正常编辑', async () => {
    const fields = [createField('f_id', 'id')]
    const createRecordMock = vi.fn().mockResolvedValue(createRecord('sys-uuid-1', { id: 'biz-001' }))

    const { result } = renderHook(() =>
      useDataGridEditingController({
        orderedFields: fields,
        fields,
        selectedTableId: 'table-1',
        useViewData: false,
        firstEditableField: 'id',
        gridApiRef: {
          current: {
            getEditingCells: () => [],
            getFocusedCell: () => null,
          } as any,
        },
        viewStoreApi: {
          getState: () => ({
            currentViewRecords: { records: [] },
          }),
        },
        createRecord: createRecordMock,
        updateRecord: vi.fn().mockResolvedValue(null),
        refreshCurrentView: vi.fn().mockResolvedValue(undefined),
        startPolling: vi.fn(),
        checkIfTriggersAutoField: vi.fn().mockReturnValue([]),
        translate: (key: string) => key,
      })
    )

    act(() => {
      result.current.handleAddRowClick()
    })

    expect(result.current.draftRowData?.__recordId).toBe('__draft_row__')
    expect(result.current.draftRowData?.__rowType).toBe('draft')

    await act(async () => {
      await result.current.handleCellValueChanged(
        {
          __recordId: '__draft_row__',
          __rowType: 'draft',
        } as any,
        'id',
        'biz-001',
        ''
      )
    })

    // 业务字段 id 的编辑值不应被内部草稿标识 __draft_row__ 覆盖
    expect(result.current.draftRowData?.id).toBe('biz-001')
    expect(result.current.draftRowData?.__recordId).toBe('__draft_row__')

    await act(async () => {
      result.current.handleCellEditingStopped({
        data: {
          __recordId: '__draft_row__',
          __rowType: 'draft',
        },
      })
    })

    await waitFor(() => {
      expect(createRecordMock).toHaveBeenCalledTimes(1)
    })
    expect(createRecordMock).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { f_id: 'biz-001' },
        fields: { f_id: 'biz-001' },
      })
    )
  })

  it('业务字段名为 id 且与系统记录标识不同时，updateRecord 应收到系统记录 id', async () => {
    const fields = [createField('f_id', 'id')]
    const updateRecordMock = vi.fn().mockResolvedValue(createRecord('sys-uuid-2', { id: 'biz-002-new' }))

    const { result } = renderHook(() =>
      useDataGridEditingController({
        orderedFields: fields,
        fields,
        selectedTableId: 'table-1',
        useViewData: false,
        firstEditableField: 'id',
        gridApiRef: {
          current: {
            getEditingCells: () => [],
            getFocusedCell: () => null,
          } as any,
        },
        viewStoreApi: {
          getState: () => ({
            currentViewRecords: { records: [] },
          }),
        },
        createRecord: vi.fn().mockResolvedValue(null),
        updateRecord: updateRecordMock,
        refreshCurrentView: vi.fn().mockResolvedValue(undefined),
        startPolling: vi.fn(),
        checkIfTriggersAutoField: vi.fn().mockReturnValue([]),
        translate: (key: string) => key,
      })
    )

    await act(async () => {
      await result.current.handleCellValueChanged(
        {
          __recordId: 'sys-uuid-2',
          id: 'biz-002-old',
        } as any,
        'id',
        'biz-002-new',
        'biz-002-old'
      )
    })

    expect(updateRecordMock).toHaveBeenCalledWith(
      'sys-uuid-2',
      expect.objectContaining({
        data: { f_id: 'biz-002-new' },
        fields: { f_id: 'biz-002-new' },
      })
    )
  })
})
