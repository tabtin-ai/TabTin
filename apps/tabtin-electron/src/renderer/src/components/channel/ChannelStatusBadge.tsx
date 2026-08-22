import React from 'react'
import { cn } from '@utils/cn'
import { useTranslation } from 'react-i18next'

type RuntimeStatus =
  | 'running' | 'stopped' | 'connecting' | 'reconnecting'
  | 'disconnected' | 'error' | 'unknown'
  | 'waiting_scan' | 'scanned' | 'auth_expired'

const STATUS_DOT: Record<RuntimeStatus, string> = {
  running: 'bg-success',
  stopped: 'bg-muted-foreground/60',
  connecting: 'bg-warning animate-pulse',
  reconnecting: 'bg-warning animate-pulse',
  disconnected: 'bg-muted-foreground/60',
  error: 'bg-destructive',
  unknown: 'bg-muted-foreground/40',
  waiting_scan: 'bg-warning animate-pulse',
  scanned: 'bg-warning animate-pulse',
  auth_expired: 'bg-destructive',
}

interface ChannelStatusBadgeProps {
  status?: string | null
  className?: string
}

export const ChannelStatusBadge: React.FC<ChannelStatusBadgeProps> = ({ status, className }) => {
  const { t } = useTranslation('channel')
  const key = (status ?? 'unknown') as RuntimeStatus
  const dot = STATUS_DOT[key] ?? STATUS_DOT.unknown
  return (
    <span className={cn('inline-flex items-center gap-1.5 text-body text-muted-foreground', className)}>
      <span className={cn('h-2 w-2 rounded-full shrink-0', dot)} />
      {t(`status.${key}`)}
    </span>
  )
}
