import React from 'react'
import { Bell, UserPlus } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useQueryClient } from '@tanstack/react-query'

import {
  Button,
  OPAQUE_OVERLAY_SURFACE_CLASS,
  ScrollArea,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
} from '@components/ui'
import { NotificationCenterItem } from '@components/notification/NotificationCenterItem'
import type { OverlayAnchorRect } from '@shared/overlay/types'
import { useInvitationInboxStore } from '@stores/useInvitationInboxStore'
import {
  prepareOptimisticMarkAllNotificationsRead,
  prepareOptimisticMarkNotificationRead,
  useNotificationCenterQuery,
  useUnreadCountQuery,
} from '@/hooks/queries/notification'
import { formatRelativeTime } from '@/utils/formatRelativeTime'
import { resolveLocalizedNotificationCopy } from '@/services/resolveLocalizedNotificationCopy'
import type { NotificationItem } from '@services/notificationApi'
import { resolveNotificationNavigateTarget } from '@services/notificationTargetResolver'
import {
  resolveNotificationCenterCategory,
  type NotificationCenterCategory,
} from '@services/notificationCenterCatalog'

const PANEL_WIDTH = 420
const PANEL_MAX_HEIGHT = 560
const PANEL_VIEWPORT_GUTTER = 8
const MAX_VISIBLE_ITEMS = 9

function readInvitationId(notification: NotificationItem): string | undefined {
  const raw = notification.metadata?.invitation_id ?? notification.metadata?.invitationId
  return typeof raw === 'string' && raw.trim() ? raw.trim() : undefined
}

type OverlayNotificationPanelProps = {
  open: boolean
  anchor?: OverlayAnchorRect
  organizationId: string | null
  onClose: () => void
}

function sendAction(payload: {
  kind: string
  notif?: unknown
  invitation?: unknown
}): void {
  window.tabtin?.overlay?.sendNotificationAction?.({ type: 'notification-action', ...payload })
}

export function OverlayNotificationPanel({
  open,
  anchor,
  organizationId,
  onClose,
}: OverlayNotificationPanelProps) {
  const { t } = useTranslation('common')
  const { t: tc } = useTranslation('context')
  const queryClient = useQueryClient()
  const panelRef = React.useRef<HTMLDivElement>(null)
  const [status, setStatus] = React.useState<'all' | 'unread'>('all')
  const [category, setCategory] = React.useState('')
  const pendingInvitations = useInvitationInboxStore((state) => state.pending)
  const refreshPending = useInvitationInboxStore((state) => state.refreshPending)
  const { data: unreadCount = 0 } = useUnreadCountQuery(organizationId)
  const { data, isLoading } = useNotificationCenterQuery(organizationId, {
    page: 1,
    status,
    category,
    search: '',
    enabled: open,
  })

  React.useEffect(() => {
    if (!open) return
    void refreshPending()
    window.requestAnimationFrame(() => panelRef.current?.focus())
  }, [open, refreshPending])

  const pendingInvitationIds = React.useMemo(
    () => new Set(pendingInvitations.map((invitation) => invitation.id)),
    [pendingInvitations],
  )
  const notifications = React.useMemo(
    () => (data?.items ?? [])
      .filter((notification) => {
        if (notification.type !== 'organization.invitation') return true
        const invitationId = readInvitationId(notification)
        return !invitationId || !pendingInvitationIds.has(invitationId)
      })
      .slice(0, MAX_VISIBLE_ITEMS),
    [data?.items, pendingInvitationIds],
  )
  const showPendingInvitations = !category || category === 'organization'
  const visiblePendingInvitations = showPendingInvitations ? pendingInvitations : []

  if (!open) return null

  const markReadInOverlayCache = (notification: NotificationItem) => {
    if (!notification.is_read) {
      void prepareOptimisticMarkNotificationRead(queryClient, organizationId, notification.id)
    }
  }
  const handleMarkReadOnly = (notification: NotificationItem) => {
    markReadInOverlayCache(notification)
    sendAction({ kind: 'mark-read', notif: notification })
  }
  const handleOpenCenterForNotification = (notification: NotificationItem) => {
    markReadInOverlayCache(notification)
    sendAction({ kind: 'open-center', notif: notification })
    onClose()
  }
  const handleNavigate = (notification: NotificationItem) => {
    markReadInOverlayCache(notification)
    sendAction({ kind: 'navigate', notif: notification })
    onClose()
  }
  const handleOpenInvitation = (notification: NotificationItem) => {
    markReadInOverlayCache(notification)
    sendAction({ kind: 'open-invitation', notif: notification })
    onClose()
  }
  const handleMarkAllRead = () => {
    void prepareOptimisticMarkAllNotificationsRead(queryClient, organizationId)
    sendAction({ kind: 'mark-all-read' })
  }
  const handleOpenCenter = (event: React.MouseEvent<HTMLButtonElement>) => {
    // modal overlay 窗口会被隐藏并复用；关闭前释放触发按钮焦点，避免下次
    // 打开时 Chromium 恢复“详情”的 focus-visible 蓝框。
    event.currentTarget.blur()
    sendAction({ kind: 'open-center' })
    onClose()
  }
  const categoryLabel = (notification: NotificationItem) => {
    const displayCategory = resolveNotificationCenterCategory(notification)
    if (!displayCategory) return t('notification.categoryOther')
    const keys: Record<NotificationCenterCategory, string> = {
      automation: 'notification.categoryAutomation',
      collaboration: 'notification.categoryCollaboration',
      organization: 'notification.categoryOrganization',
      account: 'notification.categoryAccount',
    }
    return t(keys[displayCategory])
  }

  const left = anchor
    ? Math.max(
        PANEL_VIEWPORT_GUTTER,
        Math.min(
          anchor.x + anchor.width - PANEL_WIDTH,
          window.innerWidth - PANEL_WIDTH - PANEL_VIEWPORT_GUTTER,
        ),
      )
    : window.innerWidth - PANEL_WIDTH - PANEL_VIEWPORT_GUTTER
  const spaceBelow = anchor
    ? window.innerHeight - (anchor.y + anchor.height + PANEL_VIEWPORT_GUTTER)
    : window.innerHeight
  const openUpward = Boolean(anchor && spaceBelow < PANEL_MAX_HEIGHT && anchor.y > spaceBelow)
  const top = openUpward
    ? undefined
    : anchor
      ? anchor.y + anchor.height + PANEL_VIEWPORT_GUTTER
      : PANEL_VIEWPORT_GUTTER
  const bottom = openUpward && anchor
    ? Math.min(
        window.innerHeight - PANEL_VIEWPORT_GUTTER,
        Math.max(PANEL_VIEWPORT_GUTTER, window.innerHeight - anchor.y + PANEL_VIEWPORT_GUTTER),
      )
    : undefined
  const maxHeight = Math.min(PANEL_MAX_HEIGHT, window.innerHeight - PANEL_VIEWPORT_GUTTER * 2)
  const hasItems = visiblePendingInvitations.length > 0 || notifications.length > 0

  return (
    <div
      className="pointer-events-auto fixed inset-0 z-global"
      role="presentation"
      onKeyDown={(event) => {
        if (event.key === 'Escape') onClose()
      }}
    >
      <div className="absolute inset-0" onClick={onClose} />
      <div
        ref={panelRef}
        tabIndex={-1}
        className={`absolute flex flex-col overflow-hidden rounded-2xl p-0 outline-none ${OPAQUE_OVERLAY_SURFACE_CLASS}`}
        style={{ left, top, bottom, width: PANEL_WIDTH, maxHeight }}
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-label={t('notification.title')}
      >
        <header className="flex min-h-[58px] shrink-0 items-center gap-2 px-3 pl-[18px]">
          <h2 className="text-subtitle font-semibold tracking-[-0.1px] text-foreground">
            {t('notification.title')}
          </h2>
          <span className="text-caption text-muted-foreground/75">
            {t('notification.unreadCount', { count: unreadCount })}
          </span>
          <div className="ml-auto flex items-center gap-0.5">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-[30px] rounded-[9px] px-2 text-caption"
              disabled={unreadCount <= 0}
              onClick={handleMarkAllRead}
            >
              {t('notification.markAllRead')}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-[30px] rounded-[9px] px-2 text-caption font-semibold text-primary hover:text-primary"
              onClick={handleOpenCenter}
            >
              {t('notification.details')}
            </Button>
          </div>
        </header>

        <section
          className="mx-2 flex shrink-0 items-center gap-2 border-t border-border/70 px-1.5 pb-2.5 pt-2"
          aria-label={t('notification.filters')}
        >
          <div className="inline-flex items-center gap-0.5 rounded-[10px] bg-muted p-[3px]">
            {(['all', 'unread'] as const).map((value) => (
              <Button
                key={value}
                type="button"
                variant="ghost"
                className={status === value
                  ? 'h-[29px] min-w-12 rounded-lg bg-background px-2.5 text-caption font-semibold text-foreground shadow-sm hover:bg-background'
                  : 'h-[29px] min-w-12 rounded-lg px-2.5 text-caption text-muted-foreground'}
                onClick={() => setStatus(value)}
                aria-pressed={status === value}
              >
                {t(value === 'all' ? 'notification.filterAll' : 'notification.filterUnread')}
              </Button>
            ))}
          </div>
          <Select value={category || 'all'} onValueChange={(value) => setCategory(value === 'all' ? '' : value)}>
            <SelectTrigger
              className="ml-auto h-[34px] w-28 rounded-[9px] border border-border bg-background px-2.5 py-0 text-caption text-muted-foreground"
              aria-label={t('notification.filterCategory')}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent style={{ zIndex: 'var(--z-above-global)' }}>
              <SelectItem value="all">{t('notification.categoryAll')}</SelectItem>
              <SelectItem value="automation">{t('notification.categoryAutomation')}</SelectItem>
              <SelectItem value="collaboration">{t('notification.categoryCollaboration')}</SelectItem>
              <SelectItem value="organization">{t('notification.categoryOrganization')}</SelectItem>
              <SelectItem value="account">{t('notification.categoryAccount')}</SelectItem>
            </SelectContent>
          </Select>
        </section>

        <ScrollArea className="min-h-0 flex-1 bg-muted/35">
          <div className="flex flex-col gap-2 p-2">
            {isLoading && !hasItems
              ? Array.from({ length: 4 }, (_, index) => (
                  <Skeleton key={index} className="h-[88px] rounded-[12px]" />
                ))
              : null}

            {!isLoading && !hasItems ? (
              <div
                className="flex min-h-[220px] flex-col items-center justify-center gap-2 px-7 py-7 text-center"
                role="status"
              >
                <Bell className="h-6 w-6 text-muted-foreground/35" aria-hidden="true" />
                <strong className="text-body font-medium text-muted-foreground/80">
                  {t('notification.emptyPopoverTitle')}
                </strong>
                <p className="m-0 text-caption text-muted-foreground/55">
                  {t('notification.emptyPopoverDescription')}
                </p>
              </div>
            ) : null}

            {visiblePendingInvitations.map((invitation) => {
              const inviterName = invitation.invited_by_name || t('notification.invitation.adminFallback')
              const roleLabel = t(`notification.invitation.roles.${invitation.role}`, {
                defaultValue: '',
              })
              const notification: NotificationItem = {
                id: `pending-invitation-${invitation.id}`,
                type: 'organization.invitation',
                title: t('notification.invitation.receivedFromTitle', {
                  organization: invitation.organization_name,
                }),
                body: roleLabel
                  ? t('notification.invitation.receivedByWithRole', {
                      inviter: inviterName,
                      role: roleLabel,
                    })
                  : t('notification.invitation.receivedBy', { inviter: inviterName }),
                metadata: { priority: 'normal' },
                organization_id: invitation.organization_id,
                category: 'organization',
                is_read: false,
                read_at: null,
                created_at: invitation.created_at,
              }
              return (
                <NotificationCenterItem
                  key={notification.id}
                  notification={notification}
                  categoryLabel={t('notification.categoryOrganization')}
                  timeLabel={formatRelativeTime(invitation.created_at, tc)}
                  variant="compact"
                  onOpen={() => {
                    sendAction({ kind: 'select-invitation', invitation })
                    onClose()
                  }}
                  actions={(
                    <Button
                      type="button"
                      variant="soft"
                      size="sm"
                      onClick={() => {
                        sendAction({ kind: 'select-invitation', invitation })
                        onClose()
                      }}
                    >
                      <UserPlus className="mr-1.5 h-4 w-4" />
                      {t('notification.goView')}
                    </Button>
                  )}
                />
              )
            })}

            {notifications.map((notification) => {
              const hasResolvedTarget = Boolean(resolveNotificationNavigateTarget(notification))
              const behavior = typeof notification.metadata?.behavior === 'string'
                ? notification.metadata.behavior
                : hasResolvedTarget
                  ? 'view_context'
                  : 'notification_only'
              const invitationId = readInvitationId(notification)
              const showInvitationAction = notification.type === 'organization.invitation'
                && Boolean(invitationId && pendingInvitationIds.has(invitationId))
              const showResourceAccessAction = notification.type === 'resource_access_request'
              const showScopedAction = behavior !== 'notification_only' && hasResolvedTarget
              const hasAction = showInvitationAction
                || showResourceAccessAction
                || showScopedAction
              const display = resolveLocalizedNotificationCopy(notification, t)
              const displayNotification = {
                ...notification,
                title: display.title,
                body: display.body,
              }
              const openBusinessTarget = () => {
                if (showInvitationAction) handleOpenInvitation(notification)
                else if (showResourceAccessAction || showScopedAction) handleNavigate(notification)
                else handleMarkReadOnly(notification)
              }

              return (
                <NotificationCenterItem
                  key={notification.id}
                  notification={displayNotification}
                  categoryLabel={categoryLabel(notification)}
                  timeLabel={formatRelativeTime(notification.created_at, tc)}
                  variant="compact"
                  onOpen={hasAction
                    ? openBusinessTarget
                    : () => handleOpenCenterForNotification(notification)}
                  actions={!notification.is_read && hasAction ? (
                    <Button type="button" variant="soft" size="sm" onClick={openBusinessTarget}>
                      {t('notification.goView')}
                    </Button>
                  ) : undefined}
                />
              )
            })}
          </div>
        </ScrollArea>
      </div>
    </div>
  )
}
