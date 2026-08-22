/**
 * Electron renderer 的 @tabtin/api-client 单例。
 *
 * 通过 electronFetch 桥接 IPC 代理，保持 Electron main 进程统一转发 HTTP 请求的架构。
 * 配置了 token 注入、401 自动 refresh 重试、ApiEnvelope 解包。
 */

import { createApiClient, type TabTinApiClient, type DelegatedRefresh } from '@tabtin/api-client'
import { electronFetch } from './electronFetch'
import { API_CONFIG } from '@/config/api'
import { notifyTokensSynced, notifyLogoutRequired } from '@/utils/authPersistence'

let _client: TabTinApiClient | null = null

async function getAccessToken(): Promise<string | null> {
  if (!window.tabtin?.auth?.getAccessToken) return null
  try {
    const result = await window.tabtin.auth.getAccessToken()
    return result?.success ? (result.token ?? null) : null
  } catch {
    return null
  }
}

async function hasRefreshableSession(): Promise<DelegatedRefresh | null> {
  if (!window.tabtin?.auth?.refreshAccessToken) return null
  return { delegateToMain: true }
}

async function refreshViaMainProcess(
  _refreshToken: string | null,
): Promise<{ access_token: string; refresh_token: string } | null> {
  // contract W2-β：旧 envelope `{success, accessToken}` 改为 invokeIpc 直接返
  // `{ accessToken, ... }` 或 throw。
  // 这个 helper 是 chat-client 的"refresh 失败兜底"路径——失败时返 null，
  // chat-client 会触发 session_expired 流程，所以 catch 黑洞是合理的。
  try {
    const result = await window.tabtin.auth.refreshAccessToken()
    if (!result?.accessToken) return null

    const authBundle = await window.tabtin.auth.get().catch(() => null)
    const storedRefreshToken = authBundle?.refreshToken || ''

    notifyTokensSynced({
      accessToken: result.accessToken,
      refreshToken: storedRefreshToken,
    })

    return { access_token: result.accessToken, refresh_token: storedRefreshToken }
  } catch {
    return null
  }
}

function handleSessionExpired(): void {
  notifyLogoutRequired('session_expired')
}

export function getElectronApiClient(): TabTinApiClient {
  if (!_client) {
    _client = createApiClient({
      baseUrl: API_CONFIG.baseURL,
      clientType: 'electron',
      fetch: electronFetch,
      getToken: getAccessToken,
      onUnauthorized: handleSessionExpired,
      refresh: {
        getRefreshToken: hasRefreshableSession,
        onRefreshToken: refreshViaMainProcess,
        onRefreshFailed: handleSessionExpired,
      },
    })
  }
  return _client
}

export function resetElectronApiClient(): void {
  _client = null
}
