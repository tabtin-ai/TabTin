import React from 'react'
import { Wifi, WifiOff, Loader2, Shield, ShieldAlert } from 'lucide-react'
import { cn } from '@utils/cn'
import { useTranslation } from 'react-i18next'
import type { DeviceStatus } from '@tabtin/app-shell'

interface DeviceStatusBadgeProps {
  status: DeviceStatus
  compact?: boolean
  lastHeartbeatAt?: string
}

function formatRelativeTime(isoString: string): string | null {
  const diffMs = Date.now() - new Date(isoString).getTime()
  if (isNaN(diffMs) || diffMs < 0) return null
  const diffMin = Math.floor(diffMs / 60_000)
  if (diffMin < 1) return '< 1 min'
  if (diffMin < 60) return `${diffMin} min`
  const diffHours = Math.floor(diffMin / 60)
  if (diffHours < 24) return `${diffHours} h`
  return `${Math.floor(diffHours / 24)} d`
}

export const DeviceStatusBadge: React.FC<DeviceStatusBadgeProps> = ({ status, compact, lastHeartbeatAt }) => {
  const { t } = useTranslation('space')
  const iconSize = compact ? 'h-2.5 w-2.5' : 'h-3 w-3'
  const relativeTime = lastHeartbeatAt ? formatRelativeTime(lastHeartbeatAt) : null
  const heartbeatTip = relativeTime
    ? t('device.lastHeartbeatTooltip', { defaultValue: '最后心跳: {{time}}', time: relativeTime })
    : undefined

  if (status === 'online') {
    return (
      <span className="inline-flex items-center gap-1" title={heartbeatTip}>
        <Wifi className={cn(iconSize, 'text-success')} />
        <span className="text-caption text-success">{t('device.online')}</span>
      </span>
    )
  }

  if (status === 'busy') {
    return (
      <span className="inline-flex items-center gap-1" title={heartbeatTip}>
        <Loader2 className={cn(iconSize, 'animate-spin text-warning')} />
        <span className="text-caption text-warning">{t('device.busy')}</span>
      </span>
    )
  }

  if (status === 'draining') {
    return (
      <span className="inline-flex items-center gap-1" title={heartbeatTip}>
        <Loader2 className={cn(iconSize, 'text-muted-foreground/60')} />
        <span className="text-caption text-muted-foreground/60">{t('device.draining', 'Draining')}</span>
      </span>
    )
  }

  return (
    <span className="inline-flex items-center gap-1" title={heartbeatTip}>
      <WifiOff className={cn(iconSize, compact ? 'text-muted-foreground/30' : 'text-muted-foreground/60')} />
      <span className={cn('text-caption', compact ? 'text-muted-foreground/40' : 'text-muted-foreground/60')}>
        {status === 'offline' ? t('device.offline') : t('device.unknown', { defaultValue: '未知状态' })}
      </span>
    </span>
  )
}

type SandboxStatus = 'active' | 'degraded' | 'unknown'

interface SandboxBadgeProps {
  status: SandboxStatus
}

export const SandboxBadge: React.FC<SandboxBadgeProps> = ({ status }) => {
  const { t } = useTranslation('space')

  if (status === 'active') {
    return (
      <span className="inline-flex items-center gap-0.5 text-caption text-success/80">
        <Shield className="h-2.5 w-2.5" />
        {t('device.sandboxActive', 'Sandbox')}
      </span>
    )
  }

  if (status === 'degraded') {
    return (
      <span
        className="inline-flex items-center gap-0.5 text-caption text-warning/80"
        title={t('device.sandboxDegradedTip', 'OS-level sandbox unavailable, using software-only isolation')}
      >
        <ShieldAlert className="h-2.5 w-2.5" />
        {t('device.sandboxDegraded', 'Sandbox (degraded)')}
      </span>
    )
  }

  return null
}
