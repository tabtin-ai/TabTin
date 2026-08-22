/**
 * 记录操作相关的纯工具函数。
 * 从 Electron useDataGridRecordOps 提取，供 Electron / Web 两端共享。
 */

import { normalizeGroupValue } from './buildRowsWithDraft'

export interface FieldLike {
  id: string
  name: string
  field_type: string
}

export interface GroupLike {
  field_id?: string
  field?: string
}

export function isDataRecordRow(row: unknown): row is Record<string, unknown> {
  if (!row || typeof row !== 'object') return false
  const maybeRow = row as { id?: unknown; __rowType?: unknown }
  if (typeof maybeRow.id !== 'string' || maybeRow.id.length === 0) return false
  return !(typeof maybeRow.__rowType === 'string' && maybeRow.__rowType.length > 0)
}

const UNRESOLVED = Symbol('UNRESOLVED_FILTER_PREFILL')

const NON_WRITABLE_CREATE_FIELD_TYPES = new Set([
  'created_time', 'last_modified_time', 'created_by', 'last_modified_by',
])
const PREFILLABLE_SCALAR_OPS = new Set(['equals', 'is', 'is_exactly'])
const PREFILLABLE_ARRAY_OPS = new Set(['in', 'is_any_of'])

function isWritableCreateField(fieldMeta: FieldLike | undefined): fieldMeta is FieldLike {
  return Boolean(
    fieldMeta && !NON_WRITABLE_CREATE_FIELD_TYPES.has(fieldMeta.field_type)
  )
}

function resolveFilterPrefillValue(
  fieldMeta: FieldLike | undefined,
  operator: unknown,
  value: unknown,
): unknown | typeof UNRESOLVED {
  if (!isWritableCreateField(fieldMeta)) {
    return UNRESOLVED
  }
  const op = typeof operator === 'string' ? operator.trim().toLowerCase() : ''
  if (PREFILLABLE_SCALAR_OPS.has(op)) {
    return value === null || value === undefined ? UNRESOLVED : value
  }
  if (PREFILLABLE_ARRAY_OPS.has(op)) {
    if (!Array.isArray(value) || value.length !== 1) return UNRESOLVED
    const [first] = value
    return first === null || first === undefined ? UNRESOLVED : first
  }
  return UNRESOLVED
}

export interface FilterLike {
  field_id: string
  operator?: unknown
  value?: unknown
  enabled?: boolean
}

/**
 * 从 AND 模式的 filters 中推断可预填充的字段值。
 * 返回 undefined 表示无法推断（OR 模式、冲突值、不可写字段等）。
 */
export function resolveFilterPrefillValues(params: {
  activeFilters: FilterLike[]
  filterLogic: string | undefined
  getFieldById: (id: string) => FieldLike | undefined
  normalizeValue?: (v: unknown) => string
}): Record<string, unknown> | undefined {
  const { activeFilters, filterLogic, getFieldById, normalizeValue } = params
  const normalize = normalizeValue ?? normalizeGroupValue

  if (activeFilters.length === 0 || filterLogic === 'or') return undefined

  const result: Record<string, unknown> = {}
  for (const filter of activeFilters) {
    const fieldMeta = getFieldById(filter.field_id)
    const resolved = resolveFilterPrefillValue(fieldMeta, filter.operator, filter.value)
    if (resolved === UNRESOLVED || !fieldMeta) return undefined

    const existing = result[fieldMeta.name]
    if (existing !== undefined && normalize(existing) !== normalize(resolved)) {
      return undefined
    }
    result[fieldMeta.name] = resolved
  }
  return Object.keys(result).length > 0 ? result : undefined
}

/**
 * 合并 filter 预填值和 group 预填值，group 优先。
 */
export function mergePrefillValues(
  filterPrefill: Record<string, unknown> | undefined,
  groupPrefill: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!filterPrefill && !groupPrefill) return undefined
  return { ...(filterPrefill ?? {}), ...(groupPrefill ?? {}) }
}

/**
 * 根据当前分组配置，从锚点数据行中提取 group 预填值。
 */
export function resolveGroupPrefillValuesFromAnchor(params: {
  activeGroups?: GroupLike[] | null
  anchorRow: Record<string, unknown> | null | undefined
  getFieldById: (id: string) => FieldLike | undefined
  getFieldByName?: (name: string) => FieldLike | undefined
}): Record<string, unknown> | undefined {
  const { activeGroups, anchorRow, getFieldById, getFieldByName } = params
  if (!activeGroups?.length || !anchorRow) return undefined

  const groupValues: Record<string, unknown> = {}
  for (const group of activeGroups) {
    const rawFieldId = group.field_id ?? group.field
    if (!rawFieldId) continue

    const fieldMeta = getFieldById(rawFieldId) ?? getFieldByName?.(rawFieldId)
    if (!isWritableCreateField(fieldMeta)) continue

    const groupValue = anchorRow[fieldMeta.name]
    if (groupValue === undefined || groupValue === null) continue
    if (typeof groupValue === 'string' && groupValue.trim().length === 0) continue

    groupValues[fieldMeta.name] = groupValue
  }

  return Object.keys(groupValues).length > 0 ? groupValues : undefined
}
