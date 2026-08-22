/**
 * SSH Remote Server API 服务
 *
 * 负责 SSH 远程服务器的 CRUD 和连通性测试。
 */

import { joinApiPath } from '@tabtin/config'
import type { RemoteServer, RemoteServerCreate, RemoteServerUpdate } from '@tabtin/app-shell'
import { API_CONFIG, API_ENDPOINTS } from '@/config/api'
import { apiRequest as adapterApiRequest, getAuthToken } from '@/adapters/api-adapter-instance'
import i18n from '@/i18n'

async function getAuthHeaders(): Promise<Record<string, string>> {
  try {
    const token = await getAuthToken()
    if (token) {
      return { Authorization: `Bearer ${token}` }
    }
    return {}
  } catch {
    return {}
  }
}

async function apiRequest(options: {
  url: string
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH'
  body?: string
}): Promise<any> {
  const authHeaders = await getAuthHeaders()
  const response = await adapterApiRequest({
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...authHeaders,
    },
  })
  if (response && response.status >= 400) {
    const msg = response.data?.message ?? response.data?.error ?? `HTTP ${response.status}`
    const err = new Error(msg) as Error & { status?: number }
    err.status = response.status
    throw err
  }
  return response
}

function unwrapResponseData(response: any): any {
  const body = response?.data
  if (body && typeof body === 'object' && 'data' in body) {
    return body.data
  }
  return body
}

export class SSHApiService {
  static async listServers(deviceId: string): Promise<{ servers: RemoteServer[]; total: number }> {
    const url = joinApiPath(API_CONFIG.baseURL, `${API_ENDPOINTS.SSH.LIST(deviceId)}`)
    const response = await apiRequest({ url, method: 'GET' })
    const data = unwrapResponseData(response)
    if (!data) {
      return { servers: [], total: 0 }
    }
    return data as { servers: RemoteServer[]; total: number }
  }

  static async createServer(deviceId: string, payload: RemoteServerCreate): Promise<RemoteServer> {
    const url = joinApiPath(API_CONFIG.baseURL, `${API_ENDPOINTS.SSH.CREATE(deviceId)}`)
    const response = await apiRequest({
      url,
      method: 'POST',
      body: JSON.stringify(payload),
    })
    const data = unwrapResponseData(response)
    if (!data) {
      throw new Error(`[SSH] ${i18n.t('common:errors.sshCreateInvalidResponse')}`)
    }
    return data as RemoteServer
  }

  static async updateServer(serverId: string, payload: RemoteServerUpdate): Promise<RemoteServer> {
    const url = joinApiPath(API_CONFIG.baseURL, `${API_ENDPOINTS.SSH.UPDATE(serverId)}`)
    const response = await apiRequest({
      url,
      method: 'PATCH',
      body: JSON.stringify(payload),
    })
    const data = unwrapResponseData(response)
    if (!data) {
      throw new Error(`[SSH] ${i18n.t('common:errors.sshUpdateInvalidResponse')}`)
    }
    return data as RemoteServer
  }

  static async deleteServer(serverId: string): Promise<void> {
    const url = joinApiPath(API_CONFIG.baseURL, `${API_ENDPOINTS.SSH.DELETE(serverId)}`)
    await apiRequest({ url, method: 'DELETE' })
  }

  static async testConnection(serverId: string): Promise<{ success: boolean; os_info?: string; error?: string }> {
    const url = joinApiPath(API_CONFIG.baseURL, `${API_ENDPOINTS.SSH.TEST(serverId)}`)
    const response = await apiRequest({ url, method: 'POST' })
    return unwrapResponseData(response) ?? { success: false, error: 'No response' }
  }

  static async resetHostKey(serverId: string): Promise<void> {
    const url = joinApiPath(API_CONFIG.baseURL, `${API_ENDPOINTS.SSH.RESET_HOST_KEY(serverId)}`)
    await apiRequest({ url, method: 'POST' })
  }
}
