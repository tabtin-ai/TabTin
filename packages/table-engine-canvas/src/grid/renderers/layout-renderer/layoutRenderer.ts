import { isEqual, groupBy } from 'lodash';
import type { IGridTheme } from '../../configs';
import { GRID_DEFAULT, ROW_RELATED_REGIONS } from '../../configs';
import type { IVisibleRegion } from '../../hooks';
import { getDropTargetIndex, getRowDropTarget } from '../../hooks';
import type { ICellItem, ICell, IRectangle, ICollaborator, ILinearRow } from '../../interface';
import { DragRegionType, LinearRowType, RegionType, RowControlType } from '../../interface';
import { GridInnerIcon } from '../../managers';
import {
  checkIfRowOrCellActive,
  checkIfRowOrCellSelected,
  calculateMaxRange,
  hexToRGBA,
  getAppendColumnScreenX,
} from '../../utils';
import { contractColorForTheme } from '../../shims/gridCoreCompat';
import {
  getCommentCountBounds,
  getRowDetailButtonBounds,
  resolveCellCommentCount,
} from '../../utils/commentCount';
import type { ISingleLineTextProps } from '../base-renderer';
import {
  drawCheckbox,
  drawLine,
  drawMultiLineText,
  drawRect,
  drawRoundPoly,
  drawSingleLineText,
} from '../base-renderer';
import { getCellRenderer, getCellScrollState } from '../cell-renderer';
import type {
  ICacheDrawerProps,
  ICellDrawerProps,
  IGroupRowDrawerProps,
  IFieldHeadDrawerProps,
  IGridHeaderDrawerProps,
  ILayoutDrawerProps,
  IRowHeaderDrawerProps,
  IGroupRowHeaderDrawerProps,
  IAppendRowDrawerProps,
  IGroupStatisticDrawerProps,
} from './interface';
import { RenderRegion, DividerRegion } from './interface';

const spriteIconMap = {
  [RowControlType.Drag]: GridInnerIcon.Drag,
  [RowControlType.Expand]: GridInnerIcon.Detail,
};

const {
  rowHeight: defaultRowHeight,
  fillHandlerSize,
  cellTextLineHeight,
  rowHeadIconPaddingTop,
  columnStatisticHeight,
  columnHeadHeight,
  columnHeadPadding,
  columnHeadMenuSize,
  columnAppendBtnWidth,
  columnResizeHandlerWidth,
  columnResizeHandlerPaddingTop,
  cellScrollBarWidth,
  cellScrollBarPaddingX,
  cellScrollBarPaddingY,
  cellVerticalPaddingSM,
  cellVerticalPaddingMD,
  cellHorizontalPadding,
  columnFreezeHandlerWidth,
  columnFreezeHandlerHeight,
} = GRID_DEFAULT;

const PREFILLING_ROW_HIGHLIGHT_COLOR_LIGHT = '#8B5CF6';
const PREFILLING_ROW_HIGHLIGHT_COLOR_DARK = '#6D28D9';

/** Pixels per sub-record tree depth level for indentation */
export const TREE_INDENT_PER_LEVEL = 20;

export const drawCellContent = (ctx: CanvasRenderingContext2D, props: ICellDrawerProps) => {
  const {
    x,
    y,
    width,
    height,
    theme,
    rowIndex,
    columnIndex,
    imageManager,
    spriteManager,
    isActive,
    hoverCellPosition,
    getCellContent,
    treeIndent = 0,
    treeDepth,
    treeHasChildren,
    treeExpanded,
    commentCount,
  } = props;

  // Draw tree expand/collapse arrow in the indent area (first column only)
  if (treeIndent && typeof treeDepth === 'number' && treeHasChildren) {
    const arrowX = x + treeDepth * TREE_INDENT_PER_LEVEL + TREE_INDENT_PER_LEVEL / 2;
    const arrowY = y + height / 2;
    drawTreeExpandArrow(ctx, {
      x: arrowX,
      y: arrowY,
      expanded: !!treeExpanded,
      color: theme.iconFgCommon,
    });
  }

  // Tree hierarchy guide lines for child rows (vertical dotted lines at each ancestor level)
  if (treeIndent && typeof treeDepth === 'number' && treeDepth > 0) {
    ctx.save();
    ctx.strokeStyle = theme.cellLineColor;
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 2]);
    for (let d = 0; d < treeDepth; d++) {
      const guideX = x + d * TREE_INDENT_PER_LEVEL + TREE_INDENT_PER_LEVEL / 2;
      ctx.beginPath();
      ctx.moveTo(guideX, y);
      ctx.lineTo(guideX, y + height);
      ctx.stroke();
    }
    ctx.setLineDash([]);
    ctx.restore();
  }

  const indentedX = x + treeIndent;
  const commentCountInset = commentCount ? 44 : 0;
  const indentedWidth = Math.max(width - treeIndent - commentCountInset, 0);

  const cell = props.cell ?? getCellContent([columnIndex, rowIndex]);
  const cellRenderer = getCellRenderer(cell.type);
  cellRenderer.draw(cell as never, {
    ctx,
    theme,
    rect: {
      x: indentedX,
      y,
      width: indentedWidth,
      height,
    },
    rowIndex,
    columnIndex,
    imageManager,
    spriteManager,
    hoverCellPosition,
    isActive,
  });
  if (cell.hidden) {
    spriteManager.drawSprite(ctx, {
      sprite: GridInnerIcon.EyeOff,
      x: x + width - 14,
      y: y - 1,
      size: 12,
      theme,
      colors: [theme.cellLineColorActived, theme.cellBg],
    });
  } else if (isActive && cell.locked) {
    spriteManager.drawSprite(ctx, {
      sprite: GridInnerIcon.Lock,
      x: x + width - 13,
      y: y + 1,
      size: 12,
      theme,
      colors: [theme.cellLineColorActived, theme.cellBg],
    });
  }
  if (commentCount) {
    const bounds = getCommentCountBounds({ x, y, width, height });
    drawCommentCount(ctx, { x: bounds.x, y: bounds.y, count: commentCount, theme });
  }
};

// eslint-disable-next-line sonarjs/cognitive-complexity
export const calcCells = (props: ILayoutDrawerProps, renderRegion: RenderRegion) => {
  const {
    coordInstance,
    visibleRegion,
    activeCell,
    mouseState,
    scrollState,
    selection,
    isSelecting,
    rowControls,
    rowIndexVisible,
    hoverCellPosition,
    theme,
    columns,
    commentCountMap,
    imageManager,
    spriteManager,
    groupCollection,
    getLinearRow,
    getCellContent,
    getRowTreeData,
  } = props;
  const {
    startRowIndex,
    stopRowIndex,
    startColumnIndex: originStartColumnIndex,
    stopColumnIndex: originStopColumnIndex,
  } = visibleRegion;
  const { freezeColumnCount, columnInitSize, totalWidth, rowCount } = coordInstance;
  const { isRowSelection, isColumnSelection } = selection;
  const { scrollLeft, scrollTop } = scrollState;
  const {
    columnIndex: hoverColumnIndex,
    rowIndex: hoverRowIndex,
    type: hoverRegionType,
    isOutOfBounds,
  } = mouseState;

  const cellPropList: ICellDrawerProps[] = [];
  const rowHeaderPropList: IRowHeaderDrawerProps[] = [];
  const groupRowList: IGroupRowDrawerProps[] = [];
  const groupRowHeaderList: IGroupRowHeaderDrawerProps[] = [];
  const appendRowList: IAppendRowDrawerProps[] = [];

  if (!rowCount) {
    return {
      cellPropList,
      rowHeaderPropList,
      groupRowList,
      groupRowHeaderList,
      appendRowList,
    };
  }

  const isFreezeRegion = renderRegion === RenderRegion.Freeze;
  const startColumnIndex = isFreezeRegion ? 0 : Math.max(freezeColumnCount, originStartColumnIndex);
  const stopColumnIndex = isFreezeRegion
    ? Math.max(freezeColumnCount - 1, 0)
    : originStopColumnIndex;
  const isFreezeWithoutColumns = isFreezeRegion && freezeColumnCount === 0;

  for (let columnIndex = startColumnIndex; columnIndex <= stopColumnIndex; columnIndex++) {
    const column = columns[columnIndex];
    const x = coordInstance.getColumnRelativeOffset(columnIndex, scrollLeft);
    const columnWidth = coordInstance.getColumnWidth(columnIndex);
    const isColumnActive = isColumnSelection && selection.includes([columnIndex, columnIndex]);
    const isFirstColumn = columnIndex === 0;
    const isColumnHovered = hoverColumnIndex === columnIndex;
    const finalTheme = column?.customTheme ? { ...theme, ...column.customTheme } : theme;
    const { cellBg, cellBgHovered, cellBgSelected } = finalTheme;

    for (let rowIndex = startRowIndex; rowIndex <= stopRowIndex; rowIndex++) {
      const linearRow = getLinearRow(rowIndex);
      const { type: linearRowType } = linearRow;
      const rowHeight = coordInstance.getRowHeight(rowIndex);
      const y = coordInstance.getRowOffset(rowIndex) - scrollTop;

      const cell = getCellContent([columnIndex, linearRow.realIndex]);
      if (linearRowType === LinearRowType.Group) {
        const { depth, value, isCollapsed, realIndex } = linearRow;
        if (isFirstColumn) {
          groupRowHeaderList.push({
            x: 0.5,
            y,
            width: columnInitSize,
            height: rowHeight,
            spriteManager,
            depth,
            theme,
            isCollapsed,
            groupCollection,
          });
        }

        if (isFreezeWithoutColumns) continue;

        groupRowList.push({
          x: x + 0.5,
          y,
          width: columnWidth,
          height: rowHeight,
          columnIndex,
          rowIndex: realIndex,
          depth,
          theme,
          value,
          isHover: false,
          isCollapsed,
          imageManager,
          spriteManager,
          groupCollection,
        });
        continue;
      }

      if (linearRowType === LinearRowType.Append) {
        if (isFirstColumn) {
          const isHover = hoverRegionType === RegionType.AppendRow && hoverRowIndex === rowIndex;

          appendRowList.push({
            x: 0.5,
            y: y + 0.5,
            width: totalWidth - scrollLeft,
            height: rowHeight,
            theme,
            isHover,
            spriteManager,
            coordInstance,
          });
        }
        continue;
      }

      const { displayIndex, realIndex: realRowIndex } = linearRow;
      const isRowHovered =
        !isOutOfBounds &&
        !isSelecting &&
        ROW_RELATED_REGIONS.has(hoverRegionType) &&
        rowIndex === hoverRowIndex;
      const { isCellActive, isRowActive } = checkIfRowOrCellActive(
        activeCell,
        realRowIndex,
        columnIndex
      );
      const { isRowSelected, isCellSelected } = checkIfRowOrCellSelected(
        selection,
        realRowIndex,
        columnIndex
      );
      let fill;

      if (isCellSelected || isRowSelected || isColumnActive) {
        fill = cellBgSelected;
      } else if (isRowHovered || isRowActive) {
        fill = cellBgHovered;
      }

      let currentTreeIndent = 0;
      let treeData: ReturnType<NonNullable<typeof getRowTreeData>> | undefined;
      if (isFirstColumn) {
        treeData = getRowTreeData?.(realRowIndex);
        const isInTreeMode = typeof treeData?.treeDepth === 'number';
        if (isInTreeMode) {
          currentTreeIndent = (treeData!.treeDepth! + 1) * TREE_INDENT_PER_LEVEL;
        }

        // In tree mode: root rows show rootDisplayIndex, child rows show empty
        const resolvedDisplayIndex =
          treeData && typeof treeData.treeDepth === 'number'
            ? treeData.treeDepth === 0 && treeData.rootDisplayIndex != null
              ? String(treeData.rootDisplayIndex)
              : ''
            : String(displayIndex);

        rowHeaderPropList.push({
          x: 0.5,
          y: y + 0.5,
          width: columnInitSize + 0.5,
          height: rowHeight,
          displayIndex: resolvedDisplayIndex,
          isHover: isRowHovered || isRowActive,
          isChecked: isRowSelection && isRowSelected,
          rowIndexVisible,
          rowControls,
          theme,
          spriteManager,
          treeDepth: treeData?.treeDepth,
        });
      }

      if (isFreezeWithoutColumns) continue;

      cellPropList.push({
        x: x + 0.5,
        y: y + 0.5,
        width: columnWidth,
        height: rowHeight,
        rowIndex: realRowIndex,
        columnIndex,
        hoverCellPosition: isColumnHovered && isRowHovered ? hoverCellPosition : null,
        getCellContent,
        imageManager,
        spriteManager,
        theme: finalTheme,
        fill: isCellActive ? cellBg : fill ?? cellBg,
        treeIndent: isFirstColumn ? currentTreeIndent : undefined,
        treeDepth: isFirstColumn ? treeData?.treeDepth : undefined,
        treeHasChildren: isFirstColumn ? treeData?.treeHasChildren : undefined,
        treeExpanded: isFirstColumn ? treeData?.treeExpanded : undefined,
        cell,
        commentCount: column?.isPrimary
          ? resolveCellCommentCount(cell, column, commentCountMap)?.count
          : undefined,
      });
    }
  }

  return {
    cellPropList,
    rowHeaderPropList,
    groupRowList,
    groupRowHeaderList,
    appendRowList,
  };
};

export const drawClipRegion = (
  ctx: CanvasRenderingContext2D,
  clipRect: IRectangle,
  draw: (ctx: CanvasRenderingContext2D) => void
) => {
  const { x, y, width, height } = clipRect;
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, width, height);
  ctx.clip();

  draw(ctx);

  ctx.restore();
};

const drawPrefillingRowHighlight = (
  ctx: CanvasRenderingContext2D,
  props: ILayoutDrawerProps
) => {
  const { prefillingRowIndexes, coordInstance, scrollState, visibleRegion, getLinearRow } = props;
  if (!prefillingRowIndexes?.length) {
    return;
  }

  const prefillingRowSet = new Set(
    prefillingRowIndexes.filter(
      (index): index is number => Number.isInteger(index) && index >= 0
    )
  );
  if (!prefillingRowSet.size) {
    return;
  }

  const { startRowIndex, stopRowIndex } = visibleRegion;
  const { scrollTop } = scrollState;
  const { rowInitSize, containerWidth, containerHeight } = coordInstance;
  const borderColor =
    props.theme.themeKey === 'dark'
      ? PREFILLING_ROW_HIGHLIGHT_COLOR_DARK
      : PREFILLING_ROW_HIGHLIGHT_COLOR_LIGHT;

  drawClipRegion(
    ctx,
    {
      x: 0,
      y: rowInitSize + 1,
      width: containerWidth,
      height: containerHeight - rowInitSize - 1,
    },
    (clipCtx) => {
      for (let linearRowIndex = startRowIndex; linearRowIndex <= stopRowIndex; linearRowIndex++) {
        const linearRow = getLinearRow(linearRowIndex);
        if (linearRow.type !== LinearRowType.Row || !prefillingRowSet.has(linearRow.realIndex)) {
          continue;
        }

        const y = coordInstance.getRowOffset(linearRowIndex) - scrollTop;
        const rowHeight = coordInstance.getRowHeight(linearRowIndex);
        if (!Number.isFinite(y) || !Number.isFinite(rowHeight) || rowHeight <= 0) {
          continue;
        }

        drawRect(clipCtx, {
          x: 0.5,
          y: y + 0.5,
          width: Math.max(0, containerWidth - 1),
          height: 2,
          fill: borderColor,
        });
        drawRect(clipCtx, {
          x: 0.5,
          y: y + rowHeight - 1.5,
          width: Math.max(0, containerWidth - 1),
          height: 2,
          fill: borderColor,
        });
      }
    }
  );
};

/**
 * Merged variant of calcCells that traverses rows once and produces both
 * freeze-region and other-region results, avoiding duplicate getLinearRow /
 * getCellContent calls for the same row.
 */
// eslint-disable-next-line sonarjs/cognitive-complexity
const calcCellsMerged = (props: ILayoutDrawerProps) => {
  const {
    coordInstance,
    visibleRegion,
    activeCell,
    mouseState,
    scrollState,
    selection,
    isSelecting,
    rowControls,
    rowIndexVisible,
    hoverCellPosition,
    theme,
    columns,
    commentCountMap,
    imageManager,
    spriteManager,
    groupCollection,
    getLinearRow,
    getCellContent,
    getRowTreeData,
  } = props;
  const {
    startRowIndex,
    stopRowIndex,
    startColumnIndex: originStartColumnIndex,
    stopColumnIndex: originStopColumnIndex,
  } = visibleRegion;
  const { freezeColumnCount, columnInitSize, totalWidth, rowCount } = coordInstance;
  const { isRowSelection, isColumnSelection } = selection;
  const { scrollLeft, scrollTop } = scrollState;
  const {
    columnIndex: hoverColumnIndex,
    rowIndex: hoverRowIndex,
    type: hoverRegionType,
    isOutOfBounds,
  } = mouseState;

  const freezeCellPropList: ICellDrawerProps[] = [];
  const otherCellPropList: ICellDrawerProps[] = [];
  const rowHeaderPropList: IRowHeaderDrawerProps[] = [];
  const freezeGroupRowList: IGroupRowDrawerProps[] = [];
  const otherGroupRowList: IGroupRowDrawerProps[] = [];
  const groupRowHeaderList: IGroupRowHeaderDrawerProps[] = [];
  const appendRowList: IAppendRowDrawerProps[] = [];

  if (!rowCount) {
    return {
      freezeCellPropList,
      otherCellPropList,
      rowHeaderPropList,
      freezeGroupRowList,
      otherGroupRowList,
      groupRowHeaderList,
      appendRowList,
    };
  }

  const freezeStartCol = 0;
  const freezeStopCol = Math.max(freezeColumnCount - 1, 0);
  const hasFreezeColumns = freezeColumnCount > 0;
  const otherStartCol = Math.max(freezeColumnCount, originStartColumnIndex);
  const otherStopCol = originStopColumnIndex;

  for (let rowIndex = startRowIndex; rowIndex <= stopRowIndex; rowIndex++) {
    const linearRow = getLinearRow(rowIndex);
    const { type: linearRowType } = linearRow;
    const rowHeight = coordInstance.getRowHeight(rowIndex);
    const y = coordInstance.getRowOffset(rowIndex) - scrollTop;

    if (linearRowType === LinearRowType.Append) {
      const isHover = hoverRegionType === RegionType.AppendRow && hoverRowIndex === rowIndex;
      appendRowList.push({
        x: 0.5,
        y: y + 0.5,
        width: totalWidth - scrollLeft,
        height: rowHeight,
        theme,
        isHover,
        spriteManager,
        coordInstance,
      });
      continue;
    }

    if (linearRowType === LinearRowType.Group) {
      const { depth, value, isCollapsed, realIndex } = linearRow;
      groupRowHeaderList.push({
        x: 0.5,
        y,
        width: columnInitSize,
        height: rowHeight,
        spriteManager,
        depth,
        theme,
        isCollapsed,
        groupCollection,
      });

      const emitGroupRow = (columnIndex: number, target: IGroupRowDrawerProps[]) => {
        const cx = coordInstance.getColumnRelativeOffset(columnIndex, scrollLeft);
        const cw = coordInstance.getColumnWidth(columnIndex);
        target.push({
          x: cx + 0.5,
          y,
          width: cw,
          height: rowHeight,
          columnIndex,
          rowIndex: realIndex,
          depth,
          theme,
          value,
          isHover: false,
          isCollapsed,
          imageManager,
          spriteManager,
          groupCollection,
        });
      };

      if (hasFreezeColumns) {
        for (let ci = freezeStartCol; ci <= freezeStopCol; ci++) emitGroupRow(ci, freezeGroupRowList);
      }
      for (let ci = otherStartCol; ci <= otherStopCol; ci++) emitGroupRow(ci, otherGroupRowList);
      continue;
    }

    const { displayIndex, realIndex: realRowIndex } = linearRow;
    const isRowHovered =
      !isOutOfBounds &&
      !isSelecting &&
      ROW_RELATED_REGIONS.has(hoverRegionType) &&
      rowIndex === hoverRowIndex;
    const { isCellActive: _isCellActiveAny, isRowActive } = checkIfRowOrCellActive(activeCell, realRowIndex, 0);
    const { isRowSelected } = checkIfRowOrCellSelected(selection, realRowIndex, 0);

    let currentTreeIndent = 0;
    const treeData = getRowTreeData?.(realRowIndex);
    if (typeof treeData?.treeDepth === 'number') {
      currentTreeIndent = (treeData.treeDepth + 1) * TREE_INDENT_PER_LEVEL;
    }

    const resolvedDisplayIndex =
      treeData && typeof treeData.treeDepth === 'number'
        ? treeData.treeDepth === 0 && treeData.rootDisplayIndex != null
          ? String(treeData.rootDisplayIndex)
          : ''
        : String(displayIndex);

    rowHeaderPropList.push({
      x: 0.5,
      y: y + 0.5,
      width: columnInitSize + 0.5,
      height: rowHeight,
      displayIndex: resolvedDisplayIndex,
      isHover: isRowHovered || isRowActive,
      isChecked: isRowSelection && isRowSelected,
      rowIndexVisible,
      rowControls,
      theme,
      spriteManager,
      treeDepth: treeData?.treeDepth,
    });

    const emitCell = (columnIndex: number, target: ICellDrawerProps[]) => {
      const column = columns[columnIndex];
      const x = coordInstance.getColumnRelativeOffset(columnIndex, scrollLeft);
      const columnWidth = coordInstance.getColumnWidth(columnIndex);
      const isColumnActive = isColumnSelection && selection.includes([columnIndex, columnIndex]);
      const isFirstColumn = columnIndex === 0;
      const isColumnHovered = hoverColumnIndex === columnIndex;
      const finalTheme = column?.customTheme ? { ...theme, ...column.customTheme } : theme;
      const { cellBg, cellBgHovered, cellBgSelected } = finalTheme;

      const { isCellActive } = checkIfRowOrCellActive(activeCell, realRowIndex, columnIndex);
      const { isCellSelected } = checkIfRowOrCellSelected(selection, realRowIndex, columnIndex);

      let fill;
      if (isCellSelected || isRowSelected || isColumnActive) {
        fill = cellBgSelected;
      } else if (isRowHovered || isRowActive) {
        fill = cellBgHovered;
      }

      const cell = getCellContent([columnIndex, realRowIndex]);

      target.push({
        x: x + 0.5,
        y: y + 0.5,
        width: columnWidth,
        height: rowHeight,
        rowIndex: realRowIndex,
        columnIndex,
        hoverCellPosition: isColumnHovered && isRowHovered ? hoverCellPosition : null,
        getCellContent,
        imageManager,
        spriteManager,
        theme: finalTheme,
        fill: isCellActive ? cellBg : fill ?? cellBg,
        treeIndent: isFirstColumn ? currentTreeIndent : undefined,
        treeDepth: isFirstColumn ? treeData?.treeDepth : undefined,
        treeHasChildren: isFirstColumn ? treeData?.treeHasChildren : undefined,
        treeExpanded: isFirstColumn ? treeData?.treeExpanded : undefined,
        cell,
        commentCount: column?.isPrimary
          ? resolveCellCommentCount(cell, column, commentCountMap)?.count
          : undefined,
      });
    };

    if (hasFreezeColumns) {
      for (let ci = freezeStartCol; ci <= freezeStopCol; ci++) emitCell(ci, freezeCellPropList);
    }
    for (let ci = otherStartCol; ci <= otherStopCol; ci++) emitCell(ci, otherCellPropList);
  }

  return {
    freezeCellPropList,
    otherCellPropList,
    rowHeaderPropList,
    freezeGroupRowList,
    otherGroupRowList,
    groupRowHeaderList,
    appendRowList,
  };
};

export const drawCells = (
  mainCtx: CanvasRenderingContext2D,
  cacheCtx: CanvasRenderingContext2D,
  props: ILayoutDrawerProps
) => {
  const { coordInstance, theme, shouldRerender } = props;
  const { fontFamily, fontSizeSM, fontSizeXS, cellLineColor } = theme;
  const { rowInitSize, freezeRegionWidth, containerWidth, containerHeight } = coordInstance;

  const {
    freezeCellPropList,
    otherCellPropList,
    rowHeaderPropList,
    freezeGroupRowList,
    otherGroupRowList: groupRowList,
    groupRowHeaderList,
    appendRowList,
  } = calcCellsMerged(props);

  appendRowList.forEach((props) => drawAppendRow(mainCtx, props));

  // Render freeze region
  drawClipRegion(
    mainCtx,
    {
      x: 0,
      y: rowInitSize + 1,
      width: freezeRegionWidth,
      height: containerHeight - rowInitSize - 1,
    },
    (ctx: CanvasRenderingContext2D) => {
      freezeCellPropList.forEach((cellProps) => {
        const { x, y, width, height, fill } = cellProps;
        drawRect(ctx, {
          x,
          y,
          width,
          height,
          fill,
          stroke: cellLineColor,
        });
      });
      ctx.font = `${theme.fontWeight} ${fontSizeXS}px ${fontFamily}`;
      rowHeaderPropList.forEach((rowHeaderProps) => drawRowHeader(ctx, rowHeaderProps));
      freezeGroupRowList.forEach((props) => drawGroupRow(ctx, props));
      groupRowHeaderList.forEach((props) => drawGroupRowHeader(ctx, props));
    }
  );

  // Render other region
  drawClipRegion(
    mainCtx,
    {
      x: freezeRegionWidth,
      y: rowInitSize + 1,
      width: containerWidth - freezeRegionWidth,
      height: containerHeight - rowInitSize - 1,
    },
    (ctx: CanvasRenderingContext2D) => {
      otherCellPropList.forEach((cellProps) => {
        const { x, y, width, height, fill } = cellProps;
        drawRect(ctx, {
          x,
          y,
          width,
          height,
          fill,
          stroke: cellLineColor,
        });
      });
      groupRowList.forEach((props) => drawGroupRow(ctx, props));
    }
  );

  drawPrefillingRowHighlight(mainCtx, props);

  // Cache for cells content
  if (shouldRerender) {
    drawClipRegion(
      cacheCtx,
      {
        x: 0,
        y: rowInitSize + 1,
        width: freezeRegionWidth,
        height: containerHeight - rowInitSize - 1,
      },
      (ctx: CanvasRenderingContext2D) => {
        ctx.font = `${theme.fontWeight} ${fontSizeSM}px ${fontFamily}`;
        freezeCellPropList.forEach((cellProps) => {
          drawCellContent(ctx, cellProps);
        });
      }
    );

    drawClipRegion(
      cacheCtx,
      {
        x: freezeRegionWidth,
        y: rowInitSize + 1,
        width: containerWidth - freezeRegionWidth,
        height: containerHeight - rowInitSize - 1,
      },
      (ctx: CanvasRenderingContext2D) => {
        ctx.font = `${theme.fontWeight} ${fontSizeSM}px ${fontFamily}`;
        otherCellPropList.forEach((cellProps) => {
          drawCellContent(ctx, cellProps);
        });
      }
    );
  }
};

export const drawGroupRowHeader = (
  ctx: CanvasRenderingContext2D,
  props: IGroupRowHeaderDrawerProps
) => {
  const { x, y, width, height, theme, depth, isCollapsed, spriteManager, groupCollection } = props;
  const {
    iconSizeSM,
    cellLineColor,
    groupHeaderBgPrimary,
    groupHeaderBgSecondary,
    groupHeaderBgTertiary,
  } = theme;

  if (groupCollection == null) return;

  const { groupColumns } = groupCollection;

  if (!groupColumns.length) return;

  const bgList = [groupHeaderBgTertiary, groupHeaderBgSecondary, groupHeaderBgPrimary].slice(
    -groupColumns.length
  );

  drawRect(ctx, {
    x,
    y,
    width,
    height,
    fill: bgList[depth],
  });
  drawRect(ctx, {
    x,
    y,
    width,
    height: 1,
    fill: cellLineColor,
  });

  spriteManager.drawSprite(ctx, {
    sprite: isCollapsed ? GridInnerIcon.Collapse : GridInnerIcon.Expand,
    x: (width - iconSizeSM) / 2 + depth * 16,
    y: y + (height - iconSizeSM) / 2,
    size: iconSizeSM,
    theme,
  });
};

export const drawGroupRow = (ctx: CanvasRenderingContext2D, props: IGroupRowDrawerProps) => {
  const {
    x,
    y,
    width,
    height,
    theme,
    columnIndex,
    rowIndex,
    depth,
    value,
    imageManager,
    spriteManager,
    groupCollection,
  } = props;
  const {
    cellLineColor,
    groupHeaderBgPrimary,
    groupHeaderBgTertiary,
    groupHeaderBgSecondary,
  } = theme;

  if (groupCollection == null) return;

  const { groupColumns, getGroupCell } = groupCollection;

  if (!groupColumns.length) return;

  const bgList = [groupHeaderBgTertiary, groupHeaderBgSecondary, groupHeaderBgPrimary].slice(
    -groupColumns.length
  );

  drawRect(ctx, {
    x,
    y,
    width,
    height,
    fill: bgList[depth],
  });
  drawRect(ctx, {
    x,
    y,
    width,
    height: 1,
    fill: cellLineColor,
  });

  if (columnIndex !== 0) return;

  const groupColumn = groupColumns[depth];

  if (groupColumn == null) return;

  ctx.save();
  ctx.beginPath();

  const cell = getGroupCell(value, depth);
  const cellRenderer = getCellRenderer(cell.type);
  const groupCellHeight = Math.min(defaultRowHeight, height);
  cellRenderer.draw(cell as never, {
    ctx,
    theme,
    rect: {
      x,
      y: y + (height - groupCellHeight) / 2,
      width,
      height: groupCellHeight,
    },
    rowIndex,
    columnIndex,
    imageManager,
    spriteManager,
  });
  ctx.restore();
};

export const drawActiveCell = (ctx: CanvasRenderingContext2D, props: ILayoutDrawerProps) => {
  const {
    theme,
    mouseState,
    scrollState,
    coordInstance,
    activeCellBound,
    hoverCellPosition,
    imageManager,
    spriteManager,
    real2RowIndex,
    getLinearRow,
    getCellContent,
    getRowTreeData,
    isEditing,
  } = props;

  // During editing, the DOM editor owns this visual surface. Keeping the canvas
  // preview beneath it leaves a visible duplicate strip for expanded long text.
  if (isEditing || activeCellBound == null) return;

  const { scrollTop, scrollLeft } = scrollState;
  const { width, height, columnIndex, rowIndex: activeRowIndex } = activeCellBound;
  const { rowIndex: hoverLinearRowIndex, columnIndex: hoverColumnIndex } = mouseState;
  const { cellBg, cellLineColorActived, fontSizeSM, fontFamily, scrollBarBg } = theme;
  const {
    freezeColumnCount,
    freezeRegionWidth,
    containerWidth,
    containerHeight,
    columnCount,
    rowInitSize,
  } = coordInstance;
  const activeLinearRowIndex = real2RowIndex(activeRowIndex);
  const linearRow = getLinearRow(activeLinearRowIndex);

  if (columnIndex >= columnCount || linearRow?.type !== LinearRowType.Row) return;

  const isFreezeRegion = columnIndex < freezeColumnCount;
  const x = coordInstance.getColumnRelativeOffset(columnIndex, scrollLeft);
  const y = coordInstance.getRowOffset(activeLinearRowIndex) - scrollTop;
  const { realIndex: hoverRowIndex } = getLinearRow(hoverLinearRowIndex);

  ctx.save();
  ctx.beginPath();
  ctx.rect(
    isFreezeRegion ? 0 : freezeRegionWidth,
    rowInitSize,
    isFreezeRegion ? freezeRegionWidth + 1 : containerWidth - freezeRegionWidth,
    containerHeight - rowInitSize
  );
  ctx.clip();

  ctx.font = `${theme.fontWeight} ${fontSizeSM}px ${fontFamily}`;

  const isFirstColumn = columnIndex === 0;
  const activeCellTreeData = isFirstColumn ? getRowTreeData?.(activeRowIndex) : undefined;
  const activeCellTreeIndent =
    isFirstColumn && typeof activeCellTreeData?.treeDepth === 'number'
      ? (activeCellTreeData.treeDepth + 1) * TREE_INDENT_PER_LEVEL
      : 0;

  const activeCellX = x + activeCellTreeIndent + 0.5;
  const activeCellWidth = width - activeCellTreeIndent;

  drawRect(ctx, {
    x: activeCellX,
    y: y + 0.5,
    width: activeCellWidth,
    height,
    fill: cellBg,
    stroke: cellLineColorActived,
    radius: 2,
  });

  const cellScrollState = getCellScrollState(activeCellBound);
  const { scrollBarHeight, scrollBarScrollTop, contentScrollTop } = cellScrollState;

  ctx.save();
  ctx.beginPath();

  if (activeCellBound.scrollEnable) {
    ctx.translate(0, scrollBarScrollTop);

    drawRect(ctx, {
      x: x + width - cellScrollBarWidth - cellScrollBarPaddingX,
      y: y + cellScrollBarPaddingY,
      width: cellScrollBarWidth,
      height: scrollBarHeight,
      fill: scrollBarBg,
      radius: cellScrollBarWidth / 2,
    });

    ctx.restore();
    ctx.save();
    ctx.beginPath();
    ctx.rect(activeCellX, y + 1, activeCellWidth, height - 1);
    ctx.clip();
    ctx.translate(0, -contentScrollTop);
  }

  drawCellContent(ctx, {
    x: x + 0.5,
    y: y + 0.5,
    width,
    height,
    rowIndex: activeRowIndex,
    columnIndex,
    hoverCellPosition:
      hoverRowIndex === activeRowIndex && hoverColumnIndex === columnIndex
        ? hoverCellPosition
        : null,
    getCellContent,
    isActive: true,
    imageManager,
    spriteManager,
    theme,
    treeIndent: activeCellTreeIndent || undefined,
    treeDepth: isFirstColumn ? activeCellTreeData?.treeDepth : undefined,
    treeHasChildren: isFirstColumn ? activeCellTreeData?.treeHasChildren : undefined,
    treeExpanded: isFirstColumn ? activeCellTreeData?.treeExpanded : undefined,
  });

  ctx.restore();
  ctx.restore();
};

const getVisibleCollaborators = (
  collaborators: ICollaborator,
  visibleRegion: IVisibleRegion,
  freezeColumnCount: number,
  getCellContent: (cell: ICellItem) => ICell,
  getLinearRow: (rowNumber: number) => ILinearRow
) => {
  // activeCellId 是 [recordId, fieldId] 数组，toString() 产生 "recordId,fieldId"
  // 而 cell.id 格式为 "recordId-fieldId"，需要用连字符 key 来匹配
  const groupedCollaborators = groupBy(collaborators, (c) =>
    Array.isArray(c.activeCellId) ? c.activeCellId.join('-') : String(c.activeCellId)
  );

  // through visible region to find the cell that has collaborators and get the real coordinate
  const { startColumnIndex, stopColumnIndex, startRowIndex, stopRowIndex } = visibleRegion;

  const visibleCells = [];
  const columnIndices = [
    ...Array.from({ length: freezeColumnCount }, (_, i) => i),
    ...Array.from(
      { length: stopColumnIndex - Math.max(freezeColumnCount, startColumnIndex) + 1 },
      (_, i) => Math.max(freezeColumnCount, startColumnIndex) + i
    ),
  ];

  for (const i of columnIndices) {
    for (let j = startRowIndex; j <= stopRowIndex; j++) {
      const realIndex = getLinearRow(j).realIndex;
      const cell = getCellContent([i, realIndex]);
      if (!cell?.id) {
        continue;
      }
      const visibleCell = groupedCollaborators[cell.id];
      if (visibleCell) {
        const newCell = visibleCell.map(c => ({ ...c }));
        newCell[0].activeCell = [i, realIndex];
        visibleCells.push(newCell);
      }
    }
  }

  return visibleCells;
};

const COLLAB_LABEL_HEIGHT = 18;
const COLLAB_LABEL_PADDING_H = 6;
const COLLAB_LABEL_FONT_SIZE = 10;
const COLLAB_LABEL_RADIUS = 3;
const COLLAB_BORDER_WIDTH = 2;

const resolveCollaboratorName = (
  collaborator: ICollaborator[number]
): string | undefined => {
  if (collaborator.userName) return collaborator.userName;
  if (collaborator.user?.name) return collaborator.user.name;
  return undefined;
};

export const drawCollaborators = (ctx: CanvasRenderingContext2D, props: ILayoutDrawerProps) => {
  const {
    collaborators,
    scrollState,
    coordInstance,
    activeCellBound,
    theme,
    real2RowIndex,
    getCellContent,
    visibleRegion,
    getLinearRow,
  } = props;
  const { scrollTop, scrollLeft } = scrollState;
  const { themeKey } = theme;

  const { freezeColumnCount, freezeRegionWidth, rowInitSize, containerWidth, containerHeight } =
    coordInstance;

  if (!collaborators?.length) return;

  ctx.save();

  const visibleCells = getVisibleCollaborators(
    collaborators,
    visibleRegion,
    freezeColumnCount,
    getCellContent,
    getLinearRow
  );

  for (let i = 0; i < visibleCells.length; i++) {
    const conflictCollaborators = visibleCells[i].sort((a, b) => b.timeStamp - a.timeStamp);
    const latestCollaborator = conflictCollaborators[0];
    const { activeCell, borderColor } = latestCollaborator;
    if (!activeCell) {
      continue;
    }
    const [columnIndex, _rowIndex] = activeCell;
    const rowIndex = real2RowIndex(_rowIndex);
    const x = coordInstance.getColumnRelativeOffset(columnIndex, scrollLeft);
    const y = coordInstance.getRowOffset(rowIndex) - scrollTop;
    const width = coordInstance.getColumnWidth(columnIndex);
    const height =
      activeCellBound?.columnIndex === columnIndex && activeCellBound?.rowIndex === rowIndex
        ? activeCellBound.height
        : coordInstance.getRowHeight(rowIndex);

    const resolvedColor = contractColorForTheme(borderColor, themeKey);
    const strokeColor = hexToRGBA(resolvedColor);

    ctx.save();
    ctx.beginPath();

    const isFreezeRegion = columnIndex < freezeColumnCount;

    ctx.rect(
      isFreezeRegion ? 0 : freezeRegionWidth,
      rowInitSize,
      isFreezeRegion ? freezeRegionWidth + 1 : containerWidth - freezeRegionWidth,
      containerHeight - rowInitSize
    );
    ctx.clip();

    ctx.lineWidth = COLLAB_BORDER_WIDTH;
    drawRect(ctx, {
      x: x + 0.5,
      y: y + 0.5,
      width,
      height: height,
      stroke: strokeColor,
      radius: 2,
    });

    const userName = resolveCollaboratorName(latestCollaborator);
    if (userName?.trim() && width > COLLAB_LABEL_PADDING_H * 2) {
      ctx.font = `${theme.fontWeight ?? 'normal'} ${COLLAB_LABEL_FONT_SIZE}px ${theme.fontFamily}`;
      const textMetrics = ctx.measureText(userName);
      const labelWidth = Math.min(
        textMetrics.width + COLLAB_LABEL_PADDING_H * 2,
        width
      );

      const labelX = x + width - labelWidth + 0.5;
      const preferredLabelY = y - COLLAB_LABEL_HEIGHT + 1;
      const labelY = Math.max(rowInitSize + 1, preferredLabelY);

      drawRect(ctx, {
        x: labelX,
        y: labelY,
        width: labelWidth,
        height: COLLAB_LABEL_HEIGHT,
        fill: resolvedColor,
        radius: COLLAB_LABEL_RADIUS,
      });

      const maxTextWidth = Math.max(0, labelWidth - COLLAB_LABEL_PADDING_H * 2);
      if (maxTextWidth > 0) {
        ctx.save();
        ctx.beginPath();
        ctx.rect(labelX + COLLAB_LABEL_PADDING_H, labelY, maxTextWidth, COLLAB_LABEL_HEIGHT);
        ctx.clip();
        drawSingleLineText(ctx, {
          x: labelX + COLLAB_LABEL_PADDING_H,
          y: labelY + (COLLAB_LABEL_HEIGHT - COLLAB_LABEL_FONT_SIZE) / 2,
          text: userName,
          fill: '#FFFFFF',
          fontSize: COLLAB_LABEL_FONT_SIZE,
          maxWidth: maxTextWidth,
        });
        ctx.restore();
      }
    }

    ctx.restore();
  }
  ctx.restore();
};

export const drawSearchCursor = (ctx: CanvasRenderingContext2D, props: ILayoutDrawerProps) => {
  const {
    theme,
    scrollState,
    coordInstance,
    real2RowIndex,
    getLinearRow,
    searchCursor,
    imageManager,
    spriteManager,
    getCellContent,
    getRowTreeData,
  } = props;

  if (!searchCursor) return;

  const [searchColumnIndex, searchRowIndex] = searchCursor;

  const { scrollTop, scrollLeft } = scrollState;
  const { fontSizeSM, fontFamily } = theme;
  const {
    freezeColumnCount,
    freezeRegionWidth,
    containerWidth,
    containerHeight,
    columnCount,
    rowInitSize,
  } = coordInstance;
  const activeLinearRowIndex = real2RowIndex(searchRowIndex);
  const linearRow = getLinearRow(activeLinearRowIndex);

  if (searchColumnIndex >= columnCount || linearRow?.type !== LinearRowType.Row) return;

  const isFreezeRegion = searchColumnIndex < freezeColumnCount;
  const x = coordInstance.getColumnRelativeOffset(searchColumnIndex, scrollLeft);
  const y = coordInstance.getRowOffset(activeLinearRowIndex) - scrollTop;

  const width = coordInstance.getColumnWidth(searchColumnIndex);
  const height = coordInstance.getRowHeight(activeLinearRowIndex);

  ctx.save();
  ctx.beginPath();
  ctx.rect(
    isFreezeRegion ? 0 : freezeRegionWidth,
    rowInitSize,
    isFreezeRegion ? freezeRegionWidth + 1 : containerWidth - freezeRegionWidth,
    containerHeight - rowInitSize
  );
  ctx.clip();

  ctx.font = `${theme.fontWeight} ${fontSizeSM}px ${fontFamily}`;

  drawRect(ctx, {
    x: x + 1,
    y: y + 1,
    width: width - 1,
    height: height - 1,
    fill: theme.searchCursorBg,
    radius: 0.5,
  });

  ctx.save();
  ctx.beginPath();

  const isSearchFirstColumn = searchColumnIndex === 0;
  const searchTreeData = isSearchFirstColumn ? getRowTreeData?.(searchRowIndex) : undefined;
  const searchTreeIndent =
    isSearchFirstColumn && typeof searchTreeData?.treeDepth === 'number'
      ? (searchTreeData.treeDepth + 1) * TREE_INDENT_PER_LEVEL
      : 0;

  drawCellContent(ctx, {
    x: x + 0.5,
    y: y + 0.5,
    width,
    height,
    rowIndex: searchRowIndex,
    columnIndex: searchColumnIndex,
    getCellContent,
    isActive: false,
    imageManager,
    spriteManager,
    theme,
    treeIndent: searchTreeIndent || undefined,
    treeDepth: isSearchFirstColumn ? searchTreeData?.treeDepth : undefined,
    treeHasChildren: isSearchFirstColumn ? searchTreeData?.treeHasChildren : undefined,
    treeExpanded: isSearchFirstColumn ? searchTreeData?.treeExpanded : undefined,
  });

  ctx.restore();
  ctx.restore();
};

export const drawSearchResult = (
  ctx: CanvasRenderingContext2D,
  props: ILayoutDrawerProps,
  result?: [number, number]
) => {
  const {
    theme,
    scrollState,
    coordInstance,
    real2RowIndex,
    getLinearRow,
    imageManager,
    spriteManager,
    getCellContent,
    getRowTreeData,
  } = props;

  if (!result) return;

  const [searchColumnIndex, searchRowIndex] = result;

  const { scrollTop, scrollLeft } = scrollState;
  const { fontSizeSM, fontFamily, searchTargetIndexBg } = theme;
  const {
    freezeColumnCount,
    freezeRegionWidth,
    containerWidth,
    containerHeight,
    columnCount,
    rowInitSize,
  } = coordInstance;
  const activeLinearRowIndex = real2RowIndex(searchRowIndex);
  const linearRow = getLinearRow(activeLinearRowIndex);

  if (searchColumnIndex >= columnCount || linearRow?.type !== LinearRowType.Row) return;

  const isFreezeRegion = searchColumnIndex < freezeColumnCount;
  const x = coordInstance.getColumnRelativeOffset(searchColumnIndex, scrollLeft);
  const y = coordInstance.getRowOffset(activeLinearRowIndex) - scrollTop;

  const width = coordInstance.getColumnWidth(searchColumnIndex);
  const height = coordInstance.getRowHeight(activeLinearRowIndex);

  ctx.save();
  ctx.beginPath();
  ctx.rect(
    isFreezeRegion ? 0 : freezeRegionWidth,
    rowInitSize,
    isFreezeRegion ? freezeRegionWidth + 1 : containerWidth - freezeRegionWidth,
    containerHeight - rowInitSize
  );
  ctx.clip();

  ctx.font = `${theme.fontWeight} ${fontSizeSM}px ${fontFamily}`;

  drawRect(ctx, {
    x: x + 1,
    y: y + 1,
    width: width - 1,
    height: height - 1,
    fill: searchTargetIndexBg,
    radius: 0.5,
  });

  ctx.save();
  ctx.beginPath();

  const isResultFirstColumn = searchColumnIndex === 0;
  const resultTreeData = isResultFirstColumn ? getRowTreeData?.(linearRow.realIndex) : undefined;
  const resultTreeIndent =
    isResultFirstColumn && typeof resultTreeData?.treeDepth === 'number'
      ? (resultTreeData.treeDepth + 1) * TREE_INDENT_PER_LEVEL
      : 0;

  drawCellContent(ctx, {
    x: x + 0.5,
    y: y + 0.5,
    width,
    height,
    rowIndex: linearRow.realIndex,
    columnIndex: searchColumnIndex,
    getCellContent,
    isActive: false,
    imageManager,
    spriteManager,
    theme,
    treeIndent: resultTreeIndent || undefined,
    treeDepth: isResultFirstColumn ? resultTreeData?.treeDepth : undefined,
    treeHasChildren: isResultFirstColumn ? resultTreeData?.treeHasChildren : undefined,
    treeExpanded: isResultFirstColumn ? resultTreeData?.treeExpanded : undefined,
  });

  ctx.restore();
  ctx.restore();
};

export const getVisibleSearchTargetIndex = (
  searchHitIndex: { fieldId: string; recordId: string }[],
  visibleRegion: IVisibleRegion,
  freezeColumnCount: number,
  getCellContent: (cell: ICellItem) => ICell,
  getLinearRow: (rowNumber: number) => ILinearRow
) => {
  const { startColumnIndex, stopColumnIndex, startRowIndex, stopRowIndex } = visibleRegion;

  const searchCells = [];
  const columnIndices = [
    ...Array.from({ length: freezeColumnCount }, (_, i) => i),
    ...Array.from(
      { length: stopColumnIndex - Math.max(freezeColumnCount, startColumnIndex) + 1 },
      (_, i) => Math.max(freezeColumnCount, startColumnIndex) + i
    ),
  ];

  const searchCellIdSet = new Set(
    searchHitIndex?.map((item) => `${item.recordId}-${item.fieldId}`) ?? []
  );
  // A projected/frozen column can expose the same logical cell more than once.
  // Search highlights are keyed by cell identity, so only draw one target for
  // each `recordId-fieldId` even when the visible column projection repeats it.
  const seenSearchCellIds = new Set<string>();

  for (const i of columnIndices) {
    for (let j = startRowIndex; j <= stopRowIndex; j++) {
      const line = getLinearRow(j);
      if (line.type !== LinearRowType.Row) {
        continue;
      }
      const { realIndex } = line;
      const cell = getCellContent([i, realIndex]);

      if (!cell?.id) {
        continue;
      }

      if (searchCellIdSet.has(cell.id) && !seenSearchCellIds.has(cell.id)) {
        seenSearchCellIds.add(cell.id);
        searchCells.push([i, realIndex]);
      }
    }
  }

  return searchCells as [number, number][];
};

export const drawSearchTargetIndex = (ctx: CanvasRenderingContext2D, props: ILayoutDrawerProps) => {
  const { getCellContent, coordInstance, visibleRegion, searchHitIndex, getLinearRow } = props;

  const { freezeColumnCount } = coordInstance;

  if (!searchHitIndex?.length) return;

  const searchCellIds = getVisibleSearchTargetIndex(
    searchHitIndex,
    visibleRegion,
    freezeColumnCount,
    getCellContent,
    getLinearRow
  );

  for (let i = 0; i < searchCellIds.length; i++) {
    drawSearchResult(ctx, props, searchCellIds[i]);
  }
};

export const drawFillPreview = (ctx: CanvasRenderingContext2D, props: ILayoutDrawerProps) => {
  const {
    selection,
    mouseState,
    coordInstance,
    scrollState,
    theme,
    isFilling,
    isFillEnabled,
    real2RowIndex,
    getLinearRow,
  } = props;
  if (!isFilling || !isFillEnabled) return;
  const { isCellSelection, ranges } = selection;
  if (!isCellSelection) return;
  const [start, end] = ranges;
  const startCol = Math.min(start[0], end[0]);
  const endCol = Math.max(start[0], end[0]);
  const topRow = Math.min(start[1], end[1]);
  const bottomRow = Math.max(start[1], end[1]);
  const hoverLinear = getLinearRow(mouseState.rowIndex);
  const targetRealRow = hoverLinear.realIndex;
  const { scrollLeft, scrollTop } = scrollState;
  const startX = coordInstance.getColumnRelativeOffset(startCol, scrollLeft);
  const endX =
    coordInstance.getColumnRelativeOffset(endCol, scrollLeft) +
    coordInstance.getColumnWidth(endCol);
  let startY: number | null = null;
  let endY: number | null = null;

  if (Number.isFinite(targetRealRow) && targetRealRow > bottomRow) {
    startY = coordInstance.getRowOffset(real2RowIndex(bottomRow + 1)) - scrollTop;
    endY =
      coordInstance.getRowOffset(real2RowIndex(targetRealRow)) +
      coordInstance.getRowHeight(real2RowIndex(targetRealRow)) -
      scrollTop;
  } else if (Number.isFinite(targetRealRow) && targetRealRow < topRow) {
    startY = coordInstance.getRowOffset(real2RowIndex(targetRealRow)) - scrollTop;
    endY =
      coordInstance.getRowOffset(real2RowIndex(topRow - 1)) +
      coordInstance.getRowHeight(real2RowIndex(topRow - 1)) -
      scrollTop;
  }

  if (startY != null && endY != null) {
    const width = endX - startX;
    const height = endY - startY;
    drawRect(ctx, {
      x: startX + 0.5,
      y: startY + 0.5,
      width,
      height,
      stroke: theme.interactionLineColorHighlight,
    });
  }
};

export const drawFillHandler = (ctx: CanvasRenderingContext2D, props: ILayoutDrawerProps) => {
  const {
    coordInstance,
    scrollState,
    selection,
    isSelecting,
    isEditing,
    theme,
    activeCellBound,
    isFillEnabled,
    real2RowIndex,
    getLinearRow,
  } = props;

  if (!isFillEnabled || isEditing || isSelecting) return;

  const { scrollTop, scrollLeft } = scrollState;
  const { freezeColumnCount, freezeRegionWidth, rowInitSize, containerWidth, containerHeight } =
    coordInstance;
  const maxRange = calculateMaxRange(selection);

  if (maxRange == null) return;

  const [columnIndex, realRowIndex] = maxRange;
  const { cellBg, cellLineColorActived } = theme;
  const isFreezeRegion = columnIndex < freezeColumnCount;
  const x = coordInstance.getColumnRelativeOffset(columnIndex, scrollLeft);
  const linearRowIndex = real2RowIndex(realRowIndex);
  const y = coordInstance.getRowOffset(linearRowIndex) - scrollTop;
  const width = coordInstance.getColumnWidth(columnIndex);
  const defaultHeight = coordInstance.getRowHeight(linearRowIndex);
  const isSingleCell =
    selection.isCellSelection && isEqual(selection.ranges[0], selection.ranges[1]);
  const isSameAsActive =
    isSingleCell &&
    activeCellBound &&
    activeCellBound.columnIndex === columnIndex &&
    activeCellBound.rowIndex === realRowIndex &&
    getLinearRow(linearRowIndex).type === LinearRowType.Row;
  const height = isSameAsActive && activeCellBound ? activeCellBound.height : defaultHeight;

  ctx.save();
  ctx.beginPath();
  if (!isFreezeRegion) {
    ctx.rect(
      freezeRegionWidth,
      rowInitSize,
      containerWidth - freezeRegionWidth,
      containerHeight - rowInitSize
    );
    ctx.clip();
  }

  drawRect(ctx, {
    x: x + width - fillHandlerSize / 2 - 0.5,
    y: y + height - fillHandlerSize / 2 - 0.5,
    width: fillHandlerSize,
    height: fillHandlerSize,
    stroke: cellLineColorActived,
    fill: cellBg,
  });

  ctx.restore();
};

// eslint-disable-next-line sonarjs/cognitive-complexity
export const drawRowHeader = (ctx: CanvasRenderingContext2D, props: IRowHeaderDrawerProps) => {
  const {
    x,
    y,
    width,
    height,
    displayIndex,
    theme,
    isHover,
    isChecked,
    rowControls,
    spriteManager,
    rowIndexVisible,
  } = props;

  const {
    cellBg,
    cellBgHovered,
    cellBgSelected,
    cellLineColor,
    rowHeaderTextColor,
    iconSizeXS,
    staticWhite,
    iconBgSelected,
  } = theme;
  let fill = cellBg;

  if (isChecked) {
    fill = cellBgSelected;
  } else if (isHover) {
    fill = cellBgHovered;
  }

  drawRect(ctx, {
    x,
    y,
    width,
    height,
    fill,
  });
  drawLine(ctx, {
    x,
    y,
    points: [0, 0, width, 0],
    stroke: cellLineColor,
  });
  drawLine(ctx, {
    x,
    y,
    points: [0, height, width, height],
    stroke: cellLineColor,
  });
  const halfSize = iconSizeXS / 2;

  ctx.font = `${theme.fontWeight} ${10}px ${theme.fontFamily}`;

  if (isChecked || isHover || !rowIndexVisible) {
    const controlSize = width / rowControls.length;
    for (let i = 0; i < rowControls.length; i++) {
      const { type, icon } = rowControls[i];
      const offsetX = controlSize * (i + 0.5);

      if (type === RowControlType.Checkbox) {
        drawCheckbox(ctx, {
          x: x + offsetX - halfSize,
          y: y + rowHeadIconPaddingTop,
          size: iconSizeXS,
          stroke: isChecked ? staticWhite : rowHeaderTextColor,
          fill: isChecked ? iconBgSelected : undefined,
          isChecked,
        });
      } else {
        spriteManager.drawSprite(ctx, {
          sprite: icon || spriteIconMap[type],
          x: x + offsetX - halfSize,
          y: y + rowHeadIconPaddingTop,
          size: iconSizeXS,
          theme,
        });
      }
    }
    return;
  }

  if (displayIndex) {
    drawSingleLineText(ctx, {
      x: x + width / 2,
      y: y + cellVerticalPaddingMD + 1,
      text: displayIndex,
      textAlign: 'center',
      fill: rowHeaderTextColor,
    });
  }
};

/**
 * Draw tree expand/collapse triangle arrow indicator.
 * - Expanded: downward-pointing triangle ▼
 * - Collapsed: right-pointing triangle ▶
 */
const drawTreeExpandArrow = (
  ctx: CanvasRenderingContext2D,
  props: { x: number; y: number; expanded: boolean; color: string }
) => {
  const { x, y, expanded, color } = props;
  const size = 5;

  ctx.save();
  ctx.fillStyle = color;
  ctx.beginPath();

  if (expanded) {
    // Downward triangle ▼
    ctx.moveTo(x - size, y - size / 2);
    ctx.lineTo(x + size, y - size / 2);
    ctx.lineTo(x, y + size / 2);
  } else {
    // Right triangle ▶
    ctx.moveTo(x - size / 2, y - size);
    ctx.lineTo(x + size / 2, y);
    ctx.lineTo(x - size / 2, y + size);
  }

  ctx.closePath();
  ctx.fill();
  ctx.restore();
};

export const drawCommentCount = (
  ctx: CanvasRenderingContext2D,
  props: {
    x: number;
    y: number;
    count: number;
    theme: IGridTheme;
  }
) => {
  const { theme } = props;
  const { commentCountBg, commentCountTextColor } = theme;
  drawRect(ctx, {
    ...props,
    x: props.x,
    y: props.y,
    width: 18,
    height: 16,
    stroke: commentCountBg,
    radius: 3,
    fill: commentCountBg,
  });

  drawSingleLineText(ctx, {
    ...props,
    x: props.x + 9,
    y: props.y + 3.5,
    text: props.count > 99 ? '99+' : props.count.toString(),
    textAlign: 'center',
    verticalAlign: 'middle',
    fontSize: 10,
    fill: commentCountTextColor,
  });
};

export const drawColumnHeader = (ctx: CanvasRenderingContext2D, props: IFieldHeadDrawerProps) => {
  const { x, y, width, height, theme, fill, column, hasMenu, spriteManager } = props;
  const { name, icon, description, hasMenu: hasColumnMenu, isPrimary } = column;
  const {
    cellLineColor,
    columnHeaderBg,
    iconFgCommon,
    columnHeaderNameColor,
    fontSizeSM,
    iconSizeXS,
  } = theme;
  let maxTextWidth = width - columnHeadPadding * 2;
  let iconOffsetX = columnHeadPadding;
  const hasMenuInner = hasMenu && hasColumnMenu;

  drawRect(ctx, {
    x: x + 0.5,
    y,
    width: width - 0.5,
    height,
    fill: fill ?? columnHeaderBg,
  });
  drawLine(ctx, {
    x,
    y,
    points: [0, height, width, height, width, 0],
    stroke: cellLineColor,
  });

  if (isPrimary) {
    maxTextWidth = maxTextWidth - iconSizeXS - columnHeadPadding;
    spriteManager.drawSprite(ctx, {
      sprite: GridInnerIcon.Lock,
      x: x + iconOffsetX,
      y: y + (columnHeadHeight - iconSizeXS) / 2,
      size: iconSizeXS,
      theme,
    });
    iconOffsetX += iconSizeXS + columnHeadPadding / 2;
  }

  if (icon) {
    maxTextWidth = maxTextWidth - iconSizeXS;
    spriteManager.drawSprite(ctx, {
      sprite: icon,
      x: x + iconOffsetX,
      y: y + (columnHeadHeight - iconSizeXS) / 2,
      size: iconSizeXS,
      theme,
    });
    iconOffsetX += iconSizeXS + columnHeadPadding / 2;
  }

  if (hasMenuInner) {
    maxTextWidth = maxTextWidth - columnHeadMenuSize - columnHeadPadding;
    drawRoundPoly(ctx, {
      points: [
        {
          x: x + width - columnHeadPadding - columnHeadMenuSize,
          y: y + columnHeadHeight / 2 - columnHeadMenuSize / 4,
        },
        {
          x: x + width - columnHeadPadding,
          y: y + columnHeadHeight / 2 - columnHeadMenuSize / 4,
        },
        {
          x: x + width - columnHeadPadding - columnHeadMenuSize / 2,
          y: y + columnHeadHeight / 2 + columnHeadMenuSize / 4,
        },
      ],
      radiusAll: 1,
      fill: iconFgCommon,
    });
  }

  if (description) {
    spriteManager.drawSprite(ctx, {
      sprite: GridInnerIcon.Description,
      x: hasMenuInner
        ? x + width - 2 * iconSizeXS - columnHeadPadding
        : x + width - iconSizeXS - columnHeadPadding,
      y: y + (columnHeadHeight - iconSizeXS) / 2,
      size: iconSizeXS,
      theme,
    });

    maxTextWidth = maxTextWidth - iconSizeXS - columnHeadPadding;
  }

  drawMultiLineText(ctx, {
    x: x + iconOffsetX,
    y: y + cellVerticalPaddingMD,
    text: name,
    maxLines: Math.floor((height - cellVerticalPaddingMD) / cellTextLineHeight),
    lineHeight: cellTextLineHeight,
    fontSize: fontSizeSM,
    maxWidth: maxTextWidth,
    fill: columnHeaderNameColor,
  });
};

export const drawGridHeader = (ctx: CanvasRenderingContext2D, props: IGridHeaderDrawerProps) => {
  const { x, y, width, height, theme, rowControls, isChecked, isMultiSelectionEnable } = props;
  const {
    iconSizeXS,
    staticWhite,
    columnHeaderBg,
    cellLineColor,
    rowHeaderTextColor,
    iconBgSelected,
  } = theme;
  const halfSize = iconSizeXS / 2;
  drawRect(ctx, {
    x,
    y,
    width,
    height,
    fill: columnHeaderBg,
  });
  drawLine(ctx, {
    x,
    y,
    points: [0, height, width, height],
    stroke: cellLineColor,
  });

  if (isMultiSelectionEnable && rowControls.some((item) => item.type === RowControlType.Checkbox)) {
    drawCheckbox(ctx, {
      x: width / 2 - halfSize + 0.5,
      y: height / 2 - halfSize + 0.5,
      size: iconSizeXS,
      stroke: isChecked ? staticWhite : rowHeaderTextColor,
      fill: isChecked ? iconBgSelected : undefined,
      isChecked,
    });
  }
};

export const drawColumnHeaders = (
  ctx: CanvasRenderingContext2D,
  props: ILayoutDrawerProps,
  renderRegion: RenderRegion
  // eslint-disable-next-line sonarjs/cognitive-complexity
) => {
  const {
    visibleRegion,
    coordInstance,
    columns,
    theme,
    spriteManager,
    mouseState,
    scrollState,
    selection,
    rowControls,
    isInteracting,
    isColumnHeaderMenuVisible,
    isMultiSelectionEnable,
  } = props;
  const { startColumnIndex: originStartColumnIndex, stopColumnIndex: originStopColumnIndex } =
    visibleRegion;
  const {
    containerWidth,
    freezeRegionWidth,
    rowInitSize,
    columnInitSize,
    freezeColumnCount,
    pureRowCount,
  } = coordInstance;
  const { scrollLeft } = scrollState;
  const { fontSizeSM, fontFamily } = theme;
  const { isColumnSelection, isRowSelection, ranges: selectionRanges } = selection;
  const { type: hoverRegionType, columnIndex: hoverColumnIndex } = mouseState;
  const isFreezeRegion = renderRegion === RenderRegion.Freeze;
  const startColumnIndex = isFreezeRegion ? 0 : Math.max(freezeColumnCount, originStartColumnIndex);
  const stopColumnIndex = isFreezeRegion
    ? Math.max(freezeColumnCount - 1, 0)
    : originStopColumnIndex;
  const endRowIndex = pureRowCount - 1;

  ctx.save();
  ctx.beginPath();
  ctx.rect(
    isFreezeRegion ? 0 : freezeRegionWidth + 1,
    0,
    isFreezeRegion ? freezeRegionWidth + 1 : containerWidth - freezeRegionWidth,
    rowInitSize + 1
  );
  ctx.clip();
  ctx.font = `${theme.headerFontWeight} ${fontSizeSM}px ${fontFamily}`;

  for (let columnIndex = startColumnIndex; columnIndex <= stopColumnIndex; columnIndex++) {
    const column = columns[columnIndex];
    const finalTheme = column?.customTheme ? { ...theme, ...column.customTheme } : theme;
    const { columnHeaderBgHovered, columnHeaderBgSelected } = finalTheme;
    const x = coordInstance.getColumnRelativeOffset(columnIndex, scrollLeft);
    const columnWidth = coordInstance.getColumnWidth(columnIndex);
    const isActive = isColumnSelection && selection.includes([columnIndex, columnIndex]);
    const isHover =
      !isInteracting &&
      [RegionType.ColumnHeader, RegionType.ColumnHeaderMenu].includes(hoverRegionType) &&
      hoverColumnIndex === columnIndex;
    let fill = undefined;

    if (isActive) {
      fill = columnHeaderBgSelected;
    } else if (isHover) {
      fill = columnHeaderBgHovered;
    }

    column &&
      drawColumnHeader(ctx, {
        x: x + 0.5,
        y: 0.5,
        width: columnWidth,
        height: rowInitSize,
        column: column,
        fill,
        hasMenu: isColumnHeaderMenuVisible,
        theme: finalTheme,
        spriteManager,
      });
  }

  const isChecked = isRowSelection && isEqual(selectionRanges[0], [0, endRowIndex]);
  drawGridHeader(ctx, {
    x: 0,
    y: 0.5,
    width: columnInitSize + 1.5,
    height: rowInitSize,
    theme,
    rowControls,
    isChecked,
    isMultiSelectionEnable,
  });

  ctx.restore();
};

export const drawAppendRow = (ctx: CanvasRenderingContext2D, props: IAppendRowDrawerProps) => {
  const { x, y, width, height, theme, isHover, coordInstance, spriteManager } = props;
  const { appendRowBg, appendRowBgHovered, iconSizeSM, cellLineColor } = theme;
  const { columnInitSize } = coordInstance;
  const halfIconSize = iconSizeSM / 2;

  ctx.save();
  drawRect(ctx, {
    x: x + 0.5,
    y: y + 0.5,
    width,
    height,
    fill: isHover ? appendRowBgHovered : appendRowBg,
  });
  drawRect(ctx, {
    x,
    y: y + height,
    width,
    height: 1,
    fill: cellLineColor,
  });
  spriteManager.drawSprite(ctx, {
    sprite: GridInnerIcon.Add,
    x: x + columnInitSize / 2 - halfIconSize + 0.5,
    y: y + height / 2 - halfIconSize + 0.5,
    size: iconSizeSM,
    theme,
  });
  ctx.restore();
};

export const drawAppendColumn = (ctx: CanvasRenderingContext2D, props: ILayoutDrawerProps) => {
  const { coordInstance, theme, mouseState, scrollState, isColumnAppendEnable, spriteManager } =
    props;
  const { scrollLeft, scrollTop } = scrollState;
  const { totalWidth, totalHeight, freezeRegionWidth, columnInitSize, columnCount } = coordInstance;
  const { type: hoverRegionType } = mouseState;

  if (!isColumnAppendEnable) return;

  const { iconSizeSM, columnHeaderBg, cellLineColor, columnHeaderBgHovered } = theme;
  const isHover = hoverRegionType === RegionType.AppendColumn;
  // 横向滚动后 naive `totalWidth - scrollLeft` 会盖住首列（含 freeze_columns=0）。
  const x = getAppendColumnScreenX({
    totalWidth,
    scrollLeft,
    freezeRegionWidth,
    columnInitSize,
    columnCount,
  });
  if (x == null) return;

  drawRect(ctx, {
    x: x + 1,
    y: 0.5,
    width: columnAppendBtnWidth,
    height: totalHeight - scrollTop,
    fill: isHover ? columnHeaderBgHovered : columnHeaderBg,
  });
  drawLine(ctx, {
    x: x + 0.5,
    y: columnHeadHeight + 0.5,
    points: [0, 0, 0, totalHeight - scrollTop - columnHeadHeight],
    stroke: cellLineColor,
  });

  const halfIconSize = iconSizeSM / 2;
  spriteManager.drawSprite(ctx, {
    sprite: GridInnerIcon.Add,
    x: x + columnAppendBtnWidth / 2 - halfIconSize + 0.5,
    y: columnHeadHeight / 2 - halfIconSize + 0.5,
    size: iconSizeSM,
    theme,
  });
};

export const drawColumnResizeHandler = (
  ctx: CanvasRenderingContext2D,
  props: ILayoutDrawerProps
) => {
  const {
    theme,
    scrollState,
    coordInstance,
    isColumnResizable,
    columnResizeState,
    hoveredColumnResizeIndex,
  } = props;
  const { columnIndex: resizeColumnIndex } = columnResizeState;
  const isHover = isColumnResizable && hoveredColumnResizeIndex > -1;
  const isResizing = resizeColumnIndex > -1;

  if (!isHover && !isResizing) return;

  const { scrollLeft } = scrollState;
  const { rowInitSize } = coordInstance;
  const { columnResizeHandlerBg } = theme;
  let x = 0;

  if (isResizing) {
    const columnWidth = coordInstance.getColumnWidth(resizeColumnIndex);
    x = coordInstance.getColumnRelativeOffset(resizeColumnIndex, scrollLeft) + columnWidth;
  } else {
    const realColumnWidth = coordInstance.getColumnWidth(hoveredColumnResizeIndex);
    x =
      coordInstance.getColumnRelativeOffset(hoveredColumnResizeIndex, scrollLeft) + realColumnWidth;
  }

  drawRect(ctx, {
    x: x - columnResizeHandlerWidth / 2 + 0.5,
    y: columnResizeHandlerPaddingTop + 0.5,
    width: columnResizeHandlerWidth,
    height: rowInitSize - columnResizeHandlerPaddingTop * 2,
    fill: columnResizeHandlerBg,
    radius: 3,
  });
};

export const drawColumnDraggingRegion = (
  ctx: CanvasRenderingContext2D,
  props: ILayoutDrawerProps
) => {
  const { columns, theme, mouseState, scrollState, dragState, coordInstance } = props;
  const { columnDraggingPlaceholderBg, interactionLineColorHighlight } = theme;
  const { type, isDragging, ranges: draggingRanges, delta } = dragState;
  const { containerHeight } = coordInstance;
  const { x } = mouseState;
  const { scrollLeft } = scrollState;

  if (!isDragging || type !== DragRegionType.Columns) return;

  const draggingColIndex = draggingRanges[0][0];
  drawRect(ctx, {
    x: x - delta,
    y: 0.5,
    width: columns[draggingColIndex].width as number,
    height: containerHeight,
    fill: columnDraggingPlaceholderBg,
  });

  const targetColumnIndex = getDropTargetIndex(coordInstance, mouseState, scrollState, type);
  const finalX = coordInstance.getColumnRelativeOffset(targetColumnIndex, scrollLeft);

  drawRect(ctx, {
    x: finalX - 0.5,
    y: 0.5,
    width: 2,
    height: containerHeight,
    fill: interactionLineColorHighlight,
  });
};

export const drawRowDraggingRegion = (ctx: CanvasRenderingContext2D, props: ILayoutDrawerProps) => {
  const { theme, mouseState, scrollState, dragState, coordInstance, getRowTreeData, getLinearRow } =
    props;
  const { columnDraggingPlaceholderBg, interactionLineColorHighlight } = theme;
  const { type, isDragging, ranges: draggingRanges, delta } = dragState;
  const { containerWidth } = coordInstance;
  const { scrollTop, scrollLeft } = scrollState;
  const { y } = mouseState;

  if (!isDragging || type !== DragRegionType.Rows) return;

  const draggingRowIndex = draggingRanges[0][0];
  drawRect(ctx, {
    x: 0.5,
    y: y - delta,
    width: containerWidth,
    height: coordInstance.getRowHeight(draggingRowIndex),
    fill: columnDraggingPlaceholderBg,
  });

  const dropTarget = getRowDropTarget(coordInstance, mouseState, scrollState);

  // dropTarget.targetIndex 是「线性行」下标（含分组头等），须 getLinearRow 取 realIndex
  // 后才能查 tree 数据（与 InteractionLayer onMouseUp 的换算一致）。
  const targetLinearRow =
    dropTarget.targetIndex != null ? getLinearRow(dropTarget.targetIndex) : null;
  const targetTree =
    targetLinearRow?.type === LinearRowType.Row
      ? getRowTreeData?.(targetLinearRow.realIndex)
      : undefined;
  const isTreeRow = typeof targetTree?.treeDepth === 'number';

  // 子记录树模式下悬停在行中段（inside）→ 高亮整行边框，提示「放入该记录作为子记录」。
  if (dropTarget.mode === 'inside' && dropTarget.targetIndex != null && isTreeRow) {
    const rowOffsetY = coordInstance.getRowOffset(dropTarget.targetIndex) - scrollTop;
    const rowHeight = coordInstance.getRowHeight(dropTarget.targetIndex);
    // 先铺一层淡色填充，再描不透明边框（drawRect 的 opacity 会同时作用于描边）。
    drawRect(ctx, {
      x: 0.5,
      y: rowOffsetY + 0.5,
      width: containerWidth - 1,
      height: rowHeight - 1,
      fill: interactionLineColorHighlight,
      opacity: 0.12,
      radius: 4,
    });
    drawRect(ctx, {
      x: 0.5,
      y: rowOffsetY + 0.5,
      width: containerWidth - 1,
      height: rowHeight - 1,
      stroke: interactionLineColorHighlight,
      radius: 4,
    });
    return;
  }

  // before/after 插入横线：端点对齐目标层级的折叠箭头 / 树引导线列位置
  // （firstColX + depth*INDENT + INDENT/2，与 drawCellContent 的 arrowX / guideX 一致），
  // 让「插到第 N 层」的落点与该层的箭头、竖向引导线严格对齐；并在线首画一个小圆点。
  const offsetY = coordInstance.getRowOffset(dropTarget.dropIndex)
  const finalY = offsetY - scrollTop

  // 端点比目标层级往外退一级：深度 N 的兄弟插入线对齐到第 (N-1) 层（父级的子连接列），
  // 与该层折叠箭头 / 竖向引导线重合；根级（depth 0）无父级，保持满宽不缩进。
  let lineStartX = 0.5
  if (isTreeRow && targetTree!.treeDepth! > 0) {
    const firstColX = coordInstance.getColumnRelativeOffset(0, scrollLeft) + 0.5
    lineStartX =
      firstColX + (targetTree!.treeDepth! - 1) * TREE_INDENT_PER_LEVEL + TREE_INDENT_PER_LEVEL / 2
  }

  drawRect(ctx, {
    x: lineStartX,
    y: finalY - 0.5,
    width: containerWidth - lineStartX,
    height: 2,
    fill: interactionLineColorHighlight,
  })

  if (lineStartX > 0.5) {
    drawRect(ctx, {
      x: lineStartX - 2.5,
      y: finalY - 3,
      width: 5,
      height: 5,
      fill: interactionLineColorHighlight,
      radius: 2.5,
    })
  }
};

export const drawColumnFreezeHandler = (
  ctx: CanvasRenderingContext2D,
  props: ILayoutDrawerProps
) => {
  const { coordInstance, mouseState, scrollState, columnFreezeState, theme } = props;
  const { isFreezing, targetIndex } = columnFreezeState;
  const { type, x, y } = mouseState;

  if (type !== RegionType.ColumnFreezeHandler && !isFreezing) return;

  const { scrollLeft } = scrollState;
  const { interactionLineColorHighlight } = theme;
  const { containerHeight, freezeRegionWidth } = coordInstance;
  const hoverX = isFreezing ? x : freezeRegionWidth;

  if (isFreezing) {
    const targetX = coordInstance.getColumnRelativeOffset(targetIndex + 1, scrollLeft);
    drawRect(ctx, {
      x: targetX - 1,
      y: 0,
      width: 2,
      height: containerHeight,
      fill: interactionLineColorHighlight,
    });
  }

  drawRect(ctx, {
    x: hoverX - columnFreezeHandlerWidth / 2,
    y: y - columnFreezeHandlerHeight / 2,
    width: columnFreezeHandlerWidth,
    height: columnFreezeHandlerHeight,
    fill: interactionLineColorHighlight,
    radius: 4,
  });
  drawRect(ctx, {
    x: hoverX - 1,
    y: 0,
    width: 2,
    height: containerHeight,
    fill: interactionLineColorHighlight,
  });
};

const setVisibleImageRegion = (props: ILayoutDrawerProps) => {
  const { imageManager, coordInstance, visibleRegion, getLinearRow } = props;
  const { startColumnIndex, stopColumnIndex, startRowIndex, stopRowIndex } = visibleRegion;
  const realStartRowIndex = getLinearRow(startRowIndex).realIndex;
  const realStopRowIndex = getLinearRow(stopRowIndex).realIndex;
  const { freezeColumnCount } = coordInstance;
  imageManager?.setWindow(
    {
      x: startColumnIndex,
      y: realStartRowIndex,
      width: stopColumnIndex - startColumnIndex,
      height: realStopRowIndex - realStartRowIndex,
    },
    freezeColumnCount
  );
};

export const drawFreezeRegionDivider = (
  ctx: CanvasRenderingContext2D,
  props: ILayoutDrawerProps,
  dividerRegion: DividerRegion
) => {
  const { theme, coordInstance, scrollState, height } = props;
  const { interactionLineColorCommon } = theme;
  const { scrollLeft } = scrollState;
  const { freezeRegionWidth, containerHeight } = coordInstance;
  const isTop = dividerRegion === DividerRegion.Top;

  const startY = isTop ? 0 : containerHeight;
  const endY = isTop ? containerHeight : height;
  const dividerHeight = endY - startY;

  if (freezeRegionWidth <= 0 || dividerHeight <= 0) {
    return;
  }

  if (scrollLeft === 0) {
    ctx.save();
    ctx.strokeStyle = theme.cellLineColor ?? '#E0E0E0';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(freezeRegionWidth + 0.5, startY);
    ctx.lineTo(freezeRegionWidth + 0.5, startY + dividerHeight);
    ctx.stroke();
    ctx.restore();
    return;
  }

  const isDarkTheme = theme.themeKey === 'dark';
  const shadowWidth = isDarkTheme ? 10 : 8;
  const shadowOpacity = isDarkTheme ? 0.18 : 0.24;
  const shadowGradient = ctx.createLinearGradient(
    freezeRegionWidth,
    0,
    freezeRegionWidth + shadowWidth,
    0
  );
  shadowGradient.addColorStop(0, interactionLineColorCommon);
  shadowGradient.addColorStop(isDarkTheme ? 0.45 : 0.35, 'transparent');
  shadowGradient.addColorStop(1, 'transparent');

  ctx.save();
  ctx.globalAlpha = shadowOpacity;
  ctx.fillStyle = shadowGradient;
  ctx.fillRect(freezeRegionWidth, startY, shadowWidth, dividerHeight);
  ctx.restore();
};

export const drawColumnHeaderBackdrop = (
  ctx: CanvasRenderingContext2D,
  props: ILayoutDrawerProps
) => {
  const { columnHeaderHeight, coordInstance, theme } = props;
  const { containerWidth, rowInitSize } = coordInstance;

  if (columnHeaderHeight === 0 || containerWidth <= 0 || rowInitSize <= 0) return;

  drawRect(ctx, {
    x: 0,
    y: 0,
    width: containerWidth,
    height: rowInitSize + 1,
    fill: theme.columnHeaderBg,
  });
};

export const drawColumnHeadersRegion = (
  ctx: CanvasRenderingContext2D,
  props: ILayoutDrawerProps
) => {
  const { columnHeaderHeight } = props;

  if (columnHeaderHeight === 0) return;

  drawColumnHeaderBackdrop(ctx, props);
  [RenderRegion.Freeze, RenderRegion.Other].forEach((r) => drawColumnHeaders(ctx, props, r));
  drawAppendColumn(ctx, props);
};

export const drawColumnStatistics = (
  ctx: CanvasRenderingContext2D,
  props: ILayoutDrawerProps,
  renderRegion: RenderRegion
  // eslint-disable-next-line sonarjs/cognitive-complexity
) => {
  const {
    coordInstance,
    columns,
    theme,
    height,
    visibleRegion,
    mouseState,
    scrollState,
    columnStatistics,
    groupCollection,
    getLinearRow,
  } = props;

  if (columnStatistics == null) return;

  const { scrollLeft, scrollTop } = scrollState;
  let { startColumnIndex, stopColumnIndex } = visibleRegion;
  const { startRowIndex, stopRowIndex } = visibleRegion;
  const { type, columnIndex: hoverColumnIndex, rowIndex: hoverRowIndex } = mouseState;
  const { rowInitSize, containerHeight, containerWidth, freezeRegionWidth, freezeColumnCount } =
    coordInstance;
  const {
    fontSizeXS,
    fontFamily,
    columnHeaderBg,
    groupHeaderBgTertiary,
    groupHeaderBgSecondary,
    groupHeaderBgPrimary,
  } = theme;
  const isFreezeRegion = renderRegion === RenderRegion.Freeze;
  const y = containerHeight + 0.5;

  startColumnIndex = isFreezeRegion ? 0 : Math.max(freezeColumnCount, startColumnIndex);
  stopColumnIndex = isFreezeRegion ? Math.max(freezeColumnCount - 1, 0) : stopColumnIndex;

  ctx.save();
  ctx.beginPath();
  ctx.rect(
    isFreezeRegion ? 0 : freezeRegionWidth,
    rowInitSize,
    isFreezeRegion ? freezeRegionWidth : containerWidth - freezeRegionWidth,
    height
  );
  ctx.clip();
  ctx.font = `${theme.fontWeight} ${fontSizeXS}px ${fontFamily}`;

  const { groupColumns } = groupCollection ?? {};

  for (let columnIndex = startColumnIndex; columnIndex <= stopColumnIndex; columnIndex++) {
    const x = coordInstance.getColumnRelativeOffset(columnIndex, scrollLeft);
    const columnWidth = coordInstance.getColumnWidth(columnIndex);
    const isFirstColumn = columnIndex === 0;
    const isColumnHovered = columnIndex === hoverColumnIndex;
    const column = columns[columnIndex];

    if (column == null) continue;

    const { id: columnId, name, statisticLabel } = column;

    if (groupColumns != null) {
      const bgList = [groupHeaderBgTertiary, groupHeaderBgSecondary, groupHeaderBgPrimary].slice(
        -groupColumns.length
      );

      for (let rowIndex = startRowIndex; rowIndex <= stopRowIndex; rowIndex++) {
        const linearRow = getLinearRow(rowIndex);
        const rowHeight = coordInstance.getRowHeight(rowIndex);
        const { type: linearRowType } = linearRow;
        const y = coordInstance.getRowOffset(rowIndex) - scrollTop;

        if (linearRowType === LinearRowType.Group) {
          const { id, depth } = linearRow;
          const text = columnStatistics[columnId ?? name]?.groups?.[id];

          const labelWidth = isFirstColumn
            ? Math.min(
                drawSingleLineText(ctx, {
                  maxWidth: columnWidth,
                  text: text ?? statisticLabel?.label ?? 'Summary',
                  needRender: false,
                  fontSize: fontSizeXS,
                }).width + cellHorizontalPadding,
                columnWidth
              )
            : columnWidth - 1;

          drawStatisticCell(ctx, {
            x: isFirstColumn ? x + columnWidth - labelWidth : x + 1,
            y: y + 1,
            textOffsetY: columnStatisticHeight / 2 - 2,
            width: labelWidth,
            height: rowHeight - 1,
            text,
            defaultLabel: statisticLabel?.label,
            bgColor: isFirstColumn && text ? bgList[depth] : undefined,
            isHovered:
              isColumnHovered && rowIndex === hoverRowIndex && type === RegionType.GroupStatistic,
            theme,
          });
        }
      }
    }

    const text = columnStatistics[columnId ?? name]?.total;

    drawStatisticCell(ctx, {
      x,
      y: y + 1,
      textOffsetY: cellVerticalPaddingMD,
      width: columnWidth,
      height: columnStatisticHeight,
      text,
      bgColor: columnHeaderBg,
      isHovered: isColumnHovered && type === RegionType.ColumnStatistic,
      showAlways: statisticLabel?.showAlways,
      defaultLabel: statisticLabel?.label,
      theme,
    });
  }

  ctx.restore();
};

export const drawStatisticCell = (
  ctx: CanvasRenderingContext2D,
  props: IGroupStatisticDrawerProps
) => {
  const {
    x,
    y,
    width,
    height,
    text,
    textOffsetY,
    isHovered,
    showAlways,
    theme,
    defaultLabel,
    bgColor,
  } = props;
  const { rowHeaderTextColor, columnStatisticBgHovered, fontSizeXS } = theme;

  if (text || isHovered || showAlways || bgColor) {
    drawRect(ctx, {
      x,
      y,
      width,
      height,
      fill: isHovered ? columnStatisticBgHovered : bgColor,
    });
  }

  const textProp: Omit<ISingleLineTextProps, 'text'> = {
    x: x + 0.5,
    y: y + (textOffsetY ?? 0.5),
    textAlign: 'right',
    maxWidth: width - cellHorizontalPadding / 2,
    fill: rowHeaderTextColor,
    fontSize: fontSizeXS,
  };

  if (isHovered || showAlways) {
    !text && drawSingleLineText(ctx, { ...textProp, text: defaultLabel || 'Summary' });
  }

  if (text) {
    drawSingleLineText(ctx, { ...textProp, text });
  }
};

export const drawColumnStatisticsRegion = (
  ctx: CanvasRenderingContext2D,
  props: ILayoutDrawerProps
) => {
  const { coordInstance, theme, columnStatistics, height } = props;
  const { containerWidth } = coordInstance;
  const { cellLineColor } = theme;
  const y = height - columnStatisticHeight + 0.5;

  if (columnStatistics == null) return;

  [RenderRegion.Freeze, RenderRegion.Other].forEach((r) => drawColumnStatistics(ctx, props, r));

  drawLine(ctx, {
    x: 0,
    y,
    points: [0, 0, containerWidth, 0],
    stroke: cellLineColor,
  });
};

export const computeShouldRerender = (current: ILayoutDrawerProps, last?: ILayoutDrawerProps) => {
  if (last == null) return true;
  return !(
    current.theme === last.theme &&
    current.columns === last.columns &&
    current.getLinearRow === last.getLinearRow &&
    current.real2RowIndex === last.real2RowIndex &&
    current.getCellContent === last.getCellContent &&
    current.prefillingRowIndexes === last.prefillingRowIndexes &&
    current.coordInstance === last.coordInstance &&
    current.visibleRegion === last.visibleRegion &&
    current.forceRenderFlag === last.forceRenderFlag
  );
};

// 每个 cacheCanvas 维护独立的 shiftCanvas，避免多 Grid 实例共享导致内容污染
const _shiftCanvasMap = new WeakMap<HTMLCanvasElement, HTMLCanvasElement>();

export const drawCacheContent = (
  cacheCanvas: HTMLCanvasElement | undefined,
  props: ICacheDrawerProps
) => {
  if (!cacheCanvas) return;

  const { containerWidth, containerHeight, pixelRatio, shouldRerender, scrollShift, draw } = props;
  const width = Math.ceil(containerWidth * pixelRatio);
  const height = Math.ceil(containerHeight * pixelRatio);

  if (cacheCanvas.width !== width || cacheCanvas.height !== height) {
    cacheCanvas.width = width;
    cacheCanvas.height = height;
  }

  const cacheCtx = cacheCanvas.getContext('2d');
  if (cacheCtx == null) return;

  const needsRestore = shouldRerender || scrollShift;

  if (shouldRerender) {
    cacheCtx.clearRect(0, 0, width, height);
    cacheCtx.save();

    if (pixelRatio !== 1) {
      cacheCtx.scale(pixelRatio, pixelRatio);
    }

    cacheCtx.beginPath();
    cacheCtx.rect(0, 0, containerWidth, containerHeight);
    cacheCtx.clip();
  } else if (scrollShift) {
    const { dx, dy } = scrollShift;
    const pxDx = Math.round(dx * pixelRatio);
    const pxDy = Math.round(dy * pixelRatio);

    let shiftCanvas = _shiftCanvasMap.get(cacheCanvas);
    if (!shiftCanvas) {
      shiftCanvas = document.createElement('canvas');
      _shiftCanvasMap.set(cacheCanvas, shiftCanvas);
    }
    if (shiftCanvas.width !== width || shiftCanvas.height !== height) {
      shiftCanvas.width = width;
      shiftCanvas.height = height;
    }
    const shiftCtx = shiftCanvas.getContext('2d');
    if (shiftCtx) {
      shiftCtx.clearRect(0, 0, width, height);
      shiftCtx.drawImage(cacheCanvas, 0, 0);

      cacheCtx.save();
      cacheCtx.setTransform(1, 0, 0, 1, 0, 0);
      cacheCtx.clearRect(0, 0, width, height);
      cacheCtx.drawImage(shiftCanvas, pxDx, pxDy);
      cacheCtx.restore();
    }

    cacheCtx.save();
    if (pixelRatio !== 1) {
      cacheCtx.scale(pixelRatio, pixelRatio);
    }

    const BUFFER = 40;
    cacheCtx.beginPath();
    if (dy < 0) {
      cacheCtx.rect(0, containerHeight + dy - BUFFER, containerWidth, -dy + BUFFER);
    } else if (dy > 0) {
      cacheCtx.rect(0, 0, containerWidth, dy + BUFFER);
    }
    if (dx < 0) {
      cacheCtx.rect(containerWidth + dx - BUFFER, 0, -dx + BUFFER, containerHeight);
    } else if (dx > 0) {
      cacheCtx.rect(0, 0, dx + BUFFER, containerHeight);
    }
    cacheCtx.clip();
  }

  draw(cacheCtx);

  if (needsRestore) {
    cacheCtx.restore();
  }
};

/**
 * Draw hover action buttons (查看 / 添加子记录) on the first column of the hovered row.
 * Drawn directly on mainCtx (NOT cached) to avoid stale buttons after hover changes.
 */
export const drawRowHoverButtons = (ctx: CanvasRenderingContext2D, props: ILayoutDrawerProps) => {
  const {
    coordInstance,
    scrollState,
    mouseState,
    theme,
    spriteManager,
    activeCell,
    getLinearRow,
    getRowTreeData,
    columns,
    commentCountMap,
    getCellContent,
  } = props;

  const { rowIndex: hoverRowIndex, type: hoverRegionType, isOutOfBounds } = mouseState;
  const { scrollTop, scrollLeft } = scrollState;
  const {
    rowInitSize,
    freezeRegionWidth,
    containerWidth,
    containerHeight,
    freezeColumnCount,
  } = coordInstance;

  if (isOutOfBounds || hoverRowIndex < 0) return;
  if (!ROW_RELATED_REGIONS.has(hoverRegionType)) return;

  const linearRow = getLinearRow(hoverRowIndex);
  if (linearRow.type !== LinearRowType.Row) return;

  const { realIndex: realRowIndex } = linearRow;

  const col0Width = coordInstance.getColumnWidth(0);
  const col0X = coordInstance.getColumnRelativeOffset(0, scrollLeft);
  const rowY = coordInstance.getRowOffset(hoverRowIndex) - scrollTop;
  const rowHeight = coordInstance.getRowHeight(hoverRowIndex);

  if (rowY + rowHeight < rowInitSize || rowY > containerHeight) return;

  const treeData = getRowTreeData?.(realRowIndex);
  const isInTreeMode = typeof treeData?.treeDepth === 'number';

  const btnSize = 16;
  const btnGap = 4;
  const btnY = rowY + (rowHeight - btnSize) / 2;

  const isFreezeColumn0 = freezeColumnCount > 0;
  const clipX = isFreezeColumn0 ? 0 : freezeRegionWidth;
  const clipW = isFreezeColumn0 ? freezeRegionWidth : containerWidth - freezeRegionWidth;

  ctx.save();
  ctx.beginPath();
  ctx.rect(clipX, rowInitSize, clipW, containerHeight - rowInitSize);
  ctx.clip();

  const firstCell = getCellContent([0, realRowIndex]);
  const hasCommentCount = Boolean(
    columns[0] && resolveCellCommentCount(firstCell, columns[0], commentCountMap),
  );
  let btnX = getRowDetailButtonBounds(
    { x: col0X, y: rowY, width: col0Width, height: rowHeight },
    hasCommentCount,
  ).x;

  ctx.fillStyle = theme.cellBgHovered ?? theme.cellBg;
  ctx.fillRect(btnX - 2, btnY - 1, btnSize + 4, btnSize + 2);
  spriteManager.drawSprite(ctx, {
    sprite: GridInnerIcon.Detail,
    x: btnX,
    y: btnY,
    size: btnSize,
    theme,
  });

  if (isInTreeMode) {
    btnX -= btnSize + btnGap;
    ctx.fillStyle = theme.cellBgHovered ?? theme.cellBg;
    ctx.fillRect(btnX - 2, btnY - 1, btnSize + 4, btnSize + 2);
    spriteManager.drawSprite(ctx, {
      sprite: GridInnerIcon.Add,
      x: btnX,
      y: btnY,
      size: btnSize,
      theme,
    });
  }

  ctx.restore();
};

export const drawGrid = (
  mainCanvas: HTMLCanvasElement,
  cacheCanvas: HTMLCanvasElement,
  props: ILayoutDrawerProps,
  lastProps?: ILayoutDrawerProps
) => {
  const { coordInstance, scrollState, height: originHeight, columnStatistics } = props;
  const { isScrolling } = scrollState;
  const { containerWidth } = coordInstance;

  if (containerWidth === 0 || originHeight === 0) return;

  const pixelRatio = window.devicePixelRatio ?? 1;
  const width = Math.ceil(containerWidth * pixelRatio);
  const height = Math.ceil(originHeight * pixelRatio);

  const dataChanged = computeShouldRerender(props, lastProps);
  let shouldRerender: boolean;
  let scrollShift: { dx: number; dy: number } | null = null;

  if (isScrolling && !dataChanged && lastProps != null) {
    const dScrollLeft = scrollState.scrollLeft - lastProps.scrollState.scrollLeft;
    const dScrollTop = scrollState.scrollTop - lastProps.scrollState.scrollTop;

    if (dScrollLeft !== 0 || Math.abs(dScrollTop) >= originHeight) {
      shouldRerender = true;
    } else if (dScrollLeft === 0 && dScrollTop === 0) {
      // Nothing actually changed during this scroll frame — skip render entirely
      return;
    } else {
      shouldRerender = false;
      scrollShift = { dx: 0, dy: -dScrollTop };
    }
  } else {
    shouldRerender = isScrolling || dataChanged;
  }

  if (mainCanvas.width !== width || mainCanvas.height !== height) {
    mainCanvas.width = width;
    mainCanvas.height = height;
    mainCanvas.style.width = containerWidth + 'px';
    mainCanvas.style.height = originHeight + 'px';
  }

  const mainCtx = mainCanvas.getContext('2d');
  if (mainCtx == null) return;

  mainCtx.clearRect(0, 0, width, height);
  mainCtx.save();

  if (pixelRatio !== 1) {
    mainCtx.scale(pixelRatio, pixelRatio);
  }

  mainCtx.beginPath();
  mainCtx.rect(0, 0, containerWidth, originHeight);
  mainCtx.clip();

  const cacheNeedsContent = shouldRerender || scrollShift != null;

  if (scrollShift && !shouldRerender) {
    drawCells(mainCtx, mainCtx, { ...props, shouldRerender: false });
  }

  drawCacheContent(cacheCanvas, {
    containerWidth,
    containerHeight: originHeight,
    pixelRatio,
    shouldRerender,
    scrollShift,
    draw: (cacheCtx) => {
      if (scrollShift && !shouldRerender) {
        const { dy } = scrollShift;
        const { startRowIndex, stopRowIndex } = props.visibleRegion;
        const rowHeight = coordInstance.rowInitSize || 33;
        const STRIP_BUFFER = 40;
        const extraRows = Math.ceil((Math.abs(dy) + STRIP_BUFFER) / rowHeight) + 2;
        let narrowRegion = props.visibleRegion;
        if (dy < 0) {
          const narrowStart = Math.max(startRowIndex, stopRowIndex - extraRows);
          narrowRegion = { ...narrowRegion, startRowIndex: narrowStart };
        } else if (dy > 0) {
          const narrowStop = Math.min(stopRowIndex, startRowIndex + extraRows);
          narrowRegion = { ...narrowRegion, stopRowIndex: narrowStop };
        }
        drawCells(mainCtx, cacheCtx, { ...props, shouldRerender: true, visibleRegion: narrowRegion });
      } else {
        drawCells(mainCtx, cacheCtx, { ...props, shouldRerender: cacheNeedsContent });
      }
    },
  });

  mainCtx.save();
  mainCtx.setTransform(1, 0, 0, 1, 0, 0);
  mainCtx.drawImage(cacheCanvas, 0, 0, width, height);
  mainCtx.restore();

  drawColumnHeadersRegion(mainCtx, props);

  drawFreezeRegionDivider(mainCtx, props, DividerRegion.Top);

  drawCollaborators(mainCtx, props);

  drawSearchTargetIndex(mainCtx, props);

  drawSearchCursor(mainCtx, props);

  drawColumnStatisticsRegion(mainCtx, props);

  drawActiveCell(mainCtx, props);

  drawRowHoverButtons(mainCtx, props);

  drawFillPreview(mainCtx, props);

  columnStatistics != null && drawFreezeRegionDivider(mainCtx, props, DividerRegion.Bottom);

  // Fill handle for vertical drag-fill
  drawFillHandler(mainCtx, props);

  drawColumnResizeHandler(mainCtx, props);

  drawRowDraggingRegion(mainCtx, props);

  drawColumnDraggingRegion(mainCtx, props);

  drawColumnFreezeHandler(mainCtx, props);

  setVisibleImageRegion(props);

  mainCtx.restore();
};
