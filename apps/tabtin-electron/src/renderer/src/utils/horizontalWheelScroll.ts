interface WheelScrollEventLike {
  deltaX: number
  deltaY: number
  deltaMode: number
  preventDefault: () => void
}

const WHEEL_DELTA_LINE = 1
const WHEEL_DELTA_PAGE = 2
// Browser line-mode wheel events do not expose a real pixel height; 40px matches common UA conversion.
const WHEEL_LINE_PX = 40

export function scrollHorizontallyWithVerticalWheel(
  event: WheelScrollEventLike,
  viewport: HTMLElement | null,
): boolean {
  if (!viewport) return false

  const maxScrollLeft = viewport.scrollWidth - viewport.clientWidth
  if (maxScrollLeft <= 0) return false

  const verticalDelta = normalizeWheelDeltaY(event, viewport)
  if (verticalDelta === 0) return false

  // Let native horizontal wheel / trackpad gestures keep their own momentum.
  if (Math.abs(event.deltaX) >= Math.abs(event.deltaY)) return false

  const nextScrollLeft = clamp(viewport.scrollLeft + verticalDelta, 0, maxScrollLeft)
  if (nextScrollLeft === viewport.scrollLeft) return false

  viewport.scrollLeft = nextScrollLeft
  event.preventDefault()
  return true
}

function normalizeWheelDeltaY(event: WheelScrollEventLike, viewport: HTMLElement): number {
  if (event.deltaMode === WHEEL_DELTA_LINE) {
    return event.deltaY * WHEEL_LINE_PX
  }
  if (event.deltaMode === WHEEL_DELTA_PAGE) {
    return event.deltaY * viewport.clientWidth
  }
  return event.deltaY
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}
