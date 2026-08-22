/**
 * useNotificationEventStream — 订阅通知实时推送
 *
 * ## 协议（W2 用户级事件治理后）
 *
 * 通知事件已切到 user-level 命名空间 `UserEvents.NOTIFICATION_NEW`
 * (`agent.user.notification.new`)。后端通过 `publish_to_user(user_id, ...,
 * buffer_offline=True)` 直接投递到 channel layer group `user.{user_id}`，
 * 客户端 auth.ok 时已自动 join，**无需 topic 订阅**。所以本 hook 不再走
 * `useGatewayTopic({ topic: 'notifications.{userId}' })`，改为挂全局
 * `gateway.addListener` 监听 envelope.type 判别。
 *
 * ## 职责
 *
 * 1. 乐观更新 react-query 缓存（列表 + 未读计数）
 * 2. 写入 zustand 通知 store（向后兼容老消费方）
 * 3. 触发桌面通知（SystemNotification）
 * 4. 邀请类型事件分发到 window CustomEvent（UI 联动）：
 *    组织邀请新增/同步/取消 → `tabtin:invitation-received`；
 *    `space.invitation*` → `tabtin:project-invitation-received`；
 *    接受/拒绝后 → `tabtin:organization-invitations-changed`
 * 5. 重连后 invalidate cache + 组织/Project 邀请刷新事件（断网期间可能丢推送）
 * 6. `invite_accepted` / `organization.invitation.responded` 到达时 invalidate
 *    成员相关 query，并派发 `tabtin:organization-invitations-changed`
 *   （ 人数；#6261 待处理邀请列表：管理者停留设置页时不再假「待接受」；
 *    同步失效成员用量摘要，避免新成员只有「角色/移除」、没有「本月已用」；
 *     IM 通讯录经该事件刷新 organization store 成员快照）
 *
 * ## detached IM / hasMainWindowHost 守卫
 *
 * `enabled` 控制了 detached 辅助窗（当前仅 detached IM，`mode=im-detached`）的通知
 * 接收策略：主窗口在时 detached 窗不消费（避免重复弹桌面通知）。
 * 本守卫由调用方传入，hook 不感知具体规则。
 *
 * 注：历史「ChatClient passive=true 跳过 inbox drain」+「主窗关闭后 fallback 接管」
 * 的机制已不成立——`passive` 字段随 chat detached window 拆除移除，
 * `hasMainWindowHost` 目前恒为 true（未订阅 notification:onHostStateChanged）。见 。
 */

import { useCallback, useEffect, useMemo, useRef } from 'react'
import { useQueryClient, type QueryClient } from '@tanstack/react-query'
import { UserEvents } from '@tabtin/agent-wire'
import { getChatClient } from '@/services/chatApi'
import { useNotificationStore } from '@stores/useNotificationStore'
import { getChatStoreCallbacks } from '@stores/chat/shared/storeAccessRegistry'
import { isNotificationCenterExcludedType } from '@/services/inboxNotificationPolicy'
import type { NotificationItem } from '@services/notificationApi'
import { SystemNotification } from '@/services/systemNotification'
import { withResolvedNotificationNavigateTarget } from '@/services/notificationTargetResolver'
import {
  optimisticAddNotification,
  optimisticMarkAgentSessionTerminalRead,
  optimisticRemoveInvitationNotifications,
  invalidateNotifications,
  NOTIFICATION_REFRESH_EVENT,
  notificationKeys,
} from '@/hooks/queries/notification'
import {
  isInboxExcludedNotificationType,
  isPersonalGlobalNotificationType,
} from '@/services/inboxNotificationPolicy'
import {
  ACKNOWLEDGE_AGENT_SESSION_COMPLETED_EVENT,
} from '@/services/agentSessionNotificationAck'
import { memberKeys } from '@/hooks/queries/members'
import { membershipKeys } from '@/hooks/queries/membership'
import { memberBudgetKeys } from '@/hooks/queries/memberBudgetKeys'
import { logger } from '@/utils/logger'

/** 邀请被接受后：成员名单 + 会员状态 + 行内「本月已用」一起失效，保持行布局一致。 */
function invalidateCachesAfterInviteAccepted(
  queryClient: QueryClient,
  organizationId: string,
): void {
  void queryClient.invalidateQueries({ queryKey: memberKeys.lists(organizationId) })
  void queryClient.invalidateQueries({ queryKey: membershipKeys.status(organizationId) })
  void queryClient.invalidateQueries({ queryKey: memberBudgetKeys.usageSummary(organizationId) })
  void queryClient.invalidateQueries({ queryKey: memberBudgetKeys.policies(organizationId) })
}

interface UseNotificationEventStreamOptions {
  userId: string | null
  enabled?: boolean
}

/** 只进铃铛列表、不弹 OS 桌面通知的通知类型 */
const SILENT_DESKTOP_TYPES = new Set([
  'organization.invitation.sync',
  'cash_recharged', // ：后台人民币充值只进铃铛，不弹 OS 桌面通知
])

function normalizeNotificationOrganizationId(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

/**
 * 刷新通知未读计数：具体组织变化同时影响该组织与 null 聚合；
 * organizationId=null 本身就是全组织聚合，只刷新一次。
 */
function invalidateNotificationUnreadCounts(
  queryClient: QueryClient,
  organizationId: string | null,
): void {
  void queryClient.invalidateQueries({
    queryKey: notificationKeys.unreadCount(organizationId),
  })
  if (organizationId !== null) {
    void queryClient.invalidateQueries({
      queryKey: notificationKeys.unreadCount(null),
    })
  }
}

/**
 * 解析 NOTIFICATION_NEW envelope payload → NotificationItem。
 *
 * 抽成独立函数是为了让 hook 主体只关心 React 副作用、不混 envelope 解析逻辑，
 * 单测也能直接验证 envelope shape 解析。chatApi.ts::handleUserLevelEnvelope
 * 不调用本函数——它对 NOTIFICATION_NEW 仅做 router 短路（防止落 background
 * bucket），通知业务由本 hook 单点接管以保留 detached IM enabled 守卫语义。
 */
function parseNotificationPayload(envelope: unknown): NotificationItem | null {
  if (!envelope || typeof envelope !== 'object') return null
  const env = envelope as { type?: string; payload?: unknown }
  if (env.type !== UserEvents.NOTIFICATION_NEW) return null

  const rawPayload = env.payload
  if (!rawPayload || typeof rawPayload !== 'object' || Array.isArray(rawPayload)) return null
  const payload = rawPayload as {
    id?: string
    type?: string
    title?: string
    body?: string
    metadata?: { navigate_to?: string; [key: string]: unknown }
    organization_id?: string
    space_id?: string
    priority?: string
    category?: string
    source_extension_id?: string
    source_event_id?: string
    navigate_to?: string
    is_read?: boolean
    read_at?: string | null
    created_at?: string
  }
  if (!payload.id) return null

  // 尊重服务端读态：已读推送（session ack / HITL resolve / 邀请结果态）不得再写成未读，
  // 否则角标回弹且可能误弹 OS。缺省仍按未读兼容历史 payload。
  const isRead = payload.is_read === true
  const readAt =
    isRead && typeof payload.read_at === 'string' && payload.read_at
      ? payload.read_at
      : null

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
    navigate_to: (payload.navigate_to ?? payload.metadata?.navigate_to) as NotificationItem['navigate_to'],
    is_read: isRead,
    read_at: readAt,
    created_at: payload.created_at ?? new Date().toISOString(),
  }
  return withResolvedNotificationNavigateTarget(baseItem)
}

export function useNotificationEventStream({
  userId,
  enabled = true,
}: UseNotificationEventStreamOptions) {
  const queryClient = useQueryClient()
  const addNotification = useNotificationStore(state => state.addNotification)
  const currentOrganizationId = useNotificationStore(state => state.currentOrganizationId)

  const handleEnvelope = useCallback((envelope: unknown) => {
    const item = parseNotificationPayload(envelope)
    if (!item) return

    // IM 未读只挂侧栏「消息」，不进铃铛列表 / 角标 / OS 镜像路径。
    if (isInboxExcludedNotificationType(item.type)) return

    const metadata = (item.metadata ?? {}) as Record<string, unknown>
    if (metadata.desktop_only === true) {
      SystemNotification.extensionEvent({
        type: item.type,
        title: item.title,
        body: item.body,
        priority: (item.priority as 'urgent' | 'high' | 'normal' | 'low') || 'normal',
        organizationId: item.organization_id,
        spaceId: item.space_id || undefined,
        navigateTo: undefined,
        metadata: { dedup_ref: item.source_event_id || item.id },
        desktopDelivery: 'always',
        mirrorToCenter: false,
        suppressWhenSourceWindowFocused: false,
      })
      return
    }

    // 服务端 payload 是通知归属真源；空值明确使用 null 聚合 key，不能猜当前组织。
    const itemOrganizationId = normalizeNotificationOrganizationId(item.organization_id)
    const isPersonalGlobal = isPersonalGlobalNotificationType(item.type)
    const mergeOrganizationId = isPersonalGlobal
      ? currentOrganizationId
      : item.is_read
        ? itemOrganizationId
        : currentOrganizationId
    const invitationIdRaw = metadata.invitation_id ?? metadata.invitationId
    const invitationId = typeof invitationIdRaw === 'string' ? invitationIdRaw : undefined
    const isInvitationLifecycle =
      item.type === 'organization.invitation.sync'
      || item.type === 'organization.invitation.cancelled'
      || item.type === 'organization.invitation.responded'

    // ：结果态到达时先清掉同 invitation 的旧「组织邀请」卡，再 upsert 当前条
    if (isInvitationLifecycle && invitationId) {
      optimisticRemoveInvitationNotifications(queryClient, mergeOrganizationId, invitationId)
    }

    if (!isNotificationCenterExcludedType(item.type)) {
      optimisticAddNotification(queryClient, mergeOrganizationId, item)
      addNotification(item)

      // 主窗 Bell 常只有 unread-count 查询、无 list 缓存；乐观 +1 后仍按 payload
      // organization 拉权威未读数（含未读新通知与已读结果态），避免角标漏亮/漂移。
      invalidateNotificationUnreadCounts(queryClient, itemOrganizationId)
      if (isPersonalGlobal && currentOrganizationId !== itemOrganizationId) {
        invalidateNotificationUnreadCounts(queryClient, currentOrganizationId)
      }

      // ：列表在 overlay 独立 QueryClient；主窗缓存更新后推 refresh，已开面板立刻重拉。
      void window.tabtin?.overlay?.push?.({
        type: 'notification-refresh',
        organizationId: isPersonalGlobal ? currentOrganizationId : itemOrganizationId,
      })
    }

    // SILENT_DESKTOP_TYPES：只进铃铛列表、不弹 OS 桌面通知的类型。
    // balance_low 由持久通知同时承载通知中心与 OS 桌面通知，不走应用内 toast；
    // cash_recharged：产品要求只进铃铛，不弹 OS 桌面通知；
    // organization.invitation.sync 是历史静默类型。已读的结果态（自触发 sync）也不弹桌面通知。
    const desktopDelivery = metadata.desktop_delivery
    const isDesktopSilent =
      SILENT_DESKTOP_TYPES.has(item.type)
      || desktopDelivery === 'never'
    if (!isDesktopSilent && !item.is_read) {
      const isAgentTaskTerminal = item.type.startsWith('agent.task.')
      const traceId = isAgentTaskTerminal && typeof metadata.trace_id === 'string'
        ? metadata.trace_id.trim()
        : ''
      const hitlRequestKey = item.type === 'agent.hitl.waiting'
        && typeof metadata.request_key === 'string'
        ? metadata.request_key.trim()
        : ''
      const targetSessionId = item.navigate_to?.type === 'chat-session'
        ? item.navigate_to.id
        : undefined
      SystemNotification.extensionEvent({
        type: item.type,
        title: item.title,
        body: item.body,
        priority: (item.priority as 'urgent' | 'high' | 'normal' | 'low') || 'normal',
        organizationId: item.organization_id,
        spaceId: item.space_id,
        navigateTo: item.navigate_to,
        metadata: {
          ...(traceId || hitlRequestKey
            ? { dedup_ref: traceId || `agent-hitl:${hitlRequestKey}` }
            : item.source_event_id
              ? { dedup_ref: item.source_event_id }
              : {}),
        },
        desktopDelivery:
          desktopDelivery === 'always' || desktopDelivery === 'unfocused'
            ? desktopDelivery
            : undefined,
        mirrorToCenter:
          item.category === 'organization' || item.category === 'account'
            ? false
            : undefined,
        ...(metadata.presentation_owner === 'notification_projection'
          && metadata.toast_policy === 'desktop_fallback'
          ? { toastFallback: 'desktop-unavailable' as const }
          : {}),
        suppressWhenSourceWindowFocused:
          Boolean(
            targetSessionId
            && getChatStoreCallbacks()?.getCurrentSessionId() === targetSessionId,
          ),
      })
    }

    if (
      item.type === 'organization.invitation'
      || item.type === 'organization.invitation.sync'
      || item.type === 'organization.invitation.cancelled'
    ) {
      window.dispatchEvent(new CustomEvent('tabtin:invitation-received', {
        detail: {
          invitationId,
          isSync:
            item.type === 'organization.invitation.sync'
            || item.type === 'organization.invitation.cancelled',
        },
      }))
    }

    // ：Project 邀请（space.invitation*）后端已推通知，但侧栏「待加入 Project」
    // 原先只在 organizationId 变化时拉取；收到实时通知后派事件让侧栏立刻重拉。
    if (item.type.startsWith('space.invitation')) {
      const projectIdRaw = metadata.project_id ?? metadata.projectId
      window.dispatchEvent(new CustomEvent('tabtin:project-invitation-received', {
        detail: {
          projectId: typeof projectIdRaw === 'string' ? projectIdRaw : undefined,
          organizationId: item.organization_id || undefined,
          isSync:
            item.type === 'space.invitation.cancelled'
            || item.type === 'space.invitation.responded',
        },
      }))
    }

    //  / ：被邀请者接受或拒绝后，管理者若一直停留在设置页未切窗口，
    //  的 refetchOnWindowFocus 不会触发；邀请列表又是本地 state，只会在
    // 挂载时拉一次。通知自带 organization_id，据此立刻 invalidate 成员/额度，
    // 并通知设置页重拉待处理邀请，不依赖用户切窗口。
    const organizationId = item.organization_id
    const isInviteAccepted = item.type === 'invite_accepted'
    const isInviteResponded = item.type === 'organization.invitation.responded'
    if (organizationId && (isInviteAccepted || isInviteResponded)) {
      if (isInviteAccepted || metadata.accepted === true) {
        invalidateCachesAfterInviteAccepted(queryClient, organizationId)
      }
      window.dispatchEvent(new CustomEvent('tabtin:organization-invitations-changed', {
        detail: {
          organizationId,
          invitationId,
        },
      }))
    }
  }, [queryClient, addNotification, currentOrganizationId])

  const handleReconnected = useCallback(() => {
    invalidateNotifications(queryClient)
    window.dispatchEvent(new CustomEvent('tabtin:invitation-received', {
      detail: { isSync: true },
    }))
    // 断线期间可能丢了 invite_accepted / responded；打开中的成员面板 / 通讯录自行重拉
    // （：useTabChatPanelLifecycle 监听此事件刷新 organization store）
    window.dispatchEvent(new CustomEvent('tabtin:organization-invitations-changed', {
      detail: {},
    }))
    // ：断网期间可能丢 Project 邀请推送，重连后让侧栏一并补拉。
    window.dispatchEvent(new CustomEvent('tabtin:project-invitation-received', {
      detail: { isSync: true },
    }))
  }, [queryClient])

  // dedup 缓存：实时 group_send 与 inbox drain 都可能投递同一 envelope，
  // 用 event_id 兜底（与 useGatewayTopic 内部做法一致），避免 store 双写。
  const recentEventIdsRef = useRef(new Set<string>())
  const DEDUP_LIMIT = 200

  const dedupedHandle = useCallback((envelope: { event_id?: string } | unknown) => {
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
  }, [handleEnvelope])

  // 用 ref 持最新回调，避免每次渲染都重新挂监听
  const handleRef = useRef(dedupedHandle)
  const reconnectRef = useRef(handleReconnected)
  handleRef.current = dedupedHandle
  reconnectRef.current = handleReconnected

  const isEffectivelyEnabled = useMemo(
    () => enabled && !!userId,
    [enabled, userId],
  )

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
      logger.warn('[Notification] gateway listener attach failed', err)
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

  // acknowledge API 成功后：严格按请求发起时冻结的 organization 处理。
  // 缺失归属明确落 global/null；不读取返回时的当前组织。
  useEffect(() => {
    if (!isEffectivelyEnabled) return
    const onAcknowledgeCompleted = (event: Event) => {
      const detail = (event as CustomEvent<{
        sessionId?: string
        organizationId?: string | null
      }>).detail
      const sessionId = detail?.sessionId
      if (typeof sessionId !== 'string' || !sessionId.trim()) return
      const organizationId = normalizeNotificationOrganizationId(detail?.organizationId)
      optimisticMarkAgentSessionTerminalRead(queryClient, organizationId, sessionId)
      invalidateNotificationUnreadCounts(queryClient, organizationId)
    }
    // eslint-disable-next-line tabtin/prefer-scoped-activity-effects -- 用户级通知读态跨 Space 生效，跟随 App 全局通知 stream 生命周期。
    window.addEventListener(
      ACKNOWLEDGE_AGENT_SESSION_COMPLETED_EVENT,
      onAcknowledgeCompleted,
    )
    return () => window.removeEventListener(
      ACKNOWLEDGE_AGENT_SESSION_COMPLETED_EVENT,
      onAcknowledgeCompleted,
    )
  }, [isEffectivelyEnabled, queryClient])

  // ：点券充值后 billing 流派发，重拉铃铛未读（后端已标已读 balance_low）
  useEffect(() => {
    if (!isEffectivelyEnabled) return
    const onNotificationRefresh = (event: Event) => {
      const detail = (event as CustomEvent<{ organizationId?: string | null }>).detail
      const organizationId = normalizeNotificationOrganizationId(detail?.organizationId)
      invalidateNotifications(queryClient)
      invalidateNotificationUnreadCounts(queryClient, organizationId)
      void window.tabtin?.overlay?.push?.({
        type: 'notification-refresh',
        organizationId,
      })
    }
    // eslint-disable-next-line tabtin/prefer-scoped-activity-effects -- 充值消警后的未读刷新跨 Space，挂在通知 stream 生命周期。
    window.addEventListener(NOTIFICATION_REFRESH_EVENT, onNotificationRefresh)
    return () => window.removeEventListener(NOTIFICATION_REFRESH_EVENT, onNotificationRefresh)
  }, [isEffectivelyEnabled, queryClient])
}
