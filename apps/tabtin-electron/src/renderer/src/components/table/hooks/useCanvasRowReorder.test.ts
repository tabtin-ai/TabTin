import { act, renderHook } from '@testing-library/react';
import { RecordApiService } from '@tabtin/table-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useCanvasRowReorder } from './useCanvasRowReorder';

vi.mock('@tabtin/smartsheet-ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tabtin/smartsheet-ui')>();
  return {
    ...actual,
    toast: vi.fn(),
  };
});

const row = (id: string, depth: number, parentId: string | null = null) => ({
  id,
  row_id: id,
  __treeDepth: depth,
  __treeParentId: parentId,
});

describe('useCanvasRowReorder', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(RecordApiService, 'reorderTree').mockResolvedValue({
      success: true,
      updated_record_ids: [],
    });
    vi.spyOn(RecordApiService, 'reorderRecords').mockResolvedValue({
      success: true,
      updated_count: 0,
      errors: [],
    } as any);
  });

  it('calls reorderTree for inside drops even when the flat row order is unchanged', async () => {
    const rows = [row('parent', 0), row('move', 0)] as any[];
    const refreshCurrentView = vi.fn().mockResolvedValue(undefined);

    const { result } = renderHook(() =>
      useCanvasRowReorder({
        selectedTableId: 'table-1',
        rowsForGridDisplay: rows,
        setCanvasOptimisticRows: vi.fn(),
        rowsData: rows,
        treeDataForMove: null,
        subRecordParentFieldId: 'parent-field',
        fieldById: new Map(),
        resolvedCurrentView: null,
        useViewData: true,
        currentViewId: 'view-1',
        refreshCurrentView,
        loadRecordsByTable: vi.fn().mockResolvedValue(undefined),
        page: 1,
        pageSize: 50,
        t: (key) => key,
        reorderInFlightRef: { current: false },
        isTableReadonly: false,
      }),
    );

    await act(async () => {
      result.current.handleCanvasRowMoved(['move'], {
        dropRowIndex: 1,
        dropMode: 'inside',
        targetRowId: 'parent',
      });
    });

    expect(RecordApiService.reorderTree).toHaveBeenCalledWith({
      table_id: 'table-1',
      moved_root_record_id: 'move',
      new_parent_id: 'parent',
      position: 'end',
      parent_field_id: 'parent-field',
      move_with_descendants: true,
    });
    expect(RecordApiService.reorderRecords).not.toHaveBeenCalled();
  });

  it('协作在线时层级移动走 Y.Doc，不调用 REST reorderTree', async () => {
    const rows = [row('parent', 0), row('move', 0)] as any[];
    const applyCollabTreeMove = vi.fn().mockReturnValue(true);
    const setCanvasOptimisticRows = vi.fn();
    const reorderInFlightRef = { current: false };

    const { result } = renderHook(() =>
      useCanvasRowReorder({
        selectedTableId: 'table-1',
        rowsForGridDisplay: rows,
        setCanvasOptimisticRows,
        rowsData: rows,
        treeDataForMove: null,
        subRecordParentFieldId: 'parent-field',
        fieldById: new Map(),
        resolvedCurrentView: null,
        useViewData: true,
        currentViewId: 'view-1',
        refreshCurrentView: vi.fn().mockResolvedValue(undefined),
        loadRecordsByTable: vi.fn().mockResolvedValue(undefined),
        page: 1,
        pageSize: 50,
        t: (key) => key,
        reorderInFlightRef,
        isTableReadonly: false,
        collabActive: true,
        applyCollabTreeMove,
      }),
    );

    await act(async () => {
      result.current.handleCanvasRowMoved(['move'], {
        dropRowIndex: 1,
        dropMode: 'inside',
        targetRowId: 'parent',
      });
    });

    expect(applyCollabTreeMove).toHaveBeenCalledWith(
      expect.objectContaining({
        movedRootId: 'move',
        changeParent: true,
        newParentId: 'parent',
        position: 'end',
      }),
    );
    expect(RecordApiService.reorderTree).not.toHaveBeenCalled();
    expect(RecordApiService.reorderRecords).not.toHaveBeenCalled();
    expect(setCanvasOptimisticRows).toHaveBeenLastCalledWith(null);
    expect(reorderInFlightRef.current).toBe(false);
  });

  it('协作态改父未接管时不退回 REST reorderTree', async () => {
    const rows = [row('parent', 0), row('move', 0)] as any[];
    const applyCollabTreeMove = vi.fn().mockResolvedValue(false);
    const setCanvasOptimisticRows = vi.fn();
    const reorderInFlightRef = { current: false };

    const { result } = renderHook(() =>
      useCanvasRowReorder({
        selectedTableId: 'table-1',
        rowsForGridDisplay: rows,
        setCanvasOptimisticRows,
        rowsData: rows,
        treeDataForMove: null,
        subRecordParentFieldId: 'parent-field',
        fieldById: new Map(),
        resolvedCurrentView: null,
        useViewData: true,
        currentViewId: 'view-1',
        refreshCurrentView: vi.fn().mockResolvedValue(undefined),
        loadRecordsByTable: vi.fn().mockResolvedValue(undefined),
        page: 1,
        pageSize: 50,
        t: (key) => key,
        reorderInFlightRef,
        isTableReadonly: false,
        collabActive: true,
        applyCollabTreeMove,
      }),
    );

    await act(async () => {
      result.current.handleCanvasRowMoved(['move'], {
        dropRowIndex: 1,
        dropMode: 'inside',
        targetRowId: 'parent',
      });
    });

    await vi.waitFor(() => {
      expect(reorderInFlightRef.current).toBe(false);
    });
    expect(RecordApiService.reorderTree).not.toHaveBeenCalled();
    expect(RecordApiService.reorderRecords).not.toHaveBeenCalled();
    // inside 落点行序未变：应清回 null，勿锁成快照
    expect(setCanvasOptimisticRows).toHaveBeenLastCalledWith(null);
  });
});
