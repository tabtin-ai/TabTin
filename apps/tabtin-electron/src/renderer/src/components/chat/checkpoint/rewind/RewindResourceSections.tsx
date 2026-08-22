import React from 'react'
import { Package } from 'lucide-react'
import type { RollbackPreviewResult } from '../../../../services/chatExtraApi'
import { MAX_RESOURCE_PREVIEW_COUNT, RESOURCE_TYPE_KEYS } from './deriveRewindPreviewUi'

interface ResourceRestorePlanSectionProps {
  resourceRestorePlan: NonNullable<RollbackPreviewResult['resource_restore_plan']>
  excludedResources: Set<string>
  onToggleResource: (key: string) => void
  t: (key: string, opts?: Record<string, unknown>) => string
}

const ResourceRestorePlanRow: React.FC<{
  ri: NonNullable<RollbackPreviewResult['resource_restore_plan']>[number]
  isExcluded: boolean
  onToggleResource: (key: string) => void
  t: ResourceRestorePlanSectionProps['t']
}> = ({ ri, isExcluded, onToggleResource, t }) => {
  const key = `${ri.resource_type}:${ri.resource_id}`
  const displayName = ri.resource_name || ri.resource_id.slice(0, 8)
  const typeLabel = RESOURCE_TYPE_KEYS[ri.resource_type]
    ? t(RESOURCE_TYPE_KEYS[ri.resource_type].key, { defaultValue: RESOURCE_TYPE_KEYS[ri.resource_type].fallback })
    : ri.resource_type
  const restoreVersionTime = ri.restore_to_version_time
    ? new Date(ri.restore_to_version_time)
    : null
  const formattedRestoreVersionTime = restoreVersionTime && !Number.isNaN(restoreVersionTime.getTime())
    ? restoreVersionTime.toLocaleString(undefined, {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      })
    : ri.restore_to_version_time

  return (
    <div className={`text-body text-muted-foreground ${isExcluded ? 'opacity-40' : ''}`}>
      <div className="flex items-center gap-1.5">
        {ri.can_restore && (
          <input
            type="checkbox"
            checked={!isExcluded}
            onChange={() => onToggleResource(key)}
            className="h-3 w-3 rounded border-border accent-primary shrink-0 cursor-pointer"
            aria-label={t('rewind.resourceToggle', { name: displayName, defaultValue: '回退资源：{{name}}' })}
          />
        )}
        <span className="px-1.5 py-0.5 rounded bg-muted text-caption">{typeLabel}</span>
        <span className="truncate font-medium text-foreground/80 max-w-[140px]" title={ri.resource_name || ri.resource_id}>{displayName}</span>
        {ri.can_restore && !isExcluded ? (
          <span className="px-1.5 py-0.5 rounded bg-success/10 text-success text-caption shrink-0">{ri.action_label}</span>
        ) : ri.can_restore && isExcluded ? (
          <span className="px-1.5 py-0.5 rounded bg-muted text-caption shrink-0 line-through">{t('rewind.resourceSkipped', { defaultValue: '跳过' })}</span>
        ) : (
          <span className="px-1.5 py-0.5 rounded border border-warning/30 text-warning text-caption shrink-0">{ri.action_label || t('rewind.noVersionAvailable', { defaultValue: '无版本可恢复' })}</span>
        )}
      </div>
      {ri.can_restore && !isExcluded && formattedRestoreVersionTime && (
        <p className="mt-1 ml-[18px] text-caption text-muted-foreground/70">
          {t('rewind.resourceRestoreVersionTime', {
            time: formattedRestoreVersionTime,
            defaultValue: '将恢复到 {{time}} 的版本',
          })}
        </p>
      )}
    </div>
  )
}

export const ResourceRestorePlanSection: React.FC<ResourceRestorePlanSectionProps> = ({
  resourceRestorePlan,
  excludedResources,
  onToggleResource,
  t,
}) => (
  <div className="rounded-lg border border-border bg-muted/30 p-3">
    <div className="flex items-center gap-2 mb-2">
      <Package className="h-4 w-4 text-muted-foreground" />
      <span className="text-body font-medium">{t('rewind.resourceRestorePlan', { count: resourceRestorePlan.length, defaultValue: '{{count}} 个资源将被回退' })}</span>
    </div>
    <p className="text-caption text-muted-foreground/60 ml-6 mb-1.5">{t('rewind.resourceCheckboxHint', { defaultValue: '取消勾选可跳过该资源的回退' })}</p>
    <div className="space-y-1.5 ml-6">
      {resourceRestorePlan.slice(0, MAX_RESOURCE_PREVIEW_COUNT).map((ri) => {
        const key = `${ri.resource_type}:${ri.resource_id}`
        return (
          <ResourceRestorePlanRow
            key={`${ri.resource_type}-${ri.resource_id}`}
            ri={ri}
            isExcluded={excludedResources.has(key)}
            onToggleResource={onToggleResource}
            t={t}
          />
        )
      })}
      {resourceRestorePlan.length > MAX_RESOURCE_PREVIEW_COUNT && (
        <div className="text-caption text-muted-foreground/60 ml-4">...{t('rewind.moreResources', { count: resourceRestorePlan.length - MAX_RESOURCE_PREVIEW_COUNT, defaultValue: '还有 {{count}} 个资源' })}</div>
      )}
    </div>
  </div>
)
