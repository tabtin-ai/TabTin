/**
 * Web 端通知 Zustand store — 对齐 Electron useNotificationStore
 *
 * 与 Electron 三件套 (apps/tabtin-electron/src/renderer/src/stores/useNotificationStore.ts)
 * 唯一差异:
 *  - 跳转走 navigateToWebTarget(react-router) 而非 navigateToTarget(Electron)
 *  - 无 Dock badge 同步(浏览器无该 API)
 *  - 无 window.tabtin.notification.onShown 本地推送监听(Electron 主进程才有此事件)
 *
 * 同 Electron 的"按 Organization 隔离"语义保留。
 */
import { create } from 'zustand'
import { toast } from '@tabtin/smartsheet-ui/toast'
import i18n from '@/i18n'
import {
  NotificationApiService,
  type NotificationItem,
  type NotificationNavigateTarget,
} from '@/services/notificationApi'
import {
  navigateToWebTarget,
  resolveWebNotificationNavigateTarget,
  withResolvedWebNotificationNavigateTarget,
} from '@/services/notificationNavigation'

let latestNotificationsRequestId = 0
let latestUnreadCountRequestId = 0

function isLikelySameNotification(a: NotificationItem, b: NotificationItem): boolean {
  return (
    a.type === b.type
    && a.title === b.title
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
  addNotification: (notification: NotificationItem) => void
  /**
   * @param navigate react-router useNavigate() 返回的函数;由调用方(Bell)传入
   */
  navigateToNotification: (navigate: (url: string) => void, notification: NotificationItem) => void
  setIsPanelOpen: (open: boolean) => void
  clearAll: () => void
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
    void get().loadUnreadCount()
  },

  loadNotifications: async (page = 1) => {
    const organizationId = get().currentOrganizationId
    const requestId = ++latestNotificationsRequestId
    set({ isLoading: true, error: null })
    try {
      const result = await NotificationApiService.list(page, 20, organizationId ?? undefined)
      if (requestId !== latestNotificationsRequestId || get().currentOrganizationId !== organizationId) {
        return
      }
      const normalizedItems = result.items.map(withResolvedWebNotificationNavigateTarget)
      set({
        notifications: sortNotificationsByCreatedAt(normalizedItems),
        isLoading: false,
      })
    } catch (err) {
      if (requestId !== latestNotificationsRequestId || get().currentOrganizationId !== organizationId) {
        return
      }
      set({
        error:
          err instanceof Error
            ? err.message
            : i18n.t('common:errors.loadNotificationsFailed', { defaultValue: '加载通知失败' }),
        isLoading: false,
      })
    }
  },

  loadUnreadCount: async () => {
    const organizationId = get().currentOrganizationId
    const requestId = ++latestUnreadCountRequestId
    try {
      const count = await NotificationApiService.getUnreadCount(organizationId ?? undefined)
      if (requestId !== latestUnreadCountRequestId || get().currentOrganizationId !== organizationId) {
        return
      }
      set({ unreadCount: count })
    } catch (err) {
      if (requestId !== latestUnreadCountRequestId || get().currentOrganizationId !== organizationId) {
        return
      }
      // 静默 — 与 Electron 等价(失败不阻断 UI)
      console.debug('[NotificationStore] loadUnreadCount failed:', err)
    }
  },

  markRead: async (notificationId: string) => {
    const organizationId = get().currentOrganizationId
    try {
      await NotificationApiService.markRead(notificationId)
      if (isScopeStale(get, organizationId)) return
      set((state) => {
        const target = state.notifications.find((n) => n.id === notificationId)
        if (!target || target.is_read) return state
        return {
          notifications: state.notifications.map((n) =>
            n.id === notificationId ? { ...n, is_read: true } : n,
          ),
          unreadCount: Math.max(0, state.unreadCount - 1),
        }
      })
    } catch (err) {
      console.debug('[NotificationStore] markRead failed:', err)
    }
  },

  markAllRead: async () => {
    const organizationId = get().currentOrganizationId
    const targetIds = new Set(
      get().notifications.filter((n) => !n.is_read).map((n) => n.id),
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
        return { notifications, unreadCount: nextUnreadCount }
      })
    } catch (err) {
      console.debug('[NotificationStore] markAllRead failed:', err)
    }
  },

  addNotification: (notification: NotificationItem) => {
    const wsId = get().currentOrganizationId
    if (wsId && notification.organization_id && notification.organization_id !== wsId) return
    const existing = get().notifications
    if (existing.some((n) => n.id === notification.id)) return
    if (existing.some((n) => isLikelySameNotification(n, notification))) return
    set((state) => ({
      notifications: sortNotificationsByCreatedAt([notification, ...state.notifications]),
      unreadCount: state.unreadCount + 1,
    }))
  },

  navigateToNotification: (navigate, notification) => {
    const target: NotificationNavigateTarget | undefined = resolveWebNotificationNavigateTarget(notification)
    if (target) {
      void navigateToWebTarget(navigate, target).catch(() => {})
    } else if (notification.type === 'resource_shared') {
      // Wave 4 (PRD §五块 5):resolver 对 action='removed'/'auto_removed' 主动返回 undefined,
      // 表示"不跳转,仅提示用户已无访问权限"。
      // Wave 5 §A (auto_removed_summary):owner 收到的"X 离开了团队"汇总,
      // 点击不跳转,toast 显示"无可跳转资源,信息已读"。
      const action = (notification.metadata as Record<string, unknown> | undefined)?.action
      if (action === 'removed' || action === 'auto_removed') {
        toast({
          title: i18n.t('common:share.toast.noLongerAccessible', {
            defaultValue: '你已无访问权限',
          }),
          variant: 'default',
        })
      } else if (action === 'auto_removed_summary') {
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
    set({ notifications: [], unreadCount: 0, isLoading: false, error: null, isPanelOpen: false })
  },
}))
