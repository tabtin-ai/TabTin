/**
 * Lightbox 内 show_widget 布局契约。
 *
 * 高 SVG 不得被 2000px + body overflow:hidden 静默裁切；也不能信任
 * iframe 上报的任意高度制造巨型父页面布局。父层只决定有限 viewport，
 * 完整内容与二维滚动由 iframe 文档内部承接。
 */

/** 防止异常/恶意 resize postMessage 制造巨型布局；正常高图由 iframe 内滚动承接。 */
export const WIDGET_PREVIEW_MAX_IFRAME_HEIGHT = 10_000

export interface WidgetPreviewLayout {
  height: number
  capped: boolean
}

export const WIDGET_PREVIEW_PLACEHOLDER_HEIGHT = 240

/**
 * 返回父层可采用的有限 iframe 高度。
 *
 * capped 不是内容截断信号：scrollable-preview wrapper 的 body 是二维
 * overflow:auto，完整内容仍留在 iframe 文档内可达。
 */
export function resolveLightboxWidgetIframeHeight(
  measuredPx: number,
): WidgetPreviewLayout | null {
  if (typeof measuredPx !== 'number' || !Number.isFinite(measuredPx) || measuredPx <= 0) {
    return null
  }
  const height = Math.ceil(measuredPx)
  return {
    height: Math.min(height, WIDGET_PREVIEW_MAX_IFRAME_HEIGHT),
    capped: height > WIDGET_PREVIEW_MAX_IFRAME_HEIGHT,
  }
}

/**
 * Lightbox iframe 高度：优先铺满 viewer 已建立的内容盒（对齐 PNG 的视口适配）。
 *
 * availableHeight 来自 WidgetPreviewFrame 直接父级（Modal header/padding/footer
 * 已扣除）。iframe 铺满该高度；iframe 内由 lightbox fit/tall 模式决定 contain
 * 或纵向滚动。测高结果只作兜底，不再把 iframe 收成内容矮盒。
 */
export function resolveWidgetPreviewViewportHeight(
  layout: WidgetPreviewLayout | null,
  availableHeight: number | null,
): number {
  if (
    availableHeight != null
    && Number.isFinite(availableHeight)
    && availableHeight > 0
  ) {
    return Math.floor(availableHeight)
  }
  return layout?.height ?? WIDGET_PREVIEW_PLACEHOLDER_HEIGHT
}
