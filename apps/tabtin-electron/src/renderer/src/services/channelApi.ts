/**
 * Channel Gateway API service.
 */

import { apiClient } from './apiClient'

export interface ChannelAccountPayload {
  channel: string
  account_id?: string
  organization_id: string
  name?: string
  enabled?: boolean
  config?: Record<string, unknown>
}

export interface ChannelAccountResponse {
  id: string
  channel: string
  account_id: string
  organization_id: string
  name: string | null
  enabled: boolean
  config: Record<string, unknown>
  created_at: string
  updated_at: string
}

export interface ChannelRuntimeStatusResponse {
  id: string
  channel: string
  account_id: string
  organization_id: string
  status: string
  last_error: string | null
  qr: string | null
  details: Record<string, unknown>
  updated_at: string
}

const BASE = '/channel'

export const channelApi = {
  async listAccounts(organizationId: string, channel?: string): Promise<ChannelAccountResponse[]> {
    const params: Record<string, string> = { organization_id: organizationId }
    if (channel) params.channel = channel
    const { data } = await apiClient.get(`${BASE}/accounts`, { params })
    return data?.items ?? data ?? []
  },

  async createAccount(payload: ChannelAccountPayload): Promise<ChannelAccountResponse> {
    const { data } = await apiClient.post(`${BASE}/accounts`, payload)
    return data
  },

  async updateAccount(
    accountId: string,
    payload: Partial<ChannelAccountPayload>,
  ): Promise<ChannelAccountResponse> {
    const { data } = await apiClient.patch(`${BASE}/accounts/${accountId}`, payload)
    return data
  },

  async deleteAccount(accountId: string): Promise<void> {
    await apiClient.delete(`${BASE}/accounts/${accountId}`)
  },

  async listRuntimeStatus(organizationId: string): Promise<ChannelRuntimeStatusResponse[]> {
    const { data } = await apiClient.get(`${BASE}/runtime/status`, {
      params: { organization_id: organizationId },
    })
    return data?.items ?? data ?? []
  },

  async startWeixinQrLogin(accountId: string, organizationId: string): Promise<ChannelRuntimeStatusResponse> {
    const { data } = await apiClient.post(`${BASE}/weixin/qr-login/start`, {
      account_id: accountId,
      organization_id: organizationId,
    })
    return data
  },

  async pollWeixinQrStatus(accountId: string, organizationId: string): Promise<ChannelRuntimeStatusResponse> {
    const { data } = await apiClient.post(`${BASE}/weixin/qr-login/status`, {
      account_id: accountId,
      organization_id: organizationId,
    })
    return data
  },

  async refreshWeixinQrCode(accountId: string, organizationId: string): Promise<ChannelRuntimeStatusResponse> {
    const { data } = await apiClient.post(`${BASE}/weixin/qr-login/refresh`, {
      account_id: accountId,
      organization_id: organizationId,
    })
    return data
  },
}
