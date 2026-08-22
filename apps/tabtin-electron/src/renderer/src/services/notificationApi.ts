/**
 * 通知 API 服务
 */
import { joinApiPath } from '@tabtin/config'
import { API_CONFIG, API_ENDPOINTS } from '@/config/api'
import { apiRequest as adapterApiRequest, getAuthToken } from '@/adapters/api-adapter-instance'
import type { NavigateTarget } from '../../../main/services/notification/types'
import type { NotificationCenterCategory } from './notificationCenterCatalog'

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

export type NotificationNavigateTarget = NavigateTarget

export interface NotificationItem {
  id: string
  type: string
  title: string
  body: string
  metadata: Record<string, unknown>
  organization_id: string
  space_id?: string
  priority?: string
  category?: string
  center_category?: NotificationCenterCategory | null
  source_extension_id?: string
  source_event_id?: string
  channels_delivered?: string[]
  navigate_to?: NotificationNavigateTarget
  is_read: boolean
  read_at: string | null
  created_at: string
}

export interface NotificationListFilters {
  status?: 'all' | 'unread'
  category?: string
  search?: string
  includePersonalInvitations?: boolean
  centerOnly?: boolean
}

function ensureSuccess(response: any, fallbackMessage: string): any {
  if (!response?.data?.success) {
    throw new Error(response?.data?.message || fallbackMessage)
  }
  return response.data
}

export class NotificationApiService {
  static async list(
    page = 1,
    limit = 20,
    organizationId?: string,
    filters: NotificationListFilters = {},
  ): Promise<{
    items: NotificationItem[]
    total: number
    page: number
    limit: number
  }> {
    let url = joinApiPath(API_CONFIG.baseURL, `${API_ENDPOINTS.NOTIFICATIONS.LIST}?page=${page}&limit=${limit}`)
    if (organizationId) url += `&organization_id=${encodeURIComponent(organizationId)}`
    if (filters.includePersonalInvitations) url += '&include_personal_invitations=true'
    if (filters.centerOnly) url += '&center_only=true'
    if (filters.status === 'unread') url += '&status=unread'
    if (filters.category) url += `&category=${encodeURIComponent(filters.category)}`
    if (filters.search) url += `&search=${encodeURIComponent(filters.search)}`
    const response = await apiRequest({ url, method: 'GET' })
    if (!response?.data?.success) throw new Error(response?.data?.message || '获取通知失败')
    return response.data.data
  }

  static async getUnreadCount(organizationId?: string): Promise<number> {
    let url = joinApiPath(API_CONFIG.baseURL, `${API_ENDPOINTS.NOTIFICATIONS.UNREAD_COUNT}`)
    if (organizationId) {
      url += `?organization_id=${encodeURIComponent(organizationId)}&include_personal_invitations=true&center_only=true`
    } else {
      url += '?center_only=true'
    }
    const response = await apiRequest({ url, method: 'GET' })
    const data = ensureSuccess(response, '获取未读通知数失败')
    return data.data?.count ?? 0
  }

  static async markRead(notificationId: string): Promise<void> {
    const url = joinApiPath(API_CONFIG.baseURL, `${API_ENDPOINTS.NOTIFICATIONS.MARK_READ(notificationId)}`)
    const response = await apiRequest({ url, method: 'POST' })
    ensureSuccess(response, '标记通知已读失败')
  }

  static async markAllRead(organizationId?: string): Promise<number> {
    let url = joinApiPath(API_CONFIG.baseURL, `${API_ENDPOINTS.NOTIFICATIONS.MARK_ALL_READ}`)
    if (organizationId) {
      url += `?organization_id=${encodeURIComponent(organizationId)}&include_personal_invitations=true&center_only=true`
    } else {
      url += '?center_only=true'
    }
    const response = await apiRequest({ url, method: 'POST' })
    const data = ensureSuccess(response, '全部标记已读失败')
    return data.data?.count ?? 0
  }

  /** 进入 Agent 会话并完成已查看后，将该用户该 session 的终态铃铛标已读（后端权威、幂等）。 */
  static async acknowledgeAgentSession(sessionId: string): Promise<number> {
    const url = joinApiPath(
      API_CONFIG.baseURL,
      API_ENDPOINTS.NOTIFICATIONS.ACKNOWLEDGE_AGENT_SESSION(sessionId),
    )
    const response = await apiRequest({ url, method: 'POST' })
    const data = ensureSuccess(response, '确认 Agent 会话通知已读失败')
    return data.data?.count ?? 0
  }
}
