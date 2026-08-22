import assert from 'node:assert/strict'
import test from 'node:test'
import type { Field, TableRecord, ViewMeta } from '@tabtin/table-core'
import {
  readGridEmbedFieldValue,
  resolveGridEmbedVisibleFields,
} from './webGridEmbedProjection.ts'

const fields: Field[] = [
  {
    id: 'fld-title',
    table_id: 'tbl-1',
    name: '标题',
    field_type: 'text',
    is_primary: true,
    is_hidden: false,
    sort_order: 0,
    created_at: '',
    updated_at: '',
  },
  {
    id: 'fld-status',
    table_id: 'tbl-1',
    name: '状态',
    field_type: 'text',
    is_primary: false,
    is_hidden: false,
    sort_order: 1,
    created_at: '',
    updated_at: '',
  },
  {
    id: 'fld-hidden',
    table_id: 'tbl-1',
    name: '全局隐藏',
    field_type: 'text',
    is_primary: false,
    is_hidden: true,
    sort_order: 2,
    created_at: '',
    updated_at: '',
  },
]

const view = {
  id: 'view-1',
  table_id: 'tbl-1',
  name: '表格视图',
  view_type: 'grid',
  filters: [],
  sorts: [],
  groups: [],
  visible_fields: ['fld-status'],
  field_order: ['fld-status', 'fld-title'],
  config: {},
  is_shared: true,
  is_locked: false,
  order: 0,
  created_at: '',
} satisfies ViewMeta

test('内嵌表格只投影当前视图可见字段', () => {
  assert.deepEqual(
    resolveGridEmbedVisibleFields(view, fields).map((field) => field.id),
    ['fld-status'],
  )
})

test('内嵌表格不展示全局隐藏字段', () => {
  assert.deepEqual(
    resolveGridEmbedVisibleFields({ ...view, visible_fields: [] }, fields).map(
      (field) => field.id,
    ),
    ['fld-title', 'fld-status'],
  )
})

test('内嵌表格兼容 field id 与字段名两种记录键', () => {
  const record = {
    id: 'rec-1',
    table_id: 'tbl-1',
    data: { 标题: '按字段名读取', 'fld-status': '进行中' },
    fields: {},
    created_by_id: 'user-1',
    created_at: '',
    updated_at: '',
  } satisfies TableRecord

  assert.equal(readGridEmbedFieldValue(record, fields[0]), '按字段名读取')
  assert.equal(readGridEmbedFieldValue(record, fields[1]), '进行中')
})

test('内嵌表格保留高优先级记录键的显式空值', () => {
  const record = {
    id: 'rec-2',
    table_id: 'tbl-1',
    data: { 'fld-title': '旧值', 标题: '更旧的值' },
    fields: { 'fld-title': null },
    created_by_id: 'user-1',
    created_at: '',
    updated_at: '',
  } satisfies TableRecord

  assert.equal(readGridEmbedFieldValue(record, fields[0]), null)
})
