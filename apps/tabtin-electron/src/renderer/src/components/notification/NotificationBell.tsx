import React from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '@utils/cn'
import { RailNotificationIcon } from '@components/layout/activityRailIcons'
import { RailIconTooltip } from '@components/layout/activityRailTooltip'
import {
  ACTIVITY_RAIL_ICON_SIZE,
  ACTIVITY_RAIL_ITEM,
  ACTIVITY_RAIL_ITEM_ACTIVE,
  ACTIVITY_RAIL_ITEM_INACTIVE,
  SIDEBAR_CHROME_ACTION,
  SIDEBAR_CHROME_ICON_SIZE,
} from '@components/layout/sidebarUi'

import { getCurrentLanguage } from '@/i18n'
import { useInvitationInboxStore } from '@stores/useInvitationInboxStore'
import { useNotificationStore } from '@stores/useNotificationStore'
import { useAppPageStore } from '@stores/useAppPageStore'
import {
  selectLocalNotificationCenterItems,
  useUnreadCountQuery,
} from '@/hooks/queries/notification'
import {
  resolveNotificationBadgeCount,
  syncNotificationBadge,
} from '@/services/notificationBadge'

/**
 * 通知入口 — 自定义「信息」图标 + 角标。
 *
 * 面板 UI 迁到透明 modal 子窗口（overlay.html?role=modal），盖在所有 crawl view 之上、
 * 不再走 overlayCount 让 crawl view 避让闪烁。点击铃铛把铃铛屏幕坐标 + 当前 organizationId
 * 推给子窗口；面板内的导航 / markRead 等动作回传主 renderer 执行（保证角标等缓存同步）。
 */
export const NotificationBell: React.FC<{ size?: 'default' | 'rail' }> = ({ size = 'default' }) => {
  const { t } = useTranslation('common')
  const buttonRef = React.useRef<HTMLButtonElement>(null)
  const [open, setOpen] = React.useState(false)

  const organizationId = useNotificationStore((state) => state.currentOrganizationId)
  const notifications = useNotificationStore((state) => state.notifications)
  const notificationCenterOpen = useAppPageStore((state) => state.activePage === 'notification')
  const pendingInvitations = useInvitationInboxStore((state) => state.pending)
  const refreshPending = useInvitationInboxStore((state) => state.refreshPending)

  const { data: unreadCount = 0 } = useUnreadCountQuery(organizationId)
  const badgeCount = resolveNotificationBadgeCount(unreadCount, pendingInvitations.length)
  const localNotifications = React.useMemo(
    () => selectLocalNotificationCenterItems(notifications, organizationId),
    [notifications, organizationId],
  )

  // 系统任务栏 / Dock 与用户实际看到的铃铛角标共用同一派生值。
  // pending invitations 独立于通知查询刷新，因此必须在这里随 UI 状态同步。
  React.useEffect(() => {
    syncNotificationBadge(unreadCount, pendingInvitations.length)
  }, [pendingInvitations.length, unreadCount])

  // 子窗口面板关闭（clickaway / 点击后）→ 同步主 renderer open 状态，保证 toggle 逻辑正确。
  React.useEffect(() => {
    const unsubscribe = window.tabtin?.overlay?.onNotificationClosed?.(() => setOpen(false))
    return () => {
      unsubscribe?.()
    }
  }, [])

  const handleToggle = () => {
    const next = !open
    const rect = buttonRef.current?.getBoundingClientRect()
    setOpen(next)
    if (next) {
      void refreshPending()
    }
    void window.tabtin?.overlay?.push({
      type: 'notification',
      open: next,
      anchor: rect
        ? {
            x: Math.round(rect.x),
            y: Math.round(rect.y),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
          }
        : undefined,
      organizationId: organizationId ?? null,
      locale: getCurrentLanguage(),
      localNotifications,
    })
  }

  const label = t('notification.title')
  const button = (
    <button
      ref={buttonRef}
      type="button"
      onClick={handleToggle}
      aria-label={label}
      aria-current={notificationCenterOpen ? 'page' : undefined}
      className={cn(
        'relative transition-colors',
        size === 'rail'
          ? cn(
              ACTIVITY_RAIL_ITEM,
              notificationCenterOpen ? ACTIVITY_RAIL_ITEM_ACTIVE : ACTIVITY_RAIL_ITEM_INACTIVE,
            )
          : cn('flex items-center justify-center', SIDEBAR_CHROME_ACTION),
      )}
      title={size === 'rail' ? undefined : label}
    >
      <RailNotificationIcon
        size={size === 'rail' ? ACTIVITY_RAIL_ICON_SIZE : SIDEBAR_CHROME_ICON_SIZE}
        className="text-current"
      />
      {badgeCount > 0 && (
        <span className="absolute -top-0.5 -right-0.5 min-w-[14px] h-3.5 flex items-center justify-center rounded-full bg-destructive text-caption font-medium leading-none text-white px-0.5 tabular-nums animate-in zoom-in-50 duration-200">
          {badgeCount > 99 ? '99+' : badgeCount}
        </span>
      )}
    </button>
  )

  if (size === 'rail') {
    return <RailIconTooltip label={label}>{button}</RailIconTooltip>
  }

  return button
}
