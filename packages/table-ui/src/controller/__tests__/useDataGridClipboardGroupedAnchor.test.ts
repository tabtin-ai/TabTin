import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useDataGridClipboard } from '../useDataGridClipboard';

const { mockToast } = vi.hoisted(() => ({
  mockToast: Object.assign(vi.fn(), {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
  }),
}));

vi.mock('@tabtin/smartsheet-ui', async (importOriginal) => {
  const original =
    await importOriginal<typeof import('@tabtin/smartsheet-ui')>();
  return {
    ...original,
    toast: mockToast,
    ToastAction: () => null,
  };
});

describe('useDataGridClipboard grouped anchor', () => {
  it('rowIndex 与 rowId 冲突时应按 rowId 更新目标记录', async () => {
    const rows = [
      { id: '__group__owner', __rowType: 'group_header' },
      ...Array.from({ length: 6 }, (_, index) => ({
        id: `record-${index + 1}`,
        Link: null,
      })),
    ];
    const bulkUpdateRecords = vi.fn().mockResolvedValue({
      records: [{ id: 'record-5' }],
      errors: [],
    });

    const { result } = renderHook(() =>
      useDataGridClipboard({
        columns: [
          {
            field: 'Link',
            fieldId: 'f_link',
            editable: true,
            type: 'url',
          },
        ],
        gridApiRef: {
          current: {
            getDisplayedRowCount: () => rows.length,
            getDisplayedRowAtIndex: (index: number) =>
              rows[index] ? { data: rows[index] } : undefined,
          },
        },
        tableId: 'table-1',
        refreshAfterPaste: vi.fn(),
        useViewData: true,
        buildCreatePlanFromDisplayRowIndex: vi.fn(() => ({
          orderContext: { position: 'end' },
        })),
        bulkUpdateRecords,
        bulkCreateRecords: vi.fn().mockResolvedValue([]),
        startPolling: vi.fn(),
        checkIfTriggersAutoField: () => [],
        t: (key: string) => key,
      }),
    );

    act(() => {
      result.current.handleClipboardPaste({
        operation: 'paste',
        text: 'https://example.com',
        cells: [
          {
            rowIndex: 4,
            colIndex: 0,
            rowId: 'record-5',
            field: 'Link',
            value: null,
          },
        ],
      });
    });

    await waitFor(() => {
      expect(bulkUpdateRecords).toHaveBeenCalledTimes(1);
    });
    expect(bulkUpdateRecords.mock.calls[0][0].updates).toEqual([
      {
        record_id: 'record-5',
        data: { f_link: 'https://example.com' },
      },
    ]);
  });
});
