import { renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  useDataGridSearch,
  type UseDataGridSearchParams,
} from './useDataGridSearch';

vi.mock('@tabtin/table-engine', () => ({
  resolveRecordId: (row: Record<string, unknown> | undefined) =>
    row?.__recordId ?? row?.id ?? null,
}));

vi.mock('@tabtin/table-core', () => ({
  fieldCellTextMatchesSearchQuery: (
    query: string,
    _fieldType: string | undefined,
    value: unknown,
  ) => String(value ?? '').toLowerCase().includes(query),
}));

vi.mock('@tabtin/table-ui', () => ({
  shouldActivateGridForSearchMatch: () => false,
}));

describe('useDataGridSearch', () => {
  it.each([
    { mode: 'local', useServerSearch: false },
    { mode: 'server', useServerSearch: true },
  ])('keeps collapsed group records searchable in $mode mode', async ({ useServerSearch }) => {
    const reportSearchState = vi.fn();
    const ensureSearchRowsVisible = vi.fn();
    const collapsedRows = [
      {
        id: '__group__status:done',
        __rowType: 'group_header',
        __groupPath: 'status:done',
        __groupCollapsed: true,
      },
    ];
    const searchableRows = [
      {
        __recordId: 'record-hidden',
        id: 'record-hidden',
        Name: 'collapsed-only needle',
        Status: 'Done',
      },
    ];
    let displayedRows = collapsedRows;
    const ensureIndexVisible = vi.fn();
    const gridApiRef = {
      current: {
        getDisplayedRowCount: () => displayedRows.length,
        getDisplayedRowAtIndex: (index: number) => ({ data: displayedRows[index] }),
        getFocusedCell: () => null,
        ensureIndexVisible,
        flashCells: vi.fn(),
      },
    };

    const params = {
        searchQuery: 'needle',
        searchScope: 'all_fields',
        searchSelectedFieldIds: [],
        searchHideNotMatchRows: true,
        searchNavigateRequest: null,
        reportSearchState,
        serverSearchHits: useServerSearch
          ? [{ index: 1, fieldId: 'field-name', recordId: 'record-hidden' }]
          : null,
        serverSearchLoading: false,
        serverSearchTotalCount: useServerSearch ? 1 : null,
        useServerSearch,
        serverSearchHasMore: false,
        serverSearchLoadNextPage: vi.fn(),
        isCollabRuntime: true,
        ensureSearchHitVisible: vi.fn(),
        orderedFields: [
          { id: 'field-name', name: 'Name', field_type: 'text' },
          { id: 'field-status', name: 'Status', field_type: 'text' },
        ],
        organizationMembers: [],
        columns: [
          { field: 'Name', fieldId: 'field-name' },
          { field: 'Status', fieldId: 'field-status' },
        ],
        gridApiRef,
        firstEditableField: 'Name',
        fieldIdByName: new Map([
          ['Name', 'field-name'],
          ['Status', 'field-status'],
        ]),
        groupedRowsForDisplay: collapsedRows,
        searchableRows,
        ensureSearchRowsVisible,
        useViewData: false,
        currentViewId: null,
        resolvedCurrentView: null,
        recordsQuery: { page: 1, page_size: 50 },
        viewStoreApi: { getState: () => ({}) },
      } as unknown as UseDataGridSearchParams;

    const { result, rerender } = renderHook(() => useDataGridSearch(params));

    await waitFor(() => {
      expect(reportSearchState).toHaveBeenLastCalledWith(
        expect.objectContaining({
          matchCount: 1,
          currentMatchIndex: 0,
        }),
      );
    });

    expect(ensureSearchRowsVisible).toHaveBeenCalledWith(['record-hidden']);
    expect(result.current.canvasSearchHitIndex).toEqual([
      { fieldId: 'field-name', recordId: 'record-hidden' },
    ]);
    expect(result.current.canvasSearchCursor).toBeNull();
    expect(result.current.searchFilteredRowsForDisplay).toEqual([]);
    expect(result.current.searchMetricRowsForDisplay).toEqual(searchableRows);

    displayedRows = [collapsedRows[0], searchableRows[0]];
    params.groupedRowsForDisplay = displayedRows;
    rerender();

    await waitFor(() => {
      expect(result.current.canvasSearchCursor).toEqual({ rowIndex: 1, colIndex: 0 });
      expect(ensureIndexVisible).toHaveBeenCalledWith(1, 'middle');
    });
    expect(result.current.searchFilteredRowsForDisplay).toEqual(displayedRows);
  });
});
