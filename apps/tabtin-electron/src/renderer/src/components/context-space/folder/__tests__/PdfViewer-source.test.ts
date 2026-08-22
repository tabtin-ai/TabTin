import { describe, expect, it } from 'vitest'

async function readPdfViewerSource() {
  const fs = await import('node:fs')
  const path = await import('node:path')
  const srcPath = path.resolve(__dirname, '../../../shared/file-preview/PdfViewer.tsx')
  return fs.readFileSync(srcPath, 'utf-8')
}

describe('PdfViewer page state safety', () => {
  it('clamps initial pages and resets cached page dimensions when the source changes', async () => {
    const source = await readPdfViewerSource()

    expect(source).toContain('function clampPdfPage')
    expect(source).toContain('clampPdfPage(initialPage || 1, numPages)')
    expect(source).toContain('setPageDims({})')
  })

  it('accepts binary data ahead of remote URL so chat can avoid CORS Range fetches ', async () => {
    const source = await readPdfViewerSource()

    expect(source).toContain('data?: ArrayBuffer | Uint8Array')
    expect(source).toContain('if (data)')
    expect(source).toContain('return { data: toUint8Array(data) }')
  })

  it('copies binary data before handoff so pdf.js transfer cannot poison callers ', async () => {
    const source = await readPdfViewerSource()

    expect(source).toContain('data.slice()')
    expect(source).toContain('data.slice(0)')
    expect(source).toContain('#5055')
  })
})
