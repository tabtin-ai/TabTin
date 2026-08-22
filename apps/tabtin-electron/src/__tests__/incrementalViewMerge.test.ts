import { describe, expect, it } from 'vitest'
import type { TableRecord, ViewRecordsResponse } from '@tabtin/table-core'
import {
  isPartialViewSnapshot,
  mergeCurrentViewRecords,
  removeCurrentViewRecords,
} from '../../../../packages/table-engine/src/sync/useIncrementalViewMerge'

const makeRecord = (id: string, fields: Record<string, unknown> = {}): TableRecord => ({
  id,
  table_id: 'table-1',
  created_by_id: 'user-1',
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
  data: fields,
  order: 1,
  version: 1,
})

const makeViewRecords = (overrides: Partial<ViewRecordsResponse> = {}): ViewRecordsResponse => ({
  view: {
    id: 'view-1',
    name: 'Grid',
    view_type: 'grid',
    config: {},
  },
  records: [makeRecord('r1', { title: 'A' }), makeRecord('r2', { title: 'B' })],
  total: 2,
  page: 1,
  page_size: 50,
  metadata: {},
  ...overrides,
})

describe('incremental view merge helpers', () => {
  it('分页快照不应把页外增量记录 append 到当前页，并应采用服务端 total', () => {
    const currentViewRecords = makeViewRecords({
      total: 10,
      page: 1,
      page_size: 2,
    })

    expect(isPartialViewSnapshot(currentViewRecords)).toBe(true)

    const next = mergeCurrentViewRecords(
      currentViewRecords,
      [makeRecord('r9', { title: 'off-page' })],
      { total: 11 },
    )

    expect(next.records).toHaveLength(2)
    expect(next.records.some(record => record.id === 'r9')).toBe(false)
    expect(next.total).toBe(11)
  })

  it('全量快照应追加新记录并回填 total', () => {
    const currentViewRecords = makeViewRecords()

    const next = mergeCurrentViewRecords(
      currentViewRecords,
      [makeRecord('r3', { title: 'C' })],
      { total: 3 },
    )

    expect(next.records).toHaveLength(3)
    expect(next.records.at(-1)?.id).toBe('r3')
    expect(next.total).toBe(3)
  })

  it('删除页外记录时应采用服务端 total，而不是按当前页移除数推断', () => {
    const currentViewRecords = makeViewRecords({
      total: 10,
      page: 2,
      page_size: 2,
    })

    const next = removeCurrentViewRecords(
      currentViewRecords,
      ['r9'],
      { total: 9 },
    )

    expect(next.records).toHaveLength(2)
    expect(next.total).toBe(9)
  })
})
