import { describe, expect, it } from 'vitest'
import type { Field, ViewMeta } from '../../types'
import {
  buildColumnMetaVisibilityUpdate,
  getViewVisibilitySnapshot,
} from '../viewVisibility'

const buildField = (id: string, name: string, overrides: Partial<Field> = {}): Field => ({
  id,
  table_id: 'table-1',
  name,
  field_type: 'text' as any,
  is_primary: false,
  is_hidden: false,
  sort_order: 0,
  ...overrides,
})

const buildView = (overrides: Partial<ViewMeta> = {}): ViewMeta => ({
  id: 'view-1',
  table_id: 'table-1',
  name: 'Grid View',
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
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
  ...overrides,
})

const fields = [
  buildField('fld_a', 'Title', { is_primary: true }),
  buildField('fld_b', 'Status'),
  buildField('fld_c', 'Owner'),
  buildField('fld_d', 'Due Date'),
]

describe('buildColumnMetaVisibilityUpdate', () => {
  describe('Grid 视图（hidden 语义）', () => {
    it('全部可见时，所有字段 hidden=false', () => {
      const view = buildView({ view_type: 'grid' })
      const result = buildColumnMetaVisibilityUpdate(view, fields, ['fld_a', 'fld_b', 'fld_c', 'fld_d'])

      expect(result.fld_a).toMatchObject({ hidden: false })
      expect(result.fld_b).toMatchObject({ hidden: false })
      expect(result.fld_c).toMatchObject({ hidden: false })
      expect(result.fld_d).toMatchObject({ hidden: false })
      expect(result.fld_a).not.toHaveProperty('visible')
    })

    it('隐藏部分字段时，被隐藏字段 hidden=true', () => {
      const view = buildView({ view_type: 'grid' })
      const result = buildColumnMetaVisibilityUpdate(view, fields, ['fld_a', 'fld_c'])

      expect(result.fld_a.hidden).toBe(false)
      expect(result.fld_b.hidden).toBe(true)
      expect(result.fld_c.hidden).toBe(false)
      expect(result.fld_d.hidden).toBe(true)
    })

    it('保留已有的 width 和 order', () => {
      const view = buildView({
        view_type: 'grid',
        column_meta: {
          fld_a: { order: 10, hidden: false, width: 220 },
          fld_b: { order: 20, hidden: false },
        },
      })
      const result = buildColumnMetaVisibilityUpdate(view, fields, ['fld_a', 'fld_b'])

      expect(result.fld_a.order).toBe(10)
      expect((result.fld_a as any).width).toBe(220)
      expect(result.fld_b.order).toBe(20)
    })
  })

  describe('Kanban 视图（visible 语义）', () => {
    it('可见字段 visible=true，隐藏字段 visible=false', () => {
      const view = buildView({ view_type: 'kanban' })
      const result = buildColumnMetaVisibilityUpdate(view, fields, ['fld_a', 'fld_d'])

      expect(result.fld_a).toMatchObject({ visible: true })
      expect(result.fld_b).toMatchObject({ visible: false })
      expect(result.fld_c).toMatchObject({ visible: false })
      expect(result.fld_d).toMatchObject({ visible: true })
      expect(result.fld_a).not.toHaveProperty('hidden')
    })
  })

  describe('空 column_meta', () => {
    it('无已有 meta 时，按字段默认顺序分配 order', () => {
      const view = buildView({ view_type: 'grid', column_meta: {} })
      const result = buildColumnMetaVisibilityUpdate(view, fields, ['fld_a', 'fld_b', 'fld_c', 'fld_d'])

      expect(result.fld_a.order).toBe(0)
      expect(result.fld_b.order).toBe(1)
      expect(result.fld_c.order).toBe(2)
      expect(result.fld_d.order).toBe(3)
    })

    it('column_meta 为 null 时也能正常工作', () => {
      const view = buildView({ view_type: 'grid', column_meta: null as any })
      const result = buildColumnMetaVisibilityUpdate(view, fields, ['fld_a'])

      expect(Object.keys(result)).toHaveLength(4)
      expect(result.fld_a.hidden).toBe(false)
      expect(result.fld_b.hidden).toBe(true)
    })
  })

  describe('column_meta 键为字段名而非 ID', () => {
    it('通过字段名正确匹配并归一化', () => {
      const view = buildView({
        view_type: 'grid',
        column_meta: {
          Title: { order: 5, width: 300 },
          Status: { order: 10 },
        },
      })
      const result = buildColumnMetaVisibilityUpdate(view, fields, ['fld_a', 'fld_b'])

      expect(result.fld_a.order).toBe(5)
      expect((result.fld_a as any).width).toBe(300)
      expect(result.fld_b.order).toBe(10)
    })
  })

  describe('nextVisibleFieldIds 包含无效 ID', () => {
    it('忽略不存在的字段 ID', () => {
      const view = buildView({ view_type: 'grid' })
      const result = buildColumnMetaVisibilityUpdate(view, fields, ['fld_a', 'fld_nonexistent'])

      expect(Object.keys(result)).toHaveLength(4)
      expect(result.fld_a.hidden).toBe(false)
      expect(result.fld_b.hidden).toBe(true)
      expect(result).not.toHaveProperty('fld_nonexistent')
    })
  })
})

describe('getViewVisibilitySnapshot', () => {
  it('column_meta 优先于 visible_fields', () => {
    const view = buildView({
      visible_fields: ['fld_a'],
      column_meta: {
        fld_a: { order: 0, hidden: false },
        fld_b: { order: 1, hidden: false },
        fld_c: { order: 2, hidden: true },
        fld_d: { order: 3, hidden: false },
      },
    })

    const { visibleFieldIds } = getViewVisibilitySnapshot(view, fields)
    expect(visibleFieldIds).toEqual(['fld_a', 'fld_b', 'fld_d'])
  })

  it('无 column_meta 时回退到 visible_fields', () => {
    const view = buildView({
      visible_fields: ['fld_a', 'fld_c'],
      column_meta: {},
    })

    const { visibleFieldIds } = getViewVisibilitySnapshot(view, fields)
    expect(visibleFieldIds).toEqual(['fld_a', 'fld_c'])
  })

  it('都没有时默认所有字段可见', () => {
    const view = buildView({
      visible_fields: [],
      column_meta: {},
    })

    const { visibleFieldIds } = getViewVisibilitySnapshot(view, fields)
    expect(visibleFieldIds).toEqual(['fld_a', 'fld_b', 'fld_c', 'fld_d'])
  })

  it('#8151：visible_fields=[] 且 column_meta 含 hidden:false 时仍可见（非「空表」）', () => {
    const view = buildView({
      visible_fields: [],
      column_meta: {
        fld_a: { order: 0, hidden: false },
        fld_b: { order: 1, hidden: false },
        fld_c: { order: 2, hidden: false },
      },
    })

    const { visibleFieldIds } = getViewVisibilitySnapshot(view, fields)
    expect(visibleFieldIds).toEqual(['fld_a', 'fld_b', 'fld_c', 'fld_d'])
  })

  it('#8151: empty visible_fields with column_meta hidden:false still shows columns', () => {
    const view = buildView({
      visible_fields: [],
      column_meta: {
        fld_a: { order: 0, hidden: false },
        fld_b: { order: 1, hidden: false },
        fld_c: { order: 2, hidden: false },
      },
    })

    const { visibleFieldIds } = getViewVisibilitySnapshot(view, fields)
    expect(visibleFieldIds).toEqual(['fld_a', 'fld_b', 'fld_c', 'fld_d'])
  })

  it('view 为 null 时返回所有字段', () => {
    const { visibleFieldIds } = getViewVisibilitySnapshot(null, fields)
    expect(visibleFieldIds).toEqual(['fld_a', 'fld_b', 'fld_c', 'fld_d'])
  })

  it('Kanban 视图使用 visible 语义', () => {
    const view = buildView({
      view_type: 'kanban',
      column_meta: {
        fld_a: { order: 0, visible: true },
        fld_b: { order: 1, visible: false },
        fld_c: { order: 2, visible: true },
      },
    })

    const { visibleFieldIds } = getViewVisibilitySnapshot(view, fields)
    expect(visibleFieldIds).toEqual(['fld_a', 'fld_c', 'fld_d'])
  })

  it('新增字段不在 column_meta 中默认可见', () => {
    const view = buildView({
      column_meta: {
        fld_a: { order: 0, hidden: false },
        fld_b: { order: 1, hidden: true },
      },
    })
    const fieldsWithNew = [
      ...fields,
      buildField('fld_new', 'New Field'),
    ]

    const { visibleFieldIds } = getViewVisibilitySnapshot(view, fieldsWithNew)
    expect(visibleFieldIds).toContain('fld_new')
    expect(visibleFieldIds).not.toContain('fld_b')
  })
})
