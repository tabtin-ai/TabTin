import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useRef, useState } from 'react';
import { CombinedSelection } from '../managers';
import { SelectionRegionType, type ICellItem, type IRange } from '../interface';
import { CoordinateManager } from '../managers';
import { useKeyboardSelection } from '../hooks/useKeyboardSelection';
import { GRID_CONTAINER_ATTR } from '../configs';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const mountedRoots: Array<{ root: Root; container: HTMLDivElement }> = [];

afterEach(() => {
  for (const { root, container } of mountedRoots.splice(0)) {
    act(() => {
      root.unmount();
    });
    container.remove();
  }
});

function createCoord() {
  return new CoordinateManager({
    rowHeight: 32,
    columnWidth: 150,
    rowCount: 20,
    pureRowCount: 20,
    columnCount: 5,
    containerWidth: 400,
    containerHeight: 300,
    rowInitSize: 32,
    columnInitSize: 70,
    freezeColumnCount: 1,
  });
}

function Harness(props: {
  isEditing: boolean;
  onScrollToItem: (pos: [number, number]) => void;
  onUndo?: () => void;
  onDelete?: (selection: CombinedSelection) => void;
}) {
  const gridContainerRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef(null);
  const [activeCell, setActiveCell] = useState<ICellItem | null>([1, 2]);
  const [selection, setSelection] = useState(
    () =>
      new CombinedSelection(SelectionRegionType.Cells, [
        [1, 2] as IRange,
        [1, 2] as IRange,
      ])
  );
  const coordInstance = createCoord();

  useKeyboardSelection({
    editorRef,
    gridContainerRef,
    isEditing: props.isEditing,
    activeCell,
    selection,
    coordInstance,
    onUndo: props.onUndo,
    onDelete: props.onDelete,
    setEditing: () => undefined,
    setActiveCell,
    setSelection,
    scrollToItem: props.onScrollToItem,
    scrollBy: () => undefined,
  });

  return (
    <div ref={gridContainerRef} {...{ [GRID_CONTAINER_ATTR]: '' }}>
      <input data-testid="grid-focus" defaultValue="" />
      <span data-testid="active-cell">{activeCell ? activeCell.join(',') : 'null'}</span>
    </div>
  );
}

function renderHarness(
  isEditing: boolean,
  options?: {
    onUndo?: () => void;
    onDelete?: (selection: CombinedSelection) => void;
  }
) {
  const onScrollToItem = vi.fn();
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  mountedRoots.push({ root, container });

  act(() => {
    root.render(
      <Harness
        isEditing={isEditing}
        onScrollToItem={onScrollToItem}
        onUndo={options?.onUndo}
        onDelete={options?.onDelete}
      />
    );
  });

  const focusInput = container.querySelector('[data-testid="grid-focus"]') as HTMLInputElement;
  const activeCellEl = () =>
    container.querySelector('[data-testid="active-cell"]')?.textContent ?? '';

  return { container, focusInput, activeCellEl, onScrollToItem };
}

function dispatchArrow(target: EventTarget, key: 'ArrowDown' | 'ArrowUp' | 'ArrowLeft' | 'ArrowRight') {
  const event = new KeyboardEvent('keydown', {
    key,
    code: key,
    bubbles: true,
    cancelable: true,
  });
  act(() => {
    target.dispatchEvent(event);
  });
}

describe('useKeyboardSelection arrow navigation', () => {
  it('moves active cell and scrolls when focused inside the grid and not editing', () => {
    const { focusInput, activeCellEl, onScrollToItem } = renderHarness(false);
    focusInput.focus();
    expect(document.activeElement).toBe(focusInput);

    dispatchArrow(focusInput, 'ArrowDown');

    expect(activeCellEl()).toBe('1,3');
    expect(onScrollToItem).toHaveBeenCalledWith([1, 3]);
  });

  it('ignores arrow keys when the event originates outside the grid container', () => {
    const { activeCellEl, onScrollToItem } = renderHarness(false);
    const outside = document.createElement('textarea');
    document.body.appendChild(outside);
    outside.focus();

    dispatchArrow(outside, 'ArrowDown');

    expect(activeCellEl()).toBe('1,2');
    expect(onScrollToItem).not.toHaveBeenCalled();
    outside.remove();
  });

  it('does not move the active cell while editing', () => {
    const { focusInput, activeCellEl, onScrollToItem } = renderHarness(true);
    focusInput.focus();

    dispatchArrow(focusInput, 'ArrowDown');

    expect(activeCellEl()).toBe('1,2');
    expect(onScrollToItem).not.toHaveBeenCalled();
  });

  it('does not register mod+z when onUndo is unwired (avoids swallowing host undo)', () => {
    const { focusInput } = renderHarness(false);
    focusInput.focus();

    const event = new KeyboardEvent('keydown', {
      key: 'z',
      code: 'KeyZ',
      metaKey: true,
      bubbles: true,
      cancelable: true,
    });
    act(() => {
      focusInput.dispatchEvent(event);
    });

    // 未接线时 hotkey enabled=false，不应 preventDefault
    expect(event.defaultPrevented).toBe(false);
  });

  it('invokes onUndo for mod+z when wired and not editing', () => {
    const onUndo = vi.fn();
    const { focusInput } = renderHarness(false, { onUndo });
    focusInput.focus();

    const event = new KeyboardEvent('keydown', {
      key: 'z',
      code: 'KeyZ',
      metaKey: true,
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    act(() => {
      focusInput.dispatchEvent(event);
    });

    expect(onUndo).toHaveBeenCalledTimes(1);
  });

  it.each(['Backspace', 'Delete'] as const)(
    'invokes onDelete for %s when a cell is selected',
    (key) => {
      const onDelete = vi.fn();
      const { focusInput } = renderHarness(false, { onDelete });
      focusInput.focus();

      const event = new KeyboardEvent('keydown', {
        key,
        code: key,
        bubbles: true,
        cancelable: true,
      });
      act(() => {
        focusInput.dispatchEvent(event);
      });

      expect(onDelete).toHaveBeenCalledTimes(1);
      expect(event.defaultPrevented).toBe(true);
      expect(onDelete.mock.calls[0][0].serialize()).toEqual([
        [1, 2],
        [1, 2],
      ]);
    }
  );
});
