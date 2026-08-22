import { rawJson } from '@/api/raw-json'
import { getApiClient } from '@/api/tabtin-client'
import type {
  AdminTableAuditExportRequest,
  AdminTableBatchMutationResponse,
  AdminTableDetailResponse,
  AdminTableListResponse,
  AdminTableOperationListResponse,
  AdminTableOperationsQuery,
  AdminTableQuery,
} from '@/table-management/types'

interface SensitiveActionPayload {
  reason: string
  ticket_id?: string
}

export async function getAdminTables(
  params: AdminTableQuery = {}
): Promise<AdminTableListResponse> {
  const query = new URLSearchParams()

  if (params.keyword) {
    query.set('keyword', params.keyword)
  }
  if (params.visibility) {
    query.set('visibility', params.visibility)
  }
  if (params.archived) {
    query.set('archived', params.archived)
  }
  if (params.organization_id) {
    query.set('organization_id', params.organization_id)
  }
  if (params.organization_query) {
    query.set('organization_query', params.organization_query)
  }
  if (params.space_id) {
    query.set('space_id', params.space_id)
  }
  if (params.space_query) {
    query.set('space_query', params.space_query)
  }
  if (params.owner_id) {
    query.set('owner_id', params.owner_id)
  }
  if (params.owner_query) {
    query.set('owner_query', params.owner_query)
  }
  if (params.page) {
    query.set('page', String(params.page))
  }
  if (params.page_size) {
    query.set('page_size', String(params.page_size))
  }

  const suffix = query.toString() ? `?${query.toString()}` : ''
  return getApiClient().raw<AdminTableListResponse>('GET', `/auth/admin/tables${suffix}`)
}

export async function getAdminTableDetail(tableId: string): Promise<AdminTableDetailResponse> {
  return getApiClient().raw<AdminTableDetailResponse>('GET', `/auth/admin/tables/${tableId}`)
}

export async function getAdminTableOperations(
  params: AdminTableOperationsQuery = {}
): Promise<AdminTableOperationListResponse> {
  const query = new URLSearchParams()

  if (params.action_type) {
    query.set('action_type', params.action_type)
  }
  if (params.success !== undefined) {
    query.set('success', String(params.success))
  }
  if (params.keyword) {
    query.set('keyword', params.keyword)
  }
  if (params.table_id) {
    query.set('table_id', params.table_id)
  }
  if (params.operator_id) {
    query.set('operator_id', params.operator_id)
  }
  if (params.start_at) {
    query.set('start_at', params.start_at)
  }
  if (params.end_at) {
    query.set('end_at', params.end_at)
  }
  if (params.page) {
    query.set('page', String(params.page))
  }
  if (params.page_size) {
    query.set('page_size', String(params.page_size))
  }

  const suffix = query.toString() ? `?${query.toString()}` : ''
  return getApiClient().raw<AdminTableOperationListResponse>(
    'GET',
    `/auth/admin/tables/operations${suffix}`
  )
}

export async function exportAdminTableAuditLogs(
  payload: AdminTableAuditExportRequest
): Promise<Blob> {
  const response = await getApiClient().raw<Response>('POST', '/auth/admin/tables/audit/export', {
    body: payload,
    rawResponse: true,
  })
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(text || `Export failed: HTTP ${response.status}`)
  }
  return response.blob()
}

export async function batchArchiveTables(
  tableIds: string[],
  options?: { dryRun?: boolean; sensitive?: SensitiveActionPayload }
): Promise<AdminTableBatchMutationResponse> {
  return rawJson<AdminTableBatchMutationResponse>('POST', '/auth/admin/tables/batch/archive', {
    table_ids: tableIds,
    dry_run: options?.dryRun ?? false,
    reason: options?.sensitive?.reason ?? '',
    ticket_id: options?.sensitive?.ticket_id ?? '',
  })
}

export async function batchRestoreTables(
  tableIds: string[],
  options?: { dryRun?: boolean; sensitive?: SensitiveActionPayload }
): Promise<AdminTableBatchMutationResponse> {
  return rawJson<AdminTableBatchMutationResponse>('POST', '/auth/admin/tables/batch/restore', {
    table_ids: tableIds,
    dry_run: options?.dryRun ?? false,
    reason: options?.sensitive?.reason ?? '',
    ticket_id: options?.sensitive?.ticket_id ?? '',
  })
}

export async function batchTrashTables(
  tableIds: string[],
  options?: { dryRun?: boolean; sensitive?: SensitiveActionPayload }
): Promise<AdminTableBatchMutationResponse> {
  return rawJson<AdminTableBatchMutationResponse>('POST', '/auth/admin/tables/batch/trash', {
    table_ids: tableIds,
    dry_run: options?.dryRun ?? false,
    reason: options?.sensitive?.reason ?? '',
    ticket_id: options?.sensitive?.ticket_id ?? '',
  })
}

export async function batchUntrashTables(
  tableIds: string[],
  options?: { dryRun?: boolean; sensitive?: SensitiveActionPayload }
): Promise<AdminTableBatchMutationResponse> {
  return rawJson<AdminTableBatchMutationResponse>('POST', '/auth/admin/tables/batch/untrash', {
    table_ids: tableIds,
    dry_run: options?.dryRun ?? false,
    reason: options?.sensitive?.reason ?? '',
    ticket_id: options?.sensitive?.ticket_id ?? '',
  })
}

export async function trashAdminTable(
  tableId: string,
  payload: SensitiveActionPayload
): Promise<AdminTableBatchMutationResponse> {
  return rawJson<AdminTableBatchMutationResponse>('POST', `/auth/admin/tables/${tableId}/trash`, {
    reason: payload.reason,
    ticket_id: payload.ticket_id ?? '',
  })
}

export async function untrashAdminTable(
  tableId: string,
  payload: SensitiveActionPayload
): Promise<AdminTableBatchMutationResponse> {
  return rawJson<AdminTableBatchMutationResponse>('POST', `/auth/admin/tables/${tableId}/untrash`, {
    reason: payload.reason,
    ticket_id: payload.ticket_id ?? '',
  })
}

export async function batchRepairTableSearchIndexes(
  tableIds: string[],
  options?: { dryRun?: boolean; sensitive?: SensitiveActionPayload }
): Promise<AdminTableBatchMutationResponse> {
  return rawJson<AdminTableBatchMutationResponse>(
    'POST',
    '/auth/admin/tables/batch/search-index/repair',
    {
      table_ids: tableIds,
      dry_run: options?.dryRun ?? false,
      reason: options?.sensitive?.reason ?? '',
      ticket_id: options?.sensitive?.ticket_id ?? '',
    }
  )
}
