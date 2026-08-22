import { describe, expect, it } from 'vitest'
import {
  LINK_PICKER_MIN_WIDTH_PX,
  LINK_PICKER_OVERLAY_PASS_THROUGH_CLASS,
  LINK_PICKER_SIDE_GUTTER_PX,
  resolveLinkPickerDialogSizeClass,
  sliceDisplayColumns,
  type LinkPickerField,
} from './LinkRecordPicker'

const fields: LinkPickerField[] = [
  { id: 'a', name: '主键', field_type: 'text', is_primary: true },
  { id: 'b', name: '数量', field_type: 'number', is_primary: false },
  { id: 'c', name: '备注', field_type: 'long_text', is_primary: false },
  { id: 'd', name: '日期', field_type: 'date', is_primary: false },
]

describe('sliceDisplayColumns', () => {
  it('primary first when no visibleFieldIds', () => {
    expect(sliceDisplayColumns(fields).map((f) => f.id)).toEqual(['a', 'b', 'c', 'd'])
  })

  it('respects visibleFieldIds order', () => {
    expect(sliceDisplayColumns(fields, ['c', 'a']).map((f) => f.id)).toEqual(['c', 'a'])
  })

  it('does not cap explicitly selected visibleFieldIds', () => {
    const many = [
      ...fields,
      { id: 'e', name: '模块', field_type: 'text', is_primary: false },
      { id: 'f', name: '优先级', field_type: 'text', is_primary: false },
      { id: 'g', name: '前置条件', field_type: 'text', is_primary: false },
    ]
    expect(
      sliceDisplayColumns(many, ['a', 'b', 'c', 'd', 'e', 'f', 'g']).map((f) => f.id),
    ).toEqual(['a', 'b', 'c', 'd', 'e', 'f', 'g'])
  })

  it('caps default column count when visibleFieldIds omitted', () => {
    expect(sliceDisplayColumns(fields, undefined, 2)).toHaveLength(2)
  })

  it('falls back to primary-first when visibleFieldIds miss all ids', () => {
    expect(sliceDisplayColumns(fields, ['missing']).map((f) => f.id)).toEqual([
      'a',
      'b',
      'c',
      'd',
    ])
  })
})

describe('link picker list-mode semantics (contract)', () => {
  /**
   * 宿主契约：全部模式不得传 selected_record_ids（否则后端 exclude 已选）；
   * 已选择模式必须 only_selected + selected_record_ids。
   * 此处用纯函数固化请求参数拼装规则，避免回归。
   */
  function buildLinkableQuery(args: {
    listMode: 'all' | 'selected'
    selectedIds: string[]
    search?: string
    searchFieldId?: string
    /** 表头可见列；全局搜索时传给后端限定范围 */
    searchScopeFieldIds?: string[]
    recordId: string
  }) {
    const selected_record_ids =
      args.listMode === 'selected' && args.selectedIds.length > 0
        ? args.selectedIds
        : undefined
    return {
      search: args.search || undefined,
      search_field_id: args.searchFieldId || undefined,
      search_field_ids:
        !args.searchFieldId && args.searchScopeFieldIds && args.searchScopeFieldIds.length > 0
          ? args.searchScopeFieldIds
          : undefined,
      exclude_record_id: args.listMode === 'all' ? args.recordId : undefined,
      selected_record_ids,
      only_selected: args.listMode === 'selected',
    }
  }

  it('all mode includes selected rows (no exclude-by-selected)', () => {
    const q = buildLinkableQuery({
      listMode: 'all',
      selectedIds: ['r1', 'r2'],
      recordId: 'self',
    })
    expect(q.selected_record_ids).toBeUndefined()
    expect(q.only_selected).toBe(false)
    expect(q.exclude_record_id).toBe('self')
  })

  it('selected mode uses only_selected with ordered ids', () => {
    const q = buildLinkableQuery({
      listMode: 'selected',
      selectedIds: ['r2', 'r1'],
      recordId: 'self',
      search: 'foo',
      searchFieldId: 'a',
    })
    expect(q.only_selected).toBe(true)
    expect(q.selected_record_ids).toEqual(['r2', 'r1'])
    expect(q.exclude_record_id).toBeUndefined()
    expect(q.search).toBe('foo')
    expect(q.search_field_id).toBe('a')
  })

  it('selected mode with empty selection asks for empty selected set', () => {
    const q = buildLinkableQuery({
      listMode: 'selected',
      selectedIds: [],
      recordId: 'self',
    })
    expect(q.only_selected).toBe(true)
    expect(q.selected_record_ids).toBeUndefined()
  })

  it('global search scopes to header columns via search_field_ids', () => {
    const q = buildLinkableQuery({
      listMode: 'all',
      selectedIds: [],
      recordId: 'self',
      search: '01',
      searchScopeFieldIds: ['col-a', 'col-b'],
    })
    expect(q.search_field_id).toBeUndefined()
    expect(q.search_field_ids).toEqual(['col-a', 'col-b'])
  })

  it('field-scoped search does not send search_field_ids', () => {
    const q = buildLinkableQuery({
      listMode: 'all',
      selectedIds: [],
      recordId: 'self',
      search: '01',
      searchFieldId: 'col-a',
      searchScopeFieldIds: ['col-a', 'col-b'],
    })
    expect(q.search_field_id).toBe('col-a')
    expect(q.search_field_ids).toBeUndefined()
  })
})

describe('resolveLinkPickerDialogSizeClass ', () => {
  it('scopes width to TabData panel minus 200px side gutters, with 500px floor', () => {
    const gutterTotal = LINK_PICKER_SIDE_GUTTER_PX * 2
    const cls = resolveLinkPickerDialogSizeClass(true)
    expect(cls).toContain(`w-[calc(100%-${gutterTotal}px)]`)
    expect(cls).toContain(`max-w-[calc(100%-${gutterTotal}px)]`)
    expect(cls).toContain(`min-w-[${LINK_PICKER_MIN_WIDTH_PX}px]`)
    expect(cls).not.toContain('w-full')
    expect(cls).not.toContain('92vw')
    expect(cls).not.toContain('max-w-4xl')
  })

  it('falls back to viewport-bounded width when unscoped', () => {
    const cls = resolveLinkPickerDialogSizeClass(false)
    expect(cls).toContain('min-w-[500px]')
    expect(cls).toContain('92vw')
    expect(cls).toContain('max-w-4xl')
  })


  it('overlay passes pointer events so shell resize handle stays draggable', () => {
    //  后 ShellColResizeHandle = z-sticky；遮罩若接事件会盖住跨列命中区。
    // Radix Overlay 内联 pointer-events:auto，必须 !important 才能穿透。
    expect(LINK_PICKER_OVERLAY_PASS_THROUGH_CLASS).toBe('!pointer-events-none')
  })

  it('uses non-modal Dialog so shell chrome stays interactive ', async () => {
    const fs = await import('node:fs')
    const path = await import('node:path')
    const src = fs.readFileSync(path.join(__dirname, 'LinkRecordPicker.tsx'), 'utf8')
    expect(src).toMatch(/modal=\{false\}/)
    expect(src).toMatch(/overlayClassName=\{LINK_PICKER_OVERLAY_PASS_THROUGH_CLASS\}/)
    expect(src).toMatch(/data-shell-overlay-allows-resize/)
  })

})
