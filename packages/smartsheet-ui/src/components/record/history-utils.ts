/**
 * history-utils.ts — 历史操作分组与合并算法
 *
 * 将扁平的 HistoryOperation[] 合并为时间线分组：
 * 1. 相同 operation_group_id（非 null）的操作合并
 * 2. 按日期分段："今天"、"昨天"、"本周"、具体日期
 */

import type { HistoryOperation, HistoryOperationItem, FieldChange } from './record-history-dialog'

// ── 分组后的数据结构 ──

export interface NormalizedChange {
  fieldId: string
  fieldName?: string | null
  fieldType?: string | null
  changeKind?: 'field_create' | 'field_delete' | 'field_update'
  old: unknown
  new: unknown
}

export interface HistoryGroup {
  /** 组内最后一条操作的 ID（最终状态），用于请求快照 */
  id: string
  /** 组内所有原始操作 */
  operations: HistoryOperation[]
  /** 合并去重后的字段变更列表 */
  changes: NormalizedChange[]
  /** 操作者 */
  user: HistoryOperation['user']
  /** 主要动作类型（取组内最后一条） */
  action: HistoryOperation['action']
  action_display: string
  /** 时间范围 */
  startTime: string
  endTime: string
  /** 组内是否有已撤销的操作 */
  hasUndone: boolean
  /** 组内操作数 */
  count: number
  /** 组内所有涉及的 record_id */
  recordIds: string[]
  /** 编辑者类型（取组内第一条操作的 editor_type） */
  editorType?: 'user' | 'human' | 'agent' | 'system'
  /** Agent Run ID（用于关联对话，取组内首条操作） */
  agentRunId?: string | null
}

export interface TimeSection {
  label: string
  groups: HistoryGroup[]
}

// ── 合并窗口（毫秒） ──
const MERGE_WINDOW_MS = 5 * 60 * 1000 // 5 分钟
const MAX_GROUP_SPAN_MS = 15 * 60 * 1000 // 组总跨度上限，防止链式合并无限延伸
const INTERNAL_HISTORY_FIELD_KEYS = new Set([
  'order',
  '_order',
  'sort_order',
  '_sort_order',
  'row_order',
  '_row_order',
])
const INTERNAL_HISTORY_FIELD_NAMES = new Set([
  '',
  '记录顺序',
  'record order',
  'row order',
])
export const SYSTEM_MANAGED_HISTORY_FIELD_TYPES = new Set([
  'created_by',
  'last_modified_by',
  'created_time',
  'last_modified_time',
])

// ── 工具函数 ──

function parseTime(iso: string): number {
  try {
    return new Date(iso).getTime()
  } catch {
    return 0
  }
}

function getUserId(op: HistoryOperation): string {
  return op.user?.id != null ? String(op.user.id) : '__system__'
}

function isInternalHistoryFieldKey(fieldKey: string, fieldName?: string | null): boolean {
  if (!INTERNAL_HISTORY_FIELD_KEYS.has(fieldKey)) return false
  const normalizedName = String(fieldName ?? '').trim().toLowerCase()
  // 真实业务字段可能叫 order；只有系统排序显示名才过滤。
  return INTERNAL_HISTORY_FIELD_NAMES.has(normalizedName)
}

export function areHistoryValuesEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true
  if (left == null || right == null) return false
  if (typeof left !== 'object' || typeof right !== 'object') return false

  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
      return false
    }
    return left.every((value, index) => areHistoryValuesEqual(value, right[index]))
  }

  const leftRecord = left as Record<string, unknown>
  const rightRecord = right as Record<string, unknown>
  const leftKeys = Object.keys(leftRecord).sort()
  const rightKeys = Object.keys(rightRecord).sort()
  if (leftKeys.length !== rightKeys.length) return false

  return leftKeys.every(
    (key, index) =>
      key === rightKeys[index]
      && areHistoryValuesEqual(leftRecord[key], rightRecord[key]),
  )
}

export function resolveHistoryFieldName(
  change: NormalizedChange,
  fieldNameMap: Record<string, string>,
  fallback: string,
): string {
  return fieldNameMap[change.fieldId] || change.fieldName?.trim() || fallback
}

export function resolveHistoryFieldType(
  change: NormalizedChange,
  fieldTypeMap: Record<string, string>,
): string | undefined {
  return change.fieldType || fieldTypeMap[change.fieldId] || undefined
}

/** 从操作中提取字段级变更 */
function extractChanges(op: HistoryOperation): NormalizedChange[] {
  if (op.items && op.items.length > 0) {
    return op.items.flatMap((item: HistoryOperationItem) => {
      const before = item.before
      const after = item.after
      const beforeObj = before && typeof before === 'object' ? before as Record<string, unknown> : null
      const afterObj = after && typeof after === 'object' ? after as Record<string, unknown> : null
      const isFieldStructureChange = item.field_key.startsWith('field:')
      const fieldId = isFieldStructureChange ? item.field_key.slice('field:'.length) : item.field_key
      const fieldName =
        item.field_name ??
        (typeof beforeObj?.name === 'string' ? beforeObj.name : null) ??
        (typeof afterObj?.name === 'string' ? afterObj.name : null)
      if (!isFieldStructureChange && isInternalHistoryFieldKey(item.field_key, fieldName)) {
        return []
      }
      const fieldType =
        item.field_type ??
        (typeof beforeObj?.field_type === 'string' ? beforeObj.field_type : null) ??
        (typeof afterObj?.field_type === 'string' ? afterObj.field_type : null)
      if (fieldType && SYSTEM_MANAGED_HISTORY_FIELD_TYPES.has(fieldType)) {
        return []
      }
      const changeKind = isFieldStructureChange
        ? beforeObj && !afterObj
          ? 'field_delete'
          : !beforeObj && afterObj
            ? 'field_create'
            : 'field_update'
        : undefined

      return {
        fieldId,
        fieldName,
        fieldType,
        changeKind,
        old: before,
        new: after,
      }
    })
  }
  if (op.field_changes) {
    return Object.entries(op.field_changes)
      .filter(([fieldId]) => !isInternalHistoryFieldKey(fieldId))
      .map(([fieldId, change]: [string, FieldChange]) => ({
        fieldId,
        old: change?.old,
        new: change?.new,
      }))
  }
  return []
}

/**
 * 合并多条操作的字段变更。
 * 对于同一字段多次变更，取最早的 old 和最新的 new。
 */
function mergeChanges(operations: HistoryOperation[]): NormalizedChange[] {
  // 按时间正序处理（最早 → 最新）
  const sorted = [...operations].sort(
    (a, b) => parseTime(a.created_at) - parseTime(b.created_at)
  )

  const fieldMap = new Map<string, {
    fieldName?: string | null
    fieldType?: string | null
    changeKind?: NormalizedChange['changeKind']
    old: unknown
    new: unknown
  }>()

  for (const op of sorted) {
    const changes = extractChanges(op)
    for (const c of changes) {
      const existing = fieldMap.get(c.fieldId)
      if (existing) {
        // 保留最早的 old，更新为最新的 new
        existing.new = c.new
        existing.fieldName = existing.fieldName ?? c.fieldName
        existing.fieldType = existing.fieldType ?? c.fieldType
        existing.changeKind = existing.changeKind ?? c.changeKind
      } else {
        fieldMap.set(c.fieldId, {
          fieldName: c.fieldName,
          fieldType: c.fieldType,
          changeKind: c.changeKind,
          old: c.old,
          new: c.new,
        })
      }
    }
  }

  // 过滤语义同值（JSON 对象即使引用不同，也不应产生 A → A 历史）。
  const result: NormalizedChange[] = []
  fieldMap.forEach((val, fieldId) => {
    if (!areHistoryValuesEqual(val.old, val.new)) {
      const change: NormalizedChange = {
        fieldId,
        old: val.old,
        new: val.new,
      }
      if (val.fieldName != null) change.fieldName = val.fieldName
      if (val.fieldType != null) change.fieldType = val.fieldType
      if (val.changeKind != null) change.changeKind = val.changeKind
      result.push(change)
    }
  })

  return result
}

function buildGroup(operations: HistoryOperation[]): HistoryGroup {
  const first = operations[0]
  const last = operations[operations.length - 1]
  const sorted = [...operations].sort(
    (a, b) => parseTime(a.created_at) - parseTime(b.created_at) || a.id.localeCompare(b.id)
  )
  const earliest = sorted[0]
  const latest = sorted[sorted.length - 1]

  const recordIds = [...new Set(operations.map((op) => op.record_id))]

  return {
    id: latest.id,
    operations,
    changes: mergeChanges(operations),
    user: last.user,
    action: last.action,
    action_display: last.action_display,
    startTime: earliest.created_at,
    endTime: latest.created_at,
    hasUndone: operations.some((op) => op.is_undone),
    count: operations.length,
    recordIds,
    editorType: first.editor_type || 'user',
    agentRunId: first.agent_run_id ?? null,
  }
}

// ── 主函数：分组合并 ──

export function groupOperations(operations: HistoryOperation[]): HistoryGroup[] {
  if (!operations.length) return []

  // 按时间倒序（最新在前）
  const sorted = [...operations].sort(
    (a, b) => parseTime(b.created_at) - parseTime(a.created_at) || b.id.localeCompare(a.id)
  )
  const operationGroups = new Map<string, HistoryOperation[]>()
  for (const op of sorted) {
    if (op.operation_group_id != null) {
      const groupId = String(op.operation_group_id)
      const bucket = operationGroups.get(groupId) ?? []
      bucket.push(op)
      operationGroups.set(groupId, bucket)
    }
  }

  const groups: HistoryGroup[] = []
  const emittedGroupIds = new Set<string>()

  for (const op of sorted) {
    if (op.operation_group_id == null) {
      const group = buildGroup([op])
      if (group.action !== 'update' || group.changes.length > 0) {
        groups.push(group)
      }
      continue
    }

    const groupId = String(op.operation_group_id)
    if (!emittedGroupIds.has(groupId)) {
      const group = buildGroup(operationGroups.get(groupId) ?? [op])
      if (group.action !== 'update' || group.changes.length > 0) {
        groups.push(group)
      }
      emittedGroupIds.add(groupId)
    }
  }

  return groups
}

// ── 日期分段 ──

function isSameDay(d1: Date, d2: Date): boolean {
  return (
    d1.getFullYear() === d2.getFullYear() &&
    d1.getMonth() === d2.getMonth() &&
    d1.getDate() === d2.getDate()
  )
}

function isSameWeek(d1: Date, d2: Date): boolean {
  const oneDay = 86400000
  const startOfWeek = (d: Date) => {
    const day = d.getDay() || 7 // 周日=7
    return new Date(d.getFullYear(), d.getMonth(), d.getDate() - day + 1)
  }
  const w1 = startOfWeek(d1).getTime()
  const w2 = startOfWeek(d2).getTime()
  return Math.abs(w1 - w2) < oneDay
}

export function getTimeSectionLabel(isoString: string, locale: string = 'zh-CN'): string {
  try {
    const date = new Date(isoString)
    if (Number.isNaN(date.getTime())) return isoString
    const now = new Date()

    if (isSameDay(date, now)) {
      return locale.startsWith('zh') ? '今天' : 'Today'
    }

    const yesterday = new Date(now)
    yesterday.setDate(yesterday.getDate() - 1)
    if (isSameDay(date, yesterday)) {
      return locale.startsWith('zh') ? '昨天' : 'Yesterday'
    }

    if (isSameWeek(date, now)) {
      return locale.startsWith('zh') ? '本周' : 'This Week'
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

export function groupByTimeSection(groups: HistoryGroup[], locale?: string): TimeSection[] {
  const sections: TimeSection[] = []
  let currentLabel = ''
  let currentSection: HistoryGroup[] = []

  for (const group of groups) {
    const label = getTimeSectionLabel(group.endTime, locale)
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

/** 格式化时间范围显示 */
export function formatTimeRange(startIso: string, endIso: string, locale?: string): string {
  try {
    const start = new Date(startIso)
    const end = new Date(endIso)
    if (Number.isNaN(start.getTime())) return startIso

    const fmt = (d: Date) =>
      d.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })

    if (isSameDay(start, end)) {
      if (start.getTime() === end.getTime() || fmt(start) === fmt(end)) {
        return fmt(start)
      }
      return `${fmt(start)} - ${fmt(end)}`
    }

    const dateFmt = (d: Date) =>
      d.toLocaleDateString(locale, {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      })
    return `${dateFmt(start)} - ${dateFmt(end)}`
  } catch {
    return startIso
  }
}
