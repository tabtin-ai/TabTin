import { describe, expect, it } from 'vitest'
import {
  EMPTY_MARKETPLACE_SHELF_FILTERS,
  shouldResetMarketplaceShelfFilters,
} from './marketplaceShelfFilterReset'

describe('marketplaceShelfFilterReset', () => {
  it('空筛选初值', () => {
    expect(EMPTY_MARKETPLACE_SHELF_FILTERS).toEqual({
      search: '',
      category: 'all',
      mineScope: 'all',
      workspaceScopeId: null,
    })
  })

  it('组织或货架 tab 变更时要清空', () => {
    expect(shouldResetMarketplaceShelfFilters('org-a', 'org-b')).toBe(true)
    expect(shouldResetMarketplaceShelfFilters('mine', 'recommended')).toBe(true)
    expect(shouldResetMarketplaceShelfFilters('recommended', 'organization')).toBe(true)
  })

  it('同组织 / 同 tab 再点不清理', () => {
    expect(shouldResetMarketplaceShelfFilters('org-a', 'org-a')).toBe(false)
    expect(shouldResetMarketplaceShelfFilters('mine', 'mine')).toBe(false)
    expect(shouldResetMarketplaceShelfFilters(null, null)).toBe(false)
  })
})
