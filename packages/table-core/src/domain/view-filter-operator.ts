import type { ViewFilter, FilterSet, FilterItem } from '../data'
import { isFilterSet } from '../data'

const FILTER_OPERATOR_BACKEND_COMPAT_MAP: Record<string, string> = {
  is_any_of: 'in',
  is_none_of: 'not_in',
  has_any_of: 'contains',
  has_all_of: 'equals',
  has_none_of: 'not_contains',
}

export const toBackendCompatibleFilterOperator = (operator: string): string =>
  FILTER_OPERATOR_BACKEND_COMPAT_MAP[operator] ?? operator

export const normalizeViewFilterForBackend = (filter: ViewFilter): ViewFilter => ({
  ...filter,
  operator: toBackendCompatibleFilterOperator(String(filter.operator)),
})

export const normalizeViewFiltersForBackend = (
  filters: ViewFilter[] | undefined
): ViewFilter[] | undefined => {
  if (!Array.isArray(filters)) return filters
  return filters.map(normalizeViewFilterForBackend)
}

/**
 * 递归归一化嵌套 FilterSet 中的操作符（将前端名称映射为后端名称）
 */
export const normalizeFilterSetForBackend = (
  filterSet: FilterSet,
): FilterSet => ({
  conjunction: filterSet.conjunction,
  filterSet: filterSet.filterSet.map((item): FilterItem | FilterSet => {
    if (isFilterSet(item)) {
      return normalizeFilterSetForBackend(item)
    }
    return {
      ...item,
      operator: toBackendCompatibleFilterOperator(String(item.operator)),
    }
  }),
})
