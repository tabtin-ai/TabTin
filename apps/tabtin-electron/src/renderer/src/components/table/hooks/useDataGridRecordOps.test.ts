import { act, renderHook, waitFor } from '@testing-library/react'
import { RecordApiService, type Field, type ViewMeta } from '@tabtin/table-core'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useDataGridRecordOps } from './useDataGridRecordOps'

const { mockBulkCreateRecords, mockBulkDeleteRecords, mockToast } = vi.hoisted(
  () => {
    const toastFn = Object.assign(
      vi.fn(() => ({
        id: 'toast-1',
        dismiss: vi.fn(),
        update: vi.fn(),
      })),
      {
        success: vi.fn(),
        error: vi.fn(),
        info: vi.fn(),
      },
    )
    return {
      mockBulkCreateRecords: vi.fn(),
      mockBulkDeleteRecords: vi.fn(),
      mockToast: toastFn,
    }
  },
)

vi.mock('@stores/useRecordStore', () => ({
  useRecordStore: (selector: (state: any) => unknown) =>
    selector({
      bulkCreateRecords: mockBulkCreateRecords,
      bulkDeleteRecords: mockBulkDeleteRecords,
    }),
}))

vi.mock('@tabtin/smartsheet-ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tabtin/smartsheet-ui')>()
  return {
    ...actual,
    toast: mockToast,
    ToastAction: () => null,
  }
})

describe('useDataGridRecordOps', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockBulkCreateRecords.mockResolvedValue([{ id: 'new-1' }, { id: 'new-2' }])
    mockBulkDeleteRecords.mockImplementation(async (ids: string[]) => ({
      ok: true,
      deletedIds: [...ids],
      failedIds: [],
      errors: [],
    }))
    vi.spyOn(RecordApiService, 'createSubRecord').mockResolvedValue({
      parent_field_id: 'parent-field',
      record: { id: 'real-child' },
    } as any)
  })

  it('insert above/below 应复用视图上下文生成 order_context 且保持空白记录', async () => {
    const refreshCurrentView = vi.fn().mockResolvedValue(undefined)
    const onRecordCreated = vi.fn()
    let displayedRows: Array<Record<string, unknown>> = [
      {
        id: 'row-1',
        Status: '进行中',
      },
    ]
    refreshCurrentView.mockImplementation(async () => {
      displayedRows = [
        {
          id: 'new-1',
          Status: '进行中',
          Priority: 'P0',
        },
      ]
    })

    const { result } = renderHook(() =>
      useDataGridRecordOps({
        selectedTable: { id: 'table-1' },
        fields: [
          {
            id: 'f_status',
            name: 'Status',
            field_type: 'single_select',
          } as any,
          {
            id: 'f_priority',
            name: 'Priority',
            field_type: 'single_select',
          } as any,
        ],
        records: [],
        currentViewRecords: { records: [] },
        currentView: {
          id: 'view-1',
          groups: [{ field_id: 'f_status' }],
        } as any,
        currentViewId: 'view-1',
        useViewData: true,
        isTableReadonly: false,
        isPersonalViewEnabled: false,
        allowViewMutation: false,
        fieldById: new Map<string, any>([
          [
            'f_status',
            {
              id: 'f_status',
              name: 'Status',
              field_type: 'single_select',
            },
          ],
          [
            'f_priority',
            {
              id: 'f_priority',
              name: 'Priority',
              field_type: 'single_select',
            },
          ],
        ]),
        gridApiRef: {
          current: {
            getDisplayedRowAtIndex: (index: number) =>
              displayedRows[index]
                ? {
                    data: displayedRows[index],
                  }
                : undefined,
            getDisplayedRowCount: () => displayedRows.length,
            getFocusedCell: () => null,
          },
        },
        selectedRows: [],
        firstEditableField: 'Name',
        groupedRows: [
          {
            id: 'row-1',
            Status: '进行中',
          },
        ],
        rowsData: [
          {
            id: 'row-1',
            Status: '进行中',
          },
        ],
        subRecordParentFieldId: null,
        resolvedCurrentView: {
          id: 'view-1',
          groups: [{ field_id: 'f_status' }],
          filters: [
            {
              id: 'flt-priority',
              field_id: 'f_priority',
              operator: 'equals',
              value: 'P0',
              enabled: true,
            },
          ],
          config: {
            filter_logic: 'and',
          },
        } as any,
        recordsQuery: { page: 1, page_size: 50 },
        createRecord: vi.fn(),
        refreshCurrentView,
        loadRecordsByTable: vi.fn().mockResolvedValue(undefined),
        updateView: vi.fn().mockResolvedValue(undefined),
        setPersonalViewDraft: vi.fn(),
        is403Error: () => false,
        mark403Readonly: vi.fn(),
        onRecordCreated,
        t: (key: string) => key,
      }),
    )

    await act(async () => {
      await result.current.handleInsertRecord('before', 0, 2)
    })

    await waitFor(() => {
      expect(mockBulkCreateRecords).toHaveBeenCalledTimes(1)
    })

    expect(mockBulkCreateRecords).toHaveBeenCalledWith({
      table_id: 'table-1',
      records: [
        {},
        {},
      ],
      order_context: {
        view_id: 'view-1',
        anchor_record_id: 'row-1',
        position: 'before',
        group_values: { Status: '进行中' },
      },
    })
    expect(refreshCurrentView).toHaveBeenCalled()
    expect(onRecordCreated).toHaveBeenCalledWith({ id: 'new-1' })
  })

  it('虚拟追加行应锚定前一条真实记录并保留筛选预填', () => {
    const displayedRows = [
      { id: 'row-1', Name: 'A' },
      { id: 'row-2', Name: 'B' },
      { id: '__add_row__', __rowType: 'add' },
    ]

    const { result } = renderHook(() =>
      useDataGridRecordOps({
        selectedTable: { id: 'table-1' },
        fields: [
          {
            id: 'f_priority',
            name: 'Priority',
            field_type: 'single_select',
          } as any,
        ],
        records: displayedRows.slice(0, 2),
        currentViewRecords: { records: displayedRows.slice(0, 2) },
        currentView: {
          id: 'view-1',
          groups: [],
          sorts: [{ field_id: 'f_priority', order: 'asc' }],
          filters: [
            {
              id: 'flt-priority',
              field_id: 'f_priority',
              operator: 'equals',
              value: 'P0',
              enabled: true,
            },
          ],
          config: { filter_logic: 'and' },
        } as any,
        currentViewId: 'view-1',
        useViewData: true,
        isTableReadonly: false,
        isPersonalViewEnabled: false,
        allowViewMutation: false,
        fieldById: new Map<string, any>([
          [
            'f_priority',
            {
              id: 'f_priority',
              name: 'Priority',
              field_type: 'single_select',
            },
          ],
        ]),
        gridApiRef: {
          current: {
            getDisplayedRowAtIndex: (index: number) =>
              displayedRows[index] ? { data: displayedRows[index] } : undefined,
            getDisplayedRowCount: () => displayedRows.length,
            getFocusedCell: () => null,
          },
        },
        selectedRows: [],
        firstEditableField: 'Name',
        groupedRows: displayedRows,
        rowsData: displayedRows.slice(0, 2),
        subRecordParentFieldId: null,
        resolvedCurrentView: {
          id: 'view-1',
          groups: [],
          sorts: [{ field_id: 'f_priority', order: 'asc' }],
          filters: [
            {
              id: 'flt-priority',
              field_id: 'f_priority',
              operator: 'equals',
              value: 'P0',
              enabled: true,
            },
          ],
          config: { filter_logic: 'and' },
        } as any,
        recordsQuery: { page: 1, page_size: 50 },
        createRecord: vi.fn(),
        refreshCurrentView: vi.fn().mockResolvedValue(undefined),
        loadRecordsByTable: vi.fn().mockResolvedValue(undefined),
        updateView: vi.fn().mockResolvedValue(undefined),
        setPersonalViewDraft: vi.fn(),
        is403Error: () => false,
        mark403Readonly: vi.fn(),
        t: (key: string) => key,
      }),
    )

    expect(result.current.buildCreatePlanFromDisplayRowIndex(2)).toEqual({
      orderContext: {
        view_id: 'view-1',
        anchor_record_id: 'row-2',
        position: 'after',
      },
      prefillValues: { Priority: 'P0' },
    })
    expect(
      result.current.buildCreateRecordOrderContext({
        order_context: {
          view_id: 'view-1',
          anchor_record_id: 'row-2',
          position: 'after',
        },
      }),
    ).toEqual({
      view_id: 'view-1',
      anchor_record_id: 'row-2',
      position: 'after',
    })
  })

  it('分组、折叠分组和空分组追加应生成对应分组内的创建计划', () => {
    const statusField = {
      id: 'f_status',
      name: 'Status',
      field_type: 'single_select',
    } as Field
    const groupedView = {
      id: 'view-1',
      groups: [{ field_id: 'f_status' }],
      filters: [],
      sorts: [],
    } as ViewMeta
    const cases = [
      {
        displayRowIndex: 2,
        displayedRows: [
          { id: 'group-active', __rowType: 'group_header', __groupPath: 'status/active', __groupValues: { Status: 'Active' } },
          { id: 'row-active', Status: 'Active' },
          { id: 'group-active-add', __rowType: 'group_add', __groupPath: 'status/active', __groupValues: { Status: 'Active' } },
        ],
        groupedRows: [
          { id: 'group-active', __rowType: 'group_header', __groupPath: 'status/active', __groupValues: { Status: 'Active' } },
          { id: 'row-active', Status: 'Active' },
          { id: 'group-active-add', __rowType: 'group_add', __groupPath: 'status/active', __groupValues: { Status: 'Active' } },
        ],
        rowsData: [{ id: 'row-active', Status: 'Active' }],
        expected: {
          orderContext: { view_id: 'view-1', anchor_record_id: 'row-active', position: 'after', group_values: { Status: 'Active' } },
          prefillValues: { Status: 'Active' },
        },
      },
      {
        displayRowIndex: 0,
        displayedRows: [
          { id: 'group-done', __rowType: 'group_header', __groupPath: 'status/done', __groupValues: { Status: 'Done' }, __groupCollapsed: true },
        ],
        groupedRows: [
          { id: 'group-done', __rowType: 'group_header', __groupPath: 'status/done', __groupValues: { Status: 'Done' }, __groupCollapsed: true },
          { id: 'row-done-hidden', Status: 'Done' },
          { id: 'group-done-add', __rowType: 'group_add', __groupPath: 'status/done', __groupValues: { Status: 'Done' } },
        ],
        rowsData: [{ id: 'row-done-hidden', Status: 'Done' }],
        expected: {
          orderContext: { view_id: 'view-1', anchor_record_id: 'row-done-hidden', position: 'after', group_values: { Status: 'Done' } },
          prefillValues: { Status: 'Done' },
        },
      },
      {
        displayRowIndex: 1,
        displayedRows: [
          { id: 'group-empty', __rowType: 'group_header', __groupPath: 'status/empty', __groupValues: { Status: null } },
          { id: 'group-empty-add', __rowType: 'group_add', __groupPath: 'status/empty', __groupValues: { Status: null } },
        ],
        groupedRows: [
          { id: 'group-empty', __rowType: 'group_header', __groupPath: 'status/empty', __groupValues: { Status: null } },
          { id: 'group-empty-add', __rowType: 'group_add', __groupPath: 'status/empty', __groupValues: { Status: null } },
        ],
        rowsData: [],
        expected: {
          orderContext: { view_id: 'view-1', position: 'end', group_values: { Status: null } },
          prefillValues: { Status: null },
        },
      },
    ]

    for (const testCase of cases) {
      const { result, unmount } = renderHook(() =>
        useDataGridRecordOps({
          selectedTable: { id: 'table-1' },
          fields: [statusField],
          records: testCase.rowsData,
          currentViewRecords: { records: testCase.rowsData },
          currentView: groupedView,
          currentViewId: 'view-1',
          useViewData: true,
          isTableReadonly: false,
          isPersonalViewEnabled: false,
          allowViewMutation: false,
          fieldById: new Map<string, Field>([['f_status', statusField]]),
          gridApiRef: {
            current: {
              getDisplayedRowAtIndex: (index: number) =>
                testCase.displayedRows[index] ? { data: testCase.displayedRows[index] } : undefined,
              getDisplayedRowCount: () => testCase.displayedRows.length,
              getFocusedCell: () => null,
            },
          },
          selectedRows: [],
          firstEditableField: 'Status',
          groupedRows: testCase.groupedRows,
          rowsData: testCase.rowsData,
          subRecordParentFieldId: null,
          resolvedCurrentView: groupedView,
          recordsQuery: { page: 1, page_size: 50 },
          createRecord: vi.fn(),
          refreshCurrentView: vi.fn().mockResolvedValue(undefined),
          loadRecordsByTable: vi.fn().mockResolvedValue(undefined),
          updateView: vi.fn().mockResolvedValue(undefined),
          setPersonalViewDraft: vi.fn(),
          is403Error: () => false,
          mark403Readonly: vi.fn(),
          t: (key: string) => key,
        }),
      )

      expect(result.current.buildCreatePlanFromDisplayRowIndex(testCase.displayRowIndex)).toEqual(
        testCase.expected,
      )
      unmount()
    }
  })

  it('insert 命中 local overlay 时不应再依赖 refreshCurrentView 才定位', async () => {
    const refreshCurrentView = vi.fn().mockResolvedValue(undefined)
    const onRecordCreated = vi.fn()
    const applyLocalCreateOverlay = vi.fn((
      records: any[],
      _orderContext?: unknown,
      _options?: unknown,
    ) =>
      records.map((record) => ({
        ...record,
        __viewOverlayEligible: true,
      }))
    )

    const { result } = renderHook(() =>
      useDataGridRecordOps({
        selectedTable: { id: 'table-1' },
        fields: [
          {
            id: 'f_name',
            name: 'Name',
            field_type: 'text',
          } as any,
        ],
        records: [],
        currentViewRecords: { records: [{ id: 'row-1', Name: 'Old' }] },
        currentView: {
          id: 'view-1',
          groups: [],
          filters: [],
          sorts: [],
        } as any,
        currentViewId: 'view-1',
        useViewData: true,
        isTableReadonly: false,
        isPersonalViewEnabled: false,
        allowViewMutation: true,
        fieldById: new Map(),
        gridApiRef: {
          current: {
            getDisplayedRowAtIndex: (index: number) =>
              index === 0
                ? {
                    data: {
                      id: 'new-1',
                      Name: 'Created',
                    },
                  }
                : undefined,
            getDisplayedRowCount: () => 1,
            getFocusedCell: () => null,
          },
        },
        selectedRows: [],
        firstEditableField: 'Name',
        groupedRows: [{ id: 'row-1', Name: 'Old' }],
        rowsData: [{ id: 'row-1', Name: 'Old' }],
        subRecordParentFieldId: null,
        resolvedCurrentView: {
          id: 'view-1',
          groups: [],
          filters: [],
          sorts: [],
          config: {},
        } as any,
        recordsQuery: { page: 1, page_size: 50 },
        createRecord: vi.fn(),
        refreshCurrentView,
        loadRecordsByTable: vi.fn().mockResolvedValue(undefined),
        updateView: vi.fn().mockResolvedValue(undefined),
        setPersonalViewDraft: vi.fn(),
        is403Error: () => false,
        mark403Readonly: vi.fn(),
        onRecordCreated,
        applyLocalCreateOverlay,
        t: (key: string) => key,
      }),
    )

    await act(async () => {
      await result.current.handleInsertRecord('after', 0, 1)
    })

    expect(applyLocalCreateOverlay).toHaveBeenCalledTimes(1)
    expect(refreshCurrentView).not.toHaveBeenCalled()
    expect(onRecordCreated).toHaveBeenCalledTimes(1)
  })

  it('insert 写入成功后本地可见性同步失败不应误报插入失败', async () => {
    const refreshCurrentView = vi.fn().mockResolvedValue(undefined)
    const applyLocalCreateOverlay = vi.fn(() => {
      throw new Error('overlay failed')
    })

    const { result } = renderHook(() =>
      useDataGridRecordOps({
        selectedTable: { id: 'table-1' },
        fields: [
          {
            id: 'f_name',
            name: 'Name',
            field_type: 'text',
          } as any,
        ],
        records: [],
        currentViewRecords: { records: [{ id: 'row-1', Name: 'Old' }] },
        currentView: {
          id: 'view-1',
          groups: [],
          filters: [],
          sorts: [],
        } as any,
        currentViewId: 'view-1',
        useViewData: true,
        isTableReadonly: false,
        isPersonalViewEnabled: false,
        allowViewMutation: true,
        fieldById: new Map(),
        gridApiRef: {
          current: {
            getDisplayedRowAtIndex: (index: number) =>
              index === 0
                ? {
                    data: {
                      id: 'row-1',
                      Name: 'Old',
                    },
                  }
                : undefined,
            getDisplayedRowCount: () => 1,
            getFocusedCell: () => null,
          },
        },
        selectedRows: [],
        firstEditableField: 'Name',
        groupedRows: [{ id: 'row-1', Name: 'Old' }],
        rowsData: [{ id: 'row-1', Name: 'Old' }],
        subRecordParentFieldId: null,
        resolvedCurrentView: {
          id: 'view-1',
          groups: [],
          filters: [],
          sorts: [],
          config: {},
        } as any,
        recordsQuery: { page: 1, page_size: 50 },
        createRecord: vi.fn(),
        refreshCurrentView,
        loadRecordsByTable: vi.fn().mockResolvedValue(undefined),
        updateView: vi.fn().mockResolvedValue(undefined),
        setPersonalViewDraft: vi.fn(),
        is403Error: () => false,
        mark403Readonly: vi.fn(),
        applyLocalCreateOverlay,
        t: (key: string) => key,
      }),
    )

    await act(async () => {
      await result.current.handleInsertRecord('after', 0, 1)
    })

    expect(mockBulkCreateRecords).toHaveBeenCalledTimes(1)
    expect(applyLocalCreateOverlay).toHaveBeenCalledTimes(1)
    expect(refreshCurrentView).toHaveBeenCalledTimes(1)
    expect(mockToast).not.toHaveBeenCalledWith({
      title: 'table:error.insertRecordFailed',
      variant: 'destructive',
    })
  })

  it('insert 协作写入成功后本地可见性同步失败不应误报插入失败', async () => {
    const refreshCurrentView = vi.fn().mockResolvedValue(undefined)
    const createRecord = vi.fn().mockResolvedValue({ id: 'new-1' })
    const applyLocalCreateOverlay = vi.fn(() => {
      throw new Error('overlay failed')
    })

    const { result } = renderHook(() =>
      useDataGridRecordOps({
        selectedTable: { id: 'table-1' },
        fields: [
          {
            id: 'f_name',
            name: 'Name',
            field_type: 'text',
          } as any,
        ],
        records: [],
        currentViewRecords: { records: [{ id: 'row-1', Name: 'Old' }] },
        currentView: {
          id: 'view-1',
          groups: [],
          filters: [],
          sorts: [],
        } as any,
        currentViewId: 'view-1',
        useViewData: true,
        isTableReadonly: false,
        isPersonalViewEnabled: false,
        allowViewMutation: true,
        fieldById: new Map(),
        gridApiRef: {
          current: {
            getDisplayedRowAtIndex: (index: number) =>
              index === 0
                ? {
                    data: {
                      id: 'row-1',
                      Name: 'Old',
                    },
                  }
                : undefined,
            getDisplayedRowCount: () => 1,
            getFocusedCell: () => null,
          },
        },
        selectedRows: [],
        firstEditableField: 'Name',
        groupedRows: [{ id: 'row-1', Name: 'Old' }],
        rowsData: [{ id: 'row-1', Name: 'Old' }],
        subRecordParentFieldId: null,
        resolvedCurrentView: {
          id: 'view-1',
          groups: [],
          filters: [],
          sorts: [],
          config: {},
        } as any,
        recordsQuery: { page: 1, page_size: 50 },
        createRecord,
        refreshCurrentView,
        isCollabSyncActive: true,
        loadRecordsByTable: vi.fn().mockResolvedValue(undefined),
        updateView: vi.fn().mockResolvedValue(undefined),
        setPersonalViewDraft: vi.fn(),
        is403Error: () => false,
        mark403Readonly: vi.fn(),
        applyLocalCreateOverlay,
        t: (key: string) => key,
      }),
    )

    await act(async () => {
      await result.current.handleInsertRecord('after', 0, 1)
    })

    expect(createRecord).toHaveBeenCalledWith({
      table_id: 'table-1',
      data: {},
      order_context: {
        view_id: 'view-1',
        anchor_record_id: 'row-1',
        position: 'after',
      },
    })
    expect(mockBulkCreateRecords).not.toHaveBeenCalled()
    expect(applyLocalCreateOverlay).toHaveBeenCalledTimes(1)
    expect(refreshCurrentView).toHaveBeenCalledTimes(1)
    expect(mockToast).not.toHaveBeenCalledWith({
      title: 'table:error.insertRecordFailed',
      variant: 'destructive',
    })
  })

  it('insert 协作连续向下插入多行时应推进下一条记录的 anchor', async () => {
    const refreshCurrentView = vi.fn().mockResolvedValue(undefined)
    const createRecord = vi.fn()
      .mockResolvedValueOnce({ id: 'new-1' })
      .mockResolvedValueOnce({ id: 'new-2' })

    const { result } = renderHook(() =>
      useDataGridRecordOps({
        selectedTable: { id: 'table-1' },
        fields: [
          {
            id: 'f_name',
            name: 'Name',
            field_type: 'text',
          } as any,
        ],
        records: [],
        currentViewRecords: { records: [{ id: 'row-1', Name: 'Old' }] },
        currentView: {
          id: 'view-1',
          groups: [],
          filters: [],
          sorts: [],
        } as any,
        currentViewId: 'view-1',
        useViewData: true,
        isTableReadonly: false,
        isPersonalViewEnabled: false,
        allowViewMutation: true,
        fieldById: new Map(),
        gridApiRef: {
          current: {
            getDisplayedRowAtIndex: (index: number) =>
              index === 0
                ? {
                    data: {
                      id: 'row-1',
                      Name: 'Old',
                    },
                  }
                : undefined,
            getDisplayedRowCount: () => 1,
            getFocusedCell: () => null,
          },
        },
        selectedRows: [],
        firstEditableField: 'Name',
        groupedRows: [{ id: 'row-1', Name: 'Old' }],
        rowsData: [{ id: 'row-1', Name: 'Old' }],
        subRecordParentFieldId: null,
        resolvedCurrentView: {
          id: 'view-1',
          groups: [],
          filters: [],
          sorts: [],
          config: {},
        } as any,
        recordsQuery: { page: 1, page_size: 50 },
        createRecord,
        refreshCurrentView,
        isCollabSyncActive: true,
        loadRecordsByTable: vi.fn().mockResolvedValue(undefined),
        updateView: vi.fn().mockResolvedValue(undefined),
        setPersonalViewDraft: vi.fn(),
        is403Error: () => false,
        mark403Readonly: vi.fn(),
        t: (key: string) => key,
      }),
    )

    await act(async () => {
      await result.current.handleInsertRecord('after', 0, 2)
    })

    expect(createRecord).toHaveBeenNthCalledWith(1, {
      table_id: 'table-1',
      data: {},
      order_context: {
        view_id: 'view-1',
        anchor_record_id: 'row-1',
        position: 'after',
      },
    })
    expect(createRecord).toHaveBeenNthCalledWith(2, {
      table_id: 'table-1',
      data: {},
      order_context: {
        view_id: 'view-1',
        anchor_record_id: 'new-1',
        position: 'after',
      },
    })
  })

  it('insert 写入失败仍应提示插入失败', async () => {
    mockBulkCreateRecords.mockRejectedValue(new Error('write failed'))
    const refreshCurrentView = vi.fn().mockResolvedValue(undefined)

    const { result } = renderHook(() =>
      useDataGridRecordOps({
        selectedTable: { id: 'table-1' },
        fields: [
          {
            id: 'f_name',
            name: 'Name',
            field_type: 'text',
          } as any,
        ],
        records: [],
        currentViewRecords: { records: [{ id: 'row-1', Name: 'Old' }] },
        currentView: {
          id: 'view-1',
          groups: [],
          filters: [],
          sorts: [],
        } as any,
        currentViewId: 'view-1',
        useViewData: true,
        isTableReadonly: false,
        isPersonalViewEnabled: false,
        allowViewMutation: true,
        fieldById: new Map(),
        gridApiRef: {
          current: {
            getDisplayedRowAtIndex: (index: number) =>
              index === 0
                ? {
                    data: {
                      id: 'row-1',
                      Name: 'Old',
                    },
                  }
                : undefined,
            getDisplayedRowCount: () => 1,
            getFocusedCell: () => null,
          },
        },
        selectedRows: [],
        firstEditableField: 'Name',
        groupedRows: [{ id: 'row-1', Name: 'Old' }],
        rowsData: [{ id: 'row-1', Name: 'Old' }],
        subRecordParentFieldId: null,
        resolvedCurrentView: {
          id: 'view-1',
          groups: [],
          filters: [],
          sorts: [],
          config: {},
        } as any,
        recordsQuery: { page: 1, page_size: 50 },
        createRecord: vi.fn(),
        refreshCurrentView,
        loadRecordsByTable: vi.fn().mockResolvedValue(undefined),
        updateView: vi.fn().mockResolvedValue(undefined),
        setPersonalViewDraft: vi.fn(),
        is403Error: () => false,
        mark403Readonly: vi.fn(),
        t: (key: string) => key,
      }),
    )

    await act(async () => {
      await result.current.handleInsertRecord('after', 0, 1)
    })

    expect(mockToast).toHaveBeenCalledWith({
      title: 'table:error.insertRecordFailed',
      variant: 'destructive',
    })
  })

  it('insert 可继续输入的创建路径应优先走重新进入编辑态回调', async () => {
    const refreshCurrentView = vi.fn().mockResolvedValue(undefined)
    const onRecordCreated = vi.fn()
    const onRecordCreatedContinueEditing = vi.fn()
    const applyLocalCreateOverlay = vi.fn((records: any[]) =>
      records.map((record) => ({
        ...record,
        __viewOverlayEligible: true,
      }))
    )

    const { result } = renderHook(() =>
      useDataGridRecordOps({
        selectedTable: { id: 'table-1' },
        fields: [
          {
            id: 'f_name',
            name: 'Name',
            field_type: 'text',
          } as any,
        ],
        records: [],
        currentViewRecords: { records: [{ id: 'row-1', Name: 'Old' }] },
        currentView: {
          id: 'view-1',
          groups: [],
          filters: [],
          sorts: [],
        } as any,
        currentViewId: 'view-1',
        useViewData: true,
        isTableReadonly: false,
        isPersonalViewEnabled: false,
        allowViewMutation: true,
        fieldById: new Map(),
        gridApiRef: {
          current: {
            getDisplayedRowAtIndex: (index: number) =>
              index === 0
                ? {
                    data: {
                      id: 'new-1',
                      Name: 'Created',
                    },
                  }
                : undefined,
            getDisplayedRowCount: () => 1,
            getFocusedCell: () => null,
          },
        },
        selectedRows: [],
        firstEditableField: 'Name',
        groupedRows: [{ id: 'row-1', Name: 'Old' }],
        rowsData: [{ id: 'row-1', Name: 'Old' }],
        subRecordParentFieldId: null,
        resolvedCurrentView: {
          id: 'view-1',
          groups: [],
          filters: [],
          sorts: [],
          config: {},
        } as any,
        recordsQuery: { page: 1, page_size: 50 },
        createRecord: vi.fn(),
        refreshCurrentView,
        loadRecordsByTable: vi.fn().mockResolvedValue(undefined),
        updateView: vi.fn().mockResolvedValue(undefined),
        setPersonalViewDraft: vi.fn(),
        is403Error: () => false,
        mark403Readonly: vi.fn(),
        onRecordCreated,
        onRecordCreatedContinueEditing,
        applyLocalCreateOverlay,
        t: (key: string) => key,
      }),
    )

    await act(async () => {
      await result.current.handleInsertRecord('after', 0, 1)
    })

    expect(onRecordCreatedContinueEditing).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'new-1' })
    )
    expect(onRecordCreated).not.toHaveBeenCalled()
  })

  it('resolveDraftAddRowContext 应保留空值组上下文并在分组降级时丢弃过期 group_path', () => {
    const { result } = renderHook(() =>
      useDataGridRecordOps({
        selectedTable: { id: 'table-1' },
        fields: [
          {
            id: 'f_status',
            name: 'Status',
            field_type: 'single_select',
          } as any,
          {
            id: 'f_priority',
            name: 'Priority',
            field_type: 'single_select',
          } as any,
        ],
        records: [],
        currentViewRecords: { records: [] },
        currentView: {
          id: 'view-1',
          groups: [{ field_id: 'f_status' }, { field_id: 'f_priority' }],
        } as any,
        currentViewId: 'view-1',
        useViewData: true,
        isTableReadonly: false,
        isPersonalViewEnabled: false,
        allowViewMutation: false,
        fieldById: new Map<string, any>([
          [
            'f_status',
            {
              id: 'f_status',
              name: 'Status',
              field_type: 'single_select',
            },
          ],
          [
            'f_priority',
            {
              id: 'f_priority',
              name: 'Priority',
              field_type: 'single_select',
            },
          ],
        ]),
        gridApiRef: {
          current: {
            getDisplayedRowAtIndex: () => undefined,
            getDisplayedRowCount: () => 0,
            getFocusedCell: () => null,
          },
        },
        selectedRows: [],
        firstEditableField: 'Name',
        groupedRows: [],
        rowsData: [],
        subRecordParentFieldId: null,
        resolvedCurrentView: {
          id: 'view-1',
          groups: [{ field_id: 'f_status' }, { field_id: 'f_priority' }],
        } as any,
        recordsQuery: { page: 1, page_size: 50 },
        createRecord: vi.fn(),
        refreshCurrentView: vi.fn().mockResolvedValue(undefined),
        loadRecordsByTable: vi.fn().mockResolvedValue(undefined),
        updateView: vi.fn().mockResolvedValue(undefined),
        setPersonalViewDraft: vi.fn(),
        is403Error: () => false,
        mark403Readonly: vi.fn(),
        t: (key: string) => key,
      }),
    )

    expect(
      result.current.resolveDraftAddRowContext(
        {
          id: '__draft_row__',
          row_id: '__draft_row__',
          __rowType: 'draft',
          Status: null,
          Priority: null,
        } as any,
        {
          group_path: 'ungrouped',
          group_values: { Status: null, Priority: null },
        },
      ),
    ).toEqual({
      group_path: 'ungrouped',
      group_values: { Status: null, Priority: null },
    })

    expect(
      result.current.resolveDraftAddRowContext(
        {
          id: '__draft_row__',
          row_id: '__draft_row__',
          __rowType: 'draft',
          Status: 'Todo',
          Priority: '',
        } as any,
        {
          group_path: 'Todo/P0',
          group_values: { Status: 'Todo', Priority: 'P0' },
        },
      ),
    ).toEqual({
      group_path: undefined,
      group_values: { Status: 'Todo' },
    })
  })

  it('新建折叠父节点的子记录时应展开父节点、携带 tree overlay，并把父字段写入创建请求', async () => {
    const applyLocalCreateOverlay = vi.fn((records: any[]) =>
      records.map((record) => ({
        ...record,
        __viewOverlayEligible: true,
      }))
    )
    const patchLocalCreateOverlayRecord = vi.fn()
    const expandAllTreeRecords = vi.fn()
    const refreshCurrentView = vi.fn().mockResolvedValue(undefined)

    const viewStoreApi = {
      getState: () => ({
        currentViewRecords: {
          records: [{ id: 'parent-1' }],
          metadata: {
            sub_records: {
              parent_field_id: 'parent-field',
              tree_data: {
                'parent-1': { depth: 0, has_children: false, parent_id: null },
              },
            },
          },
        },
        treeExpandedRecords: {
          'view-1': new Set<string>(),
        },
        expandAllTreeRecords,
      }),
    }

    const { result } = renderHook(() =>
      useDataGridRecordOps({
        selectedTable: { id: 'table-1' },
        fields: [],
        records: [],
        currentViewRecords: {
          records: [{ id: 'parent-1' }],
          metadata: {
            sub_records: {
              parent_field_id: 'parent-field',
              tree_data: {
                'parent-1': { depth: 0, has_children: false, parent_id: null },
              },
            },
          },
        },
        currentView: {
          id: 'view-1',
          groups: [],
          filters: [],
          sorts: [],
          config: { subRecordParentFieldId: 'parent-field' },
        } as any,
        currentViewId: 'view-1',
        useViewData: true,
        isTableReadonly: false,
        isPersonalViewEnabled: false,
        allowViewMutation: true,
        fieldById: new Map(),
        gridApiRef: {
          current: {
            getDisplayedRowAtIndex: () => undefined,
            getDisplayedRowCount: () => 1,
            getFocusedCell: () => null,
          },
        },
        selectedRows: [],
        firstEditableField: 'Name',
        groupedRows: [{ id: 'parent-1', Name: '父记录 A' }],
        rowsData: [{ id: 'parent-1', Name: '父记录 A' }],
        subRecordParentFieldId: 'parent-field',
        resolvedCurrentView: {
          id: 'view-1',
          groups: [],
          filters: [],
          sorts: [],
          config: { subRecordParentFieldId: 'parent-field' },
        } as any,
        recordsQuery: { page: 1, page_size: 50 },
        createRecord: vi.fn(),
        refreshCurrentView,
        loadRecordsByTable: vi.fn().mockResolvedValue(undefined),
        updateView: vi.fn().mockResolvedValue(undefined),
        setPersonalViewDraft: vi.fn(),
        is403Error: () => false,
        mark403Readonly: vi.fn(),
        applyLocalCreateOverlay,
        patchLocalCreateOverlayRecord,
        viewStoreApi: viewStoreApi as any,
        t: (key: string) => key,
      }),
    )

    await act(async () => {
      await result.current.handleInsertSubRecord('parent-1')
    })

    expect(expandAllTreeRecords).toHaveBeenCalledWith('view-1', ['parent-1'])
    expect(RecordApiService.createSubRecord).toHaveBeenCalledWith({
      table_id: 'table-1',
      parent_record_id: 'parent-1',
      parent_field_id: 'parent-field',
      data: { 'parent-field': { id: 'parent-1', title: '父记录 A' } },
    })

    const overlayCall = applyLocalCreateOverlay.mock.calls[0] as unknown as
      | [unknown, unknown, { subRecordTreePatch?: Record<string, unknown> }]
      | undefined
    const overlayOptions = overlayCall?.[2]
    const treePatch = overlayOptions?.subRecordTreePatch ?? {}
    const tempId = Object.keys(treePatch).find((key) => key !== 'parent-1')

    expect(applyLocalCreateOverlay).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          fields: { 'parent-field': { id: 'parent-1', title: '父记录 A' } },
        }),
      ]),
      { position: 'after', anchor_record_id: 'parent-1' },
      expect.objectContaining({
        subRecordTreePatch: expect.objectContaining({
          'parent-1': { depth: 0, has_children: true, parent_id: null },
        }),
      }),
    )
    expect(tempId).toEqual(expect.any(String))
    expect(treePatch[tempId as string]).toEqual({
      depth: 1,
      has_children: false,
      parent_id: 'parent-1',
    })
    expect(patchLocalCreateOverlayRecord).toHaveBeenCalledWith(
      tempId,
      { id: 'real-child' },
    )
    expect(refreshCurrentView).toHaveBeenCalled()
  })

  it('父记录已达最大层级时不应创建子记录并提示 maxDepthReached', async () => {
    const createRecord = vi.fn()
    const createSubRecordSpy = vi.spyOn(RecordApiService, 'createSubRecord')

    const currentViewRecords = {
      records: [{ id: 'd4' }],
      metadata: {
        sub_records: {
          parent_field_id: 'parent-field',
          tree_data: {
            d4: { depth: 4, has_children: false, parent_id: 'd3' },
          },
        },
      },
    }

    const { result } = renderHook(() =>
      useDataGridRecordOps({
        selectedTable: { id: 'table-1' },
        fields: [],
        records: [],
        currentViewRecords,
        currentView: {
          id: 'view-1',
          groups: [],
          filters: [],
          sorts: [],
          config: { subRecordParentFieldId: 'parent-field' },
        } as any,
        currentViewId: 'view-1',
        useViewData: true,
        isTableReadonly: false,
        isPersonalViewEnabled: false,
        allowViewMutation: true,
        fieldById: new Map(),
        gridApiRef: {
          current: {
            getDisplayedRowAtIndex: () => undefined,
            getDisplayedRowCount: () => 1,
            getFocusedCell: () => null,
          },
        },
        selectedRows: [],
        firstEditableField: 'Name',
        groupedRows: [{ id: 'd4', Name: 'D4', __treeDepth: 4 }],
        rowsData: [{ id: 'd4', Name: 'D4', __treeDepth: 4 }],
        subRecordParentFieldId: 'parent-field',
        resolvedCurrentView: {
          id: 'view-1',
          groups: [],
          filters: [],
          sorts: [],
          config: { subRecordParentFieldId: 'parent-field' },
        } as any,
        recordsQuery: { page: 1, page_size: 50 },
        createRecord,
        refreshCurrentView: vi.fn(),
        isCollabSyncActive: true,
        loadRecordsByTable: vi.fn(),
        updateView: vi.fn(),
        setPersonalViewDraft: vi.fn(),
        is403Error: () => false,
        mark403Readonly: vi.fn(),
        t: (key: string) => key,
      }),
    )

    await act(async () => {
      await result.current.handleInsertSubRecord('d4')
    })

    expect(createRecord).not.toHaveBeenCalled()
    expect(createSubRecordSpy).not.toHaveBeenCalled()
    expect(mockToast).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'table:subRecord.maxDepthReached',
        description: 'table:subRecord.maxDepthReached',
      }),
    )
  })

  it('协作在线（isCollabSyncActive）时新建子记录不应再触发 refreshCurrentView', async () => {
    const applyLocalCreateOverlay = vi.fn((
      records: any[],
      _orderContext?: unknown,
      _options?: unknown,
    ) =>
      records.map((record) => ({
        ...record,
        __viewOverlayEligible: true,
      }))
    )
    const patchLocalCreateOverlayRecord = vi.fn()
    const expandAllTreeRecords = vi.fn()
    const refreshCurrentView = vi.fn().mockResolvedValue(undefined)
    const loadRecordsByTable = vi.fn().mockResolvedValue(undefined)
    const updateRecord = vi.fn().mockResolvedValue(undefined)
    // 协作在线子记录走 collab createRecord（wrappedCreateRecord），它经 addRecord
    // 已把父链值写进 Y.Doc，返回乐观记录。
    const createRecord = vi.fn().mockResolvedValue({ id: 'real-child' })

    const currentViewRecords = {
      records: [{ id: 'parent-1' }],
      metadata: {
        sub_records: {
          parent_field_id: 'parent-field',
          tree_data: {
            'parent-1': { depth: 0, has_children: false, parent_id: null },
          },
        },
      },
    }
    const viewStoreApi = {
      getState: () => ({
        currentViewRecords,
        treeExpandedRecords: { 'view-1': new Set<string>() },
        expandAllTreeRecords,
      }),
    }

    const { result } = renderHook(() =>
      useDataGridRecordOps({
        selectedTable: { id: 'table-1' },
        fields: [],
        records: [],
        currentViewRecords,
        currentView: {
          id: 'view-1',
          groups: [],
          filters: [],
          sorts: [],
          config: { subRecordParentFieldId: 'parent-field' },
        } as any,
        currentViewId: 'view-1',
        useViewData: true,
        isTableReadonly: false,
        isPersonalViewEnabled: false,
        allowViewMutation: true,
        fieldById: new Map(),
        gridApiRef: {
          current: {
            getDisplayedRowAtIndex: () => undefined,
            getDisplayedRowCount: () => 1,
            getFocusedCell: () => null,
          },
        },
        selectedRows: [],
        firstEditableField: 'Name',
        groupedRows: [{ id: 'parent-1', Name: '父记录 A' }],
        rowsData: [{ id: 'parent-1', Name: '父记录 A' }],
        subRecordParentFieldId: 'parent-field',
        resolvedCurrentView: {
          id: 'view-1',
          groups: [],
          filters: [],
          sorts: [],
          config: { subRecordParentFieldId: 'parent-field' },
        } as any,
        recordsQuery: { page: 1, page_size: 50 },
        createRecord,
        refreshCurrentView,
        isCollabSyncActive: true,
        updateRecord,
        loadRecordsByTable,
        updateView: vi.fn().mockResolvedValue(undefined),
        setPersonalViewDraft: vi.fn(),
        is403Error: () => false,
        mark403Readonly: vi.fn(),
        applyLocalCreateOverlay,
        patchLocalCreateOverlayRecord,
        viewStoreApi: viewStoreApi as any,
        t: (key: string) => key,
      }),
    )

    await act(async () => {
      await result.current.handleInsertSubRecord('parent-1')
    })

    // 协作在线：走 collab createRecord，父链随 create 一并写进 Y.Doc。
    expect(createRecord).toHaveBeenCalledWith({
      table_id: 'table-1',
      fields: { 'parent-field': { id: 'parent-1', title: '父记录 A' } },
      fieldKeyType: 'id',
      order_context: { position: 'after', anchor_record_id: 'parent-1' },
    })
    // 不再走 REST createSubRecord / 冗余 updateRecord / 全量刷新。
    expect(RecordApiService.createSubRecord).not.toHaveBeenCalled()
    expect(updateRecord).not.toHaveBeenCalled()
    expect(refreshCurrentView).not.toHaveBeenCalled()
    expect(loadRecordsByTable).not.toHaveBeenCalled()
  })

  it('删除记录成功后应同步当前协作 Y.Doc 的行存在性', async () => {
    const refreshCurrentView = vi.fn().mockResolvedValue(undefined)
    const onRecordsDeleted = vi.fn()

    const { result } = renderHook(() =>
      useDataGridRecordOps({
        selectedTable: { id: 'table-1' },
        fields: [],
        records: [],
        currentViewRecords: { records: [] },
        currentView: null,
        currentViewId: null,
        useViewData: true,
        isTableReadonly: false,
        isPersonalViewEnabled: false,
        allowViewMutation: false,
        fieldById: new Map(),
        gridApiRef: {
          current: {
            getDisplayedRowAtIndex: () => undefined,
            getDisplayedRowCount: () => 0,
            getFocusedCell: () => null,
          },
        },
        selectedRows: [],
        firstEditableField: 'Name',
        groupedRows: [],
        rowsData: [],
        subRecordParentFieldId: null,
        resolvedCurrentView: null,
        recordsQuery: { page: 1, page_size: 50 },
        createRecord: vi.fn(),
        refreshCurrentView,
        loadRecordsByTable: vi.fn().mockResolvedValue(undefined),
        updateView: vi.fn().mockResolvedValue(undefined),
        setPersonalViewDraft: vi.fn(),
        is403Error: () => false,
        mark403Readonly: vi.fn(),
        onRecordsDeleted,
        t: (key: string) => key,
      }),
    )

    await act(async () => {
      await result.current.handleDeleteRecords(['r-delete'])
    })
    await act(async () => {
      await result.current.confirmDeleteRecords()
    })

    expect(mockBulkDeleteRecords).toHaveBeenCalledWith(['r-delete'])
    expect(onRecordsDeleted).toHaveBeenCalledWith(['r-delete'])
    expect(refreshCurrentView).toHaveBeenCalled()
  })

  it('协作在线时删除仍走权威 REST，成功后再镜像 Y.Doc', async () => {
    mockBulkDeleteRecords.mockImplementation(async (ids: string[]) => ({
      ok: true,
      deletedIds: [...ids],
      failedIds: [],
      errors: [],
    }))
    const refreshCurrentView = vi.fn().mockResolvedValue(undefined)
    const onRecordsDeleted = vi.fn()
    const setSelectedRows = vi.fn()
    const deselectAll = vi.fn()
    const clearFocusedCell = vi.fn()

    const { result } = renderHook(() =>
      useDataGridRecordOps({
        selectedTable: { id: 'table-1' },
        fields: [],
        records: [],
        currentViewRecords: { records: [] },
        currentView: null,
        currentViewId: null,
        useViewData: true,
        isTableReadonly: false,
        isPersonalViewEnabled: false,
        allowViewMutation: false,
        fieldById: new Map(),
        gridApiRef: {
          current: {
            getDisplayedRowAtIndex: () => undefined,
            getDisplayedRowCount: () => 0,
            getFocusedCell: () => null,
            deselectAll,
            clearFocusedCell,
          },
        },
        selectedRows: ['r1', 'r2', 'r3'],
        setSelectedRows,
        firstEditableField: 'Name',
        groupedRows: [],
        rowsData: [],
        subRecordParentFieldId: null,
        resolvedCurrentView: null,
        recordsQuery: { page: 1, page_size: 50 },
        createRecord: vi.fn(),
        refreshCurrentView,
        loadRecordsByTable: vi.fn().mockResolvedValue(undefined),
        updateView: vi.fn().mockResolvedValue(undefined),
        setPersonalViewDraft: vi.fn(),
        is403Error: () => false,
        mark403Readonly: vi.fn(),
        isCollabSyncActive: true,
        onRecordsDeleted,
        t: (key: string) => key,
      }),
    )

    const allIds = Array.from({ length: 30 }, (_, i) => `r-${i + 1}`)
    await act(async () => {
      await result.current.handleDeleteRecords(allIds)
    })
    await act(async () => {
      await result.current.confirmDeleteRecords()
    })

    expect(mockBulkDeleteRecords).toHaveBeenCalledWith(allIds)
    expect(onRecordsDeleted).toHaveBeenCalledWith(allIds)
    expect(deselectAll).toHaveBeenCalled()
    expect(setSelectedRows).toHaveBeenCalledWith([])
    expect(refreshCurrentView).toHaveBeenCalled()
  })

  it('协作镜像失败时刷新视图并提示可诊断错误', async () => {
    mockBulkDeleteRecords.mockImplementation(async (ids: string[]) => ({
      ok: true,
      deletedIds: [...ids],
      failedIds: [],
      errors: [],
    }))
    const refreshCurrentView = vi.fn().mockResolvedValue(undefined)
    const onRecordsDeleted = vi.fn(() => {
      throw new Error('mirror failed')
    })

    const { result } = renderHook(() =>
      useDataGridRecordOps({
        selectedTable: { id: 'table-1' },
        fields: [],
        records: [],
        currentViewRecords: { records: [] },
        currentView: null,
        currentViewId: null,
        useViewData: true,
        isTableReadonly: false,
        isPersonalViewEnabled: false,
        allowViewMutation: false,
        fieldById: new Map(),
        gridApiRef: {
          current: {
            getDisplayedRowAtIndex: () => undefined,
            getDisplayedRowCount: () => 0,
            getFocusedCell: () => null,
          },
        },
        selectedRows: ['r-delete'],
        firstEditableField: 'Name',
        groupedRows: [],
        rowsData: [],
        subRecordParentFieldId: null,
        resolvedCurrentView: null,
        recordsQuery: { page: 1, page_size: 50 },
        createRecord: vi.fn(),
        refreshCurrentView,
        loadRecordsByTable: vi.fn().mockResolvedValue(undefined),
        updateView: vi.fn().mockResolvedValue(undefined),
        setPersonalViewDraft: vi.fn(),
        is403Error: () => false,
        mark403Readonly: vi.fn(),
        isCollabSyncActive: true,
        onRecordsDeleted,
        t: (key: string) => key,
      }),
    )

    await act(async () => {
      await result.current.handleDeleteRecords(['r-delete'])
    })
    await act(async () => {
      await result.current.confirmDeleteRecords()
    })

    expect(mockBulkDeleteRecords).toHaveBeenCalledWith(['r-delete'])
    expect(onRecordsDeleted).toHaveBeenCalledWith(['r-delete'])
    expect(refreshCurrentView).toHaveBeenCalled()
    expect(mockToast).toHaveBeenCalledWith({
      title: 'table:error.deleteRecordFailed',
      description: 'table:error.deleteCollabSyncFailed',
      variant: 'destructive',
    })
  })

  it('删除记录失败时不应同步当前协作 Y.Doc', async () => {
    mockBulkDeleteRecords.mockResolvedValue({
      ok: false,
      deletedIds: [],
      failedIds: ['r-denied'],
      errors: ['删除失败，无权限'],
    })
    const refreshCurrentView = vi.fn().mockResolvedValue(undefined)
    const onRecordsDeleted = vi.fn()

    const { result } = renderHook(() =>
      useDataGridRecordOps({
        selectedTable: { id: 'table-1' },
        fields: [],
        records: [],
        currentViewRecords: { records: [] },
        currentView: null,
        currentViewId: null,
        useViewData: true,
        isTableReadonly: false,
        isPersonalViewEnabled: false,
        allowViewMutation: false,
        fieldById: new Map(),
        gridApiRef: {
          current: {
            getDisplayedRowAtIndex: () => undefined,
            getDisplayedRowCount: () => 0,
            getFocusedCell: () => null,
          },
        },
        selectedRows: [],
        firstEditableField: 'Name',
        groupedRows: [],
        rowsData: [],
        subRecordParentFieldId: null,
        resolvedCurrentView: null,
        recordsQuery: { page: 1, page_size: 50 },
        createRecord: vi.fn(),
        refreshCurrentView,
        loadRecordsByTable: vi.fn().mockResolvedValue(undefined),
        updateView: vi.fn().mockResolvedValue(undefined),
        setPersonalViewDraft: vi.fn(),
        is403Error: () => false,
        mark403Readonly: vi.fn(),
        onRecordsDeleted,
        t: (key: string) => key,
      }),
    )

    await act(async () => {
      await result.current.handleDeleteRecords(['r-denied'])
    })
    await act(async () => {
      await result.current.confirmDeleteRecords()
    })

    expect(mockBulkDeleteRecords).toHaveBeenCalledWith(['r-denied'])
    expect(onRecordsDeleted).not.toHaveBeenCalled()
    expect(refreshCurrentView).toHaveBeenCalled()
    expect(mockToast).toHaveBeenCalledWith({
      title: 'table:error.deleteRecordFailed',
      description: '删除失败，无权限',
      variant: 'destructive',
    })
  })

  it('已不存在的 ID 应镜像清理投影且不 toast ', async () => {
    mockBulkDeleteRecords.mockResolvedValue({
      ok: true,
      deletedIds: ['r-ghost'],
      failedIds: [],
      errors: [],
    })
    const refreshCurrentView = vi.fn().mockResolvedValue(undefined)
    const onRecordsDeleted = vi.fn()
    const removeOverlayRecords = vi.fn()

    const { result } = renderHook(() =>
      useDataGridRecordOps({
        selectedTable: { id: 'table-1' },
        fields: [],
        records: [],
        currentViewRecords: { records: [] },
        currentView: null,
        currentViewId: null,
        useViewData: true,
        isTableReadonly: false,
        isPersonalViewEnabled: false,
        allowViewMutation: false,
        fieldById: new Map(),
        gridApiRef: {
          current: {
            getDisplayedRowAtIndex: () => undefined,
            getDisplayedRowCount: () => 0,
            getFocusedCell: () => null,
            clearFocusedCell: vi.fn(),
            deselectAll: vi.fn(),
          },
        },
        selectedRows: [],
        setSelectedRows: vi.fn(),
        firstEditableField: 'Name',
        groupedRows: [],
        rowsData: [],
        subRecordParentFieldId: null,
        resolvedCurrentView: null,
        recordsQuery: { page: 1, page_size: 50 },
        createRecord: vi.fn(),
        refreshCurrentView,
        loadRecordsByTable: vi.fn().mockResolvedValue(undefined),
        updateView: vi.fn().mockResolvedValue(undefined),
        setPersonalViewDraft: vi.fn(),
        is403Error: () => false,
        mark403Readonly: vi.fn(),
        onRecordsDeleted,
        removeOverlayRecords,
        t: (key: string) => key,
      }),
    )

    await act(async () => {
      await result.current.handleDeleteRecords(['r-ghost'])
    })
    await act(async () => {
      await result.current.confirmDeleteRecords()
    })

    expect(mockBulkDeleteRecords).toHaveBeenCalledWith(['r-ghost'])
    expect(onRecordsDeleted).toHaveBeenCalledWith(['r-ghost'])
    expect(removeOverlayRecords).toHaveBeenCalledWith(['r-ghost'])
    expect(refreshCurrentView).toHaveBeenCalled()
    expect(mockToast).not.toHaveBeenCalled()
  })

  it('部分成功时只镜像成功删除的 ID 并刷新投影 ', async () => {
    mockBulkDeleteRecords.mockResolvedValue({
      ok: false,
      deletedIds: ['r-ok'],
      failedIds: ['r-conflict'],
      errors: ['[分批 1/1] 第2条: 并发冲突：记录 r-conflict 版本已变更'],
    })
    const refreshCurrentView = vi.fn().mockResolvedValue(undefined)
    const onRecordsDeleted = vi.fn()
    const setSelectedRows = vi.fn()
    const deselectAll = vi.fn()

    const { result } = renderHook(() =>
      useDataGridRecordOps({
        selectedTable: { id: 'table-1' },
        fields: [],
        records: [],
        currentViewRecords: { records: [] },
        currentView: null,
        currentViewId: null,
        useViewData: true,
        isTableReadonly: false,
        isPersonalViewEnabled: false,
        allowViewMutation: false,
        fieldById: new Map(),
        gridApiRef: {
          current: {
            getDisplayedRowAtIndex: () => undefined,
            getDisplayedRowCount: () => 0,
            getFocusedCell: () => null,
            deselectAll,
            clearFocusedCell: vi.fn(),
          },
        },
        selectedRows: ['r-ok', 'r-conflict'],
        setSelectedRows,
        firstEditableField: 'Name',
        groupedRows: [],
        rowsData: [],
        subRecordParentFieldId: null,
        resolvedCurrentView: null,
        recordsQuery: { page: 1, page_size: 50 },
        createRecord: vi.fn(),
        refreshCurrentView,
        loadRecordsByTable: vi.fn().mockResolvedValue(undefined),
        updateView: vi.fn().mockResolvedValue(undefined),
        setPersonalViewDraft: vi.fn(),
        is403Error: () => false,
        mark403Readonly: vi.fn(),
        isCollabSyncActive: true,
        onRecordsDeleted,
        t: (key: string) => key,
      }),
    )

    await act(async () => {
      await result.current.handleDeleteRecords(['r-ok', 'r-conflict'])
    })
    await act(async () => {
      await result.current.confirmDeleteRecords()
    })

    expect(mockBulkDeleteRecords).toHaveBeenCalledWith(['r-ok', 'r-conflict'])
    expect(onRecordsDeleted).toHaveBeenCalledWith(['r-ok'])
    expect(onRecordsDeleted).not.toHaveBeenCalledWith(['r-ok', 'r-conflict'])
    expect(refreshCurrentView).toHaveBeenCalled()
    expect(deselectAll).toHaveBeenCalled()
    expect(setSelectedRows).toHaveBeenCalledWith([])
    expect(mockToast).toHaveBeenCalledWith({
      title: 'table:error.deleteRecordFailed',
      description: '[分批 1/1] 第2条: 并发冲突：记录 r-conflict 版本已变更',
      variant: 'destructive',
    })
  })

  it('协作新建尚未确认时立即删除应折叠取消且不发 REST bulk-delete', async () => {
    const refreshCurrentView = vi.fn().mockResolvedValue(undefined)
    const onRecordsDeleted = vi.fn()
    const removeOverlayRecords = vi.fn()
    const cancelPendingCollabCreates = vi.fn((ids: readonly string[]) =>
      ids.filter((id) => id === 'pending-create'),
    )
    const deselectAll = vi.fn()
    const setSelectedRows = vi.fn()

    const { result } = renderHook(() =>
      useDataGridRecordOps({
        selectedTable: { id: 'table-1' },
        fields: [],
        records: [],
        currentViewRecords: { records: [] },
        currentView: null,
        currentViewId: null,
        useViewData: true,
        isTableReadonly: false,
        isPersonalViewEnabled: false,
        allowViewMutation: false,
        fieldById: new Map(),
        gridApiRef: {
          current: {
            getDisplayedRowAtIndex: () => undefined,
            getDisplayedRowCount: () => 0,
            getFocusedCell: () => null,
            deselectAll,
            clearFocusedCell: vi.fn(),
          },
        },
        selectedRows: ['pending-create'],
        setSelectedRows,
        firstEditableField: 'Name',
        groupedRows: [],
        rowsData: [],
        subRecordParentFieldId: null,
        resolvedCurrentView: null,
        recordsQuery: { page: 1, page_size: 50 },
        createRecord: vi.fn(),
        refreshCurrentView,
        loadRecordsByTable: vi.fn().mockResolvedValue(undefined),
        updateView: vi.fn().mockResolvedValue(undefined),
        setPersonalViewDraft: vi.fn(),
        is403Error: () => false,
        mark403Readonly: vi.fn(),
        removeOverlayRecords,
        onRecordsDeleted,
        cancelPendingCollabCreates,
        t: (key: string) => key,
      }),
    )

    await act(async () => {
      await result.current.executeDeleteRecords(['pending-create'])
    })

    expect(cancelPendingCollabCreates).toHaveBeenCalledWith(['pending-create'])
    expect(removeOverlayRecords).toHaveBeenCalledWith(['pending-create'])
    expect(mockBulkDeleteRecords).not.toHaveBeenCalled()
    expect(onRecordsDeleted).not.toHaveBeenCalled()
    expect(refreshCurrentView).not.toHaveBeenCalled()
    expect(mockToast).not.toHaveBeenCalled()
    expect(deselectAll).toHaveBeenCalled()
    expect(setSelectedRows).toHaveBeenCalledWith([])
  })

  it('混合删除时仅对已确认记录发 REST，pending 只折叠取消', async () => {
    const refreshCurrentView = vi.fn().mockResolvedValue(undefined)
    const onRecordsDeleted = vi.fn()
    const removeOverlayRecords = vi.fn()
    const cancelPendingCollabCreates = vi.fn((ids: readonly string[]) =>
      ids.filter((id) => id === 'pending-create'),
    )

    const { result } = renderHook(() =>
      useDataGridRecordOps({
        selectedTable: { id: 'table-1' },
        fields: [],
        records: [],
        currentViewRecords: { records: [] },
        currentView: null,
        currentViewId: null,
        useViewData: true,
        isTableReadonly: false,
        isPersonalViewEnabled: false,
        allowViewMutation: false,
        fieldById: new Map(),
        gridApiRef: {
          current: {
            getDisplayedRowAtIndex: () => undefined,
            getDisplayedRowCount: () => 0,
            getFocusedCell: () => null,
            deselectAll: vi.fn(),
            clearFocusedCell: vi.fn(),
          },
        },
        selectedRows: ['pending-create', 'persisted-1'],
        setSelectedRows: vi.fn(),
        firstEditableField: 'Name',
        groupedRows: [],
        rowsData: [],
        subRecordParentFieldId: null,
        resolvedCurrentView: null,
        recordsQuery: { page: 1, page_size: 50 },
        createRecord: vi.fn(),
        refreshCurrentView,
        loadRecordsByTable: vi.fn().mockResolvedValue(undefined),
        updateView: vi.fn().mockResolvedValue(undefined),
        setPersonalViewDraft: vi.fn(),
        is403Error: () => false,
        mark403Readonly: vi.fn(),
        removeOverlayRecords,
        onRecordsDeleted,
        cancelPendingCollabCreates,
        t: (key: string) => key,
      }),
    )

    await act(async () => {
      await result.current.executeDeleteRecords(['pending-create', 'persisted-1'])
    })

    expect(cancelPendingCollabCreates).toHaveBeenCalledWith([
      'pending-create',
      'persisted-1',
    ])
    expect(removeOverlayRecords).toHaveBeenCalledWith(['pending-create'])
    expect(mockBulkDeleteRecords).toHaveBeenCalledWith(['persisted-1'])
    expect(onRecordsDeleted).toHaveBeenCalledWith(['persisted-1'])
    expect(refreshCurrentView).toHaveBeenCalled()
  })
})
