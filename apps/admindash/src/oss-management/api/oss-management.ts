import { rawJson } from '@/api/raw-json'
import { getApiClient } from '@/api/tabtin-client'
import type {
  AdminOssBatchDeleteResponse,
  AdminOssBatchRepairOrganizationResponse,
  AdminOssCostOverviewResponse,
  AdminOssCostQuery,
  AdminOssFileDetailResponse,
  AdminOssFileListResponse,
  AdminOssFileQuery,
  AdminOssOperationListResponse,
  AdminOssOperationQuery,
  AdminOssTaskListResponse,
  AdminOssTaskQuery,
} from '@/oss-management/types'

interface SensitiveActionPayload {
  reason: string
  ticket_id?: string
}

export async function getAdminOssFiles(
  params: AdminOssFileQuery = {}
): Promise<AdminOssFileListResponse> {
  const query = new URLSearchParams()
  if (params.keyword) {
    query.set('keyword', params.keyword)
  }
  if (params.file_type) {
    query.set('file_type', params.file_type)
  }
  if (params.status) {
    query.set('status', params.status)
  }
  if (params.upload_source) {
    query.set('upload_source', params.upload_source)
  }
  if (params.is_public !== undefined) {
    query.set('is_public', String(params.is_public))
  }
  if (params.orphan_only) {
    query.set('orphan_only', 'true')
  }
  if (params.unowned_only) {
    query.set('unowned_only', 'true')
  }
  if (params.repair_state && params.repair_state !== 'all') {
    query.set('repair_state', params.repair_state)
  }
  if (params.repair_reason_code && params.repair_reason_code !== 'all') {
    query.set('repair_reason_code', params.repair_reason_code)
  }
  if (params.organization_id) {
    query.set('organization_id', params.organization_id)
  }
  if (params.space_id) {
    query.set('space_id', params.space_id)
  }
  if (params.page) {
    query.set('page', String(params.page))
  }
  if (params.page_size) {
    query.set('page_size', String(params.page_size))
  }

  const suffix = query.toString() ? `?${query.toString()}` : ''
  return getApiClient().raw<AdminOssFileListResponse>('GET', `/auth/admin/oss/files${suffix}`)
}

export async function getAdminOssFileDetail(fileId: string): Promise<AdminOssFileDetailResponse> {
  return getApiClient().raw<AdminOssFileDetailResponse>('GET', `/auth/admin/oss/files/${fileId}`)
}

export async function getAdminOssTasks(
  params: AdminOssTaskQuery = {}
): Promise<AdminOssTaskListResponse> {
  const query = new URLSearchParams()
  if (params.task_type) {
    query.set('task_type', params.task_type)
  }
  if (params.status) {
    query.set('status', params.status)
  }
  if (params.keyword) {
    query.set('keyword', params.keyword)
  }
  if (params.created_by) {
    query.set('created_by', params.created_by)
  }
  if (params.organization_id) {
    query.set('organization_id', params.organization_id)
  }
  if (params.page) {
    query.set('page', String(params.page))
  }
  if (params.page_size) {
    query.set('page_size', String(params.page_size))
  }

  const suffix = query.toString() ? `?${query.toString()}` : ''
  return getApiClient().raw<AdminOssTaskListResponse>('GET', `/auth/admin/oss/tasks${suffix}`)
}

export async function getAdminOssOperations(
  params: AdminOssOperationQuery = {}
): Promise<AdminOssOperationListResponse> {
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
  if (params.file_id) {
    query.set('file_id', params.file_id)
  }
  if (params.operator_id) {
    query.set('operator_id', params.operator_id)
  }
  if (params.organization_id) {
    query.set('organization_id', params.organization_id)
  }
  if (params.page) {
    query.set('page', String(params.page))
  }
  if (params.page_size) {
    query.set('page_size', String(params.page_size))
  }

  const suffix = query.toString() ? `?${query.toString()}` : ''
  return getApiClient().raw<AdminOssOperationListResponse>(
    'GET',
    `/auth/admin/oss/operations${suffix}`
  )
}

export async function getAdminOssCosts(
  params: AdminOssCostQuery = {}
): Promise<AdminOssCostOverviewResponse> {
  const query = new URLSearchParams()
  if (params.organization_keyword) {
    query.set('organization_keyword', params.organization_keyword)
  }
  if (params.page) {
    query.set('page', String(params.page))
  }
  if (params.page_size) {
    query.set('page_size', String(params.page_size))
  }

  const suffix = query.toString() ? `?${query.toString()}` : ''
  return getApiClient().raw<AdminOssCostOverviewResponse>('GET', `/auth/admin/oss/costs${suffix}`)
}

export async function batchDeleteAdminOssFiles(
  fileIds: string[],
  options?: { dryRun?: boolean; sensitive?: SensitiveActionPayload }
): Promise<AdminOssBatchDeleteResponse> {
  return rawJson<AdminOssBatchDeleteResponse>('POST', '/auth/admin/oss/files/batch/delete', {
    file_ids: fileIds,
    dry_run: options?.dryRun ?? false,
    reason: options?.sensitive?.reason ?? '',
    ticket_id: options?.sensitive?.ticket_id ?? '',
  })
}

export async function repairAdminOssFileOrganizations(
  fileIds: string[],
  options?: { dryRun?: boolean; sensitive?: SensitiveActionPayload }
): Promise<AdminOssBatchRepairOrganizationResponse> {
  return rawJson<AdminOssBatchRepairOrganizationResponse>(
    'POST',
    '/auth/admin/oss/files/batch/repair-organization',
    {
      file_ids: fileIds,
      dry_run: options?.dryRun ?? false,
      reason: options?.sensitive?.reason ?? '',
      ticket_id: options?.sensitive?.ticket_id ?? '',
    }
  )
}
