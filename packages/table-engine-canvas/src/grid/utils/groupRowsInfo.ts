import type { IGroupPoint, ILinearRow } from '../interface';
import { LinearRowType } from '../interface';
import type { IIndicesMap } from '../managers';

export interface GroupRowsInfo {
  linearRows: ILinearRow[];
  real2LinearRowMap: Record<number, number>;
  pureRowCount: number;
  rowCount: number;
  rowHeightMap: IIndicesMap;
}

interface BuildGroupRowsInfoOptions {
  groupPoints?: IGroupPoint[] | null;
  hasAppendRow: boolean;
  appendRowHeight: number;
  groupHeaderHeight: number;
}

export function buildGroupRowsInfo({
  groupPoints,
  hasAppendRow,
  appendRowHeight,
  groupHeaderHeight,
}: BuildGroupRowsInfoOptions): GroupRowsInfo | null {
  if (!groupPoints?.length) return null;

  let rowIndex = 0;
  let totalIndex = 0;
  let currentValue: unknown = null;
  let collapsedDepth = Number.MAX_VALUE;
  const linearRows: ILinearRow[] = [];
  const rowHeightMap: IIndicesMap = {};
  const real2LinearRowMap: Record<number, number> = {};

  const pushAppendRow = (appendPoint?: IGroupPoint) => {
    if (!hasAppendRow) return;

    const appendMeta = appendPoint?.type === LinearRowType.Append ? appendPoint : undefined;
    rowHeightMap[totalIndex] = appendRowHeight;
    linearRows.push({
      type: LinearRowType.Append,
      value: currentValue,
      realIndex: rowIndex > 0 ? rowIndex - 1 : -1,
      groupPath: appendMeta?.groupPath,
      groupValues: appendMeta?.groupValues,
    });
    totalIndex++;
  };

  groupPoints.forEach((point, pointIndex) => {
    const { type } = point;

    if (type === LinearRowType.Group) {
      const { id, value, depth, isCollapsed, count, loadedCount, countLabel } = point;
      const isSubGroup = depth > collapsedDepth;

      if (isCollapsed) {
        collapsedDepth = Math.min(collapsedDepth, depth);
        if (isSubGroup) return;
      } else if (!isSubGroup) {
        collapsedDepth = Number.MAX_VALUE;
      } else {
        return;
      }

      rowHeightMap[totalIndex] = groupHeaderHeight;
      linearRows.push({
        id,
        type: LinearRowType.Group,
        depth,
        value,
        realIndex: rowIndex,
        isCollapsed: Boolean(isCollapsed),
        count,
        loadedCount,
        countLabel,
      });
      currentValue = value;
      totalIndex++;
      return;
    }

    if (type === LinearRowType.Row) {
      const count = point.count;

      if (collapsedDepth !== Number.MAX_VALUE) {
        // Hidden records still occupy dataRows indexes. Advance the real index so
        // the next visible sibling points at the correct underlying record.
        rowIndex += count;
        return;
      }

      for (let i = 0; i < count; i++) {
        real2LinearRowMap[rowIndex + i] = totalIndex + i;
        linearRows.push({
          type: LinearRowType.Row,
          displayIndex: i + 1,
          realIndex: rowIndex + i,
        });
      }

      rowIndex += count;
      totalIndex += count;

      const nextPoint = groupPoints[pointIndex + 1];
      pushAppendRow(nextPoint);
      return;
    }

    if (collapsedDepth !== Number.MAX_VALUE) {
      return;
    }

    const previousPoint = groupPoints[pointIndex - 1];
    if (previousPoint?.type === LinearRowType.Group && previousPoint.isCollapsed) {
      return;
    }
    if (previousPoint?.type === LinearRowType.Row) {
      return;
    }

    pushAppendRow(point);
  });

  return {
    linearRows,
    real2LinearRowMap,
    pureRowCount: rowIndex,
    rowCount: totalIndex,
    rowHeightMap,
  };
}
