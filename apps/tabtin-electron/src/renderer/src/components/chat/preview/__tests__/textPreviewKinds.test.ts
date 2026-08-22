import { describe, expect, it } from 'vitest'
import { inferPreviewableKind } from '../inferPreviewableKind'
import { TEXT_PREVIEW_MAX_BYTES, decodeTextPreview } from '../decodeTextPreview'

describe('inferPreviewableKind text types', () => {
  it('识别 text/plain / json / markdown mime', () => {
    expect(inferPreviewableKind('text/plain', 'a.bin')).toBe('txt')
    expect(inferPreviewableKind('application/json', 'a.bin')).toBe('json')
    expect(inferPreviewableKind('text/json', 'a.bin')).toBe('json')
    expect(inferPreviewableKind('text/markdown', 'a.bin')).toBe('md')
    expect(inferPreviewableKind('text/x-markdown', 'a.bin')).toBe('md')
  })

  it('text/plain + .md/.json 扩展名仍走 md/json（Windows 常见误标）', () => {
    expect(inferPreviewableKind('text/plain', 'readme.md')).toBe('md')
    expect(inferPreviewableKind('text/plain', 'plan.markdown')).toBe('md')
    expect(inferPreviewableKind('text/plain', 'data.json')).toBe('json')
  })

  it('mime 不准时按扩展名兜底', () => {
    expect(inferPreviewableKind('application/octet-stream', 'notes.txt')).toBe('txt')
    expect(inferPreviewableKind('application/octet-stream', 'data.json')).toBe('json')
    expect(inferPreviewableKind('application/octet-stream', 'readme.md')).toBe('md')
    expect(inferPreviewableKind('application/octet-stream', 'plan.markdown')).toBe('md')
  })

  it('识别 Excel spreadsheet MIME 和 .xls/.xlsx 扩展名', () => {
    expect(inferPreviewableKind(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'report.bin',
    )).toBe('xlsx')
    expect(inferPreviewableKind('application/vnd.ms-excel', 'legacy.bin')).toBe('xlsx')
    expect(inferPreviewableKind('application/octet-stream', 'legacy.xls')).toBe('xlsx')
    expect(inferPreviewableKind('application/octet-stream', 'report.xlsx')).toBe('xlsx')
  })

  it('不可预览类型返回 null', () => {
    expect(inferPreviewableKind('application/zip', 'archive.zip')).toBeNull()
  })
})

describe('decodeTextPreview', () => {
  it('小文件不截断', () => {
    const data = new TextEncoder().encode('hello').buffer
    expect(decodeTextPreview(data)).toEqual({ text: 'hello', truncated: false })
  })

  it('超过上限时截断并标记 truncated', () => {
    const bytes = new Uint8Array(TEXT_PREVIEW_MAX_BYTES + 16)
    bytes.fill(65) // 'A'
    const { text, truncated } = decodeTextPreview(bytes.buffer)
    expect(truncated).toBe(true)
    expect(text.length).toBe(TEXT_PREVIEW_MAX_BYTES)
    expect(text).toMatch(/^A+$/)
  })
})
