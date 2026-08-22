/**
 * 应用根级共享的 AppHostClient (Web 端)
 *
 * smartsheet-ui 的 share-dialog 在 TablePaneView 等地方渲染时通过 useAppHostClient()
 * 获取 client 调用后端接口。这些渲染点并不在 WebDocRoute 的 AppHostClientProvider 内,
 * 所以需要一个根级 Provider 作为兜底。
 *
 * WebDocRoute 等编辑器路由自带的内层 Provider 会覆盖外层 — 编辑器专属 client 不受影响。
 */
import { createDirectAppClient } from '@tabtin/app-host-sdk/host'
import type { AppHostClient } from '@tabtin/app-host-sdk'
import type { AppHttpRequest, AppHttpResponse, AppHttpTransport } from '@tabtin/contracts/app'
import { getApiClient } from '@/services/api-client'
import { API_BASE_URL } from '@/config/api'
import { STORAGE_KEYS } from '@/platform'

let cached: AppHostClient | null = null

const resolveBaseUrl = (): string => {
  if (API_BASE_URL && API_BASE_URL.trim().length > 0) return API_BASE_URL
  if (typeof window !== 'undefined') return `${window.location.origin}/api`
  return '/api'
}

const httpTransport: AppHttpTransport = async <T = unknown>(
  req: AppHttpRequest,
): Promise<AppHttpResponse<T>> => {
  const baseApiUrl = resolveBaseUrl()
  const apiClient = getApiClient()
  const rawPath = req.url.startsWith(baseApiUrl) ? req.url.slice(baseApiUrl.length) : req.url
  const response = (await apiClient.raw(req.method, rawPath.startsWith('/') ? rawPath : `/${rawPath}`, {
    headers: req.headers,
    body: req.body ? JSON.parse(req.body) : undefined,
    rawResponse: true,
  })) as Response
  const contentType = response.headers.get('content-type') ?? ''
  let data: unknown
  if (response.status === 204) data = undefined
  else if (contentType.includes('application/json')) data = await response.json()
  else data = await response.text()
  return { data: data as T, status: response.status, statusText: response.statusText, headers: {} }
}

export function getSharedAppHostClient(): AppHostClient {
  if (cached) return cached
  cached = createDirectAppClient({
    appId: 'tabtin-shell',
    spaceId: null,
    organizationId: null,
    baseApiUrl: resolveBaseUrl(),
    getAccessToken: async () => localStorage.getItem(STORAGE_KEYS.ACCESS_TOKEN),
    httpTransport,
  })
  return cached
}
