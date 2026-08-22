import React from 'react';
import { formatNumber } from '@/utils/i18n/format';
import type { GridDisplayRows } from '../utils/gridDisplayUtils';

const ROW_COUNTER_COMPACT_THRESHOLD = 999;

interface UseRowCounterDisplayInput {
  searchFilteredRowsForDisplay: GridDisplayRows;
  searchHideNotMatchRows: boolean;
  totalCount: number;
  normalizedSearchQueryLength: number;
  translateWithOptions: (key: string, options?: Record<string, unknown>) => string;
}

export function useRowCounterDisplay({
  searchFilteredRowsForDisplay,
  searchHideNotMatchRows,
  totalCount,
  normalizedSearchQueryLength,
  translateWithOptions,
}: UseRowCounterDisplayInput) {
  const canvasVisibleDataRowCount = React.useMemo(() => {
    const countDataRows = (rows: GridDisplayRows): number =>
      rows.reduce((count, row) => {
        const rowData = row as Record<string, unknown>;
        const rowType = rowData.__rowType;
        return !rowType || rowType === 'draft' ? count + 1 : count;
      }, 0);

    if (searchHideNotMatchRows && normalizedSearchQueryLength > 0) {
      return countDataRows(searchFilteredRowsForDisplay);
    }

    if (Number.isFinite(totalCount) && totalCount >= 0) {
      return Math.floor(totalCount);
    }

    return countDataRows(searchFilteredRowsForDisplay);
  }, [
    normalizedSearchQueryLength,
    searchFilteredRowsForDisplay,
    searchHideNotMatchRows,
    totalCount,
  ]);

  const rowCounterLabel = React.useMemo(() => {
    if (canvasVisibleDataRowCount > ROW_COUNTER_COMPACT_THRESHOLD) {
      return `${ROW_COUNTER_COMPACT_THRESHOLD}+`;
    }
    const formattedCount = formatNumber(canvasVisibleDataRowCount);
    return formattedCount;
  }, [canvasVisibleDataRowCount]);

  const rowCounterTooltipLabel = React.useMemo(() => {
    if (canvasVisibleDataRowCount <= ROW_COUNTER_COMPACT_THRESHOLD) {
      return null;
    }
    const formattedCount = formatNumber(canvasVisibleDataRowCount);
    return translateWithOptions('table:toolbar.rows', {
      count: formattedCount,
    });
  }, [canvasVisibleDataRowCount, translateWithOptions]);

  const rowCounterAriaLabel = React.useMemo(() => {
    const formattedCount = formatNumber(canvasVisibleDataRowCount);
    return translateWithOptions('table:toolbar.totalRows', {
      count: formattedCount,
    });
  }, [canvasVisibleDataRowCount, translateWithOptions]);

  const canvasStatisticSummaryLabel = React.useMemo(
    () => translateWithOptions('table:statistics.summaryLabel'),
    [translateWithOptions],
  );

  return {
    canvasVisibleDataRowCount,
    rowCounterLabel,
    rowCounterTooltipLabel,
    rowCounterAriaLabel,
    canvasStatisticSummaryLabel,
  };
}
