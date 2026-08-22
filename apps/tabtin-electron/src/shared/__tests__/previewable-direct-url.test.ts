import { describe, expect, it } from 'vitest'
import {
  isLegacyDirectPreviewUrl,
  isPreviewableDirectFileUrl,
} from '../previewable-direct-url'

describe('previewable-direct-url', () => {
  it('recognizes https spreadsheet / pdf / image / csv URLs', () => {
    expect(isPreviewableDirectFileUrl('https://cdn.example.com/a.xlsx')).toBe(true)
    expect(isPreviewableDirectFileUrl('https://cdn.example.com/a.xls?sig=1')).toBe(true)
    expect(isPreviewableDirectFileUrl('https://cdn.example.com/a.csv')).toBe(true)
    expect(isPreviewableDirectFileUrl('https://cdn.example.com/a.pdf')).toBe(true)
    expect(isPreviewableDirectFileUrl('https://cdn.example.com/pic.png')).toBe(true)
  })

  it('leaves ordinary web pages for BrowserView', () => {
    expect(isPreviewableDirectFileUrl('https://example.com/')).toBe(false)
    expect(isPreviewableDirectFileUrl('https://example.com/index.html')).toBe(false)
    expect(isPreviewableDirectFileUrl('https://example.com/report')).toBe(false)
  })

  it('only accepts https/blob/data direct schemes', () => {
    expect(isLegacyDirectPreviewUrl('https://x.com/a.xlsx')).toBe(true)
    expect(isPreviewableDirectFileUrl('tabtin://resource/file/a.xlsx')).toBe(false)
    expect(isPreviewableDirectFileUrl('file:///tmp/a.xlsx')).toBe(false)
  })
})
