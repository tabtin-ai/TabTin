/**
 * grid stub（补齐宿主未提供的 SDK 类型）：hooks，供 grid 组件引用。
 * These will be replaced when we rewrite the grid with our own implementation.
 */
import { useState, useEffect } from 'react';

export const useIsTouchDevice = (): boolean => {
  const [isTouch, setIsTouch] = useState(false);
  useEffect(() => {
    setIsTouch('ontouchstart' in window || navigator.maxTouchPoints > 0);
  }, []);
  return isTouch;
};
