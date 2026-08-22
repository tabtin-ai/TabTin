/**
 * 重构来源：packages/agent-runtime/src/tools/show-widget.ts（行 50-60、132-311）
 * 拆分时间：2026-04-30
 * 重构原因：show-widget.ts 711 行单文件过大，按职责拆分
 * 职责：Mermaid 源码编译成 SVG + 格式分发 prepareWidgetSource。
 *       与 sanitizer.ts 有单向依赖（prepare 调 hasDangerous* / scrubSvg / compileMermaidToSvg
 *       最终 scrubSvg 输出）。
 * 业务逻辑版本：与拆分前完全相同，只是 module 边界调整
 */

import { JSDOM } from 'jsdom'
import { hasDangerousHtml, hasDangerousMermaidSource, scrubSvg } from './sanitizer.js'

/**
 * Widget Wave 6 上线接受的 format：
 *   - svg：原生 SVG，保持 Wave 2-4 行为
 *   - html：no-script 静态 HTML mockup / stepper / card layout
 *   - mermaid：工具 execute 阶段编译成 SVG，最终 block 不依赖 runtime mermaid.js
 */
export type WidgetFormat = 'svg' | 'html' | 'mermaid'

export interface PreparedWidgetSource {
  renderCode: string
  renderFormat: 'svg' | 'html'
  sourceCode?: string
}

let mermaidRenderSeq = 0
let mermaidDomReady = false

interface SvgBounds {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

function defineDomGlobal(name: string, value: unknown): void {
  Object.defineProperty(globalThis, name, {
    value,
    configurable: true,
    writable: true,
  })
}

function ensureMermaidDom(): void {
  const maybeDomGlobal = globalThis as typeof globalThis & {
    document?: unknown
    window?: unknown
  }
  if (mermaidDomReady) return

  let win = maybeDomGlobal.window as
    | {
      document: unknown
      navigator: unknown
      Element: unknown
      SVGElement: { prototype: unknown }
      HTMLElement: unknown
      Node: unknown
    }
    | undefined
  if (!maybeDomGlobal.document || !win) {
    const dom = new JSDOM('<!doctype html><html><body></body></html>', {
      pretendToBeVisual: true,
    })
    win = dom.window as unknown as {
      document: unknown
      navigator: unknown
      Element: unknown
      SVGElement: { prototype: unknown }
      HTMLElement: unknown
      Node: unknown
    }
    defineDomGlobal('window', win)
    defineDomGlobal('document', win.document)
    defineDomGlobal('navigator', win.navigator)
    defineDomGlobal('Element', win.Element)
    defineDomGlobal('SVGElement', win.SVGElement)
    defineDomGlobal('HTMLElement', win.HTMLElement)
    defineDomGlobal('Node', win.Node)
  }
  // jsdom does not implement SVG text measurement. Mermaid needs these APIs
  // during layout; fixed conservative boxes keep compilation deterministic.
  const svgProto = win.SVGElement.prototype as unknown as {
    getBBox?: () => { x: number; y: number; width: number; height: number }
    getComputedTextLength?: () => number
  }
  if (!svgProto.getBBox) {
    svgProto.getBBox = function getBBox() {
      return { x: 0, y: 0, width: 80, height: 24 }
    }
  }
  if (!svgProto.getComputedTextLength) {
    svgProto.getComputedTextLength = function getComputedTextLength() {
      return 80
    }
  }
  mermaidDomReady = true
}

async function compileMermaidToSvg(source: string): Promise<string> {
  ensureMermaidDom()
  const mermaid = (await import('mermaid')).default
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    deterministicIds: true,
    deterministicIDSeed: 'tabtin-widget',
    theme: 'base',
    flowchart: {
      // jsdom 无法真实测量 foreignObject/html label 尺寸；用 SVG text label
      // 可避免 Mermaid 输出 0x0 label，后续再按几何坐标重算 viewBox。
      htmlLabels: false,
    },
    themeVariables: {
      background: 'transparent',
      primaryColor: 'transparent',
      primaryTextColor: '#1f2937',
      lineColor: '#64748b',
      textColor: '#1f2937',
    },
  })
  const id = `tabtin_widget_mermaid_${Date.now().toString(36)}_${mermaidRenderSeq++}`
  const rendered = await mermaid.render(id, source)
  const normalized = normalizeMermaidSvgViewport(rendered.svg)
  // P0-4 信任边界分层：Mermaid 编译器是受控来源（源码 DSL + securityLevel:'strict'
  // + hasDangerousMermaidSource 前置拦截），允许 Mermaid 产物里的受控结构通过；
  // 但仍清 `<script>` / `on*=` / `javascript:`（defense-in-depth，防 Mermaid
  // 未来升级引入非预期 DOM）。
  const svg = scrubSvg(normalized, { trustedOrigin: true })
  if (!svg.includes('<svg')) {
    throw new Error('Mermaid compiler returned non-SVG output')
  }
  return svg
}

function parseFiniteNumber(raw: string | null): number | null {
  if (raw == null || raw.trim() === '') return null
  const value = Number(raw)
  return Number.isFinite(value) ? value : null
}

function includePoint(bounds: SvgBounds, x: number, y: number): void {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return
  bounds.minX = Math.min(bounds.minX, x)
  bounds.minY = Math.min(bounds.minY, y)
  bounds.maxX = Math.max(bounds.maxX, x)
  bounds.maxY = Math.max(bounds.maxY, y)
}

function includeRect(bounds: SvgBounds, x: number, y: number, width: number, height: number): void {
  if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return
  includePoint(bounds, x, y)
  includePoint(bounds, x + width, y + height)
}

function readTranslate(transform: string | null): { x: number; y: number } | null {
  if (!transform) return null
  const match = transform.match(/translate\(\s*(-?\d+(?:\.\d+)?)(?:[,\s]+(-?\d+(?:\.\d+)?))?\s*\)/)
  if (!match) return null
  const x = parseFiniteNumber(match[1])
  const y = parseFiniteNumber(match[2] ?? '0')
  if (x == null || y == null) return null
  return { x, y }
}

function accumulatedTranslate(el: Element, root: Element): { x: number; y: number } {
  let x = 0
  let y = 0
  let cur: Element | null = el
  while (cur && cur !== root) {
    const translate = readTranslate(cur.getAttribute('transform'))
    if (translate) {
      x += translate.x
      y += translate.y
    }
    cur = cur.parentElement
  }
  return { x, y }
}

function removeInvalidTransforms(root: Element): void {
  for (const el of Array.from(root.querySelectorAll('[transform]'))) {
    const transform = el.getAttribute('transform') ?? ''
    if (/undefined|NaN/i.test(transform)) {
      el.removeAttribute('transform')
    }
  }
}

function includePathBounds(bounds: SvgBounds, root: Element): void {
  for (const path of Array.from(root.querySelectorAll('path[d]'))) {
    if (path.closest('marker')) continue
    const d = path.getAttribute('d') ?? ''
    const nums = d.match(/-?\d+(?:\.\d+)?/g)?.map(Number).filter(Number.isFinite) ?? []
    for (let i = 0; i + 1 < nums.length; i += 2) {
      includePoint(bounds, nums[i], nums[i + 1])
    }
  }
}

function includeShapeBounds(bounds: SvgBounds, root: Element): void {
  for (const rect of Array.from(root.querySelectorAll('rect'))) {
    if (rect.closest('marker')) continue
    const tx = accumulatedTranslate(rect, root)
    const x = parseFiniteNumber(rect.getAttribute('x')) ?? 0
    const y = parseFiniteNumber(rect.getAttribute('y')) ?? 0
    const width = parseFiniteNumber(rect.getAttribute('width')) ?? 0
    const height = parseFiniteNumber(rect.getAttribute('height')) ?? 0
    includeRect(bounds, tx.x + x, tx.y + y, width, height)
  }
  for (const text of Array.from(root.querySelectorAll('text'))) {
    const tx = accumulatedTranslate(text, root)
    const x = parseFiniteNumber(text.getAttribute('x')) ?? 0
    const y = parseFiniteNumber(text.getAttribute('y')) ?? 0
    // jsdom 下文本真实宽度不可得，用保守尺寸保证 viewBox 至少覆盖 label 锚点附近。
    includeRect(bounds, tx.x + x - 80, tx.y + y - 16, 160, 32)
  }
}

function normalizeMermaidSvgViewport(svg: string): string {
  try {
    const dom = new JSDOM(svg)
    const svgEl = dom.window.document.querySelector('svg')
    if (!svgEl) return svg

    removeInvalidTransforms(svgEl)

    const bounds: SvgBounds = {
      minX: Number.POSITIVE_INFINITY,
      minY: Number.POSITIVE_INFINITY,
      maxX: Number.NEGATIVE_INFINITY,
      maxY: Number.NEGATIVE_INFINITY,
    }
    includePathBounds(bounds, svgEl)
    includeShapeBounds(bounds, svgEl)

    if (![bounds.minX, bounds.minY, bounds.maxX, bounds.maxY].every(Number.isFinite)) {
      return svgEl.outerHTML
    }

    const padding = 16
    const minX = Math.floor(bounds.minX - padding)
    const minY = Math.floor(bounds.minY - padding)
    const width = Math.ceil(bounds.maxX - bounds.minX + padding * 2)
    const height = Math.ceil(bounds.maxY - bounds.minY + padding * 2)
    if (width <= 0 || height <= 0) return svgEl.outerHTML

    svgEl.setAttribute('viewBox', `${minX} ${minY} ${width} ${height}`)
    svgEl.setAttribute('width', '100%')
    svgEl.removeAttribute('height')

    const style = svgEl.getAttribute('style') ?? ''
    const nextStyle = style.replace(/max-width\s*:\s*[^;]+;?/i, '').trim()
    if (nextStyle) svgEl.setAttribute('style', nextStyle)
    else svgEl.removeAttribute('style')

    return svgEl.outerHTML
  } catch {
    return svg
  }
}

export async function prepareWidgetSource(format: WidgetFormat, code: string): Promise<PreparedWidgetSource> {
  if (format === 'html') {
    const unsafe = hasDangerousHtml(code)
    if (unsafe) throw new Error(unsafe)
    return { renderCode: code, renderFormat: 'html' }
  }

  if (format === 'mermaid') {
    const unsafe = hasDangerousMermaidSource(code)
    if (unsafe) throw new Error(unsafe)
    const svg = await compileMermaidToSvg(code)
    return { renderCode: svg, renderFormat: 'svg', sourceCode: code }
  }

  return { renderCode: scrubSvg(code), renderFormat: 'svg' }
}
