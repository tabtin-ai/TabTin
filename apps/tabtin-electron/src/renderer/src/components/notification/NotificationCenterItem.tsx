import React from 'react'

import { Button } from '@components/ui'
import type { NotificationItem } from '@services/notificationApi'
import {
  resolveNotificationCenterCategory,
  type NotificationCenterCategory,
} from '@services/notificationCenterCatalog'
import { cn } from '@utils/cn'

type NotificationDisplayCategory = NotificationCenterCategory | 'general'

const CATEGORY_STYLES: Record<NotificationDisplayCategory, string> = {
  automation: 'bg-success/10 text-success',
  collaboration: 'bg-primary/10 text-primary',
  organization: 'bg-warning/10 text-warning',
  account: 'bg-destructive/10 text-destructive',
  general: 'bg-muted text-muted-foreground',
}

export function isCriticalNotification(notification: NotificationItem): boolean {
  const priority = notification.priority || notification.metadata?.priority
  return priority === 'urgent' || priority === 'critical'
}

type NotificationCenterItemProps = {
  notification: NotificationItem
  categoryLabel: string
  timeLabel: string
  variant: 'compact' | 'page'
  onOpen: () => void
  actions?: React.ReactNode
}

export function NotificationCenterItem({
  notification,
  categoryLabel,
  timeLabel,
  variant,
  onOpen,
  actions,
}: NotificationCenterItemProps) {
  const category = resolveNotificationCenterCategory(notification) ?? 'general'
  const critical = isCriticalNotification(notification)

  return (
    <article
      className={cn(
        'relative min-w-0 rounded-[12px] border transition-[border-color,background-color,box-shadow,transform]',
        variant === 'compact'
          ? 'grid min-h-[88px] grid-cols-[52px_minmax(0,1fr)] gap-[11px] p-3'
          : 'flex min-h-24 gap-4 px-5 py-4',
        notification.is_read
          ? 'border-border/65 bg-background/60 text-muted-foreground hover:bg-background/80'
          : 'border-primary/20 bg-background shadow-[0_2px_8px_hsl(var(--foreground)/0.035)] hover:-translate-y-px hover:border-primary/30 hover:shadow-[0_7px_18px_hsl(var(--foreground)/0.08)]',
        critical && 'border-destructive/25 hover:border-destructive/35 hover:bg-destructive/[0.02]',
      )}
    >
      <Button
        type="button"
        variant="ghost"
        className="absolute inset-0 h-full w-full rounded-[12px] p-0"
        onClick={onOpen}
        aria-label={notification.title}
      />

      <div
        className={cn(
          'relative pointer-events-none flex shrink-0 items-center justify-center px-2 text-center font-semibold leading-4',
          variant === 'compact'
            ? 'h-7 w-[52px] rounded-lg text-caption'
            : 'h-12 w-20 rounded-interactive text-caption',
          CATEGORY_STYLES[category],
          notification.is_read && 'grayscale opacity-60',
        )}
      >
        {categoryLabel}
        {!notification.is_read ? (
          <span
            className={cn(
              'absolute rounded-full bg-primary ring-2 ring-background',
              variant === 'compact' ? '-right-1 -top-1 h-2 w-2' : '-right-1 -top-1 h-3 w-3',
            )}
            aria-hidden="true"
          />
        ) : null}
      </div>

      <div
        className={cn(
          'pointer-events-none relative min-w-0 flex-1',
          variant === 'page' && 'md:pr-32',
        )}
      >
        <time
          dateTime={notification.created_at}
          className={cn(
            'text-muted-foreground/60',
            variant === 'compact'
              ? 'float-right ml-3 text-caption leading-[17px]'
              : 'text-caption md:absolute md:right-0 md:top-0',
          )}
        >
          {timeLabel}
        </time>
        <h3
          className={cn(
            notification.is_read
              ? 'font-medium text-muted-foreground'
              : 'font-semibold text-foreground',
            variant === 'compact'
              ? 'mt-[3px] line-clamp-2 text-body leading-[19px]'
              : 'pr-2 text-body',
          )}
        >
          {notification.title}
        </h3>
        {notification.body ? (
          <p
            className={cn(
              'line-clamp-2 text-muted-foreground',
              variant === 'compact' ? 'mt-0.5 text-caption leading-[18px]' : 'mt-1 text-body',
              notification.is_read && 'text-muted-foreground/60',
            )}
          >
            {notification.body}
          </p>
        ) : null}
        {actions && !notification.is_read ? (
          <div
            className={cn(
              'pointer-events-auto relative z-floating flex flex-wrap items-center',
              variant === 'compact'
                ? 'mt-[9px] gap-1.5 [&>button]:h-8 [&>button]:min-w-[72px] [&>button]:rounded-[10px] [&>button]:px-3.5 [&>button]:text-caption'
                : 'mt-3 gap-2',
              variant === 'page' && 'md:absolute md:bottom-0 md:right-0 md:mt-0',
            )}
          >
            {actions}
          </div>
        ) : null}
      </div>
    </article>
  )
}
