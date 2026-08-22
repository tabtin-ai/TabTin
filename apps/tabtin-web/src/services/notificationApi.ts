/**
 * Web 端通知 HTTP 客户端 — 对齐 Electron NotificationApiService
 *
 * 与 Electron 三件套 (apps/tabtin-electron/src/renderer/src/services/notificationApi.ts)
 * 唯一差异:
 *  - HTTP 请求走 Web 的 getApiClient().raw 而非 Electron 的 adapterApiRequest;
 *    raw 已自动 unwrap {success, data} envelope,接口直接返回 data 类型
 *  - 无 Dock badge(浏览器没有 setBadgeCount API,Bell 红点已足够)
 *  - 类型 NotificationNavigateTarget 内联,避免引入 Electron main 进程类型
 */
import { API_ENDPOINTS } from '@tabtin/config'
import { getApiClient } from './api-client'

/**
 * Wave 4 (PRD §五块 6):Web 端 NavigateTarget 与 Electron 对等 — 但只保留 Web
 * 真正消费的 case (resource-shared / notification-panel 等)。tabmail/agenda/
 * goal/chat-session 等 Electron 专属概念在 Web 暂无对应路由,resolver 不会生成。
 *
 * 当后续 Web 端补齐这些路由(R10/R11/Agent 协作下期专项),按需扩展。
 */
type NavigateTargetBase = {
  organizationId?: string
  spaceId?: string
}

export type NotificationNavigateTarget =
  | (NavigateTargetBase & {
      type: 'resource-shared'
      id: string
      resourceType: 'doc' | 'table'
      resourceTitle?: string
      recordId?: string
      commentId?: string
      openComments?: boolean
      intentKey?: string
    })
  | (NavigateTargetBase & {
      type: 'notification-panel'
      id: string
    })
  // 兼容字段:未识别的 type 仍透传(navigateToNotification 会忽略)
  | (NavigateTargetBase & {
      type: string
      id: string
      [key: string]: unknown
    })

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
  source_extension_id?: string
  source_event_id?: string
  channels_delivered?: string[]
  navigate_to?: NotificationNavigateTarget
  is_read: boolean
  read_at: string | null
  created_at: string
}

interface ListResponseData {
  items: NotificationItem[]
  total: number
  page: number
  limit: number
}

interface UnreadCountResponseData {
  count: number
}

interface MarkAllReadResponseData {
  count: number
}

export class NotificationApiService {
  static async list(page = 1, limit = 20, organizationId?: string): Promise<ListResponseData> {
    const params: Record<string, string | number> = { page, limit }
    if (organizationId) params.organization_id = organizationId
    return getApiClient().raw<ListResponseData>('GET', API_ENDPOINTS.NOTIFICATIONS.LIST, { params })
  }

  static async getUnreadCount(organizationId?: string): Promise<number> {
    const params: Record<string, string> = {}
    if (organizationId) params.organization_id = organizationId
    const data = await getApiClient().raw<UnreadCountResponseData>(
      'GET',
      API_ENDPOINTS.NOTIFICATIONS.UNREAD_COUNT,
      { params },
    )
    return data?.count ?? 0
  }

  static async markRead(notificationId: string): Promise<void> {
    await getApiClient().raw<unknown>('POST', API_ENDPOINTS.NOTIFICATIONS.MARK_READ(notificationId))
  }

  static async markAllRead(organizationId?: string): Promise<number> {
    const params: Record<string, string> = {}
    if (organizationId) params.organization_id = organizationId
    const data = await getApiClient().raw<MarkAllReadResponseData>(
      'POST',
      API_ENDPOINTS.NOTIFICATIONS.MARK_ALL_READ,
      { params },
    )
    return data?.count ?? 0
  }
}
