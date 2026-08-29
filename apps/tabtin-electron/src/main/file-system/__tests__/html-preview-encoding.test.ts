import { describe, expect, it } from 'vitest'
import { detectUnlabeledHtmlPreviewEncoding } from '../html-preview-encoding'

function gb18030HtmlWithoutDeclaration(): Uint8Array {
  const sentence = Buffer.from([0xc4, 0xe3, 0xba, 0xc3, 0xca, 0xc0, 0xbd, 0xe7])
  return Buffer.concat([
    Buffer.from('<!doctype html><html><head><title>legacy</title></head><body>'),
    ...Array.from({ length: 20 }, () => sentence),
    Buffer.from('</body></html>'),
  ])
}

describe('detectUnlabeledHtmlPreviewEncoding', () => {
  it('uses a GB18030 fallback for an unlabeled Chinese legacy page', () => {
    expect(detectUnlabeledHtmlPreviewEncoding(gb18030HtmlWithoutDeclaration())).toBe('gb18030')
  })

  it('preserves the browser priority of a declared charset', () => {
    const bytes = Buffer.concat([
      Buffer.from('<html><head><meta charset="gbk"></head><body>'),
      Buffer.from([0xc4, 0xe3, 0xba, 0xc3]),
      Buffer.from('</body></html>'),
    ])
    expect(detectUnlabeledHtmlPreviewEncoding(bytes)).toBeUndefined()
  })
})
