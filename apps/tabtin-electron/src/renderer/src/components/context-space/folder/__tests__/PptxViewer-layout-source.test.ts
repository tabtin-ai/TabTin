import { describe, expect, it } from 'vitest'

async function readPptxViewerSource() {
  const fs = await import('node:fs')
  const path = await import('node:path')
  const srcPath = path.resolve(__dirname, '../../../shared/file-preview/PptxViewer.tsx')
  return fs.readFileSync(srcPath, 'utf-8')
}

describe('PptxViewer focused preview layout', () => {
  it('renders a selected slide stage and a separate thumbnail rail', async () => {
    const source = await readPptxViewerSource()

    expect(source).toContain('data-testid="pptx-stage"')
    expect(source).toContain('data-testid="pptx-thumbnail"')
    expect(source).toContain('SLIDE_THUMB_WIDTH')
    expect(source).toContain('useElementSize')
    expect(source).toContain('calculateFitPreviewWidth')
    expect(source).not.toContain('const SLIDE_STAGE_WIDTH')
  })

  it('fits the main slide to both available width and height', async () => {
    const source = await readPptxViewerSource()

    expect(source).toContain('usableWidth / canvasWidth')
    expect(source).toContain('usableHeight / canvasHeight')
    expect(source).toContain('Math.min(widthScale, heightScale')
  })
})
