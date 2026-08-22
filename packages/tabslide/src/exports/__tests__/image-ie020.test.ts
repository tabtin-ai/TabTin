import { describe, it, expect, vi, beforeEach } from 'vitest'

// ---------------------------------------------------------------------------
// IE-020: allowTaint + useCORS 互斥回归测试
//
// html2canvas 的 allowTaint:true 会让跨域无 CORS 头的图片污染 canvas，
// 导致后续 toBlob()/toDataURL() 抛 SecurityError。修复后只保留 useCORS。
// ---------------------------------------------------------------------------

let lastHtml2CanvasOpts: Record<string, unknown> | null = null

vi.mock('html2canvas-pro', () => {
  return {
    default: async (_el: unknown, opts: Record<string, unknown>) => {
      lastHtml2CanvasOpts = opts
      const canvas = {
        toBlob(cb: (b: Blob | null) => void, _type: string, _q: number) {
          cb(new Blob(['mock'], { type: 'image/png' }))
        },
        toDataURL() { return 'data:image/png;base64,mock' },
      }
      return canvas
    },
  }
})

vi.mock('echarts', () => ({ init: vi.fn() }))

describe('IE-020: html2canvas options — no allowTaint', () => {
  beforeEach(() => { lastHtml2CanvasOpts = null })

  it('captureElement does NOT pass allowTaint', async () => {
    const { captureElement } = await import('../image')
    const el = {} as HTMLElement
    await captureElement(el)
    expect(lastHtml2CanvasOpts).toBeTruthy()
    expect(lastHtml2CanvasOpts!.useCORS).toBe(true)
    expect(lastHtml2CanvasOpts).not.toHaveProperty('allowTaint')
  })

  it('exportPageToImage does NOT pass allowTaint', async () => {
    const { exportPageToImage } = await import('../image')

    const mockContainer = {
      style: { cssText: '' },
      querySelectorAll: () => [] as unknown[],
      appendChild: vi.fn(),
    }
    const origCreateElement = globalThis.document?.createElement
    const origAppendChild = globalThis.document?.body?.appendChild
    const origRemoveChild = globalThis.document?.body?.removeChild

    vi.stubGlobal('document', {
      createElement: () => mockContainer,
      body: {
        appendChild: vi.fn(),
        removeChild: vi.fn(),
      },
    })

    const pres = {
      id: 'p1',
      name: 'Test',
      preset: '16:9',
      canvasWidth: 1920,
      canvasHeight: 1080,
      pages: [{ id: 'page-1', elements: [] }],
    } as any

    await exportPageToImage(pres, 0)
    expect(lastHtml2CanvasOpts).toBeTruthy()
    expect(lastHtml2CanvasOpts!.useCORS).toBe(true)
    expect(lastHtml2CanvasOpts).not.toHaveProperty('allowTaint')

    vi.unstubAllGlobals()
  })
})

describe('IE-020: cross-origin image fallback', () => {
  it('onerror handler removes crossorigin attribute for retry', () => {
    const { safeImageSrc: _ignored, ...mod } = {} as any
    const imgEl = document.createElement('img')
    imgEl.setAttribute('crossorigin', 'anonymous')
    imgEl.src = 'https://example.com/image.png'

    const onerror = `if(this.hasAttribute('crossorigin')){this.removeAttribute('crossorigin');this.src=this.src}else{this.style.display='none'}`

    imgEl.setAttribute('onerror', onerror)

    expect(imgEl.hasAttribute('crossorigin')).toBe(true)

    const fn = new Function('return ' + `function(){${onerror}}`)()
    fn.call(imgEl)
    expect(imgEl.hasAttribute('crossorigin')).toBe(false)

    fn.call(imgEl)
    expect(imgEl.style.display).toBe('none')
  })
})
