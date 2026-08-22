import { describe, expect, it } from 'vitest'
import type { TableRecord, ViewMeta, ViewRecordsResponse } from '@tabtin/table-core'
import {
  buildLocalCreateOverlayScopeKey,
  buildLocalCreateOverlayEntries,
  canApplyLocalCreateOverlay,
  canDisplayLocalCreateOverlayScope,
  isCollabOptimisticCreateRecord,
  mergeViewRecordsWithLocalCreateOverlays,
  patchLocalCreateOverlayEntryRecord,
  reconcileLocalCreateOverlayEntries,
  upsertLocalCreateOverlayEntries,
} from './viewLocalCreateOverlay'

const makeRecord = (id: string): TableRecord =>
  ({
    id,
    data: { Name: id },
    fields: { Name: id },
  }) as unknown as TableRecord

const viewMeta: ViewMeta = {
  id: 'view-1',
  table_id: 'table-1',
  name: 'Grid',
  view_type: 'grid',
  is_default: true,
  is_shared: false,
  is_locked: false,
  order: 0,
  config: {},
  filters: [],
  sorts: [],
  groups: [],
  visible_fields: ['Name'],
  field_order: ['Name'],
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
}

const viewRecords = (overrides?: Partial<ViewRecordsResponse>): ViewRecordsResponse => ({
  view: { id: 'view-1', name: 'Grid', view_type: 'grid', config: {} },
  records: [makeRecord('rec-1')],
  total: 1,
  page: 1,
  page_size: 100,
  metadata: {},
  ...overrides,
})

type TestSubRecordMetadata = {
  sub_records: {
    tree_data: Record<string, {
      depth?: number
      has_children?: boolean
      parent_id?: string | null
    }>
  }
}

describe('viewLocalCreateOverlay', () => {
  it('仅基础作用域安全时允许显示 local overlay', () => {
    expect(
      canDisplayLocalCreateOverlayScope({
        useViewData: true,
        currentViewId: 'view-1',
        currentView: viewMeta,
        currentViewRecords: viewRecords(),
        searchQuery: '',
        searchHideNotMatchRows: false,
        useServerSearch: false,
      })
    ).toBe(true)

    expect(
      canDisplayLocalCreateOverlayScope({
        useViewData: true,
        currentViewId: 'view-1',
        currentView: {
          ...viewMeta,
          filters: [
            {
              id: 'flt-1',
              field_id: 'Name',
              operator: 'contains',
              value: 'Alice',
              enabled: true,
            },
          ],
        },
        currentViewRecords: viewRecords(),
        searchQuery: '',
        searchHideNotMatchRows: false,
        useServerSearch: false,
      })
    ).toBe(false)

    expect(
      canDisplayLocalCreateOverlayScope({
        useViewData: true,
        currentViewId: 'view-1',
        currentView: viewMeta,
        currentViewRecords: viewRecords(),
        searchQuery: 'Alice',
        searchHideNotMatchRows: false,
        useServerSearch: false,
      })
    ).toBe(true)
  })

  it('应仅在末页追加或当前页锚点可见时允许应用 overlay', () => {
    expect(
      canApplyLocalCreateOverlay(
        {
          useViewData: true,
          currentViewId: 'view-1',
          currentView: viewMeta,
          currentViewRecords: viewRecords({ total: 150, page: 1, page_size: 100 }),
          searchQuery: '',
          searchHideNotMatchRows: false,
          useServerSearch: false,
        },
        {
          anchor_record_id: 'rec-1',
          position: 'before',
        }
      )
    ).toBe(true)

    expect(
      canApplyLocalCreateOverlay(
        {
          useViewData: true,
          currentViewId: 'view-1',
          currentView: viewMeta,
          currentViewRecords: viewRecords({ total: 150, page: 1, page_size: 100 }),
          searchQuery: '',
          searchHideNotMatchRows: false,
          useServerSearch: false,
        },
        {
          position: 'end',
        }
      )
    ).toBe(false)

    expect(
      canApplyLocalCreateOverlay(
        {
          useViewData: true,
          currentViewId: 'view-1',
          currentView: viewMeta,
          currentViewRecords: viewRecords({ total: 150, page: 1, page_size: 100 }),
          searchQuery: '',
          searchHideNotMatchRows: false,
          useServerSearch: false,
          overlayEntries: [
            {
              record: makeRecord('rec-overlay'),
              anchorRecordId: 'rec-1',
              position: 'after',
            },
          ],
        },
        {
          anchor_record_id: 'rec-overlay',
          position: 'after',
        }
      )
    ).toBe(true)

    expect(
      canApplyLocalCreateOverlay(
        {
          useViewData: true,
          currentViewId: 'view-1',
          currentView: viewMeta,
          currentViewRecords: viewRecords(),
          searchQuery: 'Alice',
          searchHideNotMatchRows: true,
          useServerSearch: false,
        },
        {
          position: 'end',
        }
      )
    ).toBe(false)
  })

  it('分组视图有明确分组上下文时允许本地 overlay', () => {
    const groupedView = {
      ...viewMeta,
      groups: [{ field_id: 'Status', direction: 'asc' as const }],
    }
    const scope = {
      useViewData: true,
      currentViewId: 'view-1',
      currentView: groupedView,
      currentViewRecords: viewRecords({
        records: [
          {
            ...makeRecord('rec-1'),
            data: { Name: 'rec-1', Status: 'Done' },
            fields: { Name: 'rec-1', Status: 'Done' },
          } as TableRecord,
        ],
        metadata: {
          groups: {
            fields: [{ field: 'Status', field_id: 'Status' }],
            nodes: [{ group_value: 'Done', group_label: 'Done', count: 1 }],
          },
        },
      }),
      searchQuery: '',
      searchHideNotMatchRows: false,
      useServerSearch: false,
    }

    expect(canDisplayLocalCreateOverlayScope(scope)).toBe(true)
    expect(
      canApplyLocalCreateOverlay(scope, {
        anchor_record_id: 'rec-1',
        position: 'after',
      })
    ).toBe(false)
    expect(
      canApplyLocalCreateOverlay(scope, {
        anchor_record_id: 'rec-1',
        position: 'after',
        group_values: { Status: 'Done' },
      })
    ).toBe(true)
    expect(
      canApplyLocalCreateOverlay(scope, {
        position: 'end',
        group_values: { Status: 'Done' },
      })
    ).toBe(false)

    const [entry] = buildLocalCreateOverlayEntries(
      [
        {
          ...makeRecord('rec-2'),
          data: { Name: 'rec-2', Status: 'Done' },
          fields: { Name: 'rec-2', Status: 'Done' },
        } as TableRecord,
      ],
      {
        anchor_record_id: 'rec-1',
        position: 'after',
        group_values: { Status: 'Done' },
      }
    )

    const merged = mergeViewRecordsWithLocalCreateOverlays(
      scope.currentViewRecords,
      [entry]
    )
    expect(merged?.records.map(record => record.id)).toEqual(['rec-1', 'rec-2'])
  })

  it('scope key 应包含 view 与分页信息', () => {
    expect(
      buildLocalCreateOverlayScopeKey({
        currentViewId: 'view-1',
        currentViewRecords: viewRecords({ page: 2, page_size: 50 }),
      })
    ).toBe('view-1:2:50')

    expect(
      buildLocalCreateOverlayScopeKey({
        currentViewId: null,
        currentViewRecords: viewRecords(),
      })
    ).toBeNull()
  })

  it('合成显示记录时应按锚点插入 overlay 并去重', () => {
    const merged = mergeViewRecordsWithLocalCreateOverlays(
      viewRecords({
        records: [makeRecord('rec-1'), makeRecord('rec-2')],
        total: 2,
      }),
      [
        {
          record: makeRecord('rec-1'),
          position: 'end',
        },
        {
          record: makeRecord('rec-3'),
          anchorRecordId: 'rec-1',
          position: 'after',
        },
        {
          record: makeRecord('rec-4'),
          anchorRecordId: 'rec-3',
          position: 'after',
        },
      ]
    )

    expect(merged?.records.map(record => record.id)).toEqual([
      'rec-1',
      'rec-3',
      'rec-4',
      'rec-2',
    ])
    expect(merged?.total).toBe(2)
  })

  it('子记录 overlay 应同步合并 tree metadata，避免 optimistic 帧跳成根节点', () => {
    const merged = mergeViewRecordsWithLocalCreateOverlays(
      viewRecords({
        records: [makeRecord('parent-1')],
        metadata: {
          sub_records: {
            parent_field_id: 'parent-field',
            tree_data: {
              'parent-1': { depth: 0, has_children: false, parent_id: null },
            },
          },
        },
      }),
      [
        {
          record: makeRecord('temp-child'),
          anchorRecordId: 'parent-1',
          position: 'after',
          subRecordTreePatch: {
            'parent-1': { depth: 0, has_children: true, parent_id: null },
            'temp-child': { depth: 1, has_children: false, parent_id: 'parent-1' },
          },
        },
      ]
    )

    expect(merged?.records.map(record => record.id)).toEqual(['parent-1', 'temp-child'])
    const treeData = (merged?.metadata as TestSubRecordMetadata | undefined)?.sub_records.tree_data
    expect(treeData?.['parent-1']).toEqual({
      depth: 0,
      has_children: true,
      parent_id: null,
    })
    expect(treeData?.['temp-child']).toEqual({
      depth: 1,
      has_children: false,
      parent_id: 'parent-1',
    })
  })

  it('patch overlay record 时应同步迁移子记录 tree metadata key', () => {
    const patched = patchLocalCreateOverlayEntryRecord(
      {
        record: makeRecord('temp-child'),
        anchorRecordId: 'parent-1',
        position: 'after',
        subRecordTreePatch: {
          'parent-1': { depth: 0, has_children: true, parent_id: null },
          'temp-child': { depth: 1, has_children: false, parent_id: 'parent-1' },
        },
      },
      'temp-child',
      makeRecord('real-child')
    )

    expect(patched.record.id).toBe('real-child')
    expect(patched.subRecordTreePatch?.['temp-child']).toBeUndefined()
    expect(patched.subRecordTreePatch?.['real-child']).toEqual({
      depth: 1,
      has_children: false,
      parent_id: 'parent-1',
    })
  })

  it('旧末页不再是末页后不应继续显示 end overlay（无 retention 标记）', () => {
    const merged = mergeViewRecordsWithLocalCreateOverlays(
      viewRecords({
        records: [makeRecord('rec-1')],
        total: 101,
        page: 1,
        page_size: 100,
      }),
      [
        {
          record: makeRecord('rec-end'),
          position: 'end',
        },
      ]
    )

    expect(merged?.records.map(record => record.id)).toEqual(['rec-1'])
  })

  it('带 retention: until_reconciled 的 end overlay 在整页刚好写满后仍应保留显示', () => {
    // 复现  Bug 2：records.length === total === page_size === 1000 时创建新记录，
    // 服务端已落库但刷新后 total 变为 1001，当前页不再是末页，若直接丢弃 overlay 记录会消失。
    const fullPageRecords = Array.from({ length: 1000 }, (_, index) =>
      makeRecord(`rec-${index + 1}`)
    )

    const merged = mergeViewRecordsWithLocalCreateOverlays(
      viewRecords({
        records: fullPageRecords,
        total: 1001,
        page: 1,
        page_size: 1000,
      }),
      [
        {
          record: makeRecord('rec-new'),
          position: 'end',
          retention: 'until_reconciled',
        },
      ]
    )

    expect(merged?.records.map(record => record.id)).toEqual([
      ...fullPageRecords.map(record => record.id),
      'rec-new',
    ])
  })

  it('buildLocalCreateOverlayEntries 生成的 entry 应带 retention: until_reconciled', () => {
    const entries = buildLocalCreateOverlayEntries([makeRecord('rec-new')], {
      position: 'end',
    })

    expect(entries).toHaveLength(1)
    expect(entries[0].retention).toBe('until_reconciled')
  })

  it('server view 追上后应回收 overlay', () => {
    expect(
      reconcileLocalCreateOverlayEntries(
        [
          { record: makeRecord('rec-1'), position: 'end' },
          { record: makeRecord('rec-2'), position: 'end' },
        ],
        [makeRecord('rec-2'), makeRecord('rec-3')]
      ).map(entry => entry.record.id)
    ).toEqual(['rec-1'])
  })

  it('upsert 应覆盖同 id 的 overlay entry', () => {
    const next = upsertLocalCreateOverlayEntries(
      [{ record: makeRecord('rec-1'), position: 'end' }],
      {
        record: {
          ...makeRecord('rec-1'),
          data: { Name: 'updated' },
        } as unknown as TableRecord,
        anchorRecordId: 'anchor-1',
        position: 'after',
      }
    )

    expect(next).toHaveLength(1)
    expect(next[0].record.data).toEqual({ Name: 'updated' })
    expect(next[0].anchorRecordId).toBe('anchor-1')
  })

  it('批量创建应生成可保持顺序的 overlay entries', () => {
    const entries = buildLocalCreateOverlayEntries(
      [makeRecord('rec-2'), makeRecord('rec-3')],
      {
        anchor_record_id: 'rec-1',
        position: 'before',
      }
    )

    expect(entries).toEqual([
      {
        record: makeRecord('rec-2'),
        anchorRecordId: 'rec-1',
        position: 'before',
        retention: 'until_reconciled',
      },
      {
        record: makeRecord('rec-3'),
        anchorRecordId: 'rec-2',
        position: 'after',
        retention: 'until_reconciled',
      },
    ])
  })

  it('应识别 collab optimistic create record', () => {
    expect(
      isCollabOptimisticCreateRecord({
        ...makeRecord('rec-collab'),
        __optimistic: true,
        __optimisticSource: 'collab',
      } as unknown as TableRecord)
    ).toBe(true)

    expect(isCollabOptimisticCreateRecord(makeRecord('rec-normal'))).toBe(false)
  })
})
