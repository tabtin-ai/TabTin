import type { TableGridRendererProps } from '@tabtin/table-engine';
import { resolveRecordId } from '@tabtin/table-engine';

export type GridDisplayRows = TableGridRendererProps['rows'];
export type GridDisplayRow = GridDisplayRows[number];

export const resolveFreezeColumnCountFromViewConfig = (
  viewConfig: Record<string, unknown> | null | undefined,
  columnCount: number,
): number | null => {
  const rawFreezeColumns = Number((viewConfig as any)?.freeze_columns);
  if (!Number.isFinite(rawFreezeColumns)) {
    return null;
  }

  return Math.max(0, Math.min(columnCount, Math.floor(rawFreezeColumns)));
};

export const resolveGridDisplayRowId = (row: GridDisplayRow): string | null => {
  return resolveRecordId(row);
};

export const isCanvasDraggableDataRow = (row: GridDisplayRow): boolean => {
  const rowType = (row as Record<string, unknown>).__rowType;
  return (
    rowType === undefined ||
    rowType === null ||
    rowType === '' ||
    rowType === 'draft'
  );
};

export const buildCanvasRowsSignature = (rows: GridDisplayRows): string => {
  let signature = String(rows.length);
  rows.forEach((row, index) => {
    const rowTypeRaw = (row as Record<string, unknown>).__rowType;
    const rowType =
      typeof rowTypeRaw === 'string' && rowTypeRaw.length > 0
        ? rowTypeRaw
        : 'data';
    const rowId = resolveGridDisplayRowId(row) ?? `row_${index}`;
    signature += `|${rowType}:${rowId}`;
  });
  return signature;
};
