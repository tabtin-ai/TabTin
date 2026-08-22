import { describe, expect, it } from 'vitest'
import {
  TABLE_PANE_RETENTION_MS,
  updateTablePaneRetention,
} from './tablePaneRetention'

describe('updateTablePaneRetention', () => {
  it('retains an inactive table while its tab remains open', () => {
    const result = updateTablePaneRetention(
      ['table-b'],
      ['table-a', 'table-b'],
      ['table-a'],
      new Map(),
      100,
    )

    expect(result.retainedTableIds).toEqual(['table-a'])
    expect(result.retainedUntil.get('table-a')).toBe(100 + TABLE_PANE_RETENTION_MS)
    expect(result.nextExpiryAt).toBe(100 + TABLE_PANE_RETENTION_MS)
  })

  it('releases a table immediately when its tab is closed', () => {
    const result = updateTablePaneRetention(
      ['table-b'],
      ['table-b'],
      [],
      new Map([['table-a', 10_000]]),
      100,
    )

    expect(result.retainedTableIds).toEqual([])
  })

  it('drops expired entries and schedules the next live entry', () => {
    const result = updateTablePaneRetention(
      ['table-c'],
      ['table-a', 'table-b', 'table-c'],
      ['table-a', 'table-b'],
      new Map([
        ['table-a', 99],
        ['table-b', 250],
      ]),
      100,
    )

    expect(result.retainedTableIds).toEqual(['table-b', 'table-a'])
    expect(result.nextExpiryAt).toBe(250)
  })

  it('keeps a retained table through another tab switch', () => {
    const result = updateTablePaneRetention(
      ['table-c'],
      ['table-a', 'table-b', 'table-c'],
      ['table-b'],
      new Map([['table-a', 30_000]]),
      1_000,
    )

    expect(result.retainedTableIds).toEqual(['table-a', 'table-b'])
    expect(result.retainedUntil.get('table-a')).toBe(30_000)
    expect(result.retainedUntil.get('table-b')).toBe(91_000)
  })

  it('does not mutate the committed snapshot during a discarded calculation', () => {
    const committedRetainedUntil = new Map<string, number>()

    updateTablePaneRetention(
      ['table-b'],
      ['table-a', 'table-b', 'table-c'],
      ['table-a'],
      committedRetainedUntil,
      100,
      1_000,
    )

    expect(committedRetainedUntil.size).toBe(0)

    const committedResult = updateTablePaneRetention(
      ['table-c'],
      ['table-a', 'table-b', 'table-c'],
      ['table-a'],
      committedRetainedUntil,
      200,
      1_000,
    )

    expect(committedResult.retainedTableIds).toEqual(['table-a'])
    expect(committedResult.retainedUntil.has('table-b')).toBe(false)
  })
})
