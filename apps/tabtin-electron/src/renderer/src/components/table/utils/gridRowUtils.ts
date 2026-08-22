import { resolveRecordId, type TableGridRow } from '@tabtin/table-engine';
import {
  resolveGridDisplayRowId,
  isCanvasDraggableDataRow,
  type GridDisplayRows,
  type GridDisplayRow,
} from './gridDisplayUtils';

export interface CanvasReorderPersistenceContext {
  movedRowIds: string[];
  anchorRowId?: string;
  anchorRowData?: Record<string, unknown>;
  position: 'before' | 'after' | 'end';
}

/** Max sub-record depth (4 levels below root). */
export const MAX_SUB_RECORD_DEPTH = 4;

export interface CanvasTreeMoveContext {
  recordId: string;
  newParentId: string | null;
  /** True when the move would exceed the max sub-record depth limit. */
  depthExceeded?: boolean;
}

export type CanvasRowDropMode = 'before' | 'after' | 'inside';

export interface CanvasRowDropContext {
  dropMode?: CanvasRowDropMode;
  targetRowId?: string;
}

export type TreeDataNodeMeta = {
  parent_id?: string | null;
};

const resolveTreeDepth = (row: GridDisplayRow): number | null => {
  const depth = (row as Record<string, unknown>).__treeDepth;
  return typeof depth === 'number' && Number.isFinite(depth) ? depth : null;
};

const resolveTreeParentId = (row: GridDisplayRow): string | null => {
  const parentId = (row as Record<string, unknown>).__treeParentId;
  return typeof parentId === 'string' && parentId.length > 0 ? parentId : null;
};

export const reorderCanvasRowsByDragSnapshot = (
  rows: GridDisplayRows,
  draggedRowIds: string[],
  dropRowIndex: number,
): GridDisplayRows => {
  if (rows.length === 0 || draggedRowIds.length === 0) {
    return rows;
  }

  const normalizedDraggedIds = Array.from(
    new Set(
      draggedRowIds.filter(
        (id): id is string => typeof id === 'string' && id.trim().length > 0,
      ),
    ),
  );
  if (normalizedDraggedIds.length === 0) {
    return rows;
  }

  const dataRowSlots: number[] = [];
  const dataRows: GridDisplayRow[] = [];
  const dataRowIds: string[] = [];

  rows.forEach((row, index) => {
    if (!isCanvasDraggableDataRow(row)) {
      return;
    }
    const rowId = resolveGridDisplayRowId(row);
    if (!rowId) {
      return;
    }
    dataRowSlots.push(index);
    dataRows.push(row);
    dataRowIds.push(rowId);
  });

  if (dataRows.length === 0) {
    return rows;
  }

  const draggedIdSet = new Set(normalizedDraggedIds);
  const draggedIndexes: number[] = [];
  dataRowIds.forEach((rowId, index) => {
    if (draggedIdSet.has(rowId)) {
      draggedIndexes.push(index);
    }
  });

  if (draggedIndexes.length === 0) {
    return rows;
  }

  const clampedDropIndex = Math.max(
    0,
    Math.min(Math.floor(dropRowIndex), dataRows.length),
  );
  const draggedIndexSet = new Set(draggedIndexes);
  const movingRows = dataRows.filter((_row, index) =>
    draggedIndexSet.has(index),
  );
  const remainingRows = dataRows.filter(
    (_row, index) => !draggedIndexSet.has(index),
  );
  const removedBeforeDrop = draggedIndexes.reduce(
    (count, index) => (index < clampedDropIndex ? count + 1 : count),
    0,
  );
  const insertIndex = Math.max(
    0,
    Math.min(clampedDropIndex - removedBeforeDrop, remainingRows.length),
  );

  const reorderedDataRows = [
    ...remainingRows.slice(0, insertIndex),
    ...movingRows,
    ...remainingRows.slice(insertIndex),
  ];

  const isOrderUnchanged = reorderedDataRows.every(
    (row, index) => row === dataRows[index],
  );
  if (isOrderUnchanged) {
    return rows;
  }

  const nextRows = [...rows];
  dataRowSlots.forEach((slotIndex, dataIndex) => {
    nextRows[slotIndex] = reorderedDataRows[dataIndex];
  });

  return nextRows;
};

export const resolveCanvasReorderPersistenceContext = (
  rows: GridDisplayRows,
  draggedRowIds: string[],
  dropRowIndex: number,
): CanvasReorderPersistenceContext | null => {
  if (rows.length === 0 || draggedRowIds.length === 0) {
    return null;
  }

  const normalizedDraggedIds = Array.from(
    new Set(
      draggedRowIds.filter(
        (id): id is string => typeof id === 'string' && id.trim().length > 0,
      ),
    ),
  );
  if (normalizedDraggedIds.length === 0) {
    return null;
  }

  const draggableRows: Array<{
    rowId: string;
    rowData: Record<string, unknown>;
    sourceIndex: number;
  }> = [];
  rows.forEach((row, index) => {
    if (!isCanvasDraggableDataRow(row)) {
      return;
    }
    const rowId = resolveGridDisplayRowId(row);
    if (!rowId) {
      return;
    }
    draggableRows.push({
      rowId,
      rowData: row as Record<string, unknown>,
      sourceIndex: index,
    });
  });

  if (draggableRows.length === 0) {
    return null;
  }

  const draggedIdSet = new Set(normalizedDraggedIds);
  const movingRows = draggableRows.filter((item) =>
    draggedIdSet.has(item.rowId),
  );
  if (movingRows.length === 0) {
    return null;
  }

  const movingSourceIndexes = new Set(
    movingRows.map((item) => item.sourceIndex),
  );
  const remainingRows = draggableRows.filter(
    (item) => !movingSourceIndexes.has(item.sourceIndex),
  );
  const removedBeforeDrop = draggableRows.reduce((count, item, index) => {
    if (!draggedIdSet.has(item.rowId)) {
      return count;
    }
    return index < dropRowIndex ? count + 1 : count;
  }, 0);
  const clampedDropIndex = Math.max(
    0,
    Math.min(Math.floor(dropRowIndex), draggableRows.length),
  );
  const insertIndex = Math.max(
    0,
    Math.min(clampedDropIndex - removedBeforeDrop, remainingRows.length),
  );

  if (remainingRows.length === 0) {
    return {
      movedRowIds: movingRows.map((item) => item.rowId),
      position: 'end',
    };
  }

  if (insertIndex <= 0) {
    const anchor = remainingRows[0];
    if (!anchor) {
      return {
        movedRowIds: movingRows.map((item) => item.rowId),
        position: 'end',
      };
    }
    return {
      movedRowIds: movingRows.map((item) => item.rowId),
      anchorRowId: anchor.rowId,
      anchorRowData: anchor.rowData,
      position: 'before',
    };
  }

  const previousAnchor =
    remainingRows[Math.min(insertIndex - 1, remainingRows.length - 1)];
  if (!previousAnchor) {
    return {
      movedRowIds: movingRows.map((item) => item.rowId),
      position: 'end',
    };
  }
  return {
    movedRowIds: movingRows.map((item) => item.rowId),
    anchorRowId: previousAnchor.rowId,
    anchorRowData: previousAnchor.rowData,
    position: 'after',
  };
};

export { resolveTreeDepth, resolveTreeParentId };

export const resolveCanvasTreeMoveContext = (
  originalRows: GridDisplayRows,
  reorderedRows: GridDisplayRows,
  draggedRowIds: string[],
  dropContext?: CanvasRowDropContext,
): CanvasTreeMoveContext | null => {
  if (originalRows.length === 0 || reorderedRows.length === 0) {
    return null;
  }

  const normalizedDraggedIds = Array.from(
    new Set(
      draggedRowIds.filter(
        (id): id is string => typeof id === 'string' && id.trim().length > 0,
      ),
    ),
  );
  if (normalizedDraggedIds.length === 0) {
    return null;
  }

  const draggedIdSet = new Set(normalizedDraggedIds);
  const originalRowById = new Map<string, GridDisplayRow>();
  const reorderedDataRowIds: string[] = [];

  originalRows.forEach((row) => {
    if (!isCanvasDraggableDataRow(row)) {
      return;
    }
    const rowId = resolveGridDisplayRowId(row);
    if (!rowId) {
      return;
    }
    originalRowById.set(rowId, row);
  });

  reorderedRows.forEach((row) => {
    if (!isCanvasDraggableDataRow(row)) {
      return;
    }
    const rowId = resolveGridDisplayRowId(row);
    if (!rowId) {
      return;
    }
    reorderedDataRowIds.push(rowId);
  });

  if (originalRowById.size === 0 || reorderedDataRowIds.length === 0) {
    return null;
  }

  const rootCandidates = normalizedDraggedIds.filter((rowId) => {
    const row = originalRowById.get(rowId);
    if (!row) {
      return false;
    }
    const parentId = resolveTreeParentId(row);
    return !parentId || !draggedIdSet.has(parentId);
  });

  // 仅支持单根拖拽推导层级，避免多根拖拽误判父关系。
  if (rootCandidates.length !== 1) {
    return null;
  }

  const recordId = rootCandidates[0];
  if (!recordId) {
    return null;
  }
  const movedRootRow = originalRowById.get(recordId);
  if (!movedRootRow) {
    return null;
  }

  const oldParentId = resolveTreeParentId(movedRootRow);
  const originalDepth = resolveTreeDepth(movedRootRow);
  if (originalDepth === null) {
    return null;
  }

  const newIndex = reorderedDataRowIds.indexOf(recordId);
  if (newIndex < 0) {
    return null;
  }

  let newParentId: string | null = null;
  if (dropContext?.targetRowId) {
    const targetRow = originalRowById.get(dropContext.targetRowId);
    if (
      targetRow &&
      !draggedIdSet.has(dropContext.targetRowId) &&
      dropContext.dropMode === 'inside'
    ) {
      newParentId = dropContext.targetRowId;
    } else if (
      targetRow &&
      !draggedIdSet.has(dropContext.targetRowId) &&
      (dropContext.dropMode === 'before' || dropContext.dropMode === 'after')
    ) {
      newParentId = resolveTreeParentId(targetRow);
    }
  } else if (originalDepth > 0) {
    const expectedParentDepth = originalDepth - 1;
    for (let index = newIndex - 1; index >= 0; index -= 1) {
      const candidateId = reorderedDataRowIds[index];
      if (!candidateId || draggedIdSet.has(candidateId)) {
        continue;
      }
      const candidateRow = originalRowById.get(candidateId);
      if (!candidateRow) {
        continue;
      }
      const candidateDepth = resolveTreeDepth(candidateRow);
      if (candidateDepth === null) {
        continue;
      }
      if (candidateDepth === expectedParentDepth) {
        newParentId = candidateId;
        break;
      }
      if (candidateDepth < expectedParentDepth) {
        break;
      }
    }
  } else {
    // 根节点下沉：若插入位置位于某父节点的子链内部，则继承该父记录。
    const prevId = newIndex > 0 ? reorderedDataRowIds[newIndex - 1] : null;
    const nextId =
      newIndex + 1 < reorderedDataRowIds.length
        ? reorderedDataRowIds[newIndex + 1]
        : null;
    const prevRow = prevId && !draggedIdSet.has(prevId)
      ? originalRowById.get(prevId)
      : null;
    const nextRow = nextId && !draggedIdSet.has(nextId)
      ? originalRowById.get(nextId)
      : null;
    const prevParentId = prevRow ? resolveTreeParentId(prevRow) : null;
    const nextParentId = nextRow ? resolveTreeParentId(nextRow) : null;

    if (nextParentId) {
      newParentId = nextParentId;
    } else if (prevParentId) {
      newParentId = prevParentId;
    }

    if (prevId && nextId && !draggedIdSet.has(prevId) && !draggedIdSet.has(nextId)) {
      if (nextRow && resolveTreeParentId(nextRow) === prevId) {
        newParentId = prevId;
      }
    }
  }

  if (newParentId === oldParentId) {
    return null;
  }

  // ── Depth validation ──
  const movedRootDepth = originalDepth;

  let subtreeMaxRelativeDepth = 0;
  for (const dId of normalizedDraggedIds) {
    const dRow = originalRowById.get(dId);
    if (!dRow) continue;
    const dDepth = resolveTreeDepth(dRow);
    if (dDepth !== null) {
      subtreeMaxRelativeDepth = Math.max(subtreeMaxRelativeDepth, dDepth - movedRootDepth);
    }
  }

  let targetDepth: number;
  if (newParentId) {
    const parentRow = originalRowById.get(newParentId);
    const parentDepth = parentRow ? (resolveTreeDepth(parentRow) ?? 0) : 0;
    targetDepth = parentDepth + 1;
  } else {
    targetDepth = 0;
  }

  const depthExceeded =
    targetDepth + subtreeMaxRelativeDepth > MAX_SUB_RECORD_DEPTH;

  return {
    recordId,
    newParentId,
    depthExceeded,
  };
};

export const expandMovedRowIdsWithDescendants = (
  movedRowIds: string[],
  orderedRows: TableGridRow[],
  treeData: Record<string, TreeDataNodeMeta>,
): string[] => {
  if (movedRowIds.length === 0) {
    return movedRowIds;
  }

  const normalizedMovedIds = Array.from(
    new Set(
      movedRowIds.filter(
        (id): id is string => typeof id === 'string' && id.trim().length > 0,
      ),
    ),
  );
  if (normalizedMovedIds.length === 0) {
    return normalizedMovedIds;
  }

  const childrenByParent = new Map<string, string[]>();
  Object.entries(treeData).forEach(([recordId, meta]) => {
    if (!recordId) {
      return;
    }
    const parentId =
      typeof meta?.parent_id === 'string' && meta.parent_id.length > 0
        ? meta.parent_id
        : null;
    if (!parentId) {
      return;
    }
    const children = childrenByParent.get(parentId) ?? [];
    children.push(recordId);
    childrenByParent.set(parentId, children);
  });

  const expandedSet = new Set(normalizedMovedIds);
  const queue = [...normalizedMovedIds];
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) {
      continue;
    }
    const children = childrenByParent.get(current) ?? [];
    children.forEach((childId) => {
      if (expandedSet.has(childId)) {
        return;
      }
      expandedSet.add(childId);
      queue.push(childId);
    });
  }

  if (expandedSet.size === normalizedMovedIds.length) {
    return normalizedMovedIds;
  }

  const orderedIds = orderedRows
    .map((row) => resolveRecordId(row))
    .filter((id): id is string => typeof id === 'string' && id.length > 0);
  const orderedExpanded = orderedIds.filter((id) => expandedSet.has(id));
  if (orderedExpanded.length > 0) {
    return orderedExpanded;
  }

  return Array.from(expandedSet);
};
