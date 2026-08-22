/**
 * 用户管理相关 API
 */

import type {
  AdminClientDeviceListResponse,
  AdminUserSessionListResponse,
  AuditExportRequest,
  DirtyUserCleanupByPhoneRequest,
  DirtyUserCleanupResponse,
  IntentUserListQuery,
  IntentUserListResponse,
  SensitiveActionPayload,
  UserBatchMutationResponse,
  UserDetailResponse,
  UserListQuery,
  UserListResponse,
  UserMutationResponse,
  UserOrganizationListResponse,
  UserRechargeRequest,
  UserRechargeResponse,
  UserRole,
  UserStatus,
  UserWalletTransactionsQuery,
  UserWalletTransactionsResponse,
} from '@/types/user'
import { rawJson } from './raw-json'
import { getApiClient } from './tabtin-client'

export async function getUsers(params: UserListQuery = {}): Promise<UserListResponse> {
  return getApiClient().raw<UserListResponse>('GET', '/auth/admin/users', {
    params: {
      keyword: params.keyword,
      status: params.status,
      page: params.page,
      page_size: params.page_size,
    },
  })
}

export async function getIntentUsers(
  params: IntentUserListQuery = {}
): Promise<IntentUserListResponse> {
  return getApiClient().raw<IntentUserListResponse>('GET', '/auth/admin/intent-users', {
    params: {
      keyword: params.keyword,
      page: params.page,
      page_size: params.page_size,
    },
  })
}

export async function getUserDetail(id: string): Promise<UserDetailResponse> {
  return getApiClient().raw<UserDetailResponse>('GET', `/auth/admin/users/${id}`)
}

export async function getUserOrganizations(
  userId: string,
  params: { page?: number; page_size?: number } = {}
): Promise<UserOrganizationListResponse> {
  return getApiClient().raw<UserOrganizationListResponse>(
    'GET',
    `/auth/admin/users/${userId}/organizations`,
    {
      params: {
        page: params.page,
        page_size: params.page_size,
      },
    }
  )
}

export async function updateUserStatus(
  id: string,
  status: UserStatus,
  reason: string,
  ticketId = ''
): Promise<UserMutationResponse> {
  return rawJson<UserMutationResponse>('PUT', `/auth/admin/users/${id}/status`, {
    status,
    reason,
    ticket_id: ticketId,
  })
}

/** @deprecated Use admin-accounts API instead. */
export async function updateUserRole(id: string, role: UserRole): Promise<UserMutationResponse> {
  return rawJson<UserMutationResponse>('PUT', `/auth/admin/users/${id}/role`, { role })
}

export async function batchUpdateUserStatus(
  userIds: string[],
  status: UserStatus,
  reason: string,
  ticketId = ''
): Promise<UserBatchMutationResponse> {
  return rawJson<UserBatchMutationResponse>('POST', '/auth/admin/batch/users/status', {
    user_ids: userIds,
    status,
    reason,
    ticket_id: ticketId,
  })
}

/** @deprecated Use admin-accounts API instead. */
export async function batchUpdateUserRole(
  userIds: string[],
  role: UserRole
): Promise<UserBatchMutationResponse> {
  return rawJson<UserBatchMutationResponse>('POST', '/auth/admin/batch/users/role', {
    user_ids: userIds,
    role,
  })
}

export async function exportAuditLogs(payload: AuditExportRequest): Promise<Blob> {
  const response = await getApiClient().raw<Response>('POST', '/auth/admin/audit/export', {
    body: payload,
    rawResponse: true,
  })
  return response.blob()
}

export async function getUserWalletTransactions(
  userId: string,
  params: UserWalletTransactionsQuery = {}
): Promise<UserWalletTransactionsResponse> {
  return getApiClient().raw<UserWalletTransactionsResponse>(
    'GET',
    `/auth/admin/users/${userId}/wallet/transactions`,
    {
      params: {
        transaction_type: params.transaction_type,
        page: params.page,
        page_size: params.page_size,
      },
    }
  )
}

export async function rechargeUserWallet(
  userId: string,
  data: UserRechargeRequest
): Promise<UserRechargeResponse> {
  return rawJson<UserRechargeResponse>('POST', `/auth/admin/users/${userId}/wallet/recharge`, data)
}

export async function cleanupDirtyUserByPhone(
  data: DirtyUserCleanupByPhoneRequest
): Promise<DirtyUserCleanupResponse> {
  return rawJson<DirtyUserCleanupResponse>('POST', '/auth/admin/dev/users/cleanup-by-phone', data)
}

export async function getUserDevices(userId: string): Promise<AdminClientDeviceListResponse> {
  return getApiClient().raw<AdminClientDeviceListResponse>(
    'GET',
    `/auth/admin/users/${userId}/devices`
  )
}

export async function getUserSessions(userId: string): Promise<AdminUserSessionListResponse> {
  return getApiClient().raw<AdminUserSessionListResponse>(
    'GET',
    `/auth/admin/users/${userId}/sessions`
  )
}

export async function blockClientDevice(deviceId: string, payload: SensitiveActionPayload) {
  return rawJson('POST', `/auth/admin/devices/${deviceId}/block`, payload)
}

export async function unblockClientDevice(deviceId: string, payload: SensitiveActionPayload) {
  return rawJson('POST', `/auth/admin/devices/${deviceId}/unblock`, payload)
}

export async function blockAllUserDevices(userId: string, payload: SensitiveActionPayload) {
  return rawJson('POST', `/auth/admin/users/${userId}/devices/block-all`, payload)
}

export async function revokeUserSession(sessionId: string, payload: SensitiveActionPayload) {
  return rawJson('POST', `/auth/admin/sessions/${sessionId}/revoke`, payload)
}

export async function revokeAllUserSessions(userId: string, payload: SensitiveActionPayload) {
  return rawJson('POST', `/auth/admin/users/${userId}/sessions/revoke-all`, payload)
}
