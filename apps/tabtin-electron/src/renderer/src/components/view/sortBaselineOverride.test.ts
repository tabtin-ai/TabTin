import type { ViewSort } from '@tabtin/table-core'
import { describe, expect, it } from 'vitest'
import {
  createSortBaselineOverride,
  resolveSortBaseline,
} from './sortBaselineOverride'

const sorts = (fieldId: string): ViewSort[] => [
  { field_id: fieldId, direction: 'asc' },
]

describe('sortBaselineOverride', () => {
  it('uses the local save while propagation is pending, then yields to authoritative sorts', () => {
    const persistedBeforeSave = sorts('before-save')
    const locallySaved = sorts('local-save')
    const remoteUpdate = sorts('remote-update')
    const override = createSortBaselineOverride(locallySaved, persistedBeforeSave)

    expect(resolveSortBaseline(persistedBeforeSave, override)).toEqual({
      sorts: locallySaved,
      shouldClearOverride: false,
    })
    expect(resolveSortBaseline(remoteUpdate, override)).toEqual({
      sorts: remoteUpdate,
      shouldClearOverride: true,
    })
  })
})
