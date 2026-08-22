import type { MutableRefObject } from 'react';
import { useRef, useState, useLayoutEffect } from 'react';

interface IResizeDetectorDimensions {
  width: number;
  height: number;
}

export interface IUseResizeDetectorReturn<T> extends IResizeDetectorDimensions {
  ref: MutableRefObject<T | null>;
}

/**
 * 观测容器尺寸。
 *
 * 额外处理 TablePanePortal / Activity 常见的 0→size 跳变：
 * 表格常先挂在 parking（h-0 w-0）或折叠画布里，首帧量到 0 后若 ResizeObserver
 * 偶发不回调，Canvas layoutRenderer 会因 containerWidth<=0 早退，表现为
 * 「第一次打开空白」。尺寸仍为 0 时用 rAF 短探测，直到非零或超时。
 */
export function useResizeObserver<T extends HTMLElement = HTMLElement>(
  initialSize?: readonly [width: number, height: number]
): IUseResizeDetectorReturn<T> {
  const ref = useRef<T>(null);

  const [size, setSize] = useState<IResizeDetectorDimensions>({
    width: initialSize?.[0] || 0,
    height: initialSize?.[1] || 0,
  });

  useLayoutEffect(() => {
    const ZERO_PROBE_MAX_FRAMES = 120;

    const normalizeSize = (width?: number, height?: number): IResizeDetectorDimensions => ({
      width: Number.isFinite(width) ? Math.max(0, Math.floor(width as number)) : 0,
      height: Number.isFinite(height) ? Math.max(0, Math.floor(height as number)) : 0,
    });

    const applyMeasuredSize = (width?: number, height?: number) => {
      const next = normalizeSize(width, height);
      setSize((cv) =>
        cv.width === next.width && cv.height === next.height
          ? cv
          : next
      );
      return next;
    };

    const measureElement = (): IResizeDetectorDimensions | null => {
      const element = ref.current;
      if (!element) return null;
      const rect = element.getBoundingClientRect();
      return applyMeasuredSize(
        rect.width || element.clientWidth,
        rect.height || element.clientHeight,
      );
    };

    const resizeCallback: ResizeObserverCallback = (entries) => {
      for (const entry of entries) {
        const { width, height } = (entry && entry.contentRect) || {};
        applyMeasuredSize(width, height);
      }
    };

    let resizeObserver: ResizeObserver | null = null;
    let probeRafId = 0;
    let probeFrames = 0;

    const stopZeroProbe = () => {
      if (probeRafId) {
        window.cancelAnimationFrame(probeRafId);
        probeRafId = 0;
      }
    };

    const probeWhileZero = () => {
      probeRafId = 0;
      const measured = measureElement();
      if (!measured) return;
      if (measured.width > 0 && measured.height > 0) return;
      probeFrames += 1;
      if (probeFrames >= ZERO_PROBE_MAX_FRAMES) return;
      probeRafId = window.requestAnimationFrame(probeWhileZero);
    };

    const startZeroProbeIfNeeded = (measured: IResizeDetectorDimensions | null) => {
      if (!measured) return;
      if (measured.width > 0 && measured.height > 0) return;
      stopZeroProbe();
      probeFrames = 0;
      probeRafId = window.requestAnimationFrame(probeWhileZero);
    };

    try {
      resizeObserver = new window.ResizeObserver(resizeCallback);
      if (ref.current) {
        resizeObserver.observe(ref.current, undefined);
        startZeroProbeIfNeeded(measureElement());
      }
    } catch {
      // ResizeObserver not available or observe failed — fall back to manual measurement
      startZeroProbeIfNeeded(measureElement());
    }

    const rafId = window.requestAnimationFrame(() => {
      startZeroProbeIfNeeded(measureElement());
    });

    return () => {
      window.cancelAnimationFrame(rafId);
      stopZeroProbe();
      resizeObserver?.disconnect();
    };
  }, []);

  return { ref, ...size };
}
