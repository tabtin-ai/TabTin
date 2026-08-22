import { describe, expect, it } from 'vitest'
import type { TableRecord } from '@tabtin/table-core'
import { mergeCurrentViewRecords } from './useIncrementalViewMerge'

const makeRecord = (id: string, fields: Record<string, unknown> = {}): TableRecord =>
  ({
    id,
    table_id: 'table-1',
    data: fields,
    fields,
  }) as unknown as TableRecord

const makeOrderedRecord = (
  id: string,
  order: number,
  fields: Record<string, unknown> = {},
): TableRecord =>
  ({
    id,
    table_id: 'table-1',
    data: fields,
    fields,
    order,
    created_at: '2026-06-16T00:00:00.000Z',
  }) as unknown as TableRecord

describe('mergeCurrentViewRecords', () => {
  it('keeps existing field values when merging partial record patches', () => {
    const current = {
      records: [
        makeRecord('parent-1', {
          title: 'Parent',
          status: 'Open',
          owner: 'Alice',
        }),
      ],
      total: 1,
      page: 1,
      page_size: 100,
    }

    const merged = mergeCurrentViewRecords(
      current,
      [
        makeRecord('parent-1', {
          status: 'Done',
        }),
      ],
      { total: 1 },
    )

    expect(merged.records[0].fields).toEqual({
      title: 'Parent',
      status: 'Done',
      owner: 'Alice',
    })
    expect(merged.records[0].data).toEqual({
      title: 'Parent',
      status: 'Done',
      owner: 'Alice',
    })
  })

  it('merges sub-record tree metadata from view delta snapshots', () => {
    const current = {
      records: [makeRecord('parent-1'), makeRecord('child-1')],
      total: 2,
      page: 1,
      page_size: 100,
      metadata: {
        sub_records: {
          parent_field_id: 'parent-field',
          tree_data: {
            'parent-1': { depth: 0, has_children: false, parent_id: null },
            'child-1': { depth: 1, has_children: false, parent_id: 'parent-1' },
          },
        },
      },
    }

    const merged = mergeCurrentViewRecords(
      current,
      [makeRecord('grandchild-1', { Name: 'grandchild' })],
      {
        total: 3,
        metadata: {
          sub_records: {
            parent_field_id: 'parent-field',
            tree_data: {
              'parent-1': { depth: 0, has_children: true, parent_id: null },
              'child-1': { depth: 1, has_children: true, parent_id: 'parent-1' },
              'grandchild-1': { depth: 2, has_children: false, parent_id: 'child-1' },
            },
          },
        },
      },
    )

    expect(merged.records.map((record) => record.id)).toEqual([
      'parent-1',
      'child-1',
      'grandchild-1',
    ])
    expect((merged.metadata as any).sub_records.tree_data).toEqual({
      'parent-1': { depth: 0, has_children: true, parent_id: null },
      'child-1': { depth: 1, has_children: true, parent_id: 'parent-1' },
      'grandchild-1': { depth: 2, has_children: false, parent_id: 'child-1' },
    })
  })

  it('preserves unrelated metadata while merging sub-record tree deltas', () => {
    const current = {
      records: [makeRecord('parent-1')],
      total: 1,
      page: 1,
      page_size: 100,
      metadata: {
        view_type: 'grid',
        delta: false,
        search: { query: 'foo' },
        groups: { fields: ['status'] },
        sub_records: {
          parent_field_id: 'parent-field',
          context_ancestor_ids: ['ancestor-1'],
          tree_data: {
            'parent-1': { depth: 0, has_children: false, parent_id: null },
          },
        },
      },
    }

    const merged = mergeCurrentViewRecords(
      current,
      [makeRecord('child-1')],
      {
        total: 2,
        metadata: {
          delta: true,
          sub_records: {
            parent_field_id: 'parent-field',
            tree_data: {
              'parent-1': { depth: 0, has_children: true, parent_id: null },
              'child-1': { depth: 1, has_children: false, parent_id: 'parent-1' },
            },
          },
        },
      },
    )

    expect(merged.metadata).toMatchObject({
      view_type: 'grid',
      delta: true,
      search: { query: 'foo' },
      groups: { fields: ['status'] },
      sub_records: {
        parent_field_id: 'parent-field',
        context_ancestor_ids: ['ancestor-1'],
        tree_data: {
          'parent-1': { depth: 0, has_children: true, parent_id: null },
          'child-1': { depth: 1, has_children: false, parent_id: 'parent-1' },
        },
      },
    })
  })

  it('inserts a new record by order instead of appending to the tail ', () => {
    // 父=0、子1=2048、下一顶层=4096；新增子记录 order=1024 应落在父正下方，
    // 而不是被 append 到末尾（修复「新建子层级跳到底部」）。
    const current = {
      records: [
        makeOrderedRecord('parent-1', 0),
        makeOrderedRecord('child-1', 2048),
        makeOrderedRecord('top-2', 4096),
      ],
      total: 3,
      page: 1,
      page_size: 100,
    }

    const merged = mergeCurrentViewRecords(
      current,
      [makeOrderedRecord('new-child', 1024)],
      { total: 4 },
    )

    expect(merged.records.map((record) => record.id)).toEqual([
      'parent-1',
      'new-child',
      'child-1',
      'top-2',
    ])
  })

  it('breaks ties with created_at then id when orders are equal', () => {
    const current = {
      records: [
        makeOrderedRecord('a', 0),
        makeOrderedRecord('c', 100),
      ],
      total: 2,
      page: 1,
      page_size: 100,
    }

    const merged = mergeCurrentViewRecords(
      current,
      [makeOrderedRecord('b', 100)],
      { total: 3 },
    )

    // a(0) < c(100) 已存在；b(100) 与 c(100) 同 order，按 id 'b' < 'c' 排在 c 前。
    expect(merged.records.map((record) => record.id)).toEqual(['a', 'b', 'c'])
  })

  it('keeps append behavior for custom-sorted views (records not order-monotonic)', () => {
    // 现有数组按某列降序（order 非单调）→ 视为自定义排序视图，新增记录维持 append，
    // 不能按 order 重排打乱用户排序。
    const current = {
      records: [
        makeOrderedRecord('a', 4096),
        makeOrderedRecord('b', 1024),
      ],
      total: 2,
      page: 1,
      page_size: 100,
    }

    const merged = mergeCurrentViewRecords(
      current,
      [makeOrderedRecord('c', 2048)],
      { total: 3 },
    )

    expect(merged.records.map((record) => record.id)).toEqual(['a', 'b', 'c'])
  })

  it('keeps append behavior when records have no order (backward compatible)', () => {
    const current = {
      records: [makeRecord('a'), makeRecord('b')],
      total: 2,
      page: 1,
      page_size: 100,
    }

    const merged = mergeCurrentViewRecords(
      current,
      [makeRecord('c')],
      { total: 3 },
    )

    expect(merged.records.map((record) => record.id)).toEqual(['a', 'b', 'c'])
  })
})
