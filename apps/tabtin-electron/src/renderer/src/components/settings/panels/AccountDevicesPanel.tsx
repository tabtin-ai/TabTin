import React from 'react'
import {
  Cloud,
  HelpCircle,
  Loader2,
  Monitor,
  RefreshCw,
  Server,
  Smartphone,
  type LucideIcon,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button, EmptyState } from '@components/ui'
import { SettingsBadge, type SettingsBadgeProps } from '../SettingsBadge'
import { SettingsPanelLayout } from '../SettingsPanelLayout'
import { SettingsSectionCard } from '../SettingsSectionCard'
import { SettingsSectionHeader } from '../SettingsSectionHeader'
import { SETTINGS_HINT } from '../settingsUi'
import { useAccountDevicesQuery } from '@/hooks/queries/accountDevices'
import {
  DAEMON_CONTROL_CONTROL_STATE,
  DAEMON_CONTROL_DEVICE_KIND,
  DAEMON_CONTROL_DEVICE_ROLE,
  DAEMON_CONTROL_PRESENCE,
  type AccountDevice,
} from '@/services/daemonControlApi'
import { useSpaceAgentDialogStore } from '@/stores/useSpaceAgentDialogStore'
import { cn } from '@utils/cn'

interface DeviceKindPresentation {
  icon: LucideIcon
  labelKey: string
}

function deviceKindPresentation(kind: number): DeviceKindPresentation {
  switch (kind) {
    case DAEMON_CONTROL_DEVICE_KIND.electron:
      return { icon: Monitor, labelKey: 'accountDevices.types.electron' }
    case DAEMON_CONTROL_DEVICE_KIND.daemon:
      return { icon: Server, labelKey: 'accountDevices.types.daemon' }
    case DAEMON_CONTROL_DEVICE_KIND.mobile:
      return { icon: Smartphone, labelKey: 'accountDevices.types.mobile' }
    case DAEMON_CONTROL_DEVICE_KIND.sandbox:
      return { icon: Cloud, labelKey: 'accountDevices.types.sandbox' }
    default:
      return { icon: HelpCircle, labelKey: 'accountDevices.types.unknown' }
  }
}

function presencePresentation(state: number | undefined): {
  labelKey: string
  tone: SettingsBadgeProps['tone']
} {
  switch (state) {
    case DAEMON_CONTROL_PRESENCE.online:
      return { labelKey: 'accountDevices.status.online', tone: 'success' }
    case DAEMON_CONTROL_PRESENCE.offline:
      return { labelKey: 'accountDevices.status.offline', tone: 'muted' }
    default:
      return { labelKey: 'accountDevices.status.unknown', tone: 'warning' }
  }
}

function formatLastSeen(timestamp: string | undefined, locale: string): string | null {
  if (!timestamp) return null
  const date = new Date(timestamp)
  if (Number.isNaN(date.getTime())) return null
  try {
    return new Intl.DateTimeFormat(locale || undefined, {
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(date)
  } catch {
    return date.toLocaleString()
  }
}

function versionLabel(version: string, fallback: string): string {
  const normalized = version.trim()
  if (!normalized) return fallback
  return normalized.startsWith('v') ? normalized : `v${normalized}`
}

const AccountDeviceRow: React.FC<{
  device: AccountDevice
  locale: string
  onCreateWorkspace: (device: AccountDevice) => void
}> = ({ device, locale, onCreateWorkspace }) => {
  const { t } = useTranslation('settings')
  const kind = deviceKindPresentation(device.kind)
  const presence = presencePresentation(device.presence?.state)
  const DeviceIcon = kind.icon
  const system = [device.os, device.arch].map(value => value.trim()).filter(Boolean).join(' · ')
    || t('accountDevices.notReported')
  const version = versionLabel(device.app_version, t('accountDevices.notReported'))
  const lastSeen = formatLastSeen(
    device.presence?.last_seen_at ?? device.presence?.connected_at,
    locale,
  )
  const canCreateWorkspace = (
    (
      device.kind === DAEMON_CONTROL_DEVICE_KIND.electron
      || device.kind === DAEMON_CONTROL_DEVICE_KIND.daemon
    )
    && device.roles.includes(DAEMON_CONTROL_DEVICE_ROLE.executor)
    && device.control_state === DAEMON_CONTROL_CONTROL_STATE.active
  )

  return (
    <article className="flex items-start gap-3 py-3 first:pt-0 last:pb-0">
      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-interactive bg-muted/30 text-muted-foreground/60">
        <DeviceIcon className="h-4 w-4" />
      </div>
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="truncate text-body font-medium text-foreground">
            {device.name.trim() || t('accountDevices.unnamedDevice')}
          </h3>
          <SettingsBadge tone="muted">{t(kind.labelKey)}</SettingsBadge>
          <SettingsBadge tone={presence.tone}>{t(presence.labelKey)}</SettingsBadge>
        </div>
        <p className={SETTINGS_HINT}>
          {t('accountDevices.deviceDetails', { system, version })}
        </p>
        <p className={SETTINGS_HINT}>
          {lastSeen
            ? t('accountDevices.lastSeen', { time: lastSeen })
            : t('accountDevices.neverSeen')}
        </p>
        {canCreateWorkspace ? (
          <Button
            variant="outline"
            size="sm"
            onClick={() => onCreateWorkspace(device)}
          >
            {t('accountDevices.createWorkspace')}
          </Button>
        ) : null}
      </div>
    </article>
  )
}

export const AccountDevicesPanel: React.FC = () => {
  const { t, i18n } = useTranslation('settings')
  const devicesQuery = useAccountDevicesQuery()
  const openCreateForDaemon = useSpaceAgentDialogStore(
    state => state.openCreateForDaemon,
  )
  const devices = devicesQuery.data ?? []

  return (
    <SettingsPanelLayout>
      <SettingsSectionHeader
        section="devices"
        subtitle={t('accountDevices.subtitle')}
        meta={(
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void devicesQuery.refetch()}
            disabled={devicesQuery.isFetching}
            title={t('accountDevices.refresh')}
          >
            <RefreshCw className={cn('h-4 w-4', devicesQuery.isFetching && 'animate-spin')} />
            {t('accountDevices.refresh')}
          </Button>
        )}
      />

      {devicesQuery.isLoading ? (
        <SettingsSectionCard>
          <div className="flex items-center justify-center gap-2 py-8 text-body text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            {t('accountDevices.loading')}
          </div>
        </SettingsSectionCard>
      ) : devicesQuery.isError ? (
        <SettingsSectionCard
          tone="danger"
          title={t('accountDevices.errorTitle')}
          actions={(
            <Button variant="ghost" size="sm" onClick={() => void devicesQuery.refetch()}>
              {t('accountDevices.retry')}
            </Button>
          )}
        >
          <p className="text-body text-destructive">{t('accountDevices.errorDescription')}</p>
        </SettingsSectionCard>
      ) : devices.length === 0 ? (
        <SettingsSectionCard>
          <EmptyState
            icon={<Monitor className="h-8 w-8" />}
            title={t('accountDevices.emptyTitle')}
            description={t('accountDevices.emptyDescription')}
            size="sm"
          />
        </SettingsSectionCard>
      ) : (
        <SettingsSectionCard
          title={t('accountDevices.listTitle')}
          subtitle={t('accountDevices.listCount', { count: devices.length })}
        >
          <div className="divide-y divide-border/20">
            {devices.map(device => (
              <AccountDeviceRow
                key={device.device_id}
                device={device}
                locale={i18n.resolvedLanguage ?? i18n.language}
                onCreateWorkspace={device => openCreateForDaemon({
                  installationId: device.installation_id,
                  deviceName: device.name.trim() || t('accountDevices.unnamedDevice'),
                })}
              />
            ))}
          </div>
        </SettingsSectionCard>
      )}
    </SettingsPanelLayout>
  )
}
