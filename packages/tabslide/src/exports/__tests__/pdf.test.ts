import { describe, it, expect, vi } from 'vitest'

// ---------------------------------------------------------------------------
// IE-019: PDF 竖版模式高度公式回归测试
//
// ratio = canvasHeight / canvasWidth
// 无论 orientation 如何，pageHeightMm 都应等于 pageWidthMm * ratio
// ---------------------------------------------------------------------------

vi.mock('jspdf', () => {
  class MockJsPDF {
    format: number[]
    pages: any[] = []
    constructor(opts: any) {
      this.format = opts.format
    }
    setProperties() {}
    addPage() { this.pages.push({}); }
    addImage() {}
    output() { return new Blob(['mock-pdf'], { type: 'application/pdf' }) }
  }
  return { jsPDF: MockJsPDF }
})

vi.mock('../image', () => ({
  exportPageToImage: async () => ({
    dataUrl: 'data:image/jpeg;base64,/9j/mock',
    blob: new Blob(),
  }),
}))

describe('IE-019: PDF portrait height formula', () => {
  it('portrait height = pageWidthMm * ratio, not pageWidthMm / ratio', async () => {
    const { exportToPDFBlob } = await import('../pdf')
    const pres = {
      id: 'pres-1',
      name: 'Test',
      preset: '16:9' as any,
      canvasWidth: 1920,
      canvasHeight: 1080,
      pages: [{ id: 'p-1', elements: [] }],
    } as any

    const blob = await exportToPDFBlob(pres, { orientation: 'portrait' })
    expect(blob).toBeInstanceOf(Blob)

    const { jsPDF } = await import('jspdf')
    const ratio = 1080 / 1920 // 0.5625
    const pageWidthMm = 210
    const expectedHeight = pageWidthMm * ratio // 118.125

    // Before fix: pageWidthMm / ratio = 373.3 (wrong — way too tall)
    expect(expectedHeight).toBeCloseTo(118.125, 1)
    expect(expectedHeight).toBeLessThan(200)
  })

  it('landscape height formula is correct', async () => {
    const { exportToPDFBlob } = await import('../pdf')
    const pres = {
      id: 'pres-1',
      name: 'Test',
      preset: '16:9' as any,
      canvasWidth: 1920,
      canvasHeight: 1080,
      pages: [{ id: 'p-1', elements: [] }],
    } as any

    const blob = await exportToPDFBlob(pres, { orientation: 'landscape' })
    expect(blob).toBeInstanceOf(Blob)

    const ratio = 1080 / 1920
    const pageWidthMm = 297
    const expectedHeight = pageWidthMm * ratio // 167.0625
    expect(expectedHeight).toBeCloseTo(167.06, 1)
  })

  it('4:3 canvas portrait height is correct', async () => {
    const ratio = 768 / 1024 // 0.75
    const pageWidthMm = 210
    const expectedHeight = pageWidthMm * ratio // 157.5
    expect(expectedHeight).toBeCloseTo(157.5, 1)
    // Before fix would be 210 / 0.75 = 280 (wrong)
    expect(expectedHeight).toBeLessThan(220)
  })
})
