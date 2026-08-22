import { describe, expect, it } from 'vitest'
import {
  buildTaobaoApplySortExpr,
  buildTaobaoSearchUrl,
  mapTaobaoSortToUrl,
  taobaoSearchQueryFromArgs,
  TAOBAO_SEARCH_CONSTRAINTS,
} from '../adapters/taobao-query'
import { decideSearchRouting } from '../routing-gate'
import { createDefaultRegistry } from '../index'

describe('mapTaobaoSortToUrl', () => {
  it('maps sale / 销量 to _sale（现网 runtime）', () => {
    expect(mapTaobaoSortToUrl('sale')).toBe('_sale')
    expect(mapTaobaoSortToUrl('销量')).toBe('_sale')
  })

  it('maps price to bid / _bid（升序 bid，降序 _bid）', () => {
    expect(mapTaobaoSortToUrl('price_asc')).toBe('bid')
    expect(mapTaobaoSortToUrl('price_desc')).toBe('_bid')
    expect(mapTaobaoSortToUrl('价格升序')).toBe('bid')
    expect(mapTaobaoSortToUrl('latest')).toBe('oldstart')
  })

  it('omits default', () => {
    expect(mapTaobaoSortToUrl('default')).toBeUndefined()
    expect(mapTaobaoSortToUrl('综合')).toBeUndefined()
  })
})

describe('buildTaobaoSearchUrl', () => {
  it('P0: sort=_sale', () => {
    const url = buildTaobaoSearchUrl({ query: '机械键盘', sort: 'sale' })
    const u = new URL(url)
    expect(u.searchParams.get('q')).toBe('机械键盘')
    expect(u.searchParams.get('sort')).toBe('_sale')
    expect(u.searchParams.get('tab')).toBe('all')
  })

  it('P1: price range + page + tmall tab', () => {
    const url = buildTaobaoSearchUrl({
      query: '露营椅',
      sort: 'price_asc',
      minPrice: 50,
      maxPrice: 200,
      page: 2,
      filters: ['tmall'],
    })
    const u = new URL(url)
    expect(u.searchParams.get('sort')).toBe('bid')
    expect(u.searchParams.get('start_price')).toBe('50')
    expect(u.searchParams.get('end_price')).toBe('200')
    expect(u.searchParams.get('page')).toBe('2')
    expect(u.searchParams.get('tab')).toBe('mall')
  })

  it('tmall adapter reuses taobao search surface (tab=mall), not list.tmall.com', () => {
    const tmall = createDefaultRegistry().get('tmall')
    expect(tmall?.domains).toEqual(expect.arrayContaining(['tmall.com']))
    expect(tmall?.searchConstraints?.sorts).toEqual([...TAOBAO_SEARCH_CONSTRAINTS.sorts])
    // 天猫入口隐含 mall tab；filters 只再暴露包邮，避免重复声明 tmall
    expect(tmall?.searchConstraints?.filters).toEqual(['free_shipping'])
    const url = buildTaobaoSearchUrl({ query: '露营椅', filters: ['tmall'] })
    expect(url).toContain('s.taobao.com')
    expect(url).not.toContain('list.tmall.com')
    expect(new URL(url).searchParams.get('tab')).toBe('mall')
  })

  it('buildTaobaoApplySortExpr uses React props path for price sorts', () => {
    expect(buildTaobaoApplySortExpr('bid')).toContain('reactPriceSort')
    expect(buildTaobaoApplySortExpr('bid')).toContain("'bid'")
    expect(buildTaobaoApplySortExpr('_bid')).toContain("'_bid'")
    expect(buildTaobaoApplySortExpr('_sale')).toContain('销量')
    expect(buildTaobaoApplySortExpr('_bid')).toContain('__reactFiber$')
  })

  it('P2: free_shipping filter=myf', () => {
    const url = buildTaobaoSearchUrl({
      query: '机械键盘',
      filters: ['包邮'],
    })
    expect(new URL(url).searchParams.get('filter')).toBe('myf')
  })
})

describe('taobaoSearchQueryFromArgs + routing gate', () => {
  it('parses CLI-ish args', () => {
    expect(
      taobaoSearchQueryFromArgs({
        query: 'x',
        sort: '销量',
        min_price: '10',
        max_price: 99,
        page: '3',
        filter: 'tmall,free_shipping',
      }),
    ).toEqual({
      query: 'x',
      sort: '销量',
      minPrice: 10,
      maxPrice: 99,
      page: 3,
      filters: ['tmall', 'free_shipping'],
    })
  })

  it('declared constraints allow sale sort through gate', () => {
    const d = decideSearchRouting(
      { searchConstraints: { ...TAOBAO_SEARCH_CONSTRAINTS, sorts: [...TAOBAO_SEARCH_CONSTRAINTS.sorts], filters: [...TAOBAO_SEARCH_CONSTRAINTS.filters] } },
      [{ kind: 'sort', key: '销量' }],
    )
    expect(d.allowReach).toBe(true)
  })
})
