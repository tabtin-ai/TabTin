/**
 * Tins API 服务层
 *
 * 与后端 /api/tins/* 接口通信。
 */

import { joinApiPath } from '@tabtin/config'
import { API_CONFIG } from '@/config/api'
import { apiRequest, getAuthToken } from '@/adapters/api-adapter-instance'
import type { TableHttpMethod } from '@tabtin/table-core'

// ─── 类型定义 ─────────────────────────────────────

export interface ActivationRule {
  type: 'url_pattern' | 'page_language' | 'page_content' | 'always'
  patterns?: string[]
  languages?: string[]
  keywords?: string[]
}

export interface VariableSchema {
  type: 'text' | 'select' | 'number' | 'boolean'
  label: string
  default?: unknown
  options?: string[]
}

export interface TinDefinition {
  id: string
  organization_id: string
  space_id?: string
  name: string
  description: string
  icon_url: string
  version: string
  status: 'draft' | 'active' | 'disabled'
  source: string

  activation_mode: 'auto' | 'suggest' | 'manual'
  activation_rules: ActivationRule[]
  activation_match: 'any' | 'all'
  variables_schema: Record<string, VariableSchema>
  permissions: string[]
  panel_position: string
  panel_width: number

  panel_html: string
  content_script: string
  background_script: string
  agent_instructions: string
  manifest: Record<string, unknown>
  package_url: string

  created_by?: string
  created_at: string
  updated_at: string
}

export interface TinListItem {
  id: string
  organization_id: string
  space_id?: string
  name: string
  description: string
  icon_url: string
  version: string
  status: string
  source: string
  activation_mode: string
  activation_rules: ActivationRule[]
  activation_match: string
  variables_schema: Record<string, VariableSchema>
  permissions: string[]
  panel_position: string
  panel_width: number
  created_by?: string
  created_at: string
  updated_at: string
}

export interface TinSummary extends TinListItem {
  panel_html: string
  content_script: string
}

export interface TinInstance {
  id: string
  tin_id: string
  organization_id: string
  space_id: string
  is_enabled: boolean
  pinned: boolean
  user_variables: Record<string, unknown>
  last_activated_at?: string
  created_at: string
  updated_at: string
  tin: TinSummary
}

export interface TinRunLog {
  id: string
  instance_id: string
  action: string
  input_data: Record<string, unknown>
  output_data: Record<string, unknown>
  error: string
  duration_ms?: number
  created_at: string
}

interface ApiResponse<T> {
  success: boolean
  data: T
  message?: string
}

// ─── 请求封装 ─────────────────────────────────────

async function tinsRequest<T>(
  method: TableHttpMethod,
  path: string,
  organizationId: string,
  body?: unknown
): Promise<T> {
  const token = await getAuthToken()
  const url = joinApiPath(API_CONFIG.baseURL, `/tins${path}`)

  const response = await apiRequest<ApiResponse<T>>({
    url,
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'X-Organization-Id': organizationId,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })

  const data = response.data
  if (!data?.success && response.status >= 400) {
    throw new Error(data?.message || `Tins API error: ${response.status}`)
  }

  return data.data as T
}

// ─── Tin CRUD ─────────────────────────────────────

export async function listTins(
  organizationId: string,
  options?: {
    spaceId?: string
    status?: string
    offset?: number
    limit?: number
  }
): Promise<{ tins: TinListItem[]; total: number; has_more: boolean }> {
  const params = new URLSearchParams()
  const spaceId = options?.spaceId
  if (spaceId) params.set('space_id', spaceId)
  if (options?.status) params.set('status', options.status)
  if (options?.offset != null) params.set('offset', String(options.offset))
  if (options?.limit != null) params.set('limit', String(options.limit))
  const query = params.toString() ? `?${params}` : ''

  return tinsRequest<{ tins: TinListItem[]; total: number; has_more: boolean }>('GET', `/tins${query}`, organizationId)
}

export async function getTin(organizationId: string, tinId: string): Promise<TinDefinition> {
  return tinsRequest<TinDefinition>('GET', `/tins/${tinId}`, organizationId)
}

export async function createTin(
  organizationId: string,
  payload: Partial<TinDefinition>
): Promise<TinDefinition> {
  return tinsRequest<TinDefinition>('POST', '/tins', organizationId, payload)
}

export async function updateTin(
  organizationId: string,
  tinId: string,
  payload: Partial<TinDefinition>
): Promise<TinDefinition> {
  return tinsRequest<TinDefinition>('PUT', `/tins/${tinId}`, organizationId, payload)
}

export async function updateTinFile(
  organizationId: string,
  tinId: string,
  fileType: string,
  content: string
): Promise<TinDefinition> {
  return tinsRequest<TinDefinition>('PUT', `/tins/${tinId}/file`, organizationId, {
    file_type: fileType,
    content,
  })
}

export async function activateTin(organizationId: string, tinId: string): Promise<TinListItem> {
  return tinsRequest<TinListItem>('POST', `/tins/${tinId}/activate`, organizationId)
}

export async function disableTin(organizationId: string, tinId: string): Promise<TinListItem> {
  return tinsRequest<TinListItem>('POST', `/tins/${tinId}/disable`, organizationId)
}

export async function deleteTin(organizationId: string, tinId: string): Promise<void> {
  await tinsRequest<{ deleted: boolean }>('DELETE', `/tins/${tinId}`, organizationId)
}

// ─── TinInstance CRUD ─────────────────────────────

export async function listInstances(
  organizationId: string,
  spaceId: string,
  options?: { isEnabled?: boolean; offset?: number; limit?: number }
): Promise<{ instances: TinInstance[]; total: number; has_more: boolean }> {
  const params = new URLSearchParams({ space_id: spaceId })
  if (options?.isEnabled !== undefined) {
    params.set('is_enabled', String(options.isEnabled))
  }
  if (options?.offset != null) params.set('offset', String(options.offset))
  if (options?.limit != null) params.set('limit', String(options.limit))
  return tinsRequest<{ instances: TinInstance[]; total: number; has_more: boolean }>(
    'GET', `/instances?${params}`, organizationId
  )
}

export async function installTin(
  organizationId: string,
  payload: {
    tin_id: string
    spaceId?: string
    user_variables?: Record<string, unknown>
    is_enabled?: boolean
    pinned?: boolean
  }
): Promise<TinInstance> {
  const spaceId = payload.spaceId
  if (!spaceId) {
    throw new Error('spaceId is required to install tin')
  }
  return tinsRequest<TinInstance>('POST', '/instances', organizationId, {
    ...payload,
    space_id: spaceId,
  })
}

export async function updateInstance(
  organizationId: string,
  instanceId: string,
  payload: { is_enabled?: boolean; pinned?: boolean; user_variables?: Record<string, unknown> }
): Promise<TinInstance> {
  return tinsRequest<TinInstance>('PUT', `/instances/${instanceId}`, organizationId, payload)
}

export async function uninstallTin(organizationId: string, instanceId: string): Promise<void> {
  await tinsRequest<{ deleted: boolean }>('DELETE', `/instances/${instanceId}`, organizationId)
}

// ─── 运行日志 ─────────────────────────────────────

export async function listRunLogs(
  organizationId: string,
  instanceId: string,
  limit = 50
): Promise<TinRunLog[]> {
  const result = await tinsRequest<{ logs: TinRunLog[] }>(
    'GET', `/instances/${instanceId}/logs?limit=${limit}`, organizationId
  )
  return result.logs
}
