import React from 'react'
import { CheckCheck, ChevronLeft, ChevronRight, Search, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import {
  Button,
  EmptyState,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
} from '@components/ui'
import { NotificationCenterItem } from './NotificationCenterItem'
import {
  useMarkAllReadMutation,
  useMarkReadMutation,
  useNotificationCenterQuery,
  useUnreadCountQuery,
} from '@/hooks/queries/notification'
import type { NotificationItem } from '@services/notificationApi'
import { resolveNotificationNavigateTarget } from '@services/notificationTargetResolver'
import { resolveLocalizedNotificationCopy } from '@/services/resolveLocalizedNotificationCopy'
import { useAppPageStore } from '@stores/useAppPageStore'
import { useInvitationInboxStore } from '@stores/useInvitationInboxStore'
import { useNotificationStore } from '@stores/useNotificationStore'
import { formatRelativeTime } from '@/utils/formatRelativeTime'
import { createLogger } from '@/utils/logger'
import { cn } from '@utils/cn'
import {
  resolveNotificationCenterCategory,
  type NotificationCenterCategory,
} from '@services/notificationCenterCatalog'

const log = createLogger('NotificationCenter')
const PAGE_SIZE = 30

function readInvitationId(notification: NotificationItem): string | undefined {
  const raw = notification.metadata?.invitation_id ?? notification.metadata?.invitationId
  return typeof raw === 'string' && raw.trim() ? raw.trim() : undefined
}

function resolveNotificationAction(notification: NotificationItem): 'invitation' | 'navigate' | 'read' {
  const hasResolvedTarget = Boolean(resolveNotificationNavigateTarget(notification))
  const behavior = typeof notification.metadata?.behavior === 'string'
    ? notification.metadata.behavior
    : hasResolvedTarget
      ? 'view_context'
      : 'notification_only'
  if (notification.type === 'resource_access_request') return 'navigate'
  if (
    notification.type === 'organization.invitation'
    && behavior === 'action_required'
    && readInvitationId(notification)
  ) {
    return 'invitation'
  }
  if (behavior !== 'notification_only' && hasResolvedTarget) return 'navigate'
  return 'read'
}

export function NotificationCenterPage() {
  const { t } = useTranslation('common')
  const { t: tc } = useTranslation('context')
  const organizationId = useNotificationStore((state) => state.currentOrganizationId)
  const navigateToNotification = useNotificationStore((state) => state.navigateToNotification)
  const openFromNotification = useInvitationInboxStore((state) => state.openFromNotification)
  const closeAppPage = useAppPageStore((state) => state.closeAppPage)
  const [page, setPage] = React.useState(1)
  const [status, setStatus] = React.useState<'all' | 'unread'>('all')
  const [category, setCategory] = React.useState('')
  const [search, setSearch] = React.useState('')
  const [searchOpen, setSearchOpen] = React.useState(false)
  const searchRef = React.useRef<HTMLInputElement>(null)
  const deferredSearch = React.useDeferredValue(search.trim())

  const { data: unreadCount = 0 } = useUnreadCountQuery(organizationId)
  const { data, isLoading } = useNotificationCenterQuery(organizationId, {
    page,
    status,
    category,
    search: deferredSearch,
  })
  const markReadMutation = useMarkReadMutation(organizationId)
  const markAllReadMutation = useMarkAllReadMutation(organizationId)
  const items = data?.items ?? []
  const total = data?.total ?? 0
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))

  React.useEffect(() => {
    setPage(1)
  }, [status, category, deferredSearch])

  React.useEffect(() => {
    if (searchOpen) searchRef.current?.focus()
  }, [searchOpen])

  const categoryLabel = React.useCallback(
    (notification: NotificationItem) => {
      const displayCategory = resolveNotificationCenterCategory(notification)
      if (!displayCategory) return t('notification.categoryOther')
      const key: Record<NotificationCenterCategory, string> = {
        automation: 'notification.categoryAutomation',
        collaboration: 'notification.categoryCollaboration',
        organization: 'notification.categoryOrganization',
        account: 'notification.categoryAccount',
      }
      return t(key[displayCategory])
    },
    [t],
  )

  const openNotification = React.useCallback(
    (notification: NotificationItem) => {
      const action = resolveNotificationAction(notification)
      if (!notification.is_read) {
        markReadMutation.mutate({ notificationId: notification.id, wasUnread: true })
      }
      log.info('用户打开通知', { notificationId: notification.id, action })

      if (action === 'invitation') {
        closeAppPage()
        void openFromNotification(notification)
      } else if (action === 'navigate') {
        void navigateToNotification(notification)
          .then(closeAppPage)
          .catch((error) => {
            log.warn('通知目标导航失败', { notificationId: notification.id, error })
          })
      }
    },
    [closeAppPage, markReadMutation, navigateToNotification, openFromNotification],
  )

  const handleMarkAllRead = () => {
    if (unreadCount <= 0 || markAllReadMutation.isPending) return
    log.info('用户将全部通知标记为已读', { organizationId })
    markAllReadMutation.mutate()
  }

  const closeSearch = () => {
    setSearch('')
    setSearchOpen(false)
  }

  return (
    <main className="h-full min-h-0 overflow-y-auto bg-muted/20" aria-labelledby="notification-center-title">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-6 py-8">
        <header className="flex min-h-24 flex-wrap items-center justify-between gap-4 rounded-[12px] bg-background px-6 py-5">
          <div>
            <h1 id="notification-center-title" className="text-heading font-semibold text-foreground">
              {t('notification.centerTitle')}
            </h1>
            <p className="mt-1 text-body text-muted-foreground">
              {t('notification.unreadCount', { count: unreadCount })}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <div className={cn('relative transition-[width]', searchOpen ? 'w-64' : 'w-10')}>
              {searchOpen ? (
                <>
                  <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
                  <Input
                    ref={searchRef}
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Escape') closeSearch()
                    }}
                    className="h-10 w-full pl-9 pr-9 text-body"
                    placeholder={t('notification.searchPlaceholder')}
                    aria-label={t('notification.searchPlaceholder')}
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="absolute right-0 top-0 h-10 w-10"
                    onClick={closeSearch}
                    aria-label={t('close')}
                  >
                    <X className="h-4 w-4" />
                  </Button>
                </>
              ) : (
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  className="h-10 w-10"
                  onClick={() => setSearchOpen(true)}
                  aria-label={t('notification.searchAction')}
                >
                  <Search className="h-4 w-4" />
                </Button>
              )}
            </div>
            <Button
              type="button"
              variant="outline"
              className="h-10"
              disabled={unreadCount <= 0 || markAllReadMutation.isPending}
              onClick={handleMarkAllRead}
            >
              <CheckCheck className="mr-2 h-4 w-4" />
              {t('notification.markAllRead')}
            </Button>
          </div>
        </header>

        <section
          className="flex flex-wrap items-center justify-between gap-3 rounded-[12px] bg-background p-3"
          aria-label={t('notification.filters')}
        >
          <div className="flex rounded-[12px] bg-muted p-1">
            {(['all', 'unread'] as const).map((value) => (
              <Button
                key={value}
                type="button"
                variant={status === value ? 'secondary' : 'ghost'}
                className="h-9 min-w-16"
                onClick={() => setStatus(value)}
                aria-pressed={status === value}
              >
                {t(value === 'all' ? 'notification.filterAll' : 'notification.filterUnread')}
              </Button>
            ))}
          </div>
          <Select value={category || 'all'} onValueChange={(value) => setCategory(value === 'all' ? '' : value)}>
            <SelectTrigger className="h-10 w-44 text-body" aria-label={t('notification.filterCategory')}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t('notification.categoryAll')}</SelectItem>
              <SelectItem value="automation">{t('notification.categoryAutomation')}</SelectItem>
              <SelectItem value="collaboration">{t('notification.categoryCollaboration')}</SelectItem>
              <SelectItem value="organization">{t('notification.categoryOrganization')}</SelectItem>
              <SelectItem value="account">{t('notification.categoryAccount')}</SelectItem>
            </SelectContent>
          </Select>
        </section>

        <section className="flex flex-col gap-3" aria-live="polite" aria-busy={isLoading}>
          {isLoading && items.length === 0 ? (
            Array.from({ length: 5 }, (_, index) => (
              <Skeleton key={index} className="h-24 rounded-[12px]" />
            ))
          ) : items.length === 0 ? (
            <div className="rounded-[12px] bg-background">
              <EmptyState
                icon={deferredSearch ? 'search' : 'inbox'}
                title={t('notification.emptyFilteredTitle')}
                description={t('notification.emptyFilteredDescription')}
                size="lg"
              />
            </div>
          ) : (
            items.map((notification) => {
              const action = resolveNotificationAction(notification)
              const showAction = !notification.is_read && action !== 'read'
              const display = resolveLocalizedNotificationCopy(notification, t)
              const displayNotification = {
                ...notification,
                title: display.title,
                body: display.body,
              }
              return (
                <NotificationCenterItem
                  key={notification.id}
                  notification={displayNotification}
                  categoryLabel={categoryLabel(notification)}
                  timeLabel={formatRelativeTime(notification.created_at, tc)}
                  variant="page"
                  onOpen={() => openNotification(notification)}
                  actions={showAction ? (
                    <Button
                      type="button"
                      variant="soft"
                      size="sm"
                      onClick={() => openNotification(notification)}
                    >
                      {t('notification.goView')}
                    </Button>
                  ) : undefined}
                />
              )
            })
          )}
        </section>

        {totalPages > 1 ? (
          <footer className="flex items-center justify-between px-1 py-2 text-body text-muted-foreground">
            <span>{t('notification.totalCount', { count: total })}</span>
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="icon"
                disabled={page <= 1}
                onClick={() => setPage((value) => Math.max(1, value - 1))}
                aria-label={t('notification.previousPage')}
              >
                <ChevronLeft className="h-4 w-4" />
              </Button>
              <span className="min-w-16 text-center tabular-nums">{page} / {totalPages}</span>
              <Button
                type="button"
                variant="outline"
                size="icon"
                disabled={page >= totalPages}
                onClick={() => setPage((value) => Math.min(totalPages, value + 1))}
                aria-label={t('notification.nextPage')}
              >
                <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
          </footer>
        ) : null}
      </div>
    </main>
  )
}

export default NotificationCenterPage
