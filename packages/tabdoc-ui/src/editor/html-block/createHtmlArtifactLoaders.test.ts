import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createDocumentHtmlArtifactLoader,
  createShareHtmlArtifactLoader,
} from './createHtmlArtifactLoaders'

describe('createDocumentHtmlArtifactLoader', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('GETs authorized artifact with Bearer token', async () => {
    const blob = new Blob(['<html>ok</html>'], { type: 'text/html' })
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      blob: async () => blob,
    })
    vi.stubGlobal('fetch', fetchMock)

    const loader = createDocumentHtmlArtifactLoader({
      apiBaseUrl: 'http://127.0.0.1:6060/api/',
      getAccessToken: async () => 'tok-1',
    })
    const result = await loader({ fileId: 'f1', documentId: 'd1' })
    expect(result).toBe(blob)
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:6060/api/tabdoc/documents/d1/html-artifacts/f1',
      expect.objectContaining({
        headers: { Authorization: 'Bearer tok-1' },
      }),
    )
  })

  it('requires documentId', async () => {
    const loader = createDocumentHtmlArtifactLoader({
      apiBaseUrl: 'http://x',
      getAccessToken: () => null,
    })
    await expect(loader({ fileId: 'f1' })).rejects.toThrow(/documentId/)
  })

  it('on 401 refreshes token once and retries GET', async () => {
    const blob = new Blob(['<html>retry</html>'], { type: 'text/html' })
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 401,
        json: async () => ({ message: 'expired' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        blob: async () => blob,
      })
    vi.stubGlobal('fetch', fetchMock)
    const refreshAccessToken = vi.fn().mockResolvedValue('tok-fresh')

    const loader = createDocumentHtmlArtifactLoader({
      apiBaseUrl: 'http://127.0.0.1:6060/api',
      getAccessToken: async () => 'tok-stale',
      refreshAccessToken,
    })
    const result = await loader({ fileId: 'f1', documentId: 'd1' })
    expect(result).toBe(blob)
    expect(refreshAccessToken).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls[1][1]).toEqual(
      expect.objectContaining({
        headers: { Authorization: 'Bearer tok-fresh' },
      }),
    )
  })

  it('does not refresh when refreshAccessToken is omitted', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({ message: 'expired' }),
    })
    vi.stubGlobal('fetch', fetchMock)

    const loader = createDocumentHtmlArtifactLoader({
      apiBaseUrl: 'http://127.0.0.1:6060/api',
      getAccessToken: async () => 'tok-stale',
    })
    await expect(loader({ fileId: 'f1', documentId: 'd1' })).rejects.toThrow(/expired/)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe('createShareHtmlArtifactLoader', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('POSTs password in body and optional Bearer', async () => {
    const blob = new Blob(['<html>share</html>'], { type: 'text/html' })
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      blob: async () => blob,
    })
    vi.stubGlobal('fetch', fetchMock)

    const loader = createShareHtmlArtifactLoader({
      apiBaseUrl: 'http://127.0.0.1:6060/api',
      getAccessToken: () => 'share-tok',
    })
    await loader({ fileId: 'f2', shareId: 's1', password: 'pw' })
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:6060/api/tabdoc/shared/s1/html-artifacts/f2',
      expect.objectContaining({
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer share-tok',
        },
        body: JSON.stringify({ password: 'pw' }),
      }),
    )
  })
})
