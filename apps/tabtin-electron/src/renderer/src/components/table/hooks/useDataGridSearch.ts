/**
 * useDataGridSearch - 搜索逻辑 hook
 *
 * 职责：
 * 1. 本地搜索（遍历已加载行匹配关键词）
 * 2. 服务端搜索（接收外部 serverSearchHits）
 * 3. Canvas 搜索高亮目标计算
 * 4. 搜索导航（上一个/下一个匹配）
 * 5. 搜索过滤显示行（hideNotMatchRows 模式）
 * 6. 视图级搜索查询（server-side search_hide_not_match_rows）
 */

import React from 'react';
import {
  resolveRecordId,
  type TableGridRendererProps,
} from '@tabtin/table-engine';
import {
  fieldCellTextMatchesSearchQuery,
  type Field,
  type SearchIndexHit,
  type ViewMeta,
} from '@tabtin/table-core';
import { shouldActivateGridForSearchMatch } from '@tabtin/table-ui';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SearchMatch {
  rowIndex: number;
  field: string;
  rowId: string;
}

export interface CanvasSearchCursor {
  rowIndex: number;
  colIndex: number;
}

type GridDisplayRows = TableGridRendererProps['rows'];
type GridDisplayRow = GridDisplayRows[number];

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

const MAX_CANVAS_SEARCH_TARGETS = 1200;
const LOCAL_SEARCH_MAX_ROWS = 5000;
// 服务端搜索导航接近已缓存命中尾部时提前预取下一页的剩余阈值。
const SERVER_SEARCH_PREFETCH_THRESHOLD = 20;

const normalizeEntityId = (id: string): string =>
  id.trim().toLowerCase().replace(/-/g, '');

const resolveRowRecordId = (row: Record<string, unknown> | undefined): string | null =>
  resolveRecordId(row);

export const areCanvasSearchCursorEqual = (
  left: CanvasSearchCursor | null,
  right: CanvasSearchCursor | null,
): boolean => {
  if (left === right) return true;
  if (!left || !right) return false;
  return left.rowIndex === right.rowIndex && left.colIndex === right.colIndex;
};

export const areCanvasSearchTargetsEqual = (
  left: CanvasSearchCursor[],
  right: CanvasSearchCursor[],
): boolean => {
  if (left === right) return true;
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    const leftItem = left[index];
    const rightItem = right[index];
    if (!leftItem || !rightItem) return false;
    if (
      leftItem.rowIndex !== rightItem.rowIndex ||
      leftItem.colIndex !== rightItem.colIndex
    ) {
      return false;
    }
  }
  return true;
};

// ---------------------------------------------------------------------------
// Hook params & return
// ---------------------------------------------------------------------------

interface ColumnDef {
  field: string;
  fieldId?: string;
}

interface OrganizationMemberOption {
  id: string;
  name: string;
}

export interface UseDataGridSearchParams {
  searchQuery: string;
  searchScope: string;
  searchSelectedFieldIds: string[];
  searchHideNotMatchRows: boolean;
  searchNavigateRequest: { direction: 'next' | 'prev' } | null;
  reportSearchState: (state: {
    matchCount: number;
    currentMatchIndex: number;
    currentField: string | null;
    searchLimitReached?: boolean;
  }) => void;
  serverSearchHits: SearchIndexHit[] | null;
  serverSearchLoading: boolean;
  serverSearchTotalCount: number | null;
  useServerSearch: boolean;
  serverSearchHasMore: boolean;
  serverSearchLoadNextPage: () => void;
  isCollabRuntime: boolean;
  ensureSearchHitVisible: (hit: SearchIndexHit) => Promise<boolean> | boolean;
  orderedFields: Field[];
  organizationMembers: OrganizationMemberOption[];
  columns: ColumnDef[];
  gridApiRef: React.RefObject<any>;
  firstEditableField: string | null;
  fieldIdByName: Map<string, string>;
  /** Display rows after draft injection, before search filtering */
  groupedRowsForDisplay: GridDisplayRows;
  /** Data rows eligible for search before group-collapse projection. */
  searchableRows: GridDisplayRows;
  /** Temporarily reveal collapsed groups containing the supplied records. */
  ensureSearchRowsVisible: (recordIds: string[]) => void;
  /** Whether view-level data is used (view API) */
  useViewData: boolean;
  currentViewId: string | null;
  resolvedCurrentView: ViewMeta | null;
  recordsQuery: {
    page: number;
    page_size: number;
    since_version?: number | null;
    only_delta?: boolean;
  };
  viewStoreApi: { getState: () => any };
}

export interface UseDataGridSearchReturn {
  canvasSearchCursor: CanvasSearchCursor | null;
  canvasSearchTargets: CanvasSearchCursor[];
  canvasSearchHitIndex: { fieldId: string; recordId: string }[];
  normalizedSearchQuery: string;
  matchedSearchRowIds: Set<string> | null;
  searchFilteredRowsForDisplay: GridDisplayRows;
  searchMetricRowsForDisplay: GridDisplayRows;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useDataGridSearch({
  searchQuery,
  searchScope,
  searchSelectedFieldIds,
  searchHideNotMatchRows,
  searchNavigateRequest,
  reportSearchState,
  serverSearchHits,
  serverSearchLoading,
  serverSearchTotalCount,
  useServerSearch,
  serverSearchHasMore,
  serverSearchLoadNextPage,
  isCollabRuntime,
  ensureSearchHitVisible,
  orderedFields,
  organizationMembers,
  columns,
  gridApiRef,
  firstEditableField,
  fieldIdByName,
  groupedRowsForDisplay,
  searchableRows,
  ensureSearchRowsVisible,
  useViewData,
  currentViewId,
  resolvedCurrentView,
  recordsQuery,
  viewStoreApi,
}: UseDataGridSearchParams): UseDataGridSearchReturn {
  // ── Canvas search state ──
  const [canvasSearchCursor, setCanvasSearchCursor] =
    React.useState<CanvasSearchCursor | null>(null);
  const [canvasSearchTargets, setCanvasSearchTargets] = React.useState<
    CanvasSearchCursor[]
  >([]);
  const [canvasSearchHitIndex, setCanvasSearchHitIndex] = React.useState<
    { fieldId: string; recordId: string }[]
  >([]);

  const columnIndexByField = React.useMemo(() => {
    const map = new Map<string, number>();
    columns.forEach((column, index) => {
      map.set(column.field, index);
    });
    return map;
  }, [columns]);

  const fieldNameToFieldId = React.useMemo(() => {
    const map = new Map<string, string>();
    for (const field of orderedFields) {
      if (field.name && field.id) {
        map.set(field.name, field.id);
      }
    }
    return map;
  }, [orderedFields]);

  const fieldTypeByName = React.useMemo(() => {
    const map = new Map<string, string>();
    for (const field of orderedFields) {
      if (field.name) {
        map.set(field.name, field.field_type);
      }
    }
    return map;
  }, [orderedFields]);

  const memberNameById = React.useMemo(
    () =>
      new Map(
        organizationMembers.map((member) => [String(member.id), member.name] as const),
      ),
    [organizationMembers],
  );

  const matchesSearchCell = React.useCallback(
    (query: string, fieldName: string, value: unknown): boolean =>
      fieldCellTextMatchesSearchQuery(
        query,
        fieldTypeByName.get(fieldName),
        value,
        memberNameById,
      ),
    [fieldTypeByName, memberNameById],
  );

  const resolveSearchHitIndex = React.useCallback(
    (matches: SearchMatch[]): { fieldId: string; recordId: string }[] => {
      if (!matches.length) return [];
      const hits: { fieldId: string; recordId: string }[] = [];
      const dedupe = new Set<string>();
      for (const match of matches) {
        const fieldId = fieldNameToFieldId.get(match.field);
        if (!fieldId || !match.rowId) continue;
        const key = `${match.rowId}-${fieldId}`;
        if (dedupe.has(key)) continue;
        dedupe.add(key);
        hits.push({ fieldId, recordId: match.rowId });
        if (hits.length >= MAX_CANVAS_SEARCH_TARGETS) break;
      }
      return hits;
    },
    [fieldNameToFieldId],
  );

  const currentSearchMatchIndexRef = React.useRef(-1);
  const currentSearchSignatureRef = React.useRef('');
  const ensuringServerHitKeyRef = React.useRef<string | null>(null);
  const ensuringServerHitSeqRef = React.useRef(0);
  const pendingServerHitFocusRef = React.useRef<{
    hitIndex: number;
    recordId: string;
    signature: string;
  } | null>(null);
  const pendingServerNavigateRef = React.useRef<{
    fromIndex: number;
    direction: 'next' | 'prev';
    signature: string;
  } | null>(null);

  // ── Search utility callbacks ──

  const isSearchableDataRow = React.useCallback((row: unknown) => {
    if (!row || typeof row !== 'object') return false;
    const rowType = (row as Record<string, unknown>).__rowType;
    return !rowType;
  }, []);

  const focusSearchMatch = React.useCallback(
    (match: SearchMatch, options?: { flash?: boolean }) => {
      if (match.rowIndex < 0) {
        ensureSearchRowsVisible([match.rowId]);
        return;
      }

      const api = gridApiRef.current;
      if (!api) return;

      api.ensureIndexVisible?.(match.rowIndex, 'middle');
      if (shouldActivateGridForSearchMatch()) {
        api.setFocusedCell?.(match.rowIndex, match.field);
      }

      if (options?.flash === false) return;

      const rowNode = api.getDisplayedRowAtIndex?.(match.rowIndex);
      api.flashCells?.({
        rowNodes: rowNode ? [rowNode] : undefined,
        flashDelay: 200,
        fadeDelay: 520,
      });
    },
    [ensureSearchRowsVisible, gridApiRef],
  );

  const resolveSearchFieldContext = React.useCallback(() => {
    const searchableFields = orderedFields.filter((field) =>
      Boolean(field.name),
    );
    const searchableFieldNames = searchableFields
      .map((field) => field.name)
      .filter((name): name is string => Boolean(name));

    if (searchScope === 'all_fields') {
      return {
        currentField: null,
        activeSearchFields: searchableFieldNames,
      };
    }

    const selectedFieldNameSet = new Set(
      searchableFields
        .filter((field) => searchSelectedFieldIds.includes(field.id))
        .map((field) => field.name),
    );
    const selectedFieldNames = searchableFieldNames.filter((name) =>
      selectedFieldNameSet.has(name),
    );

    if (selectedFieldNames.length > 0) {
      return {
        currentField:
          selectedFieldNames.length === 1 ? selectedFieldNames[0] : null,
        activeSearchFields: selectedFieldNames,
      };
    }

    const focusedField = gridApiRef.current?.getFocusedCell?.()?.field ?? null;
    const fallbackField = searchableFieldNames.includes(String(focusedField))
      ? String(focusedField)
      : firstEditableField && searchableFieldNames.includes(firstEditableField)
        ? firstEditableField
        : (searchableFieldNames[0] ?? null);

    return {
      currentField: fallbackField,
      activeSearchFields: fallbackField ? [fallbackField] : [],
    };
  }, [
    firstEditableField,
    gridApiRef,
    orderedFields,
    searchScope,
    searchSelectedFieldIds,
  ]);

  const resolveSearchRowId = React.useCallback(
    (
      rowData: Record<string, unknown> | undefined,
      fallbackIndex: number,
    ): string => {
      return resolveRecordId(rowData) ?? `row_${fallbackIndex}`;
    },
    [],
  );

  const collectSearchMatches = React.useCallback(
    (
      normalizedQuery: string,
    ): { matches: SearchMatch[]; currentField: string | null; limitReached: boolean } => {
      const { activeSearchFields, currentField: resolvedCurrentField } =
        resolveSearchFieldContext();

      if (!normalizedQuery || activeSearchFields.length === 0) {
        return { matches: [], currentField: resolvedCurrentField, limitReached: false };
      }

      const visibleRowIndexById = new Map<string, number>();
      const displayedCount =
        gridApiRef.current?.getDisplayedRowCount?.() ?? 0;

      if (displayedCount > 0 && gridApiRef.current?.getDisplayedRowAtIndex) {
        for (let index = 0; index < displayedCount; index += 1) {
          const rowNode = gridApiRef.current.getDisplayedRowAtIndex(index);
          const recordId = resolveRowRecordId(
            rowNode?.data as Record<string, unknown> | undefined,
          );
          if (recordId) {
            visibleRowIndexById.set(normalizeEntityId(recordId), index);
          }
        }
      } else {
        groupedRowsForDisplay.forEach((row, index) => {
          const recordId = resolveRowRecordId(row as Record<string, unknown>);
          if (recordId) {
            visibleRowIndexById.set(normalizeEntityId(recordId), index);
          }
        });
      }

      const matches: SearchMatch[] = [];
      const searchableCount = Math.min(searchableRows.length, LOCAL_SEARCH_MAX_ROWS);
      for (let index = 0; index < searchableCount; index += 1) {
        const data = searchableRows[index] as Record<string, unknown> | undefined;
        if (!isSearchableDataRow(data)) continue;

        const rowId = resolveSearchRowId(data, index);
        const visibleRowIndex =
          visibleRowIndexById.get(normalizeEntityId(rowId)) ?? -1;

        for (let fi = 0; fi < activeSearchFields.length; fi += 1) {
          const fieldName = activeSearchFields[fi];
          // 只匹配展示文本，避免 link/user UUID id 被数字查询误命中
          if (matchesSearchCell(normalizedQuery, fieldName, data?.[fieldName])) {
            matches.push({ rowIndex: visibleRowIndex, field: fieldName, rowId });
          }
        }
      }

      return {
        matches,
        currentField: resolvedCurrentField,
        limitReached: searchableRows.length > LOCAL_SEARCH_MAX_ROWS,
      };
    },
    [
      gridApiRef,
      groupedRowsForDisplay,
      isSearchableDataRow,
      matchesSearchCell,
      resolveSearchFieldContext,
      resolveSearchRowId,
      searchableRows,
    ],
  );

  const resolveCanvasSearchCursor = React.useCallback(
    (match: SearchMatch | null): CanvasSearchCursor | null => {
      if (!match || match.rowIndex < 0) return null;
      const colIndex = columnIndexByField.get(match.field);
      if (colIndex == null || colIndex < 0) return null;
      return { rowIndex: match.rowIndex, colIndex };
    },
    [columnIndexByField],
  );

  const resolveCanvasSearchTargets = React.useCallback(
    (matches: SearchMatch[]): CanvasSearchCursor[] => {
      if (!matches.length) return [];
      const targets: CanvasSearchCursor[] = [];
      const dedupe = new Set<string>();
      for (const match of matches) {
        if (match.rowIndex < 0) continue;
        const colIndex = columnIndexByField.get(match.field);
        if (colIndex == null || colIndex < 0) continue;
        const key = `${match.rowIndex}:${colIndex}`;
        if (dedupe.has(key)) continue;
        dedupe.add(key);
        targets.push({ rowIndex: match.rowIndex, colIndex });
        if (targets.length >= MAX_CANVAS_SEARCH_TARGETS) break;
      }
      return targets;
    },
    [columnIndexByField],
  );

  // ── Derived search state ──

  const normalizedSearchQuery = React.useMemo(
    () => searchQuery.trim().toLowerCase(),
    [searchQuery],
  );

  const isGridLikeView = React.useMemo(() => {
    const viewType = resolvedCurrentView?.view_type as string | undefined;
    return viewType === 'grid' || viewType === 'list';
  }, [resolvedCurrentView?.view_type]);

  const searchFieldIdsForViewQuery = React.useMemo(() => {
    const validFieldIds = new Set(orderedFields.map((field) => field.id));

    if (searchScope === 'all_fields') {
      return orderedFields
        .map((field) => field.id)
        .filter((fieldId) => validFieldIds.has(fieldId));
    }

    const selectedFieldIds = searchSelectedFieldIds.filter((fieldId) =>
      validFieldIds.has(fieldId),
    );
    if (selectedFieldIds.length > 0) {
      return selectedFieldIds;
    }

    const fallbackFieldId =
      (firstEditableField
        ? fieldIdByName.get(firstEditableField)
        : undefined) ?? orderedFields[0]?.id;
    return fallbackFieldId ? [fallbackFieldId] : [];
  }, [
    fieldIdByName,
    firstEditableField,
    orderedFields,
    searchScope,
    searchSelectedFieldIds,
  ]);

  const useServerSideHiddenRows = React.useMemo(
    () =>
      Boolean(
        useViewData &&
          currentViewId &&
          !isCollabRuntime &&
          isGridLikeView &&
          searchHideNotMatchRows &&
          normalizedSearchQuery.length > 0,
      ),
    [
      currentViewId,
      isCollabRuntime,
      isGridLikeView,
      normalizedSearchQuery.length,
      searchHideNotMatchRows,
      useViewData,
    ],
  );

  // ── Server-side view search debounce ──

  const viewSearchQuerySignatureRef = React.useRef('');
  const viewSearchQueryAppliedRef = React.useRef(false);
  const viewSearchDebounceRef = React.useRef<ReturnType<
    typeof setTimeout
  > | null>(null);

  React.useEffect(() => {
    viewSearchQuerySignatureRef.current = '';
    viewSearchQueryAppliedRef.current = false;
    if (viewSearchDebounceRef.current) {
      clearTimeout(viewSearchDebounceRef.current);
      viewSearchDebounceRef.current = null;
    }
  }, [currentViewId]);

  React.useEffect(() => {
    if (!useViewData || !currentViewId || !isGridLikeView) {
      return;
    }

    const shouldApplySearchQuery = useServerSideHiddenRows;
    if (!shouldApplySearchQuery && !viewSearchQueryAppliedRef.current) {
      return;
    }

    const viewSearchText = shouldApplySearchQuery ? searchQuery.trim() : '';
    const searchFieldIds = shouldApplySearchQuery
      ? searchFieldIdsForViewQuery
      : [];
    const searchFieldIdsKey = searchFieldIds.join(',');
    const targetPage = 1;
    const nextSignature = [
      currentViewId,
      shouldApplySearchQuery ? '1' : '0',
      viewSearchText,
      searchFieldIdsKey,
      targetPage,
      recordsQuery.page_size,
      recordsQuery.since_version ?? '',
      recordsQuery.only_delta ? '1' : '0',
    ].join('::');

    if (viewSearchQuerySignatureRef.current === nextSignature) {
      return;
    }

    if (viewSearchDebounceRef.current) {
      clearTimeout(viewSearchDebounceRef.current);
      viewSearchDebounceRef.current = null;
    }

    const runFetch = () => {
      viewSearchQuerySignatureRef.current = nextSignature;
      viewSearchQueryAppliedRef.current = shouldApplySearchQuery;

      const nextQuery = {
        ...recordsQuery,
        search: shouldApplySearchQuery ? viewSearchText : undefined,
        search_field_ids:
          shouldApplySearchQuery && searchFieldIds.length > 0
            ? searchFieldIds
            : undefined,
        search_hide_not_match_rows: shouldApplySearchQuery ? true : undefined,
        page: targetPage,
      };

      void viewStoreApi
        .getState()
        .fetchViewRecords(currentViewId, nextQuery);
    };

    if (shouldApplySearchQuery) {
      viewSearchDebounceRef.current = setTimeout(() => {
        viewSearchDebounceRef.current = null;
        runFetch();
      }, 300);
    } else {
      runFetch();
    }

    return () => {
      if (viewSearchDebounceRef.current) {
        clearTimeout(viewSearchDebounceRef.current);
        viewSearchDebounceRef.current = null;
      }
    };
  }, [
    currentViewId,
    isGridLikeView,
    recordsQuery,
    searchFieldIdsForViewQuery,
    searchQuery,
    useServerSideHiddenRows,
    useViewData,
    viewStoreApi,
  ]);

  // ── Server hit conversion ──

  const fieldIdToNameMap = React.useMemo(() => {
    const map = new Map<string, string>();
    for (const field of orderedFields) {
      map.set(field.id, field.name);
      map.set(normalizeEntityId(field.id), field.name);
    }
    return map;
  }, [orderedFields]);

  const recordIdToRowIndexMap = React.useMemo(() => {
    const map = new Map<string, number>();
    const allRows = groupedRowsForDisplay ?? [];
    for (let i = 0; i < allRows.length; i += 1) {
      const row = allRows[i] as Record<string, unknown> | undefined;
      const recordId = resolveRowRecordId(row);
      if (!recordId) continue;
      map.set(normalizeEntityId(recordId), i);
    }
    return map;
  }, [groupedRowsForDisplay]);

  const convertServerHitsToMatches = React.useCallback(
    (
      hits: Array<{ index: number; fieldId: string; recordId: string }>,
    ): {
      matches: SearchMatch[];
      currentField: string | null;
    } => {
      if (!hits.length) return { matches: [], currentField: null };

      const matches: SearchMatch[] = [];
      let firstFieldName: string | null = null;

      for (const hit of hits) {
        const fieldName =
          fieldIdToNameMap.get(hit.fieldId) ??
          fieldIdToNameMap.get(normalizeEntityId(hit.fieldId));
        if (!fieldName) continue;

        if (!firstFieldName) firstFieldName = fieldName;

        const rowIndex = recordIdToRowIndexMap.get(normalizeEntityId(hit.recordId));
        if (rowIndex === undefined) {
          continue;
        }

        matches.push({
          rowIndex,
          field: fieldName,
          rowId: hit.recordId,
        });
      }

      return { matches, currentField: firstFieldName };
    },
    [fieldIdToNameMap, recordIdToRowIndexMap],
  );

  const convertServerHitToMatch = React.useCallback(
    (hit: SearchIndexHit): { match: SearchMatch | null; currentField: string | null } => {
      const fieldName =
        fieldIdToNameMap.get(hit.fieldId) ??
        fieldIdToNameMap.get(normalizeEntityId(hit.fieldId)) ??
        null;
      if (!fieldName) {
        return { match: null, currentField: null };
      }

      const rowIndex = recordIdToRowIndexMap.get(normalizeEntityId(hit.recordId));
      if (rowIndex === undefined) {
        return { match: null, currentField: fieldName };
      }

      return {
        match: {
          rowIndex,
          field: fieldName,
          rowId: hit.recordId,
        },
        currentField: fieldName,
      };
    },
    [fieldIdToNameMap, recordIdToRowIndexMap],
  );

  const serverSearchSignature = React.useMemo(
    () =>
      `server::${normalizedSearchQuery}::${searchScope}::${searchSelectedFieldIds.join(',')}::${searchHideNotMatchRows ? 'hide' : 'all'}`,
    [
      normalizedSearchQuery,
      searchHideNotMatchRows,
      searchScope,
      searchSelectedFieldIds,
    ],
  );

  const requestServerHitVisible = React.useCallback(
    (hit: SearchIndexHit) => {
      ensureSearchRowsVisible([String(hit.recordId)]);
      const ensureKey = `${serverSearchSignature}::${hit.index}::${hit.recordId}::${hit.fieldId}`;
      if (ensuringServerHitKeyRef.current === ensureKey) {
        return;
      }

      ensuringServerHitKeyRef.current = ensureKey;
      const seq = ensuringServerHitSeqRef.current + 1;
      ensuringServerHitSeqRef.current = seq;

      void Promise.resolve(ensureSearchHitVisible(hit)).finally(() => {
        if (ensuringServerHitSeqRef.current === seq) {
          ensuringServerHitKeyRef.current = null;
        }
      });
    },
    [ensureSearchHitVisible, ensureSearchRowsVisible, serverSearchSignature],
  );

  const focusServerHitByIndex = React.useCallback(
    (hitIndex: number, options?: { flash?: boolean }) => {
      const hits = serverSearchHits ?? [];
      const hit = hits[hitIndex];
      const totalCount = serverSearchTotalCount ?? hits.length;
      const loadedMatches = convertServerHitsToMatches(hits).matches;
      const loadedTargets = resolveCanvasSearchTargets(loadedMatches);
      const hitIndexPayload = hits.map(({ fieldId, recordId }) => ({
        fieldId,
        recordId,
      }));
      setCanvasSearchHitIndex(hitIndexPayload);

      if (!hit) {
        currentSearchMatchIndexRef.current = -1;
        currentSearchSignatureRef.current = serverSearchSignature;
        setCanvasSearchCursor((prev) => (prev === null ? prev : null));
        setCanvasSearchTargets((prev) =>
          areCanvasSearchTargetsEqual(prev, loadedTargets) ? prev : loadedTargets,
        );
        reportSearchState({
          matchCount: totalCount,
          currentMatchIndex: -1,
          currentField: null,
        });
        return;
      }

      const { match, currentField } = convertServerHitToMatch(hit);
      currentSearchMatchIndexRef.current = hitIndex;
      currentSearchSignatureRef.current = serverSearchSignature;

      if (!match) {
        pendingServerHitFocusRef.current = {
          hitIndex,
          recordId: String(hit.recordId),
          signature: serverSearchSignature,
        };
        setCanvasSearchCursor((prev) => (prev === null ? prev : null));
        setCanvasSearchTargets((prev) =>
          areCanvasSearchTargetsEqual(prev, loadedTargets) ? prev : loadedTargets,
        );
        reportSearchState({
          matchCount: totalCount,
          currentMatchIndex: hitIndex,
          currentField,
        });
        requestServerHitVisible(hit);
        return;
      }

      pendingServerHitFocusRef.current = null;

      const nextCursor = resolveCanvasSearchCursor(match);
      setCanvasSearchCursor((prev) =>
        areCanvasSearchCursorEqual(prev, nextCursor) ? prev : nextCursor,
      );
      setCanvasSearchTargets((prev) =>
        areCanvasSearchTargetsEqual(prev, loadedTargets) ? prev : loadedTargets,
      );
      focusSearchMatch(match, options);
      reportSearchState({
        matchCount: totalCount,
        currentMatchIndex: hitIndex,
        currentField,
      });
    },
    [
      convertServerHitToMatch,
      convertServerHitsToMatches,
      focusSearchMatch,
      reportSearchState,
      requestServerHitVisible,
      resolveCanvasSearchCursor,
      resolveCanvasSearchTargets,
      serverSearchHits,
      serverSearchSignature,
      serverSearchTotalCount,
    ],
  );

  // ─── Search Effect A: clear state when no query ───
  React.useEffect(() => {
    if (normalizedSearchQuery) return;
    currentSearchMatchIndexRef.current = -1;
    currentSearchSignatureRef.current = '';
    pendingServerNavigateRef.current = null;
    pendingServerHitFocusRef.current = null;
    setCanvasSearchCursor((prev) => (prev === null ? prev : null));
    setCanvasSearchTargets((prev) => (prev.length === 0 ? prev : []));
    setCanvasSearchHitIndex((prev) => (prev.length === 0 ? prev : []));
    reportSearchState({
      matchCount: 0,
      currentMatchIndex: -1,
      currentField: null,
    });
  }, [normalizedSearchQuery, reportSearchState]);

  // ─── Search Effect B: server search results ───
  React.useEffect(() => {
    if (!normalizedSearchQuery) return;
    if (!useServerSearch) return;
    if (serverSearchLoading) return;
    if (serverSearchHits === null || serverSearchHits.length === 0) {
      const totalCount = serverSearchTotalCount ?? 0;
      currentSearchMatchIndexRef.current = -1;
      currentSearchSignatureRef.current = serverSearchSignature;
      setCanvasSearchHitIndex((prev) => (prev.length === 0 ? prev : []));
      setCanvasSearchCursor((prev) => (prev === null ? prev : null));
      setCanvasSearchTargets((prev) => (prev.length === 0 ? prev : []));
      reportSearchState({
        matchCount: totalCount,
        currentMatchIndex: -1,
        currentField: null,
      });
      return;
    }

    ensureSearchRowsVisible(serverSearchHits.map((hit) => String(hit.recordId)));

    let nextIndex = currentSearchMatchIndexRef.current;
    const pendingNavigation = pendingServerNavigateRef.current;
    if (
      pendingNavigation?.signature === serverSearchSignature &&
      pendingNavigation.direction === 'next' &&
      serverSearchHits.length > pendingNavigation.fromIndex + 1
    ) {
      nextIndex = pendingNavigation.fromIndex + 1;
      pendingServerNavigateRef.current = null;
    }

    if (
      nextIndex < 0 ||
      nextIndex >= serverSearchHits.length ||
      currentSearchSignatureRef.current !== serverSearchSignature
    ) {
      nextIndex = 0;
    }

    focusServerHitByIndex(nextIndex, { flash: false });
  }, [
    focusServerHitByIndex,
    ensureSearchRowsVisible,
    normalizedSearchQuery,
    reportSearchState,
    serverSearchHits,
    serverSearchLoading,
    serverSearchTotalCount,
    serverSearchSignature,
    useServerSearch,
  ]);

  // ─── Search Effect B2: refocus server hit after rows load/expand ───
  React.useEffect(() => {
    const pending = pendingServerHitFocusRef.current;
    if (!pending || !useServerSearch || serverSearchLoading) return;
    if (pending.signature !== serverSearchSignature) return;
    if (!recordIdToRowIndexMap.has(normalizeEntityId(pending.recordId))) return;

    const hitIndex = pending.hitIndex;
    pendingServerHitFocusRef.current = null;
    requestAnimationFrame(() => {
      focusServerHitByIndex(hitIndex, { flash: true });
    });
  }, [
    focusServerHitByIndex,
    recordIdToRowIndexMap,
    serverSearchLoading,
    serverSearchSignature,
    useServerSearch,
  ]);

  // ─── Search Effect C: local search fallback ───
  React.useEffect(() => {
    if (!normalizedSearchQuery) return;
    if (useServerSearch) return;

    const { matches, currentField, limitReached } =
      collectSearchMatches(normalizedSearchQuery);
    ensureSearchRowsVisible(matches.map((match) => match.rowId));
    const nextSignature = `${normalizedSearchQuery}::${searchScope}::${searchSelectedFieldIds.join(',')}::${searchHideNotMatchRows ? 'hide' : 'all'}::${currentField ?? ''}`;

    setCanvasSearchHitIndex(resolveSearchHitIndex(matches));

    if (matches.length === 0) {
      currentSearchMatchIndexRef.current = -1;
      currentSearchSignatureRef.current = nextSignature;
      setCanvasSearchCursor((prev) => (prev === null ? prev : null));
      setCanvasSearchTargets((prev) => (prev.length === 0 ? prev : []));
      reportSearchState({
        matchCount: 0,
        currentMatchIndex: -1,
        currentField,
        searchLimitReached: limitReached,
      });
      return;
    }

    let nextIndex = currentSearchMatchIndexRef.current;
    if (
      nextIndex < 0 ||
      nextIndex >= matches.length ||
      currentSearchSignatureRef.current !== nextSignature
    ) {
      const focusedCell = gridApiRef.current?.getFocusedCell?.();
      const focusedMatchIndex = focusedCell
        ? matches.findIndex(
            (match) =>
              match.rowIndex === focusedCell.rowIndex &&
              match.field === focusedCell.field,
          )
        : -1;
      nextIndex = focusedMatchIndex >= 0 ? focusedMatchIndex : 0;
    }

    currentSearchMatchIndexRef.current = nextIndex;
    currentSearchSignatureRef.current = nextSignature;
    focusSearchMatch(matches[nextIndex], { flash: false });
    const nextCursor = resolveCanvasSearchCursor(matches[nextIndex] ?? null);
    const nextTargets = resolveCanvasSearchTargets(matches);
    setCanvasSearchCursor((prev) =>
      areCanvasSearchCursorEqual(prev, nextCursor) ? prev : nextCursor,
    );
    setCanvasSearchTargets((prev) =>
      areCanvasSearchTargetsEqual(prev, nextTargets) ? prev : nextTargets,
    );
    reportSearchState({
      matchCount: matches.length,
      currentMatchIndex: nextIndex,
      currentField,
      searchLimitReached: limitReached,
    });
  }, [
    collectSearchMatches,
    ensureSearchRowsVisible,
    focusSearchMatch,
    gridApiRef,
    normalizedSearchQuery,
    reportSearchState,
    resolveCanvasSearchCursor,
    resolveCanvasSearchTargets,
    resolveSearchHitIndex,
    searchHideNotMatchRows,
    searchSelectedFieldIds,
    searchScope,
    useServerSearch,
  ]);

  // ─── Navigate effect ───
  React.useEffect(() => {
    if (!searchNavigateRequest) return;

    const normalizedQuery = normalizedSearchQuery;
    if (!normalizedQuery) return;

    if (useServerSearch && !serverSearchLoading) {
      const hits = serverSearchHits ?? [];
      const totalCount = serverSearchTotalCount ?? hits.length;
      if (hits.length === 0) {
        setCanvasSearchCursor((prev) => (prev === null ? prev : null));
        setCanvasSearchTargets((prev) => (prev.length === 0 ? prev : []));
        reportSearchState({
          matchCount: totalCount,
          currentMatchIndex: -1,
          currentField: null,
        });
        return;
      }

      const currentIndex =
        currentSearchMatchIndexRef.current >= 0 &&
        currentSearchMatchIndexRef.current < hits.length
          ? currentSearchMatchIndexRef.current
          : 0;
      const delta = searchNavigateRequest.direction === 'next' ? 1 : -1;

      if (
        searchNavigateRequest.direction === 'next' &&
        currentIndex >= hits.length - 1 &&
        serverSearchHasMore
      ) {
        pendingServerNavigateRef.current = {
          fromIndex: currentIndex,
          direction: 'next',
          signature: serverSearchSignature,
        };
        serverSearchLoadNextPage();
        focusServerHitByIndex(currentIndex, { flash: true });
        return;
      }

      const nextIndex = (currentIndex + delta + hits.length) % hits.length;
      pendingServerNavigateRef.current = null;
      if (
        serverSearchHasMore &&
        nextIndex >= hits.length - SERVER_SEARCH_PREFETCH_THRESHOLD
      ) {
        serverSearchLoadNextPage();
      }

      focusServerHitByIndex(nextIndex, { flash: true });
      return;
    }

    const localResult = collectSearchMatches(normalizedQuery);
    const matches: SearchMatch[] = localResult.matches;
    const currentField: string | null = localResult.currentField;
    const limitReached = localResult.limitReached;

    const totalCount = matches.length;

    if (matches.length === 0) {
      setCanvasSearchCursor((prev) => (prev === null ? prev : null));
      setCanvasSearchTargets((prev) => (prev.length === 0 ? prev : []));
      reportSearchState({
        matchCount: totalCount,
        currentMatchIndex: -1,
        currentField,
        searchLimitReached: limitReached,
      });
      return;
    }

    const currentIndex =
      currentSearchMatchIndexRef.current >= 0
        ? currentSearchMatchIndexRef.current
        : 0;
    const delta = searchNavigateRequest.direction === 'next' ? 1 : -1;
    const nextIndex =
      (currentIndex + delta + matches.length) % matches.length;

    currentSearchMatchIndexRef.current = nextIndex;
    currentSearchSignatureRef.current = `${normalizedQuery}::${searchScope}::${searchSelectedFieldIds.join(',')}::${searchHideNotMatchRows ? 'hide' : 'all'}::${currentField ?? ''}`;
    const nextCursor = resolveCanvasSearchCursor(matches[nextIndex] ?? null);
    const nextTargets = resolveCanvasSearchTargets(matches);
    setCanvasSearchCursor((prev) =>
      areCanvasSearchCursorEqual(prev, nextCursor) ? prev : nextCursor,
    );
    setCanvasSearchTargets((prev) =>
      areCanvasSearchTargetsEqual(prev, nextTargets) ? prev : nextTargets,
    );
    focusSearchMatch(matches[nextIndex], { flash: true });
    reportSearchState({
      matchCount: totalCount,
      currentMatchIndex: nextIndex,
      currentField,
      searchLimitReached: limitReached,
    });
  }, [
    collectSearchMatches,
    focusSearchMatch,
    focusServerHitByIndex,
    normalizedSearchQuery,
    reportSearchState,
    resolveCanvasSearchCursor,
    resolveCanvasSearchTargets,
    searchNavigateRequest,
    searchHideNotMatchRows,
    searchSelectedFieldIds,
    searchScope,
    serverSearchHits,
    serverSearchHasMore,
    serverSearchLoadNextPage,
    serverSearchLoading,
    serverSearchTotalCount,
    serverSearchSignature,
    useServerSearch,
  ]);

  // ─── Search-filtered rows ───

  const matchedSearchRowIds = React.useMemo(() => {
    if (useServerSideHiddenRows) return null;
    if (!searchHideNotMatchRows || !normalizedSearchQuery) return null;

    const { activeSearchFields } = resolveSearchFieldContext();
    if (activeSearchFields.length === 0) return new Set<string>();

    const matchedRowIds = new Set<string>();
    searchableRows.forEach((row, index) => {
      const rowData = row as Record<string, unknown>;
      if (!isSearchableDataRow(rowData)) return;

      const rowId = resolveSearchRowId(rowData, index);
      const hasMatch = activeSearchFields.some((fieldName) =>
        matchesSearchCell(normalizedSearchQuery, fieldName, rowData[fieldName]),
      );
      if (hasMatch) {
        matchedRowIds.add(rowId);
      }
    });

    return matchedRowIds;
  }, [
    isSearchableDataRow,
    normalizedSearchQuery,
    matchesSearchCell,
    resolveSearchFieldContext,
    resolveSearchRowId,
    searchHideNotMatchRows,
    searchableRows,
    useServerSideHiddenRows,
  ]);

  const searchFilteredRowsForDisplay = React.useMemo(() => {
    if (useServerSideHiddenRows) return groupedRowsForDisplay;
    if (
      !searchHideNotMatchRows ||
      !normalizedSearchQuery ||
      !matchedSearchRowIds
    ) {
      return groupedRowsForDisplay;
    }

    type DisplayRow = GridDisplayRow;
    interface GroupFrame {
      path: string;
      header: DisplayRow;
      rows: DisplayRow[];
      hasVisibleMatch: boolean;
    }

    const filteredRows: DisplayRow[] = [];
    const groupFrames: GroupFrame[] = [];

    const flushTopGroup = () => {
      const frame = groupFrames.pop();
      if (!frame || !frame.hasVisibleMatch) return;

      const renderedGroupRows = [frame.header, ...frame.rows];
      const parent = groupFrames[groupFrames.length - 1];
      if (parent) {
        parent.rows.push(...renderedGroupRows);
        parent.hasVisibleMatch = true;
      } else {
        filteredRows.push(...renderedGroupRows);
      }
    };

    const flushGroupsToLevel = (level: number) => {
      while (groupFrames.length > level) {
        flushTopGroup();
      }
    };

    groupedRowsForDisplay.forEach((row, index) => {
      const rowData = row as Record<string, unknown>;
      const rowType = rowData.__rowType;

      if (rowType === 'group_header') {
        const rowLevel =
          typeof rowData.__groupLevel === 'number'
            ? rowData.__groupLevel
            : 0;
        flushGroupsToLevel(rowLevel);
        const groupPath =
          typeof rowData.__groupPath === 'string'
            ? rowData.__groupPath
            : `group_${rowLevel}_${index}`;
        groupFrames.push({
          path: groupPath,
          header: row,
          rows: [],
          hasVisibleMatch: false,
        });
        return;
      }

      if (rowType === 'group_add') {
        const currentGroup = groupFrames[groupFrames.length - 1];
        if (!currentGroup) return;
        const rowGroupPath =
          typeof rowData.__groupPath === 'string'
            ? rowData.__groupPath
            : undefined;
        if (
          currentGroup.hasVisibleMatch &&
          (!rowGroupPath || rowGroupPath === currentGroup.path)
        ) {
          currentGroup.rows.push(row);
        }
        return;
      }

      if (rowType === 'add') {
        const currentGroup = groupFrames[groupFrames.length - 1];
        if (!currentGroup) {
          filteredRows.push(row);
          return;
        }
        if (currentGroup.hasVisibleMatch) {
          currentGroup.rows.push(row);
        }
        return;
      }

      if (rowType === 'draft') {
        const currentGroup = groupFrames[groupFrames.length - 1];
        if (!currentGroup) {
          filteredRows.push(row);
          return;
        }
        currentGroup.rows.push(row);
        currentGroup.hasVisibleMatch = true;
        return;
      }

      if (!isSearchableDataRow(rowData)) {
        const currentGroup = groupFrames[groupFrames.length - 1];
        if (!currentGroup) {
          filteredRows.push(row);
          return;
        }
        if (currentGroup.hasVisibleMatch) {
          currentGroup.rows.push(row);
        }
        return;
      }

      const rowId = resolveSearchRowId(rowData, index);
      if (!matchedSearchRowIds.has(rowId)) return;

      const currentGroup = groupFrames[groupFrames.length - 1];
      if (!currentGroup) {
        filteredRows.push(row);
        return;
      }
      currentGroup.rows.push(row);
      currentGroup.hasVisibleMatch = true;
    });

    flushGroupsToLevel(0);
    return filteredRows;
  }, [
    groupedRowsForDisplay,
    isSearchableDataRow,
    matchedSearchRowIds,
    normalizedSearchQuery,
    resolveSearchRowId,
    searchHideNotMatchRows,
    useServerSideHiddenRows,
  ]);

  const searchMetricRowsForDisplay = React.useMemo(() => {
    if (!searchHideNotMatchRows || !normalizedSearchQuery) {
      return searchFilteredRowsForDisplay;
    }

    const visibleRecordIds = new Set<string>();
    searchFilteredRowsForDisplay.forEach((row) => {
      const recordId = resolveRowRecordId(row as Record<string, unknown>);
      if (recordId) visibleRecordIds.add(normalizeEntityId(recordId));
    });

    const rows = [...searchFilteredRowsForDisplay];
    const serverHitRecordIds =
      useServerSideHiddenRows && serverSearchHits
        ? new Set(serverSearchHits.map((hit) => normalizeEntityId(String(hit.recordId))))
        : null;

    searchableRows.forEach((row, index) => {
      const rowData = row as Record<string, unknown>;
      if (!isSearchableDataRow(rowData)) return;

      const rowId = resolveSearchRowId(rowData, index);
      const normalizedRowId = normalizeEntityId(rowId);
      const shouldInclude = serverHitRecordIds
        ? serverHitRecordIds.has(normalizedRowId)
        : matchedSearchRowIds?.has(rowId) === true;
      if (!shouldInclude || visibleRecordIds.has(normalizedRowId)) return;

      visibleRecordIds.add(normalizedRowId);
      rows.push(row);
    });

    return rows;
  }, [
    isSearchableDataRow,
    matchedSearchRowIds,
    normalizedSearchQuery,
    resolveSearchRowId,
    searchFilteredRowsForDisplay,
    searchHideNotMatchRows,
    searchableRows,
    serverSearchHits,
    useServerSideHiddenRows,
  ]);

  return {
    canvasSearchCursor,
    canvasSearchTargets,
    canvasSearchHitIndex,
    normalizedSearchQuery,
    matchedSearchRowIds,
    searchFilteredRowsForDisplay,
    searchMetricRowsForDisplay,
  };
}
