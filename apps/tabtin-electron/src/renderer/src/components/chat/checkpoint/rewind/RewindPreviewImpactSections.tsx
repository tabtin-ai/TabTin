import React from 'react'
import { Package } from 'lucide-react'
import type { RollbackPreviewResult } from '../../../../services/chatExtraApi'
import {
  CHANGE_TYPE_KEYS,
  MAX_RESOURCE_PREVIEW_COUNT,
  RESOURCE_TYPE_KEYS,
  type CheckpointSemanticFeedback,
} from './deriveRewindPreviewUi'
import { ResourceRestorePlanSection } from './RewindResourceSections'
import { buildTabdataChangeLabels, buildTabdataPreviewLabels } from './tabdataImpactLabels'

interface RewindPreviewImpactSectionsProps {
  preview: RollbackPreviewResult
  noImpact: boolean
  showFileImpact: boolean
  excludedResources: Set<string>
  checkpointSemanticFeedback: CheckpointSemanticFeedback | null
  onToggleResource: (key: string) => void
  t: (key: string, opts?: Record<string, unknown>) => string
}

export const RewindPreviewImpactSections: React.FC<RewindPreviewImpactSectionsProps> = ({
  preview,
  noImpact,
  showFileImpact,
  excludedResources,
  checkpointSemanticFeedback,
  onToggleResource,
  t,
}) => (
  <>
    {!noImpact && (
      <p className="text-body text-muted-foreground">
        {showFileImpact
          ? t('rewind.briefImpactMessagesAndFiles', {
              defaultValue: '此操作将回退对话消息，并恢复相关工作区文件。',
            })
          : t('rewind.briefImpactMessagesOnly', {
              defaultValue: '此操作将回退对话消息。',
            })}
      </p>
    )}

    {preview.resource_restore_plan && preview.resource_restore_plan.length > 0 && (
      <ResourceRestorePlanSection
        resourceRestorePlan={preview.resource_restore_plan}
        excludedResources={excludedResources}
        onToggleResource={onToggleResource}
        t={t}
      />
    )}

    <RewindLegacyResourceSections preview={preview} t={t} />

    {!noImpact && (
      <RewindScopeFootnotes checkpointSemanticFeedback={checkpointSemanticFeedback} t={t} />
    )}
  </>
)

const RewindLegacyResourceSections: React.FC<{
  preview: RollbackPreviewResult
  t: RewindPreviewImpactSectionsProps['t']
}> = ({ preview, t }) => (
  <>
    {(preview.resource_changes?.length ?? 0) > 0
      && (!preview.resource_restore_plan || preview.resource_restore_plan.length === 0) && (
      <ResourceChangesSection resourceChanges={preview.resource_changes ?? []} t={t} />
    )}

    {(preview.impact?.tabdata?.tables_affected?.length ?? 0) > 0 && (
      <TabdataImpactSection preview={preview} t={t} />
    )}
  </>
)

const RewindScopeFootnotes: React.FC<{
  checkpointSemanticFeedback: CheckpointSemanticFeedback | null
  t: RewindPreviewImpactSectionsProps['t']
}> = ({ checkpointSemanticFeedback, t }) => {
  if (!checkpointSemanticFeedback?.capabilityScope.unrevert) return null
  return (
    <div className="text-caption text-muted-foreground/60 space-y-1">
      <p>{t('rewind.canUndo', { defaultValue: '在发送新消息之前，可以点击「恢复原状」撤销本次回退' })}</p>
    </div>
  )
}

const ResourceChangesSection: React.FC<{
  resourceChanges: NonNullable<RollbackPreviewResult['resource_changes']>
  t: RewindPreviewImpactSectionsProps['t']
}> = ({ resourceChanges, t }) => (
  <div className="rounded-lg border border-border bg-muted/30 p-3">
    <div className="flex items-center gap-2 mb-2">
      <Package className="h-4 w-4 text-muted-foreground" />
      <span className="text-body font-medium">{t('rewind.resourceChanges', { count: resourceChanges.length, defaultValue: '{{count}} 个资源受到影响' })}</span>
    </div>
    <div className="space-y-1 ml-6">
      {resourceChanges.slice(0, MAX_RESOURCE_PREVIEW_COUNT).map((rc) => (
        <div key={`${rc.resource_type}-${rc.resource_id}-${rc.change_type}`} className="text-body text-muted-foreground flex items-center gap-1.5">
          <span className="px-1.5 py-0.5 rounded bg-muted text-caption">{RESOURCE_TYPE_KEYS[rc.resource_type] ? t(RESOURCE_TYPE_KEYS[rc.resource_type].key, { defaultValue: RESOURCE_TYPE_KEYS[rc.resource_type].fallback }) : rc.resource_type}</span>
          <span className="px-1.5 py-0.5 rounded bg-muted text-caption">{CHANGE_TYPE_KEYS[rc.change_type] ? t(CHANGE_TYPE_KEYS[rc.change_type].key, { defaultValue: CHANGE_TYPE_KEYS[rc.change_type].fallback }) : rc.change_type}</span>
          <span className="truncate font-medium text-foreground/80">{rc.resource_name || rc.summary || rc.resource_id.slice(0, 8)}</span>
        </div>
      ))}
    </div>
  </div>
)

const TabdataImpactSection: React.FC<{
  preview: RollbackPreviewResult
  t: RewindPreviewImpactSectionsProps['t']
}> = ({ preview, t }) => {
  const tablesAffected = preview.impact?.tabdata?.tables_affected ?? []
  return (
    <div className="rounded-lg border border-border bg-muted/30 p-3">
      <div className="flex items-center gap-2 mb-2">
        <Package className="h-4 w-4 text-muted-foreground" />
        <span className="text-body font-medium">
          {t('rewind.tabdataImpactTitle', {
            count: tablesAffected.length,
            defaultValue: '数据表变更（{{count}} 张表）',
          })}
        </span>
      </div>
      <div className="space-y-2 ml-6">
        {tablesAffected.slice(0, MAX_RESOURCE_PREVIEW_COUNT).map((entry) => (
          <TabdataImpactRow key={entry.table_id} entry={entry} t={t} />
        ))}
        {tablesAffected.length > MAX_RESOURCE_PREVIEW_COUNT && (
          <div className="text-caption text-muted-foreground/60 ml-2">
            {t('rewind.tabdataMoreTables', {
              count: tablesAffected.length - MAX_RESOURCE_PREVIEW_COUNT,
              defaultValue: '...还有 {{count}} 张表',
            })}
          </div>
        )}
      </div>
    </div>
  )
}

const TabdataImpactRow: React.FC<{
  entry: NonNullable<NonNullable<RollbackPreviewResult['impact']>['tabdata']>['tables_affected'][number]
  t: RewindPreviewImpactSectionsProps['t']
}> = ({ entry, t }) => {
  const tableLabel = entry.table_name || entry.table_id.slice(0, 8)
  const changeLabels = buildTabdataChangeLabels(entry.changes, t)
  const previewLabels = entry.preview ? buildTabdataPreviewLabels(entry.preview, t) : []

  return (
    <div className="text-body text-muted-foreground space-y-0.5">
      <div className="flex items-center gap-1.5">
        <span className="px-1.5 py-0.5 rounded bg-muted text-caption">
          {t('rewind.tabdataTableLabel', { defaultValue: '数据表' })}
        </span>
        <span className="truncate font-medium text-foreground/80 max-w-[180px]" title={entry.table_name || entry.table_id}>
          {tableLabel}
        </span>
      </div>
      {changeLabels.length > 0 && (
        <div className="ml-2 text-caption flex flex-wrap gap-x-3 gap-y-0.5">
          {changeLabels.map(label => <span key={label}>{label}</span>)}
        </div>
      )}
      {previewLabels.length > 0 && (
        <div className="ml-2 text-caption text-muted-foreground/80 flex flex-wrap gap-x-3 gap-y-0.5">
          {previewLabels.map(label => <span key={label}>{label}</span>)}
        </div>
      )}
    </div>
  )
}
