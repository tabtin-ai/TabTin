/* eslint-disable jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions */
import { isEqual } from 'lodash';
import type { Dispatch, ForwardRefRenderFunction, RefObject, SetStateAction } from 'react';
import { useState, useRef, useEffect, useCallback, forwardRef, useImperativeHandle, useMemo, useLayoutEffect } from 'react';
import { useClickAway, useMouse } from 'react-use';
import type { CellScrollerRef } from './CellScroller';
import { CellScroller } from './CellScroller';
import type { IEditorContainerRef } from './components';
import { EditorContainer } from './components';
import type { IGridTheme } from './configs';

import {
  GRID_DEFAULT,
  DEFAULT_MOUSE_STATE,
  DEFAULT_DRAG_STATE,
  DEFAULT_COLUMN_RESIZE_STATE,
} from './configs';
import type { IGridProps } from './Grid';
import {
  useSelection,
  useAutoScroll,
  useColumnResize,
  useColumnFreeze,
  useEventListener,
} from './hooks';
import { getRowDropTarget, useDrag } from './hooks/useDrag';
import { useVisibleRegion } from './hooks/useVisibleRegion';
import { isGridOverlayTarget } from './utils/isGridOverlayTarget';
import type {
  IActiveCellBound,
  ICellItem,
  ICellPosition,
  ICellRegionWithData,
  IInnerCell,
  ILinearRow,
  IMouseState,
  IRectangle,
  IRowControlItem,
  IScrollState,
  IRange,
} from './interface';
import {
  RegionType,
  LinearRowType,
  DragRegionType,
  MouseButtonType,
  SelectionRegionType,
  DraggableType,
  SelectableType,
} from './interface';
import type { CoordinateManager, ImageManager, SpriteManager, CombinedSelection } from './managers';
import { CellRegionType, CellType, getCellRenderer } from './renderers';
import type { ILinkCell } from './renderers';
import { RenderLayer } from './RenderLayer';
import type { IRegionData } from './utils';
import { BLANK_REGION_DATA, flatRanges, getRegionData, inRange, isAppendColumnPointerHit } from './utils';
import { TREE_INDENT_PER_LEVEL } from './renderers/layout-renderer/layoutRenderer';

const { columnAppendBtnWidth, columnHeadHeight, columnResizeHandlerWidth } = GRID_DEFAULT;
type EditingStopReason = 'api' | 'interaction' | 'editor';
const APPEND_ROW_GESTURE_GUARD_MS = 500;
const COLUMN_RESIZE_CURSOR = 'col-resize';

const getRegionTitle = (type: RegionType): string | undefined => {
  switch (type) {
    case RegionType.AllCheckbox:
      return '全选 / 取消全选';
    default:
      return undefined;
  }
};

export interface IInteractionLayerProps
  extends Omit<
    IGridProps,
    | 'freezeColumnCount'
    | 'rowCount'
    | 'rowHeight'
    | 'style'
    | 'smoothScrollX'
    | 'smoothScrollY'
    | 'onVisibleRegionChanged'
  > {
  theme: IGridTheme;
  width: number;
  height: number;
  /** 本 grid 根容器（[data-t-grid-container]）的 ref，用于把 document 级键盘热键精确限定在本实例内 */
  gridContainerRef: RefObject<HTMLDivElement | null>;
  forceRenderFlag: string | number;
  rowControls: IRowControlItem[];
  mouseState: IMouseState;
  scrollState: IScrollState;
  imageManager: ImageManager;
  spriteManager: SpriteManager;
  coordInstance: CoordinateManager;
  activeCell: ICellItem | null;
  activeCellBound: IActiveCellBound | null;
  real2RowIndex: (index: number) => number;
  getLinearRow: (index: number) => ILinearRow;
  setActiveCell: Dispatch<SetStateAction<ICellItem | null>>;
  setMouseState: Dispatch<SetStateAction<IMouseState>>;
  scrollBy: (deltaX: number, deltaY: number) => void;
  scrollToItem: (position: [columnIndex: number, rowIndex: number]) => void;
  onFillSelection?: (selectionRanges: [IRange, IRange], targetEndRealRowIndex: number) => void;
  onEditingStopped?: (event: {
    cell: ICellItem | null;
    cellId: string | null;
    reason: EditingStopReason;
  }) => void;
}

export interface IInteractionLayerRef {
  isEditing: () => boolean;
  resetState: () => void;
  setSelection: (selection: CombinedSelection) => void;
  startEditingCell: (cell: ICellItem) => void;
  stopEditing: () => void;
  cancelEditing: () => void;
  getEditingCells: () => ICellItem[];
}

export const InteractionLayerBase: ForwardRefRenderFunction<
  IInteractionLayerRef,
  IInteractionLayerProps
> = (props, ref) => {
  const {
    theme,
    width,
    height,
    gridContainerRef,
    columns,
    commentCountMap,
    draggable,
    selectable,
    rowControls,
    mouseState,
    scrollState,
    imageManager,
    spriteManager,
    coordInstance,
    columnStatistics,
    forceRenderFlag,
    rowIndexVisible,
    groupCollection,
    isMultiSelectionEnable,
    activeCellBound: _activeCellBound,
    columnHeaderHeight,
    collapsedGroupIds,
    collaborators,
    searchCursor,
    searchHitIndex,
    editorShiftEnterHint,
    editorSelectSearchPlaceholder,
    editorSelectSearchPlaceholderEmpty,
    editorSelectNoResults,
    editorSelectEmptyHint,
    editorSelectAddOption,
    editorSelectDoneLabel,
    prefillingRowIndexes,
    activeCell,
    getLinearRow,
    real2RowIndex,
    setActiveCell,
    setMouseState,
    scrollToItem,
    scrollBy,
    getCellContent,
    getRowTreeData,
    onUndo,
    onRedo,
    onCopy,
    onPaste,
    onDelete,
    onRowAppend,
    onRowExpand,
    onCommentCountClick,
    onTreeToggle,
    onInsertSubRecord,
    onRowOrdered,
    onCellEdited,
    onCellDblClick,
    onSelectionChanged,
    onColumnFreeze,
    onColumnAppend,
    onColumnResize,
    onColumnOrdered,
    onContextMenu,
    onGroupHeaderContextMenu,
    onItemHovered,
    onItemClick,
    onColumnHeaderClick,
    onColumnHeaderDblClick,
    onColumnHeaderMenuClick,
    onColumnStatisticClick,
    onCollapsedGroupChanged,
    onFillSelection,
    onEditingStopped,
    onDragStart: _onDragStart,
  } = props;

  useImperativeHandle(ref, () => ({
    isEditing: () => isEditing,
    resetState,
    setSelection: (selection: CombinedSelection) => {
      const { type, ranges } = selection;

      switch (type) {
        case SelectionRegionType.Cells: {
          const activeCell = ranges[0];
          setActiveCell(activeCell);
          scrollToItem(activeCell);
          break;
        }
        case SelectionRegionType.Columns: {
          const activeCell = [ranges[0][0], 0] as ICellItem;
          setActiveCell(activeCell);
          scrollToItem(activeCell);
          break;
        }
        default: {
          setActiveCell(null);
          break;
        }
      }
      setSelection(selection);
    },
    startEditingCell: (cell: ICellItem) => {
      const [columnIndex, rowIndex] = cell;
      const nextRange = [columnIndex, rowIndex] as IRange;
      editingCellRef.current = cell;
      const cellContent = getCellContent(cell) as IInnerCell;
      editingCellIdRef.current = typeof cellContent.id === 'string' ? cellContent.id : null;
      setActiveCell(cell);
      setSelection(selection.set(SelectionRegionType.Cells, [nextRange, nextRange] as IRange[]));
      scrollToItem(cell);
      setEditing(true);
    },
    stopEditing: () => {
      stopEditingWithReason('api');
    },
    cancelEditing: () => {
      cancelEditingWithReason('api');
    },
    getEditingCells: () => {
      if (!isEditing || !activeCell) {
        return [];
      }
      return [activeCell];
    },
  }));

  const stageRef = useRef<HTMLDivElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const editorContainerRef = useRef<IEditorContainerRef>(null);
  const cellScrollerRef = useRef<CellScrollerRef | null>(null);
  const prevActiveCellRef = useRef<ICellItem | null>(null);
  const hoveredRegionRef = useRef<IRegionData>(BLANK_REGION_DATA);
  const previousHoveredRegionRef = useRef<IRegionData>(BLANK_REGION_DATA);
  const isFillingRef = useRef(false);
  // 记录上一次 mouseup 是否结束了一次真实拖拽（列/行重排）。拖拽 mouseup 后浏览器会
  // 紧接着派发一个 synthetic click，若不拦截会触发列头点击 → 自动弹出列菜单（事件冲突）。
  const draggedBeforeClickRef = useRef(false);
  const fillSelectionRef = useRef<CombinedSelection | null>(null);
  const editingCellRef = useRef<ICellItem | null>(null);
  const editingCellIdRef = useRef<string | null>(null);
  const editingStopReasonRef = useRef<EditingStopReason | null>(null);
  const prevIsEditingRef = useRef(false);
  const columnResizeGestureRef = useRef(false);
  const appendRowGestureGuardRef = useRef<{
    until: number;
    top: number;
    bottom: number;
  } | null>(null);

  const mousePosition = useMouse(stageRef as React.RefObject<HTMLDivElement>);
  const [cellScrollTop, setCellScrollTop] = useState(0);
  const [hoverCellPosition, setHoverCellPosition] = useState<ICellPosition | null>(null);
  const [cursor, setCursor] = useState('default');
  const [isEditing, setEditingState] = useState(false);

  const setEditing = useCallback((nextValue: SetStateAction<boolean>) => {
    setEditingState((prev) => {
      const resolved =
        typeof nextValue === 'function'
          ? (nextValue as (prevState: boolean) => boolean)(prev)
          : nextValue;

      if (!prev && resolved) {
        editingStopReasonRef.current = null;
        if (activeCell) {
          editingCellRef.current = activeCell;
          const cellContent = getCellContent(activeCell) as IInnerCell;
          editingCellIdRef.current = typeof cellContent.id === 'string' ? cellContent.id : null;
        }
      }

      if (prev && !resolved && editingStopReasonRef.current == null) {
        editingStopReasonRef.current = 'editor';
      }

      return resolved;
    });
  }, [activeCell, getCellContent]);

  const stopEditingWithReason = useCallback((reason: EditingStopReason) => {
    editingStopReasonRef.current = reason;
    setEditing(false);
    editorContainerRef.current?.saveValue?.();
  }, [setEditing]);

  const cancelEditingWithReason = useCallback((reason: EditingStopReason) => {
    editingStopReasonRef.current = reason;
    setEditing(false);
  }, [setEditing]);

  useLayoutEffect(() => {
    if (activeCell || !isEditing) return;
    cancelEditingWithReason('api');
  }, [activeCell, isEditing, cancelEditingWithReason]);

  useEffect(() => {
    if (isEditing && activeCell) {
      editingCellRef.current = activeCell;
    }
  }, [activeCell, isEditing]);

  // The preview scroller is unmounted during editing. Reset its position so the
  // canvas preview and its scrollbar remount from the same state afterwards.
  useEffect(() => {
    if (isEditing) {
      setCellScrollTop(0);
    }
  }, [isEditing]);

  useEffect(() => {
    if (prevIsEditingRef.current && !isEditing) {
      const stoppedCell = editingCellRef.current;
      const stoppedCellId = editingCellIdRef.current;
      const stopReason = editingStopReasonRef.current ?? 'editor';
      editingCellRef.current = null;
      editingCellIdRef.current = null;
      editingStopReasonRef.current = null;
      queueMicrotask(() => {
        onEditingStopped?.({
          cell: stoppedCell,
          cellId: stoppedCellId,
          reason: stopReason,
        });
      });
    }
    prevIsEditingRef.current = isEditing;
  }, [isEditing, onEditingStopped]);

  const { containerHeight, freezeColumnCount } = coordInstance;
  const { scrollTop, scrollLeft, isScrolling } = scrollState;
  const { type: regionType } = mouseState;
  const isRowAppendEnable = onRowAppend != null;
  const isColumnFreezable = onColumnFreeze != null;
  const isColumnResizable = onColumnResize != null;
  const isColumnAppendEnable = onColumnAppend != null;
  const isColumnHeaderMenuVisible = onColumnHeaderMenuClick != null;

  const visibleRegion = useVisibleRegion(coordInstance, scrollState, forceRenderFlag);
  const {
    columnResizeState,
    hoveredColumnResizeIndex,
    setHoveredColumnResizeIndex,
    setColumnResizeState,
    onColumnResizeStart,
    onColumnResizeChange,
    onColumnResizeEnd,
  } = useColumnResize(coordInstance, scrollState);
  const {
    selection,
    isSelecting,
    setSelection,
    onSelectionStart,
    onSelectionChange,
    onSelectionEnd,
    onSelectionClick,
    onSelectionContextMenu,
  } = useSelection({
    selectable,
    coordInstance,
    isMultiSelectionEnable,
    getLinearRow,
    setActiveCell,
    onSelectionChanged,
  });
  const { dragState, setDragState, onDragStart, onDragChange, onDragEnd } = useDrag(
    coordInstance,
    scrollState,
    selection,
    draggable
  );
  const { columnFreezeState, onColumnFreezeStart, onColumnFreezeMove, onColumnFreezeEnd } =
    useColumnFreeze(coordInstance, scrollState);

  const { isDragging, type: dragType } = dragState;
  const { isFreezing } = columnFreezeState;
  const isResizing = columnResizeState.columnIndex > -1;
  const { isCellSelection, ranges: selectionRanges } = selection;
  // isFilling 用 ref 避免每帧 setState；mousedown 里会先 setMouseState 触发重渲染，
  // 此处读 ref 才能把 fill 拖拽期间的 mouse 监听挂到 window（否则拖出 stage 会丢 mouseup）。
  const isFilling = isFillingRef.current;
  const isInteracting = isSelecting || isDragging || isResizing || isFreezing || isFilling;
  const [activeColumnIndex, activeRowIndex] = activeCell ?? [];

  useEffect(() => {
    if (!isResizing || typeof document === 'undefined') return;

    const root = document.documentElement;
    const body = document.body;
    const previousRootCursor = root.style.cursor;
    const previousBodyCursor = body?.style.cursor;

    root.style.cursor = COLUMN_RESIZE_CURSOR;
    if (body) {
      body.style.cursor = COLUMN_RESIZE_CURSOR;
    }

    return () => {
      root.style.cursor = previousRootCursor;
      if (body) {
        body.style.cursor = previousBodyCursor ?? '';
      }
    };
  }, [isResizing]);

  const getPosition = (override?: { x: number; y: number }) => {
    const x = override?.x ?? mousePosition.elX;
    const y = override?.y ?? mousePosition.elY;
    const { freezeRegionWidth, totalWidth, rowInitSize, columnInitSize, columnCount } =
      coordInstance;
    const rowIndex =
      y < 0 ? -Infinity : y <= rowInitSize ? -1 : coordInstance.getRowStartIndex(scrollTop + y);
    const columnIndex =
      x < 0
        ? -Infinity
        : isAppendColumnPointerHit({
              screenX: x,
              scrollLeft,
              totalWidth,
              freezeRegionWidth,
              columnInitSize,
              columnCount,
            })
          ? -2
          : x <= freezeRegionWidth
            ? x <= columnInitSize
              ? -1
              : coordInstance.getColumnStartIndex(x)
            : coordInstance.getColumnStartIndex(scrollLeft + x);

    return { x, y, rowIndex, columnIndex: Math.min(columnIndex, columnCount - 1) };
  };

  const getHoverCellPosition = (mouseState: IMouseState) => {
    const { rowIndex, columnIndex, x, y } = mouseState;
    const { realIndex, type } = getLinearRow(rowIndex);
    const isCellRange = columnIndex > -1 && type === LinearRowType.Row;

    if (isCellRange) {
      const cell = getCellContent([columnIndex, realIndex]);
      const cellRenderer = getCellRenderer(cell.type);

      if (
        cellRenderer.needsHoverPosition ||
        (cellRenderer.needsHoverPositionWhenActive &&
          activeCell &&
          isEqual(activeCell, [columnIndex, realIndex]))
      ) {
        const offsetX = coordInstance.getColumnOffset(columnIndex);
        let hoverX =
          columnIndex < freezeColumnCount ? x - offsetX : x - offsetX + scrollLeft;

        // 首列子记录树缩进：绘制区从 indentedX 起算，hover 坐标需对齐
        if (columnIndex === 0 && getRowTreeData) {
          const treeData = getRowTreeData(realIndex);
          if (typeof treeData?.treeDepth === 'number') {
            hoverX -= (treeData.treeDepth + 1) * TREE_INDENT_PER_LEVEL;
          }
        }

        return [
          hoverX,
          y - coordInstance.getRowOffset(rowIndex) + scrollTop,
        ] as ICellPosition;
      }
    }
    return null;
  };

  const { onAutoScroll, onAutoScrollStop } = useAutoScroll({
    coordInstance,
    scrollBy,
  });

  const activeCellBound = useMemo(() => {
    if (_activeCellBound == null) return null;
    return {
      ..._activeCellBound,
      scrollTop: _activeCellBound.scrollEnable ? cellScrollTop : 0,
    };
  }, [_activeCellBound, cellScrollTop]);

  const getMouseState = (positionOverride?: { x: number; y: number }) => {
    const position = getPosition(positionOverride);
    const { x, y } = position;
    const { totalHeight, totalWidth } = coordInstance;
    const isOutOfBounds =
      scrollLeft + x > totalWidth + columnAppendBtnWidth ||
      (scrollTop + y > totalHeight && !inRange(y, containerHeight, height));
    const regionData = getRegionData({
      position,
      dragState,
      selection,
      isSelecting,
      columnResizeState,
      columnStatistics,
      coordInstance,
      scrollState,
      rowControls,
      isFreezing,
      isOutOfBounds,
      isColumnResizable,
      isColumnAppendEnable,
      isMultiSelectionEnable,
      isColumnHeaderMenuVisible,
      isColumnFreezable,
      activeCellBound,
      activeCell,
      columns,
      commentCountMap,
      getCellContent,
      height,
      theme,
      getLinearRow,
      real2RowIndex,
      getRowTreeData,
      isFillEnabled: onFillSelection != null,
    });

    hoveredRegionRef.current = regionData;
    const { x: _x, y: _y, width: _w, height: _h, ...rest } = regionData;

    return {
      ...position,
      isOutOfBounds,
      ...rest,
    };
  };

  const getMouseStateFromEvent = (event: React.MouseEvent<HTMLDivElement, MouseEvent>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return getMouseState({
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
    });
  };

  const getColumnResizeTargetIndex = (mouseState: IMouseState) => {
    const { type, rowIndex, columnIndex, x } = mouseState;
    if (rowIndex !== -1 || columnIndex < 0) return -1;
    if (![RegionType.ColumnHeader, RegionType.ColumnResizeHandler].includes(type)) return -1;

    const tolerance = Math.max(columnResizeHandlerWidth * 2, 10);
    const startOffsetX = coordInstance.getColumnRelativeOffset(columnIndex, scrollLeft);
    const endOffsetX = startOffsetX + coordInstance.getColumnWidth(columnIndex);

    if (columnIndex > 0 && Math.abs(x - startOffsetX) <= tolerance) {
      return columnIndex - 1;
    }

    if (Math.abs(x - endOffsetX) <= tolerance) {
      return columnIndex;
    }

    return -1;
  };

  const setCursorStyle = (regionType: RegionType) => {
    if (isScrolling) return;
    if (isFreezing) return setCursor('grab');
    if (isDragging) return setCursor('grabbing');

    switch (regionType) {
      case RegionType.AppendRow: {
        if (activeCell != null) return;
        return setCursor('pointer');
      }
      case RegionType.AppendColumn:
      case RegionType.GroupStatistic:
      case RegionType.ColumnStatistic:
      case RegionType.ColumnHeaderMenu:
      case RegionType.ColumnDescription:
      case RegionType.ColumnPrimaryIcon:
      case RegionType.RowGroupControl:
      case RegionType.RowHeaderExpandHandler:
      case RegionType.RowTreeExpandHandler:
      case RegionType.RowTreeAddSubRecord:
        return setCursor('pointer');
      case RegionType.CommentCount:
        return setCursor('pointer');
      case RegionType.ColumnFreezeHandler:
        return setCursor('grab');
      case RegionType.AllCheckbox:
      case RegionType.RowHeaderCheckbox: {
        if (
          [SelectableType.None, SelectableType.Column, SelectableType.Cell].includes(
            selectable as SelectableType
          )
        ) {
          return setCursor('not-allowed');
        }
        return setCursor('pointer');
      }
      case RegionType.RowHeaderDragHandler: {
        if (draggable === DraggableType.Column || draggable === DraggableType.None) {
          return setCursor('not-allowed');
        }
        return setCursor('grabbing');
      }
      case RegionType.ColumnResizeHandler:
        return setCursor(COLUMN_RESIZE_CURSOR);
      case RegionType.FillHandler:
        return setCursor('crosshair');
      default:
        setCursor('default');
    }
  };

  // eslint-disable-next-line sonarjs/cognitive-complexity
  const onClick = (event: React.MouseEvent<HTMLDivElement, MouseEvent>) => {
    // 拖拽（列/行重排）结束后浏览器会补发一次 click，此处吞掉，避免误触发列头点击弹出菜单
    if (draggedBeforeClickRef.current) {
      draggedBeforeClickRef.current = false;
      return;
    }
    const mouseState = getMouseStateFromEvent(event);
    onSelectionClick(event, mouseState);
    const { type, rowIndex: hoverRowIndex, columnIndex } = mouseState;

    const { realIndex: rowIndex } = getLinearRow(hoverRowIndex);

    switch (type) {
      case RegionType.AppendRow: {
        if (activeCell != null) {
          setSelection(selection.reset());
          setActiveCell(null);
        }
        const rowTop = coordInstance.getRowOffset(hoverRowIndex) - scrollTop;
        appendRowGestureGuardRef.current = {
          until: performance.now() + APPEND_ROW_GESTURE_GUARD_MS,
          top: rowTop,
          bottom: rowTop + coordInstance.getRowHeight(hoverRowIndex),
        };
        const linearRow = getLinearRow(hoverRowIndex);
        onRowAppend?.({
          rowIndex:
            typeof linearRow.realIndex === 'number' && linearRow.realIndex >= 0
              ? linearRow.realIndex
              : undefined,
          groupPath:
            linearRow.type === LinearRowType.Append &&
            typeof linearRow.groupPath === 'string'
              ? linearRow.groupPath
              : null,
          groupValues:
            linearRow.type === LinearRowType.Append &&
            linearRow.groupValues &&
            typeof linearRow.groupValues === 'object'
              ? linearRow.groupValues
              : undefined,
        });
        return;
      }
      case RegionType.AppendColumn:
        return onColumnAppend?.();
      case RegionType.RowHeaderExpandHandler:
        return onRowExpand?.(rowIndex);
      case RegionType.RowTreeExpandHandler:
        return onTreeToggle?.(rowIndex);
      case RegionType.RowTreeAddSubRecord:
        return onInsertSubRecord?.(rowIndex);
      case RegionType.CommentCount:
        return onCommentCountClick?.(rowIndex);
      case RegionType.ColumnHeader:
        return onColumnHeaderClick?.(columnIndex, {
          x: coordInstance.getColumnRelativeOffset(columnIndex, scrollLeft),
          y: 0,
          width: coordInstance.getColumnWidth(columnIndex),
          height: columnHeadHeight,
        });
      case RegionType.ColumnHeaderMenu:
        return onColumnHeaderMenuClick?.(columnIndex, {
          x: coordInstance.getColumnRelativeOffset(columnIndex, scrollLeft),
          y: 0,
          width: coordInstance.getColumnWidth(columnIndex),
          height: columnHeadHeight,
        });
      case RegionType.GroupStatistic:
      case RegionType.ColumnStatistic: {
        const { x, y, width, height } = hoveredRegionRef.current;
        return onColumnStatisticClick?.(columnIndex, {
          x,
          y,
          width,
          height,
        });
      }
      case RegionType.Cell:
      case RegionType.ActiveCell: {
        const cell = getCellContent([columnIndex, rowIndex]) as IInnerCell;
        const cellRenderer = getCellRenderer(cell.type);
        const onCellClick = cellRenderer.onClick;
        const isActive =
          isEqual(prevActiveCellRef.current, activeCell) &&
          isEqual(activeCell, [columnIndex, rowIndex]);
        const clickHoverCellPosition =
          getHoverCellPosition(mouseState) ?? hoverCellPosition;

        if (onCellClick && clickHoverCellPosition) {
          onCellClick(
            cell as never,
            {
              width: coordInstance.getColumnWidth(columnIndex),
              height: coordInstance.getRowHeight(hoverRowIndex),
              theme,
              hoverCellPosition: clickHoverCellPosition,
              activeCellBound,
              isActive,
            },
            (cellRegion: ICellRegionWithData) => {
              const { type, data } = cellRegion;

              if (type === CellRegionType.Update) {
                return onCellEdited?.([columnIndex, rowIndex], {
                  ...cell,
                  data,
                } as IInnerCell);
              }

              if (type === CellRegionType.ToggleEditing) {
                return setEditing(true);
              }
            }
          );
        }
        return;
      }
      case RegionType.RowGroupControl: {
        const { rowIndex } = mouseState;
        const linearRow = getLinearRow(rowIndex);
        if (linearRow.type !== LinearRowType.Group) return;
        const { id } = linearRow;

        if (collapsedGroupIds == null) {
          return onCollapsedGroupChanged?.(new Set([id]));
        }

        if (collapsedGroupIds.has(id)) {
          const newCollapsedGroupIds = new Set(collapsedGroupIds);
          newCollapsedGroupIds.delete(id);
          return onCollapsedGroupChanged?.(newCollapsedGroupIds);
        }
        return onCollapsedGroupChanged?.(new Set([...collapsedGroupIds, id]));
      }
    }

    const { type: clickRegionType, ...rest } = hoveredRegionRef.current;
    onItemClick?.(clickRegionType, rest, [columnIndex, rowIndex]);
  };

  const onDblClick = () => {
    const mouseState = getMouseState();
    const { type, rowIndex, columnIndex } = mouseState;
    const { realIndex } = getLinearRow(rowIndex);
    if (
      [RegionType.Cell, RegionType.ActiveCell].includes(type) &&
      isEqual(selectionRanges[0], [columnIndex, realIndex])
    ) {
      const cell = getCellContent([columnIndex, realIndex]) as IInnerCell;
      // 关联字段强制 readonly（走弹窗选记录），双击应直接打开选择器，无需先激活再点
      if (cell.type === CellType.Link) {
        const linkCell = cell as ILinkCell;
        if (linkCell.onExpand) {
          linkCell.onExpand();
          return;
        }
      }
      if (cell.readonly) return onCellDblClick?.([columnIndex, realIndex]);
      editorContainerRef.current?.focus?.();
      return setEditing(true);
    }
    if (
      type === RegionType.ColumnHeader &&
      isEqual(selectionRanges[0], [columnIndex, columnIndex])
    ) {
      return onColumnHeaderDblClick?.(columnIndex, {
        x: coordInstance.getColumnRelativeOffset(columnIndex, scrollLeft),
        y: 0,
        width: coordInstance.getColumnWidth(columnIndex),
        height: columnHeadHeight,
      });
    }
  };

  const onSmartClick = (event: React.MouseEvent<HTMLDivElement, MouseEvent>) => {
    const eventDetail = event.detail;

    if (eventDetail === 1) {
      onClick(event);
    }

    if (eventDetail === 2) {
      onDblClick();
    }
  };

  const isCurrentPrefillingRowMouseEvent = (
    event: React.MouseEvent<HTMLDivElement, MouseEvent> | React.PointerEvent<HTMLDivElement>
  ) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const y = event.clientY - rect.top;
    const appendRowGestureGuard = appendRowGestureGuardRef.current;
    if (
      appendRowGestureGuard &&
      performance.now() <= appendRowGestureGuard.until &&
      y >= appendRowGestureGuard.top &&
      y <= appendRowGestureGuard.bottom
    ) {
      return true;
    }

    if (!isEditing || !activeCell || !prefillingRowIndexes?.length) {
      return false;
    }

    const [, activeRealRowIndex] = activeCell;
    if (!prefillingRowIndexes.includes(activeRealRowIndex)) {
      return false;
    }

    if (y <= coordInstance.rowInitSize) {
      return false;
    }

    const linearRowIndex = coordInstance.getRowStartIndex(scrollTop + y);
    const linearRow = getLinearRow(linearRowIndex);
    return linearRow.type === LinearRowType.Row && linearRow.realIndex === activeRealRowIndex;
  };

  const preventPrefillingRowBlur = (
    event: React.MouseEvent<HTMLDivElement, MouseEvent> | React.PointerEvent<HTMLDivElement>
  ) => {
    if (!isCurrentPrefillingRowMouseEvent(event)) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
  };

  const onMouseDown = (event: React.MouseEvent<HTMLDivElement, MouseEvent>) => {
    const target = event.target;
    if (isGridOverlayTarget(target)) {
      return;
    }
    if (event.button === MouseButtonType.Right) return;
    event.preventDefault();
    draggedBeforeClickRef.current = false;
    columnResizeGestureRef.current = false;
    const mouseState = getMouseStateFromEvent(event);
    setMouseState(mouseState);
    const nextHoverCellPosition = getHoverCellPosition(mouseState);
    if (nextHoverCellPosition) {
      setHoverCellPosition(nextHoverCellPosition);
    }
    const { rowIndex: hoverRowIndex, columnIndex, type } = mouseState;
    const { realIndex: rowIndex } = getLinearRow(hoverRowIndex);

    // Start fill-drag only when clicking the fill handler
    if (type === RegionType.FillHandler && onFillSelection) {
      isFillingRef.current = true;
      fillSelectionRef.current = selection;
      stopEditingWithReason('interaction');
      // mousedown preventDefault 会打断浏览器默认聚焦；fill 路径又不会走选区 start，
      // 这里显式拉回 grid 根，避免拖完后 Cmd/Ctrl+Z 因焦点在 body 上被宿主守卫丢掉。
      gridContainerRef.current?.focus({ preventScroll: true });
      return;
    }

    const resizeColumnIndex = getColumnResizeTargetIndex(mouseState);
    const shouldStartColumnResize = isColumnResizable && resizeColumnIndex > -1;

    if (shouldStartColumnResize) {
      columnResizeGestureRef.current = true;
      setDragState(DEFAULT_DRAG_STATE);
      stopEditingWithReason('interaction');
      if (type === RegionType.ColumnResizeHandler) {
        onColumnResizeStart(mouseState);
      } else {
        setColumnResizeState({
          x: mouseState.x,
          columnIndex: resizeColumnIndex,
          width: coordInstance.getColumnWidth(resizeColumnIndex),
        });
      }
      return;
    }

    if (
      !(
        isCellSelection &&
        isEqual(selectionRanges[0], [columnIndex, rowIndex]) &&
        type === RegionType.Cell
      )
    ) {
      stopEditingWithReason('interaction');
    }
    onDragStart(mouseState, (type, ranges) => {
      if (type === DragRegionType.Columns) {
        _onDragStart?.(type, flatRanges(ranges));
      }
      if (type === DragRegionType.Rows) {
        const originRealIndexs = flatRanges(ranges).map((index) => getLinearRow(index).realIndex);
        _onDragStart?.(type, originRealIndexs);
      }
    });
    onColumnFreezeStart(mouseState);
    prevActiveCellRef.current = activeCell;
    onSelectionStart(event, mouseState);
    isColumnResizable && onColumnResizeStart(mouseState);
  };

  const onCellPosition = (mouseState: IMouseState) => {
    const { columnIndex, rowIndex, type } = mouseState;
    const { realIndex } = getLinearRow(rowIndex);
    const cell = getCellContent([columnIndex, realIndex]);
    const cellRenderer = getCellRenderer(cell.type);
    const { needsHover, needsHoverPosition, needsHoverWhenActive, needsHoverPositionWhenActive } =
      cellRenderer;
    const isActive = type === RegionType.ActiveCell;
    if ((needsHoverPosition || (needsHoverPositionWhenActive && isActive)) && hoverCellPosition) {
      const region = cellRenderer.checkRegion?.(cell as never, {
        width: coordInstance.getColumnWidth(columnIndex),
        height: coordInstance.getRowHeight(rowIndex),
        theme,
        isActive,
        activeCellBound,
        hoverCellPosition,
      }) ?? { type: CellRegionType.Blank };
      const { type } = region;

      if (type === CellRegionType.Hover) {
        const { x, y, width, height } = region.data as IRectangle;
        const offsetX = coordInstance.getColumnOffset(columnIndex);
        const offsetY = coordInstance.getRowOffset(rowIndex);
        onItemHovered?.(
          RegionType.CellValue,
          {
            x:
              columnIndex < coordInstance.freezeColumnCount
                ? x + offsetX
                : x + offsetX - scrollLeft,
            y: y + offsetY - scrollTop,
            width,
            height,
          },
          [columnIndex, realIndex]
        );
      }

      return type !== CellRegionType.Blank ? setCursor('pointer') : undefined;
    }
    if (needsHover || (needsHoverWhenActive && isActive)) {
      setCursor('pointer');
    }
  };

  const mouseMoveRafRef = useRef<number | null>(null);

  const onMouseMoveCore = () => {
    const mouseState = getMouseState();
    const hoverCellPosition = getHoverCellPosition(mouseState);
    setHoverCellPosition(() => hoverCellPosition);
    setMouseState(() => mouseState);
    setCursorStyle(mouseState.type);
    onCellPosition(mouseState);
    if (isFillingRef.current) onAutoScroll(mouseState);
    if (isSelecting) onAutoScroll(mouseState);
    if (isDragging) onAutoScroll(mouseState, dragType);
    if (!isFillingRef.current) onSelectionChange(mouseState);
    onColumnResizeChange(mouseState, (newWidth, columnIndex) => {
      onColumnResize?.(columns[columnIndex], newWidth, columnIndex);
    });
    if (!isResizing && !columnResizeGestureRef.current) {
      onDragChange(mouseState);
    }
    onColumnFreezeMove(mouseState);
    if (!isInteracting && !isEqual(hoveredRegionRef.current, previousHoveredRegionRef.current)) {
      const { type, ...rest } = hoveredRegionRef.current;
      const { columnIndex, rowIndex } = mouseState;
      onItemHovered?.(type, rest, [columnIndex, getLinearRow(rowIndex).realIndex]);
    }
    previousHoveredRegionRef.current = { ...hoveredRegionRef.current };
  };

  const onMouseMove = () => {
    if (mouseMoveRafRef.current != null) return;
    mouseMoveRafRef.current = requestAnimationFrame(() => {
      mouseMoveRafRef.current = null;
      onMouseMoveCore();
    });
  };

  useEffect(() => {
    return () => {
      if (mouseMoveRafRef.current != null) {
        cancelAnimationFrame(mouseMoveRafRef.current);
      }
    };
  }, []);

  const onMouseUp = () => {
    const mouseState = getMouseState();
    setMouseState(mouseState);
    onAutoScrollStop();
    // 在 onDragEnd 重置 dragState 之前，记录本次 mouseup 是否结束了真实拖拽
    draggedBeforeClickRef.current = dragState.isDragging;
    let didFill = false;

    if (isFillingRef.current) {
      const selectionSnapshot = fillSelectionRef.current;
      if (selectionSnapshot?.isCellSelection) {
        const [start, end] = selectionSnapshot.serialize();
        const minRow = Math.min(start[1], end[1]);
        const maxRow = Math.max(start[1], end[1]);
        const { realIndex: targetRealRow } = getLinearRow(mouseState.rowIndex);
        if (Number.isFinite(targetRealRow) && targetRealRow > maxRow) {
          onFillSelection?.([start, end] as [IRange, IRange], targetRealRow);
          const startCol = Math.min(start[0], end[0]);
          const endCol = Math.max(start[0], end[0]);
          const startRow = Math.min(start[1], end[1]);
          const finalStart: IRange = [startCol, startRow];
          const finalEnd: IRange = [endCol, targetRealRow];
          setSelection(selection.set(SelectionRegionType.Cells, [finalStart, finalEnd]));
          didFill = true;
        } else if (Number.isFinite(targetRealRow) && targetRealRow < minRow) {
          onFillSelection?.([start, end] as [IRange, IRange], targetRealRow);
          const startCol = Math.min(start[0], end[0]);
          const endCol = Math.max(start[0], end[0]);
          const finalStart: IRange = [startCol, targetRealRow];
          const finalEnd: IRange = [endCol, maxRow];
          setSelection(selection.set(SelectionRegionType.Cells, [finalStart, finalEnd]));
          didFill = true;
        }
      }
      isFillingRef.current = false;
      fillSelectionRef.current = null;
      // fill 手势 mousedown 常 preventDefault，mouseup 默认动作仍可能把焦点甩到 body。
      // 同步 focus 会被后续默认处理盖掉，故 rAF 双帧后再拉回 grid / trap。
      const restoreFillFocus = () => {
        gridContainerRef.current?.focus({ preventScroll: true });
        editorContainerRef.current?.focus?.();
      };
      restoreFillFocus();
      requestAnimationFrame(() => {
        requestAnimationFrame(restoreFillFocus);
      });
    }
    if (isResizing || columnResizeGestureRef.current) {
      setDragState(DEFAULT_DRAG_STATE);
    } else {
      onDragEnd(mouseState, (ranges, dropIndex) => {
        if (dragType === DragRegionType.Columns) {
          onColumnOrdered?.(flatRanges(ranges), dropIndex);
        }
        if (dragType === DragRegionType.Rows) {
          const originRealIndexs = flatRanges(ranges).map((index) => getLinearRow(index).realIndex);
          const rowDropTarget = getRowDropTarget(coordInstance, mouseState, scrollState);
          const rowDropIndex = rowDropTarget.dropIndex;
          const targetLinearRow =
            typeof rowDropTarget.targetIndex === 'number'
              ? getLinearRow(rowDropTarget.targetIndex)
              : null;
          const { type: prevType } = getLinearRow(rowDropIndex - 1);
          const { type, realIndex } = getLinearRow(rowDropIndex);
          const targetRowIndex =
            targetLinearRow?.type === LinearRowType.Row
              ? targetLinearRow.realIndex
              : undefined;
          const rowMoveContext = {
            dropMode: rowDropTarget.mode,
            ...(typeof targetRowIndex === 'number' ? { targetRowIndex } : {}),
          };

          if (
            (prevType === LinearRowType.Row && type === LinearRowType.Append) ||
            (prevType === LinearRowType.Group && type === LinearRowType.Row && realIndex !== 0)
          ) {
            return onRowOrdered?.(originRealIndexs, realIndex + 1, rowMoveContext);
          }

          onRowOrdered?.(originRealIndexs, realIndex, rowMoveContext);
        }
        if (!didFill) {
          setActiveCell(null);
          setSelection(selection.reset());
        }
        setCursor('default');
      });
    }
    onColumnFreezeEnd((columnCount: number) => {
      onColumnFreeze?.(columnCount);
      setMouseState(DEFAULT_MOUSE_STATE);
    });
    onSelectionEnd();
    onColumnResizeEnd();
    columnResizeGestureRef.current = false;
  };

  const onMouseLeave = () => {
    if (isInteracting) return;
    const { type, ...rest } = BLANK_REGION_DATA;
    onItemHovered?.(type, rest, [-Infinity, -Infinity]);
    setMouseState(DEFAULT_MOUSE_STATE);
    setHoveredColumnResizeIndex(-1);
  };

  const onContextMenuInner = (event: React.MouseEvent<HTMLDivElement, MouseEvent>) => {
    if (event.cancelable) event.preventDefault();
    const mouseState = getMouseStateFromEvent(event);
    const { type, rowIndex } = mouseState;

    if (type === RegionType.RowGroupHeader || type === RegionType.RowGroupControl) {
      const linearRow = getLinearRow(rowIndex);

      if (linearRow.type !== LinearRowType.Group) return;

      const { id: groupId } = linearRow;
      return onGroupHeaderContextMenu?.(groupId, {
        x: event.clientX,
        y: event.clientY,
        coordinateSpace: 'client',
      });
    }

    if (onContextMenu) {
      onSelectionContextMenu(mouseState, (selection) =>
        onContextMenu(selection, {
          x: event.clientX,
          y: event.clientY,
          coordinateSpace: 'client',
        })
      );
    }
  };

  const resetState = () => {
    setActiveCell(null);
    setDragState(DEFAULT_DRAG_STATE);
    setMouseState(DEFAULT_MOUSE_STATE);
    setSelection(selection.reset());
    setHoveredColumnResizeIndex(-1);
    setColumnResizeState(DEFAULT_COLUMN_RESIZE_STATE);
    columnResizeGestureRef.current = false;
  };

  useEventListener('mousemove', onMouseMove, isInteracting ? window : stageRef.current, true);
  useEventListener('mouseup', onMouseUp, isInteracting ? window : stageRef.current, true);

  useClickAway(containerRef, (event) => {
    if (isGridOverlayTarget(event.target)) {
      return;
    }
    stopEditingWithReason('interaction');
  });

  useLayoutEffect(() => {
    if (activeColumnIndex == null || activeRowIndex == null) return;
    cellScrollerRef.current?.reset();
  }, [activeColumnIndex, activeRowIndex]);

  return (
    <div
      ref={containerRef}
      style={{
        position: 'absolute',
        width,
        height,
        cursor,
      }}
      className="absolute"
    >
      <div
        ref={stageRef}
        data-t-grid-stage
        className="size-full"
        title={getRegionTitle(mouseState.type)}
        style={{ width: '100%', height: '100%' }}
        onClick={onSmartClick}
        onPointerDownCapture={preventPrefillingRowBlur}
        onMouseDownCapture={preventPrefillingRowBlur}
        onMouseDown={onMouseDown}
        onMouseLeave={onMouseLeave}
        onContextMenu={onContextMenuInner}
      >
        <RenderLayer
          theme={theme}
          width={width}
          height={height}
          columns={columns}
          commentCountMap={commentCountMap}
          columnStatistics={columnStatistics}
          coordInstance={coordInstance}
          rowControls={rowControls}
          imageManager={imageManager}
          spriteManager={spriteManager}
          visibleRegion={visibleRegion}
          collaborators={collaborators}
          searchCursor={searchCursor}
          searchHitIndex={searchHitIndex}
          prefillingRowIndexes={prefillingRowIndexes}
          activeCellBound={activeCellBound}
          activeCell={activeCell}
          mouseState={mouseState}
          scrollState={scrollState}
          dragState={dragState}
          selection={selection}
          groupCollection={groupCollection}
          forceRenderFlag={forceRenderFlag}
          rowIndexVisible={rowIndexVisible}
          columnResizeState={columnResizeState}
          columnFreezeState={columnFreezeState}
          columnHeaderHeight={columnHeaderHeight}
          hoverCellPosition={hoverCellPosition}
          hoveredColumnResizeIndex={hoveredColumnResizeIndex}
          isRowAppendEnable={isRowAppendEnable}
          isColumnFreezable={isColumnFreezable}
          isColumnResizable={isColumnResizable}
          isColumnAppendEnable={isColumnAppendEnable}
          isColumnHeaderMenuVisible={isColumnHeaderMenuVisible}
          isEditing={isEditing}
          isSelecting={isSelecting}
          isInteracting={isInteracting}
          isMultiSelectionEnable={isMultiSelectionEnable}
          getCellContent={getCellContent}
          getRowTreeData={getRowTreeData}
          real2RowIndex={real2RowIndex}
          getLinearRow={getLinearRow}
          isFilling={isFilling}
          isFillEnabled={onFillSelection != null}
        />
      </div>

      {activeCellBound?.scrollEnable && !isEditing && (
        <CellScroller
          ref={cellScrollerRef}
          style={{
            top: coordInstance.getRowOffset(activeCellBound.rowIndex) + 4,
            left:
              coordInstance.getColumnRelativeOffset(activeCellBound.columnIndex + 1, scrollLeft) -
              10,
          }}
          containerRef={containerRef}
          activeCellBound={activeCellBound}
          setCellScrollTop={setCellScrollTop}
          scrollEnable={regionType === RegionType.ActiveCell}
        />
      )}

      <EditorContainer
        ref={editorContainerRef}
        gridContainerRef={gridContainerRef}
        theme={theme}
        isEditing={isEditing}
        selection={selection}
        activeCell={activeCell}
        scrollState={scrollState}
        coordInstance={coordInstance}
        activeCellBound={activeCellBound}
        onCopy={onCopy}
        onPaste={onPaste}
        onUndo={onUndo}
        onRedo={onRedo}
        onDelete={onDelete}
        onChange={onCellEdited}
        editorShiftEnterHint={editorShiftEnterHint}
        editorSelectSearchPlaceholder={editorSelectSearchPlaceholder}
        editorSelectSearchPlaceholderEmpty={editorSelectSearchPlaceholderEmpty}
        editorSelectNoResults={editorSelectNoResults}
        editorSelectEmptyHint={editorSelectEmptyHint}
        editorSelectAddOption={editorSelectAddOption}
        editorSelectDoneLabel={editorSelectDoneLabel}
        onRowExpand={onRowExpand}
        onTreeToggle={onTreeToggle}
        getRowTreeData={getRowTreeData}
        setEditing={setEditing}
        setSelection={setSelection}
        setActiveCell={setActiveCell}
        getCellContent={getCellContent}
        real2RowIndex={real2RowIndex}
        scrollToItem={scrollToItem}
        scrollBy={scrollBy}
      />
    </div>
  );
};

export const InteractionLayer = forwardRef(InteractionLayerBase);
