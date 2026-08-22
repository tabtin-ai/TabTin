import { useMemo } from 'react';
import type { IEditorProps } from '../components';
import { GRID_CONTAINER_ATTR } from '../configs';

const SAFE_SPACING = 32;

export const useGridPopupPosition = (
  rect: Pick<IEditorProps['rect'], 'y' | 'height' | 'editorId'> &
    Partial<Pick<IEditorProps['rect'], 'x' | 'width'>>,
  maxHeight?: number
) => {
  const { x, y, width, height, editorId } = rect;

  return useMemo(() => {
    if (typeof document === 'undefined' || typeof window === 'undefined') {
      return undefined;
    }

    // Prefer getElementById: HTML ids may start with a digit (e.g. field name "1"),
    // but `#1-...` is an invalid CSS selector and querySelector throws.
    const editorElement =
      typeof editorId === 'string' && editorId.length > 0
        ? document.getElementById(editorId)
        : null;
    const gridElement = editorElement?.closest(`[${GRID_CONTAINER_ATTR}]`);
    const gridBound = gridElement?.getBoundingClientRect();

    if (gridBound == null) return undefined;

    const screenH = window.innerHeight;
    const screenW = window.innerWidth;
    const { y: gridY, x: gridX } = gridBound;

    const spaceAbove = gridY + y;
    const spaceBelow = screenH - gridY - y - height;
    const isAbove = spaceAbove > spaceBelow;
    const finalHeight = Math.max(0, Math.min((isAbove ? spaceAbove : spaceBelow) - SAFE_SPACING, maxHeight ?? Infinity));

    const style: React.CSSProperties = {
      top: isAbove ? 'unset' : height + 1,
      bottom: isAbove ? height : 'unset',
      maxHeight: finalHeight,
    };

    if (x != null && width != null) {
      const absRight = gridX + x + width;
      const overflow = absRight - screenW + SAFE_SPACING;
      if (overflow > 0) {
        style.left = -overflow;
      }
    }

    return style;
  }, [editorId, x, y, width, height, maxHeight]);
};

