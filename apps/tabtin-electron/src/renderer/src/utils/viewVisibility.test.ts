import { describe, expect, it } from 'vitest'
import type { Field, ViewMeta } from '@tabtin/table-core'
import {
  buildViewColumnMetaUpdate,
  getViewFieldOrderSnapshot,
  mergeReorderedSubsetIntoFieldOrder,
} from '@tabtin/table-ui'

const buildField = (
  id: string,
  name: string,
  options: Partial<Field> = {}
): Field => ({
  id,
  table_id: 'table-1',
  name,
  field_type: 'text',
  is_primary: false,
  is_hidden: false,
  sort_order: 0,
  created_at: '2026-03-07T00:00:00Z',
  updated_at: '2026-03-07T00:00:00Z',
  ...options,
})

const buildView = (overrides: Partial<ViewMeta> = {}): ViewMeta => ({
  id: 'view-1',
  table_id: 'table-1',
  name: 'Grid',
  view_type: 'grid',
  order: 0,
  filters: [],
  sorts: [],
  groups: [],
  visible_fields: [],
  field_order: [],
  config: {},
  is_default: true,
  is_shared: false,
  is_locked: false,
  column_meta: {},
  created_at: '2026-03-07T00:00:00Z',
  updated_at: '2026-03-07T00:00:00Z',
  ...overrides,
})

describe('viewVisibility field order helpers', () => {
  const fields = [
    buildField('fld_title', 'Title', { is_primary: true }),
    buildField('fld_status', 'Status'),
    buildField('fld_owner', 'Owner'),
    buildField('fld_date', 'Due Date'),
  ]

  it('应优先按 column_meta.order 解析字段顺序，并兼容字段名 key', () => {
    const view = buildView({
      column_meta: {
        Status: { order: 0 },
        fld_owner: { order: 1 },
        fld_title: { order: 2 },
      },
    })

    const snapshot = getViewFieldOrderSnapshot(view, fields)

    expect(snapshot.orderedFieldIds).toEqual([
      'fld_status',
      'fld_owner',
      'fld_title',
      'fld_date',
    ])
  })

  it('搜索子集重排时，应仅调整命中字段的相对顺序并保留其他字段位置', () => {
    const nextOrder = mergeReorderedSubsetIntoFieldOrder(
      ['fld_title', 'fld_status', 'fld_owner', 'fld_date'],
      ['fld_owner', 'fld_title']
    )

    expect(nextOrder).toEqual([
      'fld_owner',
      'fld_status',
      'fld_title',
      'fld_date',
    ])
  })

  it('生成 column_meta 更新时，应同时保留显隐语义和新的字段顺序', () => {
    const view = buildView({
      column_meta: {
        fld_title: { order: 0, hidden: false, width: 220 },
        fld_status: { order: 1, hidden: false },
        fld_owner: { order: 2, hidden: true },
      },
    })

    const nextColumnMeta = buildViewColumnMetaUpdate(view, fields, {
      visibleFieldIds: ['fld_title', 'fld_status', 'fld_date'],
      fieldOrder: ['fld_owner', 'fld_title', 'fld_status', 'fld_date'],
    })

    expect(nextColumnMeta).toMatchObject({
      fld_owner: { order: 0, hidden: true },
      fld_title: { order: 1, hidden: false, width: 220 },
      fld_status: { order: 2, hidden: false },
      fld_date: { order: 3, hidden: false },
    })
  })
})
