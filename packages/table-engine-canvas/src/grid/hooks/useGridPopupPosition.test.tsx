import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { GRID_CONTAINER_ATTR } from '../configs';
import { useGridPopupPosition } from './useGridPopupPosition';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mountedRoots: Array<{ root: Root; container: HTMLDivElement }> = [];

afterEach(() => {
  for (const { root, container } of mountedRoots.splice(0)) {
    act(() => {
      root.unmount();
    });
    container.remove();
  }
});

function Harness({
  editorId,
  x = 10,
  y = 20,
  width = 120,
  height = 32,
}: {
  editorId: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
}) {
  const style = useGridPopupPosition({ editorId, x, y, width, height }, 340);
  return <div data-testid="popup-style">{style ? JSON.stringify(style) : 'undefined'}</div>;
}

function mount(ui: ReactElement) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  mountedRoots.push({ root, container });
  act(() => {
    root.render(ui);
  });
  return container;
}

describe('useGridPopupPosition', () => {
  it('does not throw when editorId starts with a digit', () => {
    expect(() => {
      mount(<Harness editorId="1-inline-attachment-editor" />);
    }).not.toThrow();

    const text = document.querySelector('[data-testid="popup-style"]')?.textContent;
    expect(text).toBe('undefined');
  });

  it('resolves popup style via getElementById for digit-leading ids', () => {
    const grid = document.createElement('div');
    grid.setAttribute(GRID_CONTAINER_ATTR, '');
    Object.defineProperty(grid, 'getBoundingClientRect', {
      configurable: true,
      value: () =>
        ({
          x: 0,
          y: 100,
          width: 800,
          height: 600,
          top: 100,
          left: 0,
          right: 800,
          bottom: 700,
          toJSON() {
            return {};
          },
        }) as DOMRect,
    });

    const editor = document.createElement('div');
    editor.id = '1-inline-attachment-editor';
    grid.appendChild(editor);
    document.body.appendChild(grid);

    try {
      expect(() => {
        mount(<Harness editorId="1-inline-attachment-editor" />);
      }).not.toThrow();

      const text = document.querySelector('[data-testid="popup-style"]')?.textContent;
      expect(text).not.toBe('undefined');
      const style = JSON.parse(text ?? '{}') as { maxHeight?: number };
      expect(typeof style.maxHeight).toBe('number');
    } finally {
      grid.remove();
    }
  });
});
