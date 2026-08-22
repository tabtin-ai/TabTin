import type { RollbackPreviewResult } from '../../../../services/chatExtraApi'

type TabdataPreview = NonNullable<
  NonNullable<NonNullable<RollbackPreviewResult['impact']>['tabdata']>['tables_affected'][number]['preview']
>

export function buildTabdataChangeLabels(
  changes: NonNullable<
    NonNullable<NonNullable<RollbackPreviewResult['impact']>['tabdata']>['tables_affected'][number]['changes']
  >,
  t: (key: string, opts?: Record<string, unknown>) => string,
): string[] {
  const labels: string[] = []
  if (changes.records_inserted > 0) {
    labels.push(t('rewind.tabdataInserted', { count: changes.records_inserted, defaultValue: '新增 {{count}} 行' }))
  }
  if (changes.records_updated > 0) {
    labels.push(t('rewind.tabdataUpdated', { count: changes.records_updated, defaultValue: '更新 {{count}} 行' }))
  }
  if (changes.records_deleted > 0) {
    labels.push(t('rewind.tabdataDeleted', { count: changes.records_deleted, defaultValue: '删除 {{count}} 行' }))
  }
  return labels
}

export function buildTabdataPreviewLabels(
  preview: TabdataPreview,
  t: (key: string, opts?: Record<string, unknown>) => string,
): string[] {
  const labels: string[] = []
  if (preview.records_to_restore > 0) {
    labels.push(t(
      preview.records_to_restore > 5000
        ? 'rewind.tabdataPreviewRestoreApprox'
        : 'rewind.tabdataPreviewRestoreExact',
      { count: preview.records_to_restore, defaultValue: '回滚后约 {{count}} 行将被恢复' },
    ))
  }
  if (preview.records_to_create > 0) {
    labels.push(t('rewind.tabdataPreviewCreate', { count: preview.records_to_create, defaultValue: '回滚后将重新出现 {{count}} 行' }))
  }
  if (preview.records_to_delete > 0) {
    labels.push(t('rewind.tabdataPreviewDelete', { count: preview.records_to_delete, defaultValue: '回滚后 {{count}} 行将消失' }))
  }
  if (preview.fields_to_restore.length > 0) {
    labels.push(t('rewind.tabdataPreviewFields', { count: preview.fields_to_restore.length, defaultValue: '字段结构变更：{{count}} 个' }))
  }
  if (preview.estimated_duration_ms > 1000) {
    labels.push(t('rewind.tabdataPreviewDuration', {
      seconds: Math.round(preview.estimated_duration_ms / 1000),
      defaultValue: '预计 {{seconds}} 秒（仅供参考）',
    }))
  }
  return labels
}
