import { useMemo, useRef } from 'react';
import type { IScrollState } from '../interface';
import type { CoordinateManager } from '../managers';

const DEFAULT_BUFFER_ROWS = 5;
const DEFAULT_BUFFER_COLS = 2;

export interface IVisibleRegion {
  startRowIndex: number;
  stopRowIndex: number;
  startColumnIndex: number;
  stopColumnIndex: number;
}

export const getVerticalRangeInfo = (
  coordInstance: CoordinateManager,
  scrollTop: number,
  bufferRows = 0
) => {
  const { rowCount } = coordInstance;
  const startIndex = coordInstance.getRowStartIndex(scrollTop);
  const stopIndex = coordInstance.getRowStopIndex(startIndex, scrollTop);

  return {
    startRowIndex: Math.max(0, startIndex - bufferRows),
    stopRowIndex: Math.max(0, Math.min(rowCount - 1, stopIndex + 1 + bufferRows)),
  };
};

export const getHorizontalRangeInfo = (
  coordInstance: CoordinateManager,
  scrollLeft: number,
  bufferCols = 0
) => {
  const { columnCount } = coordInstance;
  const startIndex = coordInstance.getColumnStartIndex(scrollLeft);
  const stopIndex = coordInstance.getColumnStopIndex(startIndex, scrollLeft);

  return {
    startColumnIndex: Math.max(0, startIndex - bufferCols),
    stopColumnIndex: Math.max(0, Math.min(columnCount - 1, stopIndex + bufferCols)),
  };
};

export const useVisibleRegion = (
  coordInstance: CoordinateManager,
  scrollState: IScrollState,
  forceRenderFlag: string | number,
  bufferRows: number = DEFAULT_BUFFER_ROWS,
  bufferCols: number = DEFAULT_BUFFER_COLS
) => {
  const { scrollTop, scrollLeft } = scrollState;
  const prevRef = useRef<IVisibleRegion | null>(null);

  return useMemo(() => {
    const { startRowIndex, stopRowIndex } = getVerticalRangeInfo(
      coordInstance,
      scrollTop,
      bufferRows
    );
    const { startColumnIndex, stopColumnIndex } = getHorizontalRangeInfo(
      coordInstance,
      scrollLeft,
      bufferCols
    );

    const prev = prevRef.current;
    if (
      prev != null &&
      prev.startRowIndex === startRowIndex &&
      prev.stopRowIndex === stopRowIndex &&
      prev.startColumnIndex === startColumnIndex &&
      prev.stopColumnIndex === stopColumnIndex
    ) {
      return prev;
    }

    const next: IVisibleRegion = {
      startRowIndex,
      stopRowIndex,
      startColumnIndex,
      stopColumnIndex,
    };
    prevRef.current = next;
    return next;
    // getVerticalRangeInfo/getHorizontalRangeInfo are module-level pure functions — stable by definition
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [coordInstance, scrollTop, scrollLeft, forceRenderFlag, bufferRows, bufferCols]);
};
