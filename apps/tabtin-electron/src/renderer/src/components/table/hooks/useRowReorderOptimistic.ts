import React from 'react';
import { buildCanvasRowsSignature, type GridDisplayRows } from '../utils/gridDisplayUtils';

interface UseRowReorderOptimisticInput {
  searchFilteredRowsForDisplay: GridDisplayRows;
  currentViewId: string | null | undefined;
  selectedTableId: string | undefined;
}

export function useRowReorderOptimistic({
  searchFilteredRowsForDisplay,
  currentViewId,
  selectedTableId,
}: UseRowReorderOptimisticInput) {
  const [canvasOptimisticRows, setCanvasOptimisticRows] =
    React.useState<GridDisplayRows | null>(null);
  const reorderInFlightRef = React.useRef(false);

  const sourceCanvasRowsSignature = React.useMemo(
    () => buildCanvasRowsSignature(searchFilteredRowsForDisplay),
    [searchFilteredRowsForDisplay],
  );

  React.useEffect(() => {
    reorderInFlightRef.current = false;
    setCanvasOptimisticRows(null);
  }, [currentViewId, selectedTableId]);

  React.useEffect(() => {
    if (!reorderInFlightRef.current) {
      setCanvasOptimisticRows(null);
    }
  }, [sourceCanvasRowsSignature]);

  return {
    canvasOptimisticRows,
    setCanvasOptimisticRows,
    reorderInFlightRef,
  };
}
