import {
  MAX_BROWSER_AUTO_FIT_ZOOM_FACTOR,
  MIN_BROWSER_AUTO_FIT_ZOOM_FACTOR,
} from '@shared/browser-viewport-constraints'

/** 自适应只缩小不放大：上限 1（100%），固定宽度页缩到刚好放下，窄/响应式页保持原始大小。 */
export const MAX_FIT_ZOOM_FACTOR = MAX_BROWSER_AUTO_FIT_ZOOM_FACTOR
/** 缩放下限，避免超宽页面被压成不可读的极小字号。 */
export const MIN_FIT_ZOOM_FACTOR = MIN_BROWSER_AUTO_FIT_ZOOM_FACTOR
/** 与当前缩放差小于该阈值则不重设，避免无意义的回流抖动。 */
export const ZOOM_EPSILON = 0.02

/**
 * 计算让整页恰好填进可视宽度的缩放因子（纯函数，便于单测）。
 *
 * @param innerWidth   页面当前布局视口宽（CSS px）
 * @param scrollWidth  页面内容实际宽（CSS px）
 * @param currentZoom  webContents 当前缩放因子
 * @param rememberedContentWidth  之前在溢出状态下测到的内容宽度；用于从小 zoom 恢复宽屏
 * @returns clamp 到 [MIN, MAX] 的目标因子；输入非法时返回 null（不动当前缩放）
 *
 * 推导：当前 innerWidth = boundsWidth / currentZoom，目标是新缩放 z' 使
 * boundsWidth / z' >= scrollWidth，即 z' <= boundsWidth / scrollWidth
 * = innerWidth * currentZoom / scrollWidth。该式与 currentZoom 无关（boundsWidth 固定），
 * 因此反复触发不会自我震荡。
 */
export function computeFitZoomFactor(
  innerWidth: number,
  scrollWidth: number,
  currentZoom: number,
  rememberedContentWidth?: number | null,
): number | null {
  if (
    !Number.isFinite(innerWidth) ||
    !Number.isFinite(scrollWidth) ||
    !Number.isFinite(currentZoom) ||
    innerWidth <= 0 ||
    scrollWidth <= 0 ||
    currentZoom <= 0
  ) {
    return null
  }
  const stableContentWidth =
    currentZoom < MAX_FIT_ZOOM_FACTOR - ZOOM_EPSILON &&
    scrollWidth <= innerWidth + 1 &&
    typeof rememberedContentWidth === 'number' &&
    Number.isFinite(rememberedContentWidth) &&
    rememberedContentWidth > 0
      ? rememberedContentWidth
      : scrollWidth
  const desired = (innerWidth * currentZoom) / stableContentWidth
  return Math.min(MAX_FIT_ZOOM_FACTOR, Math.max(MIN_FIT_ZOOM_FACTOR, desired))
}
