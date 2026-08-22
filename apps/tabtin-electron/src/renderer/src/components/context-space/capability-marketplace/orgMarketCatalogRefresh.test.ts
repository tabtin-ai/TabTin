import { describe, expect, it } from 'vitest'
import {
  ORG_MARKET_CATALOG_POLL_MS,
  shouldRefreshOrgMarketCatalog,
} from './orgMarketCatalogRefresh'

describe('shouldRefreshOrgMarketCatalog', () => {
  it('only refreshes when live catalog is active for an organization', () => {
    expect(shouldRefreshOrgMarketCatalog({
      liveCatalog: true,
      catalogActive: true,
      organizationId: 'org-1',
    })).toBe(true)

    expect(shouldRefreshOrgMarketCatalog({
      liveCatalog: false,
      catalogActive: true,
      organizationId: 'org-1',
    })).toBe(false)

    expect(shouldRefreshOrgMarketCatalog({
      liveCatalog: true,
      catalogActive: false,
      organizationId: 'org-1',
    })).toBe(false)

    expect(shouldRefreshOrgMarketCatalog({
      liveCatalog: true,
      catalogActive: true,
      organizationId: null,
    })).toBe(false)
  })

  it('keeps poll interval aligned with skills liveCatalog', () => {
    expect(ORG_MARKET_CATALOG_POLL_MS).toBe(15_000)
  })
})
