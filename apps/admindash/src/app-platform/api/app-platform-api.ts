import { getApiClient } from '@/api/tabtin-client'
import type {
  AppAuthorizationListResponse,
  AppInstallListResponse,
  CliAuditListResponse,
  ConnectAuditTimelineResponse,
  ConnectListResponse,
  PermissionAuditListResponse,
} from '../types'

const BASE = '/auth/admin'

export const appPlatformApi = {
  async listAppInstalls(params: {
    organization_id?: string
    device_id?: string
    app_id?: string
    page?: number
    page_size?: number
  }): Promise<AppInstallListResponse> {
    return getApiClient().raw<AppInstallListResponse>('GET', `${BASE}/app-installs`, { params })
  },

  async listCliAudit(params: {
    organization_id?: string
    user_id?: string
    binary?: string
    inner_binary?: string
    risk_level?: string
    hitl_user_decision?: string
    domain?: string
    page?: number
    page_size?: number
  }): Promise<CliAuditListResponse> {
    return getApiClient().raw<CliAuditListResponse>('GET', `${BASE}/cli-audit`, { params })
  },

  getCliAuditExportUrl(params: Record<string, string>): string {
    const qs = new URLSearchParams(params).toString()
    return `/api${BASE}/cli-audit/export?${qs}`
  },

  async listPermissionAudit(params: {
    organization_id?: string
    agent_id?: string
    thread_id?: string
    decision?: string
    source?: string
    page?: number
    page_size?: number
  }): Promise<PermissionAuditListResponse> {
    return getApiClient().raw<PermissionAuditListResponse>('GET', `${BASE}/permission-audit`, {
      params,
    })
  },

  async listAppAuthorization(params: {
    organization_id?: string
    space_id?: string
    user_id?: string
    page?: number
    page_size?: number
  }): Promise<AppAuthorizationListResponse> {
    return getApiClient().raw<AppAuthorizationListResponse>('GET', `${BASE}/app-authorization`, {
      params,
    })
  },

  async updateAuthorization(
    settingId: string,
    data: { allow_all?: boolean; tools?: string[]; apps?: string[] }
  ): Promise<{ success: boolean; data: Record<string, unknown> }> {
    return getApiClient().raw('POST', `${BASE}/app-authorization/${settingId}/update`, {
      body: data,
    })
  },

  /**
   * @deprecated TODO: Connect 后端管理接口未挂载，当前仅保留类型兼容。
   */
  async listConnects(params: {
    organization_id?: string
    user_id?: string
    app_id?: string
    status?: string
    page?: number
    page_size?: number
  }): Promise<ConnectListResponse> {
    return getApiClient().raw<ConnectListResponse>('GET', `${BASE}/connects`, { params })
  },

  /**
   * @deprecated TODO: Connect 审计接口缺失，禁止在页面链路中调用。
   */
  async getConnectAuditTimeline(connectId: string): Promise<ConnectAuditTimelineResponse> {
    return getApiClient().raw<ConnectAuditTimelineResponse>(
      'GET',
      `${BASE}/connects/${connectId}/audit-timeline`
    )
  },

  /**
   * @deprecated TODO: Connect 单个撤销接口缺失，禁止在页面链路中调用。
   */
  async revokeConnect(
    connectId: string,
    reason: string,
    ticketId = ''
  ): Promise<{ success: boolean }> {
    return getApiClient().raw('DELETE', `${BASE}/connects/${connectId}`, {
      params: { reason, ticket_id: ticketId || undefined },
    })
  },

  /**
   * @deprecated TODO: Connect 批量撤销接口缺失，禁止在页面链路中调用。
   */
  async adminBulkRevokeByUser(
    targetUserId: string,
    organizationId: string,
    appId?: string
  ): Promise<{ revoked_count: number; affected_connect_ids: string[] }> {
    const params: Record<string, string> = { organization_id: organizationId }
    if (appId) params.app_id = appId
    return getApiClient().raw('POST', `${BASE}/connects/admin/revoke-by-user/${targetUserId}`, {
      params,
    })
  },
}
