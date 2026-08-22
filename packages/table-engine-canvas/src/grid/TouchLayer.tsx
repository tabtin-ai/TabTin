import type { Dispatch, FC, SetStateAction } from 'react';
import { useRef } from 'react';
import ReactHammer from 'react-hammerjs';
import {
  DEFAULT_COLUMN_RESIZE_STATE,
  DEFAULT_DRAG_STATE,
  DEFAULT_FREEZE_COLUMN_STATE,
  DEFAULT_MOUSE_STATE,
  GRID_DEFAULT,
  type IGridTheme,
} from './configs';
import type { IGridProps } from './Grid';
import { useSelection, useVisibleRegion } from './hooks';
import { LinearRowType, RegionType, SelectionRegionType } from './interface';
import type {
  ICellItem,
  ICellRegionWithData,
  IInnerCell,
  ILinearRow,
  IMouseState,
  IRange,
  IRowControlItem,
  IScrollState,
} from './interface';
import type { CoordinateManager, ImageManager, SpriteManager } from './managers';
import { emptySelection } from './managers';
import { CellRegionType, getCellRenderer } from './renderers';
import { RenderLayer } from './RenderLayer';
import { getColumnStatisticData, inRange, isAppendColumnPointerHit } from './utils';
import { getCommentCountBounds, resolveCellCommentCount } from './utils/commentCount';

export interface ITouchLayerProps
  extends Omit<
    IGridProps,
    | 'style'
    | 'rowCount'
    | 'rowHeight'
    | 'smoothScrollX'
    | 'smoothScrollY'
    | 'freezeColumnCount'
    | 'onCopy'
    | 'onPaste'
    | 'onRowOrdered'
    | 'onColumnResize'
    | 'onColumnOrdered'
    | 'onColumnHeaderDblClick'
    | 'onColumnHeaderMenuClick'
    | 'onVisibleRegionChanged'
  > {
  theme: IGridTheme;
  width: number;
  height: number;
  forceRenderFlag: string | number;
  mouseState: IMouseState;
  scrollState: IScrollState;
  imageManager: ImageManager;
  spriteManager: SpriteManager;
  coordInstance: CoordinateManager;
  rowControls: IRowControlItem[];
  real2RowIndex: (index: number) => number;
  getLinearRow: (index: number) => ILinearRow;
  setMouseState: Dispatch<SetStateAction<IMouseState>>;
  setActiveCell: Dispatch<SetStateAction<ICellItem | null>>;
  scrollToItem?: (position: [columnIndex: number, rowIndex: number]) => void;
}

const { columnAppendBtnWidth, columnHeadHeight } = GRID_DEFAULT;

export const TouchLayer: FC<ITouchLayerProps> = (props) => {
  const {
    width,
    height,
    theme,
    columns,
    commentCountMap,
    columnStatistics,
    coordInstance,
    scrollState,
    collaborators,
    searchCursor,
    prefillingRowIndexes,
    mouseState,
    rowControls,
    imageManager,
    spriteManager,
    forceRenderFlag,
    rowIndexVisible,
    groupCollection,
    collapsedGroupIds,
    columnHeaderHeight,
    getCellContent,
    getLinearRow,
    real2RowIndex,
    setActiveCell,
    setMouseState,
    scrollToItem,
    onRowAppend,
    onRowExpand,
    onCommentCountClick,
    onColumnAppend,
    onColumnHeaderClick,
    onSelectionChanged,
    onColumnStatisticClick,
    onCollapsedGroupChanged,
  } = props;
  const hasAppendRow = onRowAppend != null;
  const hasAppendColumn = onColumnAppend != null;
  const { scrollTop, scrollLeft } = scrollState;
  const {
    totalHeight,
    containerHeight,
    freezeRegionWidth,
    totalWidth,
    columnInitSize,
    columnCount,
    rowCount,
    rowInitSize,
  } = coordInstance;

  const containerRef = useRef<HTMLDivElement | null>(null);

  const visibleRegion = useVisibleRegion(coordInstance, scrollState, forceRenderFlag);

  const { selection, setSelection } = useSelection({
    coordInstance,
    getLinearRow,
    setActiveCell,
    onSelectionChanged,
  });

  const getRangeByPosition = (x: number, y: number) => {
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

    return [columnIndex, rowIndex];
  };

  // Highlight the clicked area to enhance the user experience
  const onTapStyleEffect = (mouseState: IMouseState) => {
    setMouseState(mouseState);
    setTimeout(() => setMouseState(DEFAULT_MOUSE_STATE), 500);
  };

  // eslint-disable-next-line sonarjs/cognitive-complexity
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const onTap = (e: any) => {
    const pointerEvent = e.changedPointers[0];
    const containerRect = containerRef.current?.getBoundingClientRect();
    const x =
      typeof pointerEvent?.offsetX === 'number'
        ? pointerEvent.offsetX
        : typeof pointerEvent?.layerX === 'number'
          ? pointerEvent.layerX
          : typeof pointerEvent?.clientX === 'number' && containerRect
            ? pointerEvent.clientX - containerRect.left
            : -Infinity;
    const y =
      typeof pointerEvent?.offsetY === 'number'
        ? pointerEvent.offsetY
        : typeof pointerEvent?.layerY === 'number'
          ? pointerEvent.layerY
          : typeof pointerEvent?.clientY === 'number' && containerRect
            ? pointerEvent.clientY - containerRect.top
            : -Infinity;
    const [columnIndex, rowIndex] = getRangeByPosition(x, y);
    const posInfo = { x, y, rowIndex, columnIndex, isOutOfBounds: false };

    // Tap the column statistic
    const statisticBoundData = getColumnStatisticData({
      columnStatistics,
      scrollState,
      coordInstance,
      getLinearRow,
      position: { x, y, rowIndex, columnIndex },
      height,
    });
    if (statisticBoundData != null) {
      const { type, ...rest } = statisticBoundData;
      return onColumnStatisticClick?.(columnIndex, { ...rest });
    }

    // Tap the column header
    if (rowIndex === -1 && columnIndex > -1) {
      onTapStyleEffect({ ...posInfo, type: RegionType.ColumnHeader });
      return onColumnHeaderClick?.(columnIndex, {
        x: coordInstance.getColumnRelativeOffset(columnIndex, scrollLeft),
        y: 0,
        width: coordInstance.getColumnWidth(columnIndex),
        height: columnHeadHeight,
      });
    }

    // Tap the append column button
    if (hasAppendColumn && rowIndex >= -1 && columnIndex === -2) {
      onTapStyleEffect({ ...posInfo, type: RegionType.AppendColumn });
      return onColumnAppend?.();
    }

    // Tap the append row button
    if (
      hasAppendRow &&
      rowIndex >= 0 &&
      columnIndex >= -1 &&
      getLinearRow(rowIndex).type === LinearRowType.Append
    ) {
      onTapStyleEffect({ ...posInfo, type: RegionType.AppendRow });
      const linearRow = getLinearRow(rowIndex);
      return onRowAppend?.({
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
    }

    // Tap the row
    if (rowIndex >= 0) {
      const linearRow = getLinearRow(rowIndex);

      if (linearRow.type === LinearRowType.Group && x < rowInitSize) {
        const { id } = linearRow;
        if (collapsedGroupIds == null) return onCollapsedGroupChanged?.(new Set([id]));
        if (collapsedGroupIds.has(id)) {
          const newCollapsedGroupIds = new Set(collapsedGroupIds);
          newCollapsedGroupIds.delete(id);
          return onCollapsedGroupChanged?.(newCollapsedGroupIds);
        }
        return onCollapsedGroupChanged?.(new Set([...collapsedGroupIds, id]));
      }

      if (scrollTop + y > totalHeight && !inRange(y, containerHeight, height)) {
        return;
      }

      if (columnIndex >= 0 && columns[columnIndex]?.isPrimary && linearRow.type === LinearRowType.Row) {
        const cell = getCellContent([columnIndex, linearRow.realIndex]);
        const count = resolveCellCommentCount(cell, columns[columnIndex], commentCountMap);
        const bounds = getCommentCountBounds({
          x: coordInstance.getColumnRelativeOffset(columnIndex, scrollLeft),
          y: coordInstance.getRowOffset(rowIndex) - scrollTop,
          width: coordInstance.getColumnWidth(columnIndex),
          height: coordInstance.getRowHeight(rowIndex),
        });
        if (
          count &&
          inRange(x, bounds.x, bounds.x + bounds.width) &&
          inRange(y, bounds.y, bounds.y + bounds.height)
        ) {
          onTapStyleEffect({ ...posInfo, type: RegionType.CommentCount });
          return onCommentCountClick?.(linearRow.realIndex);
        }
      }

      let isPreview = false;

      // Tap the cell
      if (columnIndex >= 0) {
        const cell = getCellContent([columnIndex, rowIndex]) as IInnerCell;
        const cellRenderer = getCellRenderer(cell.type);
        const onCellClick = cellRenderer.onClick;

        if (onCellClick) {
          const offsetX = coordInstance.getColumnOffset(columnIndex);
          onCellClick(
            cell as never,
            {
              width: coordInstance.getColumnWidth(columnIndex),
              height: coordInstance.getRowHeight(rowIndex),
              theme,
              hoverCellPosition: [
                columnIndex < coordInstance.freezeColumnCount
                  ? x - offsetX
                  : x - offsetX + scrollLeft,
                y - coordInstance.getRowOffset(rowIndex) + scrollTop,
              ],
              activeCellBound: null,
              isActive: false,
            },
            (cellRegion: ICellRegionWithData) => {
              const { type } = cellRegion;

              if (type === CellRegionType.Preview) {
                isPreview = true;
              }
            }
          );
        }

        if (isPreview) return;
      }

      const range = [0, rowIndex];
      setActiveCell(range as IRange);
      setSelection(selection.set(SelectionRegionType.Cells, [range, range] as IRange[]));
      scrollToItem?.([range[0], range[1]]);
      onTapStyleEffect({ ...posInfo, type: RegionType.Cell });
      onRowExpand?.(linearRow.realIndex);
    }
  };

  return (
    <ReactHammer onTap={onTap}>
      <div ref={containerRef} style={{ width, height }}>
        <RenderLayer
          theme={theme}
          width={width}
          height={height}
          columns={columns}
          columnStatistics={columnStatistics}
          collaborators={collaborators}
          searchCursor={searchCursor}
          prefillingRowIndexes={prefillingRowIndexes}
          coordInstance={coordInstance}
          rowControls={rowControls}
          imageManager={imageManager}
          spriteManager={spriteManager}
          visibleRegion={visibleRegion}
          rowIndexVisible={rowIndexVisible}
          groupCollection={groupCollection}
          activeCell={null}
          activeCellBound={null}
          mouseState={mouseState}
          scrollState={scrollState}
          dragState={DEFAULT_DRAG_STATE}
          selection={emptySelection}
          isSelecting={false}
          forceRenderFlag={forceRenderFlag}
          columnHeaderHeight={columnHeaderHeight}
          columnFreezeState={DEFAULT_FREEZE_COLUMN_STATE}
          columnResizeState={DEFAULT_COLUMN_RESIZE_STATE}
          hoverCellPosition={null}
          hoveredColumnResizeIndex={-1}
          isRowAppendEnable={hasAppendRow}
          isColumnAppendEnable={hasAppendColumn}
          getCellContent={getCellContent}
          real2RowIndex={real2RowIndex}
          getLinearRow={getLinearRow}
        />
      </div>
    </ReactHammer>
  );
};
