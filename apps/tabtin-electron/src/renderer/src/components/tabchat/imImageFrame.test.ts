import { describe, expect, it } from 'vitest'
import {
  IM_IMAGE_FRAME_MAX_HEIGHT,
  IM_IMAGE_FRAME_MAX_WIDTH,
  resolveImImageFrame,
} from './imImageFrame'

describe('resolveImImageFrame', () => {
  it('preserves a portrait image ratio inside the preview bounds', () => {
    const frame = resolveImImageFrame({ image_width: 844, image_height: 1152 })

    expect(frame.width).toBeCloseTo(307.71, 2)
    expect(frame.height).toBe(IM_IMAGE_FRAME_MAX_HEIGHT)
    expect(frame.width / frame.height).toBeCloseTo(844 / 1152, 8)
  })

  it('does not upscale a small image', () => {
    expect(resolveImImageFrame({ image_width: 120, image_height: 80 })).toEqual({
      width: 120,
      height: 80,
    })
  })

  it('uses the stable legacy frame when either dimension is missing or invalid', () => {
    const fallback = {
      width: IM_IMAGE_FRAME_MAX_WIDTH,
      height: IM_IMAGE_FRAME_MAX_HEIGHT,
    }

    expect(resolveImImageFrame(undefined)).toEqual(fallback)
    expect(resolveImImageFrame({ image_width: 844 })).toEqual(fallback)
    expect(resolveImImageFrame({ image_width: 0, image_height: 1152 })).toEqual(fallback)
  })
})
