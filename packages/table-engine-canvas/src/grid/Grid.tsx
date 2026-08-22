/* eslint-disable jsx-a11y/no-static-element-interactions, jsx-a11y/no-noninteractive-tabindex */
import type { CSSProperties, ForwardRefRenderFunction } from 'react';
import { Suspense, lazy, useState, useReducer, useRef, useMemo, useEffect, useCallback, useImperativeHandle, forwardRef } from 'react';
import { LoadingIndicator } from './components/LoadingIndicator';
import type { IGridTheme } from './configs';
import { gridTheme, GRID_DEFAULT, DEFAULT_SCROLL_STATE, DEFAULT_MOUSE_STATE } from './configs';
import { useResizeObserver } from './hooks';
import type { ScrollerRef } from './InfiniteScroller';
import { InfiniteScroller } from './InfiniteScroller';
import type { IInteractionLayerRef } from './InteractionLayer';
import { InteractionLayer } from './InteractionLayer';
import type {
  IRectangle,
  IScrollState,
  ICellItem,
  IGridColumn,
  IMouseState,
  IPosition,
  IRowControlItem,
  IColumnStatistics,
  ICollaborator,
  IGroupPoint,
  ILinearRow,
  IGroupCollection,
  DragRegionType,
  IColumnLoading,
  IRange,
  ICellError,
  IRowTreeData,
} from './interface';
import {
  RegionType,
  RowControlType,
  DraggableType,
  SelectableType,
  LinearRowType,
} from './interface';
import type { ISpriteMap, CombinedSelection, IIndicesMap } from './managers';
import { CoordinateManager, SpriteManager, ImageManager } from './managers';
import { buildGroupRowsInfo } from './utils/groupRowsInfo';
import { getCellRenderer, type ICell, type IInnerCell } from './renderers';
import { measuredCanvas } from './utils';
import { computeScrollToItem } from './utils/keyboardNavigation';

export interface IGridExternalProps {
  theme?: Partial<IGridTheme>;
  customIcons?: ISpriteMap;
  rowControls?: IRowControlItem[];
  smoothScrollX?: boolean;
  smoothScrollY?: boolean;
  scrollBufferX?: number;
  scrollBufferY?: number;
  scrollBarVisible?: boolean;
  rowIndexVisible?: boolean;
  collaborators?: ICollaborator;
  // [rowIndex, colIndex]
  searchCursor?: [number, number] | null;
  searchHitIndex?: { fieldId: string; recordId: string }[];
  editorShiftEnterHint?: string;
  editorSelectSearchPlaceholder?: string;
  editorSelectSearchPlaceholderEmpty?: string;
  editorSelectNoResults?: string;
  editorSelectEmptyHint?: string;
  editorSelectAddOption?: string;
  editorSelectDoneLabel?: string;
  /**
   * Real row indexes that should render as "prefilling/new record" highlighted rows.
   */
  prefillingRowIndexes?: number[];

  /**
   * Indicates which areas can be dragged, including rows, columns or no drag
   * - 'all': Allow drag of rows, columns and cells (default)
   * - 'none': Disable drag for all areas
   * - 'row': Allow row drag only
   * - 'column': Allow column drag only
   */
  draggable?: DraggableType;

  /**
   * Indicates which areas can be selected, including row selection,
   * column selection, cell selection, all areas, or no selection
   * - 'all': Allow selection of rows, columns and cells (default)
   * - 'none': Disable selection for all areas
   * - 'row': Allow row selection only
   * - 'column': Allow column selection only
   * - 'cell': Allow cell selection only
   */
  selectable?: SelectableType;

  /**
   * Whether to allow multiple selection operations, including rows, columns and cells
   * If true, allow multiple selection of rows/columns/cells (default)
   * If false, disable multiple selection operations
   * @type {boolean}
   */
  isMultiSelectionEnable?: boolean;

  groupCollection?: IGroupCollection | null;
  collapsedGroupIds?: Set<string> | null;
  groupPoints?: IGroupPoint[] | null;

  onUndo?: () => void;
  onRedo?: () => void;
  onCopy?: (selection: CombinedSelection, e: React.ClipboardEvent) => void;
  onPaste?: (selection: CombinedSelection, e: React.ClipboardEvent) => void;
  onDelete?: (selection: CombinedSelection) => void;
  onCellEdited?: (cell: ICellItem, newValue: IInnerCell) => void;
  onCellDblClick?: (cell: ICellItem) => void;
  onSelectionChanged?: (selection: CombinedSelection) => void;
  onVisibleRegionChanged?: (rect: IRectangle) => void;
  onCollapsedGroupChanged?: (collapsedGroupIds: Set<string>) => void;
  onColumnFreeze?: (freezeColumnCount: number) => void;
  onColumnAppend?: () => void;
  onRowExpand?: (rowIndex: number) => void;
  onCommentCountClick?: (rowIndex: number) => void;
  onTreeToggle?: (rowIndex: number) => void;
  onInsertSubRecord?: (rowIndex: number) => void;
  onRowAppend?: (context?: {
    rowIndex?: number;
    groupPath?: string | null;
    groupValues?: Record<string, unknown>;
  }) => void;
  onRowOrdered?: (
    dragRowIndexCollection: number[],
    dropRowIndex: number,
    context?: { dropMode?: 'before' | 'after' | 'inside'; targetRowIndex?: number },
  ) => void;
  onColumnOrdered?: (dragColIndexCollection: number[], dropColIndex: number) => void;
  onColumnResize?: (column: IGridColumn, newSize: number, colIndex: number) => void;
  onColumnHeaderClick?: (colIndex: number, bounds: IRectangle) => void;
  onColumnHeaderDblClick?: (colIndex: number, bounds: IRectangle) => void;
  onColumnHeaderMenuClick?: (colIndex: number, bounds: IRectangle) => void;
  onColumnStatisticClick?: (colIndex: number, bounds: IRectangle) => void;
  onContextMenu?: (selection: CombinedSelection, position: IPosition) => void;
  onGroupHeaderContextMenu?: (groupId: string, position: IPosition) => void;
  onScrollChanged?: (scrollLeft: number, scrollTop: number) => void;
  onDragStart?: (type: DragRegionType, dragIndexs: number[]) => void;

  /**
   * Triggered when the mouse hovers over the every type of region
   */
  onItemHovered?: (type: RegionType, bounds: IRectangle, cellItem: ICellItem) => void;

  /**
   * Triggered when the mouse clicks the every type of region
   */
  onItemClick?: (type: RegionType, bounds: IRectangle, cellItem: ICellItem) => void;

  /**
   * Triggered when user drags the fill handle downward to auto-fill cells
   * Only vertical fill is supported. Provides current selection ranges and the target end real row index
   */
  onFillSelection?: (selectionRanges: [IRange, IRange], targetEndRealRowIndex: number) => void;
  onEditingStopped?: (event: {
    cell: ICellItem | null;
    cellId: string | null;
    reason: 'api' | 'interaction' | 'editor';
  }) => void;
}

export interface IGridProps extends IGridExternalProps {
  columns: IGridColumn[];
  commentCountMap?: Record<string, number>;
  freezeColumnCount?: number;
  rowCount: number;
  rowHeight?: number;
  style?: CSSProperties;
  isTouchDevice?: boolean;
  columnHeaderHeight?: number;
  columnStatistics?: IColumnStatistics;
  getCellContent: (cell: ICellItem) => ICell;
  getRowTreeData?: (rowIndex: number) => IRowTreeData | null;
}

export interface IGridRef {
  resetState: () => void;
  forceUpdate: () => void;
  getActiveCell: () => ICellItem | null;
  getEditingCells: () => ICellItem[];
  startEditingCell: (cell: ICellItem) => void;
  stopEditing: () => void;
  cancelEditing: () => void;
  getRowOffset: (rowIndex: number) => number;
  setSelection: (selection: CombinedSelection) => void;
  getScrollState: () => IScrollState;
  scrollBy: (deltaX: number, deltaY: number) => void;
  scrollTo: (scrollLeft?: number, scrollTop?: number) => void;
  scrollToItem: (position: [columnIndex: number, rowIndex: number]) => void;
  setActiveCell: (cell: ICellItem | null) => void;
  getCellIndicesAtPosition: (x: number, y: number) => ICellItem | null;
  getContainer: () => HTMLDivElement | null;
  getCellBounds: (cell: ICellItem) => IRectangle | null;
  setCellLoading: (cells: ICellItem[]) => void;
  setColumnLoadings: (columnLoadings: IColumnLoading[]) => void;
  setCellErrors: (cellErrors: ICellError[]) => void;
  isEditing: () => boolean | undefined;
}

const {
  scrollBuffer,
  appendRowHeight,
  groupHeaderHeight,
  cellScrollBuffer,
  columnAppendBtnWidth,
  columnStatisticHeight,
  rowHeight: defaultRowHeight,
  columnWidth: defaultColumnWidth,
  columnHeadHeight: defaultColumnHeaderHeight,
} = GRID_DEFAULT;

const LazyErrorIndicator = lazy(async () => {
  const module = await import('./components/ErrorIndicator');
  return { default: module.ErrorIndicator };
});

const LazyTouchLayer = lazy(async () => {
  const module = await import('./TouchLayer');
  return { default: module.TouchLayer };
});

const GridBase: ForwardRefRenderFunction<IGridRef, IGridProps> = (props, forwardRef) => {
  const {
    columns,
    commentCountMap,
    groupCollection,
    collapsedGroupIds,
    draggable = DraggableType.All,
    selectable = SelectableType.All,
    columnStatistics,
    freezeColumnCount: _freezeColumnCount = 1,
    rowCount: originRowCount,
    rowHeight = defaultRowHeight,
    rowControls = [{ type: RowControlType.Checkbox }],
    theme: customTheme,
    isTouchDevice,
    smoothScrollX = true,
    smoothScrollY = true,
    scrollBufferX = scrollBuffer,
    scrollBufferY = scrollBuffer,
    scrollBarVisible = true,
    rowIndexVisible = true,
    isMultiSelectionEnable = true,
    style,
    customIcons,
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
    groupPoints,
    columnHeaderHeight = defaultColumnHeaderHeight,
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
    onColumnAppend,
    onColumnResize,
    onColumnOrdered,
    onDragStart,
    onContextMenu,
    onSelectionChanged,
    onVisibleRegionChanged,
    onColumnFreeze,
    onColumnHeaderClick,
    onColumnHeaderDblClick,
    onColumnHeaderMenuClick,
    onColumnStatisticClick,
    onCollapsedGroupChanged,
    onGroupHeaderContextMenu,
    onItemHovered,
    onItemClick,
    onScrollChanged,
    onFillSelection,
    onEditingStopped,
  } = props;

  useImperativeHandle(forwardRef, () => ({
    resetState: () => interactionLayerRef.current?.resetState(),
    forceUpdate: () => bumpForceRender(),
    getActiveCell: () => activeCell,
    getEditingCells: () => interactionLayerRef.current?.getEditingCells?.() ?? [],
    startEditingCell: (cell: ICellItem) => {
      interactionLayerRef.current?.startEditingCell?.(cell);
    },
    stopEditing: () => {
      interactionLayerRef.current?.stopEditing?.();
    },
    cancelEditing: () => {
      interactionLayerRef.current?.cancelEditing?.();
    },
    setSelection: (selection: CombinedSelection) => {
      interactionLayerRef.current?.setSelection(selection);
    },
    getRowOffset: (rowIndex: number) => {
      const { scrollTop } = scrollState;
      const realRowIndex = real2RowIndex(rowIndex);
      return coordInstance.getRowOffset(realRowIndex) - scrollTop;
    },
    scrollBy,
    scrollTo,
    scrollToItem,
    setActiveCell,
    getScrollState: () => scrollState,
    getCellIndicesAtPosition: (x: number, y: number): ICellItem | null => {
      const { scrollLeft, scrollTop } = scrollState;

      const rowIndex = coordInstance.getRowStartIndex(scrollTop + y);
      const columnIndex = coordInstance.getColumnStartIndex(scrollLeft + x);

      const { type, realIndex } = getLinearRow(rowIndex);
      if (type !== LinearRowType.Row) return null;

      return [columnIndex, realIndex];
    },
    getContainer: () => containerRef.current,
    setCellLoading: (cells: ICellItem[]) => {
      setCellLoadings(cells);
    },
    setColumnLoadings: (columnLoadings: IColumnLoading[]) => {
      setColumnLoadings(columnLoadings);
    },
    setCellErrors: (cellErrors: ICellError[]) => {
      setCellErrors(cellErrors);
    },
    getCellBounds: (cell: ICellItem) => {
      const [columnIndex, _rowIndex] = cell;
      const rowIndex = real2RowIndex(_rowIndex);
      const { scrollLeft, scrollTop } = scrollState;

      const columnOffsetX = coordInstance.getColumnRelativeOffset(columnIndex, scrollLeft);
      const columnWidth = coordInstance.getColumnWidth(columnIndex);

      if (columnOffsetX == null || columnWidth == null) {
        return null;
      }

      const rowOffsetY = coordInstance.getRowOffset(rowIndex);
      const rowHeight = coordInstance.getRowHeight(rowIndex);

      if (rowOffsetY == null || rowHeight == null) {
        return null;
      }

      return {
        x: columnOffsetX,
        y: rowOffsetY - scrollTop,
        width: columnWidth,
        height: rowHeight,
      };
    },
    isEditing: () => interactionLayerRef.current?.isEditing(),
  }));

  const hasAppendRow = onRowAppend != null;
  const hasAppendColumn = onColumnAppend != null;
  const rowControlCount = rowControls.length;
  const totalWidth = columns.reduce(
    (prev, column) => prev + (column.width || defaultColumnWidth),
    hasAppendColumn ? scrollBufferX + columnAppendBtnWidth : scrollBufferX
  );

  const [forceRenderFlag, bumpForceRender] = useReducer((x: number) => x + 1, 0);
  const [mouseState, setMouseState] = useState<IMouseState>(DEFAULT_MOUSE_STATE);
  const [scrollState, setScrollState] = useState<IScrollState>(DEFAULT_SCROLL_STATE);
  // activeCell 需与 mouseState 同帧提交；useRafState 会晚一帧，导致选中高亮/编辑器与 hover 错位闪烁。
  const [activeCell, setActiveCell] = useState<ICellItem | null>(null);
  const [cellLoadings, setCellLoadings] = useState<ICellItem[]>([]);
  const [columnLoadings, setColumnLoadings] = useState<IColumnLoading[]>([]);
  const [cellErrors, setCellErrors] = useState<ICellError[]>([]);
  const scrollerRef = useRef<ScrollerRef | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const interactionLayerRef = useRef<IInteractionLayerRef | null>(null);
  const { ref, width, height } = useResizeObserver<HTMLDivElement>();

  const [activeColumnIndex, activeRowIndex] = activeCell ?? [];
  const hoverRegionType = mouseState.type;
  const hasColumnStatistics = columnStatistics != null;
  const containerHeight = hasColumnStatistics ? height - columnStatisticHeight : height;
  const columnCount = columns.length;
  const freezeColumnCount = Math.min(_freezeColumnCount, columnCount);

  const theme = useMemo(() => ({ ...gridTheme, ...customTheme }), [customTheme]);
  const { iconSizeMD } = theme;

  const columnInitSize = useMemo(() => {
    return !rowIndexVisible && !rowControlCount ? 0 : Math.max(rowControlCount, 2) * iconSizeMD;
  }, [rowControlCount, rowIndexVisible, iconSizeMD]);

  const defaultRowsInfo = useMemo(() => {
    return {
      linearRows: [],
      real2LinearRowMap: null,
      pureRowCount: originRowCount,
      rowCount: hasAppendRow ? originRowCount + 1 : originRowCount,
      rowHeightMap: hasAppendRow ? { [originRowCount]: appendRowHeight } : undefined,
    };
  }, [appendRowHeight, hasAppendRow, originRowCount]);

  const groupRowsInfo = useMemo(() => {
    return buildGroupRowsInfo({
      groupPoints,
      hasAppendRow,
      appendRowHeight,
      groupHeaderHeight,
    });
  }, [appendRowHeight, groupHeaderHeight, groupPoints, hasAppendRow]);

  const { rowCount, pureRowCount, rowHeightMap, linearRows, real2LinearRowMap } = useMemo(() => {
    return { ...defaultRowsInfo, ...groupRowsInfo };
  }, [defaultRowsInfo, groupRowsInfo]);

  const getLinearRow = useCallback(
    (index: number) => {
      if (!linearRows.length) {
        return (
          index >= pureRowCount
            ? {
                type: LinearRowType.Append,
                realIndex: index - 1,
                value: null,
              }
            : {
                type: LinearRowType.Row,
                displayIndex: index + 1,
                realIndex: index,
              }
        ) as ILinearRow;
      }
      return linearRows[index] ?? { realIndex: -2 };
    },
    [linearRows, pureRowCount]
  );

  const real2RowIndex = useCallback(
    (index: number) => {
      if (real2LinearRowMap == null) return index;
      return real2LinearRowMap[index] ?? index;
    },
    [real2LinearRowMap]
  );

  const columnWidthMap = useMemo(() => {
    const map: Record<number, number> = {};
    for (let i = 0; i < columns.length; i++) {
      map[i] = columns[i].width || defaultColumnWidth;
    }
    return map;
  }, [columns]);

  const coordInstance = useMemo<CoordinateManager>(() => {
    return new CoordinateManager({
      rowHeight,
      columnWidth: defaultColumnWidth,
      pureRowCount,
      rowCount,
      columnCount,
      freezeColumnCount,
      containerWidth: width,
      containerHeight,
      rowInitSize: columnHeaderHeight,
      columnInitSize,
      rowHeightMap,
      columnWidthMap,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rowHeight, pureRowCount, rowCount, columnHeaderHeight]);

  const totalHeight = coordInstance.totalHeight + scrollBufferY;

  useEffect(() => {
    coordInstance.refreshRowDimensions({ rowCount, pureRowCount, rowInitSize: columnHeaderHeight, rowHeightMap });
    bumpForceRender();
  }, [coordInstance, rowCount, pureRowCount, columnHeaderHeight, rowHeightMap]);

  useEffect(() => {
    coordInstance.refreshColumnDimensions({ columnInitSize, columnCount, columnWidthMap });
    bumpForceRender();
  }, [coordInstance, columnInitSize, columnCount, columnWidthMap]);

  useEffect(() => {
    coordInstance.containerWidth = width;
    coordInstance.containerHeight = containerHeight;
    coordInstance.freezeColumnCount = freezeColumnCount;
    bumpForceRender();
  }, [coordInstance, width, containerHeight, freezeColumnCount]);

  const activeCellBound = useMemo(() => {
    if (activeColumnIndex == null || activeRowIndex == null) {
      return null;
    }

    const cell = getCellContent([activeColumnIndex, activeRowIndex]);
    const cellRenderer = getCellRenderer(cell.type);
    const originWidth = coordInstance.getColumnWidth(activeColumnIndex);
    const originHeight = coordInstance.getRowHeight(real2RowIndex(activeRowIndex));

    if (cellRenderer?.measure && measuredCanvas?.ctx != null) {
      const { width, height, totalHeight } = cellRenderer.measure(cell as never, {
        theme,
        ctx: measuredCanvas.ctx,
        width: originWidth,
        height: originHeight,
      });
      return {
        rowIndex: activeRowIndex,
        columnIndex: activeColumnIndex,
        width,
        height,
        totalHeight,
        scrollTop: 0,
        scrollEnable: totalHeight > height,
      };
    }
    return {
      rowIndex: activeRowIndex,
      columnIndex: activeColumnIndex,
      width: originWidth,
      height: originHeight,
      totalHeight: originHeight,
      scrollTop: 0,
      scrollEnable: false,
    };
  }, [activeColumnIndex, activeRowIndex, coordInstance, theme, getCellContent, real2RowIndex]);

  const scrollEnable =
    hoverRegionType !== RegionType.None &&
    !(hoverRegionType === RegionType.ActiveCell && activeCellBound?.scrollEnable);

  const assetLoadRafRef = useRef<number | null>(null);
  const scheduleAssetRedraw = useCallback(() => {
    if (assetLoadRafRef.current != null) return;
    assetLoadRafRef.current = requestAnimationFrame(() => {
      assetLoadRafRef.current = null;
      bumpForceRender();
    });
  }, []);

  useEffect(() => {
    return () => {
      if (assetLoadRafRef.current != null) {
        cancelAnimationFrame(assetLoadRafRef.current);
        assetLoadRafRef.current = null;
      }
    };
  }, []);

  const spriteManager = useMemo(
    () => new SpriteManager(customIcons, scheduleAssetRedraw),
    [customIcons, scheduleAssetRedraw]
  );

  const imageManager = useMemo<ImageManager>(() => {
    const imgManager = new ImageManager();
    imgManager.setCallback(scheduleAssetRedraw);
    return imgManager;
  }, [scheduleAssetRedraw]);

  const scrollTo = useCallback((sl?: number, st?: number) => {
    scrollerRef.current?.scrollTo(sl, st);
  }, []);

  const scrollBy = useCallback((deltaX: number, deltaY: number) => {
    scrollerRef.current?.scrollBy(deltaX, deltaY);
  }, []);

  const scrollToItem = useCallback(
    (position: [columnIndex: number, rowIndex: number]) => {
      try {
        const {
          containerHeight,
          containerWidth,
          freezeRegionWidth,
          freezeColumnCount,
          rowInitSize,
        } = coordInstance;
        const { scrollTop, scrollLeft } = scrollState;
        const [columnIndex, _rowIndex] = position;
        const rowIndex = real2RowIndex(_rowIndex);
        const next = computeScrollToItem({
          columnIndex,
          rowIndex,
          scrollLeft,
          scrollTop,
          containerWidth,
          containerHeight,
          freezeRegionWidth,
          freezeColumnCount,
          rowInitSize,
          columnOffset: coordInstance.getColumnOffset(columnIndex),
          columnWidth: coordInstance.getColumnWidth(columnIndex),
          rowOffset: coordInstance.getRowOffset(rowIndex),
          rowHeight: coordInstance.getRowHeight(rowIndex),
          cellScrollBuffer,
        });
        if (next.scrollLeft != null || next.scrollTop != null) {
          scrollTo(next.scrollLeft, next.scrollTop);
        }
      } catch (error) {
        console.error('scrollToItem error', error);
      }
    },
    [coordInstance, scrollState, scrollTo, real2RowIndex, cellScrollBuffer]
  );

  const onMouseDown = () => {
    containerRef.current?.focus();
  };

  const { rowInitSize } = coordInstance;

  return (
    <div className="size-full" style={{ width: '100%', height: '100%', ...style }} ref={ref}>
      <div
        data-t-grid-container
        ref={containerRef}
        tabIndex={0}
        className="relative outline-none"
        style={{ position: 'relative', outline: 'none' }}
        onMouseDown={onMouseDown}
      >
        {isTouchDevice ? (
          <Suspense fallback={null}>
            <LazyTouchLayer
              width={width}
              height={height}
              theme={theme}
              columns={columns}
              commentCountMap={commentCountMap}
              mouseState={mouseState}
              scrollState={scrollState}
              rowControls={rowControls}
              collaborators={collaborators}
              searchCursor={searchCursor}
              searchHitIndex={searchHitIndex}
              prefillingRowIndexes={prefillingRowIndexes}
              imageManager={imageManager}
              spriteManager={spriteManager}
              coordInstance={coordInstance}
              columnStatistics={columnStatistics}
              collapsedGroupIds={collapsedGroupIds}
              columnHeaderHeight={columnHeaderHeight}
              forceRenderFlag={forceRenderFlag}
              rowIndexVisible={rowIndexVisible}
              groupCollection={groupCollection}
              getLinearRow={getLinearRow}
              real2RowIndex={real2RowIndex}
              getCellContent={getCellContent}
              getRowTreeData={getRowTreeData}
              setMouseState={setMouseState}
              setActiveCell={setActiveCell}
              scrollToItem={scrollToItem}
              onDelete={onDelete}
              onRowAppend={onRowAppend}
              onRowExpand={onRowExpand}
              onCommentCountClick={onCommentCountClick}
              onTreeToggle={onTreeToggle}
              onInsertSubRecord={onInsertSubRecord}
              onCellEdited={onCellEdited}
              onContextMenu={onContextMenu}
              onColumnAppend={onColumnAppend}
              onColumnHeaderClick={onColumnHeaderClick}
              onColumnStatisticClick={onColumnStatisticClick}
              onCollapsedGroupChanged={onCollapsedGroupChanged}
              onSelectionChanged={onSelectionChanged}
            />
          </Suspense>
        ) : (
          <InteractionLayer
            ref={interactionLayerRef}
            gridContainerRef={containerRef}
            width={width}
            height={height}
            theme={theme}
            columns={columns}
            commentCountMap={commentCountMap}
            draggable={draggable}
            selectable={selectable}
            collaborators={collaborators}
            searchCursor={searchCursor}
            searchHitIndex={searchHitIndex}
            editorShiftEnterHint={editorShiftEnterHint}
            editorSelectSearchPlaceholder={editorSelectSearchPlaceholder}
            editorSelectSearchPlaceholderEmpty={editorSelectSearchPlaceholderEmpty}
            editorSelectNoResults={editorSelectNoResults}
            editorSelectEmptyHint={editorSelectEmptyHint}
            editorSelectAddOption={editorSelectAddOption}
            editorSelectDoneLabel={editorSelectDoneLabel}
            prefillingRowIndexes={prefillingRowIndexes}
            rowControls={rowControls}
            imageManager={imageManager}
            spriteManager={spriteManager}
            coordInstance={coordInstance}
            columnStatistics={columnStatistics}
            collapsedGroupIds={collapsedGroupIds}
            columnHeaderHeight={columnHeaderHeight}
            isMultiSelectionEnable={isMultiSelectionEnable}
            activeCell={activeCell}
            mouseState={mouseState}
            scrollState={scrollState}
            activeCellBound={activeCellBound}
            forceRenderFlag={forceRenderFlag}
            rowIndexVisible={rowIndexVisible}
            groupCollection={groupCollection}
            getLinearRow={getLinearRow}
            real2RowIndex={real2RowIndex}
            getCellContent={getCellContent}
            getRowTreeData={getRowTreeData}
            setMouseState={setMouseState}
            setActiveCell={setActiveCell}
            scrollToItem={scrollToItem}
            scrollBy={scrollBy}
            onUndo={onUndo}
            onRedo={onRedo}
            onCopy={onCopy}
            onPaste={onPaste}
            onDelete={onDelete}
            onDragStart={onDragStart}
            onRowAppend={onRowAppend}
            onRowExpand={onRowExpand}
            onCommentCountClick={onCommentCountClick}
            onTreeToggle={onTreeToggle}
            onInsertSubRecord={onInsertSubRecord}
            onRowOrdered={onRowOrdered}
            onCellEdited={onCellEdited}
            onCellDblClick={onCellDblClick}
            onContextMenu={onContextMenu}
            onColumnAppend={onColumnAppend}
            onColumnResize={onColumnResize}
            onColumnOrdered={onColumnOrdered}
            onColumnHeaderClick={onColumnHeaderClick}
            onColumnStatisticClick={onColumnStatisticClick}
            onColumnHeaderDblClick={onColumnHeaderDblClick}
            onColumnHeaderMenuClick={onColumnHeaderMenuClick}
            onCollapsedGroupChanged={onCollapsedGroupChanged}
            onGroupHeaderContextMenu={onGroupHeaderContextMenu}
            onSelectionChanged={onSelectionChanged}
            onColumnFreeze={onColumnFreeze}
            onItemHovered={onItemHovered}
            onItemClick={onItemClick}
            onFillSelection={onFillSelection}
            onEditingStopped={onEditingStopped}
          />
        )}
      </div>

      <InfiniteScroller
        ref={scrollerRef}
        coordInstance={coordInstance}
        top={rowInitSize}
        left={columnInitSize}
        containerWidth={width}
        containerHeight={containerHeight}
        scrollWidth={totalWidth}
        scrollHeight={totalHeight}
        smoothScrollX={smoothScrollX}
        smoothScrollY={smoothScrollY}
        scrollBarVisible={scrollBarVisible}
        containerRef={containerRef}
        scrollState={scrollState}
        scrollEnable={scrollEnable}
        getLinearRow={getLinearRow}
        setScrollState={setScrollState}
        onScrollChanged={onScrollChanged}
        onVisibleRegionChanged={onVisibleRegionChanged}
      />

      <LoadingIndicator
        cellLoadings={cellLoadings}
        columnLoadings={columnLoadings}
        coordInstance={coordInstance}
        scrollState={scrollState}
        real2RowIndex={real2RowIndex}
      />

      {cellErrors.length > 0 && (
        <Suspense fallback={null}>
          <LazyErrorIndicator
            cellErrors={cellErrors}
            coordInstance={coordInstance}
            scrollState={scrollState}
          />
        </Suspense>
      )}
    </div>
  );
};

export const Grid = forwardRef(GridBase);
