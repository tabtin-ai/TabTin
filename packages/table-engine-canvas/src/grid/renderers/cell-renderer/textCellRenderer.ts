import { GRID_DEFAULT } from '../../configs';
import { drawMultiLineText } from '../base-renderer/baseRenderer';
import { CellType } from './interface';
import type {
  IInternalCellRenderer,
  ITextCell,
  ICellRenderProps,
  ICellMeasureProps,
} from './interface';

const { maxRowCount, cellHorizontalPadding, cellVerticalPaddingMD, cellTextLineHeight } =
  GRID_DEFAULT;

const MAX_DISPLAY_LENGTH = 10000;

function getSafeDisplayData(displayData: unknown): string | undefined {
  if (displayData == null || displayData === '') return undefined;
  const str = typeof displayData === 'string' ? displayData : String(displayData);
  if (str.length <= MAX_DISPLAY_LENGTH) return str;
  return str.slice(0, MAX_DISPLAY_LENGTH) + '…';
}

export const textCellRenderer: IInternalCellRenderer<ITextCell> = {
  type: CellType.Text,
  measure: (cell: ITextCell, props: ICellMeasureProps) => {
    const { displayData } = cell;
    const { ctx, theme, width, height } = props;
    const { cellTextColor } = theme;

    const safeData = getSafeDisplayData(displayData);
    if (!safeData) {
      return { width, height, totalHeight: height };
    }

    const lineCount = drawMultiLineText(ctx, {
      text: safeData,
      maxLines: Infinity,
      lineHeight: cellTextLineHeight,
      maxWidth: width - cellHorizontalPadding * 2,
      fill: cellTextColor,
      needRender: false,
    }).length;

    const totalHeight = cellVerticalPaddingMD + lineCount * cellTextLineHeight;
    const displayRowCount = Math.min(maxRowCount, lineCount);

    return {
      width,
      height: Math.max(height, cellVerticalPaddingMD + displayRowCount * cellTextLineHeight),
      totalHeight,
    };
  },
  draw: (cell: ITextCell, props: ICellRenderProps) => {
    const { displayData } = cell;
    const { ctx, rect, theme, isActive } = props;
    const { x, y, width, height } = rect;

    const safeData = getSafeDisplayData(displayData);
    if (!safeData) return;

    const { cellTextColor } = theme;
    const renderHeight = height - cellVerticalPaddingMD;

    drawMultiLineText(ctx, {
      x: x + cellHorizontalPadding,
      y: y + cellVerticalPaddingMD,
      text: safeData,
      maxLines: isActive ? Infinity : Math.max(Math.floor(renderHeight / cellTextLineHeight), 1),
      lineHeight: cellTextLineHeight,
      maxWidth: width - cellHorizontalPadding * 2,
      fill: cellTextColor,
    });
  },
};
