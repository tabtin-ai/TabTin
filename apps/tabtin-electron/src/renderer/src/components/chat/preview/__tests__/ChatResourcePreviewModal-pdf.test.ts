import { describe, expect, it } from 'vitest'

async function readChatResourcePreviewModalSource() {
  const fs = await import('node:fs')
  const path = await import('node:path')
  const srcPath = path.resolve(__dirname, '../ChatResourcePreviewModal.tsx')
  return fs.readFileSync(srcPath, 'utf-8')
}

describe('ChatResourcePreviewModal PDF preview wiring ', () => {
  it('loads remote PDF via attachment buffer instead of feeding OSS URL to pdf.js', async () => {
    const source = await readChatResourcePreviewModalSource()

    expect(source).toContain("import('@components/shared/file-preview/PdfViewer')")
    expect(source).toContain("case 'pdf':")
    // 必须走 OfficeBody / getAttachmentBuffer，再把 data 交给 PdfViewer
    expect(source).toMatch(/const PdfBody[\s\S]*?<OfficeBody/)
    expect(source).toMatch(/<PdfViewer[^>]*\bdata=\{data\}/)
    // 禁止把远程 resource.url 直喂 PdfViewer（打包态 CORS / Range 会挂）
    expect(source).not.toMatch(/<PdfViewer[^>]*\bfileUrl=\{resource\.url\}/)
  })
})
