/**
 *  — show_widget 高 SVG 在 Lightbox 预览中不得被静默裁切。
 *
 * 与 （矮图留白 / 测高只增不减）、（本地文件预览入口）、
 * （文档内预览）症状不等价：本文件只守「点击后完整可达 TOP/BOTTOM」。
 */

import React from 'react'
import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import {
  WIDGET_PREVIEW_MAX_IFRAME_HEIGHT,
  resolveLightboxWidgetIframeHeight,
  resolveWidgetPreviewViewportHeight,
} from '../widgetPreviewLayout'
import { WidgetPreviewFrame } from '../WidgetPreviewFrame'
import { wrapWidgetCode } from '../../richContent/widget/wrapWidgetCode'

/** viewBox 400×2400，顶部/底部可观测标记；测高应 ≥ 2400（含 wrapper padding） */
export const TALL_SVG_FIXTURE = [
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 2400" width="400" height="2400">',
  '<text id="TOP" x="8" y="32" font-size="24">TOP</text>',
  '<rect x="0" y="1180" width="400" height="40" fill="currentColor" opacity="0.15"/>',
  '<text id="BOTTOM" x="8" y="2380" font-size="24">BOTTOM</text>',
  '</svg>',
].join('')

async function readChatResourcePreviewModalSource() {
  const fs = await import('node:fs')
  const path = await import('node:path')
  const srcPath = path.resolve(__dirname, '../ChatResourcePreviewModal.tsx')
  return fs.readFileSync(srcPath, 'utf-8')
}

describe('ChatResourcePreviewModal tall widget SVG ', () => {
  it('fixture 携带 TOP/BOTTOM 标记与可观测高度（≥2400）', () => {
    expect(TALL_SVG_FIXTURE).toContain('id="TOP"')
    expect(TALL_SVG_FIXTURE).toContain('id="BOTTOM"')
    expect(TALL_SVG_FIXTURE).toMatch(/viewBox="0 0 400 2400"/)
    expect(TALL_SVG_FIXTURE).toMatch(/height="2400"/)
  })

  it('#7275：有 viewer 高度时 iframe 铺满内容盒（矮图不再收成内容矮盒）', () => {
    const layout = resolveLightboxWidgetIframeHeight(224)!
    expect(resolveWidgetPreviewViewportHeight(layout, 800)).toBe(800)
    expect(resolveWidgetPreviewViewportHeight(layout, null)).toBe(224)
  })

  it('测高有明确安全上限，但 2400px 正常内容不会被 2000px 截断', () => {
    expect(resolveLightboxWidgetIframeHeight(2400)).toEqual({
      height: 2400,
      capped: false,
    })
    expect(resolveLightboxWidgetIframeHeight(WIDGET_PREVIEW_MAX_IFRAME_HEIGHT + 1)).toEqual({
      height: WIDGET_PREVIEW_MAX_IFRAME_HEIGHT,
      capped: true,
    })
    expect(resolveLightboxWidgetIframeHeight(Number.NaN)).toBeNull()
    expect(resolveLightboxWidgetIframeHeight(0)).toBeNull()
  })

  it.each([
    { scale: 0.5, height: 100 },
    { scale: 1, height: 2400 },
    { scale: 5, height: 2400 },
  ])('真实 DOM：$scale× / $height px：transform scale 内容 + iframe 内二维滚动', ({ scale, height }) => {
    const result = resolveLightboxWidgetIframeHeight(height)!
    const { container } = render(React.createElement(WidgetPreviewFrame, {
      iframeRef: { current: null },
      srcDoc: '<!doctype html><html><body>fixture</body></html>',
      title: 'Tall SVG',
      scale,
      layout: result,
    }))

    const viewport = container.querySelector('[data-widget-preview-viewport]') as HTMLElement | null
    const iframe = container.querySelector('iframe')
    expect(viewport?.className).toContain('max-h-full')
    expect(viewport?.className).toContain('min-h-0')
    expect(viewport?.className).toContain('overflow-hidden')
    expect(iframe?.getAttribute('sandbox')).toBe('allow-scripts')
    expect(iframe?.getAttribute('data-preview-scale')).toBe(String(scale))
    expect(iframe?.className).toContain('max-h-full')
    expect(iframe?.className).toContain('min-h-0')
    expect(iframe?.getAttribute('style')).toContain(`height: ${height}px`)
    // ：与 PNG ImageBody 一致，缩放内容本身，不放大视窗盒子
    expect(viewport?.style.transform).toBe(`scale(${scale})`)
    expect(iframe?.style.zoom).toBeFalsy()
    expect(container.querySelector('[data-widget-scroll-spacer]')).toBeNull()
  })

  it('真实 DOM：超上限测高只限制 iframe 布局，内部仍通过滚动查看完整内容', () => {
    const layout = resolveLightboxWidgetIframeHeight(
      WIDGET_PREVIEW_MAX_IFRAME_HEIGHT * 100,
    )!
    const { container } = render(React.createElement(WidgetPreviewFrame, {
      iframeRef: { current: null },
      srcDoc: '<!doctype html><html><body>huge fixture</body></html>',
      title: 'Huge SVG',
      scale: 1,
      layout,
    }))

    const iframe = container.querySelector('iframe')
    expect(iframe?.className).toContain('max-h-full')
    expect(iframe?.getAttribute('style')).toContain(
      `height: ${WIDGET_PREVIEW_MAX_IFRAME_HEIGHT}px`,
    )
    expect(iframe?.getAttribute('data-height-capped')).toBe('true')
  })

  it('真实 DOM：测高前只保留 240px 占位，不恢复  的 70vh 留白', () => {
    const { container } = render(React.createElement(WidgetPreviewFrame, {
      iframeRef: { current: null },
      srcDoc: '<!doctype html><html><body>loading</body></html>',
      title: 'Loading SVG',
      scale: 1,
      layout: null,
    }))

    const iframe = container.querySelector('iframe')
    expect(iframe?.getAttribute('style')).toContain('height: 240px')
    expect(iframe?.className).not.toMatch(/70vh/)
    expect(iframe?.getAttribute('style') ?? '').not.toContain('70vh')
  })

  it('真实低高度容器：iframe 服从 viewer 内容盒，内部滚动条完整留在可见区', () => {
    const availableHeight = 180
    const host = document.createElement('div')
    host.style.height = `${availableHeight}px`
    Object.defineProperty(host, 'clientHeight', {
      configurable: true,
      value: availableHeight,
    })
    document.body.appendChild(host)

    const srcDoc = wrapWidgetCode(TALL_SVG_FIXTURE, 'svg', {
      theme: 'light',
      lightboxViewport: true,
    })
    const layout = resolveLightboxWidgetIframeHeight(2400)!
    const { container } = render(React.createElement(WidgetPreviewFrame, {
      iframeRef: { current: null },
      srcDoc,
      title: 'Low viewport tall SVG',
      scale: 5,
      layout,
    }), { container: host })

    const viewport = container.querySelector('[data-widget-preview-viewport]')
    const iframe = container.querySelector('iframe')
    expect(resolveWidgetPreviewViewportHeight(layout, availableHeight)).toBe(availableHeight)
    expect(viewport?.className).toContain('max-h-full')
    expect(iframe?.getAttribute('style')).toContain(`height: ${availableHeight}px`)
    expect(iframe?.getAttribute('data-available-height')).toBe(String(availableHeight))
    expect(iframe?.getAttribute('data-preview-scale')).toBe('5')
    expect((viewport as HTMLElement | null)?.style.transform).toBe('scale(5)')
    expect(iframe?.getAttribute('srcdoc')).toContain('overflow:auto')
    expect(iframe?.getAttribute('srcdoc')).toContain('id="TOP"')
    expect(iframe?.getAttribute('srcdoc')).toContain('id="BOTTOM"')
  })

  it('srcdoc：高图可切 tall 滚动；缩放由父层 transform scale 承担（，对齐 PNG）', () => {
    const srcdoc = wrapWidgetCode(TALL_SVG_FIXTURE, 'svg', {
      theme: 'light',
      lightboxViewport: true,
    })

    expect(srcdoc).toContain('data-lightbox-mode')
    expect(srcdoc).toContain('html[data-lightbox-mode="tall"] body{display:block;overflow:auto;')
    expect(srcdoc).toContain('id="tabtin-widget-content"')
    // 矮/方图默认 fit contain；高图由 bootstrap 切 tall
    expect(srcdoc).toContain('max-height:100%')
    expect(srcdoc).toContain('heightAtFullWidth')
  })

  it('Widget Lightbox 服从 viewer 已建立的 flex 可用高度，不另算 88vh', async () => {
    const source = await readChatResourcePreviewModalSource()

    // Image 路径已规避 max-h-full（对照，勿回归）
    expect(source).toContain('max-h-[88vh] max-w-[88vw] object-contain')

    // Widget 路径：复用 viewer 的已建立可用高度，不额外假设 viewport 高度。
    const widgetBodyMatch = source.match(
      /const WidgetBody:[\s\S]*?(?=\nconst ResourceBody:)/,
    )
    expect(widgetBodyMatch?.[0]).toBeTruthy()
    const widgetBody = widgetBodyMatch![0]

    expect(widgetBody).toContain('WidgetPreviewFrame')
    expect(widgetBody).toContain('lightboxViewport: true')
    // 禁止回到 2000px 硬截断；安全上限由明确 helper + iframe 内滚动承接
    expect(widgetBody).not.toContain('WIDGET_IFRAME_MAX_HEIGHT')
    expect(widgetBody).not.toMatch(/Math\.min\([^,]+,\s*2000\)/)
    // ：Lightbox wrapper 仅对本路径启用，聊天卡片默认语义不变
    expect(widgetBody).toContain('setIframeLayout(null)')
  })

  it('父层用 transform scale 缩放内容（对齐 PNG），不假设 sandbox postMessage', async () => {
    const fs = await import('node:fs')
    const path = await import('node:path')
    const source = await readChatResourcePreviewModalSource()
    const frameSource = fs.readFileSync(
      path.resolve(__dirname, '../WidgetPreviewFrame.tsx'),
      'utf-8',
    )
    expect(source).toContain('WidgetPreviewFrame')
    expect(source).not.toContain("type: 'tabtin:preview-scale'")
    expect(source).not.toContain('scaledWidgetScrollExtent')
    expect(source).not.toContain('shouldWidgetWheelZoom')
    expect(frameSource).toContain('transform: `scale(${scale})`')
    expect(frameSource).not.toContain('zoom: scale')
  })

  it('#7275：Lightbox 根节点声明 no-drag，避免顶栏缩放按钮被窗口 drag 带吞点击', async () => {
    const source = await readChatResourcePreviewModalSource()
    expect(source).toContain('app-region-no-drag')
    expect(source).toContain("WebkitAppRegion: 'no-drag'")
    expect(source).toContain('data-native-view-overlay="true"')
  })
})
