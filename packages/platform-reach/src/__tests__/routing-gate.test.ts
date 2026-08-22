import { describe, expect, it } from 'vitest'
import {
  decideSearchRouting,
  normalizeSortKey,
  unmatchedSearchConstraints,
} from '../routing-gate'
import { EMPTY_SEARCH_CONSTRAINTS } from '../adapter'

describe('normalizeSortKey', () => {
  it('maps 销量 / sale-desc to sale', () => {
    expect(normalizeSortKey('销量')).toBe('sale')
    expect(normalizeSortKey('sale-desc')).toBe('sale')
    expect(normalizeSortKey('按销量')).toBe('sale')
  })

  it('maps 综合 to default', () => {
    expect(normalizeSortKey('综合')).toBe('default')
  })
})

describe('unmatchedSearchConstraints', () => {
  it('default sort is never a gap', () => {
    expect(
      unmatchedSearchConstraints(EMPTY_SEARCH_CONSTRAINTS, [
        { kind: 'sort', key: '综合' },
      ]),
    ).toEqual([])
  })

  it('sale is a gap when sorts empty (当前全平台现状)', () => {
    expect(
      unmatchedSearchConstraints(EMPTY_SEARCH_CONSTRAINTS, [
        { kind: 'sort', key: '销量' },
      ]),
    ).toEqual([{ kind: 'sort', key: 'sale' }])
  })

  it('sale ok when declared', () => {
    expect(
      unmatchedSearchConstraints(
        { sorts: ['sale'], filters: [] },
        [{ kind: 'sort', key: '销量' }],
      ),
    ).toEqual([])
  })
})

describe('decideSearchRouting', () => {
  it('blocks reach when user wants sale sort and adapter undeclared', () => {
    const d = decideSearchRouting(undefined, [{ kind: 'sort', key: '销量' }])
    expect(d.allowReach).toBe(false)
    if (!d.allowReach) {
      expect(d.hint).toMatch(/禁止再用默认序 reach/)
      expect(d.unmatched).toEqual([{ kind: 'sort', key: 'sale' }])
    }
  })

  it('allows reach when no extra constraints', () => {
    const d = decideSearchRouting({ searchConstraints: EMPTY_SEARCH_CONSTRAINTS }, [])
    expect(d.allowReach).toBe(true)
  })

  it('allows reach when constraint covered', () => {
    const d = decideSearchRouting(
      { searchConstraints: { sorts: ['sale'], filters: [] } },
      [{ kind: 'sort', key: 'sale' }],
    )
    expect(d.allowReach).toBe(true)
  })
})
