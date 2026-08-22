import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('window-open-fallback preview intercept wiring', () => {
  it('calls tryOpenPreviewableDirectUrl before resourceRouter.open', async () => {
    const source = await readFile(resolve(__dirname, '../index.ts'), 'utf8')
    expect(source).toContain('tryOpenPreviewableDirectUrl')
    const handlerStart = source.indexOf('onOpenFallback(({ url, source, disposition, filename, mimeType, assetId }) => {')
    const handler = source.slice(handlerStart, handlerStart + 800)
    expect(handler).toContain('tryOpenPreviewableDirectUrl(url, {')
    expect(handler).toContain('fileId: assetId')
    expect(handler.indexOf('tryOpenPreviewableDirectUrl(url, {')).toBeLessThan(
      handler.indexOf('resourceRouter.open'),
    )
  })
})
