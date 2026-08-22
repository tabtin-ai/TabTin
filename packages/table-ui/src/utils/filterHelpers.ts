/**
 * Shared helpers for the view filter panel.
 * Used by both Electron and Web ViewFilterPanel implementations.
 */
import type { ViewFilterEditorOption, ViewFilterEditorRule } from '../components/view/ViewFilterRulesEditor'

export const createFilterId = (): string => {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID()
  }
  return `filter_${Date.now()}_${Math.random().toString(36).slice(2)}`
}

const EMPTY_OPERATORS = new Set(['is_empty', 'is_not_empty'])

const ARRAY_OPERATORS_BY_FIELD_TYPE: Record<string, Set<string>> = {
  select: new Set(['is_any_of', 'is_none_of', 'in', 'not_in']),
  single_select: new Set(['is_any_of', 'is_none_of', 'in', 'not_in']), // legacy alias for select
  multi_select: new Set([
    'has_any_of',
    'has_all_of',
    'has_none_of',
    'is_exactly',
    'is_not_exactly',
    'contains',
    'not_contains',
    'equals',
    'not_equals',
    'in',
    'not_in',
  ]),
  user: new Set(['is_any_of', 'is_none_of', 'in', 'not_in']),
  created_by: new Set(['is_any_of', 'is_none_of', 'in', 'not_in']),
  last_modified_by: new Set(['is_any_of', 'is_none_of', 'in', 'not_in']),
}

const isArrayOperatorForField = (fieldType: string, operator: string): boolean =>
  ARRAY_OPERATORS_BY_FIELD_TYPE[fieldType]?.has(operator) ?? false

const DATE_FIELD_TYPES = new Set(['date', 'created_time', 'last_modified_time'])

export const LEGACY_DATE_FILTER_OPERATORS = new Set([
  'not_equals',
  'greater_than_or_equals',
  'less_than_or_equals',
  'is_within',
])

export const getDefaultFilterValue = (fieldType: string, operator: string): unknown => {
  if (EMPTY_OPERATORS.has(operator)) return null
  if (DATE_FIELD_TYPES.has(fieldType)) {
    let tz = 'UTC'
    try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone } catch { /* noop */ }
    return { mode: 'exactDate', exactDate: '', timeZone: tz }
  }
  if (fieldType === 'checkbox') return null
  if (
    fieldType === 'select' ||
    fieldType === 'single_select' /* legacy alias */ ||
    fieldType === 'multi_select' ||
    fieldType === 'user' ||
    fieldType === 'created_by' ||
    fieldType === 'last_modified_by'
  ) {
    return isArrayOperatorForField(fieldType, operator) ? [] : ''
  }
  return ''
}

export const normalizeOperatorForEditor = (fieldType: string, operator: string): string => {
  const normalizedType = fieldType === 'single_select' ? 'select' : fieldType
  if (normalizedType === 'checkbox') {
    return operator === 'equals' ? 'is' : operator
  }
  if (normalizedType === 'select') {
    if (operator === 'in') return 'is_any_of'
    if (operator === 'not_in') return 'is_none_of'
    return operator
  }
  if (normalizedType === 'multi_select') {
    if (operator === 'contains') return 'has_any_of'
    if (operator === 'equals') return 'has_all_of'
    if (operator === 'not_contains') return 'has_none_of'
    if (operator === 'not_equals') return 'is_not_exactly'
    return operator
  }
  return operator
}

export interface FilterOperatorLabels {
  common: {
    is: string
    contains: string
    not_contains: string
    equals: string
    not_equals: string
    in: string
    not_in: string
    is_empty: string
    is_not_empty: string
  }
  number: {
    greater_than: string
    greater_than_or_equals: string
    less_than: string
    less_than_or_equals: string
  }
  date: {
    greater_than: string
    greater_than_or_equals: string
    less_than: string
    less_than_or_equals: string
    is_within: string
  }
  select: { any_of: string; none_of: string }
  multiSelect: {
    has_any_of: string
    has_all_of: string
    has_none_of: string
    is_exactly: string
    is_not_exactly: string
  }
}

export const buildFilterOperatorOptions = (
  labels: FilterOperatorLabels,
): Record<string, ViewFilterEditorOption[]> => {
  const { common, number, date, select, multiSelect } = labels
  return {
    text: [
      { value: 'contains', label: common.contains },
      { value: 'not_contains', label: common.not_contains },
      { value: 'equals', label: common.equals },
      { value: 'not_equals', label: common.not_equals },
      { value: 'is_empty', label: common.is_empty },
      { value: 'is_not_empty', label: common.is_not_empty },
    ],
    number: [
      { value: 'equals', label: common.equals },
      { value: 'not_equals', label: common.not_equals },
      { value: 'greater_than', label: number.greater_than },
      { value: 'greater_than_or_equals', label: number.greater_than_or_equals },
      { value: 'less_than', label: number.less_than },
      { value: 'less_than_or_equals', label: number.less_than_or_equals },
      { value: 'is_empty', label: common.is_empty },
      { value: 'is_not_empty', label: common.is_not_empty },
    ],
    date: [
      { value: 'equals', label: common.equals },
      { value: 'not_equals', label: common.not_equals },
      { value: 'greater_than', label: date.greater_than },
      { value: 'greater_than_or_equals', label: date.greater_than_or_equals },
      { value: 'less_than', label: date.less_than },
      { value: 'less_than_or_equals', label: date.less_than_or_equals },
      { value: 'is_within', label: date.is_within },
      { value: 'is_empty', label: common.is_empty },
      { value: 'is_not_empty', label: common.is_not_empty },
    ],
    select: [
      { value: 'equals', label: common.equals },
      { value: 'not_equals', label: common.not_equals },
      { value: 'is_any_of', label: select.any_of },
      { value: 'is_none_of', label: select.none_of },
      { value: 'is_empty', label: common.is_empty },
      { value: 'is_not_empty', label: common.is_not_empty },
    ],
    multi_select: [
      { value: 'has_any_of', label: multiSelect.has_any_of },
      { value: 'has_all_of', label: multiSelect.has_all_of },
      { value: 'is_exactly', label: multiSelect.is_exactly },
      { value: 'is_not_exactly', label: multiSelect.is_not_exactly },
      { value: 'has_none_of', label: multiSelect.has_none_of },
      { value: 'is_empty', label: common.is_empty },
      { value: 'is_not_empty', label: common.is_not_empty },
    ],
    checkbox: [{ value: 'is', label: common.is }],
    attachment: [
      { value: 'is_empty', label: common.is_empty },
      { value: 'is_not_empty', label: common.is_not_empty },
    ],
  }
}

export const buildFieldTypeOperatorOptions = (
  operatorOptions: Record<string, ViewFilterEditorOption[]>,
): Record<string, ViewFilterEditorOption[]> => {
  const userOperators = [
    ...operatorOptions.select.filter(option => option.value === 'is_any_of'),
    ...operatorOptions.select.filter(option => option.value === 'is_none_of'),
    ...operatorOptions.select.filter(option => (
      option.value !== 'is_any_of' && option.value !== 'is_none_of'
    )),
  ]

  return {
    text: operatorOptions.text,
    long_text: operatorOptions.text,
    url: operatorOptions.text,
    email: operatorOptions.text,
    phone: operatorOptions.text,
    number: operatorOptions.number,
    currency: operatorOptions.number,
    percent: operatorOptions.number,
    rating: operatorOptions.number,
    date: operatorOptions.date,
    created_time: operatorOptions.date,
    last_modified_time: operatorOptions.date,
    select: operatorOptions.select,
    single_select: operatorOptions.select, // legacy alias for select
    multi_select: operatorOptions.multi_select,
    checkbox: operatorOptions.checkbox,
    attachment: operatorOptions.attachment,
    link: operatorOptions.attachment,
    user: userOperators,
    created_by: userOperators,
    last_modified_by: userOperators,
  }
}

export interface FilterableField {
  id: string
  name: string
  field_type: string
  is_hidden?: boolean
  options?: Record<string, unknown>
}

export interface FilterRule {
  id: string
  field_id: string
  operator: string
  value: unknown
  enabled: boolean
}

export const mapFiltersToEditorRules = (
  filters: FilterRule[],
  fields: FilterableField[],
): ViewFilterEditorRule[] =>
  filters.map(filter => {
    const resolvedField =
      fields.find(f => f.id === filter.field_id) ??
      fields.find(f => f.name === filter.field_id)
    const fieldType = resolvedField ? String(resolvedField.field_type) : 'text'
    return {
      id: filter.id,
      fieldId: filter.field_id,
      operator: normalizeOperatorForEditor(fieldType, filter.operator),
      value: filter.value,
      enabled: filter.enabled !== false,
    }
  })

export const mapFieldsToEditorFields = (
  fields: FilterableField[],
) =>
  fields.map(field => ({
    id: field.id,
    name: field.name,
    fieldType: String(field.field_type),
    isHidden: field.is_hidden,
    options: field.options,
  }))
