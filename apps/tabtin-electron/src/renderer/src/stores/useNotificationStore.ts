/** @store-category domain */

/**
 * 通知状态管理（普通业务按 Organization 隔离，个人生命周期消息全局可见）
 *
 * 系统角标由 NotificationBell 的最终展示值统一驱动；本 Store 仅保留兼容消费方状态。
 */
import { create } from 'zustand'
import { toast } from '@tabtin/smartsheet-ui/toast'
import { NotificationApiService, type NotificationItem, type NotificationNavigateTarget } from '@services/notificationApi'
import { navigateToTarget } from '@/services/notificationNavigation'
import {
  resolveNotificationNavigateTarget,
  withResolvedNotificationNavigateTarget,
} from '@/services/notificationTargetResolver'
import i18n from '@/i18n'
import { registerResetAction } from './sessionResetRegistry'
import { dedupAsync } from '@/stores/organization/helpers'
import { createLogger } from '@/utils/logger'
import { syncNotificationBadge } from '@/services/notificationBadge'
import {
  isInboxExcludedNotificationType,
  isNotificationCenterExcludedType,
  isPersonalGlobalNotificationType,
} from '@/services/inboxNotificationPolicy'

const log = createLogger('Notification')

let latestNotificationsRequestId = 0
let latestUnreadCountRequestId = 0
const _notifInFlight = new Map<string, Promise<void>>()

function isLocalNotification(notification: NotificationItem): boolean {
  return notification.id.startsWith('local-')
}

function readNavigateTargetId(item: NotificationItem): string | undefined {
  const target = item.navigate_to
    ?? (item.metadata as Record<string, unknown> | undefined)?.navigate_to
  if (!target || typeof target !== 'object') return undefined
  const id = (target as Record<string, unknown>).id
  return typeof id === 'string' && id.trim() ? id : undefined
}

function isLikelySameNotification(a: NotificationItem, b: NotificationItem): boolean {
  if (a.type !== b.type) return false

  // 优先按跳转目标 id（session / tracker）去重，比 title 更稳
  const aTargetId = readNavigateTargetId(a)
  const bTargetId = readNavigateTargetId(b)
  if (aTargetId && bTargetId && aTargetId === bTargetId) {
    return Math.abs(new Date(a.created_at).getTime() - new Date(b.created_at).getTime()) < 10_000
  }

  const aSession = (a.metadata as Record<string, unknown> | undefined)?.session_id
    ?? (a.metadata as Record<string, unknown> | undefined)?.sessionId
  const bSession = (b.metadata as Record<string, unknown> | undefined)?.session_id
    ?? (b.metadata as Record<string, unknown> | undefined)?.sessionId
  if (
    typeof aSession === 'string' && aSession
    && typeof bSession === 'string' && bSession
    && aSession === bSession
  ) {
    return Math.abs(new Date(a.created_at).getTime() - new Date(b.created_at).getTime()) < 10_000
  }

  return (
    a.title === b.title
    && Math.abs(new Date(a.created_at).getTime() - new Date(b.created_at).getTime()) < 3000
  )
}

function sortNotificationsByCreatedAt(items: NotificationItem[]): NotificationItem[] {
  return [...items].sort(
    (left, right) => new Date(right.created_at).getTime() - new Date(left.created_at).getTime(),
  )
}

function isScopeStale(
  get: () => Pick<NotificationState, 'currentOrganizationId'>,
  organizationId: string | null,
) {
  return get().currentOrganizationId !== organizationId
}

interface NotificationState {
  currentOrganizationId: string | null
  notifications: NotificationItem[]
  unreadCount: number
  isLoading: boolean
  error: string | null
  isPanelOpen: boolean

  setOrganizationScope: (organizationId: string | null) => void
  loadNotifications: (page?: number) => Promise<void>
  loadUnreadCount: () => Promise<void>
  markRead: (notificationId: string) => Promise<void>
  markAllRead: () => Promise<void>
  markAllLocalRead: () => void
  replaceLocalNotifications: (notifications: NotificationItem[]) => void
  addNotification: (notification: NotificationItem) => void
  navigateToNotification: (notification: NotificationItem) => Promise<void>
  setIsPanelOpen: (open: boolean) => void
  clearAll: () => void
  initShownListener: () => (() => void)
}

export const useNotificationStore = create<NotificationState>((set, get) => ({
  currentOrganizationId: null,
  notifications: [],
  unreadCount: 0,
  isLoading: false,
  error: null,
  isPanelOpen: false,

  setOrganizationScope: (organizationId: string | null) => {
    const prev = get().currentOrganizationId
    if (prev === organizationId) return
    _notifInFlight.clear()
    latestNotificationsRequestId += 1
    latestUnreadCountRequestId += 1
    const shouldReloadPanel = get().isPanelOpen
    set({
      currentOrganizationId: organizationId,
      notifications: [],
      isLoading: shouldReloadPanel,
      error: null,
    })
    if (shouldReloadPanel) {
      void get().loadNotifications()
    }
  },

  loadNotifications: async (page = 1) => {
    const organizationId = get().currentOrganizationId
    await dedupAsync(_notifInFlight, `list:${page}:${organizationId ?? 'global'}`, async () => {
      const requestId = ++latestNotificationsRequestId
      set({ isLoading: true, error: null })
      try {
        const result = await NotificationApiService.list(
          page,
          20,
          organizationId ?? undefined,
          { includePersonalInvitations: true },
        )
        if (
          requestId !== latestNotificationsRequestId
          || get().currentOrganizationId !== organizationId
        ) {
          return
        }
        const localOnly = get().notifications.filter((notification) =>
          isLocalNotification(notification)
          && !result.items.some((serverNotification) => isLikelySameNotification(serverNotification, notification)),
        )
        const normalizedServerItems = result.items.map(withResolvedNotificationNavigateTarget)
        set({
          notifications: sortNotificationsByCreatedAt([...localOnly, ...normalizedServerItems]),
          isLoading: false,
        })
      } catch (err) {
        if (
          requestId !== latestNotificationsRequestId
          || get().currentOrganizationId !== organizationId
        ) {
          return
        }
        log.warn('loadNotifications failed:', { organizationId, page, error: err })
        set({
          error: err instanceof Error ? err.message : i18n.t('common:errors.loadNotificationsFailed'),
          isLoading: false,
        })
      }
    })
  },

  loadUnreadCount: async () => {
    const organizationId = get().currentOrganizationId
    await dedupAsync(_notifInFlight, `unread:${organizationId ?? 'global'}`, async () => {
      const requestId = ++latestUnreadCountRequestId
      try {
        const count = await NotificationApiService.getUnreadCount(organizationId ?? undefined)
        if (
          requestId !== latestUnreadCountRequestId
          || get().currentOrganizationId !== organizationId
        ) {
          return
        }
        set({ unreadCount: count })
      } catch (err) {
        if (
          requestId !== latestUnreadCountRequestId
          || get().currentOrganizationId !== organizationId
        ) {
          return
        }
        log.debug('loadUnreadCount failed:', { organizationId, error: err })
      }
    })
  },

  markRead: async (notificationId: string) => {
    const organizationId = get().currentOrganizationId
    if (notificationId.startsWith('local-')) {
      set((state) => {
        const target = state.notifications.find((notification) => notification.id === notificationId)
        if (!target || target.is_read) return state
        return {
          notifications: state.notifications.map((notification) =>
            notification.id === notificationId ? { ...notification, is_read: true } : notification,
          ),
          unreadCount: Math.max(0, state.unreadCount - 1),
        }
      })
      return
    }
    try {
      await NotificationApiService.markRead(notificationId)
      if (isScopeStale(get, organizationId)) return
      set((state) => {
        const target = state.notifications.find((n) => n.id === notificationId)
        if (!target || target.is_read) return state
        const next = Math.max(0, state.unreadCount - 1)
        return {
          notifications: state.notifications.map((n) =>
            n.id === notificationId ? { ...n, is_read: true } : n,
          ),
          unreadCount: next,
        }
      })
    } catch (err) {
      log.debug('markRead failed:', { notificationId, error: err })
    }
  },

  markAllRead: async () => {
    const organizationId = get().currentOrganizationId
    const targetIds = new Set(
      get().notifications.filter((notification) => !notification.is_read).map((notification) => notification.id),
    )
    try {
      await NotificationApiService.markAllRead(organizationId ?? undefined)
      if (isScopeStale(get, organizationId)) return
      set((state) => {
        let nextUnreadCount = 0
        const notifications = state.notifications.map((notification) => {
          if (!targetIds.has(notification.id)) {
            if (!notification.is_read) nextUnreadCount += 1
            return notification
          }
          return { ...notification, is_read: true }
        })
        return {
          notifications,
          unreadCount: nextUnreadCount,
        }
      })
    } catch (err) {
      log.debug('markAllRead failed:', { organizationId, error: err })
    }
  },

  markAllLocalRead: () => {
    set((state) => {
      const localUnread = state.notifications.filter((notification) =>
        isLocalNotification(notification) && !notification.is_read,
      ).length
      return {
        notifications: state.notifications.map((notification) =>
          isLocalNotification(notification) ? { ...notification, is_read: true } : notification,
        ),
        unreadCount: Math.max(0, state.unreadCount - localUnread),
      }
    })
  },

  replaceLocalNotifications: (notifications) => {
    const nextLocalNotifications = notifications.filter(isLocalNotification)
    set((state) => {
      const previousLocalUnread = state.notifications.filter((notification) =>
        isLocalNotification(notification) && !notification.is_read,
      ).length
      const nextLocalUnread = nextLocalNotifications.filter((notification) => !notification.is_read).length
      return {
        notifications: sortNotificationsByCreatedAt([
          ...nextLocalNotifications,
          ...state.notifications.filter((notification) => !isLocalNotification(notification)),
        ]),
        unreadCount: Math.max(0, state.unreadCount - previousLocalUnread + nextLocalUnread),
      }
    })
  },

  addNotification: (notification: NotificationItem) => {
    if (isNotificationCenterExcludedType(notification.type)) return
    const wsId = get().currentOrganizationId
    if (
      wsId
      && notification.organization_id
      && notification.organization_id !== wsId
      && !isPersonalGlobalNotificationType(notification.type)
    ) return
    const existing = get().notifications
    const sameIdIdx = existing.findIndex(n => n.id === notification.id)
    if (sameIdIdx >= 0) {
      // ：同 id 原地升级（邀请 → sync/cancelled）时替换内容并校正未读
      set((state) => {
        const prev = state.notifications[sameIdIdx]
        const unreadDelta = (prev?.is_read ? 0 : -1) + (notification.is_read ? 0 : 1)
        const nextUnread = Math.max(0, state.unreadCount + unreadDelta)
        const rest = state.notifications.filter((_, idx) => idx !== sameIdIdx)
        return {
          notifications: sortNotificationsByCreatedAt([notification, ...rest]),
          unreadCount: nextUnread,
        }
      })
      return
    }
    const invitationId = (notification.metadata as Record<string, unknown> | undefined)?.invitation_id
      ?? (notification.metadata as Record<string, unknown> | undefined)?.invitationId
    if (
      typeof invitationId === 'string'
      && invitationId
      && (
        notification.type === 'organization.invitation.sync'
        || notification.type === 'organization.invitation.cancelled'
      )
    ) {
      // 结果态到达：清掉同 invitation 的旧邀请卡，避免双卡
      set((state) => {
        let removedUnread = 0
        const kept = state.notifications.filter((n) => {
          if (n.type !== 'organization.invitation') return true
          const id = (n.metadata as Record<string, unknown> | undefined)?.invitation_id
            ?? (n.metadata as Record<string, unknown> | undefined)?.invitationId
          if (id === invitationId) {
            if (!n.is_read) removedUnread += 1
            return false
          }
          return true
        })
        const unreadDelta = -removedUnread + (notification.is_read ? 0 : 1)
        const nextUnread = Math.max(0, state.unreadCount + unreadDelta)
        return {
          notifications: sortNotificationsByCreatedAt([notification, ...kept]),
          unreadCount: nextUnread,
        }
      })
      return
    }
    const likelySameIdx = existing.findIndex((item) =>
      isLikelySameNotification(item, notification)
    )
    if (likelySameIdx >= 0) {
      const previous = existing[likelySameIdx]
      // OS 桌面通知可能先于 WS 持久通知到达。服务端版本必须接管本地镜像，
      // 否则 overlay 标记 server id 已读后，主窗仍会把 local-* 副本计入角标。
      if (previous && isLocalNotification(previous) && !isLocalNotification(notification)) {
        set((state) => {
          const currentIdx = state.notifications.findIndex((item) =>
            isLikelySameNotification(item, notification)
          )
          if (currentIdx < 0) return state
          const current = state.notifications[currentIdx]
          if (!current || !isLocalNotification(current)) return state
          const unreadDelta = (current.is_read ? 0 : -1) + (notification.is_read ? 0 : 1)
          return {
            notifications: sortNotificationsByCreatedAt([
              notification,
              ...state.notifications.filter((_, idx) => idx !== currentIdx),
            ]),
            unreadCount: Math.max(0, state.unreadCount + unreadDelta),
          }
        })
      }
      return
    }
    set((state) => {
      const next = notification.is_read ? state.unreadCount : state.unreadCount + 1
      return {
        notifications: sortNotificationsByCreatedAt([notification, ...state.notifications]),
        unreadCount: next,
      }
    })
  },

  navigateToNotification: async (notification: NotificationItem) => {
    if (notification.type === 'organization.invitation') {
      const { useInvitationInboxStore } = await import('@stores/useInvitationInboxStore')
      await useInvitationInboxStore.getState().openFromNotification(notification)
      if (!notification.is_read) {
        void get().markRead(notification.id)
      }
      return
    }

    // ：资源访问申请 → 直接打开 owner 确认弹窗（不 toast、不按 metadata 本地授权）
    if (notification.type === 'resource_access_request') {
      const { useResourceAccessRequestStore } = await import('@stores/useResourceAccessRequestStore')
      useResourceAccessRequestStore.getState().openConfirm(notification)
      if (!notification.is_read) {
        void get().markRead(notification.id)
      }
      return
    }

    // Project 邀请：进「协作」待加入列表（与 Toast「去协作」同路径）
    if (notification.type === 'space.invitation' || notification.type.startsWith('space.invitation.')) {
      const { openCollaborationFromInvite } = await import('@/components/layout/project/openCollaborationFromInvite')
      await openCollaborationFromInvite(notification.organization_id)
      if (!notification.is_read) {
        void get().markRead(notification.id)
      }
      return
    }

    const target: NotificationNavigateTarget | undefined = resolveNotificationNavigateTarget(notification)
    if (target) {
      await navigateToTarget(target)
    } else if (notification.type === 'resource_shared') {
      // Wave 4 (PRD §五块 5):resolver 对 action='removed'/'auto_removed' 主动返回 undefined,
      // 表示"不跳转,仅提示用户已无访问权限"。
      // Wave 5 §A (auto_removed_summary):owner 收到的"X 离开了团队"汇总通知,
      //  (owner_reassigned_summary):资料转交汇总通知,
      // 点击不跳转,toast 显示"汇总通知"语义。
      const action = (notification.metadata as Record<string, unknown> | undefined)?.action
      if (action === 'removed' || action === 'auto_removed') {
        toast({
          title: i18n.t('common:share.toast.noLongerAccessible', {
            defaultValue: '你已无访问权限',
          }),
          variant: 'default',
        })
      } else if (action === 'auto_removed_summary' || action === 'owner_reassigned_summary') {
        toast({
          title: i18n.t('common:share.toast.summaryNoNavigate', {
            defaultValue: '汇总通知，详情见列表',
          }),
          variant: 'default',
        })
      }
    }
    if (!notification.is_read) {
      void get().markRead(notification.id)
    }
  },

  setIsPanelOpen: (open: boolean) => {
    set({ isPanelOpen: open })
    if (open) {
      void get().loadNotifications()
    }
  },

  clearAll: () => {
    _notifInFlight.clear()
    set({ notifications: [], unreadCount: 0, isLoading: false, error: null, isPanelOpen: false })
    syncNotificationBadge(0, 0)
  },

  initShownListener: () => {
    const handler = (data: Record<string, unknown>) => {
      if (typeof data?.type !== 'string' || typeof data?.title !== 'string') return

      const type = data.type
      // IM 未读只挂侧栏「消息」，桌面 toast 不镜像进铃铛。
      if (isNotificationCenterExcludedType(type)) return
      const navigateTo = data.navigateTo && typeof data.navigateTo === 'object'
        ? data.navigateTo as NotificationNavigateTarget
        : undefined
      const navigateId = navigateTo && typeof (navigateTo as { id?: unknown }).id === 'string'
        ? (navigateTo as { id: string }).id
        : undefined
      const existing = get().notifications
      const hasServerVersion = existing.some((n) => {
        if (n.type !== type || n.id.startsWith('local-')) return false
        if (Date.now() - new Date(n.created_at).getTime() >= 10_000) return false
        if (navigateId) {
          const serverTargetId = readNavigateTargetId(n)
          if (serverTargetId) return serverTargetId === navigateId
        }
        return true
      })
      if (hasServerVersion) return

      const item: NotificationItem = {
        id: `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        type,
        title: data.title,
        body: typeof data.body === 'string' ? data.body : '',
        metadata: navigateId
          ? {
              session_id: type.startsWith('agent.') ? navigateId : undefined,
              tracker_id: type.startsWith('tracker.') ? navigateId : undefined,
            }
          : {},
        organization_id: typeof data.organizationId === 'string' ? data.organizationId : '',
        space_id:
          typeof data.spaceId === 'string'
            ? data.spaceId
            : undefined,
        priority: typeof data.priority === 'string' ? data.priority : undefined,
        navigate_to: navigateTo,
        is_read: false,
        read_at: null,
        created_at: new Date().toISOString(),
      }
      get().addNotification(withResolvedNotificationNavigateTarget(item))
    }
    const unsub = window.tabtin?.notification?.onShown?.(handler)
    return () => { unsub?.() }
  },
}))

registerResetAction('notification', 'reset', () => useNotificationStore.getState().clearAll())
