/**
 * 图片导出 — html2canvas 截图每页导出 PNG/JPG
 *
 * 核心流程：
 * 1. 在离屏 DOM 中渲染一页幻灯片（复用 SlideShow 的纯 HTML 渲染逻辑）
 * 2. 使用 html2canvas-pro 截图为 Canvas
 * 3. 转换为 Blob / DataURL / 下载
 *
 * 同时提供「从已渲染 DOM 截图」和「自动构建离屏 DOM 截图」两种方式。
 */

import html2canvas from 'html2canvas-pro'
import * as echarts from 'echarts'
import type { SlidePresentation, Slide, PPTElement, PPTChartElement, PPTShapeElement } from '../types/slides'
import { buildChartOption, hasValidChartData } from '../utils/chart-option'
import { sanitizeHtml } from '../utils/sanitize'
import {
  getTableThemeColors,
  getCellThemeStyle,
  resolveTableCellStyle,
  getTableColumnCount,
  normalizeTableColWidths,
  normalizeTableRowHeights,
  resolveTableOuterBorderSpecs,
  resolveTableCellBorderSpecs,
  tableBorderSpecToCss,
} from '../utils/tableTheme'
import { getBackgroundCssText } from '../utils/background'
import { normalizeLatexSvgForDisplay } from '../utils/latex-shared'
import { buildShadowStyle, buildDropShadowFilter, ptToPx } from '../utils/geometry'
import { getLineLocalBounds, getLinePathD } from '../utils/line-geometry'
import { getShapePath } from '../configs/shapes'

const SAFE_URL_PROTOCOLS = /^https?:\/\//i

function escapeAttr(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function safeImageSrc(src: string | undefined | null): string {
  if (!src) return ''
  if (SAFE_URL_PROTOCOLS.test(src) || src.startsWith('data:image/') || src.startsWith('blob:')) return src
  if (src.startsWith('/') && !src.startsWith('//')) return src
  return ''
}

// ═══════════════════════════════════════════════
// 类型
// ═══════════════════════════════════════════════

export interface ImageExportOptions {
  /** 输出格式 */
  format?: 'png' | 'jpeg'
  /** JPEG 质量 0-1（仅 jpeg 格式有效） */
  quality?: number
  /** 输出图片宽度（px），高度按比例自动计算。默认使用 canvasWidth */
  width?: number
  /** 缩放倍率（默认 2x 保证清晰度） */
  scale?: number
  /** 背景色（默认白色，透明传 null） */
  backgroundColor?: string | null
}

export interface PageImageResult {
  pageIndex: number
  pageId: string
  blob: Blob
  dataUrl: string
}

// ═══════════════════════════════════════════════
// 从已渲染的 DOM 元素截图
// ═══════════════════════════════════════════════

/** 从一个已经渲染好的 DOM 元素截图 */
export async function captureElement(
  element: HTMLElement,
  options: ImageExportOptions = {},
): Promise<Blob> {
  const { format = 'png', quality = 0.92, scale = 2, backgroundColor } = options

  const canvas = await html2canvas(element, {
    scale,
    backgroundColor: backgroundColor !== undefined ? backgroundColor : null,
    useCORS: true,
    logging: false,
  })

  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) resolve(blob)
        else reject(new Error('Canvas toBlob 返回 null'))
      },
      `image/${format}`,
      quality,
    )
  })
}

// ═══════════════════════════════════════════════
// 自动构建离屏 DOM 导出
// ═══════════════════════════════════════════════

/**
 * 导出单页为图片
 *
 * 在离屏 DOM 中构建页面的纯 HTML 表示，使用 html2canvas 截图。
 */
export async function exportPageToImage(
  presentation: SlidePresentation,
  pageIndex: number,
  options: ImageExportOptions = {},
): Promise<PageImageResult> {
  const page = presentation.pages[pageIndex]
  if (!page) throw new Error(`页面索引 ${pageIndex} 不存在`)

  const { format = 'png', quality = 0.92, scale = 2, backgroundColor } = options
  const cw = options.width || presentation.canvasWidth
  const ch = options.width
    ? Math.round((presentation.canvasHeight / presentation.canvasWidth) * options.width)
    : presentation.canvasHeight

  // 构建离屏容器
  const container = document.createElement('div')
  container.style.cssText = `
    position: fixed; left: -99999px; top: -99999px;
    width: ${cw}px; height: ${ch}px; overflow: hidden;
    ${getBackgroundCssText(page.background, presentation.theme)}
  `
  document.body.appendChild(container)

  try {
    await renderPageElements(container, page, cw, ch, presentation)

    // 等待图片加载
    await waitForImages(container)

    // 截图
    const canvas = await html2canvas(container, {
      width: cw,
      height: ch,
      scale,
      // 容器已通过 CSS 应用了正确的幻灯片背景，html2canvas 的 backgroundColor
      // 只应在用户明确传入时才设置，否则用 null 避免白色底色覆盖渐变/图片/主题背景
      backgroundColor: backgroundColor !== undefined ? backgroundColor : null,
      useCORS: true,
      logging: false,
    })

    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (b) => b ? resolve(b) : reject(new Error('toBlob 返回 null')),
        `image/${format}`,
        quality,
      )
    })

    const dataUrl = canvas.toDataURL(`image/${format}`, quality)

    return {
      pageIndex,
      pageId: page.id,
      blob,
      dataUrl,
    }
  } finally {
    document.body.removeChild(container)
  }
}

/**
 * 批量导出所有页面为图片
 *
 * 流式处理：逐页渲染，每页完成后回调 onPage 让调用方消费/释放，
 * 避免大文稿所有 Blob 同时驻留内存。
 */
export async function exportAllPagesToImages(
  presentation: SlidePresentation,
  options: ImageExportOptions = {},
  onProgress?: (current: number, total: number) => void,
  onPage?: (result: PageImageResult, index: number) => void | Promise<void>,
): Promise<PageImageResult[]> {
  const results: PageImageResult[] = []
  const total = presentation.pages.length

  for (let i = 0; i < total; i++) {
    onProgress?.(i, total)
    const result = await exportPageToImage(presentation, i, options)
    if (onPage) {
      await onPage(result, i)
    }
    results.push(result)
  }

  onProgress?.(total, total)
  return results
}

/**
 * 导出单页并下载
 */
export async function downloadPageAsImage(
  presentation: SlidePresentation,
  pageIndex: number,
  options: ImageExportOptions = {},
  filename?: string,
): Promise<void> {
  const result = await exportPageToImage(presentation, pageIndex, options)
  const ext = (options.format || 'png')
  const name = filename || `${presentation.name || '幻灯片'}-第${pageIndex + 1}页.${ext}`
  downloadBlob(result.blob, name)
}

/**
 * 导出所有页面并下载 — 流式（渲染→下载→释放→下一张），
 * 不再积压所有 Blob，避免大文稿 OOM。
 */
export async function downloadAllPagesAsImages(
  presentation: SlidePresentation,
  options: ImageExportOptions = {},
  onProgress?: (current: number, total: number) => void,
): Promise<void> {
  const ext = (options.format || 'png')
  const total = presentation.pages.length

  for (let i = 0; i < total; i++) {
    onProgress?.(i, total)
    const result = await exportPageToImage(presentation, i, options)
    const name = `${presentation.name || '幻灯片'}-第${result.pageIndex + 1}页.${ext}`
    downloadBlob(result.blob, name)
    await new Promise((r) => setTimeout(r, 200))
  }

  onProgress?.(total, total)
}

// ═══════════════════════════════════════════════
// 内部：纯 DOM 渲染页面
// ═══════════════════════════════════════════════

async function renderPageElements(
  container: HTMLElement,
  page: Slide,
  cw: number,
  ch: number,
  presentation: SlidePresentation,
) {
  const patternDataUrls = await prefetchPatternImages(page.elements)
  for (const el of page.elements) {
    if (el.visible === false) continue
    const dom = createElement(el, cw, ch, patternDataUrls)
    if (dom) container.appendChild(dom)
  }
}

async function prefetchPatternImages(elements: PPTElement[]): Promise<Map<string, string>> {
  const map = new Map<string, string>()
  const urls = new Set<string>()
  for (const el of elements) {
    if (el.type === 'shape' && (el as PPTShapeElement).pattern) {
      const url = (el as PPTShapeElement).pattern!
      if (url && !url.startsWith('data:')) urls.add(url)
    }
  }
  await Promise.all(
    [...urls].map(async (url) => {
      try {
        const resp = await fetch(url, { mode: 'cors' })
        if (!resp.ok) return
        const blob = await resp.blob()
        const dataUrl = await new Promise<string>((resolve) => {
          const reader = new FileReader()
          reader.onloadend = () => resolve(reader.result as string)
          reader.readAsDataURL(blob)
        })
        map.set(url, dataUrl)
      } catch { /* cross-origin fetch failed — leave original URL */ }
    }),
  )
  return map
}

function createElement(el: PPTElement, _cw: number, _ch: number, patternDataUrls?: Map<string, string>): HTMLElement | null {
  const isLine = el.type === 'line'
  const wrapper = document.createElement('div')

  // 构建 transform：翻转 + 旋转（与编辑器 ElementRenderer 一致）
  const transforms: string[] = []
  if ('flipH' in el && (el as { flipH?: boolean }).flipH) transforms.push('scaleX(-1)')
  if ('flipV' in el && (el as { flipV?: boolean }).flipV) transforms.push('scaleY(-1)')
  const rotate = (el as { rotate?: number }).rotate
  if (rotate) transforms.push(`rotate(${rotate}deg)`)
  const transformStr = transforms.length ? transforms.join(' ') : ''
  const overflowMode = isLine || transformStr ? 'visible' : 'hidden'

  wrapper.style.cssText = `
    position: absolute;
    left: ${el.x}px;
    top: ${el.y}px;
    width: ${el.width}px;
    height: ${isLine ? 4 : (el as { height: number }).height}px;
    opacity: ${el.opacity};
    ${transformStr ? `transform: ${transformStr};` : ''}
    overflow: ${overflowMode};
  `

  switch (el.type) {
    case 'text': {
      const tm = el.margin
      wrapper.innerHTML = `<div style="
        width:100%;height:100%;box-sizing:border-box;
        font-family:${el.defaultFontName || 'sans-serif'};
        ${el.defaultFontSize ? `font-size:${el.defaultFontSize}pt;` : ''}
        color:${el.defaultColor || '#333'};
        line-height:${el.lineHeight || 1.5};
        ${el.wordSpace ? `letter-spacing:${el.wordSpace}px;` : ''}
        background:${el.fill || 'transparent'};
        overflow:hidden;
        ${tm ? `padding:${tm.top ?? 0}px ${tm.right ?? 0}px ${tm.bottom ?? 0}px ${tm.left ?? 0}px;` : ''}
        ${el.vertical ? 'writing-mode:vertical-rl;' : ''}
      ">${sanitizeHtml(el.content)}</div>`
      break
    }

    case 'image': {
      wrapper.style.overflow = 'hidden'
      if (el.radius) wrapper.style.borderRadius = `${el.radius}px`
      if (el.outline) wrapper.style.border = `${el.outline.width}px ${el.outline.style} ${el.outline.color}`
      if (el.shadow) wrapper.style.boxShadow = buildShadowStyle(el.shadow)

      const imgFilterParts: string[] = []
      if (el.filters) {
        if (el.filters.brightness !== undefined) imgFilterParts.push(`brightness(${el.filters.brightness})`)
        if (el.filters.contrast !== undefined) imgFilterParts.push(`contrast(${el.filters.contrast})`)
        if (el.filters.saturate !== undefined) imgFilterParts.push(`saturate(${el.filters.saturate})`)
        if (el.filters.blur !== undefined) imgFilterParts.push(`blur(${el.filters.blur}px)`)
        if (el.filters.grayscale !== undefined) imgFilterParts.push(`grayscale(${el.filters.grayscale})`)
        if (el.filters.invert !== undefined) imgFilterParts.push(`invert(${el.filters.invert})`)
        if (el.filters.hueRotate !== undefined) imgFilterParts.push(`hue-rotate(${el.filters.hueRotate}deg)`)
        if (el.filters.sepia !== undefined) imgFilterParts.push(`sepia(${el.filters.sepia})`)
      }
      const imgFilterStr = imgFilterParts.length ? imgFilterParts.join(' ') : ''

      let clipPathStr = ''
      if (el.clip) {
        if (el.clip.shape === 'ellipse') {
          clipPathStr = 'clip-path:ellipse(50% 50% at 50% 50%);'
        } else if (el.clip.range && el.clip.range.length >= 4) {
          clipPathStr = `clip-path:polygon(${el.clip.range.map((p: number[]) => `${p[0] * 100}% ${p[1] * 100}%`).join(', ')});`
        }
      }

      let imgHtml = `<img src="${escapeAttr(safeImageSrc(el.src))}" style="
        width:100%;height:100%;object-fit:${el.objectFit || 'cover'};
        ${el.radius ? `border-radius:${el.radius}px;` : ''}
        ${imgFilterStr ? `filter:${imgFilterStr};` : ''}
        ${clipPathStr}
      " crossorigin="anonymous" onerror="if(this.hasAttribute('crossorigin')){this.removeAttribute('crossorigin');this.src=this.src}else{this.style.display='none'}" />`

      // 颜色蒙版
      if (el.colorMask) {
        imgHtml += `<div style="position:absolute;inset:0;background:${el.colorMask};pointer-events:none;${el.radius ? `border-radius:${el.radius}px;` : ''}${clipPathStr}"></div>`
      }

      wrapper.innerHTML = imgHtml
      break
    }

    case 'shape': {
      const actualPath = getShapePath(el.pathFormula, el.path, el.width, el.height, el.keypoints)
      const vb = el.pathFormula
        ? `0 0 ${el.width} ${el.height}`
        : `0 0 ${el.viewBox?.[0] ?? el.width} ${el.viewBox?.[1] ?? el.height}`
      const shpGradId = `exp-grad-${el.id}`
      const shpPatId = `exp-pat-${el.id}`
      const shpClipId = `exp-clip-${el.id}`
      let defs = ''
      let fillAttr: string

      if (el.gradient) {
        const stops = el.gradient.colors.map((s) => `<stop offset="${s.pos * 100}%" stop-color="${s.color}"/>`).join('')
        if (el.gradient.type === 'linear') {
          defs = `<linearGradient id="${shpGradId}" gradientTransform="rotate(${el.gradient.rotate}, 0.5, 0.5)">${stops}</linearGradient>`
        } else {
          const rcx = typeof el.gradient.center?.x === 'number' ? el.gradient.center.x : 0.5
          const rcy = typeof el.gradient.center?.y === 'number' ? el.gradient.center.y : 0.5
          defs = `<radialGradient id="${shpGradId}" cx="${rcx}" cy="${rcy}" r="0.5" fx="${rcx}" fy="${rcy}" gradientUnits="objectBoundingBox">${stops}</radialGradient>`
        }
        fillAttr = `url(#${shpGradId})`
      } else if (el.pattern) {
        const patternSrc = patternDataUrls?.get(el.pattern) ?? safeImageSrc(el.pattern)
        defs = `<pattern id="${shpPatId}" patternUnits="objectBoundingBox" patternContentUnits="objectBoundingBox" width="1" height="1"><image href="${escapeAttr(patternSrc)}" width="1" height="1" preserveAspectRatio="xMidYMid slice"/></pattern>`
        fillAttr = `url(#${shpPatId})`
      } else {
        fillAttr = el.fill === 'transparent' || el.fill === 'none' ? 'transparent' : (el.fill || '#5b9bd5')
      }

      defs += `<clipPath id="${shpClipId}"><path d="${actualPath}"/></clipPath>`

      let outlineAttrs = ''
      if (el.outline) {
        outlineAttrs = ` stroke="${el.outline.color}" stroke-width="${el.outline.width}"`
        if (el.outline.style === 'dashed') outlineAttrs += ' stroke-dasharray="8 4"'
        else if (el.outline.style === 'dotted') outlineAttrs += ' stroke-dasharray="2 2"'
        else if (el.outline.style === 'dashDot') outlineAttrs += ' stroke-dasharray="8 4 2 4"'
        else if (el.outline.style === 'longDash') outlineAttrs += ' stroke-dasharray="16 4"'
        else if (el.outline.style === 'longDashDot') outlineAttrs += ' stroke-dasharray="16 4 2 4"'
      }

      const shpShadow = el.shadow
        ? `filter:${buildDropShadowFilter(el.shadow)};`
        : ''

      let svgContent = `<path d="${actualPath}" fill="${fillAttr}"${outlineAttrs}/>`
      if (el.text?.content) {
        const txtAlign = el.text.align || 'center'
        const vAlign = el.text.verticalAlign || 'center'
        const justifyMap: Record<string, string> = { top: 'flex-start', middle: 'center', bottom: 'flex-end' }
        const alignMap: Record<string, string> = { left: 'flex-start', center: 'center', right: 'flex-end' }
        svgContent += `<foreignObject x="0" y="0" width="100%" height="100%" clip-path="url(#${shpClipId})">
          <div xmlns="http://www.w3.org/1999/xhtml" style="
            width:100%;height:100%;display:flex;flex-direction:column;
            align-items:${alignMap[txtAlign] || 'center'};
            justify-content:${justifyMap[vAlign] || 'center'};
            font-size:${el.text.defaultFontSize || 14}px;
            color:${el.text.defaultColor || '#333'};
            font-family:${el.text.defaultFontName || 'inherit'};
            text-align:${txtAlign};padding:8px;overflow:hidden;word-break:break-word;
          ">${sanitizeHtml(el.text.content)}</div>
        </foreignObject>`
      }

      wrapper.innerHTML = `<svg width="100%" height="100%" viewBox="${vb}" preserveAspectRatio="none" style="overflow:visible;${shpShadow}">${defs ? `<defs>${defs}</defs>` : ''}${svgContent}</svg>`
      break
    }

    case 'line': {
      const lineBounds = getLineLocalBounds(el)
      const h = Math.max(lineBounds.height, 4)
      wrapper.style.height = `${h}px`

      const lnColor = el.color || '#333'
      const lnW = ptToPx(el.lineWidth || 2)
      const lnDash = el.style === 'dashed' ? 'stroke-dasharray="8 4"'
        : el.style === 'dotted' ? 'stroke-dasharray="2 2"'
        : el.style === 'dashDot' ? 'stroke-dasharray="8 4 2 4"'
        : el.style === 'longDash' ? 'stroke-dasharray="16 4"'
        : el.style === 'longDashDot' ? 'stroke-dasharray="16 4 2 4"'
        : ''
      const [lnStartPt, lnEndPt] = el.points || ['', '']
      const lnShadow = el.shadow ? `filter:${buildDropShadowFilter(el.shadow)};` : ''

      // 箭头 marker defs
      let lnDefs = ''
      const mEndId = `exp-me-${el.id}`
      const mStartId = `exp-ms-${el.id}`
      if (lnEndPt !== '') {
        const cfg = getLineMarkerConfig(lnEndPt)
        lnDefs += `<marker id="${mEndId}" markerWidth="${cfg.width}" markerHeight="${cfg.height}" refX="${cfg.refX}" refY="${cfg.refY}" orient="auto">${lineMarkerSvg(lnEndPt, lnColor, false)}</marker>`
      }
      if (lnStartPt !== '') {
        const cfg = getLineMarkerConfig(lnStartPt)
        lnDefs += `<marker id="${mStartId}" markerWidth="${cfg.width}" markerHeight="${cfg.height}" refX="${cfg.startRefX}" refY="${cfg.refY}" orient="auto">${lineMarkerSvg(lnStartPt, lnColor, true)}</marker>`
      }

      const lnPath = getLinePathD(el)

      const mEndAttr = lnEndPt !== '' ? ` marker-end="url(#${mEndId})"` : ''
      const mStartAttr = lnStartPt !== '' ? ` marker-start="url(#${mStartId})"` : ''

      wrapper.innerHTML = `<svg width="100%" height="100%" style="overflow:visible;${lnShadow}">
        ${lnDefs ? `<defs>${lnDefs}</defs>` : ''}
        <path d="${lnPath}" fill="none" stroke="${lnColor}" stroke-width="${lnW}" ${lnDash}${mEndAttr}${mStartAttr}/>
      </svg>`
      break
    }

    case 'table': {
      const tblO = el.outline || { style: 'solid', width: 1, color: '#d0d0d0' }
      const innerBorderVisible = (el.borders?.insideH?.width ?? el.borders?.insideV?.width) != null
        ? ((el.borders?.insideH?.width || 0) > 0 || (el.borders?.insideV?.width || 0) > 0)
        : tblO.width > 0
      const tblTC = getTableThemeColors(el.theme, tblO.color, innerBorderVisible)
      const tblRows = el.data.length
      const tblCols = getTableColumnCount(el.data)
      const normalizedColWidths = normalizeTableColWidths(el.colWidths, tblCols)
      const outerBorderSpecs = resolveTableOuterBorderSpecs(tblO, el.borders)
      const normalizedRowHeights = el.rowHeights?.length
        ? normalizeTableRowHeights(
            el.rowHeights,
            tblRows,
            { totalHeight: el.height, minHeight: el.cellMinHeight || 0 },
          )
        : undefined
      let colGroupHtml = ''
      if (normalizedColWidths?.length) {
        colGroupHtml = '<colgroup>' + normalizedColWidths.map((w) => `<col style="width:${w * 100}%">`).join('') + '</colgroup>'
      }
      let tableHtml = `<style>.tabslide-exp-table td p{margin:0;}</style><table class="tabslide-exp-table" style="width:100%;height:100%;border-collapse:collapse;table-layout:fixed;border:none;border-top:${tableBorderSpecToCss(outerBorderSpecs.top)};border-right:${tableBorderSpecToCss(outerBorderSpecs.right)};border-bottom:${tableBorderSpecToCss(outerBorderSpecs.bottom)};border-left:${tableBorderSpecToCss(outerBorderSpecs.left)}">${colGroupHtml}<tbody>`
      for (let ri = 0; ri < el.data.length; ri++) {
        const row = el.data[ri]
        const rowHeight = normalizedRowHeights?.[ri]
        tableHtml += `<tr${rowHeight ? ` style="height:${rowHeight}px"` : ''}>`
        for (let ci = 0; ci < row.length; ci++) {
          const cell = row[ci]
          if (cell.colspan === 0 || cell.rowspan === 0) continue
          const cts = getCellThemeStyle(cell, ri, ci, tblRows, tblCols, el.theme, tblTC)
          const style = resolveTableCellStyle(cell)
          const borderSpecs = resolveTableCellBorderSpecs({
            rowIdx: ri,
            colIdx: ci,
            totalRows: tblRows,
            totalCols: tblCols,
            cell,
            outline: tblO,
            borders: el.borders,
            fallbackInsideHColor: tblTC.borderBottomColor,
            fallbackInsideVColor: tblTC.borderRightColor,
          })
          const cellContent = cell.richText ? sanitizeHtml(cell.richText) : escapeAttr(cell.text || '')
          tableHtml += `<td colspan="${cell.colspan ?? 1}" rowspan="${cell.rowspan ?? 1}" style="
            padding:6px 10px;border-top:${tableBorderSpecToCss(borderSpecs.top)};border-right:${tableBorderSpecToCss(borderSpecs.right)};border-bottom:${tableBorderSpecToCss(borderSpecs.bottom)};border-left:${tableBorderSpecToCss(borderSpecs.left)};
            white-space:pre-wrap;word-break:break-word;line-height:1.4;
            color:${cts.textColor || style.color || '#333'};
            background-color:${cts.bgColor};
            font-size:${style.fontSize || 14}pt;
            font-weight:${cts.bold ? 'bold' : 'normal'};
            ${style.italic ? 'font-style:italic;' : ''}
            ${style.underline ? 'text-decoration:underline;' : ''}
            ${(style.fontName || style.fontFamily) ? `font-family:${style.fontName || style.fontFamily};` : ''}
            text-align:${style.align || 'left'};
            vertical-align:${style.verticalAlign || 'middle'};
            min-height:${rowHeight || el.cellMinHeight || 36}px;
          ">${cellContent}</td>`
        }
        tableHtml += '</tr>'
      }
      tableHtml += '</tbody></table>'
      wrapper.innerHTML = tableHtml
      break
    }

    case 'chart': {
      const chartEl = el as PPTChartElement
      const elHeight = (el as { height: number }).height

      if (hasValidChartData(chartEl)) {
        const option = buildChartOption(chartEl)
        const chart = echarts.init(null, undefined, {
          renderer: 'svg',
          ssr: true,
          width: el.width,
          height: elHeight,
        })
        chart.setOption(option)
        const svgStr = chart.renderToSVGString()
        chart.dispose()

        wrapper.style.background = chartEl.fill || 'transparent'
        if (chartEl.outline) {
          wrapper.style.border = `${chartEl.outline.width}px ${chartEl.outline.style} ${chartEl.outline.color}`
        }
        wrapper.innerHTML = svgStr
      } else {
        wrapper.style.cssText += `
          display:flex;align-items:center;justify-content:center;flex-direction:column;gap:4px;
          background:${chartEl.fill || '#f5f5f5'};border:1px dashed #d0d0d0;border-radius:4px;
          color:;font-size:13px;font-family:sans-serif;
        `
        wrapper.innerHTML = `<span style="font-size:20px">&#x1F4CA;</span><span>${escapeAttr(chartEl.name || `Chart (${chartEl.chartType})`)}</span>`
      }
      break
    }

    case 'latex':
      if (el.svg) {
        wrapper.style.color = el.color || '#111111'
        wrapper.innerHTML = normalizeLatexSvgForDisplay(el.svg)
      } else if (el.path && el.viewBox) {
        wrapper.innerHTML = `<svg width="100%" height="100%" viewBox="0 0 ${el.viewBox?.[0] ?? el.width} ${el.viewBox?.[1] ?? el.height}" preserveAspectRatio="xMidYMid meet">
          <path d="${el.path}" fill="${el.color}" />
        </svg>`
      } else if (el.rasterSrc) {
        const img = document.createElement('img')
        img.crossOrigin = 'anonymous'
        img.src = el.rasterSrc
        img.alt = el.latex || 'LaTeX'
        img.draggable = false
        img.style.cssText = 'width:100%;height:100%;object-fit:contain;display:block'
        img.onerror = () => {
          if (img.hasAttribute('crossorigin')) {
            img.removeAttribute('crossorigin')
            img.src = img.src // eslint-disable-line no-self-assign
          } else {
            img.style.display = 'none'
          }
        }
        wrapper.appendChild(img)
      } else {
        const latexDiv = document.createElement('div')
        latexDiv.style.cssText = 'padding:8px;font-family:serif'
        latexDiv.textContent = el.latex
        wrapper.appendChild(latexDiv)
      }
      break

    case 'video': {
      const videoEl = el as import('../types/slides').PPTVideoElement
      const posterSrc = safeImageSrc(videoEl.poster)
      if (posterSrc) {
        const img = document.createElement('img')
        img.crossOrigin = 'anonymous'
        img.src = posterSrc
        img.alt = 'Video poster'
        img.draggable = false
        img.style.cssText = 'width:100%;height:100%;object-fit:cover;display:block'
        img.onerror = () => {
          if (img.hasAttribute('crossorigin')) {
            img.removeAttribute('crossorigin')
            img.src = img.src // eslint-disable-line no-self-assign
          } else {
            img.style.display = 'none'
            wrapper.style.cssText += 'display:flex;align-items:center;justify-content:center;background:#f0f0f0;border:1px dashed #ccc;border-radius:4px;color:;font-size:13px;font-family:sans-serif;'
            wrapper.textContent = '\u25B6 Video'
          }
        }
        wrapper.appendChild(img)
      } else {
        wrapper.style.cssText += `
          display:flex;align-items:center;justify-content:center;
          background:#f0f0f0;border:1px dashed #ccc;border-radius:4px;
          color:;font-size:13px;font-family:sans-serif;
        `
        wrapper.textContent = '\u25B6 Video'
      }
      break
    }
    case 'canvas': {
      wrapper.style.cssText += `
        display:flex;align-items:center;justify-content:center;
        background:#f0f0f0;border:1px dashed #ccc;border-radius:4px;
        color:;font-size:13px;font-family:sans-serif;
      `
      wrapper.textContent = 'Canvas'
      break
    }

    default:
      return null
  }

  return wrapper
}

function getLineMarkerConfig(point: string) {
  if (point === 'dot') return { width: 8, height: 8, refX: 6, startRefX: 2, refY: 4 }
  if (point === 'diamond') return { width: 10, height: 10, refX: 10, startRefX: 0, refY: 5 }
  if (point === 'stealth') return { width: 10, height: 8, refX: 10, startRefX: 0, refY: 4 }
  if (point === 'triangle') return { width: 10, height: 8, refX: 10, startRefX: 0, refY: 4 }
  return { width: 10, height: 8, refX: 10, startRefX: 0, refY: 4 }
}

function lineMarkerSvg(point: string, color: string, start: boolean): string {
  if (point === 'dot') return `<circle cx="4" cy="4" r="2.5" fill="${color}"/>`
  if (point === 'diamond') {
    return start
      ? `<polygon points="10 5,5 0,0 5,5 10" fill="${color}"/>`
      : `<polygon points="0 5,5 0,10 5,5 10" fill="${color}"/>`
  }
  if (point === 'stealth') {
    return start
      ? `<polygon points="10 0,2.5 4,10 8,6.5 4" fill="${color}"/>`
      : `<polygon points="0 0,7.5 4,0 8,3.5 4" fill="${color}"/>`
  }
  if (point === 'triangle' || point === 'arrow') {
    return start
      ? `<polygon points="10 0,0 4,10 8" fill="${color}"/>`
      : `<polygon points="0 0,10 4,0 8" fill="${color}"/>`
  }
  return start
    ? `<polygon points="10 0,0 4,10 8" fill="${color}"/>`
    : `<polygon points="0 0,10 4,0 8" fill="${color}"/>`
}

/** 等待容器内所有图片加载完毕 */
function waitForImages(container: HTMLElement, timeout = 10000): Promise<void> {
  const imgs = container.querySelectorAll('img')
  if (imgs.length === 0) return Promise.resolve()

  return new Promise((resolve) => {
    let loaded = 0
    const total = imgs.length
    const timer = setTimeout(finish, timeout)
    function finish() { clearTimeout(timer); resolve() }
    function done() { if (++loaded >= total) finish() }

    imgs.forEach((img) => {
      if (img.complete) {
        if (img.naturalWidth > 0) { done(); return }
        // complete 但 naturalWidth=0 表示加载失败，尝试 CORS 重试
        if (!img.crossOrigin) {
          img.crossOrigin = 'anonymous'
          img.onload = done
          img.onerror = () => done()
          img.src = img.src // eslint-disable-line no-self-assign
        } else {
          done()
        }
        return
      }
      img.onload = done
      img.onerror = () => {
        if (!img.crossOrigin) {
          img.crossOrigin = 'anonymous'
          img.onload = done
          img.onerror = () => done()
          img.src = img.src // eslint-disable-line no-self-assign
        } else {
          done()
        }
      }
    })
  })
}

// ═══════════════════════════════════════════════
// 工具
// ═══════════════════════════════════════════════

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}
