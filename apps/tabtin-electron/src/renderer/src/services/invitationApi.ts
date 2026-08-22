/**
 * 组织邀请 API 服务
 */
import { joinApiPath } from '@tabtin/config'
import { API_CONFIG, API_ENDPOINTS } from '@/config/api'
import { apiRequest as adapterApiRequest, getAuthToken } from '@/adapters/api-adapter-instance'
import type { AssignableRole } from '@tabtin/app-shell'
import i18n from '@/i18n'

async function getAuthHeaders(): Promise<Record<string, string>> {
  try {
    const token = await getAuthToken()
    return token ? { Authorization: `Bearer ${token}` } : {}
  } catch {
    return {}
  }
}

async function apiRequest(options: {
  url: string
  method: 'GET' | 'POST' | 'PUT' | 'DELETE'
  headers?: Record<string, string>
  body?: string
}): Promise<any> {
  const authHeaders = await getAuthHeaders()
  return adapterApiRequest({
    ...options,
    headers: { ...authHeaders, ...options.headers },
  })
}

export interface InvitationInfo {
  id: string
  organization_id: string
  invited_by: string
  invite_type: 'email' | 'link' | 'direct' | 'phone'
  email?: string
  invited_user_id?: string
  invite_phone?: string
  /** 定向邀请时后端附带的被邀请人展示名 */
  invited_user_nickname?: string
  /** Owner 的待处理直接邀请：后端按权限返回受邀人的可读身份。 */
  invited_user_phone?: string
  role: AssignableRole
  token: string
  status: string
  expires_at: string
  max_uses: number
  use_count: number
  created_at: string
}

export type PendingInvitationSummary = {
  /** 主文案：有昵称时用昵称，否则用渠道标识 */
  title: string
  /** 副文案：有昵称时保留手机号 / 用户id 渠道标识 */
  detail?: string
}

/** 待处理定向邀请列表文案：昵称 + 手机号/用户id 标识。 */
export const resolvePendingInvitationSummary = (
  inv: Pick<
    InvitationInfo,
    | 'invite_type'
    | 'invite_phone'
    | 'invited_user_id'
    | 'invited_user_nickname'
    | 'invited_user_phone'
    | 'email'
  >,
  t: (key: string, options?: Record<string, unknown>) => string,
): PendingInvitationSummary => {
  const nickname = (inv.invited_user_nickname || '').trim()
  if (inv.invite_type === 'phone') {
    const phoneLabel = t('members.phoneInvitation', {
      phone: inv.invite_phone || inv.invited_user_id || '',
    })
    return nickname ? { title: nickname, detail: phoneLabel } : { title: phoneLabel }
  }
  if (inv.invite_type === 'direct') {
    const userIdLabel = t('members.directInvitation', {
      userId: inv.invited_user_id || '',
    })
    if (nickname) {
      return { title: nickname, detail: userIdLabel }
    }
    const phone = (inv.invited_user_phone || '').trim()
    if (phone) {
      return { title: phone, detail: userIdLabel }
    }
    if (inv.invited_user_id) {
      return { title: userIdLabel }
    }
    return { title: t('members.directInvitationUnavailable') }
  }
  return { title: inv.email || t('members.linkInvitation') }
}

export interface InvitationPreview {
  valid: boolean
  status: string
  organization_id?: string
  organization_name?: string
  organization_icon?: string
  role?: AssignableRole
  invite_type?: string
  expires_at?: string
}

export interface PendingInvitation {
  id: string
  organization_id: string
  organization_name: string
  organization_icon: string
  invited_by: string
  invited_by_name: string
  role: AssignableRole
  status: string
  expires_at: string
  created_at: string
}

export class InvitationApiService {
  static async createEmailInvitation(
    organizationId: string,
    email: string,
    role: AssignableRole = 'editor',
    expiresHours: number = 72,
  ): Promise<InvitationInfo> {
    const url = joinApiPath(API_CONFIG.baseURL, `${API_ENDPOINTS.ORGANIZATION_INVITATION.CREATE_EMAIL(organizationId)}`)
    const response = await apiRequest({
      url,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, role, expires_hours: expiresHours }),
    })
    if (!response?.data?.success) throw new Error(response?.data?.message || i18n.t('organization:invitation.errors.sendFailed'))
    return response.data.data
  }

  static async createLinkInvitation(
    organizationId: string,
    role: AssignableRole = 'editor',
    maxUses: number = -1,
    expiresHours: number = 168,
  ): Promise<InvitationInfo> {
    const url = joinApiPath(API_CONFIG.baseURL, `${API_ENDPOINTS.ORGANIZATION_INVITATION.CREATE_LINK(organizationId)}`)
    const response = await apiRequest({
      url,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role, max_uses: maxUses, expires_hours: expiresHours }),
    })
    if (!response?.data?.success) throw new Error(response?.data?.message || i18n.t('organization:invitation.errors.createLinkFailed'))
    return response.data.data
  }

  static async listInvitations(organizationId: string): Promise<InvitationInfo[]> {
    const url = joinApiPath(API_CONFIG.baseURL, `${API_ENDPOINTS.ORGANIZATION_INVITATION.LIST(organizationId)}`)
    const response = await apiRequest({ url, method: 'GET' })
    if (!response?.data?.success) throw new Error(response?.data?.message || i18n.t('organization:invitation.errors.listFailed'))
    return response.data.data?.invitations || []
  }

  static async cancelInvitation(organizationId: string, invitationId: string): Promise<void> {
    const url = joinApiPath(API_CONFIG.baseURL, `${API_ENDPOINTS.ORGANIZATION_INVITATION.CANCEL(organizationId, invitationId)}`)
    const response = await apiRequest({ url, method: 'DELETE' })
    if (!response?.data?.success) throw new Error(response?.data?.message || i18n.t('organization:invitation.errors.cancelFailed'))
  }

  static async getInvitationInfo(token: string): Promise<InvitationPreview> {
    const url = joinApiPath(API_CONFIG.baseURL, `${API_ENDPOINTS.ORGANIZATION_INVITATION.INFO(token)}`)
    const response = await apiRequest({ url, method: 'GET' })
    if (!response?.data?.success) throw new Error(response?.data?.message || i18n.t('organization:invitation.errors.notFound'))
    return response.data.data
  }

  static async acceptInvitation(token: string): Promise<{ organization_id: string; organization_name: string; role: string }> {
    const url = joinApiPath(API_CONFIG.baseURL, `${API_ENDPOINTS.ORGANIZATION_INVITATION.ACCEPT(token)}`)
    const response = await apiRequest({ url, method: 'POST' })
    if (!response?.data?.success) throw new Error(response?.data?.message || i18n.t('organization:invitation.errors.acceptFailed'))
    return response.data.data
  }

  static async createDirectInvitation(
    organizationId: string,
    userId: string,
    role: AssignableRole = 'editor',
    expiresHours: number = 72,
  ): Promise<InvitationInfo> {
    const url = joinApiPath(API_CONFIG.baseURL, `${API_ENDPOINTS.ORGANIZATION_INVITATION.CREATE_DIRECT(organizationId)}`)
    const response = await apiRequest({
      url,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_id: userId, role, expires_hours: expiresHours }),
    })
    if (!response?.data?.success) throw new Error(response?.data?.message || i18n.t('organization:invitation.errors.sendFailed'))
    return response.data.data
  }

  static async createPhoneInvitation(
    organizationId: string,
    phone: string,
    role: AssignableRole = 'editor',
    expiresHours: number = 72,
  ): Promise<InvitationInfo> {
    const url = joinApiPath(API_CONFIG.baseURL, `${API_ENDPOINTS.ORGANIZATION_INVITATION.CREATE_PHONE(organizationId)}`)
    const response = await apiRequest({
      url,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone, role, expires_hours: expiresHours }),
    })
    if (!response?.data?.success) throw new Error(response?.data?.message || i18n.t('organization:invitation.errors.sendFailed'))
    return response.data.data
  }

  static async listMyPendingInvitations(): Promise<PendingInvitation[]> {
    const url = joinApiPath(API_CONFIG.baseURL, `${API_ENDPOINTS.ORGANIZATION_INVITATION.MY_PENDING}`)
    const response = await apiRequest({ url, method: 'GET' })
    if (!response?.data?.success) throw new Error(response?.data?.message || i18n.t('organization:invitation.errors.listFailed'))
    return response.data.data?.invitations || []
  }

  static async respondToInvitation(
    invitationId: string,
    accept: boolean,
  ): Promise<{ organization_id: string; organization_name: string; status: string; role?: string }> {
    const url = joinApiPath(API_CONFIG.baseURL, `${API_ENDPOINTS.ORGANIZATION_INVITATION.RESPOND(invitationId)}`)
    const response = await apiRequest({
      url,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accept }),
    })
    if (!response?.data?.success) throw new Error(response?.data?.message || i18n.t('organization:invitation.errors.respondFailed'))
    return response.data.data
  }
}
