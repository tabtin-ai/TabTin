export type ViewBounds = { x: number; y: number; width: number; height: number }

type RectLike = { x: number; y: number; width: number; height: number }

export const CRAWL_VIEW_LAYOUT_CHANGE_EVENT = 'canvas-layout-change'

export function getRendererZoomFactor(): number {
  if (typeof window === 'undefined') return 1
  const raw = window.tabtin?.zoom?.getZoomFactor?.()
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) {
    return 1
  }
  return raw
}

export function convertCssRectToViewBounds(rect: RectLike): ViewBounds {
  const zoomFactor = getRendererZoomFactor()
  return {
    x: Math.round(rect.x * zoomFactor),
    y: Math.round(rect.y * zoomFactor),
    width: Math.round(rect.width * zoomFactor),
    height: Math.round(rect.height * zoomFactor),
  }
}

export function getElementViewBounds(element: Element | null): ViewBounds | null {
  if (!element) return null
  const rect = element.getBoundingClientRect()
  if (rect.width <= 2 || rect.height <= 2) return null
  return convertCssRectToViewBounds(rect)
}

export function dispatchCrawlViewLayoutChange(reason: string, detail: Record<string, unknown> = {}): void {
  if (typeof window === 'undefined') return
  window.dispatchEvent(
    new CustomEvent(CRAWL_VIEW_LAYOUT_CHANGE_EVENT, {
      detail: {
        ...detail,
        reason,
        zoomFactor: getRendererZoomFactor(),
      },
    }),
  )
}
