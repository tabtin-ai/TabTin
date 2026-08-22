import React from 'react';
import {
  buildTabDataRuntimeMetrics,
  publishTabDataRuntimeMetrics,
} from '../table-runtime-monitor';
import type { TableEngineObservabilitySnapshot } from '../controller/useTableEngineObservability';

interface UseTabDataRuntimeMetricsInput {
  runtimeTableId: string | null | undefined;
  selectedTable: { id?: string; name?: string; row_count?: number } | null;
  totalCount: number;
  rowsDataLength: number;
  groupedRowsLength: number;
  fieldsLength: number;
  orderedFieldsLength: number;
  resolvedCurrentView: { id?: string | null; name?: string | null; filters?: unknown; sorts?: unknown; groups?: unknown } | null;
  hasGrouping: boolean;
  hasSubRecordTreeRuntime: boolean;
  isPersonalViewEnabled: boolean;
  currentPage: number;
  currentPageSize: number;
  gridLoading: boolean;
  isRecordsLoading: boolean;
  isRecordLoading: boolean;
  selectedRowsLength: number;
  useViewData: boolean;
  collabStatus: string | null;
  collabConnectionStatus?: string | null;
  isCollabOnline: boolean;
  peerCount: number;
  isCollabFallback: boolean;
  tableEngineMetricsSnapshot: TableEngineObservabilitySnapshot | null | undefined;
}

export function useTabDataRuntimeMetrics({
  runtimeTableId,
  selectedTable,
  totalCount,
  rowsDataLength,
  groupedRowsLength,
  fieldsLength,
  orderedFieldsLength,
  resolvedCurrentView,
  hasGrouping,
  hasSubRecordTreeRuntime,
  isPersonalViewEnabled,
  currentPage,
  currentPageSize,
  gridLoading,
  isRecordsLoading,
  isRecordLoading,
  selectedRowsLength,
  useViewData,
  collabStatus,
  collabConnectionStatus = null,
  isCollabOnline,
  peerCount,
  isCollabFallback,
  tableEngineMetricsSnapshot,
}: UseTabDataRuntimeMetricsInput) {
  const tabDataRuntimeMetrics = React.useMemo(() => {
    if (!runtimeTableId || !selectedTable?.id) {
      return null;
    }

    return buildTabDataRuntimeMetrics({
      tableName: selectedTable.name,
      tableRowCount: selectedTable.row_count ?? totalCount,
      viewRowCount: totalCount,
      loadedRowCount: rowsDataLength,
      renderedRowCount: groupedRowsLength,
      fieldCount: fieldsLength,
      visibleFieldCount: orderedFieldsLength,
      currentViewId: resolvedCurrentView?.id ?? null,
      currentViewName:
        typeof resolvedCurrentView?.name === 'string'
          ? resolvedCurrentView.name
          : null,
      filters: resolvedCurrentView?.filters,
      sorts: resolvedCurrentView?.sorts,
      groups: resolvedCurrentView?.groups,
      hasGrouping,
      hasSubRecordTree: hasSubRecordTreeRuntime,
      isPersonalViewEnabled,
      currentPage,
      currentPageSize,
      gridLoading,
      isRecordsLoading,
      isRecordLoading,
      selectedRowCount: selectedRowsLength,
      useViewData,
      collabStatus,
      collabConnectionStatus,
      isCollabOnline,
      peerCount,
      isCollabFallback,
      engineSnapshot: tableEngineMetricsSnapshot,
    });
  }, [
    runtimeTableId,
    selectedTable?.id,
    selectedTable?.name,
    selectedTable?.row_count,
    totalCount,
    rowsDataLength,
    groupedRowsLength,
    fieldsLength,
    orderedFieldsLength,
    resolvedCurrentView?.id,
    resolvedCurrentView?.name,
    resolvedCurrentView?.filters,
    resolvedCurrentView?.sorts,
    resolvedCurrentView?.groups,
    hasGrouping,
    hasSubRecordTreeRuntime,
    isPersonalViewEnabled,
    currentPage,
    currentPageSize,
    gridLoading,
    isRecordsLoading,
    isRecordLoading,
    selectedRowsLength,
    useViewData,
    collabStatus,
    collabConnectionStatus,
    isCollabOnline,
    peerCount,
    isCollabFallback,
    tableEngineMetricsSnapshot,
  ]);

  React.useEffect(() => {
    publishTabDataRuntimeMetrics(runtimeTableId, tabDataRuntimeMetrics);
  }, [runtimeTableId, tabDataRuntimeMetrics]);
}
