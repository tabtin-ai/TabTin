import type { TabDocHtmlArtifactLoader } from './HtmlArtifactLoaderContext'

function normalizeApiBase(apiBaseUrl: string): string {
  return apiBaseUrl.replace(/\/+$/, '')
}

async function readErrorMessage(response: Response): Promise<string> {
  try {
    const json = (await response.json()) as { message?: string; detail?: string }
    return json.message || json.detail || `HTTP ${response.status}`
  } catch {
    return `HTTP ${response.status}`
  }
}

export function createDocumentHtmlArtifactLoader(options: {
  apiBaseUrl: string
  getAccessToken: () => Promise<string | null> | string | null
  /** Optional 401 recovery: refresh once then retry the GET. */
  refreshAccessToken?: () => Promise<string | null> | string | null
}): TabDocHtmlArtifactLoader {
  const base = normalizeApiBase(options.apiBaseUrl)
  return async ({ fileId, documentId, signal }) => {
    if (!documentId) {
      throw new Error('documentId is required to load HTML artifact')
    }

    const url =
      `${base}/tabdoc/documents/${encodeURIComponent(documentId)}/html-artifacts/${encodeURIComponent(fileId)}`

    const fetchOnce = async (token: string | null) => {
      const headers: Record<string, string> = {}
      if (token) headers.Authorization = `Bearer ${token}`
      return fetch(url, { headers, signal })
    }

    let token = await options.getAccessToken()
    let response = await fetchOnce(token)

    if (response.status === 401 && options.refreshAccessToken) {
      token = await options.refreshAccessToken()
      response = await fetchOnce(token)
    }

    if (!response.ok) {
      throw new Error(await readErrorMessage(response))
    }
    return response.blob()
  }
}

export function createShareHtmlArtifactLoader(options: {
  apiBaseUrl: string
  getAccessToken?: () => string | null
}): TabDocHtmlArtifactLoader {
  const base = normalizeApiBase(options.apiBaseUrl)
  return async ({ fileId, shareId, password, signal }) => {
    if (!shareId) {
      throw new Error('shareId is required to load shared HTML artifact')
    }
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    }
    const token = options.getAccessToken?.()
    if (token) headers.Authorization = `Bearer ${token}`
    const response = await fetch(
      `${base}/tabdoc/shared/${encodeURIComponent(shareId)}/html-artifacts/${encodeURIComponent(fileId)}`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({ password: password || '' }),
        signal,
      },
    )
    if (!response.ok) {
      throw new Error(await readErrorMessage(response))
    }
    return response.blob()
  }
}
