import { describe, expect, it } from 'vitest'
import { resolveCodeSelectionToolbarPosition } from './codeSelection'

describe('resolveCodeSelectionToolbarPosition', () => {
  it('places toolbar above selection when there is room', () => {
    const pos = resolveCodeSelectionToolbarPosition(
      { top: 200, bottom: 220, centerX: 400 },
      { toolbarHeight: 36, gap: 8, flipThreshold: 56, viewportWidth: 1000, toolbarWidth: 280 },
    )
    expect(pos.placement).toBe('above')
    expect(pos.top).toBe(200 - 36 - 8)
    expect(pos.left).toBe(400)
  })

  it('flips below when near the top of the viewport', () => {
    const pos = resolveCodeSelectionToolbarPosition(
      { top: 40, bottom: 60, centerX: 400 },
      { toolbarHeight: 36, gap: 8, flipThreshold: 56, viewportWidth: 1000, toolbarWidth: 280 },
    )
    expect(pos.placement).toBe('below')
    expect(pos.top).toBe(60 + 8)
  })

  it('clamps horizontal center away from viewport edges', () => {
    const leftEdge = resolveCodeSelectionToolbarPosition(
      { top: 200, bottom: 220, centerX: 10 },
      { viewportWidth: 1000, toolbarWidth: 280 },
    )
    expect(leftEdge.left).toBeGreaterThan(10)

    const rightEdge = resolveCodeSelectionToolbarPosition(
      { top: 200, bottom: 220, centerX: 990 },
      { viewportWidth: 1000, toolbarWidth: 280 },
    )
    expect(rightEdge.left).toBeLessThan(990)
  })
})
