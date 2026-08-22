import { describe, expect, it } from 'vitest'
import { resolveOverlayAnchorRect } from './useGridOverlayFloatingPosition'

describe('resolveOverlayAnchorRect', () => {
  it('maps container-relative anchors through the grid container rect', () => {
    const rect = resolveOverlayAnchorRect(
      { x: 12, y: 24, width: 2, height: 3 },
      new DOMRect(100, 200, 800, 600),
    )

    expect(rect.x).toBe(112)
    expect(rect.y).toBe(224)
    expect(rect.width).toBe(2)
    expect(rect.height).toBe(3)
  })

  it('uses viewport coordinates directly for client-space context menus', () => {
    const rect = resolveOverlayAnchorRect(
      { x: 480, y: 320, coordinateSpace: 'client' },
      new DOMRect(100, 200, 800, 600),
    )

    expect(rect.x).toBe(480)
    expect(rect.y).toBe(320)
  })
})
