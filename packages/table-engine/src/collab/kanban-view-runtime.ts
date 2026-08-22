import type { TableRecord, ViewMeta, ViewRecordsResponse } from '@tabtin/table-core'
import {
  buildSortedCollabViewRecords,
  type BuildCollabViewRecordsInput,
  type CollabViewFieldMeta,
} from './collabViewRuntime'

export const KANBAN_DEFAULT_PER_GROUP_LIMIT = 50
export const KANBAN_UNGROUPED_OFFSET_KEY = '__ungrouped__'

export const getKanbanOffsetKey = (groupKey: string | null): string =>
  groupKey ?? KANBAN_UNGROUPED_OFFSET_KEY

export interface KanbanGroupRecord {
  group_value: string | null
  group_label: string
  count: number
  records: TableRecord[]
  offset: number
  per_group_limit: number
  has_more: boolean
  color: string | null
}

export interface BuildKanbanViewRecordsInput extends BuildCollabViewRecordsInput {
  perGroupLimit?: number
  groupOffsets?: Record<string, number>
  ungroupedLabel?: string
}

const getRecordFieldValue = (record: TableRecord, fieldId: string): unknown =>
  record.fields?.[fieldId] ?? record.data?.[fieldId]

const isUnsetGroupValue = (value: unknown): boolean => {
  if (value === null || value === undefined) return true
  if (typeof value === 'string') return value.trim().length === 0
  if (Array.isArray(value)) return value.length === 0
  return false
}

const resolveSelectOption = (
  option: unknown,
): { value: string; label: string; color: string | null } | null => {
  if (option == null) return null
  if (typeof option === 'string') {
    return { value: option, label: option, color: null }
  }
  if (typeof option === 'object') {
    const obj = option as Record<string, unknown>
    const value = String(obj.value ?? obj.id ?? obj.name ?? '')
    if (!value) return null
    const label = String(obj.label ?? obj.name ?? obj.value ?? value)
    const color =
      typeof obj.color === 'string' && obj.color.length > 0 ? obj.color : null
    return { value, label, color }
  }
  return null
}

const resolveGroupByFieldId = (view: ViewMeta | null): string | null => {
  if (!view) return null
  const config = (view.config ?? {}) as Record<string, unknown>
  const fromConfig = config.group_by_field
  if (typeof fromConfig === 'string' && fromConfig.length > 0) return fromConfig
  const firstGroup = (view.groups ?? [])[0] as { field_id?: string; field?: string } | undefined
  const fromGroup = firstGroup?.field_id ?? firstGroup?.field
  return typeof fromGroup === 'string' && fromGroup.length > 0 ? fromGroup : null
}

/**
 * 从 Y.Doc 全量快照派生看板视图记录（客户端分组 + per_group_limit 切片）。
 * 对齐后端 view_kanban_service.get_kanban_groups_orm 契约。
 */
export function buildKanbanViewRecords(input: BuildKanbanViewRecordsInput): ViewRecordsResponse {
  const sorted = buildSortedCollabViewRecords(input)
  const groupByFieldId = resolveGroupByFieldId(input.view)
  const fieldById = new Map(input.fieldsMeta.map(field => [field.id, field]))
  const groupField = groupByFieldId ? fieldById.get(groupByFieldId) : undefined
  const perGroupLimit = Math.max(
    1,
    Math.floor(input.perGroupLimit ?? KANBAN_DEFAULT_PER_GROUP_LIMIT),
  )
  const offsets = input.groupOffsets ?? {}
  const ungroupedLabel = input.ungroupedLabel ?? '未分组'

  const buckets = new Map<string, TableRecord[]>()
  const ungrouped: TableRecord[] = []

  for (const record of sorted) {
    if (!groupByFieldId) {
      ungrouped.push(record)
      continue
    }
    const raw = getRecordFieldValue(record, groupByFieldId)
    if (isUnsetGroupValue(raw)) {
      ungrouped.push(record)
      continue
    }
    const key = String(raw)
    const bucket = buckets.get(key)
    if (bucket) bucket.push(record)
    else buckets.set(key, [record])
  }

  const isSelectField =
    groupField?.field_type === 'select' || groupField?.field_type === 'single_select'
  const options = (groupField?.config as { choices?: unknown[] } | undefined)?.choices ?? []

  const orderedKeys: string[] = []
  const optionMeta = new Map<string, { label: string; color: string | null }>()

  if (isSelectField) {
    for (const option of options) {
      const resolved = resolveSelectOption(option)
      if (!resolved || optionMeta.has(resolved.value)) continue
      orderedKeys.push(resolved.value)
      optionMeta.set(resolved.value, { label: resolved.label, color: resolved.color })
    }
    for (const key of [...buckets.keys()].sort()) {
      if (!optionMeta.has(key)) {
        orderedKeys.push(key)
        optionMeta.set(key, { label: key, color: null })
      }
    }
  } else {
    for (const key of [...buckets.keys()].sort()) {
      orderedKeys.push(key)
      optionMeta.set(key, { label: key, color: null })
    }
  }

  const groups: KanbanGroupRecord[] = []
  let totalCount = 0

  for (const key of orderedKeys) {
    const recs = buckets.get(key) ?? []
    const meta = optionMeta.get(key) ?? { label: key, color: null }
    const groupCount = recs.length
    totalCount += groupCount
    const sqlOffset = offsets[key] ?? 0
    const visibleEnd = sqlOffset + perGroupLimit
    const pageRecs = recs.slice(0, visibleEnd)
    groups.push({
      group_value: key,
      group_label: meta.label,
      count: groupCount,
      records: pageRecs,
      offset: sqlOffset,
      per_group_limit: perGroupLimit,
      has_more: visibleEnd < groupCount,
      color: meta.color,
    })
  }

  if (ungrouped.length > 0 || !groupByFieldId) {
    totalCount += ungrouped.length
    const sqlOffset = offsets[KANBAN_UNGROUPED_OFFSET_KEY] ?? 0
    const visibleEnd = sqlOffset + perGroupLimit
    const pageRecs = ungrouped.slice(0, visibleEnd)
    groups.push({
      group_value: null,
      group_label: ungroupedLabel,
      count: ungrouped.length,
      records: pageRecs,
      offset: sqlOffset,
      per_group_limit: perGroupLimit,
      has_more: visibleEnd < ungrouped.length,
      color: null,
    })
  }

  return {
    view: {
      id: String(input.view?.id ?? ''),
      name: String(input.view?.name ?? ''),
      view_type: 'kanban',
      config: input.view?.config ?? {},
    },
    records: [],
    total: totalCount,
    matched_total: totalCount,
    page: 1,
    page_size: perGroupLimit,
    latest_version: 0,
    delta: false,
    has_changes: true,
    metadata: {
      view_type: 'kanban',
      group_by_field: groupByFieldId,
      groups,
    },
  }
}

export type { CollabViewFieldMeta }
