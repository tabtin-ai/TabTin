import { rawJson } from '@/api/raw-json'
import { getApiClient } from '@/api/tabtin-client'
import type {
  AdminDocAuditExportQuery,
  AdminDocBatchMutationResponse,
  AdminDocDetailResponse,
  AdminDocListResponse,
  AdminDocOperationsQuery,
  AdminDocOperationsResponse,
  AdminDocPermissionInput,
  AdminDocPermissionsUpdateResponse,
  AdminDocQuery,
  AdminDocRestoreResponse,
} from '@/doc-management/types'

interface SensitiveActionPayload {
  reason: string
  ticket_id?: string
}

export async function getAdminDocs(params: AdminDocQuery = {}): Promise<AdminDocListResponse> {
  const query = new URLSearchParams()

  if (params.keyword) {
    query.set('keyword', params.keyword)
  }
  if (params.status) {
    query.set('status', params.status)
  }
  if (params.organization_id) {
    query.set('organization_id', params.organization_id)
  }
  if (params.space_id) {
    query.set('space_id', params.space_id)
  }
  if (params.updated_by_id) {
    query.set('updated_by_id', params.updated_by_id)
  }
  if (params.has_permission_override !== undefined) {
    query.set('has_permission_override', String(params.has_permission_override))
  }
  if (params.page) {
    query.set('page', String(params.page))
  }
  if (params.page_size) {
    query.set('page_size', String(params.page_size))
  }

  const suffix = query.toString() ? `?${query.toString()}` : ''
  return getApiClient().raw<AdminDocListResponse>('GET', `/auth/admin/docs${suffix}`)
}

export async function getAdminDocDetail(documentId: string): Promise<AdminDocDetailResponse> {
  return getApiClient().raw<AdminDocDetailResponse>('GET', `/auth/admin/docs/${documentId}`)
}

export async function batchArchiveDocs(
  documentIds: string[],
  options?: { dryRun?: boolean; sensitive?: SensitiveActionPayload }
): Promise<AdminDocBatchMutationResponse> {
  return rawJson<AdminDocBatchMutationResponse>('POST', '/auth/admin/docs/batch/archive', {
    document_ids: documentIds,
    dry_run: options?.dryRun ?? false,
    reason: options?.sensitive?.reason ?? '',
    ticket_id: options?.sensitive?.ticket_id ?? '',
  })
}

export async function batchRestoreDocs(
  documentIds: string[],
  options?: { dryRun?: boolean; sensitive?: SensitiveActionPayload }
): Promise<AdminDocBatchMutationResponse> {
  return rawJson<AdminDocBatchMutationResponse>('POST', '/auth/admin/docs/batch/restore', {
    document_ids: documentIds,
    dry_run: options?.dryRun ?? false,
    reason: options?.sensitive?.reason ?? '',
    ticket_id: options?.sensitive?.ticket_id ?? '',
  })
}

export async function batchTrashDocs(
  documentIds: string[],
  options?: { dryRun?: boolean; sensitive?: SensitiveActionPayload }
): Promise<AdminDocBatchMutationResponse> {
  return rawJson<AdminDocBatchMutationResponse>('POST', '/auth/admin/docs/batch/trash', {
    document_ids: documentIds,
    dry_run: options?.dryRun ?? false,
    reason: options?.sensitive?.reason ?? '',
    ticket_id: options?.sensitive?.ticket_id ?? '',
  })
}

export async function batchUntrashDocs(
  documentIds: string[],
  options?: { dryRun?: boolean; sensitive?: SensitiveActionPayload }
): Promise<AdminDocBatchMutationResponse> {
  return rawJson<AdminDocBatchMutationResponse>('POST', '/auth/admin/docs/batch/untrash', {
    document_ids: documentIds,
    dry_run: options?.dryRun ?? false,
    reason: options?.sensitive?.reason ?? '',
    ticket_id: options?.sensitive?.ticket_id ?? '',
  })
}

export async function restoreAdminDocRevision(
  documentId: string,
  input: {
    version?: number
    versionId?: string
  } & SensitiveActionPayload
): Promise<AdminDocRestoreResponse> {
  return rawJson<AdminDocRestoreResponse>('POST', `/auth/admin/docs/${documentId}/restore`, {
    version: input.version,
    version_id: input.versionId,
    reason: input.reason,
    ticket_id: input.ticket_id ?? '',
  })
}

export async function archiveAdminDoc(
  documentId: string,
  payload: SensitiveActionPayload
): Promise<AdminDocRestoreResponse> {
  return rawJson<AdminDocRestoreResponse>('POST', `/auth/admin/docs/${documentId}/status/archive`, {
    reason: payload.reason,
    ticket_id: payload.ticket_id ?? '',
  })
}

export async function restoreAdminDocStatus(
  documentId: string,
  payload: SensitiveActionPayload
): Promise<AdminDocRestoreResponse> {
  return rawJson<AdminDocRestoreResponse>('POST', `/auth/admin/docs/${documentId}/status/restore`, {
    reason: payload.reason,
    ticket_id: payload.ticket_id ?? '',
  })
}

export async function trashAdminDoc(
  documentId: string,
  payload: SensitiveActionPayload
): Promise<AdminDocRestoreResponse> {
  return rawJson<AdminDocRestoreResponse>('POST', `/auth/admin/docs/${documentId}/trash`, {
    reason: payload.reason,
    ticket_id: payload.ticket_id ?? '',
  })
}

export async function untrashAdminDoc(
  documentId: string,
  payload: SensitiveActionPayload
): Promise<AdminDocRestoreResponse> {
  return rawJson<AdminDocRestoreResponse>('POST', `/auth/admin/docs/${documentId}/untrash`, {
    reason: payload.reason,
    ticket_id: payload.ticket_id ?? '',
  })
}

export async function updateAdminDocPermissions(
  documentId: string,
  entries: AdminDocPermissionInput[],
  sensitive: SensitiveActionPayload
): Promise<AdminDocPermissionsUpdateResponse> {
  return rawJson<AdminDocPermissionsUpdateResponse>(
    'POST',
    `/auth/admin/docs/${documentId}/permissions`,
    {
      entries: entries.map((item) => ({
        subject_type: item.subject_type,
        subject_id: item.subject_id,
        permission: item.permission,
        is_active: item.is_active ?? true,
      })),
      reason: sensitive.reason,
      ticket_id: sensitive.ticket_id ?? '',
    }
  )
}

export async function getAdminDocOperations(
  params: AdminDocOperationsQuery = {}
): Promise<AdminDocOperationsResponse> {
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
  if (params.document_id) {
    query.set('document_id', params.document_id)
  }
  if (params.page) {
    query.set('page', String(params.page))
  }
  if (params.page_size) {
    query.set('page_size', String(params.page_size))
  }

  const suffix = query.toString() ? `?${query.toString()}` : ''
  return getApiClient().raw<AdminDocOperationsResponse>(
    'GET',
    `/auth/admin/docs/operations${suffix}`
  )
}

function resolveFilename(contentDisposition: string | null): string {
  if (!contentDisposition) {
    return `doc_admin_audit_${Date.now()}.csv`
  }
  const match = contentDisposition.match(/filename=\"?([^\";]+)\"?/)
  return match?.[1] || `doc_admin_audit_${Date.now()}.csv`
}

export async function exportAdminDocAuditCsv(params: AdminDocAuditExportQuery = {}): Promise<void> {
  const response = (await getApiClient().raw('POST', '/auth/admin/docs/audit/export', {
    body: {
      action_type: params.action_type || 'all',
      success: params.success,
      keyword: params.keyword || '',
      document_id: params.document_id || '',
      limit: Math.max(1, Math.min(params.limit ?? 5000, 20000)),
    },
    rawResponse: true,
  })) as Response

  if (!response.ok) {
    let message = '导出失败'
    try {
      const payload = await response.json()
      message = payload?.message || payload?.detail || message
    } catch {
      // ignore json parse errors
    }
    throw new Error(message)
  }

  const blob = await response.blob()
  const fileName = resolveFilename(response.headers.get('content-disposition'))
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = fileName
  document.body.appendChild(link)
  link.click()
  link.remove()
  URL.revokeObjectURL(url)
}
