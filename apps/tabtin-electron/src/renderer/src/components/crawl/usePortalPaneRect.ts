import {
  type RefObject,
  useCallback,
  useLayoutEffect,
  useState,
} from 'react'

export interface PaneRect {
  top: number
  left: number
  width: number
  height: number
}

const EMPTY_RECT: PaneRect = { top: 0, left: 0, width: 0, height: 0 }

function readPaneRect(pane: HTMLElement | null): PaneRect {
  if (!pane) return EMPTY_RECT
  const { top, left, width, height } = pane.getBoundingClientRect()
  return { top, left, width, height }
}

export function usePortalPaneRect(
  paneRef: RefObject<HTMLElement | null>,
  enabled: boolean,
): PaneRect {
  const [paneRect, setPaneRect] = useState<PaneRect>(EMPTY_RECT)
  const updatePaneRect = useCallback(() => {
    const nextRect = readPaneRect(paneRef.current)
    if (nextRect.width <= 0 || nextRect.height <= 0) return
    setPaneRect(nextRect)
  }, [paneRef])

  useLayoutEffect(() => {
    if (!enabled) return

    let cancelled = false
    let rafId = 0
    let observer: ResizeObserver | undefined

    const observePane = (pane: HTMLElement) => {
      if (typeof ResizeObserver === 'undefined') return
      // eslint-disable-next-line tabtin/prefer-scoped-activity-effects -- portal 在 Activity 外，必须自己跟随面板尺寸。
      observer = new ResizeObserver(updatePaneRect)
      observer.observe(pane)
    }

    const measureUntilReady = () => {
      if (cancelled) return
      const pane = paneRef.current
      const nextRect = readPaneRect(pane)
      if (nextRect.width > 0 && nextRect.height > 0) {
        setPaneRect(nextRect)
        if (pane) observePane(pane)
        return
      }
      rafId = requestAnimationFrame(measureUntilReady)
    }

    // eslint-disable-next-line tabtin/prefer-scoped-activity-effects -- portal 在 Activity 外，必须自己跟随窗口尺寸。
    window.addEventListener('resize', updatePaneRect)
    measureUntilReady()

    return () => {
      cancelled = true
      cancelAnimationFrame(rafId)
      window.removeEventListener('resize', updatePaneRect)
      observer?.disconnect()
    }
  }, [enabled, paneRef, updatePaneRect])

  return paneRect
}
