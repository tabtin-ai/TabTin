/**
 * TableHistoryModal - 表格级历史版本 Modal
 *
 * 布局增加多视图支持：
 * - 顶部：视图切换 Tab（Grid / Kanban / Calendar / Gallery）
 * - 左侧：只读表格快照预览，根据视图配置过滤字段
 * - 右侧：精简历史时间线（紧凑卡片，适配窄面板）
 * - 底部：操作栏（返回 + 还原按钮）
 * - 还原确认弹窗
 *
 * 自包含所有数据获取和状态管理。
 */

import React from 'react'
import { useTranslation } from 'react-i18next'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  Button,
  ScrollArea,
  ConfirmDialog,
  Input,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  toast,
  cn,
  groupOperations,
  EmptyState,
  LoadingSpinner,
  ViewTypeIcon,
  compactCellValue,
} from '@tabtin/smartsheet-ui'
import { VersionHistoryOverlayShell } from '@tabtin/collab-core'
import type { HistoryGroup } from '@tabtin/smartsheet-ui'
import type { Field, HistoryOperationOut, ViewMeta } from '@tabtin/table-core'
import { Bookmark, Bot, ChevronDown, ChevronRight, MoreHorizontal, Pencil, Plus, Trash2 } from 'lucide-react'
import { UndoRedoApiService } from '@tabtin/table-core'
import { getViewVisibilitySnapshot } from '@tabtin/table-ui'
import { HistoryTablePreview, type SnapshotRow } from './HistoryTablePreview'
import { sanitizeHistoryAttachmentValue } from './historyAttachmentValue'
import { resolveNamedVersionSnapshotKey } from './namedVersionSnapshotKey'
import { shouldAbsorbExternalHistoryRefresh } from '@components/view/tableHistoryRefresh'

export { resolveNamedVersionSnapshotKey } from './namedVersionSnapshotKey'

const TABLE_HISTORY_PAGE_SIZE = 20

export interface TableHistoryCountSummaryInput {
  versionCount: number
  translate: (key: string, options?: Record<string, unknown>) => unknown
}

export function formatTableHistoryCountSummary({
  versionCount,
  translate,
}: TableHistoryCountSummaryInput): string {
  return String(translate('table:history.timelineVersionSummary', { count: versionCount }))
}

export function resolveTableHistoryPreviewView(
  views: ViewMeta[],
  previewViewId: string | null | undefined,
  currentViewId: string | null | undefined,
): ViewMeta | null {
  if (!views.length) return null

  const previewView = previewViewId ? views.find((view) => view.id === previewViewId) : null
  if (previewView) return previewView

  const currentView = currentViewId ? views.find((view) => view.id === currentViewId) : null
  return currentView ?? views[0] ?? null
}

export function getTableHistoryPreviewFields(
  fields: Field[],
  previewView: ViewMeta | null,
): Field[] {
  if (!previewView) return fields

  const { visibleFieldIds } = getViewVisibilitySnapshot(previewView, fields)
  if (!visibleFieldIds.length) return fields

  const fieldById = new Map(fields.map((field) => [field.id, field]))
  const ordered: Field[] = []
  for (const fieldId of visibleFieldIds) {
    const field = fieldById.get(fieldId)
    if (field) ordered.push(field)
  }
  return ordered.length > 0 ? ordered : fields
}

function isRecordDeletionChange(change: HistoryGroup['changes'][number]): boolean {
  return change.fieldId === '_deleted' && change.old === false && change.new === true
}

function isDirectRecordDeleteOperation(operation: HistoryOperationOut): boolean {
  const fieldChanges = operation.field_changes
  const deletedChange = fieldChanges && typeof fieldChanges === 'object'
    ? (fieldChanges as Record<string, unknown>)._deleted
    : null
  return (
    operation.action === 'delete' &&
    !String(operation.record_id ?? '').startsWith('field:') &&
    typeof deletedChange === 'object' &&
    deletedChange !== null &&
    (deletedChange as { old?: unknown }).old === false &&
    (deletedChange as { new?: unknown }).new === true
  )
}

export function isRecordDeletionHistoryGroup(group: HistoryGroup): boolean {
  return group.action === 'delete' && group.changes.some(isRecordDeletionChange)
}

export function getDeletedRecordIdsForRestore(group: HistoryGroup | null): string[] {
  if (!group || !isRecordDeletionHistoryGroup(group)) return []
  const directDeletedIds = (group.operations as HistoryOperationOut[])
    .filter(isDirectRecordDeleteOperation)
    .map((operation) => operation.record_id)
    .filter(Boolean)
  return Array.from(new Set(directDeletedIds))
}

function shouldShowTableHistoryGroup(group: HistoryGroup): boolean {
  if (group.changes.length > 0) return true
  // Create/delete with empty data is still a meaningful user action; pure update/restore order churn is not.
  return group.action === 'create' || group.action === 'delete'
}

function filterDuplicateRecordDeletionGroups(groups: HistoryGroup[]): HistoryGroup[] {
  const seenDeletedRecordIds = new Set<string>()
  const result: HistoryGroup[] = []

  for (const group of groups) {
    const deletedRecordIds = getDeletedRecordIdsForRestore(group)
    if (deletedRecordIds.length === 0) {
      result.push(group)
      continue
    }

    const unseenDeletedIds = deletedRecordIds.filter((recordId) => !seenDeletedRecordIds.has(recordId))
    for (const recordId of deletedRecordIds) {
      seenDeletedRecordIds.add(recordId)
    }
    if (unseenDeletedIds.length === 0) continue

    const unseenSet = new Set(unseenDeletedIds)
    const retainedOperations = (group.operations as HistoryOperationOut[]).filter(
      (operation) => !isDirectRecordDeleteOperation(operation) || unseenSet.has(operation.record_id),
    )
    const retainedDeleteOperations = retainedOperations.filter(isDirectRecordDeleteOperation)
    const latestRetainedDelete = [...retainedDeleteOperations].sort((a, b) => {
      const timeA = new Date(a.created_at).getTime()
      const timeB = new Date(b.created_at).getTime()
      return timeB - timeA || b.id.localeCompare(a.id)
    })[0]

    result.push({
      ...group,
      id: latestRetainedDelete?.id ?? group.id,
      operations: retainedOperations,
      recordIds: unseenDeletedIds,
      count: unseenDeletedIds.length,
    })
  }

  return result
}

export function buildTableHistoryGroups(operations: HistoryOperationOut[]): HistoryGroup[] {
  const operationGroups = new Map<string, HistoryOperationOut[]>()
  for (const operation of operations) {
    if (!operation.operation_group_id) continue
    const bucket = operationGroups.get(operation.operation_group_id) ?? []
    bucket.push(operation)
    operationGroups.set(operation.operation_group_id, bucket)
  }

  const emittedOperationGroups = new Set<string>()
  const historyGroups: HistoryGroup[] = []
  for (const operation of operations) {
    const operationGroupId = operation.operation_group_id
    const groupedOperations = operationGroupId
      ? operationGroups.get(operationGroupId) ?? [operation]
      : [operation]

    if (operationGroupId) {
      if (emittedOperationGroups.has(operationGroupId)) continue
      emittedOperationGroups.add(operationGroupId)
    }

    const sortedGroupedOperations = [...groupedOperations].sort((a, b) => {
        const timeA = new Date(a.created_at).getTime()
        const timeB = new Date(b.created_at).getTime()
        return timeA - timeB || a.id.localeCompare(b.id)
      })
    const group = groupOperations(sortedGroupedOperations)[0]
    if (group && shouldShowTableHistoryGroup(group)) {
      historyGroups.push({
        ...group,
        startTime: sortedGroupedOperations[0]?.created_at ?? group.startTime,
        endTime: sortedGroupedOperations[sortedGroupedOperations.length - 1]?.created_at ?? group.endTime,
      })
    }
  }

  return filterDuplicateRecordDeletionGroups(historyGroups)
}

function formatVersionDateTimeRange(startIso: string, endIso: string, locale?: string): string {
  try {
    const start = new Date(startIso)
    const end = new Date(endIso)
    if (Number.isNaN(start.getTime())) return startIso

    const fmt = (date: Date) => date.toLocaleString(locale, {
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    })

    if (Number.isNaN(end.getTime()) || start.getTime() === end.getTime()) {
      return fmt(start)
    }

    return `${fmt(start)} - ${fmt(end)}`
  } catch {
    return startIso
  }
}

function getHistoryDateLabel(isoString: string, locale?: string): string {
  try {
    const date = new Date(isoString)
    if (Number.isNaN(date.getTime())) return isoString
    const today = new Date()
    if (
      date.getFullYear() === today.getFullYear() &&
      date.getMonth() === today.getMonth() &&
      date.getDate() === today.getDate()
    ) {
      return locale?.startsWith('zh') ? '今天' : 'Today'
    }
    return date.toLocaleDateString(locale, {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    })
  } catch {
    return isoString
  }
}

function groupTableHistoryByDate(groups: HistoryGroup[], locale?: string) {
  const sections: Array<{ label: string; groups: HistoryGroup[] }> = []
  let currentLabel = ''
  let currentSection: HistoryGroup[] = []

  for (const group of groups) {
    const label = getHistoryDateLabel(group.endTime, locale)
    if (label !== currentLabel) {
      if (currentSection.length > 0) {
        sections.push({ label: currentLabel, groups: currentSection })
      }
      currentLabel = label
      currentSection = [group]
    } else {
      currentSection.push(group)
    }
  }

  if (currentSection.length > 0) {
    sections.push({ label: currentLabel, groups: currentSection })
  }

  return sections
}

// VIEW_TYPE_ICONS → ViewTypeIcon from @tabtin/smartsheet-ui

// ── Action badge colors ──
const ACTION_COLORS: Record<string, string> = {
  create: 'bg-success',
  update: 'bg-info',
  delete: 'bg-destructive',
  restore: 'bg-warning',
}

// compactValue → compactCellValue from @tabtin/smartsheet-ui

const MAX_INLINE_CHANGES = 3

export function formatHistoryShortId(id: string | null | undefined): string {
  const text = String(id ?? '').trim()
  return text ? text.slice(0, 8) : ''
}

export function getDeletedFieldIdsForRestore(group: HistoryGroup | null): string[] {
  if (!group) return []
  return Array.from(new Set(
    group.changes
      .filter((change) => change.changeKind === 'field_delete')
      .map((change) => change.fieldId)
      .filter(Boolean),
  ))
}

type HistoryFieldChange = { old: unknown; new: unknown }
type HistoryFieldMeta = {
  fieldType: string
}

function stripUuidDashes(value: string): string {
  return value.replace(/-/g, '')
}

function isHistoryFieldChange(value: unknown): value is HistoryFieldChange {
  return (
    typeof value === 'object' &&
    value !== null &&
    ('old' in value || 'new' in value)
  )
}

function resolveHistoryFieldKey(fieldKey: string, fieldKeyMap: Record<string, string>): string {
  if (fieldKey.startsWith('_')) return fieldKey
  return fieldKeyMap[fieldKey] ?? fieldKeyMap[stripUuidDashes(fieldKey)] ?? fieldKey
}

function mergeHistoryChange(
  changes: Record<string, HistoryFieldChange>,
  fieldKey: string,
  oldValue: unknown,
  newValue: unknown,
) {
  const existing = changes[fieldKey]
  changes[fieldKey] = existing
    ? { old: existing.old, new: newValue }
    : { old: oldValue, new: newValue }
}

function normalizeTableHistoryOperation(
  operation: HistoryOperationOut,
  fieldKeyMap: Record<string, string>,
): HistoryOperationOut {
  const fieldChanges: Record<string, HistoryFieldChange> = {}

  for (const [rawKey, rawValue] of Object.entries(operation.field_changes ?? {})) {
    if (rawKey === 'data' && rawValue && typeof rawValue === 'object' && !Array.isArray(rawValue)) {
      for (const [dataKey, dataValue] of Object.entries(rawValue as unknown as Record<string, unknown>)) {
        mergeHistoryChange(
          fieldChanges,
          resolveHistoryFieldKey(dataKey, fieldKeyMap),
          null,
          dataValue,
        )
      }
      continue
    }

    const fieldKey = resolveHistoryFieldKey(rawKey, fieldKeyMap)
    if (isHistoryFieldChange(rawValue)) {
      mergeHistoryChange(fieldChanges, fieldKey, rawValue.old, rawValue.new)
    } else {
      mergeHistoryChange(fieldChanges, fieldKey, null, rawValue)
    }
  }

  const itemMap = new Map<string, NonNullable<HistoryOperationOut['items']>[number]>()
  for (const item of operation.items ?? []) {
    const fieldKey = resolveHistoryFieldKey(item.field_key, fieldKeyMap)
    const existing = itemMap.get(fieldKey)
    itemMap.set(fieldKey, existing
      ? { ...existing, after: item.after }
      : { ...item, field_key: fieldKey })
  }

  return {
    ...operation,
    field_changes: fieldChanges,
    items: [...itemMap.values()],
  }
}

function normalizeTableHistoryOperations(
  operations: HistoryOperationOut[],
  fieldKeyMap: Record<string, string>,
): HistoryOperationOut[] {
  return operations.map((operation) => normalizeTableHistoryOperation(operation, fieldKeyMap))
}

function getRecordDeletionChange(group: HistoryGroup) {
  return group.changes.find((change) => change.fieldId === '_deleted')
}

function getRecordChangeSummary(
  group: HistoryGroup,
  t: ReturnType<typeof useTranslation>['t'],
): string | null {
  if (group.action !== 'delete') return null
  const deletionChange = getRecordDeletionChange(group)
  if (!deletionChange) return null

  const count = group.recordIds.length || group.count || 1
  if (deletionChange.old === false && deletionChange.new === true) {
    return String(t('table:history.deletedRecords', { count }))
  }
  if (deletionChange.old === true && deletionChange.new === false) {
    return String(t('table:history.restoredRecords', { count }))
  }
  return null
}

function getRestoreChangeSummary(group: HistoryGroup): string | null {
  if (group.action !== 'restore') return null
  const restoreChange = group.changes.find((change) => change.fieldId === 'restore')
  const restoreValue = restoreChange?.new
  if (restoreValue && typeof restoreValue === 'object' && 'name' in restoreValue) {
    return String((restoreValue as { name?: unknown }).name || '')
  }
  return group.action_display || null
}

function resolveHistoryDisplayFieldName(
  fieldId: string,
  fieldNameMap: Record<string, string>,
  activeFieldIds: Set<string>,
  t: ReturnType<typeof useTranslation>['t'],
): string {
  if (fieldId === '_deleted') return String(t('table:history.recordDeletedState'))
  if (fieldId === '_order') return String(t('table:history.recordOrder'))
  const name = fieldNameMap[fieldId] || fieldNameMap[stripUuidDashes(fieldId)]
  if (!name) return String(t('table:history.deletedField'))
  const isActive =
    activeFieldIds.has(fieldId) || activeFieldIds.has(stripUuidDashes(fieldId))
  if (isActive) return name
  return String(t('table:history.historicalField', { name }))
}

function formatHistoryChangeValue(
  fieldId: string,
  fieldType: string | null | undefined,
  value: unknown,
  t: ReturnType<typeof useTranslation>['t'],
): string {
  if (fieldId === '_deleted') {
    return value === true
      ? String(t('table:history.recordDeleted'))
      : String(t('table:history.recordExists'))
  }
  return compactCellValue(sanitizeHistoryAttachmentValue(fieldType, value))
}

// ── View conversation button (agent traceability) ──

function ViewConversationButton({ agentRunId }: { agentRunId: string }) {
  const { t } = useTranslation(['chat'])

  const handleClick = React.useCallback(
    async (e: React.MouseEvent) => {
      e.stopPropagation()
      try {
        const { navigateToConversationFromVersionPanel } = await import(
          '@/components/collab/versionPanelConversationNavigation'
        )
        await navigateToConversationFromVersionPanel(agentRunId)
      } catch { /* best-effort */ }
    },
    [agentRunId],
  )

  return (
    <button
      type="button"
      className="text-caption text-accent hover:underline ml-2"
      onClick={handleClick}
    >
      {t('chat:checkpoint.viewConversation')}
    </button>
  )
}

// ── Version item with field-level diff ──

function VersionItem({
  group,
  fieldNameMap,
  activeFieldIds,
  fieldMetaMap,
  isActive,
  onClick,
}: {
  group: HistoryGroup
  fieldNameMap: Record<string, string>
  activeFieldIds: Set<string>
  fieldMetaMap: Record<string, HistoryFieldMeta>
  isActive: boolean
  onClick: () => void
}) {
  const { t, i18n } = useTranslation(['table'])
  const [expanded, setExpanded] = React.useState(false)
  const isRecordDeletion = isRecordDeletionHistoryGroup(group)
  const restoreChangeSummary = getRestoreChangeSummary(group)
  const recordChangeSummary = getRecordChangeSummary(group, t)
  const displayChanges = React.useMemo(
    () => group.changes.filter((change) => (
      change.fieldId !== '_deleted' &&
      change.fieldId !== 'restore'
    )),
    [group],
  )
  const visibleChanges = expanded
    ? displayChanges
    : displayChanges.slice(0, MAX_INLINE_CHANGES)
  const hasMore = displayChanges.length > MAX_INLINE_CHANGES
  const operationLabel = restoreChangeSummary ?? recordChangeSummary ?? (group.action === 'create' ? t('table:actions.addRow') : null)
  const deletedRecordCount = Math.max(new Set(group.recordIds).size, group.count, 1)
  const shortHistoryId = formatHistoryShortId(group.id)

  const handleCardKeyDown = React.useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault()
        onClick()
      }
    },
    [onClick],
  )

  return (
    <div
      role="button"
      tabIndex={0}
      aria-pressed={isActive}
      className={cn(
        'w-full text-left rounded-lg px-3 py-2.5 transition-all duration-150 cursor-pointer',
        'hover:bg-accent/60',
        isActive
          ? 'bg-primary/10 ring-1 ring-primary/20'
          : 'bg-transparent',
      )}
      onClick={onClick}
      onKeyDown={handleCardKeyDown}
    >
      {/* Header: action dot + user + time */}
      <div className="flex items-center gap-2">
        <div
          className={cn(
            'h-2 w-2 shrink-0 rounded-full',
            ACTION_COLORS[group.action] || 'bg-muted-foreground',
          )}
        />
        <span className="min-w-0 truncate text-body font-medium text-foreground flex items-center gap-1">
          {group.editorType === 'agent' && (
            <Bot className="h-3 w-3 shrink-0 text-info" />
          )}
          {group.user?.name || (group.editorType === 'system' ? t('table:history.systemUser') : t('table:history.unknownUser'))}
          {group.editorType === 'agent' && group.agentRunId && (
            <ViewConversationButton agentRunId={group.agentRunId} />
          )}
        </span>
        {operationLabel && (
          <span className={cn(
            'shrink-0 rounded px-1.5 py-px text-caption font-medium',
            recordChangeSummary
              ? 'bg-destructive/10 text-destructive'
              : restoreChangeSummary
                ? 'bg-warning/15 text-warning'
                : 'bg-success/15 text-success',
          )}>
            {operationLabel}
          </span>
        )}
        {group.hasUndone && !recordChangeSummary && (
          <span className="shrink-0 rounded bg-warning/15 px-1 py-px text-caption text-warning">
            {t('table:history.undone')}
          </span>
        )}
      </div>
      <div className="mt-0.5 flex items-center gap-1.5 pl-4 text-caption text-muted-foreground">
        <span className="tabular-nums">
          {formatVersionDateTimeRange(group.startTime, group.endTime, i18n.language)}
        </span>
        {group.count > 1 && (
          <span className="text-muted-foreground/40">· {t('table:history.times', { count: group.count })}</span>
        )}
        {shortHistoryId && (
          <span className="font-mono text-muted-foreground/80">{shortHistoryId}</span>
        )}
      </div>

      {/* Field-level diff (vertical layout for narrow panel) */}
      {isRecordDeletion || visibleChanges.length > 0 ? (
        <div className="mt-1.5 space-y-1 pl-4">
          {isRecordDeletion && (
            <div className="flex min-w-0 items-start gap-1.5 rounded bg-destructive/10 px-1.5 py-1 text-caption leading-snug text-destructive">
              <Trash2 className="mt-0.5 h-3 w-3 shrink-0" />
              <div className="min-w-0">
                <div className="font-semibold">
                  {t('table:history.recordDeletedCount', { count: deletedRecordCount })}
                </div>
              </div>
            </div>
          )}
          {visibleChanges.map((change) => {
            const structuralFieldName = resolveHistoryDisplayFieldName(
              change.fieldId,
              {
                ...fieldNameMap,
                ...(change.fieldName
                  ? {
                      [change.fieldId]: change.fieldName,
                      [stripUuidDashes(change.fieldId)]: change.fieldName,
                    }
                  : {}),
              },
              activeFieldIds,
              t,
            )
            const isFieldDelete = change.changeKind === 'field_delete'
            const isFieldUpdate = change.changeKind === 'field_update' || (
              change.changeKind === 'field_create' && group.action === 'update'
            )
            const isFieldCreate = change.changeKind === 'field_create' && !isFieldUpdate
            if (isFieldDelete || isFieldCreate || isFieldUpdate) {
              const label = isFieldDelete
                ? t('table:history.deletedColumn')
                : isFieldCreate
                  ? t('table:history.createdColumn')
                  : t('table:history.updatedColumn')
              return (
                <div
                  key={change.fieldId}
                  className={cn(
                    'flex min-w-0 items-center gap-1.5 rounded px-1.5 py-1 text-caption leading-snug',
                    isFieldDelete ? 'bg-destructive/10 text-destructive' : 'bg-info/10 text-info',
                  )}
                >
                  {isFieldDelete ? (
                    <Trash2 className="h-3 w-3 shrink-0" />
                  ) : (
                    <Pencil className="h-3 w-3 shrink-0" />
                  )}
                  <span className="shrink-0 font-medium">{label}</span>
                  <span className={cn('min-w-0 truncate font-semibold', isFieldDelete && 'line-through')}>
                    {structuralFieldName}
                  </span>
                </div>
              )
            }
            const resolvedFieldName = resolveHistoryDisplayFieldName(
              change.fieldId,
              fieldNameMap,
              activeFieldIds,
              t,
            )
            const fieldName = resolvedFieldName
            const fieldType = (
              fieldMetaMap[change.fieldId] ??
              fieldMetaMap[stripUuidDashes(change.fieldId)]
            )?.fieldType
            const oldValue = formatHistoryChangeValue(
              change.fieldId,
              fieldType,
              change.old,
              t,
            )
            const newValue = formatHistoryChangeValue(
              change.fieldId,
              fieldType,
              change.new,
              t,
            )
            return (
              <div key={change.fieldId} className="min-w-0 text-caption leading-snug">
                <span className="font-medium text-muted-foreground/80">
                  {fieldName}
                </span>
                <div className="mt-px flex items-center gap-1">
                  <span
                    className="max-w-[80px] truncate text-destructive/60 line-through"
                    title={oldValue}
                  >
                    {oldValue}
                  </span>
                  <svg
                    width="8"
                    height="8"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="3"
                    className="shrink-0 text-muted-foreground/30"
                    aria-hidden="true"
                  >
                    <line x1="5" y1="12" x2="19" y2="12" />
                    <polyline points="12 5 19 12 12 19" />
                  </svg>
                  <span
                    className="max-w-[80px] truncate text-success"
                    title={newValue}
                  >
                    {newValue}
                  </span>
                </div>
              </div>
            )
          })}
          {hasMore && !expanded && (
            <button
              type="button"
              className="text-caption text-primary/60 transition-colors hover:text-primary"
              onClick={(e) => {
                e.stopPropagation()
                setExpanded(true)
              }}
            >
              {t('table:history.moreChanges', { count: displayChanges.length - MAX_INLINE_CHANGES })}
            </button>
          )}
        </div>
      ) : operationLabel ? (
        <div className="mt-1.5 pl-4 text-caption text-muted-foreground/60">
          {operationLabel}
        </div>
      ) : null}
    </div>
  )
}

// ── Named version item ──

/**
 * VH 命名版本的前端类型（从 collab VH API 返回的格式）。
 * 兼容旧 TableNamedVersion 类型，向后兼容 deprecated tabdata 端点。
 */
interface VHNamedVersion {
  id: string
  table_id?: string
  history_id?: string | null
  snapshot_at?: string | null
  name: string
  created_by?: string | null
  created_at?: string | null
}

function NamedVersionItem({
  version,
  isActive,
  onClick,
  onRename,
  onDelete,
}: {
  version: VHNamedVersion
  isActive: boolean
  onClick: () => void
  onRename?: (v: VHNamedVersion) => void
  onDelete?: (v: VHNamedVersion) => void
}) {
  const { t } = useTranslation(['table'])
  const time = (version.snapshot_at || version.created_at) ? new Date(version.snapshot_at || version.created_at!) : null
  const timeStr = time && !Number.isNaN(time.getTime())
    ? time.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    : '-'

  return (
    <button
      type="button"
      className={cn(
        'group relative w-full text-left rounded-lg px-3 py-2.5 transition-all duration-150 cursor-pointer',
        'hover:bg-accent/60 border border-warning/30',
        isActive
          ? 'bg-primary/10 ring-1 ring-primary/20'
          : 'bg-transparent',
      )}
      onClick={onClick}
    >
      <div className="flex items-center gap-2">
        <Bookmark className="h-3.5 w-3.5 shrink-0 fill-warning text-warning" />
        <span className="flex-1 min-w-0 truncate text-body font-semibold text-warning">
          {version.name || t('table:history.unnamedVersion')}
        </span>

        {(onRename || onDelete) && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <span
                role="button"
                tabIndex={0}
                className="ml-auto shrink-0 opacity-0 group-hover:opacity-100 transition-opacity p-0.5 rounded hover:bg-accent"
                onClick={(e) => e.stopPropagation()}
                onKeyDown={(e) => { if (e.key === 'Enter') e.stopPropagation() }}
              >
                <MoreHorizontal className="h-3.5 w-3.5 text-muted-foreground" />
              </span>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-32">
              {onRename && (
                <DropdownMenuItem onClick={(e) => { e.stopPropagation(); onRename(version) }}>
                  <Pencil className="h-3.5 w-3.5" />
                  {t('table:history.rename')}
                </DropdownMenuItem>
              )}
              {onDelete && (
                <DropdownMenuItem
                  className="text-destructive"
                  onClick={(e) => { e.stopPropagation(); onDelete(version) }}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  {t('table:history.delete')}
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
      <div className="mt-0.5 flex items-center gap-1.5 pl-5 text-caption text-muted-foreground">
        <span className="tabular-nums">{timeStr}</span>
        <span className="flex items-center gap-1 text-success/80">
          <Bookmark className="h-3 w-3" />
          {t('table:history.permanentlyKept')}
        </span>
      </div>
    </button>
  )
}

// ── Day section header ──

function DaySectionHeader({
  label,
  count,
  collapsed,
  onToggle,
}: {
  label: string
  count: number
  collapsed: boolean
  onToggle: () => void
}) {
  return (
    <button
      type="button"
      className="flex w-full items-center gap-1.5 px-3 pb-1 pt-3 text-left transition-colors first:pt-1 hover:text-foreground"
      aria-expanded={!collapsed}
      onClick={onToggle}
    >
      {collapsed ? (
        <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground/60" />
      ) : (
        <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground/60" />
      )}
      <span className="text-caption font-semibold uppercase tracking-wider text-muted-foreground/80">
        {label}
      </span>
      <span className="text-caption text-muted-foreground/40">({count})</span>
    </button>
  )
}

// ── Compact timeline list ──

function CompactTimeline({
  groups,
  operations,
  total,
  loading,
  onLoadMore,
  fieldNameMap,
  activeFieldIds,
  fieldMetaMap,
  activeGroupId,
  onGroupClick,
  loadError,
  onRetry,
}: {
  groups: HistoryGroup[]
  operations: HistoryOperationOut[]
  total: number
  loading: boolean
  onLoadMore?: () => void
  fieldNameMap: Record<string, string>
  activeFieldIds: Set<string>
  fieldMetaMap: Record<string, HistoryFieldMeta>
  activeGroupId: string | null
  onGroupClick: (group: HistoryGroup) => void
  loadError?: boolean
  onRetry?: () => void
}) {
  const { i18n } = useTranslation()
  const sentinelRef = React.useRef<HTMLDivElement>(null)
  const isLoadingRef = React.useRef(false)
  const [collapsedSections, setCollapsedSections] = React.useState<Set<string>>(() => new Set())

  React.useEffect(() => {
    isLoadingRef.current = loading
  }, [loading])

  const sections = React.useMemo(() => groupTableHistoryByDate(groups, i18n.language), [groups, i18n.language])
  const toggleSection = React.useCallback((label: string) => {
    setCollapsedSections((prev) => {
      const next = new Set(prev)
      if (next.has(label)) {
        next.delete(label)
      } else {
        next.add(label)
      }
      return next
    })
  }, [])

  // Infinite scroll with ref-based guard to prevent duplicate triggers
  React.useEffect(() => {
    const sentinel = sentinelRef.current
    if (!sentinel || !onLoadMore) return
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting && !isLoadingRef.current && operations.length < total) {
          onLoadMore()
        }
      },
      { rootMargin: '200px' },
    )
    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [onLoadMore, operations.length, total])

  const hasMore = operations.length < total

  const { t } = useTranslation(['table'])

  if (loading && operations.length === 0) {
    return <LoadingSpinner size="xs" text={String(t('table:history.loading'))} className="py-12" textClassName="text-body" />
  }

  if (operations.length === 0) {
    if (loadError) {
      return (
        <div className="flex flex-col items-center gap-2 py-8 text-muted-foreground">
          <span>{t('table:history.loadFailed')}</span>
          {onRetry && (
            <Button variant="ghost" size="sm" onClick={onRetry}>
              {t('common:retry')}
            </Button>
          )}
        </div>
      )
    }
    return (
      <EmptyState
        icon="clock"
        title={String(t('table:history.noChanges'))}
        size="sm"
      />
    )
  }

  return (
    <div className="space-y-0.5">
      {sections.map((section) => (
        <div key={section.label}>
          <DaySectionHeader
            label={section.label}
            count={section.groups.length}
            collapsed={collapsedSections.has(section.label)}
            onToggle={() => toggleSection(section.label)}
          />
          {!collapsedSections.has(section.label) && (
            <div className="space-y-0.5 px-1">
              {section.groups.map((group) => (
                <VersionItem
                  key={group.id}
                  group={group}
                  fieldNameMap={fieldNameMap}
                  activeFieldIds={activeFieldIds}
                  fieldMetaMap={fieldMetaMap}
                  isActive={activeGroupId === group.id}
                  onClick={() => onGroupClick(group)}
                />
              ))}
            </div>
          )}
        </div>
      ))}

      {hasMore && (
        <div ref={sentinelRef} className="flex justify-center py-2">
          {loading ? (
            <LoadingSpinner size="xs" text={String(t('table:history.loading'))} inline textClassName="text-caption" />
          ) : (
            <button
              type="button"
              className="text-caption text-muted-foreground/60 transition-colors hover:text-foreground"
              onClick={onLoadMore}
            >
              {t('table:history.loadMore')}
            </button>
          )}
        </div>
      )}
    </div>
  )
}

// ── View switcher tabs ──

function ViewTabs({
  views,
  selectedViewId,
  onSelectView,
}: {
  views: ViewMeta[]
  selectedViewId: string | null
  onSelectView: (viewId: string) => void
}) {
  if (views.length <= 1) return null

  return (
    <div className="flex shrink-0 items-center gap-1 border-b bg-muted/30 px-4 py-1.5">
      {views.map((view) => (
        <button
          key={view.id}
          type="button"
          className={cn(
            'flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-body font-medium transition-colors',
            selectedViewId === view.id
              ? 'bg-background text-foreground'
              : 'text-muted-foreground hover:bg-background/60 hover:text-foreground',
          )}
          onClick={() => onSelectView(view.id)}
        >
          <span className="shrink-0 text-muted-foreground">
            <ViewTypeIcon type={view.view_type || 'grid'} />
          </span>
          <span className="max-w-[100px] truncate">{view.name}</span>
        </button>
      ))}
    </div>
  )
}

// ── Main Modal ──

interface TableHistoryModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  tableId: string
  tableName: string
  fields: Field[]
  views?: ViewMeta[]
  currentViewId?: string | null
  /** 外部表格数据变化标记；面板打开时变化会触发历史刷新 */
  refreshKey?: string
  /** 只读模式下禁用还原操作 */
  isReadonly?: boolean
  /** 还原成功后的回调（刷新表格数据，并按服务端同步模式决定是否重连） */
  onRestoreSuccess?: (info?: { syncMode?: string }) => void | Promise<void>
}

export const TableHistoryModal: React.FC<TableHistoryModalProps> = ({
  open,
  onOpenChange,
  tableId,
  tableName,
  fields,
  views = [],
  currentViewId: externalCurrentViewId = null,
  refreshKey = '',
  isReadonly = false,
  onRestoreSuccess,
}) => {
  const { t } = useTranslation(['table', 'common'])

  // ── View state ──
  const [previewViewId, setPreviewViewId] = React.useState<string | null>(null)

  const selectedView = React.useMemo(() => {
    return resolveTableHistoryPreviewView(views, previewViewId, externalCurrentViewId)
  }, [views, previewViewId, externalCurrentViewId])

  // Compute visible fields based on the selected view
  const viewFilteredFields = React.useMemo(() => {
    return getTableHistoryPreviewFields(fields, selectedView)
  }, [selectedView, fields])

  // ── History list state ──
  const [historyOps, setHistoryOps] = React.useState<HistoryOperationOut[]>([])
  const [historyTotal, setHistoryTotal] = React.useState(0)
  const [isLoadingHistory, setIsLoadingHistory] = React.useState(false)
  const [nextCursor, setNextCursor] = React.useState<string | null>(null)

  // ── Named versions state (using VH API) ──
  const [namedVersions, setNamedVersions] = React.useState<VHNamedVersion[]>([])
  const [showSaveVersion, setShowSaveVersion] = React.useState(false)
  const [versionName, setVersionName] = React.useState('')
  const [isSavingVersion, setIsSavingVersion] = React.useState(false)
  const [renamingVersion, setRenamingVersion] = React.useState<VHNamedVersion | null>(null)
  const [renameValue, setRenameValue] = React.useState('')
  const [deletingVersion, setDeletingVersion] = React.useState<VHNamedVersion | null>(null)

  // ── History load error state ──
  const [loadError, setLoadError] = React.useState(false)

  // ── Snapshot state ──
  const [snapshotRows, setSnapshotRows] = React.useState<SnapshotRow[]>([])
  const [snapshotTruncated, setSnapshotTruncated] = React.useState(false)
  const [snapshotLoading, setSnapshotLoading] = React.useState(false)
  const snapshotRequestIdRef = React.useRef(0)
  const historyRequestIdRef = React.useRef(0)
  const namedVersionsRequestIdRef = React.useRef(0)
  const lastRefreshKeyRef = React.useRef(refreshKey)
  const skipNextExternalRefreshRef = React.useRef(false)

  // ── Active version state ──
  const [activeGroupId, setActiveGroupId] = React.useState<string | null>(null)
  const [activeGroup, setActiveGroup] = React.useState<HistoryGroup | null>(null)
  // ── Restore state ──
  const [restoreLoading, setRestoreLoading] = React.useState(false)
  const [showRestoreConfirm, setShowRestoreConfirm] = React.useState(false)

  // ── Field maps (all fields for timeline display) ──
  const fieldKeyMap = React.useMemo(() => {
    const map: Record<string, string> = {}
    for (const f of fields) {
      map[f.id] = f.id
      map[stripUuidDashes(f.id)] = f.id
    }
    return map
  }, [fields])

  const fieldMetaMap = React.useMemo(() => {
    const map: Record<string, HistoryFieldMeta> = {}
    for (const f of fields) {
      const meta = {
        fieldType: f.field_type,
      }
      map[f.id] = meta
      map[stripUuidDashes(f.id)] = meta
    }
    return map
  }, [fields])
  const fieldListSignature = React.useMemo(
    () => fields.map((field) => [
      field.id,
      field.name,
      field.field_type,
      field.sort_order,
      field.is_hidden,
      field.updated_at,
    ].join(':')).join('|'),
    [fields],
  )
  const previousFieldListSignatureRef = React.useRef(fieldListSignature)

  // ── Grouped operations (shared between timeline and named version lookup) ──
  const normalizedHistoryOps = React.useMemo(
    () => normalizeTableHistoryOperations(historyOps, fieldKeyMap),
    [fieldKeyMap, historyOps],
  )
  const historyGroups = React.useMemo(() => buildTableHistoryGroups(normalizedHistoryOps), [normalizedHistoryOps])

  // : 历史时间线结构变更携带字段名；合并进 name map，避免已删字段
  // 一律显示「已删除字段」。必须在 historyGroups 之后计算。
  // 软删仍在 ORM 的字段走「名称（历史字段）」；仅物理回收后才显示「已删除字段」。
  const activeFieldIds = React.useMemo(() => {
    const ids = new Set<string>()
    for (const f of fields) {
      ids.add(f.id)
      ids.add(stripUuidDashes(f.id))
    }
    return ids
  }, [fields])
  const fieldNameMap = React.useMemo(() => {
    const map: Record<string, string> = {}
    for (const f of fields) {
      map[f.id] = f.name
      map[stripUuidDashes(f.id)] = f.name
    }
    for (const group of historyGroups) {
      for (const change of group.changes) {
        if (!change.fieldId || !change.fieldName) continue
        if (change.fieldId.startsWith('_')) continue
        if (!map[change.fieldId]) {
          map[change.fieldId] = change.fieldName
          map[stripUuidDashes(change.fieldId)] = change.fieldName
        }
      }
    }
    return map
  }, [fields, historyGroups])

  const timelineCountSummary = React.useMemo(() => {
    if (historyGroups.length <= 0) return null
    return formatTableHistoryCountSummary({
      versionCount: historyGroups.length,
      translate: t,
    })
  }, [historyGroups.length, t])
  const historyGroupById = React.useMemo(() => {
    const map = new Map<string, HistoryGroup>()
    for (const g of historyGroups) {
      map.set(g.id, g)
      for (const op of g.operations) {
        if (op.id) map.set(op.id, g)
      }
    }
    return map
  }, [historyGroups])

  // ── Fetch history ──
  const fetchHistory = React.useCallback(
    async (cursor: string | null = null) => {
      if (!tableId) return
      const requestId = historyRequestIdRef.current + 1
      historyRequestIdRef.current = requestId
      setLoadError(false)
      // 后台刷新保留现有列表；仅首屏空列表时展示 loading
      setIsLoadingHistory(true)
      try {
        const result = await UndoRedoApiService.getTableHistory(tableId, {
          cursor: cursor ?? undefined,
          include_undone: true,
          only_my_operations: false,
          limit: TABLE_HISTORY_PAGE_SIZE,
        })
        if (historyRequestIdRef.current !== requestId) return
        const operations = result.operations ?? result.history_list ?? []
        setHistoryOps((prev) => (cursor ? [...prev, ...operations] : operations))
        setHistoryTotal(result.total)
        setNextCursor(result.next_cursor ?? null)
      } catch (error) {
        if (historyRequestIdRef.current !== requestId) return
        console.error('[TableHistoryModal] fetchHistory failed:', error)
        setLoadError(true)
        toast({
          title: String(t('table:toolbar.snapshotFailed')),
          description: error instanceof Error ? error.message : undefined,
          variant: 'destructive',
        })
      } finally {
        if (historyRequestIdRef.current === requestId) {
          setIsLoadingHistory(false)
        }
      }
    },
    [tableId, t],
  )

  const handleLoadMore = React.useCallback(() => {
    if (isLoadingHistory || !nextCursor) return
    void fetchHistory(nextCursor)
  }, [fetchHistory, isLoadingHistory, nextCursor])

  // ── Fetch named versions (via deprecated tabdata endpoint → proxied to VH) ──
  const fetchNamedVersions = React.useCallback(async () => {
    if (!tableId) return
    const requestId = namedVersionsRequestIdRef.current + 1
    namedVersionsRequestIdRef.current = requestId
    try {
      const versions = await UndoRedoApiService.listTableNamedVersions(tableId)
      if (namedVersionsRequestIdRef.current !== requestId) return
      setNamedVersions(versions as VHNamedVersion[])
    } catch {
      // non-critical
    }
  }, [tableId])

  // ── Named version actions ──
  // ：侧栏有选中历史时保存左侧预览快照；未选中则拍当前表
  const saveTargetsSnapshot = Boolean(activeGroupId)
  const saveVersionActionLabel = saveTargetsSnapshot
    ? String(t('table:history.saveVersionSnapshot'))
    : String(t('table:history.saveVersionCurrent'))

  const handleSaveVersion = React.useCallback(async () => {
    if (!tableId || isReadonly) return
    setIsSavingVersion(true)
    try {
      const now = new Date()
      const dateStr = now.toLocaleDateString()
      const defaultName = `${saveVersionActionLabel} ${namedVersions.length + 1} — ${dateStr}`
      const name = versionName.trim() || defaultName
      await UndoRedoApiService.createTableNamedVersion(tableId, {
        name,
        ...(activeGroupId ? { history_id: activeGroupId } : {}),
      })
      setShowSaveVersion(false)
      setVersionName('')
      await fetchNamedVersions()
    } catch (err) {
      toast({
        title: String(t('table:history.saveVersionFailed')),
        description: err instanceof Error ? err.message : undefined,
        variant: 'destructive',
      })
    } finally {
      setIsSavingVersion(false)
    }
  }, [
    tableId,
    versionName,
    namedVersions.length,
    fetchNamedVersions,
    t,
    activeGroupId,
    isReadonly,
    saveVersionActionLabel,
  ])

  const handleRenameVersion = React.useCallback(async () => {
    if (!tableId || !renamingVersion || isReadonly) return
    try {
      await UndoRedoApiService.renameTableNamedVersion(tableId, renamingVersion.id, { name: renameValue.trim() })
      setRenamingVersion(null)
      setRenameValue('')
      await fetchNamedVersions()
    } catch {
      // error handled by API service
    }
  }, [tableId, renamingVersion, renameValue, fetchNamedVersions, isReadonly])

  const handleDeleteVersion = React.useCallback(async () => {
    if (!tableId || !deletingVersion || isReadonly) return
    try {
      await UndoRedoApiService.deleteTableNamedVersion(tableId, deletingVersion.id)
      await fetchNamedVersions()
    } catch {
      // error handled by API service
    }
  }, [tableId, deletingVersion, fetchNamedVersions, isReadonly])

  // ── Fetch snapshot ──
  const fetchSnapshot = React.useCallback(
    async (historyId: string) => {
      if (!tableId || !historyId) return
      const requestId = snapshotRequestIdRef.current + 1
      snapshotRequestIdRef.current = requestId
      setSnapshotLoading(true)
      setSnapshotRows([])
      setSnapshotTruncated(false)
      try {
        const result = await UndoRedoApiService.getTableSnapshot(tableId, historyId)
        if (snapshotRequestIdRef.current !== requestId) return
        const records = Array.isArray(result?.snapshot) ? result.snapshot : []
        const sorted = [...records].sort((a, b) => {
          const orderA = typeof a.order === 'number' ? a.order : 0
          const orderB = typeof b.order === 'number' ? b.order : 0
          return orderA - orderB
        })
        setSnapshotRows(
          sorted.map((r) => {
            const record = r as typeof r & { is_deleted?: boolean }
            return {
              record_id: record.record_id,
              row_id: record.row_id,
              order: record.order,
              is_deleted: record.is_deleted,
              data: record.data ?? {},
            }
          }),
        )
        setSnapshotTruncated(result?.is_truncated === true)
      } catch (error) {
        if (snapshotRequestIdRef.current !== requestId) return
        setSnapshotRows([])
        setSnapshotTruncated(false)
        toast({
          title: String(t('table:toolbar.snapshotFailed')),
          description: error instanceof Error ? error.message : undefined,
          variant: 'destructive',
        })
      } finally {
        if (snapshotRequestIdRef.current === requestId) {
          setSnapshotLoading(false)
        }
      }
    },
    [tableId, t],
  )

  // ── Handle version selection ──
  const handleVersionChange = React.useCallback(
    (group: HistoryGroup) => {
      if (activeGroupId === group.id) return
      setActiveGroupId(group.id)
      setActiveGroup(group)
      void fetchSnapshot(group.id)
    },
    [activeGroupId, fetchSnapshot],
  )

  // ── Handle restore ──
  const handleRestore = React.useCallback(async () => {
    if (!tableId || !activeGroupId || isReadonly) return
    setRestoreLoading(true)
    try {
      const result = await UndoRedoApiService.restoreTable(tableId, {
        history_id: activeGroupId,
      })
      toast({
        title: String(t('table:history.restoreSuccess')),
      })
      setShowRestoreConfirm(false)
      // 还原成功会自行拉一次历史；吞掉随后 refreshKey 变化触发的重复刷新
      skipNextExternalRefreshRef.current = true
      await onRestoreSuccess?.({ syncMode: result.sync_mode })
      setActiveGroupId(null)
      setActiveGroup(null)
      setSnapshotRows([])
      setSnapshotTruncated(false)
      await Promise.all([fetchHistory(null), fetchNamedVersions()])
    } catch (error) {
      skipNextExternalRefreshRef.current = false
      toast({
        title: String(t('table:history.restoreFailed')),
        description: error instanceof Error ? error.message : undefined,
        variant: 'destructive',
      })
    } finally {
      setRestoreLoading(false)
    }
  }, [tableId, activeGroupId, onRestoreSuccess, fetchHistory, fetchNamedVersions, isReadonly, t])

  React.useEffect(() => {
    if (!isReadonly) return
    setShowSaveVersion(false)
    setRenamingVersion(null)
    setDeletingVersion(null)
    setShowRestoreConfirm(false)
  }, [isReadonly])

  // ── Reset state when modal opens/closes ──
  React.useEffect(() => {
    if (open) {
      setHistoryOps([])
      setHistoryTotal(0)
      setNextCursor(null)
      setActiveGroupId(null)
      setActiveGroup(null)
      setSnapshotRows([])
      setSnapshotTruncated(false)
      setSnapshotLoading(false)
      setPreviewViewId(resolveTableHistoryPreviewView(views, null, externalCurrentViewId)?.id ?? null)
      setShowSaveVersion(false)
      setRenamingVersion(null)
      setDeletingVersion(null)
      snapshotRequestIdRef.current += 1
      historyRequestIdRef.current += 1
      namedVersionsRequestIdRef.current += 1
      lastRefreshKeyRef.current = refreshKey
      void fetchHistory(null)
      void fetchNamedVersions()
    }
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps -- only trigger on open change

  React.useEffect(() => {
    if (!open) return
    setPreviewViewId((currentPreviewViewId) => {
      if (currentPreviewViewId && views.some((view) => view.id === currentPreviewViewId)) {
        return currentPreviewViewId
      }
      return resolveTableHistoryPreviewView(views, null, externalCurrentViewId)?.id ?? null
    })
  }, [externalCurrentViewId, open, views])

  React.useEffect(() => {
    if (!open) {
      previousFieldListSignatureRef.current = fieldListSignature
      return
    }
    if (previousFieldListSignatureRef.current === fieldListSignature) return
    previousFieldListSignatureRef.current = fieldListSignature
    void fetchHistory(null)
  }, [fieldListSignature, open, fetchHistory])

  React.useEffect(() => {
    if (!open) {
      lastRefreshKeyRef.current = refreshKey
      skipNextExternalRefreshRef.current = false
      return
    }
    const decision = shouldAbsorbExternalHistoryRefresh({
      open,
      restoreLoading,
      skipNextExternalRefresh: skipNextExternalRefreshRef.current,
      previousKey: lastRefreshKeyRef.current,
      nextKey: refreshKey,
    })
    if (decision === 'ignore') return

    if (decision === 'absorb') {
      // 还原进行中不推进 key，失败后仍能 refresh；成功 skip 则推进并消费 skip
      if (skipNextExternalRefreshRef.current && !restoreLoading) {
        skipNextExternalRefreshRef.current = false
        lastRefreshKeyRef.current = refreshKey
      }
      return
    }

    lastRefreshKeyRef.current = refreshKey
    setActiveGroupId(null)
    setActiveGroup(null)
    setSnapshotRows([])
    setSnapshotTruncated(false)
    setSnapshotLoading(false)
    snapshotRequestIdRef.current += 1
    void fetchHistory(null)
    void fetchNamedVersions()
  }, [fetchHistory, fetchNamedVersions, open, refreshKey, restoreLoading])

  if (!open) return null

  return (
    <>
      <VersionHistoryOverlayShell
        title={String(t('table:history.modalTitle'))}
        subtitle={tableName}
        onClose={() => onOpenChange(false)}
        contentHeader={(
          <ViewTabs
            views={views}
            selectedViewId={selectedView?.id ?? null}
            onSelectView={setPreviewViewId}
          />
        )}
        left={(
          <>
            <HistoryTablePreview
              fields={viewFilteredFields}
              allFields={fields}
              rows={snapshotRows}
              loading={snapshotLoading}
              activeGroup={activeGroup}
              isTruncated={snapshotTruncated}
              previewView={selectedView}
              fieldNameMap={fieldNameMap}
            />
          </>
        )}
        leftClassName="flex flex-1 flex-col overflow-hidden border-r bg-muted/20"
        right={(
          <>
            <div className="shrink-0 border-b px-3 py-2.5">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-1.5">
                  <span className="text-body font-medium">
                    {String(t('table:history.timelineTitle'))}
                  </span>
                  {timelineCountSummary && (
                    <span className="text-caption text-muted-foreground/60">
                      {timelineCountSummary}
                    </span>
                  )}
                </div>
                {!isReadonly && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 gap-1 px-2 text-body"
                    onClick={() => {
                      const now = new Date()
                      const dateStr = now.toLocaleDateString()
                      setVersionName(`${saveVersionActionLabel} ${namedVersions.length + 1} — ${dateStr}`)
                      setShowSaveVersion(true)
                    }}
                  >
                    <Plus className="h-3.5 w-3.5" />
                    {saveVersionActionLabel}
                  </Button>
                )}
              </div>

              {/* 保存版本输入框 */}
              {!isReadonly && showSaveVersion && (
                <div className="mt-2 space-y-1.5">
                  <p className="px-0.5 text-caption text-muted-foreground/80">
                    {saveTargetsSnapshot
                      ? t('table:history.saveVersionHintSnapshot')
                      : t('table:history.saveVersionHintCurrent')}
                  </p>
                  <div className="flex gap-1.5">
                    <Input
                      placeholder={String(t('table:history.versionNamePlaceholder'))}
                      value={versionName}
                      onChange={(e: React.ChangeEvent<HTMLInputElement>) => setVersionName(e.target.value)}
                      onKeyDown={(e: React.KeyboardEvent) => {
                        if (e.key === 'Enter' && !e.nativeEvent.isComposing) void handleSaveVersion()
                        if (e.key === 'Escape') setShowSaveVersion(false)
                      }}
                      className="h-7 text-body"
                      autoFocus
                    />
                    <Button
                      size="sm"
                      className="h-7 shrink-0 px-2.5 text-body"
                      disabled={isSavingVersion}
                      onClick={() => void handleSaveVersion()}
                    >
                      {isSavingVersion ? '...' : t('table:history.save')}
                    </Button>
                  </div>
                </div>
              )}
            </div>

            <ScrollArea className="flex-1">
              <div className="py-1">
                {/* 命名版本区域 */}
                {namedVersions.length > 0 && (
                  <div className="mb-1">
                    <div className="flex items-center gap-1.5 px-3 pb-1 pt-1">
                      <span className="text-caption font-semibold uppercase tracking-wider text-warning/80">
                        {t('table:history.savedVersions')}
                      </span>
                      <span className="text-caption text-muted-foreground/40">({namedVersions.length})</span>
                    </div>
                    <div className="space-y-0.5 px-1">
                      {namedVersions.map((v) => {
                        const versionKey = resolveNamedVersionSnapshotKey(v)
                        // 时间线高亮仍可按 legacy history_id 对齐变更组
                        const timelineKey = v.history_id || v.id
                        return (
                          <NamedVersionItem
                            key={v.id}
                            version={v}
                            isActive={activeGroupId === versionKey}
                            onClick={() => {
                              if (versionKey) {
                                setActiveGroupId(versionKey)
                                setActiveGroup(historyGroupById.get(timelineKey) ?? null)
                                void fetchSnapshot(versionKey)
                              }
                            }}
                            onRename={isReadonly ? undefined : (ver) => {
                              setRenamingVersion(ver)
                              setRenameValue(ver.name || '')
                            }}
                            onDelete={isReadonly ? undefined : (ver) => setDeletingVersion(ver)}
                          />
                        )
                      })}
                    </div>
                    <div className="mx-3 my-2 border-t" />
                  </div>
                )}

                {/* 自动变更记录 */}
                <CompactTimeline
                  groups={historyGroups}
                  operations={historyOps}
                  total={historyTotal}
                  loading={isLoadingHistory}
                  onLoadMore={handleLoadMore}
                  fieldNameMap={fieldNameMap}
                  activeFieldIds={activeFieldIds}
                  fieldMetaMap={fieldMetaMap}
                  activeGroupId={activeGroupId}
                  onGroupClick={handleVersionChange}
                  loadError={loadError}
                  onRetry={() => fetchHistory(null)}
                />
              </div>
            </ScrollArea>
          </>
        )}
        footer={isReadonly ? undefined : (
          <Button
            size="sm"
            disabled={restoreLoading || !activeGroupId}
            onClick={() => setShowRestoreConfirm(true)}
          >
            {restoreLoading
              ? String(t('table:history.restoring'))
              : String(t('table:history.restoreToVersion'))}
          </Button>
        )}
      />

      {/* Restore confirmation dialog */}
      <ConfirmDialog
        open={showRestoreConfirm}
        onOpenChange={setShowRestoreConfirm}
        title={String(t('table:history.restoreConfirmTitle'))}
        description={
          activeGroup
            ? String(t('table:history.restoreConfirmDescriptionDetailed', {
                time: activeGroup.endTime
                  ? new Date(activeGroup.endTime).toLocaleString()
                  : new Date(activeGroup.startTime).toLocaleString(),
                user: activeGroup.user?.name || (activeGroup.editorType === 'system' ? t('table:history.systemUser') : t('table:history.unknownUser')),
                count: snapshotRows.length,
              }))
            : String(t('table:history.restoreConfirmDescription'))
        }
        confirmText={String(
          t('table:history.restoreToVersion'),
        )}
        cancelText={String(t('common:cancel'))}
        variant="destructive"
        onConfirm={() => {
          void handleRestore()
        }}
      />

      {/* 重命名版本弹窗 */}
      <Dialog open={!!renamingVersion} onOpenChange={(v) => { if (!v) setRenamingVersion(null) }}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>{t('table:history.renameVersion')}</DialogTitle>
          </DialogHeader>
          <div className="py-2">
            <Input
              placeholder={String(t('table:history.versionName'))}
              value={renameValue}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => setRenameValue(e.target.value)}
              onKeyDown={(e: React.KeyboardEvent) => {
                if (e.key === 'Enter' && !e.nativeEvent.isComposing) void handleRenameVersion()
              }}
              autoFocus
            />
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="outline" size="sm" onClick={() => setRenamingVersion(null)}>
              {t('common:cancel')}
            </Button>
            <Button size="sm" onClick={() => void handleRenameVersion()}>
              {t('table:history.confirm')}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* 删除版本确认弹窗 */}
      <ConfirmDialog
        open={!!deletingVersion}
        onOpenChange={(v) => { if (!v) setDeletingVersion(null) }}
        title={String(t('table:history.deleteVersion'))}
        description={String(t('table:history.deleteVersionConfirm', { name: deletingVersion?.name || String(t('table:history.unnamedVersion')) }))}
        confirmText={String(t('table:history.delete'))}
        cancelText={String(t('common:cancel'))}
        variant="destructive"
        onConfirm={() => void handleDeleteVersion()}
      />
    </>
  )
}
