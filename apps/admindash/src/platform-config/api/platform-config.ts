import { rawJson } from '@/api/raw-json'
import { getApiClient } from '@/api/tabtin-client'

export type PlatformConfigValueType = 'string' | 'integer' | 'decimal' | 'boolean' | 'json'

export interface PlatformConfigItem {
  id: number
  key: string
  name: string
  description: string
  category: string
  value_type: PlatformConfigValueType
  value: unknown
  default_value: unknown
  is_active: boolean
  is_system: boolean
  sort_order: number
  extra_schema: Record<string, unknown>
  updated_by_id?: string | null
  created_at?: string | null
  updated_at?: string | null
}

export interface PlatformConfigListResponse {
  items: PlatformConfigItem[]
}

export interface PlatformConfigEnvelope {
  success: boolean
  message?: string
  data?: {
    item?: PlatformConfigItem
    items?: PlatformConfigItem[]
  }
}

export interface PlatformConfigSavePayload {
  key: string
  name: string
  description?: string
  category: string
  value_type: PlatformConfigValueType
  value: unknown
  default_value?: unknown
  is_active?: boolean
  is_system?: boolean
  sort_order?: number
  extra_schema?: Record<string, unknown>
}

export interface PlatformConfigUpdatePayload {
  name?: string
  description?: string
  category?: string
  value_type?: PlatformConfigValueType
  value?: unknown
  default_value?: unknown
  is_active?: boolean
  sort_order?: number
  extra_schema?: Record<string, unknown>
}

function unwrapItem(envelope: PlatformConfigEnvelope): PlatformConfigItem {
  const item = envelope.data?.item
  if (!item) throw new Error(envelope.message || '配置响应为空')
  return item
}

export async function listPlatformConfigItems(params?: {
  category?: string
  include_inactive?: boolean
}): Promise<PlatformConfigListResponse> {
  return getApiClient().raw<PlatformConfigListResponse>(
    'GET',
    '/auth/admin/platform-config/items',
    {
      params: {
        ...(params?.category ? { category: params.category } : {}),
        include_inactive: params?.include_inactive ?? true,
      },
    }
  )
}

export async function savePlatformConfigItem(
  payload: PlatformConfigSavePayload
): Promise<PlatformConfigItem> {
  const envelope = await rawJson<PlatformConfigEnvelope>(
    'POST',
    '/auth/admin/platform-config/items',
    payload
  )
  return unwrapItem(envelope)
}

export async function updatePlatformConfigItem(
  key: string,
  payload: PlatformConfigUpdatePayload
): Promise<PlatformConfigItem> {
  const envelope = await rawJson<PlatformConfigEnvelope>(
    'PUT',
    `/auth/admin/platform-config/items/${encodeURIComponent(key)}`,
    payload
  )
  return unwrapItem(envelope)
}

export async function deletePlatformConfigItem(
  key: string,
  payload: { reason: string; ticket_id?: string }
): Promise<void> {
  await rawJson<PlatformConfigEnvelope>(
    'DELETE',
    `/auth/admin/platform-config/items/${encodeURIComponent(key)}?${new URLSearchParams({
      reason: payload.reason,
      ticket_id: payload.ticket_id ?? '',
    }).toString()}`
  )
}
