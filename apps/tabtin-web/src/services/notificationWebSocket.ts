/**
 * Web 端通知实时推送订阅 — 对齐 Electron useNotificationEventStream
 *
 * 复用 chatApi 已建立的 ws-gateway-client 连接(Capabilities.NOTIFICATIONS 已在
 * apps/tabtin-web/src/services/chatApi.ts 注册),监听 envelope.type ===
 * UserEvents.NOTIFICATION_NEW 投递,把 payload → NotificationItem 追加到 store。
 *
 * 与 Electron 三件套唯一差异:
 *  - 无 SystemNotification 桌面通知(浏览器有自己的 Web Notification API,
 *    本期 Web 通知中心红点已足够,系统级通知是下期范围)
 *  - 无 react-query 缓存联动(Web 端 store 直接持数据)
 *  - organization.invitation CustomEvent 暂不消费(Web 端无对应 UI)
 *
 * 在 AppLayout/SpaceHome 等顶层组件 mount 时通过 hook 形态调用。
 */
import { useEffect, useRef, useCallback, useMemo } from 'react'
import { getChatClient } from '@/services/chatApi'

/**
 * 与 @tabtin/agent-wire 中的 UserEvents.NOTIFICATION_NEW 字符串值同步。
 * Web 包尚未引入 @tabtin/agent-wire workspace 依赖,这里内联常量;
 * 后端 agent_wire publish_to_user 写死该字符串,不会漂。
 */
const USER_EVENT_NOTIFICATION_NEW = 'agent.user.notification.new'
import { useNotificationStore } from '@/stores/useNotificationStore'
import {
  withResolvedWebNotificationNavigateTarget,
} from '@/services/notificationNavigation'
import type { NotificationItem } from '@/services/notificationApi'

interface UseNotificationEventStreamOptions {
  userId: string | null
  enabled?: boolean
}

function parseNotificationPayload(envelope: unknown): NotificationItem | null {
  if (!envelope || typeof envelope !== 'object') return null
  const env = envelope as { type?: string; payload?: unknown }
  if (env.type !== USER_EVENT_NOTIFICATION_NEW) return null

  const rawPayload = env.payload
  if (!rawPayload || typeof rawPayload !== 'object' || Array.isArray(rawPayload)) return null
  const payload = rawPayload as {
    id?: string
    type?: string
    title?: string
    body?: string
    metadata?: Record<string, unknown>
    organization_id?: string
    space_id?: string
    priority?: string
    category?: string
    source_extension_id?: string
    source_event_id?: string
    created_at?: string
  }
  if (!payload.id) return null
  if (payload.metadata?.desktop_only === true) return null

  const baseItem: NotificationItem = {
    id: payload.id,
    type: payload.type ?? 'system',
    title: payload.title ?? '',
    body: payload.body ?? '',
    metadata: payload.metadata ?? {},
    organization_id: payload.organization_id ?? '',
    space_id: payload.space_id,
    priority: payload.priority,
    category: payload.category,
    source_extension_id: payload.source_extension_id,
    source_event_id: payload.source_event_id,
    is_read: false,
    read_at: null,
    created_at: payload.created_at ?? new Date().toISOString(),
  }
  return withResolvedWebNotificationNavigateTarget(baseItem)
}

/**
 * Web 端通知实时订阅 hook。
 *
 * @param userId 当前登录用户 id;null 时不订阅
 * @param enabled 显式控制开关(测试场景);默认 true
 */
export function useWebNotificationEventStream({
  userId,
  enabled = true,
}: UseNotificationEventStreamOptions): void {
  const addNotification = useNotificationStore((s) => s.addNotification)
  const loadUnreadCount = useNotificationStore((s) => s.loadUnreadCount)

  const handleEnvelope = useCallback(
    (envelope: unknown) => {
      const item = parseNotificationPayload(envelope)
      if (!item) return
      addNotification(item)
    },
    [addNotification],
  )

  // dedup:实时 group_send 与 inbox drain 可能投递同一 envelope,event_id 兜底
  const recentEventIdsRef = useRef(new Set<string>())
  const DEDUP_LIMIT = 200

  const dedupedHandle = useCallback(
    (envelope: { event_id?: string } | unknown) => {
      if (envelope && typeof envelope === 'object') {
        const eventId = (envelope as { event_id?: unknown }).event_id
        if (typeof eventId === 'string') {
          if (recentEventIdsRef.current.has(eventId)) return
          recentEventIdsRef.current.add(eventId)
          if (recentEventIdsRef.current.size > DEDUP_LIMIT) {
            const first = recentEventIdsRef.current.values().next().value
            if (first !== undefined) recentEventIdsRef.current.delete(first)
          }
        }
      }
      handleEnvelope(envelope)
    },
    [handleEnvelope],
  )

  const handleReconnected = useCallback(() => {
    // 重连后:网络断开期间可能丢推送,主动刷一次未读数
    void loadUnreadCount()
  }, [loadUnreadCount])

  const handleRef = useRef(dedupedHandle)
  const reconnectRef = useRef(handleReconnected)
  handleRef.current = dedupedHandle
  reconnectRef.current = handleReconnected

  const isEffectivelyEnabled = useMemo(() => enabled && !!userId, [enabled, userId])

  useEffect(() => {
    if (!isEffectivelyEnabled) return

    let listener: ((envelope: unknown) => void) | null = null
    let reconnectHandler: (() => void) | null = null
    let gateway: ReturnType<ReturnType<typeof getChatClient>['getGateway']> | null = null

    try {
      gateway = getChatClient().getGateway()
      listener = (env: unknown) => handleRef.current(env)
      reconnectHandler = () => reconnectRef.current()
      gateway.addListener(listener)
      gateway.onReconnectedEvent(reconnectHandler)
    } catch (err) {
      // gateway 可能未初始化(未登录 / 网络问题),静默处理
      console.debug('[WebNotificationWS] gateway listener attach failed', err)
    }

    recentEventIdsRef.current.clear()

    return () => {
      try {
        if (listener) gateway?.removeListener(listener)
        if (reconnectHandler) gateway?.offReconnectedEvent(reconnectHandler)
      } catch {
        /* gateway 可能已被销毁 */
      }
      recentEventIdsRef.current.clear()
    }
  }, [isEffectivelyEnabled, userId])
}
