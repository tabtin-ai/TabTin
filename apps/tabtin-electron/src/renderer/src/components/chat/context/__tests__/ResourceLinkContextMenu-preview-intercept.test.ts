import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

async function readSource() {
  return readFile(resolve(__dirname, '../ResourceLinkContextMenu.tsx'), 'utf8')
}

describe('ResourceLinkContextMenu preview intercept', () => {
  it('opens previewable spreadsheet URLs in lightbox before 工作空间 open', async () => {
    const source = await readSource()
    expect(source).toContain('tryOpenPreviewableDirectUrl')
    expect(source).toContain('const handleOpenInSpace = async () => {')
    const handlerStart = source.indexOf('const handleOpenInSpace = async () => {')
    const handlerEnd = source.indexOf('const handleOpenExternal')
    const handler = source.slice(handlerStart, handlerEnd)
    expect(handler).toContain('if (tryOpenPreviewableDirectUrl(href))')
    expect(handler.indexOf('tryOpenPreviewableDirectUrl(href)')).toBeLessThan(
      handler.indexOf('resourceRouter.open'),
    )
  })
})
