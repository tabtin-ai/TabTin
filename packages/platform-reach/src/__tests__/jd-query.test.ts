import { describe, expect, it } from 'vitest'
import {
  buildJdSearchUrl,
  JD_SEARCH_CONSTRAINTS,
  mapJdSortToPsort,
} from '../adapters/jd-query'
import { createDefaultRegistry } from '../index'
import { decideSearchRouting } from '../routing-gate'

describe('mapJdSortToPsort', () => {
  it('maps sale / 销量 to psort=3 (live)', () => {
    expect(mapJdSortToPsort('sale')).toBe('3')
    expect(mapJdSortToPsort('销量')).toBe('3')
  })

  it('maps price / latest', () => {
    expect(mapJdSortToPsort('price_asc')).toBe('2')
    expect(mapJdSortToPsort('price_desc')).toBe('2')
    expect(mapJdSortToPsort('latest')).toBe('5')
  })

  it('omits default', () => {
    expect(mapJdSortToPsort('default')).toBeUndefined()
    expect(mapJdSortToPsort('综合')).toBeUndefined()
  })
})

describe('buildJdSearchUrl', () => {
  it('sale sort sets psort=3 without enc=', () => {
    const url = buildJdSearchUrl({ query: '机械键盘', sort: 'sale' })
    const u = new URL(url)
    expect(u.hostname).toBe('search.jd.com')
    expect(u.searchParams.get('keyword')).toBe('机械键盘')
    expect(u.searchParams.get('psort')).toBe('3')
    expect(url).not.toContain('enc=')
  })
})

describe('jd adapter searchConstraints', () => {
  it('declares sale so routing gate allows 销量前五', () => {
    const jd = createDefaultRegistry().get('jd')
    expect(jd?.searchConstraints?.sorts).toEqual([...JD_SEARCH_CONSTRAINTS.sorts])
    const decision = decideSearchRouting(jd, [{ kind: 'sort', key: '销量' }])
    expect(decision.allowReach).toBe(true)
  })
})
