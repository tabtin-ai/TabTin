import type { IGridTheme } from '../../configs';
import { GRID_DEFAULT } from '../../configs';
import type { IRectangle } from '../../interface';
import { measuredCanvas } from '../../utils';
import { CellRegionType, CellType } from './interface';
import type {
  IInternalCellRenderer,
  ICellRenderProps,
  ILinkCell,
  ILinkCellValue,
  ICellClickProps,
  ICellClickCallback,
  ICellMeasureProps,
} from './interface';

const TAG_HEIGHT = 22;
const TAG_PADDING_X = 8;
const TAG_GAP = 4;
const TAG_RADIUS = 4;
const TAG_ROW_GAP = 3;

const { cellHorizontalPadding, cellVerticalPaddingMD, maxRowCount } = GRID_DEFAULT;

interface ITagPosition {
  /** Tag index (maps to data item) */
  index: number;
  /** Tag bounds within cell */
  x: number;
  y: number;
  width: number;
  height: number;
  /** Truncated display text */
  text: string;
  /** Link record id */
  link: string;
}

interface IComputeTagPositionProps {
  ctx: CanvasRenderingContext2D;
  data: ILinkCellValue[];
  rect: IRectangle;
  theme: IGridTheme;
  isActive?: boolean;
}

/**
 * Compute tag positions for link cell values.
 * Tags flow left-to-right, wrapping to next row when they exceed available width.
 */
const computeTagPositions = ({
  ctx,
  data,
  rect,
  theme,
  isActive,
}: IComputeTagPositionProps): ITagPosition[] => {
  const positions: ITagPosition[] = [];
  const { x: originX, y: originY, width, height } = rect;
  const { fontSizeSM } = theme;
  const drawWidth = width - 2 * cellHorizontalPadding;
  const rowHeight = TAG_HEIGHT + TAG_ROW_GAP;
  const drawHeight = height - cellVerticalPaddingMD;
  const maxRows = isActive ? Infinity : Math.max(1, Math.floor(drawHeight / rowHeight));

  let row = 0;
  let cursorX = originX + cellHorizontalPadding;
  let cursorY = data.length > 1
    ? originY + cellVerticalPaddingMD / 2
    : originY + Math.max(4, (height - TAG_HEIGHT) / 2);

  const { fontFamily = 'sans-serif', fontWeight = '' } = theme;
  ctx.font = `${fontWeight} ${fontSizeSM}px ${fontFamily}`.trim();

  for (let i = 0; i < data.length; i++) {
    if (row >= maxRows) break;

    const item = data[i];
    const displayText = item.title || item.id;

    // Measure text width + padding
    const textMetrics = ctx.measureText(displayText);
    let tagTextWidth = textMetrics.width;
    let tagWidth = tagTextWidth + TAG_PADDING_X * 2;

    // Clamp tag width to available draw width
    const maxTagWidth = drawWidth;
    let truncatedText = displayText;

    if (tagWidth > maxTagWidth) {
      // Binary search for optimal truncation length
      let lo = 1, hi = displayText.length - 1, bestLen = 0;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const tw = ctx.measureText(displayText.slice(0, mid) + '…').width;
        if (tw + TAG_PADDING_X * 2 <= maxTagWidth) {
          bestLen = mid;
          lo = mid + 1;
        } else {
          hi = mid - 1;
        }
      }
      truncatedText = displayText.slice(0, bestLen) + '…';
      tagTextWidth = ctx.measureText(truncatedText).width;
      tagWidth = tagTextWidth + TAG_PADDING_X * 2;
    }

    // Wrap to next row if tag doesn't fit
    if (cursorX + tagWidth > originX + width - cellHorizontalPadding && cursorX > originX + cellHorizontalPadding) {
      row++;
      if (row >= maxRows) break;
      cursorX = originX + cellHorizontalPadding;
      cursorY += rowHeight;
    }

    positions.push({
      index: i,
      x: cursorX,
      y: cursorY,
      width: tagWidth,
      height: TAG_HEIGHT,
      text: truncatedText,
      link: item.id,
    });

    cursorX += tagWidth + TAG_GAP;
  }

  return positions;
};

/**
 * Rounded-rect helper for drawing tag backgrounds.
 */
const drawRoundRect = (
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
) => {
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + width - radius, y);
  ctx.arcTo(x + width, y, x + width, y + radius, radius);
  ctx.lineTo(x + width, y + height - radius);
  ctx.arcTo(x + width, y + height, x + width - radius, y + height, radius);
  ctx.lineTo(x + radius, y + height);
  ctx.arcTo(x, y + height, x, y + height - radius, radius);
  ctx.lineTo(x, y + radius);
  ctx.arcTo(x, y, x + radius, y, radius);
  ctx.closePath();
};

export const linkCellRenderer: IInternalCellRenderer<ILinkCell> = {
  type: CellType.Link,
  needsHover: true,
  needsHoverPosition: true,
  measure: (cell: ILinkCell, props: ICellMeasureProps) => {
    const { data } = cell;
    const { ctx, theme, width, height } = props;

    if (!data.length) {
      return { width, height, totalHeight: height };
    }

    const tagPositions = computeTagPositions({
      ctx,
      data,
      rect: { x: 0, y: 0, width, height },
      theme,
      isActive: true,
    });

    if (!tagPositions.length) return { width, height, totalHeight: height };

    const lastTag = tagPositions[tagPositions.length - 1];
    const totalHeight = lastTag.y + lastTag.height + cellVerticalPaddingMD / 2;
    const rowHeight = TAG_HEIGHT + TAG_ROW_GAP;
    const maxHeight = cellVerticalPaddingMD + maxRowCount * rowHeight;
    const finalHeight = Math.max(Math.min(totalHeight, maxHeight), height);

    return {
      width,
      height: finalHeight,
      totalHeight,
    };
  },

  draw: (cell: ILinkCell, props: ICellRenderProps) => {
    const { ctx, rect, theme, hoverCellPosition, isActive } = props;
    const { data } = cell;
    const { x: originX, y: originY, width: originWidth, height: originHeight } = rect;
    const [hoverX, hoverY] = hoverCellPosition || [-1, -1];
    const { fontSizeSM, cellOptionBg, cellOptionBgHighlight, cellTextColor } = theme;

    ctx.save();
    ctx.beginPath();

    if (data.length && !isActive) {
      ctx.rect(originX, originY, originWidth, originHeight);
      ctx.clip();
    }

    const tagPositions = computeTagPositions({
      ctx,
      data,
      rect,
      theme,
      isActive,
    });

    const { fontFamily = 'sans-serif', fontWeight = '' } = theme;
    ctx.font = `${fontWeight} ${fontSizeSM}px ${fontFamily}`.trim();
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';

    for (const tag of tagPositions) {
      const { x, y, width, height, text } = tag;

      // Check hover state
      const isHovered =
        hoverX >= x - originX &&
        hoverX <= x - originX + width &&
        hoverY >= y - originY &&
        hoverY <= y - originY + height;

      // Draw rounded tag background
      const bgColor = isHovered ? (cellOptionBgHighlight ?? cellOptionBg) : cellOptionBg;
      ctx.fillStyle = bgColor;
      drawRoundRect(ctx, x, y, width, height, TAG_RADIUS);
      ctx.fill();

      // Draw text
      ctx.fillStyle = cellTextColor;
      ctx.fillText(text, x + TAG_PADDING_X, y + height / 2);
    }

    ctx.restore();
  },

  checkRegion: (cell: ILinkCell, props: ICellClickProps, _shouldCalculate?: boolean) => {
    const { hoverCellPosition, width, height, isActive, theme, activeCellBound } = props;
    if (!hoverCellPosition || measuredCanvas == null) return { type: CellRegionType.Blank };
    const [hoverX, originHoverY] = hoverCellPosition;
    const { fontSizeSM } = theme;
    const { data } = cell;
    const { ctx } = measuredCanvas;
    if (!ctx) return { type: CellRegionType.Blank };

    const scrollTop = activeCellBound?.scrollTop ?? 0;
    const hoverY = originHoverY + scrollTop;

    const { fontFamily = 'sans-serif', fontWeight = '' } = theme;
    ctx.font = `${fontWeight} ${fontSizeSM}px ${fontFamily}`.trim();

    const tagPositions = computeTagPositions({
      ctx,
      data,
      rect: { x: 0, y: 0, width, height },
      theme,
      isActive,
    });

    for (const tag of tagPositions) {
      const { x, y, width: tagW, height: tagH, link } = tag;
      if (hoverX >= x && hoverX <= x + tagW && hoverY >= y && hoverY <= y + tagH) {
        return { type: CellRegionType.Preview, data: link };
      }
    }
    return { type: CellRegionType.Blank };
  },

  onClick: (cell: ILinkCell, props: ICellClickProps, _callback: ICellClickCallback) => {
    const cellRegion = linkCellRenderer.checkRegion?.(cell, props, true);

    // 飞书式语义：只有点到链接 tag 文字（Preview 命中）才跳转，不要求单元格已 active。
    // 点空白不在此处理——由 InteractionLayer 的选区逻辑激活单元格，双击 / 键盘输入进编辑。
    if (cellRegion?.type === CellRegionType.Preview && cell.onClick) {
      cell.onClick(cellRegion.data as string);
      return;
    }

    if (!props.isActive) return;

    // 记录型链接（有 onExpand）在已激活时点空白展开关联记录面板；URL/email/phone 无 onExpand，不动作。
    if (cell.onExpand) {
      cell.onExpand();
    }
  },
};
