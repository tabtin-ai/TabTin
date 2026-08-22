import { isEmptyGroupValue, type TableGridRow } from '@tabtin/table-engine'

export interface GroupOrderSnapshotItem {
  index: number
  level: number
  label: string
  value: unknown
  path: string
  count: number | null
  empty: boolean
}

export interface GroupOrderSnapshot {
  groups: GroupOrderSnapshotItem[]
  signature: string
  emptyGroupsLast: boolean
  siblingOrders: Record<string, string[]>
}

const asRecord = (row: TableGridRow): Record<string, unknown> =>
  row as unknown as Record<string, unknown>

const isEmptyGroup = (value: unknown, path: string): boolean =>
  isEmptyGroupValue(value) || path === '__empty__' || path.endsWith('||__empty__')

/**
 * Builds a serializable, presentation-order snapshot from the exact rows sent
 * to the grid. The snapshot is intentionally independent of React and canvas
 * internals so DEV probes can keep working when the renderer implementation
 * changes.
 */
export const buildGroupOrderSnapshot = (
  rows: ReadonlyArray<TableGridRow>,
): GroupOrderSnapshot => {
  const groups: GroupOrderSnapshotItem[] = []
  const siblingEmptyStates = new Map<string, boolean[]>()
  const siblingPaths = new Map<string, string[]>()
  const ancestorPathByLevel: string[] = []

  rows.forEach((row, index) => {
    const value = asRecord(row)
    if (value.__rowType !== 'group_header') return

    const rawLevel = Number(value.__groupLevel)
    const level = Number.isInteger(rawLevel) && rawLevel >= 0 ? rawLevel : 0
    const path = String(value.__groupPath ?? value.id ?? `group-${index}`)
    const groupValue = value.__groupValue ?? null
    const empty = isEmptyGroup(groupValue, path)
    const rawCount = Number(value.__groupCount)

    ancestorPathByLevel.length = level
    const parentPath = level === 0
      ? '__root__'
      : (ancestorPathByLevel[level - 1] ?? `__missing_parent__:${level}`)
    const siblingStates = siblingEmptyStates.get(parentPath) ?? []
    siblingStates.push(empty)
    siblingEmptyStates.set(parentPath, siblingStates)
    const paths = siblingPaths.get(parentPath) ?? []
    paths.push(path)
    siblingPaths.set(parentPath, paths)
    ancestorPathByLevel[level] = path

    groups.push({
      index,
      level,
      label: String(value.__groupLabel ?? ''),
      value: groupValue,
      path,
      count: Number.isFinite(rawCount) ? rawCount : null,
      empty,
    })
  })

  const emptyGroupsLast = Array.from(siblingEmptyStates.values()).every(states => {
    const firstEmpty = states.indexOf(true)
    return firstEmpty < 0 || states.slice(firstEmpty).every(Boolean)
  })

  return {
    groups,
    signature: JSON.stringify(groups.map(group => [group.level, group.path])),
    emptyGroupsLast,
    siblingOrders: Object.fromEntries(siblingPaths),
  }
}
