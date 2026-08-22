export const TABSLIDE_LATEX_META_PREFIX = 'TABSLIDE_LATEX_V1:'

export interface LatexRenderOptions {
  display?: boolean
  color?: string
}

export interface LatexSvgRenderResult {
  svg: string
  viewBox: [number, number]
  path?: string
}

export interface LatexMetadataPayload {
  latex: string
  svg?: string
  path?: string
  viewBox?: [number, number]
  color?: string
  strokeWidth?: number
  fixedRatio?: boolean
}

export interface SvgViewBoxInfo {
  width: number
  height: number
  viewBox: string
}

export type LatexVisualRegenerator = (
  latexSource: string,
  color: string,
) => LatexSvgRenderResult | null

const MAX_LATEX_META_LENGTH = 24_000

let activeLatexVisualRegenerator: LatexVisualRegenerator | null = null

export function setLatexVisualRegenerator(regenerator: LatexVisualRegenerator | null): void {
  activeLatexVisualRegenerator = regenerator
}

export function getLatexVisualRegenerator(): LatexVisualRegenerator | null {
  return activeLatexVisualRegenerator
}

function utf8ToBase64(text: string): string {
  if (typeof btoa === 'function') {
    const bytes = new TextEncoder().encode(text)
    let binary = ''
    for (const b of bytes) binary += String.fromCharCode(b)
    return btoa(binary)
  }

  const maybeBuffer = (globalThis as unknown as {
    Buffer?: { from: (input: string, encoding: string) => { toString: (encoding: string) => string } }
  }).Buffer
  if (maybeBuffer) {
    return maybeBuffer.from(text, 'utf8').toString('base64')
  }

  throw new Error('Base64 编码不可用')
}

function base64ToUtf8(base64: string): string {
  if (typeof atob === 'function') {
    const binary = atob(base64)
    const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0))
    return new TextDecoder().decode(bytes)
  }

  const maybeBuffer = (globalThis as unknown as {
    Buffer?: { from: (input: string, encoding: string) => { toString: (encoding: string) => string } }
  }).Buffer
  if (maybeBuffer) {
    return maybeBuffer.from(base64, 'base64').toString('utf8')
  }

  throw new Error('Base64 解码不可用')
}

export function sanitizeSvgUnsafe(svg: string): string {
  return svg
    .replace(/<\?xml[\s\S]*?\?>/gi, '')
    .replace(/<!DOCTYPE[\s\S]*?>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<foreignObject[\s\S]*?<\/foreignObject>/gi, '')
    .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*')/gi, '')
    .replace(/\s(?:href|xlink:href)\s*=\s*("javascript:[^"]*"|'javascript:[^']*')/gi, '')
    .trim()
}

const SVG_SAFE_ELEMENTS = new Set([
  'svg', 'g', 'defs', 'symbol', 'use',
  'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon',
  'text', 'tspan', 'textPath',
  'clipPath', 'mask', 'pattern', 'marker',
  'linearGradient', 'radialGradient', 'stop',
  'title', 'desc',
])

const SVG_SAFE_ATTRS = new Set([
  'viewBox', 'preserveAspectRatio', 'xmlns', 'xmlns:xlink',
  'width', 'height', 'x', 'y', 'cx', 'cy', 'r', 'rx', 'ry',
  'd', 'points', 'x1', 'y1', 'x2', 'y2',
  'fill', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin',
  'stroke-dasharray', 'stroke-dashoffset', 'stroke-miterlimit',
  'opacity', 'fill-opacity', 'stroke-opacity', 'fill-rule', 'clip-rule',
  'transform', 'style', 'class', 'id',
  'font-family', 'font-size', 'font-weight', 'font-style',
  'text-anchor', 'dominant-baseline', 'alignment-baseline',
  'color', 'vector-effect', 'data-tabslide-latex-stroke',
  'offset', 'stop-color', 'stop-opacity', 'gradientUnits', 'gradientTransform',
  'patternUnits', 'patternContentUnits', 'patternTransform',
  'clipPathUnits', 'maskUnits', 'maskContentUnits',
  'markerWidth', 'markerHeight', 'orient', 'refX', 'refY', 'markerUnits',
  'overflow', 'display', 'visibility',
])

const DANGEROUS_STYLE_PATTERNS = [
  /url\s*\(/i,
  /expression\s*\(/i,
  /javascript\s*:/i,
  /-moz-binding/i,
  /behavior\s*:/i,
  /@import/i,
]

function sanitizeStyleValue(style: string): string {
  for (const pattern of DANGEROUS_STYLE_PATTERNS) {
    if (pattern.test(style)) {
      return style
        .split(';')
        .map((s) => s.trim())
        .filter((s) => !DANGEROUS_STYLE_PATTERNS.some((p) => p.test(s)))
        .join(';')
    }
  }
  return style
}

export function sanitizeSvgStrict(svg: string): string {
  if (typeof DOMParser === 'undefined' || typeof XMLSerializer === 'undefined') {
    return ''
  }

  const parser = new DOMParser()
  const doc = parser.parseFromString(svg, 'image/svg+xml')

  const errorNode = doc.querySelector('parsererror')
  if (errorNode) return ''

  const root = doc.documentElement
  if (root.tagName.toLowerCase() !== 'svg') return ''

  function cleanElement(el: Element): void {
    const children = Array.from(el.children)
    for (const child of children) {
      const tag = child.tagName.toLowerCase()
      if (!SVG_SAFE_ELEMENTS.has(tag)) {
        el.removeChild(child)
        continue
      }
      const attrs = Array.from(child.attributes)
      for (const attr of attrs) {
        if (attr.name.startsWith('on')) {
          child.removeAttribute(attr.name)
        } else if (attr.name === 'href' || attr.name === 'xlink:href') {
          if (tag !== 'use' || !attr.value.startsWith('#')) {
            child.removeAttribute(attr.name)
          }
        } else if (attr.name === 'style') {
          child.setAttribute('style', sanitizeStyleValue(attr.value))
        } else if (!SVG_SAFE_ATTRS.has(attr.name)) {
          child.removeAttribute(attr.name)
        }
      }
      cleanElement(child)
    }
  }

  const rootAttrs = Array.from(root.attributes)
  for (const attr of rootAttrs) {
    if (attr.name.startsWith('on')) {
      root.removeAttribute(attr.name)
    } else if (attr.name === 'style') {
      root.setAttribute('style', sanitizeStyleValue(attr.value))
    } else if (!SVG_SAFE_ATTRS.has(attr.name)) {
      root.removeAttribute(attr.name)
    }
  }

  cleanElement(root)

  return new XMLSerializer().serializeToString(root)
}

export function parseViewBox(svgEl: SVGElement): SvgViewBoxInfo {
  const parseViewBoxRaw = (raw: string | null): [number, number, number, number] | null => {
    if (!raw) return null
    const nums = raw
      .split(/[\s,]+/)
      .map((n) => parseFloat(n))
      .filter((n) => Number.isFinite(n))
    if (nums.length !== 4) return null
    if (nums[2] <= 0 || nums[3] <= 0) return null
    return [nums[0], nums[1], nums[2], nums[3]]
  }

  const vb = svgEl.getAttribute('viewBox')
  const parsedVb = parseViewBoxRaw(vb)
  if (parsedVb) {
    return {
      width: parsedVb[2],
      height: parsedVb[3],
      viewBox: `${parsedVb[0]} ${parsedVb[1]} ${parsedVb[2]} ${parsedVb[3]}`,
    }
  }

  const parseLen = (raw: string | null): number | null => {
    if (!raw) return null
    const m = raw.match(/-?\d*\.?\d+/)
    if (!m) return null
    const val = parseFloat(m[0])
    return Number.isFinite(val) && val > 0 ? val : null
  }

  const w = parseLen(svgEl.getAttribute('width'))
  const h = parseLen(svgEl.getAttribute('height'))
  if (w && h) {
    return {
      width: w,
      height: h,
      viewBox: `0 0 ${w} ${h}`,
    }
  }

  return {
    width: 100,
    height: 32,
    viewBox: '0 0 100 32',
  }
}

export function patchSvgRoot(
  svg: string,
  attrs: Record<string, string>,
): string {
  return svg.replace(/<svg\b([^>]*)>/i, (_m, attrChunk: string) => {
    const map = new Map<string, string>()

    const attrRegex = /([:\w-]+)\s*=\s*("[^"]*"|'[^']*')/g
    let match: RegExpExecArray | null
    while ((match = attrRegex.exec(attrChunk)) !== null) {
      const key = match[1]
      const value = match[2].slice(1, -1)
      map.set(key, value)
    }

    for (const [k, v] of Object.entries(attrs)) {
      map.set(k, v)
    }

    const serialized = Array.from(map.entries())
      .map(([k, v]) => ` ${k}="${v}"`)
      .join('')

    return `<svg${serialized}>`
  })
}

export function buildLatexSvgFromPath(
  path: string,
  viewBox: [number, number],
  color = '#111111',
  strokeWidth = 0,
): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${viewBox[0]} ${viewBox[1]}" width="${viewBox[0]}" height="${viewBox[1]}" preserveAspectRatio="xMidYMid meet" style="color:${color}"><path d="${path}" fill="currentColor" stroke="currentColor" stroke-width="${strokeWidth}"/></svg>`
}

export function normalizeLatexSvgForDisplay(svg: string): string {
  const strict = sanitizeSvgStrict(svg)
  if (strict) {
    return patchSvgRoot(strict, {
      width: '100%',
      height: '100%',
      preserveAspectRatio: 'xMidYMid meet',
    })
  }
  if (typeof DOMParser === 'undefined') {
    return ''
  }
  const cleaned = sanitizeSvgUnsafe(svg)
  return patchSvgRoot(cleaned, {
    width: '100%',
    height: '100%',
    preserveAspectRatio: 'xMidYMid meet',
  })
}

export function applyColorToLatexSvg(svg: string, color: string): string {
  const cleaned = sanitizeSvgStrict(svg) || sanitizeSvgUnsafe(svg)

  if (typeof DOMParser !== 'undefined' && typeof XMLSerializer !== 'undefined') {
    const parser = new DOMParser()
    const doc = parser.parseFromString(cleaned, 'image/svg+xml')
    const root = doc.querySelector('svg')
    if (root) {
      const style = root.getAttribute('style') || ''
      const noColor = style
        .split(';')
        .map((x) => x.trim())
        .filter((x) => x && !x.startsWith('color:'))
      noColor.push(`color:${color}`)
      root.setAttribute('style', noColor.join(';'))
      return new XMLSerializer().serializeToString(root)
    }
  }

  return patchSvgRoot(cleaned, { style: `color:${color}` })
}

export function applyStrokeWidthToLatexSvg(svg: string, strokeWidth: number): string {
  const cleaned = sanitizeSvgStrict(svg) || sanitizeSvgUnsafe(svg)
  const safeStroke = Number.isFinite(strokeWidth) ? Math.max(0, strokeWidth) : 0

  if (typeof DOMParser !== 'undefined' && typeof XMLSerializer !== 'undefined') {
    const parser = new DOMParser()
    const doc = parser.parseFromString(cleaned, 'image/svg+xml')
    const root = doc.querySelector('svg')
    if (root) {
      if (safeStroke > 0) {
        root.querySelectorAll('path').forEach((pathEl) => {
          pathEl.setAttribute('stroke', 'currentColor')
          pathEl.setAttribute('stroke-width', `${safeStroke}`)
          pathEl.setAttribute('vector-effect', 'non-scaling-stroke')
          pathEl.setAttribute('data-tabslide-latex-stroke', '1')
        })
      } else {
        root.querySelectorAll('path[data-tabslide-latex-stroke="1"]').forEach((pathEl) => {
          pathEl.removeAttribute('stroke')
          pathEl.removeAttribute('stroke-width')
          pathEl.removeAttribute('vector-effect')
          pathEl.removeAttribute('data-tabslide-latex-stroke')
        })
      }
      return new XMLSerializer().serializeToString(root)
    }
  }

  return cleaned
}

function escapeXml(raw: string): string {
  return raw
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

export function buildLatexPlaceholderSvg(
  latex: string,
  color = '#111111',
  width = 320,
  height = 96,
): string {
  const w = Number.isFinite(width) ? width : 320
  const h = Number.isFinite(height) ? height : 96
  const safeW = Math.max(120, Math.round(w))
  const safeH = Math.max(40, Math.round(h))
  const source = latex.trim().replace(/\s+/g, ' ')
  const clipped = source.length > 240 ? `${source.slice(0, 237)}...` : source
  const safeText = escapeXml(clipped || 'LaTeX')
  const safeColor = escapeXml(color || '#111111')
  const fontSize = Math.max(12, Math.min(28, Math.round(safeH * 0.28)))
  const y = Math.round(safeH / 2)

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${safeW} ${safeH}" width="${safeW}" height="${safeH}" preserveAspectRatio="xMidYMid meet"><rect x="0" y="0" width="${safeW}" height="${safeH}" fill="transparent"/><text x="12" y="${y}" fill="${safeColor}" dominant-baseline="middle" text-anchor="start" font-family="Times New Roman, serif" font-size="${fontSize}">${safeText}</text></svg>`
}

export function svgToDataUrl(svg: string): string {
  return `data:image/svg+xml;base64,${utf8ToBase64(svg)}`
}

export async function renderLatexSvgToPngDataUrl(
  svg: string,
  targetWidth: number,
  targetHeight: number,
  scale = 3,
): Promise<string> {
  const safeW = Math.max(1, Math.round(targetWidth))
  const safeH = Math.max(1, Math.round(targetHeight))

  const maxPixels = 16_000_000
  let pixelW = Math.max(1, Math.round(safeW * scale))
  let pixelH = Math.max(1, Math.round(safeH * scale))

  if (pixelW * pixelH > maxPixels) {
    const ratio = Math.sqrt(maxPixels / (pixelW * pixelH))
    pixelW = Math.max(1, Math.floor(pixelW * ratio))
    pixelH = Math.max(1, Math.floor(pixelH * ratio))
  }

  const blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' })
  const url = URL.createObjectURL(blob)

  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image()
      img.onload = () => resolve(img)
      img.onerror = () => reject(new Error('SVG 转 PNG 失败'))
      img.src = url
    })

    const canvas = document.createElement('canvas')
    canvas.width = pixelW
    canvas.height = pixelH

    const ctx = canvas.getContext('2d')
    if (!ctx) {
      throw new Error('Canvas 初始化失败')
    }

    ctx.clearRect(0, 0, pixelW, pixelH)
    ctx.drawImage(image, 0, 0, pixelW, pixelH)

    return canvas.toDataURL('image/png')
  } finally {
    URL.revokeObjectURL(url)
  }
}

export function encodeLatexMetadata(payload: LatexMetadataPayload): string {
  const safePayload: LatexMetadataPayload = {
    latex: payload.latex,
    ...(payload.svg ? { svg: payload.svg } : {}),
    ...(payload.path ? { path: payload.path } : {}),
    ...(payload.viewBox ? { viewBox: payload.viewBox } : {}),
    ...(payload.color ? { color: payload.color } : {}),
    ...(payload.strokeWidth != null ? { strokeWidth: payload.strokeWidth } : {}),
    ...(payload.fixedRatio != null ? { fixedRatio: payload.fixedRatio } : {}),
  }

  const encode = (v: LatexMetadataPayload) => `${TABSLIDE_LATEX_META_PREFIX}${utf8ToBase64(JSON.stringify(v))}`

  let encoded = encode(safePayload)
  if (encoded.length <= MAX_LATEX_META_LENGTH) return encoded

  if (safePayload.svg) {
    delete safePayload.svg
    encoded = encode(safePayload)
    if (encoded.length <= MAX_LATEX_META_LENGTH) return encoded
  }

  if (safePayload.path) {
    delete safePayload.path
    encoded = encode(safePayload)
    if (encoded.length <= MAX_LATEX_META_LENGTH) return encoded
  }

  const minimal: LatexMetadataPayload = {
    latex: safePayload.latex,
    ...(safePayload.color ? { color: safePayload.color } : {}),
    ...(safePayload.strokeWidth != null ? { strokeWidth: safePayload.strokeWidth } : {}),
    ...(safePayload.fixedRatio != null ? { fixedRatio: safePayload.fixedRatio } : {}),
  }

  encoded = encode(minimal)
  if (encoded.length <= MAX_LATEX_META_LENGTH) return encoded

  const maxLatexLen = Math.max(256, Math.floor(safePayload.latex.length * MAX_LATEX_META_LENGTH / encoded.length))
  minimal.latex = safePayload.latex.slice(0, maxLatexLen)
  return encode(minimal)
}

export function decodeLatexMetadata(raw?: string | null): LatexMetadataPayload | null {
  if (!raw || !raw.startsWith(TABSLIDE_LATEX_META_PREFIX)) return null

  try {
    const b64 = raw.slice(TABSLIDE_LATEX_META_PREFIX.length)
    const json = base64ToUtf8(b64)
    const obj = JSON.parse(json) as LatexMetadataPayload

    if (!obj || typeof obj.latex !== 'string') return null

    return {
      latex: obj.latex,
      ...(obj.svg ? { svg: obj.svg } : {}),
      ...(obj.path ? { path: obj.path } : {}),
      ...(obj.viewBox && obj.viewBox.length === 2
        && Number.isFinite(obj.viewBox[0]) && obj.viewBox[0] > 0
        && Number.isFinite(obj.viewBox[1]) && obj.viewBox[1] > 0
        ? { viewBox: [obj.viewBox[0], obj.viewBox[1]] as [number, number] }
        : {}),
      ...(obj.color ? { color: obj.color } : {}),
      ...(obj.strokeWidth != null ? { strokeWidth: obj.strokeWidth } : {}),
      ...(obj.fixedRatio != null ? { fixedRatio: obj.fixedRatio } : {}),
    }
  } catch {
    return null
  }
}
