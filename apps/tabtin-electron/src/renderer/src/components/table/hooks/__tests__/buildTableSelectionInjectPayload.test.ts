import { describe, expect, it } from 'vitest'
import { buildTableSelectionInjectPayload } from '../buildTableSelectionInjectPayload'

describe('buildTableSelectionInjectPayload ', () => {
  const resolveRowLabel = (row: Record<string, unknown>) =>
    String(row.Title ?? row.id ?? '')

  it('builds a cell index with table + record_ids + field_ids', () => {
    const payload = buildTableSelectionInjectPayload({
      tableId: 'tbl-1',
      tableName: '客户表',
      spaceId: 'space-1',
      recordIds: ['rec-1'],
      selectedFields: [{ id: 'fld-name', name: 'Title' }],
      primaryRow: { id: 'rec-1', Title: 'Acme' },
      resolveRowLabel,
      selectedRecordCountLabel: '1 条记录',
    })

    expect(payload).toEqual({
      type: 'table_selection',
      resourceId: 'tbl-1',
      label: '客户表 · Title · Acme',
      spaceId: 'space-1',
      preview: 'Acme',
      meta: {
        record_ids: ['rec-1'],
        field_ids: ['fld-name'],
      },
    })
  })

  it('omits field_ids for whole-row send so undo/restore keeps record-level index', () => {
    const payload = buildTableSelectionInjectPayload({
      tableId: 'tbl-1',
      tableName: '客户表',
      recordIds: ['rec-1'],
      selectedFields: [],
      primaryRow: { id: 'rec-1', Title: 'Acme' },
      resolveRowLabel,
      selectedRecordCountLabel: '1 条记录',
    })

    expect(payload?.meta).toEqual({
      record_ids: ['rec-1'],
    })
    expect(payload?.label).toBe('客户表 · Acme')
  })

  it('supports multi-record selection labels', () => {
    const payload = buildTableSelectionInjectPayload({
      tableId: 'tbl-1',
      tableName: '客户表',
      recordIds: ['rec-1', 'rec-2'],
      selectedFields: [{ id: 'fld-name', name: 'Title' }],
      primaryRow: { id: 'rec-1', Title: 'Acme' },
      resolveRowLabel,
      selectedRecordCountLabel: '2 条记录',
    })

    expect(payload).toMatchObject({
      label: '客户表 · 2 条记录',
      preview: 'Acme (+1)',
      meta: {
        record_ids: ['rec-1', 'rec-2'],
        field_ids: ['fld-name'],
      },
    })
  })

  it('returns null when record ids are empty', () => {
    expect(
      buildTableSelectionInjectPayload({
        tableId: 'tbl-1',
        recordIds: [],
        selectedFields: [],
        primaryRow: {},
        resolveRowLabel,
        selectedRecordCountLabel: '0 条记录',
      }),
    ).toBeNull()
  })
})
