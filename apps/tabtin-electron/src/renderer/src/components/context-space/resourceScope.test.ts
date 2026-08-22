import { describe, expect, it } from 'vitest'
import {
  getTabdataResourceVisibility,
  isNonUserVisibleTabdataVisibility,
  isUserVisibleTabdataResourceItem,
  isUserVisibleTabdataTable,
} from './resourceScope'

describe('resourceScope tabdata visibility helpers', () => {
  it('treats system and hidden as non-user-visible visibilities', () => {
    expect(isNonUserVisibleTabdataVisibility('system')).toBe(true)
    expect(isNonUserVisibleTabdataVisibility('hidden')).toBe(true)
    expect(isNonUserVisibleTabdataVisibility('normal')).toBe(false)
    expect(isNonUserVisibleTabdataVisibility(undefined)).toBe(false)
  })

  it('keeps only user-visible tables in tabdata lists', () => {
    expect(isUserVisibleTabdataTable({ visibility: 'normal' })).toBe(true)
    expect(isUserVisibleTabdataTable({ visibility: undefined })).toBe(true)
    expect(isUserVisibleTabdataTable({ visibility: 'system' })).toBe(false)
    expect(isUserVisibleTabdataTable({ visibility: 'hidden' })).toBe(false)
  })

  it('filters tabdata resource items by metadata visibility only for tabdata items', () => {
    expect(getTabdataResourceVisibility({ item_type: 'tabdata', metadata: { visibility: 'hidden' } })).toBe('hidden')
    expect(getTabdataResourceVisibility({ item_type: 'tabdoc', metadata: { visibility: 'hidden' } })).toBeNull()

    expect(isUserVisibleTabdataResourceItem({ item_type: 'tabdata', metadata: { visibility: 'system' } })).toBe(false)
    expect(isUserVisibleTabdataResourceItem({ item_type: 'tabdata', metadata: { visibility: 'hidden' } })).toBe(false)
    expect(isUserVisibleTabdataResourceItem({ item_type: 'tabdata', metadata: {} })).toBe(true)
    expect(isUserVisibleTabdataResourceItem({ item_type: 'tabdoc', metadata: { visibility: 'hidden' } })).toBe(true)
  })
})
