import type { ViewFilter, ViewGroup, ViewSort } from '@tabtin/table-core'

export interface FilterEditorItem {
  id: string
  fieldId: string
  operator: string
  valueText: string
  enabled: boolean
}

export interface SortEditorItem {
  id: string
  fieldId: string
  direction: 'asc' | 'desc'
}

export interface GroupEditorItem {
  id: string
  fieldId: string
  direction: 'asc' | 'desc'
}

interface ViewFilterInput {
  id?: string
  field_id?: string
  operator?: string
  value?: unknown
  enabled?: boolean
}

interface ViewSortInput {
  field_id?: string
  direction?: string
}

interface ViewGroupInput {
  field_id?: string
  direction?: string
}

const NUMBER_LIKE_VALUE_PATTERN = /^-?\d+(\.\d+)?$/

export const FILTER_OPERATOR_OPTIONS: Array<{ label: string; value: string }> = [
  { label: '等于', value: 'equals' },
  { label: '不等于', value: 'not_equals' },
  { label: '包含', value: 'contains' },
  { label: '不包含', value: 'not_contains' },
  { label: '大于', value: 'greater_than' },
  { label: '小于', value: 'less_than' },
  { label: '大于等于', value: 'greater_than_or_equal' },
  { label: '小于等于', value: 'less_than_or_equal' },
  { label: '为空', value: 'is_empty' },
  { label: '不为空', value: 'is_not_empty' },
]

export const buildEditorItemId = (prefix: string): string =>
  `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`

const stringifyEditorValue = (value: unknown): string => {
  if (value === null || value === undefined) {
    return ''
  }
  if (typeof value === 'string') {
    return value
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value)
  }

  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

const parseEditorValue = (valueText: string): unknown => {
  const trimmed = valueText.trim()
  if (!trimmed) {
    return ''
  }

  if (trimmed === 'true') return true
  if (trimmed === 'false') return false
  if (trimmed === 'null') return null
  if (NUMBER_LIKE_VALUE_PATTERN.test(trimmed)) return Number(trimmed)

  const startsWithJsonToken =
    (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
    (trimmed.startsWith('[') && trimmed.endsWith(']')) ||
    (trimmed.startsWith('"') && trimmed.endsWith('"'))

  if (startsWithJsonToken) {
    try {
      return JSON.parse(trimmed)
    } catch {
      return valueText
    }
  }

  return valueText
}

export const toFilterEditorItems = (filters: ViewFilterInput[]): FilterEditorItem[] => {
  return filters.map((filter, index) => ({
    id: filter.id || buildEditorItemId(`filter-${index}`),
    fieldId: filter.field_id ?? '',
    operator: filter.operator ?? 'equals',
    valueText: stringifyEditorValue(filter.value),
    enabled: filter.enabled !== false,
  }))
}

export const toSortEditorItems = (sorts: ViewSortInput[]): SortEditorItem[] => {
  return sorts.map((sort, index) => ({
    id: buildEditorItemId(`sort-${index}`),
    fieldId: sort.field_id ?? '',
    direction: sort.direction === 'desc' ? 'desc' : 'asc',
  }))
}

export const toGroupEditorItems = (groups: ViewGroupInput[]): GroupEditorItem[] => {
  return groups.map((group, index) => ({
    id: buildEditorItemId(`group-${index}`),
    fieldId: group.field_id ?? '',
    direction: group.direction === 'desc' ? 'desc' : 'asc',
  }))
}

export const toViewFilters = (
  items: FilterEditorItem[],
  availableFieldIds: string[]
): ViewFilter[] => {
  const availableSet = new Set(availableFieldIds)

  return items.map((item, index) => {
    const fieldId = item.fieldId.trim()
    const operator = item.operator.trim()

    if (!fieldId) {
      throw new Error(`第 ${index + 1} 条筛选缺少字段`)
    }
    if (!operator) {
      throw new Error(`第 ${index + 1} 条筛选缺少操作符`)
    }
    if (!availableSet.has(fieldId)) {
      throw new Error(`第 ${index + 1} 条筛选字段无效：${fieldId}`)
    }

    return {
      id: item.id || buildEditorItemId(`filter-${index}`),
      field_id: fieldId,
      operator,
      value: parseEditorValue(item.valueText),
      enabled: item.enabled !== false,
    }
  })
}

export const toViewSorts = (items: SortEditorItem[], availableFieldIds: string[]): ViewSort[] => {
  const availableSet = new Set(availableFieldIds)

  return items.map((item, index) => {
    const fieldId = item.fieldId.trim()
    if (!fieldId) {
      throw new Error(`第 ${index + 1} 条排序缺少字段`)
    }
    if (!availableSet.has(fieldId)) {
      throw new Error(`第 ${index + 1} 条排序字段无效：${fieldId}`)
    }

    return {
      field_id: fieldId,
      direction: item.direction === 'desc' ? 'desc' : 'asc',
      priority: index + 1,
    }
  })
}

export const toViewGroups = (
  items: GroupEditorItem[],
  availableFieldIds: string[]
): ViewGroup[] => {
  const availableSet = new Set(availableFieldIds)

  return items.map((item, index) => {
    const fieldId = item.fieldId.trim()
    if (!fieldId) {
      throw new Error(`第 ${index + 1} 条分组缺少字段`)
    }
    if (!availableSet.has(fieldId)) {
      throw new Error(`第 ${index + 1} 条分组字段无效：${fieldId}`)
    }

    return {
      field_id: fieldId,
      direction: item.direction === 'desc' ? 'desc' : 'asc',
    }
  })
}
