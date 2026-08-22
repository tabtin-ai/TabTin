/**
 * 共享的 Extension 徽章组件：TypeBadge、StatusBadge、ConfigFieldCount。
 */
import React from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '@utils/cn'
import type { ExtensionConnection } from '@/services/extensionApi'

const TYPE_LABELS: Record<string, string> = {
  channel: 'Channel',
  integration: 'Integration',
}

export const TypeBadge: React.FC<{ type: string }> = ({ type }) => (
  <span className="text-caption font-medium px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
    {TYPE_LABELS[type] ?? type}
  </span>
)

export const STATUS_STYLES: Record<string, string> = {
  connected: 'bg-success/15 text-success',
  disconnected: 'bg-muted text-muted-foreground',
  error: 'bg-destructive/15 text-destructive',
  connecting: 'bg-warning/15 text-warning',
}

const STATUS_I18N: Record<string, string> = {
  connected: 'extensions.statusConnected',
  disconnected: 'extensions.statusDisconnected',
  error: 'extensions.statusError',
  connecting: 'extensions.statusConnecting',
}

export const StatusBadge: React.FC<{ status: string }> = ({ status }) => {
  const { t } = useTranslation('settings')
  return (
    <span className={cn('text-caption font-medium px-1.5 py-0.5 rounded', STATUS_STYLES[status] ?? STATUS_STYLES.disconnected)}>
      {STATUS_I18N[status] ? t(STATUS_I18N[status]) : status}
    </span>
  )
}

export function configuredFieldCount(conn: ExtensionConnection | undefined): number {
  if (!conn?.config_masked) return 0
  return Object.values(conn.config_masked).filter((v) => v != null && v !== '').length
}

export const ConfigFieldCount: React.FC<{ conn: ExtensionConnection | undefined }> = ({ conn }) => {
  const { t } = useTranslation('settings')
  const cnt = configuredFieldCount(conn)
  if (cnt <= 0) return null
  return (
    <span className="text-caption text-success font-medium">
      {t('extensions.fieldCount', { count: cnt })}
    </span>
  )
}
