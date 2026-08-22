import { describe, expect, it } from 'vitest'
import {
  buildTableHistoryRefreshKey,
  shouldAbsorbExternalHistoryRefresh,
} from './tableHistoryRefresh'

describe('buildTableHistoryRefreshKey', () => {
  it('uses table-level version and totals only', () => {
    expect(
      buildTableHistoryRefreshKey({
        latest_version: 42,
        total: 11,
        matched_total: 11,
      }),
    ).toBe('42:11:11')
  })

  it('stays stable when per-row timestamps would have changed', () => {
    const before = buildTableHistoryRefreshKey({
      latest_version: 10,
      total: 4,
      matched_total: 4,
    })
    const after = buildTableHistoryRefreshKey({
      latest_version: 10,
      total: 4,
      matched_total: 4,
    })
    expect(before).toBe(after)
  })

  it('changes when latest_version or totals change', () => {
    const base = buildTableHistoryRefreshKey({
      latest_version: 10,
      total: 4,
      matched_total: 4,
    })
    expect(
      buildTableHistoryRefreshKey({
        latest_version: 11,
        total: 4,
        matched_total: 4,
      }),
    ).not.toBe(base)
    expect(
      buildTableHistoryRefreshKey({
        latest_version: 10,
        total: 11,
        matched_total: 4,
      }),
    ).not.toBe(base)
  })
})

describe('shouldAbsorbExternalHistoryRefresh', () => {
  it('ignores identical keys', () => {
    expect(
      shouldAbsorbExternalHistoryRefresh({
        open: true,
        restoreLoading: false,
        skipNextExternalRefresh: false,
        previousKey: '1:2:3',
        nextKey: '1:2:3',
      }),
    ).toBe('ignore')
  })

  it('absorbs external refresh while restore is in progress', () => {
    expect(
      shouldAbsorbExternalHistoryRefresh({
        open: true,
        restoreLoading: true,
        skipNextExternalRefresh: false,
        previousKey: '1:2:3',
        nextKey: '9:11:11',
      }),
    ).toBe('absorb')
  })

  it('absorbs one external refresh after successful restore fetch', () => {
    expect(
      shouldAbsorbExternalHistoryRefresh({
        open: true,
        restoreLoading: false,
        skipNextExternalRefresh: true,
        previousKey: '1:2:3',
        nextKey: '9:11:11',
      }),
    ).toBe('absorb')
  })

  it('refreshes when idle and key changes', () => {
    expect(
      shouldAbsorbExternalHistoryRefresh({
        open: true,
        restoreLoading: false,
        skipNextExternalRefresh: false,
        previousKey: '1:2:3',
        nextKey: '9:11:11',
      }),
    ).toBe('refresh')
  })
})
