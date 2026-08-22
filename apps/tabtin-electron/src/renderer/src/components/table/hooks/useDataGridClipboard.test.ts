import React from 'react'
import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { planPasteOperations, useDataGridClipboard } from './useDataGridClipboard'

const {
  mockBulkCreateRecords,
  mockBulkUpdateRecords,
  mockToastDismiss,
  mockToast,
} = vi.hoisted(() => {
  const dismiss = vi.fn()
  const toastFn = Object.assign(
    vi.fn(() => ({
      id: 'toast-1',
      dismiss,
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
    mockBulkUpdateRecords: vi.fn(),
    mockToastDismiss: dismiss,
    mockToast: toastFn,
  }
})

vi.mock('@stores/useRecordStore', () => ({
  useRecordStore: (selector: (state: any) => unknown) =>
    selector({
      bulkCreateRecords: mockBulkCreateRecords,
      bulkUpdateRecords: mockBulkUpdateRecords,
    }),
}))

vi.mock('@tabtin/smartsheet-ui', () => ({
  toast: mockToast,
  validateFieldRules: vi.fn(() => ({ valid: true })),
  ToastAction: ({ children, ...props }: Record<string, unknown>) =>
    React.createElement('button', props, children),
}))

describe('planPasteOperations', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('在 grouped add 行粘贴超出 500 行时应保留 group 语义并统计截断', () => {
    const parsedRows = Array.from({ length: 502 }, (_, index) => [`Row ${index + 1}`])
    const result = planPasteOperations({
      parsedRows,
      anchorRowIndex: 10,
      anchorColIndex: 0,
      columns: [
        {
          field: 'Name',
          fieldId: 'f_name',
          editable: true,
          type: 'text',
        },
      ],
      tableId: 'table-1',
      getDisplayRowData: (displayRowIndex) =>
        displayRowIndex === 10
          ? ({
              id: '__group_add__',
              __rowType: 'group_add',
              __groupPath: '进行中',
              __groupValues: { Status: '进行中' },
            } as any)
          : undefined,
      buildCreatePlanFromDisplayRowIndex: () => ({
        orderContext: {
          view_id: 'view-1',
          anchor_record_id: 'anchor-1',
          position: 'after',
          group_values: { Status: '进行中' },
        },
        prefillValues: { Status: '进行中' },
      }),
    })

    expect(result.updatedCellCount).toBe(0)
    expect(result.createdRowCount).toBe(500)
    expect(result.truncatedRows).toBe(2)
    expect(result.skippedRows).toBe(2)
    expect(result.creates[0]).toEqual({
      data: {
        Status: '进行中',
        f_name: 'Row 1',
      },
    })
    expect(result.createPlan?.orderContext).toEqual({
      view_id: 'view-1',
      anchor_record_id: 'anchor-1',
      position: 'after',
      group_values: { Status: '进行中' },
    })
  })
})

describe('useDataGridClipboard', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockBulkUpdateRecords.mockResolvedValue({ records: [{ id: 'row-1' }], errors: [] })
    mockBulkCreateRecords.mockResolvedValue(
      Array.from({ length: 50 }, (_, index) => ({ id: `new-${index + 1}` })),
    )
  })

  it('大粘贴确认后应复用同一个 operation_group_id，并透传 view-aware create 语义', async () => {
    const startPolling = vi.fn()
    const buildCreatePlanFromDisplayRowIndex = vi.fn(() => ({
      orderContext: {
        view_id: 'view-1',
        anchor_record_id: 'row-1',
        position: 'after',
        group_values: { Status: '进行中' },
      },
      prefillValues: { Status: '进行中' },
    }))

    const { result } = renderHook(() =>
      useDataGridClipboard({
        columns: [
          {
            field: 'Name',
            fieldId: 'f_name',
            editable: true,
            type: 'text',
          },
        ],
        gridApiRef: {
          current: {
            getDisplayedRowAtIndex: (index: number) =>
              index === 0
                ? {
                    data: {
                      id: 'row-1',
                      Name: 'Old',
                      Status: '进行中',
                    },
                  }
                : undefined,
          },
        },
        tableId: 'table-1',
        refreshAfterPaste: vi.fn().mockResolvedValue(undefined),
        useViewData: false,
        buildCreatePlanFromDisplayRowIndex,
        startPolling,
        checkIfTriggersAutoField: (fieldNameOrId: string) =>
          fieldNameOrId === 'f_name' ? [{ id: 'ai-1' }] : [],
        t: (key: string) => key,
      }),
    )

    const rows = Array.from({ length: 51 }, (_, index) => `User ${index + 1}`).join('\n')

    act(() => {
      result.current.handleClipboardPaste({
        text: rows,
        html: null,
        cells: [{ rowIndex: 0, colIndex: 0 }],
        hasFiles: false,
      } as any)
    })

    expect(result.current.pasteConfirmState).toEqual({
      open: true,
      rowCount: 51,
      cellCount: 1,
      newRowCount: 50,
      skippedRows: 0,
      truncatedRows: 0,
    })

    act(() => {
      result.current.confirmPaste()
    })

    await waitFor(() => {
      expect(mockBulkUpdateRecords).toHaveBeenCalledTimes(1)
      expect(mockBulkCreateRecords).toHaveBeenCalledTimes(1)
    })

    const updatePayload = mockBulkUpdateRecords.mock.calls[0][0]
    const createPayload = mockBulkCreateRecords.mock.calls[0][0]

    expect(updatePayload.operation_group_id).toBe(createPayload.operation_group_id)
    expect(createPayload.order_context).toEqual({
      view_id: 'view-1',
      anchor_record_id: 'row-1',
      position: 'after',
      group_values: { Status: '进行中' },
    })
    expect(createPayload.records[0]).toEqual({
      Status: '进行中',
      f_name: 'User 2',
    })
    expect(buildCreatePlanFromDisplayRowIndex).toHaveBeenCalledWith(0)
    expect(startPolling).toHaveBeenCalledWith(new Set(['row-1_ai-1']))
  })

  it('纯 update 粘贴在视图模式下应刷新当前视图', async () => {
    const refreshAfterPaste = vi.fn().mockResolvedValue(undefined)

    const { result } = renderHook(() =>
      useDataGridClipboard({
        columns: [
          {
            field: 'Name',
            fieldId: 'f_name',
            editable: true,
            type: 'text',
          },
        ],
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
          },
        },
        tableId: 'table-1',
        refreshAfterPaste,
        useViewData: true,
        buildCreatePlanFromDisplayRowIndex: vi.fn(() => ({
          orderContext: { position: 'end' },
        })),
        startPolling: vi.fn(),
        checkIfTriggersAutoField: () => [],
        isCollabSyncActive: false,
        t: (key: string) => key,
      }),
    )

    act(() => {
      result.current.handleClipboardPaste({
        text: 'New value',
        html: null,
        cells: [{ rowIndex: 0, colIndex: 0 }],
        hasFiles: false,
      } as any)
    })

    await waitFor(() => {
      expect(mockBulkUpdateRecords).toHaveBeenCalledTimes(1)
      expect(refreshAfterPaste).toHaveBeenCalledTimes(1)
    })
  })

  it('协作在线的纯 update 粘贴不应立即拉取可能落后的视图快照', async () => {
    const refreshAfterPaste = vi.fn().mockResolvedValue(undefined)
    const optimisticRecord = {
      id: 'row-1',
      data: { Name: 'New value' },
      fields: { f_name: 'New value' },
      __optimistic: true,
      __optimisticSource: 'collab',
    }
    let resolveUpdate!: (record: typeof optimisticRecord) => void
    const updateRecord = vi.fn(
      () =>
        new Promise<typeof optimisticRecord>((resolve) => {
          resolveUpdate = resolve
        }),
    )

    const { result } = renderHook(() =>
      useDataGridClipboard({
        columns: [
          {
            field: 'Name',
            fieldId: 'f_name',
            editable: true,
            type: 'text',
          },
        ],
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
          },
        },
        tableId: 'table-1',
        refreshAfterPaste,
        useViewData: true,
        buildCreatePlanFromDisplayRowIndex: vi.fn(() => ({
          orderContext: { position: 'end' as const },
        })),
        startPolling: vi.fn(),
        checkIfTriggersAutoField: () => [],
        isCollabSyncActive: true,
        updateRecord,
        t: (key: string) => key,
      }),
    )

    act(() => {
      result.current.handleClipboardPaste({
        operation: 'paste',
        text: 'New value',
        cells: [
          {
            rowIndex: 0,
            colIndex: 0,
            field: 'Name',
            value: 'New value',
          },
        ],
        hasFiles: false,
      })
    })

    await waitFor(() => {
      expect(updateRecord).toHaveBeenCalledWith('row-1', {
        data: { f_name: 'New value' },
      })
    })
    expect(refreshAfterPaste).not.toHaveBeenCalled()

    await act(async () => {
      resolveUpdate(optimisticRecord)
    })

    await waitFor(() => {
      expect(mockToast).toHaveBeenCalledWith({
        description: 'table:clipboard.pastedCells',
        duration: 2500,
      })
    })

    expect(mockBulkUpdateRecords).not.toHaveBeenCalled()
    expect(refreshAfterPaste).not.toHaveBeenCalled()
  })

  it('协作在线多行自动创建应逐条推进 after 锚点，保持粘贴顺序', async () => {
    const createRecord = vi.fn()
      .mockResolvedValueOnce({ id: 'new-1' })
      .mockResolvedValueOnce({ id: 'new-2' })
      .mockResolvedValueOnce({ id: 'new-3' })

    const { result } = renderHook(() =>
      useDataGridClipboard({
        columns: [{ field: 'Name', fieldId: 'f_name', editable: true, type: 'text' }],
        gridApiRef: { current: { getDisplayedRowAtIndex: () => undefined, getDisplayedRowCount: () => 0 } },
        tableId: 'table-1',
        refreshAfterPaste: vi.fn(),
        useViewData: false,
        buildCreatePlanFromDisplayRowIndex: vi.fn(() => ({
          orderContext: {
            view_id: 'view-1',
            anchor_record_id: 'row-1',
            position: 'after' as const,
            group_values: { Status: '进行中' },
          },
        })),
        startPolling: vi.fn(),
        checkIfTriggersAutoField: () => [],
        isCollabSyncActive: true,
        createRecord,
        t: (key: string) => key,
      }),
    )

    act(() => {
      result.current.handleClipboardPaste({
        operation: 'paste',
        text: 'First\nSecond\nThird',
        cells: [{ rowIndex: 0, colIndex: 0 }],
        hasFiles: false,
      } as any)
    })

    await waitFor(() => expect(createRecord).toHaveBeenCalledTimes(3))

    expect(createRecord).toHaveBeenNthCalledWith(1, expect.objectContaining({
      order_context: {
        view_id: 'view-1',
        anchor_record_id: 'row-1',
        position: 'after',
        group_values: { Status: '进行中' },
      },
    }))
    expect(createRecord).toHaveBeenNthCalledWith(2, expect.objectContaining({
      order_context: {
        view_id: 'view-1',
        anchor_record_id: 'new-1',
        position: 'after',
        group_values: { Status: '进行中' },
      },
    }))
    expect(createRecord).toHaveBeenNthCalledWith(3, expect.objectContaining({
      order_context: {
        view_id: 'view-1',
        anchor_record_id: 'new-2',
        position: 'after',
        group_values: { Status: '进行中' },
      },
    }))
  })

  it('协作在线多行创建失败时不推进后续锚点', async () => {
    const createRecord = vi.fn()
      .mockResolvedValueOnce({ id: 'new-1' })
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'new-3' })

    const { result } = renderHook(() =>
      useDataGridClipboard({
        columns: [{ field: 'Name', fieldId: 'f_name', editable: true, type: 'text' }],
        gridApiRef: { current: { getDisplayedRowAtIndex: () => undefined, getDisplayedRowCount: () => 0 } },
        tableId: 'table-1',
        refreshAfterPaste: vi.fn(),
        useViewData: false,
        buildCreatePlanFromDisplayRowIndex: vi.fn(() => ({
          orderContext: { anchor_record_id: 'row-1', position: 'after' as const },
        })),
        startPolling: vi.fn(),
        checkIfTriggersAutoField: () => [],
        isCollabSyncActive: true,
        createRecord,
        t: (key: string) => key,
      }),
    )

    act(() => {
      result.current.handleClipboardPaste({
        operation: 'paste',
        text: 'First\nSecond\nThird',
        cells: [{ rowIndex: 0, colIndex: 0 }],
        hasFiles: false,
      } as any)
    })

    await waitFor(() => expect(createRecord).toHaveBeenCalledTimes(3))
    expect(createRecord).toHaveBeenNthCalledWith(3, expect.objectContaining({
      order_context: { anchor_record_id: 'new-1', position: 'after' },
    }))
  })

  it('自动创建后的新记录若已在当前网格可见，应自动定位', async () => {
    mockBulkCreateRecords.mockResolvedValue([{ id: 'new-1' }])
    const onRecordCreated = vi.fn()
    const refreshAfterPaste = vi.fn().mockResolvedValue(undefined)
    let displayedRows: Array<Record<string, unknown>> = []
    refreshAfterPaste.mockImplementation(async () => {
      displayedRows = [
        {
          id: 'new-1',
          Name: 'New value',
        },
      ]
    })

    const { result } = renderHook(() =>
      useDataGridClipboard({
        columns: [
          {
            field: 'Name',
            fieldId: 'f_name',
            editable: true,
            type: 'text',
          },
        ],
        gridApiRef: {
          current: {
            getDisplayedRowAtIndex: (index: number) =>
              displayedRows[index]
                ? {
                    data: displayedRows[index],
                  }
                : undefined,
            getDisplayedRowCount: () => displayedRows.length,
          },
        },
        tableId: 'table-1',
        refreshAfterPaste,
        useViewData: true,
        buildCreatePlanFromDisplayRowIndex: vi.fn(() => ({
          orderContext: { position: 'end' },
        })),
        onRecordCreated,
        startPolling: vi.fn(),
        checkIfTriggersAutoField: () => [],
        t: (key: string) => key,
      }),
    )

    act(() => {
      result.current.handleClipboardPaste({
        text: 'New value',
        html: null,
        cells: [{ rowIndex: 0, colIndex: 0 }],
        hasFiles: false,
      } as any)
    })

    await waitFor(() => {
      expect(mockBulkCreateRecords).toHaveBeenCalledTimes(1)
      expect(refreshAfterPaste).toHaveBeenCalledTimes(1)
      expect(onRecordCreated).toHaveBeenCalledWith({ id: 'new-1' })
    })
  })

  it('纯 auto-create 命中 local overlay 时不应再触发 refreshAfterPaste', async () => {
    mockBulkCreateRecords.mockResolvedValue([{ id: 'new-1' }])
    const refreshAfterPaste = vi.fn().mockResolvedValue(undefined)
    const applyLocalCreateOverlay = vi.fn((records: any[]) =>
      records.map((record) => ({
        ...record,
        __viewOverlayEligible: true,
      }))
    )

    const { result } = renderHook(() =>
      useDataGridClipboard({
        columns: [
          {
            field: 'Name',
            fieldId: 'f_name',
            editable: true,
            type: 'text',
          },
        ],
        gridApiRef: {
          current: {
            getDisplayedRowAtIndex: () => undefined,
            getDisplayedRowCount: () => 0,
          },
        },
        tableId: 'table-1',
        refreshAfterPaste,
        useViewData: true,
        buildCreatePlanFromDisplayRowIndex: vi.fn(() => ({
          orderContext: {
            view_id: 'view-1',
            anchor_record_id: 'row-1',
            position: 'after',
          },
        })),
        applyLocalCreateOverlay,
        startPolling: vi.fn(),
        checkIfTriggersAutoField: () => [],
        t: (key: string) => key,
      }),
    )

    act(() => {
      result.current.handleClipboardPaste({
        text: 'New row',
        html: null,
        cells: [{ rowIndex: 0, colIndex: 0 }],
        hasFiles: false,
      } as any)
    })

    await waitFor(() => {
      expect(mockBulkCreateRecords).toHaveBeenCalledTimes(1)
    })

    expect(refreshAfterPaste).not.toHaveBeenCalled()
  })
})
