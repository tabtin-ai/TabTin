import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { InfiniteScroller, type ScrollerProps } from './InfiniteScroller';
import { LinearRowType, type IScrollState } from './interface';
import type { CoordinateManager } from './managers';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const mountedRoots: Array<{
  root: Root;
  host: HTMLDivElement;
  wheelTarget: HTMLDivElement;
}> = [];

afterEach(() => {
  for (const { root, host, wheelTarget } of mountedRoots.splice(0)) {
    act(() => root.unmount());
    host.remove();
    wheelTarget.remove();
  }
  vi.unstubAllGlobals();
});

const makeCoordinateManager = () =>
  ({
    containerHeight: 300,
    rowInitSize: 0,
    rowHeight: 20,
    columnInitSize: 0,
    rowCount: 100,
    columnCount: 100,
    getRowStartIndex: (scrollTop: number) => Math.floor(scrollTop / 20),
    getRowStopIndex: (startIndex: number) => startIndex + 10,
    getRowOffset: (rowIndex: number) => rowIndex * 20,
    getColumnStartIndex: (scrollLeft: number) => Math.floor(scrollLeft / 100),
    getColumnStopIndex: (startIndex: number) => startIndex + 5,
    getColumnOffset: (columnIndex: number) => columnIndex * 100,
  }) as unknown as CoordinateManager;

const mountBasicScroller = (wheelTarget: HTMLDivElement) => {
  const host = document.createElement('div');
  document.body.append(host, wheelTarget);
  const root = createRoot(host);
  mountedRoots.push({ root, host, wheelTarget });

  act(() => {
    root.render(
      <InfiniteScroller
        coordInstance={makeCoordinateManager()}
        containerWidth={400}
        containerHeight={300}
        scrollWidth={2_000}
        scrollHeight={2_000}
        containerRef={{ current: wheelTarget }}
        smoothScrollX
        smoothScrollY
        scrollBarVisible={false}
        scrollState={{ scrollLeft: 0, scrollTop: 0, isScrolling: false }}
        getLinearRow={(index) => ({
          type: LinearRowType.Row,
          displayIndex: index,
          realIndex: index,
        })}
        setScrollState={vi.fn() as ScrollerProps['setScrollState']}
      />,
    );
  });

  return {
    horizontalScroller: host.querySelector<HTMLElement>('.tt-grid-scrollbar-horizontal'),
    verticalScroller: host.querySelector<HTMLElement>('.tt-grid-scrollbar-vertical'),
  };
};

describe('InfiniteScroller trackpad scrolling', () => {
  it('continues from the saved position when portal parking resets native scrollbars', () => {
    const animationFrames: FrameRequestCallback[] = [];
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn((callback: FrameRequestCallback) => {
        animationFrames.push(callback);
        return animationFrames.length;
      }),
    );
    vi.stubGlobal('cancelAnimationFrame', vi.fn());

    const flushAnimationFrames = () => {
      for (const frame of animationFrames.splice(0)) frame(16);
    };

    const host = document.createElement('div');
    const wheelTarget = document.createElement('div');
    document.body.append(host, wheelTarget);
    const root = createRoot(host);
    mountedRoots.push({ root, host, wheelTarget });

    const renderScroller = (scrollLeft: number, scrollTop: number) => {
      root.render(
        <InfiniteScroller
          coordInstance={makeCoordinateManager()}
          containerWidth={400}
          containerHeight={300}
          scrollWidth={2_000}
          scrollHeight={2_000}
          containerRef={{ current: wheelTarget }}
          smoothScrollX
          smoothScrollY
          scrollBarVisible={false}
          scrollState={{ scrollLeft, scrollTop, isScrolling: false }}
          getLinearRow={(index) => ({
            type: LinearRowType.Row,
            displayIndex: index,
            realIndex: index,
          })}
          setScrollState={vi.fn() as ScrollerProps['setScrollState']}
        />,
      );
    };

    act(() => renderScroller(0, 0));
    const horizontalScroller = host.querySelector<HTMLElement>(
      '.tt-grid-scrollbar-horizontal',
    );
    const verticalScroller = host.querySelector<HTMLElement>(
      '.tt-grid-scrollbar-vertical',
    );
    expect(horizontalScroller).not.toBeNull();
    expect(verticalScroller).not.toBeNull();

    act(flushAnimationFrames);
    horizontalScroller!.scrollLeft = 240;
    verticalScroller!.scrollTop = 600;
    act(() => renderScroller(240, 600));

    // TablePanePortalLayer keeps the grid mounted while moving its DOM root
    // through the zero-sized parking host, which clamps only native offsets.
    horizontalScroller!.scrollLeft = 0;
    verticalScroller!.scrollTop = 0;

    const wheelEvent = new WheelEvent('wheel', {
      deltaY: 120,
      bubbles: true,
      cancelable: true,
    });
    act(() => wheelTarget.dispatchEvent(wheelEvent));

    expect(wheelEvent.defaultPrevented).toBe(true);
    expect(
      host.querySelector<HTMLElement>('.tt-grid-scrollbar-horizontal')!
        .scrollLeft,
    ).toBe(240);
    expect(
      host.querySelector<HTMLElement>('.tt-grid-scrollbar-vertical')!.scrollTop,
    ).toBe(720);
  });

  it.each([
    { label: 'diagonal', deltaX: 45, deltaY: 75 },
    { label: 'horizontal-only', deltaX: 45, deltaY: 0 },
    { label: 'vertical-only', deltaX: 0, deltaY: 75 },
  ])(
    'commits the $label wheel position as one scroll snapshot',
    ({ deltaX, deltaY }) => {
      let nextFrameId = 1;
      const animationFrames = new Map<number, FrameRequestCallback>();
      vi.stubGlobal(
        'requestAnimationFrame',
        vi.fn((callback: FrameRequestCallback) => {
          const id = nextFrameId++;
          animationFrames.set(id, callback);
          return id;
        }),
      );
      vi.stubGlobal(
        'cancelAnimationFrame',
        vi.fn((id: number) => animationFrames.delete(id)),
      );

      const host = document.createElement('div');
      const wheelTarget = document.createElement('div');
      document.body.append(host, wheelTarget);
      const root = createRoot(host);
      mountedRoots.push({ root, host, wheelTarget });

      const setScrollState = vi.fn();
      const onScrollChanged = vi.fn();
      act(() => {
        root.render(
          <InfiniteScroller
            coordInstance={makeCoordinateManager()}
            containerWidth={400}
            containerHeight={300}
            scrollWidth={2_000}
            scrollHeight={2_000}
            containerRef={{ current: wheelTarget }}
            smoothScrollX
            smoothScrollY
            scrollBarVisible={false}
            scrollState={{ scrollLeft: 0, scrollTop: 0, isScrolling: false }}
            getLinearRow={(index) => ({
              type: LinearRowType.Row,
              displayIndex: index,
              realIndex: index,
            })}
            setScrollState={setScrollState as ScrollerProps['setScrollState']}
            onScrollChanged={onScrollChanged}
          />,
        );
      });

      const mountedFrames = [...animationFrames.entries()];
      animationFrames.clear();
      act(() => {
        for (const [, frame] of mountedFrames) frame(0);
      });

      const horizontalScroller = host.querySelector<HTMLElement>(
        '.tt-grid-scrollbar-horizontal',
      );
      const verticalScroller = host.querySelector<HTMLElement>(
        '.tt-grid-scrollbar-vertical',
      );
      expect(horizontalScroller).not.toBeNull();
      expect(verticalScroller).not.toBeNull();

      const wheelEvent = new WheelEvent('wheel', {
        deltaX,
        deltaY,
        bubbles: true,
        cancelable: true,
      });
      act(() => {
        wheelTarget.dispatchEvent(wheelEvent);
      });

      expect(wheelEvent.defaultPrevented).toBe(true);
      expect(horizontalScroller!.scrollLeft).toBe(deltaX);
      expect(verticalScroller!.scrollTop).toBe(deltaY);

      act(() => {
        if (deltaX !== 0)
          horizontalScroller!.dispatchEvent(new Event('scroll'));
        if (deltaY !== 0) verticalScroller!.dispatchEvent(new Event('scroll'));
      });

      expect(animationFrames.size).toBe(1);
      const [frameId, frame] = animationFrames.entries().next().value!;
      animationFrames.delete(frameId);
      act(() => frame(16));

      expect(onScrollChanged).toHaveBeenCalledOnce();
      expect(onScrollChanged).toHaveBeenCalledWith(deltaX, deltaY);
      expect(setScrollState).toHaveBeenCalledOnce();

      const update = setScrollState.mock.calls[0][0] as (
        previous: IScrollState,
      ) => IScrollState;
      expect(
        update({ scrollLeft: 0, scrollTop: 0, isScrolling: false }),
      ).toEqual({
        scrollLeft: deltaX,
        scrollTop: deltaY,
        isScrolling: true,
      });
    },
  );

  it('leaves vertical wheel input to a nested textarea while it can still scroll', () => {
    const wheelTarget = document.createElement('div');
    const textarea = document.createElement('textarea');
    textarea.style.overflowY = 'auto';
    Object.defineProperties(textarea, {
      scrollHeight: { configurable: true, value: 600 },
      clientHeight: { configurable: true, value: 200 },
      scrollTop: { configurable: true, value: 100, writable: true },
    });
    wheelTarget.append(textarea);
    const { horizontalScroller, verticalScroller } = mountBasicScroller(wheelTarget);
    const wheelEvent = new WheelEvent('wheel', {
      deltaY: 0.5,
      bubbles: true,
      cancelable: true,
    });

    act(() => {
      textarea.dispatchEvent(wheelEvent);
    });

    expect(wheelEvent.defaultPrevented).toBe(false);
    expect(horizontalScroller?.scrollLeft).toBe(0);
    expect(verticalScroller?.scrollTop).toBe(0);
  });

  it.each([
    { edge: 'top', scrollTop: 0, deltaY: -0.5 },
    { edge: 'bottom', scrollTop: 400, deltaY: 0.5 },
  ])('hands a small diagonal wheel event back to the grid at the textarea $edge edge', ({
    scrollTop,
    deltaY,
  }) => {
    const wheelTarget = document.createElement('div');
    const textarea = document.createElement('textarea');
    textarea.style.overflowY = 'auto';
    Object.defineProperties(textarea, {
      scrollHeight: { configurable: true, value: 600 },
      clientHeight: { configurable: true, value: 200 },
      scrollTop: { configurable: true, value: scrollTop, writable: true },
    });
    wheelTarget.append(textarea);
    const { horizontalScroller, verticalScroller } = mountBasicScroller(wheelTarget);
    const wheelEvent = new WheelEvent('wheel', {
      deltaX: 0.25,
      deltaY,
      bubbles: true,
      cancelable: true,
    });

    act(() => {
      textarea.dispatchEvent(wheelEvent);
    });

    expect(wheelEvent.defaultPrevented).toBe(true);
    expect(horizontalScroller?.scrollLeft).toBe(0.25);
    expect(verticalScroller?.scrollTop).toBe(deltaY);
  });

  it('leaves two-finger touch moves to browser pinch zoom', () => {
    const host = document.createElement('div');
    const wheelTarget = document.createElement('div');
    document.body.append(host, wheelTarget);
    const root = createRoot(host);
    mountedRoots.push({ root, host, wheelTarget });

    act(() => {
      root.render(
        <InfiniteScroller
          coordInstance={makeCoordinateManager()}
          containerWidth={400}
          containerHeight={300}
          scrollWidth={2_000}
          scrollHeight={2_000}
          containerRef={{ current: wheelTarget }}
          smoothScrollX
          smoothScrollY
          scrollBarVisible={false}
          scrollState={{ scrollLeft: 0, scrollTop: 0, isScrolling: false }}
          getLinearRow={(index) => ({
            type: LinearRowType.Row,
            displayIndex: index,
            realIndex: index,
          })}
          setScrollState={vi.fn() as ScrollerProps['setScrollState']}
        />,
      );
    });

    const touchMove = new Event('touchmove', {
      bubbles: true,
      cancelable: true,
    }) as TouchEvent;
    Object.defineProperty(touchMove, 'touches', { value: [{}, {}] });
    Object.defineProperty(touchMove, 'changedTouches', { value: [{}, {}] });

    act(() => {
      wheelTarget.dispatchEvent(touchMove);
    });

    expect(touchMove.defaultPrevented).toBe(false);
  });
});
