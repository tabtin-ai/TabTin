import type {
  AdminActionLogListData,
  OrganizationCashPurchasePayload,
  OrganizationCashRechargePayload,
  OrganizationCashWalletData,
  OrganizationControlPolicy,
  OrganizationControlPolicyPatch,
  OrganizationEntitlementsData,
  OrganizationInvitationItem,
  OrganizationListData,
  OrganizationMemberListData,
  OrganizationMemberUsageData,
  OrganizationQuotaGrantPayload,
  OrganizationQuotaGrantResult,
  OrganizationResourceListData,
  OrganizationSummary,
  OrganizationWalletData,
  OrganizationWalletRechargeResult,
  OrganizationWalletTransactionsData,
  SpaceAppSettingsData,
  SpaceListData,
  SpaceStats,
  SpaceSummary,
} from '@/types/space-admin'
import { getApiClient } from './tabtin-client'

export interface ListOrganizationParams {
  search?: string
  ownerId?: string
  ownerKeyword?: string
  isDefault?: boolean
  sort?: string
  page?: number
  pageSize?: number
}

export interface ListSpaceParams {
  organizationId?: string
  keyword?: string
  status?: string
  isArchived?: boolean
  page?: number
  pageSize?: number
}

export interface ListOrganizationResourceParams {
  itemType?: string
  keyword?: string
  spaceId?: string
  createdBy?: string
  includeArchived?: boolean
  page?: number
  pageSize?: number
}

export interface ListAuditLogParams {
  actionType?: string
  targetType?: string
  operatorId?: string
  operatorKeyword?: string
  startAt?: string
  endAt?: string
  success?: boolean
  page?: number
  pageSize?: number
}

export interface ListOrganizationMemberParams {
  page?: number
  pageSize?: number
}

export interface SpaceDeleteParams {
  dryRun?: boolean
  force?: boolean
}

export interface SpaceDeleteResult {
  dry_run?: boolean
  space_id: string
  force?: boolean
  impact?: Record<string, number>
}

export interface CreateOrganizationPayload {
  name: string
  description?: string
  icon?: string
  settings?: Record<string, unknown>
}

export interface UpdateOrganizationPayload {
  name?: string
  description?: string
  icon?: string
  settings?: Record<string, unknown>
  reason: string
  ticket_id?: string
}

export interface OrganizationDeleteParams {
  dryRun?: boolean
  force?: boolean
  reason?: string
  ticket_id?: string
}

export interface TransferOrganizationOwnershipPayload {
  new_owner_user_id: string
  reason: string
  ticket_id?: string
}

export interface OrganizationDeleteResult {
  dry_run?: boolean
  organization_id: string
  force?: boolean
  impact?: Record<string, number>
}

export const spaceAdminApi = {
  async listOrganizations(params: ListOrganizationParams = {}): Promise<OrganizationListData> {
    const queryParams: Record<string, string | number | boolean> = {}
    if (params.search?.trim()) queryParams.keyword = params.search.trim()
    if (params.ownerId?.trim()) queryParams.owner_id = params.ownerId.trim()
    if (params.ownerKeyword?.trim()) queryParams.owner_keyword = params.ownerKeyword.trim()
    if (params.isDefault !== undefined) queryParams.is_default = params.isDefault
    if (params.sort?.trim()) queryParams.sort = params.sort.trim()
    if (params.page !== undefined) queryParams.page = params.page
    if (params.pageSize !== undefined) queryParams.page_size = params.pageSize

    return getApiClient().raw<OrganizationListData>('GET', '/auth/admin/organizations', {
      params: queryParams,
    })
  },

  async getOrganization(organizationId: string): Promise<OrganizationSummary> {
    return getApiClient().raw<OrganizationSummary>(
      'GET',
      `/auth/admin/organizations/${organizationId}`
    )
  },

  async getOrganizationControlPolicy(organizationId: string): Promise<OrganizationControlPolicy> {
    return getApiClient().raw<OrganizationControlPolicy>(
      'GET',
      `/auth/admin/organizations/${organizationId}/control-policy`
    )
  },

  async updateOrganizationControlPolicy(
    organizationId: string,
    data: OrganizationControlPolicyPatch
  ): Promise<OrganizationControlPolicy> {
    return getApiClient().raw<OrganizationControlPolicy>(
      'PATCH',
      `/auth/admin/organizations/${organizationId}/control-policy`,
      { body: data }
    )
  },

  async listOrganizationMembers(
    organizationId: string,
    params: ListOrganizationMemberParams = {}
  ): Promise<OrganizationMemberListData> {
    const queryParams: Record<string, string | number> = {}
    if (params.page !== undefined) queryParams.page = params.page
    if (params.pageSize !== undefined) queryParams.page_size = params.pageSize

    return getApiClient().raw<OrganizationMemberListData>(
      'GET',
      `/auth/admin/organizations/${organizationId}/members`,
      { params: queryParams }
    )
  },

  async createOrganization(data: CreateOrganizationPayload): Promise<OrganizationSummary> {
    return getApiClient().raw<OrganizationSummary>('POST', '/auth/admin/organizations', {
      body: data,
    })
  },

  async updateOrganization(
    organizationId: string,
    data: UpdateOrganizationPayload
  ): Promise<OrganizationSummary> {
    return getApiClient().raw<OrganizationSummary>(
      'PUT',
      `/auth/admin/organizations/${organizationId}`,
      {
        body: data,
      }
    )
  },

  async deleteOrganization(
    organizationId: string,
    params: OrganizationDeleteParams = {}
  ): Promise<OrganizationDeleteResult> {
    return getApiClient().raw<OrganizationDeleteResult>(
      'POST',
      `/auth/admin/organizations/${organizationId}/delete`,
      {
        body: {
          dry_run: params.dryRun ?? false,
          force: params.force ?? false,
          reason: params.reason ?? '',
          ticket_id: params.ticket_id ?? '',
        },
      }
    )
  },

  async transferOrganizationOwnership(
    organizationId: string,
    data: TransferOrganizationOwnershipPayload
  ): Promise<OrganizationSummary> {
    return getApiClient().raw<OrganizationSummary>(
      'POST',
      `/auth/admin/organizations/${organizationId}/transfer-ownership`,
      {
        body: {
          new_owner_user_id: data.new_owner_user_id,
          reason: data.reason,
          ticket_id: data.ticket_id ?? '',
        },
      }
    )
  },

  async listSpaces(params: ListSpaceParams = {}): Promise<SpaceListData> {
    const queryParams: Record<string, string | number | boolean> = {}
    if (params.organizationId?.trim()) queryParams.organization_id = params.organizationId.trim()
    if (params.keyword?.trim()) queryParams.keyword = params.keyword.trim()
    if (params.status?.trim()) queryParams.status = params.status.trim()
    if (params.isArchived !== undefined) queryParams.is_archived = params.isArchived
    if (params.page !== undefined) queryParams.page = params.page
    if (params.pageSize !== undefined) queryParams.page_size = params.pageSize

    return getApiClient().raw<SpaceListData>('GET', '/auth/admin/spaces', {
      params: queryParams,
    })
  },

  async listOrganizationResources(
    organizationId: string,
    params: ListOrganizationResourceParams = {}
  ): Promise<OrganizationResourceListData> {
    const queryParams: Record<string, string | number | boolean> = {}
    if (params.itemType?.trim()) queryParams.item_type = params.itemType.trim()
    if (params.keyword?.trim()) queryParams.keyword = params.keyword.trim()
    if (params.spaceId?.trim()) queryParams.space_id = params.spaceId.trim()
    if (params.createdBy?.trim()) queryParams.created_by = params.createdBy.trim()
    if (params.includeArchived !== undefined) queryParams.include_archived = params.includeArchived
    queryParams.page = params.page ?? 1
    queryParams.page_size = params.pageSize ?? 50

    return getApiClient().raw<OrganizationResourceListData>(
      'GET',
      `/auth/admin/organizations/${organizationId}/resources`,
      { params: queryParams }
    )
  },

  async getSpace(spaceId: string): Promise<SpaceSummary> {
    return getApiClient().raw<SpaceSummary>('GET', `/auth/admin/spaces/${spaceId}`)
  },

  async getSpaceStats(spaceId: string): Promise<SpaceStats> {
    return getApiClient().raw<SpaceStats>('GET', `/auth/admin/spaces/${spaceId}/stats`)
  },

  async getSpaceAppSettings(spaceId: string): Promise<SpaceAppSettingsData> {
    return getApiClient().raw<SpaceAppSettingsData>('GET', `/auth/admin/spaces/${spaceId}/apps`)
  },

  async listOrganizationAuditLogs(
    organizationId: string,
    params: ListAuditLogParams = {}
  ): Promise<AdminActionLogListData> {
    const queryParams: Record<string, string | number | boolean> = {}
    if (params.actionType?.trim()) queryParams.action_type = params.actionType.trim()
    if (params.targetType?.trim()) queryParams.target_type = params.targetType.trim()
    if (params.operatorId?.trim()) queryParams.operator_id = params.operatorId.trim()
    if (params.operatorKeyword?.trim()) queryParams.operator_keyword = params.operatorKeyword.trim()
    if (params.startAt?.trim()) queryParams.start_at = params.startAt.trim()
    if (params.endAt?.trim()) queryParams.end_at = params.endAt.trim()
    if (params.success !== undefined) queryParams.success = params.success
    if (params.page !== undefined) queryParams.page = params.page
    if (params.pageSize !== undefined) queryParams.page_size = params.pageSize

    return getApiClient().raw<AdminActionLogListData>(
      'GET',
      `/auth/admin/organizations/${organizationId}/audit-logs`,
      { params: queryParams }
    )
  },

  async listSpaceAuditLogs(
    spaceId: string,
    params: ListAuditLogParams = {}
  ): Promise<AdminActionLogListData> {
    const queryParams: Record<string, string | number | boolean> = {}
    if (params.actionType?.trim()) queryParams.action_type = params.actionType.trim()
    if (params.success !== undefined) queryParams.success = params.success
    if (params.page !== undefined) queryParams.page = params.page
    if (params.pageSize !== undefined) queryParams.page_size = params.pageSize

    return getApiClient().raw<AdminActionLogListData>(
      'GET',
      `/auth/admin/spaces/${spaceId}/audit-logs`,
      { params: queryParams }
    )
  },

  async updateSpace(spaceId: string, data: Partial<SpaceSummary>): Promise<SpaceSummary> {
    return getApiClient().raw<SpaceSummary>('PUT', `/auth/admin/spaces/${spaceId}`, {
      body: data,
    })
  },

  async archiveSpace(spaceId: string): Promise<void> {
    await getApiClient().raw('POST', `/auth/admin/spaces/${spaceId}/archive`)
  },

  async restoreSpace(spaceId: string): Promise<void> {
    await getApiClient().raw('POST', `/auth/admin/spaces/${spaceId}/restore`)
  },

  async deleteSpace(spaceId: string, params: SpaceDeleteParams = {}): Promise<SpaceDeleteResult> {
    return getApiClient().raw<SpaceDeleteResult>('POST', `/auth/admin/spaces/${spaceId}/delete`, {
      body: {
        dry_run: params.dryRun ?? false,
        force: params.force ?? false,
      },
    })
  },

  async getOrganizationWallet(organizationId: string): Promise<OrganizationWalletData> {
    return getApiClient().raw<OrganizationWalletData>(
      'GET',
      `/auth/admin/organizations/${organizationId}/wallet`
    )
  },

  async rechargeOrganizationWallet(
    organizationId: string,
    amount: number,
    description?: string
  ): Promise<OrganizationWalletRechargeResult> {
    return getApiClient().raw<OrganizationWalletRechargeResult>(
      'POST',
      `/auth/admin/organizations/${organizationId}/wallet/recharge`,
      {
        body: { amount, description: description || '管理员充值' },
      }
    )
  },

  async getOrganizationCashWallet(organizationId: string): Promise<OrganizationCashWalletData> {
    return getApiClient().raw<OrganizationCashWalletData>(
      'GET',
      `/auth/admin/organizations/${organizationId}/cash-wallet`
    )
  },

  async listOrganizationCashWalletTransactions(
    organizationId: string,
    params: { transactionType?: string; limit?: number; offset?: number } = {}
  ): Promise<{
    organization_id: string
    wallet: OrganizationCashWalletData['wallet']
    balance_cny: string
    frozen_cny: string
    available_cny: string
    total: number
    transactions: OrganizationCashWalletData['transactions']
  }> {
    const queryParams: Record<string, string | number> = {}
    if (params.transactionType?.trim()) queryParams.transaction_type = params.transactionType.trim()
    if (params.limit !== undefined) queryParams.limit = params.limit
    if (params.offset !== undefined) queryParams.offset = params.offset
    return getApiClient().raw(
      'GET',
      `/auth/admin/organizations/${organizationId}/cash-wallet/transactions`,
      { params: queryParams }
    )
  },

  async rechargeOrganizationCashWallet(
    organizationId: string,
    payload: OrganizationCashRechargePayload
  ): Promise<OrganizationCashWalletData> {
    return getApiClient().raw<OrganizationCashWalletData>(
      'POST',
      `/auth/admin/organizations/${organizationId}/cash-wallet/recharge`,
      { body: payload }
    )
  },

  async purchaseCreditPackageWithCashWallet(
    organizationId: string,
    payload: OrganizationCashPurchasePayload
  ): Promise<Record<string, unknown>> {
    return getApiClient().raw<Record<string, unknown>>(
      'POST',
      `/auth/admin/organizations/${organizationId}/cash-wallet/purchase-credit-package`,
      { body: payload }
    )
  },

  async purchaseAddonPackageWithCashWallet(
    organizationId: string,
    payload: OrganizationCashPurchasePayload
  ): Promise<Record<string, unknown>> {
    return getApiClient().raw<Record<string, unknown>>(
      'POST',
      `/auth/admin/organizations/${organizationId}/cash-wallet/purchase-addon-package`,
      { body: payload }
    )
  },

  async getOrganizationEntitlements(organizationId: string): Promise<OrganizationEntitlementsData> {
    return getApiClient().raw<OrganizationEntitlementsData>(
      'GET',
      `/auth/admin/organizations/${organizationId}/entitlements`
    )
  },

  async grantOrganizationQuota(
    organizationId: string,
    payload: OrganizationQuotaGrantPayload
  ): Promise<OrganizationQuotaGrantResult> {
    return getApiClient().raw<OrganizationQuotaGrantResult>(
      'POST',
      `/auth/admin/organizations/${organizationId}/entitlements/grant`,
      { body: payload }
    )
  },

  async getOrganizationMemberUsage(
    organizationId: string,
    days = 30
  ): Promise<OrganizationMemberUsageData> {
    return getApiClient().raw<OrganizationMemberUsageData>(
      'GET',
      `/auth/admin/organizations/${organizationId}/member-usage`,
      { params: { days } }
    )
  },

  async addOrganizationMember(
    organizationId: string,
    body: {
      user_id?: string
      phone?: string
      role?: 'editor'
      reason: string
      ticket_id?: string
    }
  ): Promise<{
    id: string
    organization_id: string
    user_id: string
    role: string
    joined_at?: string
  }> {
    return getApiClient().raw(
      'POST',
      `/auth/admin/organizations/${organizationId}/members`,
      { body }
    )
  },

  async updateOrganizationMemberRole(
    organizationId: string,
    userId: string,
    body: { role: 'admin' | 'editor' | 'viewer'; reason: string; ticket_id?: string }
  ): Promise<{ user_id: string; role: string }> {
    return getApiClient().raw(
      'PUT',
      `/auth/admin/organizations/${organizationId}/members/${userId}`,
      { body }
    )
  },

  async removeOrganizationMember(
    organizationId: string,
    userId: string,
    body: { reason: string; ticket_id?: string }
  ): Promise<{ user_id: string; removed: boolean }> {
    return getApiClient().raw(
      'POST',
      `/auth/admin/organizations/${organizationId}/members/${userId}/remove`,
      { body }
    )
  },

  async listOrganizationInvitations(organizationId: string): Promise<{
    invitations: OrganizationInvitationItem[]
    total: number
  }> {
    return getApiClient().raw('GET', `/auth/admin/organizations/${organizationId}/invitations`)
  },

  async createPhoneInvitation(
    organizationId: string,
    body: {
      phone: string
      role?: 'editor'
      expires_hours?: number
      reason: string
      ticket_id?: string
    }
  ): Promise<OrganizationInvitationItem> {
    return getApiClient().raw(
      'POST',
      `/auth/admin/organizations/${organizationId}/invitations/phone`,
      { body }
    )
  },

  async createLinkInvitation(
    organizationId: string,
    body: {
      role?: 'editor'
      max_uses?: number
      expires_hours?: number
      reason: string
      ticket_id?: string
    }
  ): Promise<OrganizationInvitationItem> {
    return getApiClient().raw(
      'POST',
      `/auth/admin/organizations/${organizationId}/invitations/link`,
      { body }
    )
  },

  async createDirectInvitation(
    organizationId: string,
    body: {
      user_id: string
      role?: 'editor'
      expires_hours?: number
      reason: string
      ticket_id?: string
    }
  ): Promise<OrganizationInvitationItem> {
    return getApiClient().raw(
      'POST',
      `/auth/admin/organizations/${organizationId}/invitations/direct`,
      { body }
    )
  },

  async cancelOrganizationInvitation(
    organizationId: string,
    invitationId: string,
    body: { reason: string; ticket_id?: string }
  ): Promise<{ invitation_id: string; cancelled: boolean }> {
    return getApiClient().raw(
      'POST',
      `/auth/admin/organizations/${organizationId}/invitations/${invitationId}/cancel`,
      { body }
    )
  },

  async listOrganizationWalletTransactions(
    organizationId: string,
    params: { transactionType?: string; page?: number; pageSize?: number } = {}
  ): Promise<OrganizationWalletTransactionsData> {
    const queryParams: Record<string, string | number> = {}
    if (params.transactionType?.trim()) queryParams.transaction_type = params.transactionType.trim()
    if (params.page !== undefined) queryParams.page = params.page
    if (params.pageSize !== undefined) queryParams.page_size = params.pageSize

    return getApiClient().raw<OrganizationWalletTransactionsData>(
      'GET',
      `/auth/admin/organizations/${organizationId}/wallet/transactions`,
      { params: queryParams }
    )
  },
}
