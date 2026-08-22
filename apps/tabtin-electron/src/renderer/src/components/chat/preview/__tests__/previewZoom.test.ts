import { describe, expect, it } from 'vitest'
import {
  clampPreviewScale,
  formatPreviewScalePercent,
  isPreviewZoomable,
  PREVIEW_DEFAULT_SCALE,
  PREVIEW_MAX_SCALE,
  PREVIEW_MIN_SCALE,
  stepPreviewScale,
} from '../previewZoom'

describe('previewZoom', () => {
  it('isPreviewZoomable only for image and widget', () => {
    expect(isPreviewZoomable('image')).toBe(true)
    expect(isPreviewZoomable('widget')).toBe(true)
    expect(isPreviewZoomable('pdf')).toBe(false)
    expect(isPreviewZoomable('video')).toBe(false)
  })

  it('clampPreviewScale respects bounds', () => {
    expect(clampPreviewScale(0.1)).toBe(PREVIEW_MIN_SCALE)
    expect(clampPreviewScale(9)).toBe(PREVIEW_MAX_SCALE)
    expect(clampPreviewScale(1.333)).toBe(1.33)
    expect(clampPreviewScale(Number.NaN)).toBe(PREVIEW_DEFAULT_SCALE)
  })

  it('stepPreviewScale zooms by 0.25', () => {
    expect(stepPreviewScale(1, 1)).toBe(1.25)
    expect(stepPreviewScale(1, -1)).toBe(0.75)
    expect(stepPreviewScale(PREVIEW_MIN_SCALE, -1)).toBe(PREVIEW_MIN_SCALE)
    expect(stepPreviewScale(PREVIEW_MAX_SCALE, 1)).toBe(PREVIEW_MAX_SCALE)
  })

  it('formatPreviewScalePercent', () => {
    expect(formatPreviewScalePercent(1)).toBe('100%')
    expect(formatPreviewScalePercent(1.25)).toBe('125%')
  })
})
