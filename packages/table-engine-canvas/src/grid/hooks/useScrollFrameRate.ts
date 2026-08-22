import { useRef, useCallback, useEffect } from 'react';

export const useScrollFrameRate = (scrollFunction?: (deltaX: number, deltaY: number) => void) => {
  const requestRef = useRef(0);
  const lastTimeRef = useRef(0);
  const frameCountRef = useRef(0);
  const totalFpsRef = useRef(0);
  const measuringRef = useRef(false);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const measureFrameRate = useCallback((timestamp: number) => {
    if (!lastTimeRef.current) {
      lastTimeRef.current = timestamp;
    } else {
      const delta = timestamp - lastTimeRef.current;
      frameCountRef.current++;
      const fps = 1000 / delta;
      totalFpsRef.current += fps;

      lastTimeRef.current = timestamp;
    }

    if (measuringRef.current) {
      requestRef.current = requestAnimationFrame(measureFrameRate);
    }
  }, []);

  const measureRate = useCallback(
    (deltaY: number, duration: number = 10) => {
      if (!measuringRef.current) {
        measuringRef.current = true;
        frameCountRef.current = 0;
        totalFpsRef.current = 0;
        lastTimeRef.current = 0;
        requestRef.current = requestAnimationFrame(measureFrameRate);

        const intervalId = setInterval(() => {
          if (measuringRef.current) {
            scrollFunction?.(0, deltaY);
          } else {
            clearInterval(intervalId);
          }
        }, 1000 / 60);
        intervalRef.current = intervalId;

        setTimeout(() => {
          if (measuringRef.current) {
            cancelAnimationFrame(requestRef.current);
            clearInterval(intervalId);
            intervalRef.current = null;
            measuringRef.current = false;
            const averageFps = totalFpsRef.current / frameCountRef.current;
            console.log(`Average Rate: ${averageFps.toFixed(2)} FPS`);
          }
        }, duration * 1000);
      }
    },
    [measureFrameRate, scrollFunction]
  );

  // 组件卸载时清理 interval 和 rAF，防止泄漏
  useEffect(() => {
    return () => {
      measuringRef.current = false;
      cancelAnimationFrame(requestRef.current);
      if (intervalRef.current !== null) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, []);

  return measureRate;
};
