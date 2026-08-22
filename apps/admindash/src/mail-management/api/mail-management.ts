import { getApiClient } from '@/api/tabtin-client'
import { rawJson } from '@/api/raw-json'
import type {
  AdminMailBatchActionResponse,
  AdminMailDetailResponse,
  AdminMailListResponse,
  AdminMailOperationDetailResponse,
  AdminMailOperationsQuery,
  AdminMailOperationsResponse,
  AdminMailQuery,
  AdminMailSingleActionResponse,
} from '@/mail-management/types'

interface MailSensitiveActionPayload {
  reason: string
  ticket_id?: string
}

export async function getAdminMailAccounts(
  params: AdminMailQuery = {}
): Promise<AdminMailListResponse> {
  const query = new URLSearchParams()
  if (params.keyword) query.set('keyword', params.keyword)
  if (params.provider) query.set('provider', params.provider)
  if (params.sync_status) query.set('sync_status', params.sync_status)
  if (params.is_active) query.set('is_active', params.is_active)
  if (params.attention) query.set('attention', params.attention)
  if (params.organization_id) query.set('organization_id', params.organization_id)
  if (params.organization_query) query.set('organization_query', params.organization_query)
  if (params.space_id) query.set('space_id', params.space_id)
  if (params.space_query) query.set('space_query', params.space_query)
  if (params.page) query.set('page', String(params.page))
  if (params.page_size) query.set('page_size', String(params.page_size))

  const suffix = query.toString() ? `?${query.toString()}` : ''
  return getApiClient().raw<AdminMailListResponse>('GET', `/auth/admin/mail/accounts${suffix}`)
}

export async function getAdminMailAccountDetail(
  accountId: string
): Promise<AdminMailDetailResponse> {
  return getApiClient().raw<AdminMailDetailResponse>(
    'GET',
    `/auth/admin/mail/accounts/${accountId}`
  )
}

export async function syncAdminMailAccount(
  accountId: string,
  payload: MailSensitiveActionPayload
): Promise<AdminMailSingleActionResponse> {
  return rawJson<AdminMailSingleActionResponse>(
    'POST',
    `/auth/admin/mail/accounts/${accountId}/sync`,
    {
      reason: payload.reason,
      ticket_id: payload.ticket_id ?? '',
    }
  )
}

export async function updateAdminMailAccountStatus(
  accountId: string,
  isActive: boolean,
  payload: MailSensitiveActionPayload
): Promise<AdminMailSingleActionResponse> {
  return rawJson<AdminMailSingleActionResponse>(
    'PUT',
    `/auth/admin/mail/accounts/${accountId}/status`,
    {
      is_active: isActive,
      reason: payload.reason,
      ticket_id: payload.ticket_id ?? '',
    }
  )
}

export async function getAdminMailOperations(
  params: AdminMailOperationsQuery = {}
): Promise<AdminMailOperationsResponse> {
  const query = new URLSearchParams()
  if (params.action_type) query.set('action_type', params.action_type)
  if (params.success !== undefined) query.set('success', String(params.success))
  if (params.keyword) query.set('keyword', params.keyword)
  if (params.account_id) query.set('account_id', params.account_id)
  if (params.operation_id) query.set('operation_id', params.operation_id)
  if (params.page) query.set('page', String(params.page))
  if (params.page_size) query.set('page_size', String(params.page_size))

  const suffix = query.toString() ? `?${query.toString()}` : ''
  return getApiClient().raw<AdminMailOperationsResponse>(
    'GET',
    `/auth/admin/mail/accounts/operations${suffix}`
  )
}

export async function getAdminMailOperationDetail(
  operationId: string
): Promise<AdminMailOperationDetailResponse> {
  return getApiClient().raw<AdminMailOperationDetailResponse>(
    'GET',
    `/auth/admin/mail/accounts/operations/${operationId}`
  )
}

export async function batchSyncAdminMailAccounts(
  accountIds: string[],
  payload: MailSensitiveActionPayload
): Promise<AdminMailBatchActionResponse> {
  return rawJson<AdminMailBatchActionResponse>(
    'POST',
    '/auth/admin/mail/accounts/batch-sync',
    { account_ids: accountIds, reason: payload.reason, ticket_id: payload.ticket_id ?? '' }
  )
}

export async function batchUpdateAdminMailAccountStatus(
  accountIds: string[],
  isActive: boolean,
  payload: MailSensitiveActionPayload
): Promise<AdminMailBatchActionResponse> {
  return rawJson<AdminMailBatchActionResponse>(
    'PUT',
    '/auth/admin/mail/accounts/batch-status',
    {
      account_ids: accountIds,
      is_active: isActive,
      reason: payload.reason,
      ticket_id: payload.ticket_id ?? '',
    }
  )
}
