import { getApiClient } from '@/api/tabtin-client'
import type {
  AuditAppsResponse,
  AuditToolsResponse,
  CategoryStat,
  ProviderStat,
  SyncResult,
  ToolBrief,
  ToolDetail,
  ToolListQuery,
  ToolListResponse,
} from '../types'

function buildQuery(params: Record<string, string | number | boolean | undefined>): string {
  const q = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') {
      q.set(k, String(v))
    }
  }
  const s = q.toString()
  return s ? `?${s}` : ''
}

export async function getToolList(params: ToolListQuery = {}): Promise<ToolListResponse> {
  const suffix = buildQuery(params as Record<string, string | number>)
  return getApiClient().raw<ToolListResponse>('GET', `/capabilities/tools${suffix}`)
}

export async function getToolDetail(toolName: string): Promise<ToolDetail> {
  return getApiClient().raw<ToolDetail>(
    'GET',
    `/capabilities/tools/${encodeURIComponent(toolName)}`
  )
}

export async function toggleToolStatus(
  toolName: string,
  status: 'active' | 'disabled',
  payload: { reason: string; ticket_id?: string }
): Promise<ToolBrief> {
  return getApiClient().raw<ToolBrief>(
    'PATCH',
    `/capabilities/admin/tools/${encodeURIComponent(toolName)}/status`,
    {
      body: {
        status,
        reason: payload.reason,
        ticket_id: payload.ticket_id || '',
      },
    }
  )
}

export async function syncTools(): Promise<SyncResult> {
  return getApiClient().raw<SyncResult>('POST', '/capabilities/tools/sync')
}

export async function syncSkillLinks(): Promise<{ total_links: number }> {
  return getApiClient().raw<{ total_links: number }>('POST', '/capabilities/links/sync')
}

export async function getCategories(): Promise<CategoryStat[]> {
  const resp = await getApiClient().raw<{ categories: CategoryStat[] }>(
    'GET',
    '/capabilities/categories'
  )
  return resp.categories
}

export async function getProviders(): Promise<ProviderStat[]> {
  const resp = await getApiClient().raw<{ providers: ProviderStat[] }>(
    'GET',
    '/capabilities/providers'
  )
  return resp.providers
}

export async function runAuditTools(params?: {
  domain?: string
  tool?: string
  source?: string
}): Promise<AuditToolsResponse> {
  const suffix = buildQuery((params || {}) as Record<string, string>)
  return getApiClient().raw<AuditToolsResponse>('GET', `/capabilities/admin/audit/tools${suffix}`)
}

export async function runAuditApps(appId?: string): Promise<AuditAppsResponse> {
  const suffix = appId ? `?app_id=${encodeURIComponent(appId)}` : ''
  return getApiClient().raw<AuditAppsResponse>('GET', `/capabilities/admin/audit/apps${suffix}`)
}
