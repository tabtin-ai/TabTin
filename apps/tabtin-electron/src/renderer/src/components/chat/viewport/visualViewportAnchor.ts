const CONTENT_ANCHOR_SELECTOR = [
  '[data-viewport-anchor]',
  '.markdown-body > *',
  '[data-testid^="block-"]',
].join(',')

const VIRTUAL_ROW_SELECTOR = '[data-message-enter-key]'

export type VisualViewportAnchor = {
  element: HTMLElement
  offsetTop: number
  fallbackRow: HTMLElement | null
  fallbackRowOffsetTop: number | null
}

function isVisibleInViewport(
  element: HTMLElement,
  viewportTop: number,
  viewportBottom: number,
): boolean {
  const rect = element.getBoundingClientRect()
  return rect.height > 0 && rect.bottom > viewportTop && rect.top < viewportBottom
}

function offsetFromViewportTop(scrollElement: HTMLElement, element: HTMLElement): number {
  return element.getBoundingClientRect().top - scrollElement.getBoundingClientRect().top
}

/** Capture a stable content node and its containing virtual row as a degradation anchor. */
export function captureVisualViewportAnchor(
  scrollElement: HTMLElement,
  contentElement: HTMLElement,
): VisualViewportAnchor | null {
  const viewport = scrollElement.getBoundingClientRect()
  let candidates = Array.from(
    contentElement.querySelectorAll<HTMLElement>(CONTENT_ANCHOR_SELECTOR),
  ).filter((element) => isVisibleInViewport(element, viewport.top, viewport.bottom))
  if (candidates.length === 0) {
    candidates = Array.from(
      contentElement.querySelectorAll<HTMLElement>(VIRTUAL_ROW_SELECTOR),
    ).filter((element) => isVisibleInViewport(element, viewport.top, viewport.bottom))
  }

  const crossingTop = candidates.filter((element) => {
    const rect = element.getBoundingClientRect()
    return rect.top <= viewport.top && rect.bottom > viewport.top
  })
  const element = crossingTop.at(-1) ?? candidates.sort((left, right) => (
    left.getBoundingClientRect().top - right.getBoundingClientRect().top
  ))[0]
  if (!element) return null

  const fallbackRow = element.closest<HTMLElement>(VIRTUAL_ROW_SELECTOR)
  return {
    element,
    offsetTop: offsetFromViewportTop(scrollElement, element),
    fallbackRow,
    fallbackRowOffsetTop: fallbackRow
      ? offsetFromViewportTop(scrollElement, fallbackRow)
      : null,
  }
}

/** Return the scrollTop delta required to restore the captured visual position. */
export function measureVisualViewportAnchorShift(
  scrollElement: HTMLElement,
  anchor: VisualViewportAnchor,
): number | null {
  if (scrollElement.contains(anchor.element)) {
    const nextOffset = offsetFromViewportTop(scrollElement, anchor.element)
    const delta = nextOffset - anchor.offsetTop
    return Math.abs(delta) > 0.5 ? delta : 0
  }

  if (
    anchor.fallbackRow
    && anchor.fallbackRowOffsetTop != null
    && scrollElement.contains(anchor.fallbackRow)
  ) {
    const nextOffset = offsetFromViewportTop(scrollElement, anchor.fallbackRow)
    const delta = nextOffset - anchor.fallbackRowOffsetTop
    return Math.abs(delta) > 0.5 ? delta : 0
  }

  return null
}
