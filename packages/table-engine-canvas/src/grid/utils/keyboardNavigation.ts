import { GRID_CONTAINER_ATTR } from '../configs';

export type ArrowDirection = 'up' | 'down' | 'left' | 'right';

export interface CellNavigationPosition {
  columnIndex: number;
  rowIndex: number;
}

/**
 * 从键盘事件解析方向。
 *
 * 注意：react-hotkeys-hook 的 isHotkeyPressed('down') 不可靠——
 * 按下 ArrowDown 时内部 pressed set 存的是 'arrowdown'，别名 'down' 匹配不上，
 * 会导致「热键触发了但坐标不变」。优先用 event.key / 已解析的 hotkey keys。
 */
export const resolveArrowDirectionFromEvent = (
  keyboardEvent: Pick<KeyboardEvent, 'key'>,
  hotkeysEvent?: { keys?: readonly string[] }
): ArrowDirection | null => {
  const keys = (hotkeysEvent?.keys ?? []).map((k) => k.toLowerCase());
  if (keys.includes('up') || keys.includes('arrowup') || keyboardEvent.key === 'ArrowUp') {
    return 'up';
  }
  if (keys.includes('down') || keys.includes('arrowdown') || keyboardEvent.key === 'ArrowDown') {
    return 'down';
  }
  if (keys.includes('left') || keys.includes('arrowleft') || keyboardEvent.key === 'ArrowLeft') {
    return 'left';
  }
  if (keys.includes('right') || keys.includes('arrowright') || keyboardEvent.key === 'ArrowRight') {
    return 'right';
  }
  return null;
};

/**
 * 焦点守卫：判断按键事件是否发生在「本」grid 容器之外。
 *
 * 表格快捷键挂在 document 上；选中未编辑时焦点在容器/隐藏 input 上，
 * 编辑中焦点在编辑器上——二者都位于 [data-t-grid-container] 子树内。
 * 侧边栏输入框或多 grid 场景下，必须丢弃容器外的按键，避免串扰。
 */
export const isEventOutsideContainer = (
  event: KeyboardEvent,
  container: HTMLElement | null
): boolean => {
  const target = event.target as Node | null;
  if (container) {
    return !target || !container.contains(target);
  }
  const element = target as Element | null;
  return !(
    element &&
    typeof element.closest === 'function' &&
    element.closest(`[${GRID_CONTAINER_ATTR}]`)
  );
};

/**
 * 非编辑态方向键 / Cmd+方向键：计算下一个激活单元格坐标。
 * 坐标为 [columnIndex, realRowIndex]，与 selection / activeCell 一致。
 */
export const resolveCellNavigationMove = (params: {
  columnIndex: number;
  rowIndex: number;
  direction: ArrowDirection;
  columnCount: number;
  pureRowCount: number;
  isMod?: boolean;
}): CellNavigationPosition => {
  const { direction, columnCount, pureRowCount, isMod = false } = params;
  let { columnIndex, rowIndex } = params;

  if (columnCount <= 0 || pureRowCount <= 0) {
    return { columnIndex, rowIndex };
  }

  if (isMod) {
    switch (direction) {
      case 'up':
        rowIndex = 0;
        break;
      case 'down':
        rowIndex = pureRowCount - 1;
        break;
      case 'left':
        columnIndex = 0;
        break;
      case 'right':
        columnIndex = columnCount - 1;
        break;
    }
  } else {
    switch (direction) {
      case 'up':
        rowIndex = Math.max(rowIndex - 1, 0);
        break;
      case 'down':
        rowIndex = Math.min(rowIndex + 1, pureRowCount - 1);
        break;
      case 'left':
        columnIndex = Math.max(columnIndex - 1, 0);
        break;
      case 'right':
        columnIndex = Math.min(columnIndex + 1, columnCount - 1);
        break;
    }
  }

  return { columnIndex, rowIndex };
};

/**
 * PageUp / PageDown：按可视行数迁移激活行（对齐飞书多维表 / Excel）。
 */
export const resolvePageNavigationRow = (params: {
  rowIndex: number;
  direction: 'up' | 'down';
  pureRowCount: number;
  pageRowDelta: number;
}): number => {
  const { rowIndex, direction, pureRowCount, pageRowDelta } = params;
  if (pureRowCount <= 0) return rowIndex;
  const delta = Math.max(1, pageRowDelta);
  const next =
    direction === 'up' ? rowIndex - delta : rowIndex + delta;
  return Math.max(0, Math.min(pureRowCount - 1, next));
};

/** 估算一页可滚动的数据行数（不含表头）。 */
export const estimatePageRowDelta = (params: {
  containerHeight: number;
  rowInitSize: number;
  rowHeight: number;
}): number => {
  const { containerHeight, rowInitSize, rowHeight } = params;
  const bodyHeight = Math.max(0, containerHeight - rowInitSize);
  const visible = rowHeight > 0 ? Math.floor(bodyHeight / rowHeight) : 1;
  return Math.max(1, visible - 1);
};

export interface ScrollToItemInput {
  columnIndex: number;
  /** 已转换为 linear row index（含分组头）后的行索引 */
  rowIndex: number;
  scrollLeft: number;
  scrollTop: number;
  containerWidth: number;
  containerHeight: number;
  freezeRegionWidth: number;
  freezeColumnCount: number;
  rowInitSize: number;
  columnOffset: number;
  columnWidth: number;
  rowOffset: number;
  rowHeight: number;
  cellScrollBuffer: number;
}

export interface ScrollToItemResult {
  scrollLeft?: number;
  scrollTop?: number;
}

/**
 * 计算让目标单元格进入视口所需的 scrollLeft / scrollTop。
 * 仅当单元格越界时才返回对应轴的新偏移；冻结列不做水平滚动。
 */
export const computeScrollToItem = (input: ScrollToItemInput): ScrollToItemResult => {
  const {
    columnIndex,
    scrollLeft,
    scrollTop,
    containerWidth,
    containerHeight,
    freezeRegionWidth,
    freezeColumnCount,
    rowInitSize,
    columnOffset,
    columnWidth,
    rowOffset,
    rowHeight,
    cellScrollBuffer,
  } = input;

  const result: ScrollToItemResult = {};
  const isFreezeColumn = columnIndex < freezeColumnCount;

  if (!isFreezeColumn) {
    const deltaLeft = Math.min(columnOffset - scrollLeft - freezeRegionWidth, 0);
    const deltaRight = Math.max(columnOffset + columnWidth - scrollLeft - containerWidth, 0);
    const sl = scrollLeft + deltaLeft + deltaRight;
    if (sl !== scrollLeft) {
      const scrollBuffer =
        deltaLeft < 0 ? -cellScrollBuffer : deltaRight > 0 ? cellScrollBuffer : 0;
      result.scrollLeft = sl + scrollBuffer;
    }
  }

  const deltaTop = Math.min(rowOffset - scrollTop - rowInitSize, 0);
  const deltaBottom = Math.max(rowOffset + rowHeight - scrollTop - containerHeight, 0);
  const st = scrollTop + deltaTop + deltaBottom;
  if (st !== scrollTop) {
    result.scrollTop = st;
  }

  return result;
};
