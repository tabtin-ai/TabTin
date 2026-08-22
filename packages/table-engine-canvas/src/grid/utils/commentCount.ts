type CellBounds = {
  x: number;
  y: number;
  width: number;
  height: number;
};

type CommentCell = { id?: string };
type CommentColumn = { id?: string; name: string };

export const COMMENT_COUNT_WIDTH = 18;
export const COMMENT_COUNT_HEIGHT = 16;
export const COMMENT_COUNT_RIGHT_PADDING = 6;
export const ROW_DETAIL_BUTTON_SIZE = 16;
export const ROW_ACTION_GAP = 4;

export function getCommentCountBounds(cellBounds: CellBounds): CellBounds {
  return {
    x:
      cellBounds.x +
      cellBounds.width -
      COMMENT_COUNT_WIDTH -
      COMMENT_COUNT_RIGHT_PADDING,
    y: cellBounds.y + (cellBounds.height - COMMENT_COUNT_HEIGHT) / 2,
    width: COMMENT_COUNT_WIDTH,
    height: COMMENT_COUNT_HEIGHT,
  };
}

export function getRowDetailButtonBounds(
  cellBounds: CellBounds,
  hasCommentCount: boolean,
): CellBounds {
  const commentBounds = getCommentCountBounds(cellBounds);
  return {
    x: hasCommentCount
      ? commentBounds.x - ROW_ACTION_GAP - ROW_DETAIL_BUTTON_SIZE
      : cellBounds.x + cellBounds.width - ROW_DETAIL_BUTTON_SIZE - 4,
    y: cellBounds.y + (cellBounds.height - ROW_DETAIL_BUTTON_SIZE) / 2,
    width: ROW_DETAIL_BUTTON_SIZE,
    height: ROW_DETAIL_BUTTON_SIZE,
  };
}

export function resolveCellCommentCount(
  cell: CommentCell,
  column: CommentColumn,
  commentCountMap?: Record<string, number>,
): { recordId: string; count: number } | null {
  if (!cell.id || !commentCountMap) return null;

  const suffixes = [column.id, column.name]
    .filter((value): value is string => Boolean(value))
    .map((value) => `-${value}`);
  const suffix = suffixes.find((candidate) => cell.id!.endsWith(candidate));
  const recordId = suffix
    ? cell.id.slice(0, -suffix.length)
    : Object.keys(commentCountMap).find(
        (id) => cell.id === id || cell.id!.startsWith(`${id}-`),
      );
  if (!recordId) return null;

  const count = commentCountMap[recordId] ?? 0;
  return count > 0 ? { recordId, count } : null;
}
