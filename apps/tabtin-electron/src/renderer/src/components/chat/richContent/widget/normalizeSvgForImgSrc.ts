/**
 * 把对话 Widget 的 SVG 规范化成适合 <img src> 的形态。
 *
 * Chat 里 SVG 在 iframe + wrapper 中按 viewBox 缩放；直接 data-URL 进文档时，
 * 若根节点是 width/height=100%、缺 viewBox、或 preserveAspectRatio=none，
 * 浏览器固有尺寸会错，表现为纵向/横向拉伸。
 */

export type NormalizedSvgForImg = {
  code: string
  width: number
  height: number
}

function parseNumericLength(raw: string | undefined): number | null {
  if (!raw) return null
  const trimmed = raw.trim()
  if (!trimmed || trimmed.endsWith('%')) return null
  const match = trimmed.match(/^([\d.]+)\s*(px|pt|em|rem)?$/i)
  if (!match) return null
  const n = Number(match[1])
  if (!Number.isFinite(n) || n <= 0) return null
  return Math.round(n)
}

function parseViewBoxSize(viewBox: string): { width: number; height: number } | null {
  const parts = viewBox.trim().split(/[\s,]+/).map(Number)
  if (parts.length !== 4) return null
  const [, , w, h] = parts
  if (![w, h].every((n) => Number.isFinite(n) && n > 0)) return null
  return { width: Math.round(w), height: Math.round(h) }
}

function rewriteSvgOpenTag(
  openTag: string,
  dims: { width: number; height: number },
  viewBox: string | null,
): string {
  let tag = openTag
  // 去掉百分比或不靠谱的宽高，稍后写回数值
  tag = tag.replace(/\s(width|height)\s*=\s*(["'])[^"']*\2/gi, '')
  // 去掉会强制拉伸的 none
  tag = tag.replace(/\spreserveAspectRatio\s*=\s*(["'])none\1/gi, '')

  if (viewBox && !/\sviewBox\s*=/i.test(tag)) {
    tag = tag.replace(/<svg\b/i, `<svg viewBox="${viewBox}"`)
  }

  if (!/\spreserveAspectRatio\s*=/i.test(tag)) {
    tag = tag.replace(/<svg\b/i, '<svg preserveAspectRatio="xMidYMid meet"')
  }

  tag = tag.replace(
    /<svg\b/i,
    `<svg width="${dims.width}" height="${dims.height}"`,
  )
  return tag
}

/**
 * 规范化 SVG，返回可安全作 img src 的源码与固有宽高。
 * 解析失败返回 null。
 */
export function normalizeSvgForImgSrc(svgCode: string): NormalizedSvgForImg | null {
  const code = svgCode.trim()
  const openMatch = code.match(/<svg\b[^>]*>/i)
  if (!openMatch || openMatch.index == null) return null

  const openTag = openMatch[0]
  const viewBoxAttr = openTag.match(/\sviewBox\s*=\s*(["'])([^"']*)\1/i)?.[2] ?? null
  const vb = viewBoxAttr ? parseViewBoxSize(viewBoxAttr) : null

  const attrW = parseNumericLength(openTag.match(/\swidth\s*=\s*(["'])([^"']*)\1/i)?.[2])
  const attrH = parseNumericLength(openTag.match(/\sheight\s*=\s*(["'])([^"']*)\1/i)?.[2])

  let width = vb?.width ?? attrW
  let height = vb?.height ?? attrH

  // 只有一侧时按另一侧估个接近正方形的兜底，避免 300×150 浏览器默认
  if (width && !height) height = width
  if (height && !width) width = height
  if (!width || !height) {
    width = 680
    height = 400
  }

  // 用 viewBox 时优先以 viewBox 为准（属性宽高常是 100% 或 wrapper 视口）
  if (vb) {
    width = vb.width
    height = vb.height
  }

  const ensuredViewBox = viewBoxAttr ?? `0 0 ${width} ${height}`
  const nextOpen = rewriteSvgOpenTag(openTag, { width, height }, ensuredViewBox)
  const nextCode = code.slice(0, openMatch.index) + nextOpen + code.slice(openMatch.index + openTag.length)

  return { code: nextCode, width, height }
}

/** 文档内展示宽度上限，只写 width、height 交由 CSS auto 保比例 */
export const DOC_IMAGE_MAX_DISPLAY_WIDTH = 560

export function capDisplayWidth(width: number, height: number, maxWidth = DOC_IMAGE_MAX_DISPLAY_WIDTH): {
  width: number
  height: number
} {
  if (width <= maxWidth) return { width, height }
  const scale = maxWidth / width
  return {
    width: Math.round(maxWidth),
    height: Math.max(1, Math.round(height * scale)),
  }
}
