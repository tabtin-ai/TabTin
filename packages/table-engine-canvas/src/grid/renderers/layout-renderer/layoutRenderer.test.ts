import { describe, expect, it, vi } from 'vitest';
import {
  drawActiveCell,
  drawColumnHeaderBackdrop,
  drawGroupRow,
  drawGroupRowHeader,
  drawRowHoverButtons,
  getVisibleSearchTargetIndex,
} from './layoutRenderer';
import { LinearRowType, RegionType } from '../../interface';

const { drawGroupCell } = vi.hoisted(() => ({
  drawGroupCell: vi.fn(),
}));

vi.mock('../cell-renderer', () => ({
  getCellRenderer: () => ({ draw: drawGroupCell }),
  getCellScrollState: () => null,
}));

interface MockCanvasCall {
  type: 'beginPath' | 'rect' | 'closePath' | 'fill' | 'fillText';
  args?: number[];
  text?: string;
  fillStyle?: string | CanvasGradient | CanvasPattern;
}

interface MockCanvasContext extends Partial<CanvasRenderingContext2D> {
  calls: MockCanvasCall[];
  fillStyle: string | CanvasGradient | CanvasPattern;
}

const createMockCanvasContext = (): MockCanvasContext => {
  const ctx: MockCanvasContext = {
    calls: [],
    fillStyle: '#000000',
    beginPath: () => {
      ctx.calls.push({ type: 'beginPath' });
    },
    rect: (x: number, y: number, width: number, height: number) => {
      ctx.calls.push({ type: 'rect', args: [x, y, width, height] });
    },
    closePath: () => {
      ctx.calls.push({ type: 'closePath' });
    },
    fill: () => {
      ctx.calls.push({ type: 'fill', fillStyle: ctx.fillStyle });
    },
    fillText: (text: string) => {
      ctx.calls.push({ type: 'fillText', text });
    },
    measureText: (text: string) => ({ width: text.length * 8 }) as TextMetrics,
    save: () => undefined,
    restore: () => undefined,
  };
  return ctx;
};

describe('drawColumnHeaderBackdrop', () => {
  it('draws an opaque full-width header band before column headers', () => {
    const ctx = createMockCanvasContext();
    const props = {
      columnHeaderHeight: 32,
      coordInstance: {
        containerWidth: 640,
        rowInitSize: 32,
      },
      theme: {
        columnHeaderBg: '#f8fafc',
      },
    } as unknown as Parameters<typeof drawColumnHeaderBackdrop>[1];

    drawColumnHeaderBackdrop(ctx as unknown as CanvasRenderingContext2D, props);

    expect(ctx.calls).toEqual([
      { type: 'beginPath' },
      { type: 'rect', args: [0, 0, 640, 33] },
      { type: 'closePath' },
      { type: 'fill', fillStyle: '#f8fafc' },
    ]);
  });

  it('does not draw when the column header is hidden', () => {
    const ctx = createMockCanvasContext();
    const props = {
      columnHeaderHeight: 0,
      coordInstance: {
        containerWidth: 640,
        rowInitSize: 32,
      },
      theme: {
        columnHeaderBg: '#f8fafc',
      },
    } as unknown as Parameters<typeof drawColumnHeaderBackdrop>[1];

    drawColumnHeaderBackdrop(ctx as unknown as CanvasRenderingContext2D, props);

    expect(ctx.calls).toEqual([]);
  });
});

describe('getVisibleSearchTargetIndex', () => {
  it('deduplicates a logical cell repeated by the visible column projection', () => {
    const getCellContent = vi.fn((cell: [number, number]) => ({
      id: cell[0] < 2 ? 'record-1-field-title' : `record-1-field-${cell[0]}`,
    }));

    const result = getVisibleSearchTargetIndex(
      [{ recordId: 'record-1', fieldId: 'field-title' }],
      { startColumnIndex: 0, stopColumnIndex: 1, startRowIndex: 0, stopRowIndex: 0 },
      2,
      getCellContent,
      () => ({ type: LinearRowType.Row, displayIndex: 0, realIndex: 0 }),
    );

    expect(result).toEqual([[0, 0]]);
  });

  it('keeps distinct matching cells as separate search targets', () => {
    const result = getVisibleSearchTargetIndex(
      [
        { recordId: 'record-1', fieldId: 'field-title' },
        { recordId: 'record-1', fieldId: 'field-status' },
      ],
      { startColumnIndex: 0, stopColumnIndex: 1, startRowIndex: 0, stopRowIndex: 0 },
      0,
      (cell: [number, number]) => ({
        id: cell[0] === 0 ? 'record-1-field-title' : 'record-1-field-status',
      }),
      () => ({ type: LinearRowType.Row, displayIndex: 0, realIndex: 0 }),
    );

    expect(result).toEqual([
      [0, 0],
      [1, 0],
    ]);
  });

  it.each([LinearRowType.Group, LinearRowType.Append])(
    'does not turn %s layout rows into record search targets',
    (rowType) => {
      const getCellContent = vi.fn(() => ({ id: 'record-1-field-title' }));
      const result = getVisibleSearchTargetIndex(
        [{ recordId: 'record-1', fieldId: 'field-title' }],
        { startColumnIndex: 0, stopColumnIndex: 0, startRowIndex: 0, stopRowIndex: 0 },
        0,
        getCellContent,
        () => ({ type: rowType, displayIndex: 0, realIndex: 0 }),
      );

      expect(result).toEqual([]);
      expect(getCellContent).not.toHaveBeenCalled();
    },
  );

  it('keeps record coordinates accurate when group rows share the visible region', () => {
    const result = getVisibleSearchTargetIndex(
      [{ recordId: 'record-2', fieldId: 'field-title' }],
      { startColumnIndex: 0, stopColumnIndex: 0, startRowIndex: 0, stopRowIndex: 1 },
      0,
      ([, rowIndex]: [number, number]) => ({
        id: rowIndex === 7 ? 'record-2-field-title' : 'record-1-field-title',
      }),
      (rowIndex: number) =>
        rowIndex === 0
          ? { type: LinearRowType.Group, displayIndex: 0, realIndex: 0 }
          : { type: LinearRowType.Row, displayIndex: 1, realIndex: 7 },
    );

    expect(result).toEqual([[0, 7]]);
  });
});

describe('drawActiveCell', () => {
  it('skips the canvas preview while editing so the DOM editor has no ghost layer beneath it', () => {
    const ctx = createMockCanvasContext();

    drawActiveCell(
      ctx as unknown as CanvasRenderingContext2D,
      { isEditing: true } as Parameters<typeof drawActiveCell>[1]
    );

    expect(ctx.calls).toEqual([]);
  });
});

describe('drawRowHoverButtons', () => {
  it('draws the detail button before the comment count tag', () => {
    const ctx = createMockCanvasContext() as MockCanvasContext & {
      clip: () => void;
      fillRect: () => void;
    };
    ctx.clip = () => undefined;
    ctx.fillRect = () => undefined;
    const drawSprite = vi.fn();

    drawRowHoverButtons(
      ctx as unknown as CanvasRenderingContext2D,
      {
        coordInstance: {
          rowInitSize: 32,
          freezeRegionWidth: 240,
          containerWidth: 640,
          containerHeight: 480,
          freezeColumnCount: 1,
          getColumnWidth: () => 200,
          getColumnRelativeOffset: () => 40,
          getRowOffset: () => 64,
          getRowHeight: () => 32,
        },
        scrollState: { scrollTop: 0, scrollLeft: 0 },
        mouseState: { rowIndex: 0, type: RegionType.Cell, isOutOfBounds: false },
        theme: { cellBgHovered: '#222', cellBg: '#111' },
        spriteManager: { drawSprite },
        getLinearRow: () => ({ type: LinearRowType.Row, realIndex: 0 }),
        getRowTreeData: () => null,
        columns: [{ id: 'field-title', name: 'Title', isPrimary: true }],
        commentCountMap: { 'record-1': 2 },
        getCellContent: () => ({ id: 'record-1-field-title' }),
      } as unknown as Parameters<typeof drawRowHoverButtons>[1],
    );

    expect(drawSprite).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ x: 196, y: 72, size: 16 }),
    );
  });
});

describe('drawGroupRowHeader', () => {
  it('aligns the top-level group toggle with the row-header control axis', () => {
    const ctx = createMockCanvasContext();
    const drawSprite = vi.fn();

    drawGroupRowHeader(
      ctx as unknown as CanvasRenderingContext2D,
      {
        x: 0.5,
        y: 10,
        width: 32,
        height: 40,
        depth: 0,
        isCollapsed: false,
        theme: {
          iconSizeSM: 16,
          cellLineColor: '#ddd',
          groupHeaderBgPrimary: '#fff',
          groupHeaderBgSecondary: '#fafafa',
          groupHeaderBgTertiary: '#f5f5f5',
        },
        spriteManager: { drawSprite },
        groupCollection: { groupColumns: [{ name: 'assignee' }] },
      } as unknown as Parameters<typeof drawGroupRowHeader>[1]
    );

    expect(drawSprite).toHaveBeenCalledWith(
      ctx,
      expect.objectContaining({ x: 8, y: 22, size: 16 })
    );
  });

  it('indents each nested group toggle by one level', () => {
    const ctx = createMockCanvasContext();
    const drawSprite = vi.fn();

    drawGroupRowHeader(
      ctx as unknown as CanvasRenderingContext2D,
      {
        x: 0.5,
        y: 10,
        width: 32,
        height: 40,
        depth: 1,
        isCollapsed: true,
        theme: {
          iconSizeSM: 16,
          cellLineColor: '#ddd',
          groupHeaderBgPrimary: '#fff',
          groupHeaderBgSecondary: '#fafafa',
          groupHeaderBgTertiary: '#f5f5f5',
        },
        spriteManager: { drawSprite },
        groupCollection: { groupColumns: [{ name: 'assignee' }, { name: 'status' }] },
      } as unknown as Parameters<typeof drawGroupRowHeader>[1]
    );

    expect(drawSprite).toHaveBeenCalledWith(
      ctx,
      expect.objectContaining({ x: 24, y: 22, size: 16 })
    );
  });
});

describe('drawGroupRow', () => {
  it('renders only the group value and vertically centers a standard-height cell', () => {
    const ctx = createMockCanvasContext();
    const cell = { type: 'text', data: 'user_5837' };

    drawGroupRow(
      ctx as unknown as CanvasRenderingContext2D,
      {
        x: 0,
        y: 10,
        width: 240,
        height: 40,
        depth: 0,
        columnIndex: 0,
        rowIndex: 0,
        value: 'user-id',
        theme: {
          fontWeight: 400,
          fontSizeSM: 12,
          fontFamily: 'sans-serif',
          cellLineColor: '#ddd',
          rowHeaderTextColor: '#666',
          groupHeaderBgPrimary: '#fff',
          groupHeaderBgSecondary: '#fafafa',
          groupHeaderBgTertiary: '#f5f5f5',
        },
        groupCollection: {
          groupColumns: [{ name: '23' }],
          getGroupCell: () => cell,
        },
        imageManager: {},
        spriteManager: {},
      } as unknown as Parameters<typeof drawGroupRow>[1]
    );

    expect(ctx.calls.filter(call => call.type === 'fillText')).toEqual([]);
    expect(drawGroupCell).toHaveBeenCalledWith(
      cell,
      expect.objectContaining({
        rect: { x: 0, y: 14, width: 240, height: 32 },
      })
    );
  });
});
