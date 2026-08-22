import { rawJson } from '@/api/raw-json'
import { getApiClient } from '@/api/tabtin-client'

export interface AdminShareItem {
  id: string
  resource_type: 'doc' | 'table' | string
  resource_id: string
  resource_title: string
  share_id: string
  share_type: string
  permission: string
  is_active: boolean
  has_password: boolean
  organization_id: string
  space_id: string
  created_by_id?: string | null
  created_by_name?: string | null
  created_at?: string | null
  updated_at?: string | null
  expire_at?: string | null
  visit_count: number
}

export interface AdminShareListResponse {
  items: AdminShareItem[]
  total: number
  page: number
  page_size: number
}

export interface AdminShareListQuery {
  resource_type?: string
  resource_id?: string
  organization_id?: string
  active?: boolean
  page?: number
  page_size?: number
}

export interface AdminShareSensitivePayload {
  reason: string
  ticket_id?: string
}

export async function getAdminShares(
  params: AdminShareListQuery = {}
): Promise<AdminShareListResponse> {
  const query = new URLSearchParams()
  if (params.resource_type) query.set('resource_type', params.resource_type)
  if (params.resource_id) query.set('resource_id', params.resource_id)
  if (params.organization_id) query.set('organization_id', params.organization_id)
  if (params.active !== undefined) query.set('active', String(params.active))
  if (params.page) query.set('page', String(params.page))
  if (params.page_size) query.set('page_size', String(params.page_size))
  const suffix = query.toString() ? `?${query.toString()}` : ''
  return getApiClient().raw<AdminShareListResponse>('GET', `/auth/admin/shares${suffix}`)
}

export async function revokeAdminShare(
  resourceType: string,
  shareId: string,
  payload: AdminShareSensitivePayload
): Promise<{ message?: string }> {
  return rawJson<{ message?: string }>(
    'POST',
    `/auth/admin/shares/${resourceType}/${shareId}/revoke`,
    {
      reason: payload.reason,
      ticket_id: payload.ticket_id ?? '',
    }
  )
}
