import assert from 'node:assert/strict'
import test from 'node:test'
import type { ViewMeta, ViewRecordsQuery } from '@tabtin/table-core'
import { buildWebCollabViewRecords } from './webCollabViewProjection.ts'

const fieldsMeta = [
  {
    id: 'fld-status',
    id_hex: 'fldstatus',
    name: '状态',
    field_type: 'single_select',
    config: { choices: ['待处理', '已完成'] },
  },
  {
    id: 'fld-date',
    id_hex: 'flddate',
    name: '日期',
    field_type: 'date',
  },
]

const recordsSnapshot = new Map([
  ['rec-1', new Map<string, unknown>([
    ['fldstatus', '待处理'],
    ['flddate', '2026-08-12'],
  ])],
])

const createView = (viewType: ViewMeta['view_type'], config: Record<string, unknown>): ViewMeta => ({
  id: `view-${viewType}`,
  table_id: 'tbl-1',
  name: viewType,
  view_type: viewType,
  filters: [],
  sorts: [],
  groups: [],
  visible_fields: [],
  field_order: [],
  config,
  is_shared: true,
  is_locked: false,
  order: 0,
  created_at: '',
})

const project = (view: ViewMeta, query: ViewRecordsQuery = {}) =>
  buildWebCollabViewRecords({
    tableId: 'tbl-1',
    recordsSnapshot,
    rowOrder: ['rec-1'],
    fieldsMeta,
    view,
    query,
  })

test('普通视图保持平铺记录契约', () => {
  const response = project(createView('grid', {}))

  assert.deepEqual(response.records.map(record => record.id), ['rec-1'])
  assert.equal(response.metadata?.view_type, undefined)
})

test('看板视图按有效视图配置生成分组元数据', () => {
  const response = project(
    createView('kanban', { group_by_field: 'fld-status' }),
    { per_group_limit: 20, group_offsets: { 待处理: 0 } },
  )

  assert.equal(response.records.length, 0)
  assert.equal(response.metadata?.view_type, 'kanban')
  assert.deepEqual(
    (response.metadata?.groups as Array<{ group_label: string; count: number }>).map(group => [
      group.group_label,
      group.count,
    ]),
    [['待处理', 1], ['已完成', 0]],
  )
})

test('日历视图把协作记录投影为 occurrence wrapper', () => {
  const response = project(
    createView('calendar', { date_field: 'fld-date' }),
    { date_range: '2026-08-01,2026-08-31' },
  )

  assert.equal(response.metadata?.view_type, 'calendar')
  assert.equal(response.metadata?.occurrence_count, 1)
  const occurrence = response.records[0] as unknown as {
    date: string
    record: { id: string; fields?: Record<string, unknown> }
    is_start: boolean
    is_end: boolean
    span_total_days: number
    occurrence_index: number
    dirty: boolean
    truncated: boolean
  }
  assert.deepEqual({
    date: occurrence.date,
    recordId: occurrence.record.id,
    dateValue: occurrence.record.fields?.['fld-date'],
    isStart: occurrence.is_start,
    isEnd: occurrence.is_end,
    spanTotalDays: occurrence.span_total_days,
    occurrenceIndex: occurrence.occurrence_index,
    dirty: occurrence.dirty,
    truncated: occurrence.truncated,
  }, {
    date: '2026-08-12',
    recordId: 'rec-1',
    dateValue: '2026-08-12',
    isStart: true,
    isEnd: true,
    spanTotalDays: 1,
    occurrenceIndex: 0,
    dirty: false,
    truncated: false,
  })
})
