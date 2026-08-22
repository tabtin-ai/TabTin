import { describe, expect, it } from 'vitest'

async function readViewerSource() {
  const fs = await import('node:fs')
  const path = await import('node:path')
  const srcPath = path.resolve(__dirname, '../OfficeRenderedPagesViewer.tsx')
  return fs.readFileSync(srcPath, 'utf-8')
}

describe('OfficeRenderedPagesViewer thumbnail rail', () => {
  it('renders a left thumbnail rail alongside the stage pages', async () => {
    const source = await readViewerSource()

    expect(source).toContain('data-testid="office-rendered-thumbnail-rail"')
    expect(source).toContain('data-testid="office-rendered-thumbnail"')
    expect(source).toContain('data-testid="office-rendered-stage"')
    expect(source).toContain('PAGE_THUMB_WIDTH')
    expect(source).toContain('grid-cols-[212px_minmax(0,1fr)]')
    expect(source).not.toContain('ZoomIn')
    expect(source).not.toContain('zoomIn')
  })

  it('uses rendered page images for thumbnails and jumps via scrollToPage', async () => {
    const source = await readViewerSource()

    expect(source).toContain('RenderedPageThumbnail')
    expect(source).toContain('scrollToPage(index)')
    expect(source.indexOf('office-rendered-thumbnail-rail')).toBeLessThan(
      source.indexOf('office-rendered-stage'),
    )
  })
})
