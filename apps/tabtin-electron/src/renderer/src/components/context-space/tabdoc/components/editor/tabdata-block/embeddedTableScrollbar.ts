export interface StickyScrollbarBounds {
  viewportBottom: number
  embedTop: number
  embedBottom: number
  scrollbarHeight: number
}

export function resolveStickyScrollbarOffset({
  viewportBottom,
  embedTop,
  embedBottom,
  scrollbarHeight,
}: StickyScrollbarBounds): number {
  if (embedTop >= viewportBottom || embedBottom <= viewportBottom) return 0
  return Math.max(
    viewportBottom - embedBottom,
    embedTop + scrollbarHeight - embedBottom,
  )
}

export function findVerticalScrollContainer(element: HTMLElement): HTMLElement | null {
  let current = element.parentElement
  while (current) {
    const { overflowY } = window.getComputedStyle(current)
    if (overflowY === 'auto' || overflowY === 'scroll') {
      return current
    }
    current = current.parentElement
  }
  return null
}
