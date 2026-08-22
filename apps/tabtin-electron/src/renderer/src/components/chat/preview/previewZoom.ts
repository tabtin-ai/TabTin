/**
 * Agent 对话资源预览缩放：纯函数，供 Lightbox 与单测共用。
 */

export const PREVIEW_MIN_SCALE = 0.5
export const PREVIEW_MAX_SCALE = 5
export const PREVIEW_SCALE_STEP = 0.25
export const PREVIEW_DEFAULT_SCALE = 1

export type PreviewZoomableKind = 'image' | 'widget'

export function isPreviewZoomable(kind: string | undefined): kind is PreviewZoomableKind {
  return kind === 'image' || kind === 'widget'
}

export function clampPreviewScale(scale: number): number {
  if (!Number.isFinite(scale)) return PREVIEW_DEFAULT_SCALE
  return Math.min(
    PREVIEW_MAX_SCALE,
    Math.max(PREVIEW_MIN_SCALE, Number(scale.toFixed(2))),
  )
}

/** direction: 1 放大，-1 缩小；滚轮向上视为放大 */
export function stepPreviewScale(scale: number, direction: 1 | -1): number {
  return clampPreviewScale(scale + direction * PREVIEW_SCALE_STEP)
}

export function formatPreviewScalePercent(scale: number): string {
  return `${Math.round(clampPreviewScale(scale) * 100)}%`
}
