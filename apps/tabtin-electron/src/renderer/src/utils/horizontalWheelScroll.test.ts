import { describe, expect, it, vi } from 'vitest'
import { scrollHorizontallyWithVerticalWheel } from './horizontalWheelScroll'

function makeViewport(metrics: {
  clientWidth: number
  scrollWidth: number
  scrollLeft?: number
}): HTMLElement {
  const viewport = document.createElement('div')
  Object.defineProperty(viewport, 'clientWidth', {
    configurable: true,
    value: metrics.clientWidth,
  })
  Object.defineProperty(viewport, 'scrollWidth', {
    configurable: true,
    value: metrics.scrollWidth,
  })
  Object.defineProperty(viewport, 'scrollLeft', {
    configurable: true,
    writable: true,
    value: metrics.scrollLeft ?? 0,
  })
  return viewport
}

function makeWheelEvent(overrides: Partial<{
  deltaX: number
  deltaY: number
  deltaMode: number
}> = {}) {
  return {
    deltaX: overrides.deltaX ?? 0,
    deltaY: overrides.deltaY ?? 80,
    deltaMode: overrides.deltaMode ?? 0,
    preventDefault: vi.fn(),
  }
}

describe('scrollHorizontallyWithVerticalWheel', () => {
  it('maps vertical wheel delta to horizontal scroll when the viewport overflows', () => {
    const viewport = makeViewport({ clientWidth: 100, scrollWidth: 300, scrollLeft: 20 })
    const event = makeWheelEvent({ deltaY: 80 })

    const handled = scrollHorizontallyWithVerticalWheel(event, viewport)

    expect(handled).toBe(true)
    expect(viewport.scrollLeft).toBe(100)
    expect(event.preventDefault).toHaveBeenCalledTimes(1)
  })

  it('does not intercept native horizontal wheel intent', () => {
    const viewport = makeViewport({ clientWidth: 100, scrollWidth: 300, scrollLeft: 20 })
    const event = makeWheelEvent({ deltaX: 90, deltaY: 30 })

    const handled = scrollHorizontallyWithVerticalWheel(event, viewport)

    expect(handled).toBe(false)
    expect(viewport.scrollLeft).toBe(20)
    expect(event.preventDefault).not.toHaveBeenCalled()
  })

  it('does not intercept when there is no horizontal overflow', () => {
    const viewport = makeViewport({ clientWidth: 300, scrollWidth: 300, scrollLeft: 0 })
    const event = makeWheelEvent({ deltaY: 80 })

    const handled = scrollHorizontallyWithVerticalWheel(event, viewport)

    expect(handled).toBe(false)
    expect(event.preventDefault).not.toHaveBeenCalled()
  })

  it('does not intercept when scrolling cannot move past the edge', () => {
    const viewport = makeViewport({ clientWidth: 100, scrollWidth: 300, scrollLeft: 200 })
    const event = makeWheelEvent({ deltaY: 80 })

    const handled = scrollHorizontallyWithVerticalWheel(event, viewport)

    expect(handled).toBe(false)
    expect(viewport.scrollLeft).toBe(200)
    expect(event.preventDefault).not.toHaveBeenCalled()
  })

  it('scrolls back toward the left edge with negative vertical delta', () => {
    const viewport = makeViewport({ clientWidth: 100, scrollWidth: 300, scrollLeft: 120 })
    const event = makeWheelEvent({ deltaY: -80 })

    const handled = scrollHorizontallyWithVerticalWheel(event, viewport)

    expect(handled).toBe(true)
    expect(viewport.scrollLeft).toBe(40)
    expect(event.preventDefault).toHaveBeenCalledTimes(1)
  })

  it('normalizes line-mode wheel deltas', () => {
    const viewport = makeViewport({ clientWidth: 100, scrollWidth: 300, scrollLeft: 0 })
    const event = makeWheelEvent({ deltaY: 2, deltaMode: 1 })

    const handled = scrollHorizontallyWithVerticalWheel(event, viewport)

    expect(handled).toBe(true)
    expect(viewport.scrollLeft).toBe(80)
    expect(event.preventDefault).toHaveBeenCalledTimes(1)
  })

  it('normalizes page-mode wheel deltas using the viewport width', () => {
    const viewport = makeViewport({ clientWidth: 100, scrollWidth: 300, scrollLeft: 0 })
    const event = makeWheelEvent({ deltaY: 1, deltaMode: 2 })

    const handled = scrollHorizontallyWithVerticalWheel(event, viewport)

    expect(handled).toBe(true)
    expect(viewport.scrollLeft).toBe(100)
    expect(event.preventDefault).toHaveBeenCalledTimes(1)
  })

  it('does not intercept before the viewport ref is ready', () => {
    const event = makeWheelEvent({ deltaY: 80 })

    const handled = scrollHorizontallyWithVerticalWheel(event, null)

    expect(handled).toBe(false)
    expect(event.preventDefault).not.toHaveBeenCalled()
  })
})
