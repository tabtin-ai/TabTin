/**
 * EventLog 事件日志区块，含筛选栏 + 分页列表。
 * 作为独立子组件可嵌入 OrganizationExtensionsPanel 等面板。
 */
import React, { useEffect, useMemo, useState } from 'react'
import { Activity, ChevronLeft, ChevronRight } from 'lucide-react'
import { Button } from '@tabtin/smartsheet-ui'
import { useTranslation } from 'react-i18next'
import { useShallow } from 'zustand/react/shallow'
import { useExtensionStore } from '@stores/useExtensionStore'
import type { ExtensionManifest } from '@/services/extensionApi'
import { cn } from '@utils/cn'
import { DetailedRowListSkeleton } from '@components/common/ListSkeletons'

const LOG_PAGE_SIZE = 20

const LOG_STATUS_COLORS: Record<string, string> = {
  consumed: 'bg-success/15 text-success',
  pending: 'bg-warning/15 text-warning',
  failed: 'bg-destructive/15 text-destructive',
  dispatched: 'bg-info/15 text-info',
  skipped: 'bg-muted text-muted-foreground',
}

const LOG_STATUS_I18N: Record<string, string> = {
  consumed: 'extensions.logStatusConsumed',
  pending: 'extensions.logStatusPending',
  failed: 'extensions.logStatusFailed',
  dispatched: 'extensions.logStatusDispatched',
  skipped: 'extensions.logStatusSkipped',
}

interface EventLogFilterBarProps {
  extensions: ExtensionManifest[]
  filter: { status?: string; extension_id?: string }
  onFilterChange: (filter: { status?: string; extension_id?: string }) => void
}

const EventLogFilterBar: React.FC<EventLogFilterBarProps> = ({ extensions, filter, onFilterChange }) => {
  const { t } = useTranslation('settings')
  return (
    <div className="flex items-center gap-1.5">
      <select
        value={filter.status ?? ''}
        onChange={(e) => onFilterChange({ ...filter, status: e.target.value || undefined })}
        className="h-7 rounded-md border border-input bg-background px-1.5 text-caption"
        aria-label={t('extensions.allStatuses')}
      >
        <option value="">{t('extensions.allStatuses')}</option>
        <option value="pending">{t('extensions.logStatusPending')}</option>
        <option value="consumed">{t('extensions.logStatusConsumed')}</option>
        <option value="failed">{t('extensions.logStatusFailed')}</option>
        <option value="dispatched">{t('extensions.logStatusDispatched')}</option>
        <option value="skipped">{t('extensions.logStatusSkipped')}</option>
      </select>
      {extensions.length > 0 && (
        <select
          value={filter.extension_id ?? ''}
          onChange={(e) => onFilterChange({ ...filter, extension_id: e.target.value || undefined })}
          className="h-7 rounded-md border border-input bg-background px-1.5 text-caption"
          aria-label={t('extensions.allExtensions')}
        >
          <option value="">{t('extensions.allExtensions')}</option>
          {extensions.map((ext) => (
            <option key={ext.id} value={ext.id}>{ext.name}</option>
          ))}
        </select>
      )}
    </div>
  )
}

export interface EventLogSectionProps {
  organizationId: string
  /** Caller provides the icon + title container; this component renders body only. */
  SectionWrapper: React.FC<{ icon: React.ReactNode; title: string; subtitle: string; actions: React.ReactNode; children: React.ReactNode }>
}

export const EventLogSection: React.FC<EventLogSectionProps> = ({ organizationId, SectionWrapper }) => {
  const { t } = useTranslation('settings')
  const { extensions, eventLogs, fetchEventLogs } = useExtensionStore(useShallow((s) => ({
    extensions: s.extensions,
    eventLogs: s.eventLogs,
    fetchEventLogs: s.fetchEventLogs,
  })))

  const [page, setPage] = useState(0)
  const [filter, setFilter] = useState<{ status?: string; extension_id?: string }>({})

  const extNameMap = useMemo(() => {
    const m = new Map<string, string>()
    for (const ext of extensions) m.set(ext.id, ext.name)
    return m
  }, [extensions])

  useEffect(() => {
    void fetchEventLogs(organizationId, { ...filter, limit: LOG_PAGE_SIZE, offset: page * LOG_PAGE_SIZE })
  }, [organizationId, page, filter, fetchEventLogs])

  const handleFilterChange = (f: { status?: string; extension_id?: string }) => {
    setFilter(f)
    setPage(0)
  }

  return (
    <SectionWrapper
      icon={<Activity className="h-3.5 w-3.5" />}
      title={t('extensions.eventLogs')}
      subtitle={t('extensions.eventLogsDesc')}
      actions={<EventLogFilterBar extensions={extensions} filter={filter} onFilterChange={handleFilterChange} />}
    >
      {eventLogs.loading && eventLogs.logs.length === 0 ? (
        <div className="py-1">
          <DetailedRowListSkeleton count={5} compact showPreview={false} />
        </div>
      ) : eventLogs.logs.length === 0 ? (
        <p className="text-caption text-muted-foreground py-3">
          {t('extensions.noEventLogs')}
        </p>
      ) : (
        <>
          <div className="space-y-1">
            {eventLogs.logs.map((log) => (
              <div
                key={log.id}
                className="flex items-center justify-between gap-3 rounded-md border border-border/40 px-3 py-2"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-caption font-mono truncate">{log.event_type}</span>
                    <span className={cn(
                      'text-caption font-medium px-1.5 py-0.5 rounded shrink-0',
                      LOG_STATUS_COLORS[log.status] ?? LOG_STATUS_COLORS.skipped,
                    )}>
                      {t(LOG_STATUS_I18N[log.status] ?? 'extensions.logStatusSkipped', { defaultValue: log.status })}
                    </span>
                  </div>
                  <div className="flex items-center gap-2 mt-0.5">
                    <span className="text-caption text-muted-foreground/60">{extNameMap.get(log.extension_id) ?? log.extension_id}</span>
                    <span className="text-caption text-muted-foreground/40">
                      {new Date(log.created_at).toLocaleString()}
                    </span>
                  </div>
                  {log.error_message && (
                    <p className="text-caption text-destructive/80 mt-0.5 truncate">{log.error_message}</p>
                  )}
                </div>
              </div>
            ))}
          </div>
          {eventLogs.total > LOG_PAGE_SIZE && (
            <div className="flex items-center justify-between pt-2 mt-2 border-t border-border/30">
              <span className="text-caption text-muted-foreground/60">
                {page * LOG_PAGE_SIZE + 1}–{Math.min((page + 1) * LOG_PAGE_SIZE, eventLogs.total)} / {eventLogs.total}
              </span>
              <div className="flex items-center gap-1">
                <Button variant="ghost" size="sm" disabled={page === 0} onClick={() => setPage((p) => Math.max(0, p - 1))} aria-label={t('extensions.prevPage', { defaultValue: 'Previous page' })}>
                  <ChevronLeft className="h-3.5 w-3.5" />
                </Button>
                <Button variant="ghost" size="sm" disabled={(page + 1) * LOG_PAGE_SIZE >= eventLogs.total} onClick={() => setPage((p) => p + 1)} aria-label={t('extensions.nextPage', { defaultValue: 'Next page' })}>
                  <ChevronRight className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>
          )}
        </>
      )}
    </SectionWrapper>
  )
}
