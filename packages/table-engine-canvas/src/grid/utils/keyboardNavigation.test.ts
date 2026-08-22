import { GRID_CONTAINER_ATTR } from '../configs';
import {
  computeScrollToItem,
  estimatePageRowDelta,
  isEventOutsideContainer,
  resolveArrowDirectionFromEvent,
  resolveCellNavigationMove,
  resolvePageNavigationRow,
} from './keyboardNavigation';

describe('resolveArrowDirectionFromEvent', () => {
  it('resolves from KeyboardEvent.key', () => {
    expect(resolveArrowDirectionFromEvent({ key: 'ArrowDown' })).toBe('down');
    expect(resolveArrowDirectionFromEvent({ key: 'ArrowLeft' })).toBe('left');
  });

  it('resolves from hotkeys-hook parsed keys (arrowdown alias)', () => {
    expect(
      resolveArrowDirectionFromEvent({ key: 'Unidentified' }, { keys: ['arrowdown'] })
    ).toBe('down');
    expect(resolveArrowDirectionFromEvent({ key: 'Unidentified' }, { keys: ['up'] })).toBe('up');
  });
});

describe('isEventOutsideContainer', () => {
  it('allows events whose target is inside the provided grid container', () => {
    const container = document.createElement('div');
    container.setAttribute(GRID_CONTAINER_ATTR, '');
    const focusInput = document.createElement('input');
    container.appendChild(focusInput);
    document.body.appendChild(container);

    const event = new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true });
    Object.defineProperty(event, 'target', { value: focusInput });

    expect(isEventOutsideContainer(event, container)).toBe(false);

    container.remove();
  });

  it('rejects events whose target is outside the grid (e.g. sidebar composer)', () => {
    const container = document.createElement('div');
    container.setAttribute(GRID_CONTAINER_ATTR, '');
    document.body.appendChild(container);

    const outside = document.createElement('textarea');
    document.body.appendChild(outside);

    const event = new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true });
    Object.defineProperty(event, 'target', { value: outside });

    expect(isEventOutsideContainer(event, container)).toBe(true);

    container.remove();
    outside.remove();
  });

  it('falls back to closest grid container when container ref is null', () => {
    const container = document.createElement('div');
    container.setAttribute(GRID_CONTAINER_ATTR, '');
    const focusInput = document.createElement('input');
    container.appendChild(focusInput);
    document.body.appendChild(container);

    const event = new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true });
    Object.defineProperty(event, 'target', { value: focusInput });

    expect(isEventOutsideContainer(event, null)).toBe(false);

    container.remove();
  });
});

describe('resolveCellNavigationMove', () => {
  it('moves active cell by one step within bounds', () => {
    expect(
      resolveCellNavigationMove({
        columnIndex: 2,
        rowIndex: 3,
        direction: 'down',
        columnCount: 5,
        pureRowCount: 10,
      })
    ).toEqual({ columnIndex: 2, rowIndex: 4 });

    expect(
      resolveCellNavigationMove({
        columnIndex: 0,
        rowIndex: 0,
        direction: 'up',
        columnCount: 5,
        pureRowCount: 10,
      })
    ).toEqual({ columnIndex: 0, rowIndex: 0 });

    expect(
      resolveCellNavigationMove({
        columnIndex: 4,
        rowIndex: 1,
        direction: 'right',
        columnCount: 5,
        pureRowCount: 10,
      })
    ).toEqual({ columnIndex: 4, rowIndex: 1 });
  });

  it('jumps to edges with mod', () => {
    expect(
      resolveCellNavigationMove({
        columnIndex: 2,
        rowIndex: 3,
        direction: 'up',
        columnCount: 5,
        pureRowCount: 10,
        isMod: true,
      })
    ).toEqual({ columnIndex: 2, rowIndex: 0 });

    expect(
      resolveCellNavigationMove({
        columnIndex: 2,
        rowIndex: 3,
        direction: 'right',
        columnCount: 5,
        pureRowCount: 10,
        isMod: true,
      })
    ).toEqual({ columnIndex: 4, rowIndex: 3 });
  });
});

describe('resolvePageNavigationRow / estimatePageRowDelta', () => {
  it('estimates page delta from viewport height', () => {
    expect(
      estimatePageRowDelta({
        containerHeight: 32 + 32 * 10,
        rowInitSize: 32,
        rowHeight: 32,
      })
    ).toBe(9);
  });

  it('moves active row by a page and clamps to bounds', () => {
    expect(
      resolvePageNavigationRow({
        rowIndex: 5,
        direction: 'down',
        pureRowCount: 20,
        pageRowDelta: 8,
      })
    ).toBe(13);

    expect(
      resolvePageNavigationRow({
        rowIndex: 2,
        direction: 'up',
        pureRowCount: 20,
        pageRowDelta: 8,
      })
    ).toBe(0);
  });
});

describe('computeScrollToItem', () => {
  const base = {
    columnIndex: 3,
    rowIndex: 10,
    scrollLeft: 0,
    scrollTop: 0,
    containerWidth: 400,
    containerHeight: 300,
    freezeRegionWidth: 70,
    freezeColumnCount: 1,
    rowInitSize: 32,
    columnOffset: 70 + 150 * 3,
    columnWidth: 150,
    rowOffset: 32 + 32 * 10,
    rowHeight: 32,
    cellScrollBuffer: 16,
  };

  it('returns empty when the cell is already fully visible', () => {
    expect(
      computeScrollToItem({
        ...base,
        columnIndex: 1,
        columnOffset: 70 + 150,
        rowIndex: 1,
        rowOffset: 32 + 32,
      })
    ).toEqual({});
  });

  it('scrolls vertically when the target row is below the viewport', () => {
    const result = computeScrollToItem(base);
    expect(result.scrollTop).toBeGreaterThan(0);
    // row bottom (32+320+32=384) - containerHeight 300 = 84
    expect(result.scrollTop).toBe(84);
  });

  it('scrolls horizontally with buffer when the target column is offscreen', () => {
    const result = computeScrollToItem({
      ...base,
      columnOffset: 70 + 150 * 5,
      columnIndex: 5,
      rowIndex: 0,
      rowOffset: 32,
    });
    expect(result.scrollLeft).toBeGreaterThan(0);
    expect(result.scrollTop).toBeUndefined();
  });

  it('does not scroll horizontally for freeze columns', () => {
    const result = computeScrollToItem({
      ...base,
      columnIndex: 0,
      columnOffset: 0,
      scrollLeft: 200,
      rowIndex: 0,
      rowOffset: 32,
    });
    expect(result.scrollLeft).toBeUndefined();
  });
});
