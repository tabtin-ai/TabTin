import React from 'react';
import type { TableRecord, ViewMeta, ViewRecordsResponse } from '@tabtin/table-core';
import {
  buildLocalCreateOverlayScopeKey,
  buildLocalCreateOverlayEntries,
  canApplyLocalCreateOverlay,
  canDisplayLocalCreateOverlayScope,
  type LocalCreateOverlayEntry,
  type LocalCreateOverlayOrderContext,
  type LocalCreateOverlayScopeInput,
  type LocalCreateOverlayTreePatch,
  mergeViewRecordsWithLocalCreateOverlays,
  patchLocalCreateOverlayEntryRecord,
  reconcileLocalCreateOverlayEntries,
  upsertLocalCreateOverlayEntries,
} from '../utils/viewLocalCreateOverlay';

interface UseLocalCreateOverlayInput {
  selectedTableId: string | undefined;
  currentViewId: string | null | undefined;
  currentViewRecords: ViewRecordsResponse | null;
  resolvedCurrentView: ViewMeta | null;
  useViewData: boolean;
  searchQuery: string;
  searchHideNotMatchRows: boolean;
  useServerSearch: boolean;
}

export function useLocalCreateOverlay({
  selectedTableId,
  currentViewId,
  currentViewRecords,
  resolvedCurrentView,
  useViewData,
  searchQuery,
  searchHideNotMatchRows,
  useServerSearch,
}: UseLocalCreateOverlayInput) {
  const [overlaysByScopeKey, setOverlaysByScopeKey] =
    React.useState<Record<string, LocalCreateOverlayEntry[]>>({});
  const normalizedCurrentViewId: string | null = currentViewId ?? null;
  const previousScopeKeyRef = React.useRef<string | null>(null);

  const scopeKey = React.useMemo<string | null>(
    () => buildLocalCreateOverlayScopeKey({ currentViewId: normalizedCurrentViewId, currentViewRecords }),
    [normalizedCurrentViewId, currentViewRecords],
  );

  // Leaving a page/view scope drops that scope's overlays so retained end
  // projections cannot reappear as ghosts when navigating back (the real
  // record lives on a later page after a full-page create).
  React.useEffect(() => {
    const previousScopeKey = previousScopeKeyRef.current;
    previousScopeKeyRef.current = scopeKey;
    if (!previousScopeKey || previousScopeKey === scopeKey) {
      return;
    }
    setOverlaysByScopeKey((prev) => {
      if (!(previousScopeKey in prev)) {
        return prev;
      }
      const next = { ...prev };
      delete next[previousScopeKey];
      return next;
    });
  }, [scopeKey]);

  const currentOverlays = React.useMemo<LocalCreateOverlayEntry[]>(
    () => (scopeKey ? overlaysByScopeKey[scopeKey] ?? [] : []),
    [scopeKey, overlaysByScopeKey],
  );

  const scopeInput = React.useMemo<LocalCreateOverlayScopeInput>(
    () => ({
      useViewData,
      currentViewId: normalizedCurrentViewId,
      currentView: resolvedCurrentView,
      currentViewRecords,
      searchQuery,
      searchHideNotMatchRows,
      useServerSearch,
      overlayEntries: currentOverlays,
    }),
    [
      useViewData,
      normalizedCurrentViewId,
      resolvedCurrentView,
      currentViewRecords,
      searchQuery,
      searchHideNotMatchRows,
      useServerSearch,
      currentOverlays,
    ],
  );

  const canDisplay = React.useMemo(
    () => canDisplayLocalCreateOverlayScope(scopeInput),
    [scopeInput],
  );

  const currentViewRecordsForDisplay = React.useMemo<ViewRecordsResponse | null>(
    () =>
      canDisplay
        ? mergeViewRecordsWithLocalCreateOverlays(currentViewRecords, currentOverlays)
        : currentViewRecords,
    [canDisplay, currentViewRecords, currentOverlays],
  );

  React.useEffect(() => {
    setOverlaysByScopeKey({});
  }, [selectedTableId]);

  React.useEffect(() => {
    if (!scopeKey || currentOverlays.length === 0) return;

    const nextOverlays = reconcileLocalCreateOverlayEntries(
      currentOverlays,
      currentViewRecords?.records ?? [],
    );
    if (nextOverlays.length === currentOverlays.length) return;

    setOverlaysByScopeKey((prev) => {
      const current = prev[scopeKey] ?? [];
      if (current.length === nextOverlays.length) return prev;
      if (nextOverlays.length === 0) {
        const next = { ...prev };
        delete next[scopeKey];
        return next;
      }
      return { ...prev, [scopeKey]: nextOverlays };
    });
  }, [currentOverlays, currentViewRecords, scopeKey]);

  const applyLocalCreateOverlay = React.useCallback(
    (
      createdRecords: TableRecord[],
      orderContext?: LocalCreateOverlayOrderContext | null,
      options?: { subRecordTreePatch?: LocalCreateOverlayTreePatch },
    ): TableRecord[] => {
      if (
        !scopeKey ||
        createdRecords.length === 0 ||
        !canApplyLocalCreateOverlay(scopeInput, orderContext)
      ) {
        return createdRecords;
      }

      const overlayRecords = createdRecords.map((record) => ({
        ...record,
        __viewOverlayEligible: true,
      })) as TableRecord[];
      const nextEntries = buildLocalCreateOverlayEntries(
        overlayRecords,
        orderContext,
        options,
      );
      if (nextEntries.length === 0) return createdRecords;

      setOverlaysByScopeKey((prev) => {
        const current = prev[scopeKey] ?? [];
        const next = nextEntries.reduce(
          (entries, entry) => upsertLocalCreateOverlayEntries(entries, entry),
          current,
        );
        return { ...prev, [scopeKey]: next };
      });

      return overlayRecords;
    },
    [scopeInput, scopeKey],
  );

  const patchLocalCreateOverlayRecord = React.useCallback(
    (recordId: string | number, updatedRecord: TableRecord) => {
      if (!scopeKey) return

      setOverlaysByScopeKey((prev) => {
        const current = prev[scopeKey] ?? []
        if (!current.some((entry) => String(entry.record.id) === String(recordId))) {
          return prev
        }

        const next = current.map((entry) =>
          patchLocalCreateOverlayEntryRecord(entry, recordId, updatedRecord),
        )

        return {
          ...prev,
          [scopeKey]: next,
        }
      })
    },
    [scopeKey],
  )

  const removeOverlayRecords = React.useCallback(
    (recordIds: (string | number)[]) => {
      if (!scopeKey || recordIds.length === 0) return
      const idsToRemove = new Set(recordIds.map(String))
      setOverlaysByScopeKey((prev) => {
        const current = prev[scopeKey] ?? []
        const next = current.filter(entry => !idsToRemove.has(String(entry.record.id)))
        if (next.length === current.length) return prev
        if (next.length === 0) {
          const result = { ...prev }
          delete result[scopeKey]
          return result
        }
        return { ...prev, [scopeKey]: next }
      })
    },
    [scopeKey],
  )

  return {
    currentViewRecordsForDisplay,
    applyLocalCreateOverlay,
    patchLocalCreateOverlayRecord,
    removeOverlayRecords,
    localCreateOverlayScopeKey: scopeKey,
  };
}
