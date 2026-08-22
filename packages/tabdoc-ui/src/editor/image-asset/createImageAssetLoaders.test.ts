import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createDocumentImageAssetLoader,
  createShareImageAssetLoader,
} from './createImageAssetLoaders'

describe('createDocumentImageAssetLoader', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('loads a short-lived URL with member authorization', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        data: { url: 'https://oss.example/private.jpg?sig=member', expires_in: 900 },
      }),
    })
    vi.stubGlobal('fetch', fetchMock)

    const loader = createDocumentImageAssetLoader({
      apiBaseUrl: 'http://127.0.0.1:6060/api/',
      getAccessToken: async () => 'member-token',
    })
    await expect(loader({ fileId: 'f1', documentId: 'd1' })).resolves.toEqual({
      url: 'https://oss.example/private.jpg?sig=member',
      expiresIn: 900,
    })
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:6060/api/tabdoc/documents/d1/image-assets/f1',
      expect.objectContaining({ headers: { Authorization: 'Bearer member-token' } }),
    )
  })

  it('refreshes an expired member token once', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 401, json: async () => ({ message: 'expired' }) })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ data: { url: 'https://oss.example/private.jpg?sig=fresh' } }),
      })
    vi.stubGlobal('fetch', fetchMock)
    const refreshAccessToken = vi.fn().mockResolvedValue('fresh-token')

    const loader = createDocumentImageAssetLoader({
      apiBaseUrl: 'http://127.0.0.1:6060/api',
      getAccessToken: () => 'stale-token',
      refreshAccessToken,
    })
    await loader({ fileId: 'f1', documentId: 'd1' })

    expect(refreshAccessToken).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls[1][1]).toEqual(
      expect.objectContaining({ headers: { Authorization: 'Bearer fresh-token' } }),
    )
  })
})

describe('createShareImageAssetLoader', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('passes share password and optional member token to the signing endpoint', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ data: { url: 'https://oss.example/private.jpg?sig=share' } }),
    })
    vi.stubGlobal('fetch', fetchMock)

    const loader = createShareImageAssetLoader({
      apiBaseUrl: 'http://127.0.0.1:6060/api',
      getAccessToken: () => 'share-token',
    })
    await loader({ fileId: 'f2', shareId: 's1', password: 'pw' })

    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:6060/api/tabdoc/shared/s1/image-assets/f2',
      expect.objectContaining({
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer share-token',
        },
        body: JSON.stringify({ password: 'pw' }),
      }),
    )
  })
})
