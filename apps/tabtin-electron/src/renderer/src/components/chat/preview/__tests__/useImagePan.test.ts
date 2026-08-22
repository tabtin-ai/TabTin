import { describe, expect, it } from 'vitest'
import { clampImagePanOffset } from '../useImagePan'

describe('clampImagePanOffset', () => {
  it('keeps a zoomed image within the viewport-sized pan range', () => {
    const result = clampImagePanOffset({ x: 9999, y: -9999 }, 2)

    expect(result.x).toBe(window.innerWidth / 2)
    expect(result.y).toBe(-window.innerHeight / 2)
  })

  it('does not pan an image at its default scale', () => {
    expect(clampImagePanOffset({ x: 20, y: -20 }, 1)).toEqual({ x: 0, y: 0 })
  })
})
