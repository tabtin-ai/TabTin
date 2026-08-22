import { describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

describe('ChatResourcePreviewModal image copy wiring', () => {
  it('uses the shared preview with attachment bytes for the real lightbox image body', async () => {
    const source = await readFile(resolve(__dirname, '../ChatResourcePreviewModal.tsx'), 'utf8')

    expect(source).toContain("@components/shared/image-preview/ImagePreview")
    expect(source).toContain('loadBytes: () => getAttachmentBuffer({ fileId: resource.fileId, url: resource.url })')
    expect(source).toContain('onPointerDown={pan?.onPointerDown}')
    expect(source).toContain('onPointerMove={pan?.onPointerMove}')
  })
})
