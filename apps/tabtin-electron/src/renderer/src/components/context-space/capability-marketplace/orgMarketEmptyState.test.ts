import { describe, expect, it } from 'vitest'
import { resolveOrgMarketEmptyKind } from './orgMarketEmptyState'

describe('resolveOrgMarketEmptyKind', () => {
  it('prefer loadFailed when orgError is set', () => {
    expect(resolveOrgMarketEmptyKind({ orgError: 'boom', visibleCount: 0 })).toBe('loadFailed')
    expect(resolveOrgMarketEmptyKind({ orgError: 'boom', visibleCount: 2 })).toBe('loadFailed')
  })

  it('returns noMatch when list is empty without error', () => {
    expect(resolveOrgMarketEmptyKind({ orgError: null, visibleCount: 0 })).toBe('noMatch')
  })

  it('returns null when there are visible rows', () => {
    expect(resolveOrgMarketEmptyKind({ orgError: null, visibleCount: 1 })).toBeNull()
  })
})
