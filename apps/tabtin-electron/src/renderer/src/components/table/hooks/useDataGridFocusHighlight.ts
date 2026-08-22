import type { MutableRefObject } from 'react';
import { useCallback, useEffect, useRef } from 'react';
import {
  resolveRecordId,
  type TableGridRow,
  type TableGridRuntimeApi,
} from '@tabtin/table-engine';
import type { Field, ViewFilter } from '@tabtin/table-core';
import { createLogger } from '@/utils/logger';

const log = createLogger('DataGridFocusHighlight');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface UseDataGridFocusHighlightParams {
  gridApiRef: MutableRefObject<TableGridRuntimeApi<TableGridRow> | null>;
  fieldById: Map<string, Field>;
  fieldByName: Map<string, Field>;
  columns: ReadonlyArray<{ field?: string }>;
  firstEditableField: string | null;

  /** 当前视图是否有有效数据 */
  useViewData: boolean;
  currentViewId: string | null;
  clearGroupCollapse: (viewId: string) => void;
  setDraftFilters: (viewId: string, filters: ViewFilter[]) => void;
  applyDraft: (viewId: string) => Promise<void>;

  registerHighlightCells: (
    handler: (recordId: string, fieldKeys: string[]) => void,
  ) => void;
  recordFocusIntent?: {
    requestId: string | number;
    recordId: string;
  } | null;
  /** 记录数据仍在加载或扩页时，聚焦可预览但不能消费深链意图。 */
  isRecordFocusDataLoading?: boolean;
  ensureRecordAvailable?: (recordId: string) => Promise<boolean>;
  ensureRecordFocusGroupsVisible?: (recordId: string) => void;
  onRecordFocusIntentConsumed?: (requestId: string | number) => void;
}

export interface UseDataGridFocusHighlightReturn {
  focusRecordRow: (
    recordId: string,
    options?: { flash?: boolean; select?: boolean; startEditing?: boolean },
  ) => boolean;
  focusRecordRowWithRetry: (
    recordId: string,
    options?: { flash?: boolean; select?: boolean; startEditing?: boolean },
  ) => void;
  resolveFieldIdFromHistoryKey: (fieldKey: string) => string | null;
  resolveColumnFieldFromHistoryKey: (fieldKey: string) => string | null;
  highlightCellsImpl: (recordId: string, fieldKeys: string[]) => void;
  handleRecordCreatedVisible: (record: { id?: string }) => Promise<void>;
  handleRecordCreatedVisibleForEditing: (record: { id?: string }) => Promise<void>;
  handleRevealHiddenRecord: (record: { id?: string }) => Promise<void>;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useDataGridFocusHighlight({
  gridApiRef,
  fieldById,
  fieldByName,
  columns,
  firstEditableField,
  useViewData,
  currentViewId,
  clearGroupCollapse,
  setDraftFilters,
  applyDraft,
  registerHighlightCells,
  recordFocusIntent,
  isRecordFocusDataLoading = false,
  ensureRecordAvailable,
  ensureRecordFocusGroupsVisible,
  onRecordFocusIntentConsumed,
}: UseDataGridFocusHighlightParams): UseDataGridFocusHighlightReturn {
  // ── focus helpers ──

  const focusRecordRow = useCallback(
    (
      recordId: string,
      options?: { flash?: boolean; select?: boolean; startEditing?: boolean },
    ) => {
      const api = gridApiRef.current;
      if (!api) {
        return false;
      }

      const firstVisibleField = columns.find(
        (column) => typeof column.field === 'string' && column.field.length > 0,
      )?.field;
      const focusField = firstEditableField ?? firstVisibleField;
      if (!focusField) {
        return false;
      }

      const displayedCount = api.getDisplayedRowCount?.() ?? 0;

      for (let index = 0; index < displayedCount; index += 1) {
        const rowNode = api.getDisplayedRowAtIndex?.(index);
        const rowData = rowNode?.data as Record<string, unknown> | undefined;
        if (!rowData) {
          continue;
        }

        if (resolveRecordId(rowData) !== recordId) {
          continue;
        }

        log.debug('定位记录最终展示位置', {
          recordId,
          displayRowIndex: index,
          startEditing: Boolean(options?.startEditing),
        });
        const targetRowNode = api.getDisplayedRowAtIndex?.(index);
        if (options?.select !== false && targetRowNode?.setSelected) {
          targetRowNode.setSelected(true, true);
        }
        api.setFocusedCell?.(index, focusField);
        if (options?.startEditing && firstEditableField) {
          api.startEditingCell?.({
            rowIndex: index,
            colKey: firstEditableField,
          });
        }
        // setFocusedCell/startEditingCell may perform their own visibility
        // adjustment. Center the row last so the final viewport position is
        // stable instead of leaving the focused cell at the bottom edge.
        api.ensureIndexVisible?.(index, 'middle');
        if (options?.flash !== false && typeof api.flashCells === 'function') {
          api.flashCells({
            rowNodes: targetRowNode ? [targetRowNode] : undefined,
            flashDelay: 300,
            fadeDelay: 900,
          });
        }
        return true;
      }
      return false;
    },
    [columns, firstEditableField, gridApiRef],
  );

  const focusRecordRowWithRetry = useCallback(
    (
      recordId: string,
      options?: { flash?: boolean; select?: boolean; startEditing?: boolean },
    ) => {
      const maxAttempts = 8;
      let attempts = 0;

      const tryFocus = () => {
        attempts += 1;
        const found = focusRecordRow(recordId, {
          flash: true,
          select: true,
          ...options,
        });
        if (found || attempts >= maxAttempts) {
          return;
        }
        setTimeout(tryFocus, 120);
      };

      tryFocus();
    },
    [focusRecordRow],
  );

  const handledRecordFocusRequestRef = useRef<string | number | null>(null);
  useEffect(() => {
    if (!recordFocusIntent?.recordId) return;
    if (handledRecordFocusRequestRef.current === recordFocusIntent.requestId) return;

    // 目标可能尚未进入首批行模型。只在未命中时扩页并重试；一旦成功立即
    // 消费意图，避免用户随后点击其他单元格时被定时器反复抢回焦点。
    const maxAttempts = 25;
    let attempts = 0;
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    const tryFocus = async () => {
      if (cancelled) return;
      attempts += 1;
      ensureRecordFocusGroupsVisible?.(recordFocusIntent.recordId);

      if (isRecordFocusDataLoading) {
        if (attempts >= maxAttempts) return;
        try {
          await ensureRecordAvailable?.(recordFocusIntent.recordId);
        } catch {
          // Keep the focus intent pending while the initial dataset settles.
        }
        if (cancelled) return;
        retryTimer = setTimeout(() => void tryFocus(), 160);
        return;
      }

      const focused = focusRecordRow(recordFocusIntent.recordId, {
        flash: true,
        select: true,
      });
      if (focused) {
        // 首批/旧行模型上的命中不是最终成功。完整数据到达后网格会重建并
        // 清掉程序化选区；保留意图，等加载结束的 effect 再聚焦并消费。
        handledRecordFocusRequestRef.current = recordFocusIntent.requestId;
        onRecordFocusIntentConsumed?.(recordFocusIntent.requestId);
        return;
      }
      if (attempts >= maxAttempts) {
        return;
      }

      try {
        await ensureRecordAvailable?.(recordFocusIntent.recordId);
      } catch {
        // 网络扩页失败时保留定位意图，后续数据/网络状态变化后仍可重试。
      }
      if (cancelled) return;
      retryTimer = setTimeout(() => void tryFocus(), 160);
    };

    retryTimer = setTimeout(() => void tryFocus(), 0);
    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, [
    ensureRecordAvailable,
    ensureRecordFocusGroupsVisible,
    focusRecordRow,
    isRecordFocusDataLoading,
    onRecordFocusIntentConsumed,
    recordFocusIntent?.recordId,
    recordFocusIntent?.requestId,
  ]);

  // ── field key resolution ──

  const resolveFieldIdFromHistoryKey = useCallback(
    (fieldKey: string): string | null => {
      if (!fieldKey) {
        return null;
      }
      if (fieldById.has(fieldKey)) {
        return fieldKey;
      }
      return fieldByName.get(fieldKey)?.id ?? null;
    },
    [fieldById, fieldByName],
  );

  const resolveColumnFieldFromHistoryKey = useCallback(
    (fieldKey: string): string | null => {
      if (!fieldKey) {
        return null;
      }
      if (fieldById.has(fieldKey)) {
        return fieldById.get(fieldKey)?.name ?? null;
      }
      if (fieldByName.has(fieldKey)) {
        return fieldKey;
      }
      return null;
    },
    [fieldById, fieldByName],
  );

  // ── highlight cells ──

  const highlightCellsImpl = useCallback(
    (recordId: string, fieldKeys: string[]) => {
      const api = gridApiRef.current;
      if (!api) {
        return;
      }

      const displayedCount = api.getDisplayedRowCount?.() ?? 0;
      let targetRowIndex = -1;

      for (let index = 0; index < displayedCount; index += 1) {
        const rowNode = api.getDisplayedRowAtIndex?.(index);
        const rowData = rowNode?.data as Record<string, unknown> | undefined;
        if (!rowData) {
          continue;
        }

        if (resolveRecordId(rowData) === recordId) {
          targetRowIndex = index;
          break;
        }
      }

      if (targetRowIndex < 0) {
        return;
      }

      const visibleFieldSet = new Set(
        columns
          .map((column) => column.field)
          .filter(
            (field): field is string =>
              typeof field === 'string' && field.length > 0,
          ),
      );
      const normalizedFocusField =
        fieldKeys
          .map((key) => resolveColumnFieldFromHistoryKey(key))
          .find(
            (fieldName): fieldName is string =>
              typeof fieldName === 'string' &&
              fieldName.length > 0 &&
              visibleFieldSet.has(fieldName),
          ) ?? firstEditableField;

      requestAnimationFrame(() => {
        if (normalizedFocusField) {
          api.setFocusedCell?.(targetRowIndex, normalizedFocusField);
        }
        // Keep the centering call after focus, which can otherwise move the
        // row back to the nearest edge of the viewport.
        api.ensureIndexVisible?.(targetRowIndex, 'middle');
      });
    },
    [columns, firstEditableField, gridApiRef, resolveColumnFieldFromHistoryKey],
  );

  // ── register highlight handler ──

  useEffect(() => {
    registerHighlightCells(highlightCellsImpl);
  }, [registerHighlightCells, highlightCellsImpl]);

  // ── record created / reveal handlers ──

  const handleRecordCreatedVisible = useCallback(
    async (record: { id?: string }) => {
      const recordId = record?.id;
      if (!recordId) {
        return;
      }
      setTimeout(() => {
        focusRecordRowWithRetry(recordId);
      }, 0);
    },
    [focusRecordRowWithRetry],
  );

  const handleRecordCreatedVisibleForEditing = useCallback(
    async (record: { id?: string }) => {
      const recordId = record?.id;
      if (!recordId) {
        return;
      }
      setTimeout(() => {
        focusRecordRowWithRetry(recordId, {
          startEditing: true,
        });
      }, 0);
    },
    [focusRecordRowWithRetry],
  );

  const handleRevealHiddenRecord = useCallback(
    async (record: { id?: string }) => {
      if (!useViewData || !currentViewId) {
        return;
      }

      clearGroupCollapse(currentViewId);
      setDraftFilters(currentViewId, []);
      await applyDraft(currentViewId);

      const recordId = record?.id;
      if (recordId) {
        setTimeout(() => {
          focusRecordRowWithRetry(recordId);
        }, 0);
      }
    },
    [
      applyDraft,
      clearGroupCollapse,
      currentViewId,
      focusRecordRowWithRetry,
      setDraftFilters,
      useViewData,
    ],
  );

  return {
    focusRecordRow,
    focusRecordRowWithRetry,
    resolveFieldIdFromHistoryKey,
    resolveColumnFieldFromHistoryKey,
    highlightCellsImpl,
    handleRecordCreatedVisible,
    handleRecordCreatedVisibleForEditing,
    handleRevealHiddenRecord,
  };
}
