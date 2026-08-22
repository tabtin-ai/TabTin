import React from 'react'
import { HardDrive, AlertTriangle, Info } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useQueryClient } from '@tanstack/react-query'
import type { Organization } from '@tabtin/app-shell'
import { formatBytes } from '@/utils/formatBilling'
import { cn } from '@utils/cn'
import { OVERLAY_SURFACE_CLASS } from '@components/ui'
import {
  useStorageOverviewQuery,
  useStorageByModuleQuery,
  useStorageByMemberQuery,
  useStorageByFileTypeQuery,
  useStorageLargeFilesQuery,
} from '@/hooks/queries/storage'
import { SettingsPanelHeader } from '../SettingsPanelHeader'
import { SettingsPanelLayout } from '../SettingsPanelLayout'
import { SettingsSection } from '../SettingsSection'
import { SettingsLink } from '../SettingsLink'
import { SettingsBadge } from '../SettingsBadge'
import { MeterBar } from '../MeterBar'
import { SETTINGS_HINT, SETTINGS_ROW_HOVER, SETTINGS_TEXT_MICRO } from '../settingsUi'
import { useSettingsSpaceStore } from '@stores/useSettingsSpaceStore'

interface Props {
  organization: Organization
}

const MODULE_ICONS: Record<string, string> = {
  chat: '💬',
  tabdata: '📊',
  tabdoc: '📄',
  tabslide: '📑',
  tabsite: '🌐',
  media_generation: '✨',
  crawl: '🔗',
  other: '📁',
}

const FILE_TYPE_ICONS: Record<string, string> = {
  image: '🖼️',
  video: '🎥',
  audio: '🎵',
  document: '📎',
  archive: '📦',
  other: '📄',
}

export const OrganizationStorageDashboard: React.FC<Props> = ({ organization }) => {
  const { t } = useTranslation('settings')
  const queryClient = useQueryClient()
  const setRoute = useSettingsSpaceStore((s) => s.setRoute)

  const overviewQuery = useStorageOverviewQuery(organization.id)
  const byModuleQuery = useStorageByModuleQuery(organization.id)
  const byMemberQuery = useStorageByMemberQuery(organization.id)
  const byFileTypeQuery = useStorageByFileTypeQuery(organization.id)
  const largeFilesQuery = useStorageLargeFilesQuery(organization.id)

  const overview = overviewQuery.data ?? null
  const byModule = byModuleQuery.data ?? []
  const byMember = byMemberQuery.data ?? []
  const byFileType = byFileTypeQuery.data ?? []
  const largeFiles = largeFilesQuery.data ?? []

  React.useEffect(() => {
    const handler = () => {
      void queryClient.invalidateQueries({
        predicate: (q) => {
          const k = q.queryKey
          return k[0] === 'storage' && k[2] === organization.id
        },
      })
    }
    window.addEventListener('billing:refresh', handler)
    return () => window.removeEventListener('billing:refresh', handler)
  }, [queryClient, organization.id])

  const loading = overviewQuery.isLoading
  const error = overviewQuery.isError

  const usedBytes = overview?.used_bytes ?? 0
  const quotaBytes = overview?.quota_bytes ?? 0
  const usedPct = quotaBytes > 0 ? Math.round(Math.min(usedBytes / quotaBytes, 1) * 100) : 0
  const maxModuleBytes = byModule.length > 0 ? byModule[0].total_bytes : 1
  const maxMemberBytes = byMember.length > 0 ? byMember[0].total_bytes : 1
  const maxFileTypeBytes = byFileType.length > 0 ? byFileType[0].total_bytes : 1

  return (
    <SettingsPanelLayout>
      <SettingsPanelHeader
        icon={<HardDrive className="h-5 w-5" />}
        title={t('storage.title')}
        subtitle={t('storage.subtitle')}
      />

      {loading && (
        <div className="flex items-center justify-center py-20 text-body text-muted-foreground/60">
          <span className="inline-block h-4 w-4 mr-2 rounded-full border-2 border-muted-foreground/30 border-t-muted-foreground animate-spin" />
          {t('common:loading', { defaultValue: '加载中...' })}
        </div>
      )}

      {!loading && error && (
        <div className="py-16 text-center text-body text-muted-foreground/60 space-y-3">
          <p>{t('storage.errorState')}</p>
          <SettingsLink onClick={() => void overviewQuery.refetch()}>
            {t('common:retry')}
          </SettingsLink>
        </div>
      )}

      {!loading && !error && overview && overview.file_count === 0 && (
        <div className="py-16 text-center text-body text-muted-foreground/60">
          {t('storage.emptyState')}
        </div>
      )}

      {!loading && !error && overview && overview.file_count > 0 && (
        <div className="space-y-6">
          {/* Warning / Critical banners */}
          {usedPct >= 80 && (
            <div className={cn(
              'flex items-center justify-between rounded-[12px] px-3 py-2 text-body',
              usedPct >= 95
                ? 'bg-destructive/10 border border-destructive/30 text-destructive'
                : 'bg-warning/10 border border-warning/30 text-warning',
            )}>
              <span className="flex items-center gap-2">
                <AlertTriangle className="h-[1em] w-[1em]" />
                {usedPct >= 95 ? t('storage.criticalBanner') : t('storage.warningBanner')}
              </span>
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  className="text-body hover:underline"
                  onClick={() => {
                    const el = document.getElementById('storage-large-files')
                    el?.scrollIntoView({ behavior: 'smooth' })
                  }}
                >
                  {t('storage.viewLargeFiles')}
                </button>
                <button
                  type="button"
                  className="text-body hover:underline"
                  onClick={() => setRoute({ category: 'organization', section: 'membership' })}
                >
                  {t('storage.upgradePlan')}
                </button>
              </div>
            </div>
          )}

          {/* Section 1: Overview */}
          <SettingsSection title={t('storage.overview')}>
            <div className="flex items-center justify-between text-body mb-2">
              <span className="text-muted-foreground/60">{t('storage.quotaLabel')}</span>
              <span className="tabular-nums font-medium text-foreground">
                {quotaBytes > 0
                  ? `${formatBytes(usedBytes)} / ${formatBytes(quotaBytes)}`
                  : formatBytes(usedBytes)}
              </span>
            </div>
            <MeterBar value={usedBytes} max={quotaBytes} variant="threshold" />
            <div className="flex items-center gap-1 mt-2">
              <span className={SETTINGS_HINT}>
                {t('storage.fileCount', { count: overview.file_count })}
              </span>
              <div className="group relative ml-1 inline-flex">
                <button type="button" className="outline-none" aria-label={t('storage.footnote')}>
                  <Info className="h-3.5 w-3.5 text-muted-foreground/60 cursor-help" />
                </button>
                <div role="tooltip" className={cn('absolute bottom-full left-0 mb-1 hidden group-hover:block group-focus-within:block z-dropdown w-64 rounded-interactive px-3 py-2', SETTINGS_HINT, OVERLAY_SURFACE_CLASS)}>
                  {t('storage.footnote')}
                </div>
              </div>
            </div>
          </SettingsSection>

          {/* Section 2: By Module */}
          <SettingsSection title={t('storage.byModule')}>
            <div className="space-y-0.5">
              {byModule.map((m, i) => (
                <MeterBar
                  key={m.module}
                  icon={MODULE_ICONS[m.module] || MODULE_ICONS.other}
                  label={t(`storage.modules.${m.module}`, { defaultValue: m.display_name })}
                  value={m.total_bytes}
                  max={maxModuleBytes}
                  colorIndex={i}
                  valueLabel={formatBytes(m.total_bytes)}
                  className="py-1"
                />
              ))}
            </div>
          </SettingsSection>

          {/* Section 3: By File Type */}
          <SettingsSection title={t('storage.byFileType')}>
            <div className="space-y-0.5">
              {byFileType.map((ft, i) => (
                <MeterBar
                  key={ft.file_type}
                  icon={FILE_TYPE_ICONS[ft.file_type] || FILE_TYPE_ICONS.other}
                  label={t(`storage.fileTypes.${ft.file_type}`, { defaultValue: ft.file_type })}
                  value={ft.total_bytes}
                  max={maxFileTypeBytes}
                  colorIndex={i}
                  valueLabel={formatBytes(ft.total_bytes)}
                  className="py-1"
                />
              ))}
            </div>
          </SettingsSection>

          {/* Section 4: By Member */}
          {byMember.length > 0 && (
            <SettingsSection
              title={
                <span className="flex items-center gap-2">
                  {t('storage.byMember')}
                  <SettingsBadge tone="muted">{t('common:roles.admin', { defaultValue: 'Admin' })}</SettingsBadge>
                </span>
              }
            >
              <div className="space-y-0.5">
                {byMember.map((m, i) => (
                  <MeterBar
                    key={m.user_id}
                    icon="👤"
                    label={m.display_name || m.user_id.slice(0, 8)}
                    value={m.total_bytes}
                    max={maxMemberBytes}
                    colorIndex={i}
                    valueLabel={formatBytes(m.total_bytes)}
                    className="py-1"
                  />
                ))}
              </div>
            </SettingsSection>
          )}

          {/* Section 5: Large Files */}
          <SettingsSection
            id="storage-large-files"
            title={t('storage.largeFiles')}
            action={
              <SettingsLink onClick={() => setRoute({ category: 'organization', section: 'storageFiles' })}>
                {t('storage.viewAll')} →
              </SettingsLink>
            }
            subtitle={t('storage.largeFilesDesc')}
          >
            {largeFiles.length === 0 ? (
              <p className={cn(SETTINGS_HINT, 'py-4 text-center')}>{t('storage.noLargeFiles')}</p>
            ) : (
              <div className="space-y-0.5">
                {largeFiles.map((f) => (
                  <div key={f.file_id} className={cn('flex items-center gap-3 py-2 px-2 rounded-interactive', SETTINGS_ROW_HOVER)}>
                    <span className="w-5 text-center shrink-0">{MODULE_ICONS[f.module] || MODULE_ICONS.other}</span>
                    <div className="flex-1 min-w-0">
                      <div className="text-body truncate text-foreground">
                        {f.file_name || f.file_id}
                      </div>
                      <div className={cn(SETTINGS_HINT, 'truncate flex items-center gap-2')}>
                        <span>{f.module_display}{(f as any).context_display ? ` · ${(f as any).context_display}` : ''}</span>
                        {f.upload_user_display && <span>· {f.upload_user_display}</span>}
                        {f.created_at && <span>· {f.created_at.slice(0, 10)}</span>}
                      </div>
                    </div>
                    <span className={cn(SETTINGS_TEXT_MICRO, 'tabular-nums', 'text-muted-foreground/60 shrink-0')}>
                      {formatBytes(f.file_size)}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </SettingsSection>

          {/* Footer */}
          <div className="pt-4 flex items-center justify-between">
            <SettingsLink onClick={() => setRoute({ category: 'organization', section: 'storageFiles' })}>
              {t('storage.fileManager.title')} →
            </SettingsLink>
            <div className="flex items-center gap-3">
              <SettingsLink onClick={() => setRoute({ category: 'organization', section: 'billing' })}>
                {t('storage.viewDetails')}
              </SettingsLink>
              <SettingsLink onClick={() => setRoute({ category: 'organization', section: 'membership' })}>
                {t('storage.upgradePlan')}
              </SettingsLink>
            </div>
          </div>
        </div>
      )}
    </SettingsPanelLayout>
  )
}

OrganizationStorageDashboard.displayName = 'OrganizationStorageDashboard'
