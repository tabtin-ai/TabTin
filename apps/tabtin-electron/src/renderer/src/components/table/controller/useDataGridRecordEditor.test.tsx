import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { TableGridRow } from '@tabtin/table-engine';
import type { TableRecord } from '@tabtin/table-core';
import { RecordFormFocusTarget } from '@/components/record/recordFormFocusTarget';
import { useDataGridRecordEditor } from './useDataGridRecordEditor';

describe('useDataGridRecordEditor comment entry', () => {
  it('opens comments from the context menu with an explicit input-focus intent', () => {
    let registeredEditor: ((row: TableGridRow | null) => void) | undefined;
    const row = { __recordId: 'record-1' } as TableGridRow;
    const record = { id: 'record-1', data: { Title: 'A' } } as TableRecord;
    const { result } = renderHook(() =>
      useDataGridRecordEditor({
        useViewData: false,
        records: [record],
        currentViewRecords: null,
        visibleRecordIds: ['record-1'],
        registerRecordEditor: vi.fn((editor) => {
          registeredEditor = editor;
        }),
      }),
    );

    act(() => registeredEditor?.(row));
    expect(result.current.showEditDialog).toBe(true);
    expect(result.current.initialCommentsOpen).toBe(false);
    expect(result.current.initialFocusTarget).toBeNull();

    act(() => result.current.handleRecordDialogOpenChange(false));
    act(() => result.current.openRecordEditorWithComments(row));
    expect(result.current.showEditDialog).toBe(true);
    expect(result.current.initialCommentsOpen).toBe(true);
    expect(result.current.initialFocusTarget).toBeNull();

    act(() => result.current.handleRecordDialogOpenChange(false));
    act(() => result.current.openRecordEditorWithComments(row, {
      focusTarget: RecordFormFocusTarget.CommentInput,
    }));
    expect(result.current.showEditDialog).toBe(true);
    expect(result.current.initialCommentsOpen).toBe(true);
    expect(result.current.initialFocusTarget).toBe(RecordFormFocusTarget.CommentInput);
  });
});
