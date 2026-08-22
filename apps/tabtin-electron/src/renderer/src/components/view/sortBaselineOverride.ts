import {
  areViewConfigValuesEqual,
  type ViewSort,
} from '@tabtin/table-core'

export interface SortBaselineOverride {
  savedSorts: ViewSort[]
  persistedSortsAtSave: ViewSort[]
}

export interface ResolvedSortBaseline {
  sorts: ViewSort[]
  shouldClearOverride: boolean
}

const copySorts = (sorts: ViewSort[]): ViewSort[] =>
  sorts.map(sort => ({ ...sort }))

export const createSortBaselineOverride = (
  savedSorts: ViewSort[],
  persistedSortsAtSave: ViewSort[],
): SortBaselineOverride => ({
  savedSorts: copySorts(savedSorts),
  persistedSortsAtSave: copySorts(persistedSortsAtSave),
})

export const resolveSortBaseline = (
  persistedSorts: ViewSort[],
  override: SortBaselineOverride | undefined,
): ResolvedSortBaseline => {
  if (!override) {
    return { sorts: persistedSorts, shouldClearOverride: false }
  }

  if (!areViewConfigValuesEqual(persistedSorts, override.persistedSortsAtSave)) {
    return { sorts: persistedSorts, shouldClearOverride: true }
  }

  return { sorts: override.savedSorts, shouldClearOverride: false }
}
