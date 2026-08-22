import { getApiClient } from '@/api/tabtin-client'

export type DiagnosticBundleItem = {
  id: string
  user_id: string
  organization_id: string
  client_install_id: string
  sentry_event_id: string | null
  source: 'incident' | 'support_upload'
  status: string
  bytes: number
  created_at: string
  available_at: string | null
  expires_at: string
  expired: boolean
}

export async function listDiagnosticBundles(input: { query?: string; status?: string; page?: number } = {}) {
  return getApiClient().raw<{ items: DiagnosticBundleItem[]; pagination: { total: number; page: number; page_size: number } }>(
    'GET',
    '/diagnostics/admin/bundles',
    { params: { query: input.query || undefined, status: input.status || undefined, page: input.page || 1, page_size: 30 } },
  )
}

export async function createDiagnosticDownload(bundleId: string) {
  return getApiClient().raw<{ bundle_id: string; download_url: string; expires_in: number }>(
    'POST',
    `/diagnostics/admin/bundles/${encodeURIComponent(bundleId)}/download`,
  )
}
