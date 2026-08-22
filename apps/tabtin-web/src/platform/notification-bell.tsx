/**
 * Web 端 NotificationBell — 对齐 Electron NotificationBell.tsx
 *
 * 替换 Wave 4 之前的 stub (return null)。
 *
 * 与 Electron 差异:
 *  - 跳转走 react-router useNavigate() 而非 navigateToTarget(Electron)
 *  - 列表项格式更轻量(无 tracker 双按钮,Wave 6 goal.run.* 是 Electron 专属)
 *  - 时间显示用 Intl.DateTimeFormat 本地化,不引入额外依赖
 *
 * 顶层订阅 useWebNotificationEventStream(在 Bell 组件里)— Bell 一旦 mount,
 * 就会订阅 ws-gateway notification 推送。这避免了在 AppLayout 加专门的 hook 调用,
 * 让"挂 Bell"自动等同于"接通推送"。
 */
import React, { useEffect } from 'react'
import { Bell, CheckCheck } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import {
  Button,
  ScrollArea,
  Popover,
  PopoverTrigger,
  PopoverContent,
} from '@tabtin/smartsheet-ui'
import { useOrganizationStore } from '@tabtin/app-shell'
import { useAuthStore } from '@/stores/auth-store'
import { useNotificationStore } from '@/stores/useNotificationStore'
import { useWebNotificationEventStream } from '@/services/notificationWebSocket'

const PRIORITY_STYLES: Record<string, string> = {
  urgent: 'border-l-destructive',
  high: 'border-l-amber-500',
  normal: 'border-l-transparent',
  low: 'border-l-transparent',
}

function formatRelative(value: string, locale: string): string {
  try {
    const date = new Date(value)
    const now = Date.now()
    const diff = (now - date.getTime()) / 1000 // seconds
    if (diff < 60) return locale === 'zh-CN' ? '刚刚' : 'just now'
    if (diff < 3600) {
      const m = Math.floor(diff / 60)
      return locale === 'zh-CN' ? `${m} 分钟前` : `${m}m ago`
    }
    if (diff < 86_400) {
      const h = Math.floor(diff / 3600)
      return locale === 'zh-CN' ? `${h} 小时前` : `${h}h ago`
    }
    return new Intl.DateTimeFormat(locale, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }).format(date)
  } catch {
    return value
  }
}

export const NotificationBell: React.FC = () => {
  const { t, i18n: i18nInstance } = useTranslation('common')
  const navigate = useNavigate()
  const [open, setOpen] = React.useState(false)

  // 接通用户身份 → 订阅 WS
  const userId = useAuthStore((s) => s.user?.id ?? null)
  useWebNotificationEventStream({ userId, enabled: !!userId })

  // 接通 organization scope → store 自动按 organization 隔离
  const selectedOrganizationId = useOrganizationStore((s) => s.selectedOrganization?.id ?? null)
  const setOrganizationScope = useNotificationStore((s) => s.setOrganizationScope)
  const loadUnreadCount = useNotificationStore((s) => s.loadUnreadCount)
  const loadNotifications = useNotificationStore((s) => s.loadNotifications)
  useEffect(() => {
    setOrganizationScope(selectedOrganizationId)
  }, [selectedOrganizationId, setOrganizationScope])

  // 初始 + 周期性拉一次未读数
  useEffect(() => {
    if (!userId) return
    void loadUnreadCount()
    const timer = setInterval(() => {
      void loadUnreadCount()
    }, 120_000)
    return () => clearInterval(timer)
  }, [userId, selectedOrganizationId, loadUnreadCount])

  // 打开 popover 时主动拉一次列表
  useEffect(() => {
    if (open && userId) {
      void loadNotifications()
    }
  }, [open, userId, loadNotifications])

  const notifications = useNotificationStore((s) => s.notifications)
  const unreadCount = useNotificationStore((s) => s.unreadCount)
  const isLoading = useNotificationStore((s) => s.isLoading)
  const markAllRead = useNotificationStore((s) => s.markAllRead)
  const navigateToNotification = useNotificationStore((s) => s.navigateToNotification)

  const handleNavigate = (notif: (typeof notifications)[number]) => {
    navigateToNotification(navigate, notif)
    setOpen(false)
  }

  if (!userId) return null

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="relative h-7 w-7 rounded-md flex items-center justify-center transition-colors text-muted-foreground/60 hover:text-foreground hover:bg-muted/30"
          title={t('notification.title', { defaultValue: '通知' })}
          aria-label={t('notification.title', { defaultValue: '通知' })}
          data-testid="web-notification-bell"
        >
          <Bell className="h-3.5 w-3.5" />
          {unreadCount > 0 && (
            <span className="absolute -top-1 -right-1 min-w-[16px] h-4 flex items-center justify-center rounded-full bg-destructive text-caption font-semibold text-white px-1">
              {unreadCount > 99 ? '99+' : unreadCount}
            </span>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        side="right"
        sideOffset={8}
        className="w-80 rounded-xl border bg-popover p-0 shadow-xl"
      >
        <div className="flex items-center justify-between px-4 py-3 border-b">
          <span className="text-body font-semibold">
            {t('notification.title', { defaultValue: '通知' })}
          </span>
          {unreadCount > 0 && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void markAllRead()}
              className="text-body h-7"
            >
              <CheckCheck className="h-3 w-3 mr-1" />
              {t('notification.markAllRead', { defaultValue: '全部已读' })}
            </Button>
          )}
        </div>

        <ScrollArea className="max-h-80">
          {isLoading && notifications.length === 0 && (
            <div className="py-8 text-center text-body text-muted-foreground animate-pulse">
              {t('notification.loading', { defaultValue: '加载中…' })}
            </div>
          )}
          {notifications.length === 0 && !isLoading && (
            <div className="py-8 text-center text-body text-muted-foreground">
              {t('notification.empty', { defaultValue: '暂无通知' })}
            </div>
          )}

          {notifications.map((notif) => {
            const priority = (notif.metadata?.priority as string) || notif.priority || 'normal'
            // ：成员移除转交汇总显示「成员移除」，不沿用 resource_shared
            const typeKey =
              notif.metadata?.action === 'owner_reassigned_summary'
                ? 'notification.types.owner_reassigned_summary'
                : `notification.types.${notif.type}`
            const typeLabel = t(typeKey, {
              defaultValue: t('notification.types.unknown', { defaultValue: '通知' }),
            })
            return (
              <div
                key={notif.id}
                className={[
                  'px-4 py-3 border-b border-border/30 border-l-2 hover:bg-accent/50 transition-colors cursor-pointer',
                  !notif.is_read ? 'bg-primary/5' : '',
                  PRIORITY_STYLES[priority] ?? PRIORITY_STYLES.normal,
                ]
                  .filter(Boolean)
                  .join(' ')}
                data-testid={`web-notification-item-${notif.id}`}
                onClick={() => handleNavigate(notif)}
              >
                <div className="flex items-start gap-2">
                  {!notif.is_read && (
                    <span className="mt-1.5 w-2 h-2 rounded-full bg-primary shrink-0" />
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span className="text-caption text-muted-foreground/60">{typeLabel}</span>
                    </div>
                    <p className="text-body font-medium mt-0.5">{notif.title}</p>
                    {notif.body && (
                      <p className="text-body text-muted-foreground mt-0.5 line-clamp-2">
                        {notif.body}
                      </p>
                    )}
                    <p className="text-caption text-muted-foreground/60 mt-1">
                      {formatRelative(notif.created_at, i18nInstance.language || 'zh-CN')}
                    </p>
                  </div>
                </div>
              </div>
            )
          })}
        </ScrollArea>
      </PopoverContent>
    </Popover>
  )
}
