import { beforeEach, describe, expect, it, vi } from 'vitest'

const openResourcePreview = vi.fn(() => true)

vi.mock('../useResourcePreviewStore', () => ({
  useResourcePreviewStore: {
    getState: () => ({
      open: (...args: unknown[]) => (openResourcePreview as (...items: unknown[]) => unknown)(...args),
    }),
  },
}))

import {
  resolveLegacyFilePreviewResource,
  tryOpenPreviewableDirectUrl,
} from '../assetPreviewResolver'

describe('assetPreviewResolver', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    openResourcePreview.mockReturnValue(true)
  })

  it('maps legacy direct xlsx URLs to spreadsheet preview resources', () => {
    expect(resolveLegacyFilePreviewResource({
      url: 'https://assets.example.com/tabfiles/uploads/report.xlsx',
      filename: 'report.xlsx',
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      size: 1024,
      fileId: 'file-1',
    })).toMatchObject({
      id: 'legacy-file:file-1',
      kind: 'xlsx',
      url: 'https://assets.example.com/tabfiles/uploads/report.xlsx',
      name: 'report.xlsx',
    })
  })

  it('strips query strings when inferring filename from URL', () => {
    expect(resolveLegacyFilePreviewResource({
      url: 'https://assets.example.com/tabfiles/uploads/a.xlsx?signature=secret',
    })).toMatchObject({
      kind: 'xlsx',
      name: 'a.xlsx',
    })
  })

  it('does not turn arbitrary webpages into file preview resources', () => {
    expect(resolveLegacyFilePreviewResource({
      url: 'https://example.com/',
      filename: 'example',
      mimeType: 'text/html',
    })).toBeNull()
  })

  it('tryOpenPreviewableDirectUrl opens spreadsheet preview and skips BrowserView callers', () => {
    expect(tryOpenPreviewableDirectUrl('https://cdn.example.com/sheet.csv')).toBe(true)
    expect(openResourcePreview).toHaveBeenCalledWith([
      expect.objectContaining({ kind: 'csv', name: 'sheet.csv' }),
    ], 0)
  })

  it('tryOpenPreviewableDirectUrl leaves html pages for BrowserView', () => {
    expect(tryOpenPreviewableDirectUrl('https://example.com/index.html')).toBe(false)
    expect(openResourcePreview).not.toHaveBeenCalled()
  })
})
