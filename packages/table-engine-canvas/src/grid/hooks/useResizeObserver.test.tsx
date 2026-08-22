import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useResizeObserver } from './useResizeObserver';

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

function Harness() {
  const { ref, width, height } = useResizeObserver<HTMLDivElement>();
  return (
    <div
      ref={ref}
      data-testid="size-target"
      data-width={width}
      data-height={height}
      style={{ width: '100%', height: '100%' }}
    />
  );
}

function mockBoundingRect(el: HTMLElement, width: number, height: number) {
  Object.defineProperty(el, 'getBoundingClientRect', {
    configurable: true,
    value: () =>
      ({
        width,
        height,
        top: 0,
        left: 0,
        bottom: height,
        right: width,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }) as DOMRect,
  });
  Object.defineProperty(el, 'clientWidth', { configurable: true, value: width });
  Object.defineProperty(el, 'clientHeight', { configurable: true, value: height });
}

describe('useResizeObserver ( zero-size probe)', () => {
  it('recovers from 0×0 parking size even when ResizeObserver stays silent', async () => {
    // Silent RO: never invokes callback — simulates missed parking→slot notify
    class SilentResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    vi.stubGlobal('ResizeObserver', SilentResizeObserver);

    const host = document.createElement('div');
    document.body.appendChild(host);
    mockBoundingRect(host, 0, 0);

    const root = createRoot(host);
    mountedRoots.push({ root, container: host });

    act(() => {
      root.render(<Harness />);
    });

    const target = host.querySelector('[data-testid="size-target"]') as HTMLElement;
    expect(target).toBeTruthy();
    mockBoundingRect(target, 0, 0);

    await act(async () => {
      await Promise.resolve();
    });

    expect(target.getAttribute('data-width')).toBe('0');
    expect(target.getAttribute('data-height')).toBe('0');

    // Simulate portal move: element now has real slot size
    mockBoundingRect(target, 908, 640);

    await act(async () => {
      for (let i = 0; i < 5; i += 1) {
        await new Promise<void>((resolve) => {
          requestAnimationFrame(() => resolve());
        });
      }
    });

    expect(target.getAttribute('data-width')).toBe('908');
    expect(target.getAttribute('data-height')).toBe('640');
  });
});
