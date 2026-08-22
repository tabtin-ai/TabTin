/**
 * HistoryTablePreview - 只读表格预览组件
 *
 * 展示历史版本的表格快照数据。
 * 当有活跃的 HistoryGroup 时，高亮变更字段列。
 * 使用 @tanstack/react-virtual 做行虚拟化，支持大数据量预览。
 *
 *
 * ## HOT_SPACE_GATE_NOT_NEEDED（Wave 5 useVirtualizer 治理审计）
 *
 * 本组件渲染在 `TableHistoryModal`（基于 Radix Dialog）内，DOM 通过 portal
 * 出口到 `document.body`。**注意 React tree 仍连着 hot Space 子树**——portal
 * 只移 DOM，不移 React parent；外层 Activity hidden 时本组件的 effect 仍会
 * 沿 React tree 走 cleanup。
 *
 * 真正不需要 `enabled: isForeground` gate 的原因：
 *
 * 1. **DOM 留在 body**：`display:none` 不会传播到 portal 出口的子节点——
 *    即使外层 hot Space 被 `display:none` 隐藏，本 Modal 容器尺寸保持稳定。
 *    ResizeObserver 在 setup 时观测到的容器尺寸**始终非零**，不会触发
 *     的 0→size 跳变模式。
 * 2. **Activity 调度兜底**：外层 hot Space hidden 时 React tree 的 effect
 *    cleanup 会经过本组件，virtualizer 内部的 ResizeObserver / 滚动监听
 *    随 effect 一起 cleanup；hidden 期间没有副作用挂在 DOM 上。这与
 *    `enabled: false` 在效果上等价。
 * 3. **Modal close → 整组件 unmount**：cold 启动，virtualizer 完全重建，
 *    无需保留 scroll 位置。所以也不接 `useScrollPositionPreserve`。
 *
 * 三条路径互补，覆盖了从 hot Space 切换、modal open/close、modal 内表格切换
 * 的所有场景。
 */

import React, { useCallback } from 'react'
import { useSafeVirtualizer } from '@hooks/useSafeVirtualizer'
import { useTranslation } from 'react-i18next'
import { EmptyState, formatCellValue, cn, ViewTypeIcon } from '@tabtin/smartsheet-ui'
import { formatFieldDisplayValue, formatAttachmentValue } from '@tabtin/table-ui'
/** Inline select choice normalizer to avoid @tabtin/table-kernel dependency */
const SELECT_PALETTE = [
  '#E53935', '#1E88E5', '#43A047', '#FB8C00', '#8E24AA',
  '#00ACC1', '#F4511E', '#3949AB', '#7CB342', '#C0CA33',
]
type SelectChoice = { value: string; label: string; color: string }
function normalizeSelectChoices(
  choices: Array<string | Record<string, unknown>> | undefined,
): SelectChoice[] {
  if (!choices || !Array.isArray(choices)) return []
  const result: SelectChoice[] = []
  const seen = new Set<string>()
  for (let i = 0; i < choices.length; i++) {
    const c = choices[i]
    if (typeof c === 'object' && c !== null) {
      const choice = c as Record<string, unknown>
      const value = String(choice.value ?? choice.id ?? choice.name ?? choice.label ?? '')
      if (!value || seen.has(value)) continue
      seen.add(value)
      result.push({
        value,
        label: String(choice.label ?? choice.name ?? value),
        color: String(choice.color ?? SELECT_PALETTE[i % SELECT_PALETTE.length]),
      })
    } else {
      const value = String(c)
      if (seen.has(value)) continue
      seen.add(value)
      result.push({ value, label: value, color: SELECT_PALETTE[i % SELECT_PALETTE.length] })
    }
  }
  return result
}
import type { HistoryGroup } from '@tabtin/smartsheet-ui'
import type { Field, ViewMeta } from '@tabtin/table-core'
import { TablePreviewSkeleton } from '@components/common/ListSkeletons'

export interface SnapshotRow {
  record_id: string
  row_id?: string
  order?: number
  is_deleted?: boolean
  data: Record<string, unknown>
  isDeletedPreview?: boolean
}

interface HistoryTablePreviewProps {
  fields: Field[]
  allFields?: Field[]
  rows?: SnapshotRow[]
  loading: boolean
  activeGroup?: HistoryGroup | null
  isTruncated?: boolean
  previewView?: ViewMeta | null
  /** : 含历史结构变更中的已删字段名，用于预览列标题 */
  fieldNameMap?: Record<string, string>
}

const ROW_HEIGHT = 36
const ROW_NUM_WIDTH = 40
const COL_MIN_WIDTH = 120
const COL_MAX_WIDTH = 200

type HistoryPreviewMode = 'grid' | 'kanban' | 'gallery' | 'calendar'

export interface HistoryKanbanPreviewGroup {
  key: string
  label: string
  rows: SnapshotRow[]
}

export interface HistoryPreviewChangeSummary {
  fieldId: string
  fieldName: string
  oldText: string
  newText: string
  changeKind?: HistoryGroup['changes'][number]['changeKind']
}

const MAX_PREVIEW_CHANGE_SUMMARY = 3

const compactFieldId = (fieldId: string): string => fieldId.replace(/-/g, '')

function getSnapshotFieldKeys(field: Field): string[] {
  const keys = [field.name, field.id, compactFieldId(field.id)].filter(Boolean)
  return Array.from(new Set(keys))
}

export function resolveSnapshotCellValue(
  rowData: Record<string, unknown>,
  field: Field,
): unknown {
  for (const key of getSnapshotFieldKeys(field)) {
    if (Object.prototype.hasOwnProperty.call(rowData, key)) {
      return rowData[key]
    }
  }
  return undefined
}

function isSnapshotFieldChanged(changedFieldIds: Set<string>, field: Field): boolean {
  return getSnapshotFieldKeys(field).some((key) => changedFieldIds.has(key))
}

export function isSnapshotRowDeleted(
  row: Pick<SnapshotRow, 'record_id' | 'row_id' | 'is_deleted'>,
  deletedRecordIds: Set<string>,
): boolean {
  return (
    deletedRecordIds.has(row.record_id) ||
    (row.row_id ? deletedRecordIds.has(row.row_id) : false)
  )
}

function getDeletedRecordIds(activeGroup?: HistoryGroup | null): Set<string> {
  const deletedChange = activeGroup?.changes.find((change) => change.fieldId === '_deleted')
  if (!deletedChange || deletedChange.old !== false || deletedChange.new !== true) {
    return new Set()
  }
  return new Set(activeGroup?.recordIds ?? [])
}

export function shouldAppendSnapshotStructuralField(
  change: HistoryGroup['changes'][number],
  currentViewFieldKeys: Set<string>,
): boolean {
  if (
    change.changeKind !== 'field_create' &&
    change.changeKind !== 'field_update' &&
    change.changeKind !== 'field_delete'
  ) {
    return false
  }
  return !currentViewFieldKeys.has(change.fieldId)
}

/**
 * 将 hex 颜色转为带透明度的 rgba，用于选择标签背景色。
 * 避免硬编码 CSS 变量（选项颜色是动态 hex 值）。
 */
function hexToRgba(hex: string, alpha: number): string {
  const cleaned = hex.replace('#', '')
  const r = parseInt(cleaned.slice(0, 2), 16)
  const g = parseInt(cleaned.slice(2, 4), 16)
  const b = parseInt(cleaned.slice(4, 6), 16)
  if (isNaN(r) || isNaN(g) || isNaN(b)) return hex
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

function renderCellValue(value: unknown, field: Field): React.ReactNode {
  if (value === null || value === undefined || value === '') return '-'

  const ft = field.field_type

  if (ft === 'attachment' && (Array.isArray(value) || typeof value === 'object')) {
    return formatAttachmentValue(value) || '-'
  }

  if (ft === 'select' && value) {
    const choices = normalizeSelectChoices(field.options?.choices)
    const match = choices.find((c) => c.value === value || c.label === value)
    if (match) {
      return (
        <span
          className="inline-flex items-center rounded px-1.5 py-0.5 text-caption font-medium"
          style={{
            backgroundColor: hexToRgba(match.color, 0.15),
            color: match.color,
          }}
        >
          {match.label}
        </span>
      )
    }
    return String(value)
  }

  if (ft === 'multi_select' && value) {
    const choices = normalizeSelectChoices(field.options?.choices)
    const values = Array.isArray(value) ? value : [value]
    const tags = values.map((v, i) => {
      const match = choices.find((c) => c.value === v || c.label === v)
      const label = match?.label || String(v)
      const color = match?.color || '#808080'
      return (
        <span
          key={i}
          className="inline-flex items-center rounded px-1.5 py-0.5 text-caption font-medium"
          style={{
            backgroundColor: hexToRgba(color, 0.15),
            color,
          }}
        >
          {label}
        </span>
      )
    })
    return <span className="flex flex-wrap gap-0.5">{tags}</span>
  }

  if (ft === 'checkbox') {
    return value ? '✓' : '✗'
  }

  if (ft === 'link') {
    if (Array.isArray(value)) {
      const titles = value
        .map((v: unknown) => {
          if (!v || typeof v !== 'object') return null
          const item = v as Record<string, unknown>
          return item.title || item.name || item.id
        })
        .filter(Boolean)
      return titles.join(', ') || `${value.length} 条关联`
    }
    if (typeof value === 'object' && value !== null) {
      const record = value as Record<string, unknown>
      return String(record.title ?? record.name ?? record.id ?? '-')
    }
  }

  return formatFieldDisplayValue(
    value,
    field as Parameters<typeof formatFieldDisplayValue>[1],
    { emptyLabel: '-' },
  ) || formatCellValue(value)
}

function renderCellText(value: unknown, field: Field): string {
  const rendered = renderCellValue(value, field)
  if (typeof rendered === 'string') return rendered
  const formatted = formatCellValue(value)
  return formatted === '' ? '-' : formatted
}

function getConfiguredField(
  previewView: ViewMeta | null | undefined,
  fields: Field[],
  configKey: string,
): Field | null {
  const config = previewView?.config
  if (!config || typeof config !== 'object') return null

  const raw = (config as Record<string, unknown>)[configKey]
  if (typeof raw !== 'string' || !raw) return null

  return fields.find((field) => field.id === raw || field.name === raw) ?? null
}

function getPrimaryPreviewField(fields: Field[]): Field | null {
  return fields.find((field) => field.is_primary) ?? fields[0] ?? null
}

function getHistoryPreviewMode(previewView: ViewMeta | null | undefined): HistoryPreviewMode {
  const viewType = String(previewView?.view_type ?? 'grid').toLowerCase()
  if (viewType === 'kanban') return 'kanban'
  if (viewType === 'gallery') return 'gallery'
  if (viewType === 'calendar') return 'calendar'
  return 'grid'
}

function normalizeGroupLabel(value: unknown): string {
  if (value === null || value === undefined || value === '') return ''
  if (Array.isArray(value)) {
    return value.map(normalizeGroupLabel).filter(Boolean).join(', ')
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>
    return String(record.label ?? record.name ?? record.title ?? record.value ?? record.id ?? '')
  }
  return String(value)
}

export function buildHistoryKanbanPreviewGroups(
  rows: SnapshotRow[],
  groupField: Field | null,
  emptyLabel: string,
): HistoryKanbanPreviewGroup[] {
  const groups = new Map<string, HistoryKanbanPreviewGroup>()

  for (const row of rows) {
    const rawValue = groupField ? resolveSnapshotCellValue(row.data, groupField) : null
    const label = normalizeGroupLabel(rawValue) || emptyLabel
    const key = label || '__empty__'
    const group = groups.get(key) ?? { key, label, rows: [] }
    group.rows.push(row)
    groups.set(key, group)
  }

  return Array.from(groups.values())
}

function resolveHistoryChangeField(
  change: HistoryGroup['changes'][number],
  fields: Field[],
): Field {
  const matched = fields.find((field) => (
    field.id === change.fieldId ||
    field.name === change.fieldId ||
    compactFieldId(field.id) === change.fieldId
  ))
  if (matched) return matched

  return {
    id: change.fieldId,
    name: change.fieldName || change.fieldId,
    field_type: change.fieldType || 'text',
  } as Field
}

function formatHistoryChangeValue(value: unknown, field: Field): string {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>
    const label = record.label ?? record.name ?? record.title ?? record.value ?? record.id
    if (label !== undefined && label !== null && label !== '') {
      return String(label)
    }
  }

  return renderCellText(value, field)
}

export function buildHistoryPreviewChangeSummaries(
  activeGroup: HistoryGroup | null | undefined,
  fields: Field[],
  limit = MAX_PREVIEW_CHANGE_SUMMARY,
): HistoryPreviewChangeSummary[] {
  if (!activeGroup) return []

  return activeGroup.changes
    .filter((change) => change.fieldId !== '_deleted')
    .slice(0, limit)
    .map((change) => {
      const field = resolveHistoryChangeField(change, fields)
      return {
        fieldId: change.fieldId,
        fieldName: change.fieldName || field.name,
        oldText: formatHistoryChangeValue(change.old, field),
        newText: formatHistoryChangeValue(change.new, field),
        changeKind: change.changeKind,
      }
    })
}

function isSnapshotRowChangedByGroup(
  row: Pick<SnapshotRow, 'record_id' | 'row_id'>,
  activeGroup?: HistoryGroup | null,
): boolean {
  if (!activeGroup) return false
  const changedRecordIds = new Set(activeGroup.recordIds ?? [])
  return changedRecordIds.has(row.record_id) || (row.row_id ? changedRecordIds.has(row.row_id) : false)
}

function isHistoryChangeShape(value: unknown): value is { old?: unknown; new?: unknown } {
  return (
    typeof value === 'object' &&
    value !== null &&
    ('old' in value || 'new' in value)
  )
}

function isOperationForSnapshotRow(
  operation: HistoryGroup['operations'][number],
  row: Pick<SnapshotRow, 'record_id' | 'row_id'>,
): boolean {
  return operation.record_id === row.record_id || (row.row_id ? operation.record_id === row.row_id : false)
}

function resolveFieldByHistoryKey(fieldKey: string, fields: Field[]): Field {
  const normalizedKey = fieldKey.startsWith('field:') ? fieldKey.slice('field:'.length) : fieldKey
  const matched = fields.find((field) => (
    field.id === normalizedKey ||
    field.name === normalizedKey ||
    compactFieldId(field.id) === normalizedKey
  ))
  if (matched) return matched

  return {
    id: normalizedKey,
    name: normalizedKey,
    field_type: 'text',
  } as Field
}

function mergeRowChangeSummary(
  summariesByField: Map<string, HistoryPreviewChangeSummary>,
  fieldKey: string,
  fieldName: string | null | undefined,
  oldValue: unknown,
  newValue: unknown,
  fields: Field[],
) {
  if (fieldKey === '_deleted' || fieldKey.startsWith('_')) return

  const field = resolveFieldByHistoryKey(fieldKey, fields)
  const existing = summariesByField.get(field.id)
  summariesByField.set(field.id, {
    fieldId: field.id,
    fieldName: fieldName || field.name,
    oldText: existing?.oldText ?? formatHistoryChangeValue(oldValue, field),
    newText: formatHistoryChangeValue(newValue, field),
  })
}

export function buildHistoryRowChangeSummaries(
  row: SnapshotRow,
  activeGroup: HistoryGroup | null | undefined,
  fields: Field[],
  limit = MAX_PREVIEW_CHANGE_SUMMARY,
): HistoryPreviewChangeSummary[] {
  if (!activeGroup) return []

  const summariesByField = new Map<string, HistoryPreviewChangeSummary>()
  const operations = [...activeGroup.operations]
    .filter((operation) => isOperationForSnapshotRow(operation, row))
    .sort((a, b) => {
      const timeA = new Date(a.created_at).getTime()
      const timeB = new Date(b.created_at).getTime()
      return timeA - timeB || a.id.localeCompare(b.id)
    })

  for (const operation of operations) {
    const items = operation.items ?? []
    if (items.length > 0) {
      for (const item of items) {
        mergeRowChangeSummary(
          summariesByField,
          item.field_key,
          item.field_name,
          item.before,
          item.after,
          fields,
        )
      }
      continue
    }

    for (const [fieldKey, rawValue] of Object.entries(operation.field_changes ?? {})) {
      if (isHistoryChangeShape(rawValue)) {
        mergeRowChangeSummary(
          summariesByField,
          fieldKey,
          null,
          rawValue.old,
          rawValue.new,
          fields,
        )
      } else {
        mergeRowChangeSummary(
          summariesByField,
          fieldKey,
          null,
          null,
          rawValue,
          fields,
        )
      }
    }
  }

  return Array.from(summariesByField.values()).slice(0, limit)
}

function getRecordDeletionCount(activeGroup?: HistoryGroup | null): number {
  if (!activeGroup) return 0
  const deletedChange = activeGroup.changes.find((change) => change.fieldId === '_deleted')
  if (!deletedChange || deletedChange.old !== false || deletedChange.new !== true) return 0
  return activeGroup.recordIds.length || activeGroup.count || 1
}

function HistoryChangePill({
  summary,
  compact = false,
}: {
  summary: HistoryPreviewChangeSummary
  compact?: boolean
}) {
  return (
    <span
      className={cn(
        'inline-flex min-w-0 items-center gap-1 rounded border border-warning/25 bg-warning/10 text-warning',
        compact ? 'px-1.5 py-0.5' : 'px-2 py-1',
      )}
      title={`${summary.fieldName}: ${summary.oldText} → ${summary.newText}`}
    >
      <span className="shrink-0 font-medium">{summary.fieldName}</span>
      <span className="min-w-0 truncate text-warning/80">
        {summary.oldText} → {summary.newText}
      </span>
    </span>
  )
}

function HistoryChangeSummaryStrip({
  activeGroup,
  fields,
}: {
  activeGroup?: HistoryGroup | null
  fields: Field[]
}) {
  const { t } = useTranslation(['table'])
  if (!activeGroup) return null

  const summaries = buildHistoryPreviewChangeSummaries(activeGroup, fields)
  const deletedCount = getRecordDeletionCount(activeGroup)
  const hiddenCount = Math.max(0, activeGroup.changes.filter((change) => change.fieldId !== '_deleted').length - summaries.length)

  if (summaries.length === 0 && deletedCount === 0) return null

  return (
    <div className="flex shrink-0 flex-wrap items-center gap-2 border-b bg-warning/5 px-3 py-2 text-caption">
      <span className="font-medium text-warning">
        {t('table:history.previewChangeSummary')}
      </span>
      {activeGroup.recordIds.length > 0 && deletedCount === 0 && (
        <span className="text-muted-foreground">
          {t('table:history.restoreChangedRecords', { count: activeGroup.recordIds.length })}
        </span>
      )}
      {deletedCount > 0 && (
        <span className="rounded border border-destructive/25 bg-destructive/10 px-2 py-1 text-destructive">
          {t('table:history.recordDeletedCount', { count: deletedCount })}
        </span>
      )}
      {summaries.map((summary) => (
        <HistoryChangePill key={summary.fieldId} summary={summary} />
      ))}
      {hiddenCount > 0 && (
        <span className="text-muted-foreground">
          {t('table:history.moreChanges', { count: hiddenCount })}
        </span>
      )}
    </div>
  )
}

function HistoryRowChangeSummary({
  row,
  activeGroup,
  fields,
  deletedRecordIds,
}: {
  row: SnapshotRow
  activeGroup?: HistoryGroup | null
  fields: Field[]
  deletedRecordIds: Set<string>
}) {
  const { t } = useTranslation(['table'])
  const isDeleted = row.isDeletedPreview === true || isSnapshotRowDeleted(row, deletedRecordIds)
  const isChanged = isSnapshotRowChangedByGroup(row, activeGroup)
  if (!isChanged && !isDeleted) return null

  if (isDeleted) {
    return (
      <div className="mt-2 inline-flex rounded border border-destructive/25 bg-destructive/10 px-2 py-1 text-caption font-medium text-destructive">
        {t('table:history.recordDeletedTag')}
      </div>
    )
  }

  const summaries = buildHistoryRowChangeSummaries(row, activeGroup, fields)
  if (summaries.length > 0) {
    return (
      <div className="mt-2 flex flex-wrap gap-1 text-caption">
        {summaries.map((summary) => (
          <HistoryChangePill key={summary.fieldId} summary={summary} compact />
        ))}
      </div>
    )
  }

  return (
    <div className="mt-2 inline-flex rounded border border-warning/25 bg-warning/10 px-2 py-1 text-caption font-medium text-warning">
      {t('table:history.recordChangedTag')}
    </div>
  )
}

function PreviewShell({
  previewView,
  activeGroup,
  fields,
  children,
}: {
  previewView: ViewMeta | null | undefined
  activeGroup?: HistoryGroup | null
  fields: Field[]
  children: React.ReactNode
}) {
  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="flex shrink-0 items-center gap-2 border-b bg-background px-3 py-2">
        <span className="text-muted-foreground [&_svg]:h-3.5 [&_svg]:w-3.5">
          <ViewTypeIcon type={previewView?.view_type || 'grid'} />
        </span>
        <span className="truncate text-body font-medium text-foreground">
          {previewView?.name}
        </span>
      </div>
      <HistoryChangeSummaryStrip activeGroup={activeGroup} fields={fields} />
      {children}
    </div>
  )
}

function HistoryKanbanSnapshotPreview({
  fields,
  allFields,
  rows,
  previewView,
  activeGroup,
}: {
  fields: Field[]
  allFields: Field[]
  rows: SnapshotRow[]
  previewView: ViewMeta | null | undefined
  activeGroup?: HistoryGroup | null
}) {
  const { t } = useTranslation(['view', 'table'])
  const groupField = getConfiguredField(previewView, allFields, 'group_by_field')
    ?? allFields.find((field) => field.field_type === 'select')
    ?? null
  const titleField = getConfiguredField(previewView, allFields, 'card_title_field') ?? getPrimaryPreviewField(allFields)
  const detailFields = fields
    .filter((field) => field.id !== titleField?.id && field.id !== groupField?.id)
    .slice(0, 4)
  const changedRecordIds = new Set(activeGroup?.recordIds ?? [])
  const deletedRecordIds = getDeletedRecordIds(activeGroup)
  const groups = buildHistoryKanbanPreviewGroups(rows, groupField, String(t('view:labels.ungrouped')))

  return (
    <PreviewShell previewView={previewView} activeGroup={activeGroup} fields={allFields}>
      <div data-testid="history-kanban-preview" className="flex-1 overflow-auto p-3">
        <div className="flex min-h-full gap-3">
          {groups.map((group) => (
            <section key={group.key} className="flex w-56 shrink-0 flex-col rounded-lg border bg-muted/30">
              <div className="flex items-center justify-between border-b px-3 py-2">
                <span className="truncate text-caption font-medium text-foreground">{group.label}</span>
                <span className="rounded-full bg-background px-1.5 py-0.5 text-caption text-muted-foreground">
                  {group.rows.length}
                </span>
              </div>
              <div className="space-y-2 overflow-auto p-2">
                {group.rows.map((row, index) => {
                  const isChanged = changedRecordIds.has(row.record_id) || (row.row_id ? changedRecordIds.has(row.row_id) : false)
                  const isDeleted = row.isDeletedPreview === true || isSnapshotRowDeleted(row, deletedRecordIds)
                  const title = titleField ? renderCellText(resolveSnapshotCellValue(row.data, titleField), titleField) : `#${index + 1}`
                  return (
                    <article
                      key={row.record_id || `${group.key}-${index}`}
                      className={cn(
                        'rounded-md border bg-background p-2 shadow-sm',
                        isChanged && 'ring-1 ring-warning/30',
                        isDeleted && 'border-destructive/30 bg-destructive/5 text-destructive/80 line-through',
                      )}
                    >
                      <div className="truncate text-body font-medium">{title}</div>
                      <HistoryRowChangeSummary
                        row={row}
                        activeGroup={activeGroup}
                        fields={allFields}
                        deletedRecordIds={deletedRecordIds}
                      />
                      {detailFields.length > 0 && (
                        <dl className="mt-2 space-y-1">
                          {detailFields.map((field) => (
                            <div key={field.id} className="flex min-w-0 gap-2 text-caption">
                              <dt className="shrink-0 text-muted-foreground">{field.name}</dt>
                              <dd className="truncate text-foreground/80">
                                {renderCellText(resolveSnapshotCellValue(row.data, field), field)}
                              </dd>
                            </div>
                          ))}
                        </dl>
                      )}
                    </article>
                  )
                })}
              </div>
            </section>
          ))}
        </div>
      </div>
    </PreviewShell>
  )
}

function HistoryGallerySnapshotPreview({
  fields,
  allFields,
  rows,
  previewView,
  activeGroup,
}: {
  fields: Field[]
  allFields: Field[]
  rows: SnapshotRow[]
  previewView: ViewMeta | null | undefined
  activeGroup?: HistoryGroup | null
}) {
  const titleField = getConfiguredField(previewView, allFields, 'title_field') ?? getPrimaryPreviewField(allFields)
  const descriptionField = getConfiguredField(previewView, allFields, 'description_field')
  const cardFields = fields
    .filter((field) => field.id !== titleField?.id && field.id !== descriptionField?.id)
    .slice(0, 3)
  const deletedRecordIds = getDeletedRecordIds(activeGroup)

  return (
    <PreviewShell previewView={previewView} activeGroup={activeGroup} fields={allFields}>
      <div data-testid="history-gallery-preview" className="flex-1 overflow-auto p-3">
        <div className="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-3">
          {rows.map((row, index) => {
            const title = titleField ? renderCellText(resolveSnapshotCellValue(row.data, titleField), titleField) : `#${index + 1}`
            const description = descriptionField
              ? renderCellText(resolveSnapshotCellValue(row.data, descriptionField), descriptionField)
              : null
            const isChanged = isSnapshotRowChangedByGroup(row, activeGroup)
            const isDeleted = row.isDeletedPreview === true || isSnapshotRowDeleted(row, deletedRecordIds)
            return (
              <article
                key={row.record_id || index}
                className={cn(
                  'overflow-hidden rounded-lg border bg-background',
                  isChanged && 'ring-1 ring-warning/30',
                  isDeleted && 'border-destructive/30 bg-destructive/5 text-destructive/80 line-through',
                )}
              >
                <div className="h-20 border-b bg-muted/40" />
                <div className="space-y-2 p-3">
                  <div className="truncate text-body font-medium">{title}</div>
                  {description && description !== '-' && (
                    <p className="line-clamp-2 text-caption text-muted-foreground">{description}</p>
                  )}
                  <HistoryRowChangeSummary
                    row={row}
                    activeGroup={activeGroup}
                    fields={allFields}
                    deletedRecordIds={deletedRecordIds}
                  />
                  {cardFields.map((field) => (
                    <div key={field.id} className="flex min-w-0 gap-2 text-caption">
                      <span className="shrink-0 text-muted-foreground">{field.name}</span>
                      <span className="truncate">{renderCellText(resolveSnapshotCellValue(row.data, field), field)}</span>
                    </div>
                  ))}
                </div>
              </article>
            )
          })}
        </div>
      </div>
    </PreviewShell>
  )
}

function formatCalendarPreviewDate(value: unknown, fallback: string): string {
  if (value === null || value === undefined || value === '') return fallback
  const date = new Date(String(value))
  if (Number.isNaN(date.getTime())) return String(value)
  return date.toLocaleDateString()
}

function HistoryCalendarSnapshotPreview({
  allFields,
  rows,
  previewView,
  activeGroup,
}: {
  allFields: Field[]
  rows: SnapshotRow[]
  previewView: ViewMeta | null | undefined
  activeGroup?: HistoryGroup | null
}) {
  const { t } = useTranslation(['view'])
  const dateField = getConfiguredField(previewView, allFields, 'date_field')
    ?? allFields.find((field) => ['date', 'created_time', 'last_modified_time'].includes(String(field.field_type)))
    ?? null
  const titleField = getConfiguredField(previewView, allFields, 'title_field') ?? getPrimaryPreviewField(allFields)
  const unsetDate = String(t('view:calendar.unsetDate'))
  const grouped = new Map<string, SnapshotRow[]>()
  const deletedRecordIds = getDeletedRecordIds(activeGroup)

  for (const row of rows) {
    const label = dateField
      ? formatCalendarPreviewDate(resolveSnapshotCellValue(row.data, dateField), unsetDate)
      : unsetDate
    grouped.set(label, [...(grouped.get(label) ?? []), row])
  }

  return (
    <PreviewShell previewView={previewView} activeGroup={activeGroup} fields={allFields}>
      <div data-testid="history-calendar-preview" className="flex-1 overflow-auto p-3">
        <div className="space-y-3">
          {Array.from(grouped.entries()).map(([dateLabel, dateRows]) => (
            <section key={dateLabel} className="rounded-lg border bg-background">
              <div className="border-b px-3 py-2 text-caption font-medium text-muted-foreground">{dateLabel}</div>
              <div className="divide-y">
                {dateRows.map((row, index) => {
                  const title = titleField ? renderCellText(resolveSnapshotCellValue(row.data, titleField), titleField) : `#${index + 1}`
                  const isChanged = isSnapshotRowChangedByGroup(row, activeGroup)
                  const isDeleted = row.isDeletedPreview === true || isSnapshotRowDeleted(row, deletedRecordIds)
                  return (
                    <div
                      key={row.record_id || `${dateLabel}-${index}`}
                      className={cn(
                        'px-3 py-2',
                        isChanged && 'bg-warning/5',
                        isDeleted && 'bg-destructive/5 text-destructive/80 line-through',
                      )}
                    >
                      <div className="truncate text-body font-medium">{title}</div>
                      <HistoryRowChangeSummary
                        row={row}
                        activeGroup={activeGroup}
                        fields={allFields}
                        deletedRecordIds={deletedRecordIds}
                      />
                    </div>
                  )
                })}
              </div>
            </section>
          ))}
        </div>
      </div>
    </PreviewShell>
  )
}

export const HistoryTablePreview: React.FC<HistoryTablePreviewProps> = ({
  fields,
  allFields,
  rows,
  loading,
  activeGroup,
  isTruncated,
  previewView,
  fieldNameMap,
}) => {
  const { t } = useTranslation(['table'])
  const parentRef = React.useRef<HTMLDivElement>(null)
  const fieldCatalog = allFields && allFields.length > 0 ? allFields : fields

  const changedFieldIds = React.useMemo(() => {
    if (!activeGroup) return new Set<string>()
    return new Set(activeGroup.changes.map((c) => c.fieldId))
  }, [activeGroup])

  const currentViewFieldKeys = React.useMemo(() => {
    const keys = new Set<string>()
    for (const field of fields) {
      for (const key of getSnapshotFieldKeys(field)) {
        keys.add(key)
      }
    }
    return keys
  }, [fields])

  const deletedFieldIds = React.useMemo(() => {
    if (!activeGroup) return new Set<string>()
    return new Set(
      activeGroup.changes
        .filter((change) => change.changeKind === 'field_delete')
        .map((change) => change.fieldId),
    )
  }, [activeGroup])

  const changedRecordIds = React.useMemo(() => {
    if (!activeGroup) return new Set<string>()
    return new Set(activeGroup.recordIds ?? [])
  }, [activeGroup])

  const deletedRecordIds = React.useMemo(
    () => getDeletedRecordIds(activeGroup),
    [activeGroup],
  )

  const previewRows = React.useMemo(() => {
    const baseRows = rows ?? []
    if (deletedRecordIds.size === 0) return baseRows

    const rowsWithDeleteState = baseRows.map((row) => (
      isSnapshotRowDeleted(row, deletedRecordIds)
        ? { ...row, isDeletedPreview: true }
        : row
    ))

    const visibleRowIds = new Set<string>()
    for (const row of rowsWithDeleteState) {
      visibleRowIds.add(row.record_id)
      if (row.row_id) visibleRowIds.add(row.row_id)
    }

    const deletedRows: SnapshotRow[] = []
    for (const recordId of deletedRecordIds) {
      if (!visibleRowIds.has(recordId)) {
        deletedRows.push({
          record_id: recordId,
          row_id: recordId,
          data: {},
          isDeletedPreview: true,
        })
      }
    }

    return deletedRows.length > 0 ? [...rowsWithDeleteState, ...deletedRows] : rowsWithDeleteState
  }, [deletedRecordIds, rows])

  const visibleFields = React.useMemo(() => {
    const currentFields = fields.filter((f) => !f.is_hidden)
    const knownKeys = new Set<string>()
    for (const field of currentFields) {
      for (const key of getSnapshotFieldKeys(field)) {
        knownKeys.add(key)
      }
    }

    const extraById = new Map<string, Field>()

    const appendExtraField = (
      fieldId: string,
      name?: string | null,
      fieldType?: string | null,
    ) => {
      if (!fieldId || fieldId.startsWith('_')) return
      if (knownKeys.has(fieldId) || knownKeys.has(compactFieldId(fieldId))) return
      if (extraById.has(fieldId)) return
      const resolvedName =
        name
        || fieldNameMap?.[fieldId]
        || fieldNameMap?.[compactFieldId(fieldId)]
        || t('table:history.deletedField')
      extraById.set(fieldId, {
        id: fieldId,
        name: resolvedName,
        field_type: fieldType || 'text',
        is_hidden: false,
      } as Field)
      knownKeys.add(fieldId)
      knownKeys.add(compactFieldId(fieldId))
    }

    // 结构变更（create/update/delete）追加列
    if (activeGroup) {
      for (const change of activeGroup.changes) {
        if (!shouldAppendSnapshotStructuralField(change, currentViewFieldKeys)) continue
        appendExtraField(change.fieldId, change.fieldName, change.fieldType)
      }
    }

    // : 快照行里仍有、但当前 schema 已无的字段 key → 补列，避免历史预览缺列
    for (const row of previewRows) {
      const data = row.data
      if (!data || typeof data !== 'object') continue
      for (const key of Object.keys(data)) {
        if (key.startsWith('_') || key.startsWith('__')) continue
        if (knownKeys.has(key) || knownKeys.has(compactFieldId(key))) continue
        appendExtraField(key, fieldNameMap?.[key] || fieldNameMap?.[compactFieldId(key)])
      }
    }

    return [...currentFields, ...extraById.values()]
  }, [activeGroup, currentViewFieldKeys, fieldNameMap, fields, previewRows, t])

  const gridTemplateColumns = React.useMemo(
    () =>
      `${ROW_NUM_WIDTH}px repeat(${visibleFields.length}, minmax(${COL_MIN_WIDTH}px, ${COL_MAX_WIDTH}px))`,
    [visibleFields.length],
  )
  const hasFieldStructureChanges = activeGroup?.changes.some((change) => (
    change.changeKind === 'field_create' ||
    change.changeKind === 'field_update' ||
    change.changeKind === 'field_delete'
  )) ?? false
  const previewMode = getHistoryPreviewMode(previewView)

  // react-virtual 3.13+ 要求 measurement-affecting 回调稳定，
  // inline 函数会让测量缓存反复失效触发死循环。用 useCallback 永久稳定。
  const getScrollElement = useCallback(() => parentRef.current, [])
  const estimateSize = useCallback(() => ROW_HEIGHT, [])

  const rowVirtualizer = useSafeVirtualizer({
    count: previewRows.length,
    getScrollElement,
    estimateSize,
    overscan: 10,
  })

  if (loading) {
    return <TablePreviewSkeleton />
  }

  if (previewRows.length === 0) {
    if (previewMode !== 'grid') {
      return (
        <PreviewShell previewView={previewView} activeGroup={activeGroup} fields={fieldCatalog}>
          <EmptyState
            icon="list"
            title={
              hasFieldStructureChanges
                ? t('table:history.structuralPreviewHint')
                : t('table:history.emptyPreviewHint')
            }
            size="md"
            className="h-full"
          />
        </PreviewShell>
      )
    }

    if (hasFieldStructureChanges) {
      return (
        <div ref={parentRef} className="h-full overflow-auto">
          <div
            className="sticky top-0 z-sticky grid bg-background"
            style={{ gridTemplateColumns }}
          >
            <div className="sticky left-0 z-floating border-b border-r bg-background px-2 py-2 text-center text-caption font-medium text-muted-foreground">
              #
            </div>
            {visibleFields.map((f) => {
              const isChanged = isSnapshotFieldChanged(changedFieldIds, f)
              const isDeletedField = isSnapshotFieldChanged(deletedFieldIds, f)
              return (
                <div
                  key={f.id}
                  className={cn(
                    'flex min-w-0 items-center gap-1.5 truncate whitespace-nowrap border-b border-r px-3 py-2 text-left text-caption font-medium text-muted-foreground',
                    isChanged && 'bg-warning/10 text-warning',
                    isDeletedField && 'bg-destructive/10 text-destructive',
                  )}
                >
                  <span className={cn('min-w-0 truncate', isDeletedField && 'line-through')}>
                    {f.name}
                  </span>
                  {isDeletedField && (
                    <span className="shrink-0 rounded bg-destructive/15 px-1 py-px text-caption font-medium text-destructive">
                      {t('table:history.deletedColumnTag')}
                    </span>
                  )}
                </div>
              )
            })}
          </div>
          <EmptyState
            icon="list"
            title={t('table:history.structuralPreviewHint')}
            size="md"
            className="h-[calc(100%-40px)]"
          />
        </div>
      )
    }
    return (
      <EmptyState
        icon="list"
        title={t('table:history.emptyPreviewHint')}
        size="md"
        className="h-full"
      />
    )
  }

  if (previewMode === 'kanban') {
    return (
      <HistoryKanbanSnapshotPreview
        fields={visibleFields}
        allFields={fieldCatalog}
        rows={previewRows}
        previewView={previewView}
        activeGroup={activeGroup}
      />
    )
  }

  if (previewMode === 'gallery') {
    return (
      <HistoryGallerySnapshotPreview
        fields={visibleFields}
        allFields={fieldCatalog}
        rows={previewRows}
        previewView={previewView}
        activeGroup={activeGroup}
      />
    )
  }

  if (previewMode === 'calendar') {
    return (
      <HistoryCalendarSnapshotPreview
        allFields={fieldCatalog}
        rows={previewRows}
        previewView={previewView}
        activeGroup={activeGroup}
      />
    )
  }

  return (
    <div ref={parentRef} className="h-full overflow-auto">
      {/* Sticky header */}
      <div
        className="sticky top-0 z-sticky grid bg-background"
        style={{ gridTemplateColumns }}
      >
        <div className="sticky left-0 z-floating border-b border-r bg-background px-2 py-2 text-center text-caption font-medium text-muted-foreground">
          #
        </div>
        {visibleFields.map((f) => {
          const isChanged = isSnapshotFieldChanged(changedFieldIds, f)
          const isDeletedField = isSnapshotFieldChanged(deletedFieldIds, f)
          return (
            <div
              key={f.id}
              className={cn(
                'flex min-w-0 items-center gap-1.5 truncate whitespace-nowrap border-b border-r px-3 py-2 text-left text-caption font-medium text-muted-foreground',
                isChanged && 'bg-warning/10 text-warning',
                isDeletedField && 'bg-destructive/10 text-destructive',
              )}
            >
              <span className={cn('min-w-0 truncate', isDeletedField && 'line-through')}>
                {f.name}
              </span>
              {isDeletedField && (
                <span className="shrink-0 rounded bg-destructive/15 px-1 py-px text-caption font-medium text-destructive">
                  {t('table:history.deletedColumnTag')}
                </span>
              )}
            </div>
          )
        })}
      </div>

      {/* Virtualized rows */}
      <div
        style={{
          height: `${rowVirtualizer.getTotalSize()}px`,
          position: 'relative',
        }}
      >
        {rowVirtualizer.getVirtualItems().map((vRow) => {
          const row = previewRows[vRow.index]
          const idx = vRow.index
          const isRowChanged =
            changedRecordIds.has(row.record_id) ||
            (row.row_id ? changedRecordIds.has(row.row_id) : false)
          const isRowDeleted = row.isDeletedPreview === true || isSnapshotRowDeleted(row, deletedRecordIds)

          return (
            <div
              key={row.record_id || idx}
              ref={rowVirtualizer.measureElement}
              data-index={vRow.index}
              className={cn(
                'grid border-b transition-colors hover:bg-accent/30',
                isRowDeleted && 'bg-destructive/5 hover:bg-destructive/10',
              )}
              style={{
                gridTemplateColumns,
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                transform: `translateY(${vRow.start}px)`,
              }}
            >
              <div
                className={cn(
                  'sticky left-0 z-floating border-r bg-background px-2 py-1.5 text-center text-caption text-muted-foreground/60',
                  isRowDeleted && 'bg-destructive/10 text-destructive',
                )}
                title={isRowDeleted ? t('table:history.recordDeletedTag') : undefined}
              >
                <span className={cn(isRowDeleted && 'line-through decoration-destructive decoration-2')}>
                  {idx + 1}
                </span>
              </div>
              {visibleFields.map((f) => {
                const cellValue = resolveSnapshotCellValue(row.data, f)
                const rendered = renderCellValue(cellValue, f)
                const isFieldChanged = isSnapshotFieldChanged(changedFieldIds, f)
                const isDeletedField = isSnapshotFieldChanged(deletedFieldIds, f)
                const isCellChanged = isFieldChanged && isRowChanged
                const titleText =
                  typeof rendered === 'string'
                    ? rendered
                    : formatCellValue(cellValue)
                return (
                  <div
                    key={f.id}
                    className={cn(
                      'truncate whitespace-nowrap border-r px-3 py-1.5',
                      isRowDeleted &&
                        'bg-destructive/5 text-destructive/80 line-through',
                      isCellChanged &&
                        'bg-warning/10 ring-1 ring-inset ring-warning/20',
                      isDeletedField &&
                        'bg-destructive/5 text-destructive/80 line-through ring-1 ring-inset ring-destructive/15',
                    )}
                    title={titleText}
                  >
                    {rendered}
                  </div>
                )
              })}
            </div>
          )
        })}
      </div>

      {isTruncated && (
        <div className="sticky bottom-0 left-0 flex items-center justify-center border-t bg-muted/60 px-4 py-2 text-caption text-muted-foreground">
          {t('table:history.truncatedHint', { count: previewRows.length })}
        </div>
      )}
    </div>
  )
}
