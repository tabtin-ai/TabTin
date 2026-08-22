import { describe, expect, it } from 'vitest'

async function readChatResourcePreviewModalSource() {
  const fs = await import('node:fs')
  const path = await import('node:path')
  const srcPath = path.resolve(__dirname, '../ChatResourcePreviewModal.tsx')
  return fs.readFileSync(srcPath, 'utf-8')
}

describe('ChatResourcePreviewModal CSV preview wiring', () => {
  it('routes csv resources to the shared CSV table viewer', async () => {
    const source = await readChatResourcePreviewModalSource()

    expect(source).toContain("import('@components/shared/file-preview/CsvViewer')")
    expect(source).toContain("case 'csv':")
    expect(source).toContain('<CsvViewer')
  })

  it('keeps document previews inside a padded viewport', async () => {
    const source = await readChatResourcePreviewModalSource()

    expect(source).toContain('overflow-hidden px-6 pb-6 pt-2')
    expect(source).toContain('h-full max-h-[90vh] w-[min(1100px,100%)]')
  })

  it('guards document preview downloads with file size limits before fetching buffers', async () => {
    const source = await readChatResourcePreviewModalSource()

    expect(source).toContain('const isTooLarge = typeof maxBytes ===')
    expect(source).toContain('useAttachmentBuffer(resource, !isTooLarge)')
    expect(source).toContain('maxBytes={MAX_OFFICE_FILE_BYTES}')
    expect(source).toContain('preview.fileTooLarge')
  })
})
