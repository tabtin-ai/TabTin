import type {
  TabDocImageAssetLoader,
  TabDocImageAssetLoadResult,
} from './ImageAssetLoaderContext'

function normalizeApiBase(apiBaseUrl: string): string {
  return apiBaseUrl.replace(/\/+$/, '')
}

async function readPayload(response: Response): Promise<TabDocImageAssetLoadResult> {
  const payload = await response.json() as {
    message?: string
    data?: { url?: string; expires_in?: number | null }
  }
  if (!response.ok || !payload.data?.url) {
    throw new Error(payload.message || `HTTP ${response.status}`)
  }
  return {
    url: payload.data.url,
    expiresIn: payload.data.expires_in,
  }
}

export function createDocumentImageAssetLoader(options: {
  apiBaseUrl: string
  getAccessToken: () => Promise<string | null> | string | null
  refreshAccessToken?: () => Promise<string | null> | string | null
}): TabDocImageAssetLoader {
  const base = normalizeApiBase(options.apiBaseUrl)
  return async ({ fileId, documentId, signal }) => {
    if (!documentId) throw new Error('documentId is required to load image asset')
    const url = `${base}/tabdoc/documents/${encodeURIComponent(documentId)}/image-assets/${encodeURIComponent(fileId)}`
    const fetchOnce = async (token: string | null) => fetch(url, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      signal,
    })
    let token = await options.getAccessToken()
    let response = await fetchOnce(token)
    if (response.status === 401 && options.refreshAccessToken) {
      token = await options.refreshAccessToken()
      response = await fetchOnce(token)
    }
    return readPayload(response)
  }
}

export function createShareImageAssetLoader(options: {
  apiBaseUrl: string
  getAccessToken?: () => string | null
}): TabDocImageAssetLoader {
  const base = normalizeApiBase(options.apiBaseUrl)
  return async ({ fileId, shareId, password, signal }) => {
    if (!shareId) throw new Error('shareId is required to load shared image asset')
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    const token = options.getAccessToken?.()
    if (token) headers.Authorization = `Bearer ${token}`
    const response = await fetch(
      `${base}/tabdoc/shared/${encodeURIComponent(shareId)}/image-assets/${encodeURIComponent(fileId)}`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({ password: password || '' }),
        signal,
      },
    )
    return readPayload(response)
  }
}
