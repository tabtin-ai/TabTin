/**
 * 外部过滤结构 → 内核过滤结构 适配
 *
 * table-core/Django 的 FilterItem 使用 field_id（snake_case），
 * 内核的 FilterItem 使用 fieldId（camelCase）。
 */

import type { FilterItem, FilterSet } from '../filter/index.js'
import { isFilterSet } from '../filter/index.js'

export interface ExternalFilterItem {
  field_id: string
  operator: string
  value?: unknown
}

export interface ExternalFilterSet {
  conjunction: 'and' | 'or'
  filterSet: Array<ExternalFilterItem | ExternalFilterSet>
}

function isExternalFilterSet(item: unknown): item is ExternalFilterSet {
  return typeof item === 'object' && item !== null && 'conjunction' in item && 'filterSet' in item
}

function adaptFilterItem(ext: ExternalFilterItem): FilterItem {
  return {
    fieldId: ext.field_id,
    operator: ext.operator,
    value: ext.value,
  }
}

/**
 * 将外部（snake_case field_id）的过滤结构递归转为内核格式
 */
export function externalFilterToKernel(
  filter: ExternalFilterItem | ExternalFilterSet,
): FilterItem | FilterSet {
  if (isExternalFilterSet(filter)) {
    return {
      conjunction: filter.conjunction,
      filterSet: filter.filterSet.map(externalFilterToKernel),
    }
  }
  return adaptFilterItem(filter)
}

/**
 * 将内核格式的过滤结构递归转为外部（snake_case field_id）格式
 */
export function kernelFilterToExternal(
  filter: FilterItem | FilterSet,
): ExternalFilterItem | ExternalFilterSet {
  if (isFilterSet(filter)) {
    return {
      conjunction: filter.conjunction,
      filterSet: filter.filterSet.map(kernelFilterToExternal),
    }
  }
  return {
    field_id: filter.fieldId,
    operator: filter.operator,
    value: filter.value,
  }
}
