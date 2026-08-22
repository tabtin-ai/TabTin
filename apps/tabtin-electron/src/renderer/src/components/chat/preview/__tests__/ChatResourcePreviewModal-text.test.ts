import { describe, expect, it } from 'vitest'

async function readChatResourcePreviewModalSource() {
  const fs = await import('node:fs')
  const path = await import('node:path')
  const srcPath = path.resolve(__dirname, '../ChatResourcePreviewModal.tsx')
  return fs.readFileSync(srcPath, 'utf-8')
}

describe('ChatResourcePreviewModal text preview wiring', () => {
  it('routes txt/json to TextFileEditor and md to MarkdownViewer', async () => {
    const source = await readChatResourcePreviewModalSource()

    expect(source).toContain("import('@components/shared/file-preview/TextFileEditor')")
    expect(source).toContain("import('@components/shared/file-preview/MarkdownViewer')")
    expect(source).toContain("case 'txt':")
    expect(source).toContain("case 'json':")
    expect(source).toContain("case 'md':")
    expect(source).toContain('<TextFileEditor')
    expect(source).toContain('<MarkdownViewer')
  })
})
