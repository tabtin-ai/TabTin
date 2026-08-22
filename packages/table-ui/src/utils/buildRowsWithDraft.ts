/**
 * 将 draft 行插入到 groupedRows 的正确位置。
 *
 * 优先按 group_path 精确匹配 → group_values 匹配 →
 * draftRowData 推断分组值匹配 → 首个 group_add 兜底 → 全局 add 行 → 末尾追加。
 */

import type { TableGridRowType } from '@tabtin/table-engine'

export interface GroupRowLike {
  __rowType?: TableGridRowType
  __groupPath?: string
  __groupValues?: Record<string, unknown>
  [key: string]: unknown
}

export interface DraftAddRowContext {
  group_path?: string
  group_values?: Record<string, unknown>
}

export interface GroupFieldInfo {
  field_id: string
}

export interface FieldMetaLike {
  id: string
  name: string
}

export interface BuildRowsWithDraftOptions<T extends GroupRowLike> {
  groupedRows: T[]
  draftRowData: Record<string, unknown> | null
  hasGrouping: boolean
  draftAddRowContext?: DraftAddRowContext | null
  /** view 的 groups 配置，用于 fallback 分组推断 */
  viewGroups?: GroupFieldInfo[]
  /** 按 id 查找字段的映射，用于 fallback 分组推断 */
  getFieldById?: (id: string) => FieldMetaLike | undefined
}

export function normalizeGroupValue(value: unknown): string {
  if (value === null || value === undefined) return '__empty__'
  if (Array.isArray(value)) return JSON.stringify(value)
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

export function isGroupValuesMatch(
  sourceValues: Record<string, unknown> | undefined,
  targetValues: Record<string, unknown> | null | undefined,
): boolean {
  if (!sourceValues || !targetValues) return false
  const keys = Object.keys(targetValues)
  if (keys.length === 0) return false
  return keys.every(k => normalizeGroupValue(sourceValues[k]) === normalizeGroupValue(targetValues[k]))
}

export function buildRowsWithDraft<T extends GroupRowLike>(
  options: BuildRowsWithDraftOptions<T>,
): T[] {
  const {
    groupedRows,
    draftRowData,
    hasGrouping,
    draftAddRowContext,
    viewGroups,
    getFieldById,
  } = options

  if (!draftRowData) return groupedRows

  const globalAddIndex = groupedRows.findIndex(row => row.__rowType === 'add')
  let insertIndex = -1
  let anchorRow: T | undefined

  if (hasGrouping) {
    // 1. 按 group_path 精确匹配
    if (draftAddRowContext?.group_path) {
      insertIndex = groupedRows.findIndex(
        row => row.__rowType === 'group_add' && row.__groupPath === draftAddRowContext.group_path,
      )
      if (insertIndex >= 0) anchorRow = groupedRows[insertIndex]

      if (insertIndex < 0) {
        const headerIdx = groupedRows.findIndex(
          row => row.__rowType === 'group_header' && row.__groupPath === draftAddRowContext.group_path,
        )
        if (headerIdx >= 0) {
          insertIndex = headerIdx + 1
          anchorRow = groupedRows[headerIdx]
        }
      }
    }

    // 2. 按 group_values 匹配
    if (insertIndex < 0 && draftAddRowContext?.group_values) {
      insertIndex = groupedRows.findIndex(
        row => row.__rowType === 'group_add' && isGroupValuesMatch(row.__groupValues, draftAddRowContext.group_values),
      )
      if (insertIndex >= 0) anchorRow = groupedRows[insertIndex]
    }

    // 3. 从 draftRowData 推断分组值做 fallback
    if (insertIndex < 0 && viewGroups?.length && getFieldById) {
      const fallbackGv: Record<string, unknown> = {}
      for (const group of viewGroups) {
        const fieldMeta = getFieldById(group.field_id)
        if (!fieldMeta) continue
        const val = draftRowData[fieldMeta.name]
        if (val === undefined || val === null || val === '') continue
        fallbackGv[fieldMeta.name] = val
      }
      if (Object.keys(fallbackGv).length > 0) {
        insertIndex = groupedRows.findIndex(
          row => row.__rowType === 'group_add' && isGroupValuesMatch(row.__groupValues, fallbackGv),
        )
        if (insertIndex >= 0) anchorRow = groupedRows[insertIndex]
      }
    }

    // 4. 兜底：首个 group_add
    if (insertIndex < 0) {
      const hasAnyGroupAdd = groupedRows.some(row => row.__rowType === 'group_add')
      if (hasAnyGroupAdd) {
        insertIndex = groupedRows.findIndex(row => row.__rowType === 'group_add')
        if (insertIndex >= 0) anchorRow = groupedRows[insertIndex]
      }
    }
  } else {
    insertIndex = globalAddIndex
    if (insertIndex >= 0) anchorRow = groupedRows[insertIndex]
  }

  const draftRow = {
    ...draftRowData,
    __rowType: 'draft' as const,
    __inlineDraft: true,
    ...(anchorRow &&
      (anchorRow.__rowType === 'group_add' || anchorRow.__rowType === 'group_header') &&
      typeof anchorRow.__groupPath === 'string'
        ? { __groupPath: anchorRow.__groupPath }
        : {}),
    ...(anchorRow &&
      (anchorRow.__rowType === 'group_add' || anchorRow.__rowType === 'group_header') &&
      anchorRow.__groupValues
        ? { __groupValues: anchorRow.__groupValues }
        : {}),
  } as unknown as T

  if (insertIndex < 0) return [...groupedRows, draftRow]
  const nextRows = [...groupedRows]
  nextRows.splice(insertIndex, 0, draftRow)
  return nextRows
}
