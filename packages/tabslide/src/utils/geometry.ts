/**
 * 几何/单位转换工具
 *
 * PPTX 使用 EMU（English Metric Units），1 inch = 914400 EMU。
 * 我们的坐标系统直接用 px，只在导入/导出 PPTX 时转换。
 *
 * 转换链：px → inch → EMU
 * px ÷ 96 = inch
 * inch × 914400 = EMU
 * 即 1px = 9525 EMU
 */

const PX_TO_EMU = 9525 // 1px = 9525 EMU
const POINTS_PER_INCH = 72
const PX_PER_INCH = 96

/** 角度 → 弧度 */
export function degToRad(deg: number): number {
  return (deg * Math.PI) / 180
}

/** 弧度 → 角度 */
export function radToDeg(rad: number): number {
  return (rad * 180) / Math.PI
}

/** 限制数值范围 */
export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

/** 吸附到网格 */
export function snapToGrid(value: number, gridSize: number): number {
  return Math.round(value / gridSize) * gridSize
}

/** px → EMU */
export function pxToEmu(px: number): number {
  return Math.round(px * PX_TO_EMU)
}

/** EMU → px */
export function emuToPx(emu: number): number {
  return emu / PX_TO_EMU
}

/** px → pt */
export function pxToPt(px: number): number {
  return (px / PX_PER_INCH) * POINTS_PER_INCH
}

/** pt → px */
export function ptToPx(pt: number): number {
  return (pt / POINTS_PER_INCH) * PX_PER_INCH
}

/** px → inch */
export function pxToInch(px: number): number {
  return px / PX_PER_INCH
}

/** inch → px */
export function inchToPx(inch: number): number {
  return inch * PX_PER_INCH
}

/**
 * 将阴影的 color + opacity 合并为最终 CSS 颜色值。
 *
 * PPTElementShadow 的 color 可能已经是 rgba()，同时还有独立的 opacity 字段。
 * 本函数优先使用 opacity 字段（如果存在），将最终颜色输出为 rgba()。
 */
export function resolveShadowCssColor(color: string, opacity?: number): string {
  if (opacity == null || opacity >= 1) return color

  // 解析已有的颜色值
  const rgbaMatch = color.match(
    /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([0-9]*\.?[0-9]+)\s*)?\)/i,
  )
  if (rgbaMatch) {
    const r = rgbaMatch[1]
    const g = rgbaMatch[2]
    const b = rgbaMatch[3]
    return `rgba(${r},${g},${b},${Math.max(0, Math.min(1, opacity))})`
  }

  // #RRGGBB 或 #RGB
  const hexMatch = color.match(/^#([0-9a-fA-F]{3,8})$/)
  if (hexMatch) {
    let hex = hexMatch[1]
    if (hex.length === 3) hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2]
    else if (hex.length === 4) hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2] // ignore alpha nibble
    else if (hex.length === 8) hex = hex.slice(0, 6) // ignore existing alpha
    const r = parseInt(hex.slice(0, 2), 16)
    const g = parseInt(hex.slice(2, 4), 16)
    const b = parseInt(hex.slice(4, 6), 16)
    return `rgba(${r},${g},${b},${Math.max(0, Math.min(1, opacity))})`
  }

  return color
}

/** 构建 CSS box-shadow 字符串（合并 opacity） */
export function buildShadowStyle(shadow: { h: number; v: number; blur: number; color: string; opacity?: number }): string {
  const color = resolveShadowCssColor(shadow.color, shadow.opacity)
  return `${shadow.h}px ${shadow.v}px ${shadow.blur}px ${color}`
}

/** 构建 CSS drop-shadow filter 字符串（合并 opacity） */
export function buildDropShadowFilter(shadow: { h: number; v: number; blur: number; color: string; opacity?: number }): string {
  const color = resolveShadowCssColor(shadow.color, shadow.opacity)
  return `drop-shadow(${shadow.h}px ${shadow.v}px ${shadow.blur}px ${color})`
}

/**
 * 构建元素的 flip transform 前缀字符串。
 *
 * 用于 Moveable 旋转/拖拽时保留 flipH/flipV 状态，
 * 以及 ElementRenderer 的 transform 构建。
 */
export function buildFlipTransform(el: { flipH?: boolean; flipV?: boolean }): string {
  const parts: string[] = []
  if (el.flipH) parts.push('scaleX(-1)')
  if (el.flipV) parts.push('scaleY(-1)')
  return parts.join(' ')
}

/** 矩形交叉检测 */
export function rectsIntersect(
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number },
): boolean {
  return (
    a.x < b.x + b.width &&
    a.x + a.width > b.x &&
    a.y < b.y + b.height &&
    a.y + a.height > b.y
  )
}

/**
 * 适配画布到容器（fit-to-screen）时使用的内边距（px）。
 * Canvas.fitToContainer 和 SlideEditor.handleFitCanvas 共享此值。
 */
export const CANVAS_FIT_PADDING = 60

/**
 * 给定容器尺寸和画布尺寸，计算 fit-to-screen 缩放比。
 * 返回 <= 1 的值（不会超过 100%）。
 */
export function calculateFitZoom(
  containerWidth: number,
  containerHeight: number,
  canvasWidth: number,
  canvasHeight: number,
): number {
  if (containerWidth <= 0 || containerHeight <= 0) return 1
  const scaleX = (containerWidth - CANVAS_FIT_PADDING * 2) / canvasWidth
  const scaleY = (containerHeight - CANVAS_FIT_PADDING * 2) / canvasHeight
  return Math.min(scaleX, scaleY, 1)
}

/** 计算多个矩形的包围盒 */
export function boundingRect(
  rects: { x: number; y: number; width: number; height: number }[],
): { x: number; y: number; width: number; height: number } {
  if (rects.length === 0) return { x: 0, y: 0, width: 0, height: 0 }
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const r of rects) {
    minX = Math.min(minX, r.x)
    minY = Math.min(minY, r.y)
    maxX = Math.max(maxX, r.x + r.width)
    maxY = Math.max(maxY, r.y + r.height)
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY }
}
