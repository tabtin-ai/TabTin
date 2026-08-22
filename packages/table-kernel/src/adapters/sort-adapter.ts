/**
 * 外部排序结构 → 内核排序结构 适配
 *
 * table-core/Django 的 ViewSort 使用 field_id + direction，
 * 内核的 SortConfig 使用 fieldId + order。
 */

import type { SortConfig } from '../sort/index.js'

export interface ExternalViewSort {
  field_id: string
  direction: 'asc' | 'desc'
  priority?: number
}

export function externalSortToKernel(sort: ExternalViewSort): SortConfig {
  return {
    fieldId: sort.field_id,
    order: sort.direction,
  }
}

export function externalSortsToKernel(sorts: ExternalViewSort[]): SortConfig[] {
  const sorted = [...sorts].sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0))
  return sorted.map(externalSortToKernel)
}

export function kernelSortToExternal(sort: SortConfig): ExternalViewSort {
  return {
    field_id: sort.fieldId,
    direction: sort.order,
  }
}

export function kernelSortsToExternal(sorts: SortConfig[]): ExternalViewSort[] {
  return sorts.map((s, i) => ({ ...kernelSortToExternal(s), priority: i }))
}
