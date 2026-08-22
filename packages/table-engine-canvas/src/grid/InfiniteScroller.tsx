import type { ForwardRefRenderFunction, MutableRefObject, ReactNode, UIEvent } from 'react';
import { useMemo, useRef, useCallback, forwardRef, useImperativeHandle, useEffect } from 'react';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import { Scroller } from 'scroller';
import { useIsTouchDevice } from './shims/hooks';
import type { IGridProps } from './Grid';
import { getHorizontalRangeInfo, getVerticalRangeInfo, useEventListener } from './hooks';
import type { ILinearRow, IScrollState } from './interface';
import type { CoordinateManager } from './managers';
import type { ITimeoutID } from './utils';
import { getWheelDelta } from './utils';
import { cancelTimeout, requestTimeout } from './utils/utils';

export interface ScrollerProps
  extends Pick<
    IGridProps,
    | 'smoothScrollX'
    | 'smoothScrollY'
    | 'scrollBarVisible'
    | 'onScrollChanged'
    | 'onVisibleRegionChanged'
  > {
  coordInstance: CoordinateManager;
  containerWidth: number;
  containerHeight: number;
  scrollWidth: number;
  scrollHeight: number;
  containerRef: MutableRefObject<HTMLDivElement | null>;
  left?: number;
  top?: number;
  scrollEnable?: boolean;
  scrollState: IScrollState;
  getLinearRow: (index: number) => ILinearRow;
  setScrollState: React.Dispatch<React.SetStateAction<IScrollState>>;
}

export interface ScrollerRef {
  scrollTo: (sl?: number, st?: number) => void;
  scrollBy: (deltaX: number, deltaY: number) => void;
}

const joinClassNames = (...parts: Array<string | false | null | undefined>) =>
  parts.filter(Boolean).join(' ');

const NATIVE_VERTICAL_SCROLL_OVERFLOWS = new Set(['auto', 'scroll', 'overlay']);

const canNestedElementConsumeVerticalWheel = (
  event: WheelEvent,
  container: HTMLElement | null
) => {
  if (!container || event.deltaY === 0 || !(event.target instanceof HTMLElement)) return false;

  // Native scrolling runs after this bubbled listener. Preserve it while a nested
  // editor has room; once it reaches the requested edge, the same path falls through
  // to the grid so ownership changes on the next wheel/trackpad event.
  let element: HTMLElement | null = event.target;
  while (element && element !== container) {
    const maxScrollTop = element.scrollHeight - element.clientHeight;
    if (maxScrollTop > 0) {
      const { overflowY } = window.getComputedStyle(element);
      if (NATIVE_VERTICAL_SCROLL_OVERFLOWS.has(overflowY)) {
        if (event.deltaY < 0 ? element.scrollTop > 0 : element.scrollTop < maxScrollTop) {
          return true;
        }
      }
    }
    element = element.parentElement;
  }

  return false;
};

const InfiniteScrollerBase: ForwardRefRenderFunction<ScrollerRef, ScrollerProps> = (props, ref) => {
  const {
    coordInstance,
    containerWidth,
    containerHeight,
    scrollWidth,
    scrollHeight,
    left = 0,
    top = 0,
    containerRef,
    smoothScrollX,
    smoothScrollY,
    scrollBarVisible,
    scrollEnable = true,
    scrollState,
    getLinearRow,
    setScrollState,
    onScrollChanged,
    onVisibleRegionChanged,
  } = props;

  useImperativeHandle(ref, () => ({
    scrollTo: (sl?: number, st?: number) => {
      if (horizontalScrollRef.current && sl != null) {
        horizontalScrollRef.current.scrollLeft = sl;
      }
      if (verticalScrollRef.current && st != null) {
        const el = verticalScrollRef.current;
        const scrollableHeight = el.scrollHeight - el.clientHeight;
        let virtaulOffsetY = 0;
        if (scrollableHeight > 0 && scrollHeight > el.scrollHeight + 5) {
          const prog = st / (scrollHeight - el.clientHeight);
          const actualScrollTop = scrollableHeight * prog;
          virtaulOffsetY = actualScrollTop - st;
        }
        verticalScrollRef.current.scrollTop = st + virtaulOffsetY;
      }
    },
    scrollBy: (deltaX: number, deltaY: number) => {
      horizontalScrollRef.current?.scrollBy(deltaX, 0);
      verticalScrollRef.current?.scrollBy(0, deltaY);
    },
  }));

  const isTouchDevice = useIsTouchDevice();

  const scrollerRef = useRef<Scroller | null>(null);
  const horizontalScrollRef = useRef<HTMLDivElement | null>(null);
  const verticalScrollRef = useRef<HTMLDivElement | null>(null);
  const resetScrollingTimeoutID = useRef<ITimeoutID | null>(null);
  const rafIdRef = useRef<number | null>(null);
  const hasPendingScrollRef = useRef(false);
  const offsetY = useRef(0);
  const lastScrollTop = useRef(0);
  const savedScrollStateRef = useRef(scrollState);
  const scrollHeightRef = useRef(scrollHeight);
  const restoreFrameIdRef = useRef<number | null>(null);

  savedScrollStateRef.current = scrollState;
  scrollHeightRef.current = scrollHeight;

  const restoreSavedScrollPosition = useCallback(() => {
    const horizontalScroller = horizontalScrollRef.current;
    const verticalScroller = verticalScrollRef.current;
    const savedScrollState = savedScrollStateRef.current;

    if (horizontalScroller && Math.abs(horizontalScroller.scrollLeft - savedScrollState.scrollLeft) > 0.5) {
      horizontalScroller.scrollLeft = savedScrollState.scrollLeft;
    }
    if (!verticalScroller) return;

    const scrollableHeight = verticalScroller.scrollHeight - verticalScroller.clientHeight;
    let actualScrollTop = savedScrollState.scrollTop;
    if (scrollableHeight > 0 && scrollHeightRef.current > verticalScroller.scrollHeight + 5) {
      const progress = savedScrollState.scrollTop / (scrollHeightRef.current - verticalScroller.clientHeight);
      actualScrollTop = scrollableHeight * progress;
    }
    if (Math.abs(verticalScroller.scrollTop - actualScrollTop) <= 0.5) return;

    offsetY.current = savedScrollState.scrollTop - actualScrollTop;
    lastScrollTop.current = actualScrollTop;
    verticalScroller.scrollTop = actualScrollTop;
  }, []);

  useEffect(() => {
    // Activity preserves React state, but its hidden DOM scroll offsets can reconnect as zero.
    // Restore after the reveal commit, or synchronously if the user scrolls before that frame.
    restoreFrameIdRef.current = requestAnimationFrame(() => {
      restoreFrameIdRef.current = null;
      restoreSavedScrollPosition();
    });

    return () => {
      if (restoreFrameIdRef.current != null) {
        cancelAnimationFrame(restoreFrameIdRef.current);
        restoreFrameIdRef.current = null;
      }
    };
  }, [restoreSavedScrollPosition]);

  // 主体可横向滚动时横向条常显；纵向仍用 data-scrolling 自动隐藏
  const canScrollHorizontally = scrollWidth > containerWidth - left;
  const horizontalScrollBarAlwaysVisible = Boolean(scrollBarVisible && canScrollHorizontally);

  const scrollbarHideTimeoutRef = useRef<ITimeoutID | null>(null);
  const showScrollbar = useCallback(() => {
    if (!scrollBarVisible) return;
    verticalScrollRef.current?.setAttribute('data-scrolling', 'true');
    if (scrollbarHideTimeoutRef.current) {
      cancelTimeout(scrollbarHideTimeoutRef.current);
    }
    scrollbarHideTimeoutRef.current = requestTimeout(() => {
      verticalScrollRef.current?.setAttribute('data-scrolling', 'false');
      scrollbarHideTimeoutRef.current = null;
    }, 1200);
  }, [scrollBarVisible]);

  useEffect(() => {
    horizontalScrollRef.current?.setAttribute(
      'data-scrolling',
      horizontalScrollBarAlwaysVisible ? 'true' : 'false'
    );
  }, [horizontalScrollBarAlwaysVisible]);

  useEffect(() => {
    if (!scrollBarVisible) {
      verticalScrollRef.current?.setAttribute('data-scrolling', 'false');
      if (scrollbarHideTimeoutRef.current) {
        cancelTimeout(scrollbarHideTimeoutRef.current);
        scrollbarHideTimeoutRef.current = null;
      }
    }
  }, [scrollBarVisible]);

  useEffect(() => {
    return () => {
      if (scrollbarHideTimeoutRef.current) {
        cancelTimeout(scrollbarHideTimeoutRef.current);
        scrollbarHideTimeoutRef.current = null;
      }
      if (rafIdRef.current != null) {
        cancelAnimationFrame(rafIdRef.current);
        rafIdRef.current = null;
      }
    };
  }, []);

  // One trackpad gesture can fire horizontal and vertical scroll events in the same frame.
  // Read both scrollers as one snapshot so the later event cannot overwrite the other axis.
  const processScroll = () => {
    const verticalScroller = verticalScrollRef.current;
    const horizontalScroller = horizontalScrollRef.current;
    if (!verticalScroller || !horizontalScroller) {
      return;
    }
    const { scrollTop: newScrollTop } = verticalScroller;
    const { scrollLeft } = horizontalScroller;
    const { rowInitSize, columnInitSize } = coordInstance;

    const delta = lastScrollTop.current - newScrollTop;
    const scrollableHeight = verticalScroller.scrollHeight - verticalScroller.clientHeight;
    lastScrollTop.current = newScrollTop;

    if (
      scrollableHeight > 0 &&
      (Math.abs(delta) > 2000 || newScrollTop === 0 || newScrollTop === scrollableHeight) &&
      scrollHeight > verticalScroller.scrollHeight + 5
    ) {
      const prog = newScrollTop / scrollableHeight;
      const recomputed = (scrollHeight - verticalScroller.clientHeight) * prog;
      offsetY.current = recomputed - newScrollTop;
    }
    const scrollTop = newScrollTop + offsetY.current;
    const rowIndex = coordInstance.getRowStartIndex(scrollTop);
    const rowOffset = coordInstance.getRowOffset(rowIndex);

    const colIndex = coordInstance.getColumnStartIndex(scrollLeft);
    const colOffset = coordInstance.getColumnOffset(colIndex);
    const scrollProps = {
      scrollTop: !smoothScrollY ? rowOffset - rowInitSize : scrollTop,
      scrollLeft: !smoothScrollX ? colOffset - columnInitSize : scrollLeft,
    };

    const BUFFER_ROWS = 5;
    const BUFFER_COLS = 2;
    const { startRowIndex, stopRowIndex } = getVerticalRangeInfo(
      coordInstance,
      scrollProps.scrollTop,
      BUFFER_ROWS
    );
    const { startColumnIndex, stopColumnIndex } = getHorizontalRangeInfo(
      coordInstance,
      scrollProps.scrollLeft,
      BUFFER_COLS
    );

    const realStartRowIndex = getLinearRow(startRowIndex).realIndex;
    const realStopRowIndex = getLinearRow(stopRowIndex).realIndex;

    onVisibleRegionChanged?.({
      x: startColumnIndex,
      y: realStartRowIndex,
      width: stopColumnIndex - startColumnIndex,
      height: realStopRowIndex - realStartRowIndex,
    });
    onScrollChanged?.(scrollProps.scrollLeft, scrollProps.scrollTop);

    setScrollState((prev) => {
      return {
        ...prev,
        ...scrollProps,
        isScrolling: true,
      };
    });
    resetScrollingDebounced();
  };

  const onScroll = (_event: UIEvent<HTMLDivElement>) => {
    showScrollbar();
    hasPendingScrollRef.current = true;
    if (rafIdRef.current == null) {
      rafIdRef.current = requestAnimationFrame(() => {
        rafIdRef.current = null;
        if (hasPendingScrollRef.current) {
          hasPendingScrollRef.current = false;
          processScroll();
        }
      });
    }
  };

  const resetScrolling = useCallback(() => {
    setScrollState((prev) => ({ ...prev, isScrolling: false }));
    resetScrollingTimeoutID.current = null;
  }, [setScrollState]);

  const resetScrollingDebounced = useCallback(() => {
    if (resetScrollingTimeoutID.current !== null) {
      cancelTimeout(resetScrollingTimeoutID.current);
    }
    resetScrollingTimeoutID.current = requestTimeout(resetScrolling, 200);
  }, [resetScrolling]);

  const scrollHandler = useCallback((deltaX: number, deltaY: number) => {
    if (horizontalScrollRef.current) {
      horizontalScrollRef.current.scrollLeft = horizontalScrollRef.current.scrollLeft + deltaX;
    }
    if (verticalScrollRef.current) {
      const realDeltaY = deltaY;
      verticalScrollRef.current.scrollTop = verticalScrollRef.current.scrollTop + realDeltaY;
    }
  }, []);

  const mobileScrollHandler = useCallback((scrollLeft: number, scrollTop: number) => {
    if (horizontalScrollRef.current) {
      horizontalScrollRef.current.scrollLeft = scrollLeft;
    }
    if (verticalScrollRef.current) {
      verticalScrollRef.current.scrollTop = scrollTop;
    }
  }, []);

  const onWheel = useCallback(
    (event: Event) => {
      if (!scrollEnable) return;
      const wheelEvent = event as WheelEvent;
      if (canNestedElementConsumeVerticalWheel(wheelEvent, containerRef.current)) return;
      event.preventDefault();

      const shouldRestoreBeforeWheel =
        restoreFrameIdRef.current != null ||
        (rafIdRef.current == null && !hasPendingScrollRef.current);
      if (restoreFrameIdRef.current != null) {
        cancelAnimationFrame(restoreFrameIdRef.current);
        restoreFrameIdRef.current = null;
      }
      if (shouldRestoreBeforeWheel) {
        restoreSavedScrollPosition();
      }
      showScrollbar();
      const [fixedDeltaX, fixedDeltaY] = getWheelDelta({
        event: wheelEvent,
        pageHeight: coordInstance.containerHeight - coordInstance.rowInitSize - 1,
        lineHeight: coordInstance.rowHeight,
      });
      scrollHandler(fixedDeltaX, fixedDeltaY);
    },
    [scrollEnable, scrollHandler, coordInstance, showScrollbar, containerRef, restoreSavedScrollPosition]
  );

  const onTouchStart = useCallback((e: TouchEvent) => {
    if (scrollerRef.current) {
      scrollerRef.current.doTouchStart(e.changedTouches, e.timeStamp);
    }
  }, []);

  const onTouchMove = useCallback((e: TouchEvent) => {
    if (e.touches.length !== 1) return;
    e.preventDefault();
    if (scrollerRef.current) {
      scrollerRef.current.doTouchMove(e.changedTouches, e.timeStamp);
    }
  }, []);

  const onTouchEnd = useCallback((e: TouchEvent) => {
    if (scrollerRef.current) {
      if (horizontalScrollRef.current && verticalScrollRef.current) {
        scrollerRef.current?.scrollTo(
          horizontalScrollRef.current.scrollLeft,
          verticalScrollRef.current.scrollTop
        );
      }
      scrollerRef.current.doTouchEnd(e.timeStamp);
    }
  }, []);

  useEffect(() => {
    if (!isTouchDevice) return;

    const options = {
      scrollingX: true,
      scrollingY: true,
      animationDuration: 200,
    };

    scrollerRef.current = new Scroller(mobileScrollHandler, options);
  }, [mobileScrollHandler, isTouchDevice]);

  useEffect(() => {
    if (scrollerRef.current) {
      scrollerRef.current.setDimensions(containerWidth, containerHeight, scrollWidth, scrollHeight);
    }
  }, [containerHeight, containerWidth, scrollWidth, scrollHeight]);

  const placeholderElements: ReactNode[] = useMemo(() => {
    let h = 0;
    let key = 0;
    const res = [];

    while (h < scrollHeight) {
      const curH = Math.min(5000000, scrollHeight - h);
      res.push(<div key={key++} style={{ width: 0, height: curH }} />);
      h += curH;
    }
    return res;
  }, [scrollHeight]);

  useEventListener('wheel', onWheel, containerRef.current, false);
  useEventListener('touchstart', onTouchStart, containerRef.current, false);
  useEventListener('touchmove', onTouchMove, containerRef.current, false);
  useEventListener('touchend', onTouchEnd, containerRef.current, false);

  return (
    <>
      <div
        ref={horizontalScrollRef}
        data-scrolling={horizontalScrollBarAlwaysVisible ? 'true' : 'false'}
        data-enabled={scrollBarVisible ? 'true' : 'false'}
        className={joinClassNames(
          'tt-grid-scrollbar tt-grid-scrollbar-horizontal absolute bottom-[2px] left-0 h-4 cursor-pointer overflow-y-hidden overflow-x-scroll will-change-transform',
          horizontalScrollBarAlwaysVisible
            ? 'opacity-100'
            : 'opacity-0 transition-opacity duration-300 data-[scrolling=true]:opacity-100',
          !scrollBarVisible && 'pointer-events-none'
        )}
        style={{
          left,
          width: containerWidth - left,
          transform: 'translateY(var(--tt-grid-horizontal-scrollbar-offset-y, 0px))',
        }}
        onScroll={onScroll}
        onMouseEnter={() => showScrollbar()}
      >
        <div
          className="absolute"
          style={{
            width: scrollWidth,
            height: 1,
          }}
        />
      </div>
      <div
        ref={verticalScrollRef}
        data-scrolling="false"
        data-enabled={scrollBarVisible ? 'true' : 'false'}
        className={joinClassNames(
          'tt-grid-scrollbar tt-grid-scrollbar-vertical absolute right-[2px] w-4 cursor-pointer overflow-x-hidden overflow-y-scroll will-change-transform',
          'opacity-0 transition-opacity duration-300 data-[scrolling=true]:opacity-100',
          !scrollBarVisible && 'pointer-events-none'
        )}
        style={{
          top,
          height: containerHeight - top,
        }}
        onScroll={onScroll}
        onMouseEnter={() => showScrollbar()}
      >
        <div className="flex w-px shrink-0 flex-col">{placeholderElements}</div>
      </div>
    </>
  );
};

export const InfiniteScroller = forwardRef(InfiniteScrollerBase);
