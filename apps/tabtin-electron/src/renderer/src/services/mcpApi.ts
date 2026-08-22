/**
 * 组织级远程 MCP API（scope=remote）。
 * 本机 stdio / 手动连接仍走 localMcp IPC。
 */

import { joinApiPath } from '@tabtin/config'
import { API_CONFIG, API_ENDPOINTS } from '@/config/api'
import { apiRequest as adapterApiRequest, getAuthToken } from '@/adapters/api-adapter-instance'

export interface OrgMcpConnection {
  id: string
  name: string
  description: string
  scope: string
  organization_id: string | null
  /** 新字段可选，兼容尚未升级的后端与迁移前的组织精选记录。 */
  created_by_user_id?: string | null
  transport: string
  endpoint: string
  config: Record<string, unknown>
  has_credential: boolean
  enabled: boolean
  last_probe: Record<string, unknown>
  created_at: string
  updated_at: string
}

export interface OrgMcpConnectionCreatePayload {
  name: string
  description?: string
  endpoint: string
  config?: Record<string, unknown>
  credential_value?: string | null
  credential_name?: string | null
  enabled?: boolean
}

async function getAuthHeaders(): Promise<Record<string, string>> {
  try {
    const token = await getAuthToken()
    if (token) return { Authorization: `Bearer ${token}` }
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

export class McpApiService {
  static async listOrgConnections(
    organizationId: string,
  ): Promise<{ connections: OrgMcpConnection[]; total: number }> {
    const url = joinApiPath(
      API_CONFIG.baseURL,
      API_ENDPOINTS.MCP_CONNECTION.LIST_ORG(organizationId),
    )
    const response = await apiRequest({ url, method: 'GET' })
    const data = unwrapResponseData(response)
    if (!data) return { connections: [], total: 0 }
    return data as { connections: OrgMcpConnection[]; total: number }
  }

  static async createOrgConnection(
    organizationId: string,
    payload: OrgMcpConnectionCreatePayload,
  ): Promise<OrgMcpConnection> {
    const url = joinApiPath(
      API_CONFIG.baseURL,
      API_ENDPOINTS.MCP_CONNECTION.CREATE_ORG(organizationId),
    )
    const response = await apiRequest({
      url,
      method: 'POST',
      body: JSON.stringify(payload),
    })
    const data = unwrapResponseData(response)
    if (!data) throw new Error('创建组织远程 MCP 连接失败：无效响应')
    return data as OrgMcpConnection
  }

  static async deleteConnection(connectionId: string): Promise<void> {
    const url = joinApiPath(
      API_CONFIG.baseURL,
      API_ENDPOINTS.MCP_CONNECTION.DELETE(connectionId),
    )
    await apiRequest({ url, method: 'DELETE' })
  }
}
