import type { AppHostClient } from '@tabtin/app-host-sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { exportDocumentBlob, parseContentDispositionFilename } from '../api-client'

const makeClient = (token = 'jwt-token') => ({
  getBaseApiUrl: () => 'https://api.example.test/',
  getAccessToken: vi.fn(async () => token),
}) as unknown as AppHostClient

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('parseContentDispositionFilename ()', () => {
  it('returns null when no filename present', () => {
    expect(parseContentDispositionFilename('attachment')).toBeNull()
    expect(parseContentDispositionFilename('')).toBeNull()
  })

  it('reads plain ASCII filename', () => {
    expect(parseContentDispositionFilename('attachment; filename="Report.docx"')).toBe('Report.docx')
  })

  it('prefers filename* (RFC 5987) over the ASCII fallback filename=', () => {
    const disposition =
      "attachment; filename=\"__.docx\"; filename*=UTF-8''%E6%8E%A2%E7%B4%A2.docx"
    expect(parseContentDispositionFilename(disposition)).toBe('探索.docx')
  })

  it('decodes percent-encoded UTF-8 from filename*', () => {
    const disposition = "attachment; filename*=UTF-8''Pinterest%20Ideas%20%E6%8E%A2%E7%B4%A2.docx"
    expect(parseContentDispositionFilename(disposition)).toBe('Pinterest Ideas 探索.docx')
  })

  it('does not mistake the trailing "filename*" token for the plain filename', () => {
    const disposition = "attachment; filename*=UTF-8''abc.docx"
    expect(parseContentDispositionFilename(disposition)).toBe('abc.docx')
  })

  it('parses docx export header that only carries filename*', () => {
    const disposition = "attachment; filename*=UTF-8''%E4%BA%91%E7%9B%98%E5%90%8D.docx"
    expect(parseContentDispositionFilename(disposition)).toBe('云盘名.docx')
  })
})

describe('exportDocumentBlob', () => {
  it('downloads PDF as blob with encoded document id and response filename', async () => {
    const fetchMock = vi.fn(async () => new Response('%PDF-1.4', {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': "attachment; filename*=UTF-8''%E6%8A%A5%E5%91%8A.pdf",
      },
    }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await exportDocumentBlob(makeClient(), 'doc/id', 'pdf')

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.example.test/tabdoc/documents/doc%2Fid/export?format=pdf',
      expect.objectContaining({
        method: 'GET',
        headers: { Authorization: 'Bearer jwt-token' },
      }),
    )
    expect(result.filename).toBe('报告.pdf')
    expect(await result.blob.text()).toBe('%PDF-1.4')
  })

  it('surfaces JSON error detail from failed PDF export', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      success: false,
      code: 'VALIDATION_ERROR',
      message: '参数错误',
      data: {
        detail: 'PDF 导出需要可用的 Playwright Chromium renderer',
      },
    }), { status: 400 })))

    await expect(exportDocumentBlob(makeClient(), 'doc-1', 'pdf')).rejects.toThrow(
      'PDF 导出需要可用的 Playwright Chromium renderer',
    )
  })
})
