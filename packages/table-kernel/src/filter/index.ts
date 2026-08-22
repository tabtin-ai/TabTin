/**
 * 内存筛选操作符求值 — 从 Django lookup_field_service.py 精确翻译
 *
 * 纯函数，不依赖任何外部服务。
 * 用于：内存 filter 匹配、Specification 的 isSatisfiedBy、Agent 试算
 */

export interface FilterItem {
  fieldId: string
  operator: string
  value?: unknown
}

export interface FilterSet {
  conjunction: 'and' | 'or'
  filterSet: Array<FilterItem | FilterSet>
}

export function isFilterSet(item: unknown): item is FilterSet {
  return typeof item === 'object' && item !== null && 'conjunction' in item && 'filterSet' in item
}

// ── 基础比较辅助 ──

function isEmpty(value: unknown): boolean {
  if (value == null) return true
  if (typeof value === 'string' && value.trim() === '') return true
  if (Array.isArray(value) && value.length === 0) return true
  return false
}

function looseEquals(a: unknown, b: unknown): boolean {
  if (a == null && b == null) return true
  if (a == null || b == null) return false
  const sa = String(a).toLowerCase().trim()
  const sb = String(b).toLowerCase().trim()
  return sa === sb
}

function strContains(haystack: unknown, needle: unknown): boolean {
  if (haystack == null || needle == null) return false
  return String(haystack).toLowerCase().includes(String(needle).toLowerCase())
}

function numericCompare(cellValue: unknown, filterValue: unknown): number | null {
  const a = Number(cellValue)
  const b = Number(filterValue)
  if (isNaN(a) || isNaN(b)) return null
  if (a < b) return -1
  if (a > b) return 1
  return 0
}

function toSet(value: unknown): Set<string> {
  if (value == null) return new Set()
  if (Array.isArray(value)) {
    return new Set(value.map((v) => String(v).toLowerCase().trim()))
  }
  return new Set([String(value).toLowerCase().trim()])
}

// ── 集合操作 ──

function setIn(cellValue: unknown, filterValue: unknown): boolean {
  const filterSet = toSet(filterValue)
  if (filterSet.size === 0) return true
  const cellStr = String(cellValue ?? '').toLowerCase().trim()
  return filterSet.has(cellStr)
}

function setHasAnyOf(cellValue: unknown, filterValue: unknown): boolean {
  const cellSet = toSet(cellValue)
  const filterSet = toSet(filterValue)
  if (filterSet.size === 0) return true
  for (const item of filterSet) {
    if (cellSet.has(item)) return true
  }
  return false
}

function setHasAllOf(cellValue: unknown, filterValue: unknown): boolean {
  const cellSet = toSet(cellValue)
  const filterSet = toSet(filterValue)
  for (const item of filterSet) {
    if (!cellSet.has(item)) return false
  }
  return true
}

function setHasNoneOf(cellValue: unknown, filterValue: unknown): boolean {
  return !setHasAnyOf(cellValue, filterValue)
}

function setIsExactly(cellValue: unknown, filterValue: unknown): boolean {
  const cellSet = toSet(cellValue)
  const filterSet = toSet(filterValue)
  if (cellSet.size !== filterSet.size) return false
  for (const item of filterSet) {
    if (!cellSet.has(item)) return false
  }
  return true
}

// ── 操作符别名 ──

const OPERATOR_ALIASES: Record<string, string> = {
  is: 'equals',
  is_not: 'not_equals',
  '=': 'equals',
  '!=': 'not_equals',
  '>': 'greater_than',
  '<': 'less_than',
  '>=': 'greater_than_or_equal',
  '<=': 'less_than_or_equal',
  is_any_of: 'in',
  is_none_of: 'not_in',
}

function resolveOperator(op: string): string {
  return OPERATOR_ALIASES[op] ?? op
}

// ── 操作符求值 ──

export function evaluateOperator(cellValue: unknown, operator: string, filterValue: unknown): boolean {
  const op = resolveOperator(operator)

  switch (op) {
    case 'is_empty':
      return isEmpty(cellValue)
    case 'is_not_empty':
      return !isEmpty(cellValue)
    case 'equals':
      return looseEquals(cellValue, filterValue)
    case 'not_equals':
      return !looseEquals(cellValue, filterValue)
    case 'contains':
      return strContains(cellValue, filterValue)
    case 'not_contains':
    case 'does_not_contain':
      return !strContains(cellValue, filterValue)
    case 'starts_with':
      if (cellValue == null) return false
      return String(cellValue).toLowerCase().startsWith(String(filterValue ?? '').toLowerCase())
    case 'ends_with':
      if (cellValue == null) return false
      return String(cellValue).toLowerCase().endsWith(String(filterValue ?? '').toLowerCase())
    case 'greater_than': {
      const cmp = numericCompare(cellValue, filterValue)
      return cmp !== null && cmp > 0
    }
    case 'less_than': {
      const cmp = numericCompare(cellValue, filterValue)
      return cmp !== null && cmp < 0
    }
    case 'greater_than_or_equal': {
      const cmp = numericCompare(cellValue, filterValue)
      return cmp !== null && cmp >= 0
    }
    case 'less_than_or_equal': {
      const cmp = numericCompare(cellValue, filterValue)
      return cmp !== null && cmp <= 0
    }
    case 'in':
      return setIn(cellValue, filterValue)
    case 'not_in':
      return !setIn(cellValue, filterValue)
    case 'has_any_of':
      return setHasAnyOf(cellValue, filterValue)
    case 'has_all_of':
      return setHasAllOf(cellValue, filterValue)
    case 'has_none_of':
      return setHasNoneOf(cellValue, filterValue)
    case 'is_exactly':
      return setIsExactly(cellValue, filterValue)
    default:
      return false
  }
}

// ── 记录匹配 ──

export type RecordData = Record<string, unknown>

export interface FieldResolver {
  getFieldById(fieldId: string): { field_type: string } | undefined
}

export function recordMatchesFilter(
  record: RecordData,
  filter: FilterItem | FilterSet,
  fieldResolver?: FieldResolver,
): boolean {
  if (isFilterSet(filter)) {
    const { conjunction, filterSet } = filter
    if (filterSet.length === 0) return true

    if (conjunction === 'and') {
      return filterSet.every((item) => recordMatchesFilter(record, item, fieldResolver))
    } else {
      return filterSet.some((item) => recordMatchesFilter(record, item, fieldResolver))
    }
  }

  const { fieldId, operator, value: filterValue } = filter
  const cellValue = record[fieldId]
  return evaluateOperator(cellValue, operator, filterValue)
}

export function filterRecords(
  records: RecordData[],
  filter: FilterSet | null | undefined,
  fieldResolver?: FieldResolver,
): RecordData[] {
  if (!filter || !filter.filterSet || filter.filterSet.length === 0) return records
  return records.filter((r) => recordMatchesFilter(r, filter, fieldResolver))
}
