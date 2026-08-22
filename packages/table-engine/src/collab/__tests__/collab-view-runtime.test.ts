import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  buildViewDraftSavePayload,
  resolveViewGroups,
  type ViewMeta,
  type ViewSort,
} from '@tabtin/table-core'
import {
  applyViewUpdatePayload,
  buildCollabViewRecords,
  mergeViewsLifecycleIntoYDoc,
  resolveCollabViewUpdateBase,
  COLLAB_PENDING_VIEW_CREATED_AT,
  COLLAB_PENDING_VIEW_TTL_MS,
} from '../collabViewRuntime'

const titleField = {
  id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  id_hex: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  name: '标题',
  field_type: 'text',
}

const statusField = {
  id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
  id_hex: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  name: '状态',
  field_type: 'select',
}

const makeRecord = (values: Record<string, unknown>) => new Map<string, unknown>(Object.entries(values))

const dateField = {
  id: 'dddddddd-dddd-dddd-dddd-dddddddddddd',
  id_hex: 'dddddddddddddddddddddddddddddddd',
  name: 'Date',
  field_type: 'date',
  config: {
    formatting: {
      date: 'YYYY/MM/DD',
      time: 'HH:mm',
      timeZone: 'Asia/Shanghai',
    },
  },
}

const baseView = {
  id: 'view-1',
  table_id: 'table-1',
  name: '默认视图',
  view_type: 'grid' as const,
  filters: [],
  sorts: [],
  groups: [],
  visible_fields: [],
  field_order: [],
  column_meta: {},
  config: {},
  is_shared: false,
  is_locked: false,
  order: 0,
  created_at: '',
}

describe('buildCollabViewRecords', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('builds records directly from Y.Doc snapshots', () => {
    const recordsSnapshot = new Map([
      ['r1', makeRecord({ [titleField.id_hex]: 'A', [statusField.id_hex]: 'open', __order: 2 })],
      ['r2', makeRecord({ [titleField.id_hex]: 'B', [statusField.id_hex]: 'done', __order: 1 })],
    ])

    const result = buildCollabViewRecords({
      tableId: 'table-1',
      recordsSnapshot,
      rowOrder: ['r2', 'r1'],
      fieldsMeta: [titleField, statusField],
      view: baseView,
    })

    expect(result.records.map(record => record.id)).toEqual(['r2', 'r1'])
    expect(result.records[0].data).toEqual({ 标题: 'B', 状态: 'done' })
    expect(result.records[0].fields?.[titleField.id]).toBe('B')
  })

  it('preserves Y.Doc rowOrder when view has no explicit sorts', () => {
    const recordsSnapshot = new Map([
      ['r1', makeRecord({ [titleField.id_hex]: 'A', __order: 1 })],
      ['r2', makeRecord({ [titleField.id_hex]: 'B', __order: 2 })],
    ])

    const result = buildCollabViewRecords({
      tableId: 'table-1',
      recordsSnapshot,
      rowOrder: ['r2', 'r1'],
      fieldsMeta: [titleField],
      view: baseView,
    })

    expect(result.records.map(record => record.id)).toEqual(['r2', 'r1'])
  })

  it('rowOrder 与 recordsSnapshot 混合时不隐藏 NULL PositionId 的记录', () => {
    const recordsSnapshot = new Map([
      ['positioned', makeRecord({ [titleField.id_hex]: 'explicit', __position_id: 'p1:a0V', __order: 1 })],
      ['legacy-null', makeRecord({ [titleField.id_hex]: null, __position_id: null, __order: 2 })],
    ])

    const result = buildCollabViewRecords({
      tableId: 'table-1',
      recordsSnapshot,
      rowOrder: ['positioned'],
      fieldsMeta: [titleField],
      view: baseView,
    })

    expect(result.records.map(record => record.id)).toEqual(['positioned', 'legacy-null'])
    expect(result.records[1].data).toEqual({ 标题: null })
  })

  it('跨端以不同 Map 插入顺序收到缺失投影记录时仍确定性追加', () => {
    const entries = [
      ['z-uncovered', makeRecord({ [titleField.id_hex]: 'Z' })],
      ['covered', makeRecord({ [titleField.id_hex]: 'Covered' })],
      ['a-uncovered', makeRecord({ [titleField.id_hex]: 'A' })],
    ] as const
    const build = (recordsSnapshot: Map<string, Map<string, unknown>>) =>
      buildCollabViewRecords({
        tableId: 'table-1',
        recordsSnapshot,
        rowOrder: ['covered'],
        fieldsMeta: [titleField],
        view: baseView,
      }).records.map(record => record.id)

    const forward = build(new Map(entries))
    const reverse = build(new Map([...entries].reverse()))

    expect(forward).toEqual(['covered', 'a-uncovered', 'z-uncovered'])
    expect(reverse).toEqual(forward)
  })

  it('忽略缺失 field_id 的脏排序规则，避免协作投影崩溃', () => {
    const recordsSnapshot = new Map([
      ['r1', makeRecord({ [titleField.id_hex]: 'B', __order: 1 })],
      ['r2', makeRecord({ [titleField.id_hex]: 'A', __order: 2 })],
    ])

    const result = buildCollabViewRecords({
      tableId: 'table-1',
      recordsSnapshot,
      rowOrder: ['r1', 'r2'],
      fieldsMeta: [titleField],
      view: {
        ...baseView,
        sorts: [
          { field_id: undefined, direction: 'asc' },
          { field_id: titleField.id, direction: 'asc' },
        ] as unknown as ViewSort[],
      },
    })

    expect(result.records.map(record => record.id)).toEqual(['r2', 'r1'])
  })

  it('忽略非数组 sorts 脏数据，避免协作投影崩溃', () => {
    const recordsSnapshot = new Map([
      ['r1', makeRecord({ [titleField.id_hex]: 'A', __order: 1 })],
      ['r2', makeRecord({ [titleField.id_hex]: 'B', __order: 2 })],
    ])

    const result = buildCollabViewRecords({
      tableId: 'table-1',
      recordsSnapshot,
      rowOrder: ['r2', 'r1'],
      fieldsMeta: [titleField],
      view: {
        ...baseView,
        sorts: { field_id: titleField.id, direction: 'asc' } as unknown as ViewSort[],
      },
    })

    expect(result.records.map(record => record.id)).toEqual(['r2', 'r1'])
  })

  it('filters records by Y.Doc view filters', () => {
    const recordsSnapshot = new Map([
      ['r1', makeRecord({ [titleField.id_hex]: 'A', [statusField.id_hex]: 'open' })],
      ['r2', makeRecord({ [titleField.id_hex]: 'B', [statusField.id_hex]: 'done' })],
    ])

    const result = buildCollabViewRecords({
      tableId: 'table-1',
      recordsSnapshot,
      rowOrder: ['r1', 'r2'],
      fieldsMeta: [titleField, statusField],
      view: {
        ...baseView,
        filters: [{ id: 'f1', field_id: statusField.id, operator: 'equals', value: 'done', enabled: true }],
      },
    })

    expect(result.records.map(record => record.id)).toEqual(['r2'])
  })

  it('filters date presets from Y.Doc view filters by timestamp range', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-15T04:00:00.000Z'))

    const recordsSnapshot = new Map([
      ['today-iso', makeRecord({ [dateField.id_hex]: '2026-08-15T07:55:19.329Z' })],
      ['today-date', makeRecord({ [dateField.id_hex]: '2026-08-15' })],
      ['week-date', makeRecord({ [dateField.id_hex]: '2026-08-10' })],
      ['month-timestamp', makeRecord({ [dateField.id_hex]: Date.parse('2026-08-28T07:55:00.000Z') })],
      ['last-month', makeRecord({ [dateField.id_hex]: '2026-07-31T15:59:59.999Z' })],
      ['next-month', makeRecord({ [dateField.id_hex]: '2026-09-01' })],
      ['empty', makeRecord({ [dateField.id_hex]: null })],
    ])

    const build = (mode: 'today' | 'thisWeek' | 'thisMonth') =>
      buildCollabViewRecords({
        tableId: 'table-1',
        recordsSnapshot,
        rowOrder: [
          'today-iso',
          'today-date',
          'week-date',
          'month-timestamp',
          'last-month',
          'next-month',
          'empty',
        ],
        fieldsMeta: [dateField],
        view: {
          ...baseView,
          filters: [{
            id: `filter-${mode}`,
            field_id: dateField.id,
            operator: 'equals',
            value: { mode, timeZone: 'Asia/Shanghai' },
            enabled: true,
          }],
        },
      }).records.map(record => record.id)

    expect(build('today')).toEqual(['today-iso', 'today-date'])
    expect(build('thisWeek')).toEqual(['today-iso', 'today-date', 'week-date'])
    expect(build('thisMonth')).toEqual(['today-iso', 'today-date', 'week-date', 'month-timestamp'])
  })

  it('rating equals matches number cell against string filter value', () => {
    const ratingField = {
      id: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
      id_hex: 'cccccccccccccccccccccccccccccccc',
      name: '评分',
      field_type: 'rating',
    }
    const recordsSnapshot = new Map([
      ['r1', makeRecord({ [ratingField.id_hex]: 3 })],
      ['r2', makeRecord({ [ratingField.id_hex]: 5 })],
      ['r3', makeRecord({ [ratingField.id_hex]: 3 })],
    ])

    const result = buildCollabViewRecords({
      tableId: 'table-1',
      recordsSnapshot,
      rowOrder: ['r1', 'r2', 'r3'],
      fieldsMeta: [ratingField],
      view: {
        ...baseView,
        filters: [{ id: 'f1', field_id: ratingField.id, operator: 'equals', value: '3', enabled: true }],
      },
    })

    expect(result.records.map(record => record.id)).toEqual(['r1', 'r3'])
  })

  it('applies search before pagination for collab hide-not-match rows', () => {
    const recordsSnapshot = new Map([
      ['r1', makeRecord({ [titleField.id_hex]: 'alpha' })],
      ['r2', makeRecord({ [titleField.id_hex]: 'target row' })],
      ['r3', makeRecord({ [titleField.id_hex]: 'another target' })],
    ])

    const result = buildCollabViewRecords({
      tableId: 'table-1',
      recordsSnapshot,
      rowOrder: ['r1', 'r2', 'r3'],
      fieldsMeta: [titleField],
      view: baseView,
      page: 1,
      pageSize: 1,
      search: {
        query: 'target',
        fieldIds: [titleField.id],
      },
    })

    expect(result.total).toBe(2)
    expect(result.matched_total).toBe(2)
    expect(result.records.map(record => record.id)).toEqual(['r2'])
  })

  it('normalizes editor filter operators used by persisted view configs', () => {
    const recordsSnapshot = new Map([
      ['r1', makeRecord({ [titleField.id_hex]: 'A', [statusField.id_hex]: 'open' })],
      ['r2', makeRecord({ [titleField.id_hex]: 'B', [statusField.id_hex]: 'done' })],
    ])

    const result = buildCollabViewRecords({
      tableId: 'table-1',
      recordsSnapshot,
      rowOrder: ['r1', 'r2'],
      fieldsMeta: [titleField, statusField],
      view: {
        ...baseView,
        filters: [{ id: 'f1', field_id: statusField.id, operator: 'is_any_of', value: ['done'], enabled: true }],
      },
    })

    expect(result.records.map(record => record.id)).toEqual(['r2'])
  })

  it('uses view config filter_logic for legacy filters', () => {
    const recordsSnapshot = new Map([
      ['r1', makeRecord({ [titleField.id_hex]: 'A', [statusField.id_hex]: 'open' })],
      ['r2', makeRecord({ [titleField.id_hex]: 'B', [statusField.id_hex]: 'done' })],
    ])

    const result = buildCollabViewRecords({
      tableId: 'table-1',
      recordsSnapshot,
      rowOrder: ['r1', 'r2'],
      fieldsMeta: [titleField, statusField],
      view: {
        ...baseView,
        filters: [
          { id: 'f1', field_id: statusField.id, operator: 'equals', value: 'done', enabled: true },
          { id: 'f2', field_id: titleField.id, operator: 'equals', value: 'A', enabled: true },
        ],
        config: { filter_logic: 'or' },
      },
    })

    expect(result.records.map(record => record.id)).toEqual(['r1', 'r2'])
  })

  it('sorts records by Y.Doc view sorts', () => {
    const recordsSnapshot = new Map([
      ['r1', makeRecord({ [titleField.id_hex]: 'B' })],
      ['r2', makeRecord({ [titleField.id_hex]: 'A' })],
    ])

    const result = buildCollabViewRecords({
      tableId: 'table-1',
      recordsSnapshot,
      rowOrder: ['r1', 'r2'],
      fieldsMeta: [titleField],
      view: {
        ...baseView,
        sorts: [{ field_id: titleField.id, direction: 'asc' }],
      },
    })

    expect(result.records.map(record => record.id)).toEqual(['r2', 'r1'])
  })

  it('文本字段 A→Z / Z→A 按 locale 顺序排序', () => {
    const recordsSnapshot = new Map([
      ['r1', makeRecord({ [titleField.id_hex]: 'banana' })],
      ['r2', makeRecord({ [titleField.id_hex]: 'Apple' })],
      ['r3', makeRecord({ [titleField.id_hex]: 'cherry' })],
    ])
    const input = {
      tableId: 'table-1',
      recordsSnapshot,
      rowOrder: ['r1', 'r2', 'r3'],
      fieldsMeta: [titleField],
    }

    const asc = buildCollabViewRecords({
      ...input,
      view: { ...baseView, sorts: [{ field_id: titleField.id, direction: 'asc' }] },
    })
    expect(asc.records.map(r => r.id)).toEqual(['r2', 'r1', 'r3'])

    const desc = buildCollabViewRecords({
      ...input,
      view: { ...baseView, sorts: [{ field_id: titleField.id, direction: 'desc' }] },
    })
    expect(desc.records.map(r => r.id)).toEqual(['r3', 'r1', 'r2'])
  })

  it('数值字段按数值大小排序（不退化为字典序）', () => {
    const numberField = {
      id: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
      id_hex: 'cccccccccccccccccccccccccccccccc',
      name: '数量',
      field_type: 'number',
    }
    const recordsSnapshot = new Map([
      ['r1', makeRecord({ [numberField.id_hex]: 2 })],
      ['r2', makeRecord({ [numberField.id_hex]: 10 })],
      ['r3', makeRecord({ [numberField.id_hex]: 1 })],
    ])

    const result = buildCollabViewRecords({
      tableId: 'table-1',
      recordsSnapshot,
      rowOrder: ['r1', 'r2', 'r3'],
      fieldsMeta: [numberField],
      view: { ...baseView, sorts: [{ field_id: numberField.id, direction: 'asc' }] },
    })

    expect(result.records.map(r => r.id)).toEqual(['r3', 'r1', 'r2'])
  })

  it('select 字段按选项定义顺序排序，而非字母序', () => {
    const selectField = {
      id: 'dddddddd-dddd-dddd-dddd-dddddddddddd',
      id_hex: 'dddddddddddddddddddddddddddddddd',
      name: '优先级',
      field_type: 'select',
      config: { choices: [{ value: 'High' }, { value: 'Medium' }, { value: 'Low' }] },
    }
    const recordsSnapshot = new Map([
      ['r1', makeRecord({ [selectField.id_hex]: 'Low' })],
      ['r2', makeRecord({ [selectField.id_hex]: 'High' })],
      ['r3', makeRecord({ [selectField.id_hex]: 'Medium' })],
    ])

    const result = buildCollabViewRecords({
      tableId: 'table-1',
      recordsSnapshot,
      rowOrder: ['r1', 'r2', 'r3'],
      fieldsMeta: [selectField],
      view: { ...baseView, sorts: [{ field_id: selectField.id, direction: 'asc' }] },
    })

    // 选项顺序 High < Medium < Low（字母序会得到 High, Low, Medium）
    expect(result.records.map(r => r.id)).toEqual(['r2', 'r3', 'r1'])
  })

  it('分组：在 metadata.groups 输出分组树，组顺序按分组字段排序', () => {
    const recordsSnapshot = new Map([
      ['r1', makeRecord({ [titleField.id_hex]: 'A', [statusField.id_hex]: 'done' })],
      ['r2', makeRecord({ [titleField.id_hex]: 'B', [statusField.id_hex]: 'open' })],
      ['r3', makeRecord({ [titleField.id_hex]: 'C', [statusField.id_hex]: 'done' })],
    ])

    const result = buildCollabViewRecords({
      tableId: 'table-1',
      recordsSnapshot,
      rowOrder: ['r1', 'r2', 'r3'],
      fieldsMeta: [titleField, statusField],
      view: {
        ...baseView,
        groups: [{ field_id: statusField.id, direction: 'asc' }],
      },
    })

    const groups = (result.metadata as any)?.groups
    expect(groups).toBeTruthy()
    // 组顺序按 status 升序：done < open
    expect(groups.nodes.map((n: any) => n.group_value)).toEqual(['done', 'open'])
    expect(groups.nodes.map((n: any) => n.count)).toEqual([2, 1])
    // 分组时返回全部记录，供 grid 按 metadata 聚合
    expect(result.records.map(r => r.id).sort()).toEqual(['r1', 'r2', 'r3'])
  })

  it('分组：无分组时 metadata.groups 不输出', () => {
    const recordsSnapshot = new Map([
      ['r1', makeRecord({ [titleField.id_hex]: 'A' })],
    ])

    const result = buildCollabViewRecords({
      tableId: 'table-1',
      recordsSnapshot,
      rowOrder: ['r1'],
      fieldsMeta: [titleField],
      view: { ...baseView },
    })

    expect((result.metadata as any)?.groups).toBeUndefined()
  })

  it('层级：在 metadata.sub_records.tree_data 输出父子关系', () => {
    const parentField = {
      id: 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee',
      id_hex: 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
      name: '父记录',
      field_type: 'link',
    }
    // r2 的父是 r1；r1 无父（根）
    const recordsSnapshot = new Map([
      ['r1', makeRecord({ [titleField.id_hex]: '父项', [parentField.id_hex]: null })],
      ['r2', makeRecord({ [titleField.id_hex]: '子项', [parentField.id_hex]: 'r1' })],
    ])

    const result = buildCollabViewRecords({
      tableId: 'table-1',
      recordsSnapshot,
      rowOrder: ['r1', 'r2'],
      fieldsMeta: [titleField, parentField],
      view: {
        ...baseView,
        config: { subRecordParentFieldId: parentField.id },
      },
    })

    const treeData = (result.metadata as any)?.sub_records?.tree_data
    expect(treeData).toBeTruthy()
    expect(treeData.r1).toEqual({ depth: 0, has_children: true, parent_id: null })
    expect(treeData.r2).toEqual({ depth: 1, has_children: false, parent_id: 'r1' })
    // 层级时返回 DFS 树序记录（父在前、子紧随）
    expect(result.records.map(r => r.id)).toEqual(['r1', 'r2'])
  })

  it('层级：集合外的父 id 视作根节点', () => {
    const parentField = {
      id: 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee',
      id_hex: 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
      name: '父记录',
      field_type: 'link',
    }
    const recordsSnapshot = new Map([
      ['r1', makeRecord({ [titleField.id_hex]: 'A', [parentField.id_hex]: 'missing-parent' })],
    ])

    const result = buildCollabViewRecords({
      tableId: 'table-1',
      recordsSnapshot,
      rowOrder: ['r1'],
      fieldsMeta: [titleField, parentField],
      view: { ...baseView, config: { subRecordParentFieldId: parentField.id } },
    })

    const treeData = (result.metadata as any)?.sub_records?.tree_data
    expect(treeData.r1).toEqual({ depth: 0, has_children: false, parent_id: null })
  })

  it('层级：筛选只命中子记录时补回祖先，保持树完整（对齐后端 filter_with_ancestors）', () => {
    const parentField = {
      id: 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee',
      id_hex: 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
      name: '父记录',
      field_type: 'link',
    }
    // r1 为父（status=open，会被筛掉）；r2 为 r1 的子（status=done，命中筛选）
    const recordsSnapshot = new Map([
      ['r1', makeRecord({ [titleField.id_hex]: '父', [statusField.id_hex]: 'open', [parentField.id_hex]: null })],
      ['r2', makeRecord({ [titleField.id_hex]: '子', [statusField.id_hex]: 'done', [parentField.id_hex]: 'r1' })],
    ])

    const result = buildCollabViewRecords({
      tableId: 'table-1',
      recordsSnapshot,
      rowOrder: ['r1', 'r2'],
      fieldsMeta: [titleField, statusField, parentField],
      view: {
        ...baseView,
        filters: [{ id: 'f1', field_id: statusField.id, operator: 'equals', value: 'done', enabled: true }],
        config: { subRecordParentFieldId: parentField.id },
      },
    })

    // 祖先 r1 被补回，DFS 序 父在前
    expect(result.records.map(r => r.id)).toEqual(['r1', 'r2'])
    const treeData = (result.metadata as any)?.sub_records?.tree_data
    expect(treeData.r1).toEqual({ depth: 0, has_children: true, parent_id: null })
    expect(treeData.r2).toEqual({ depth: 1, has_children: false, parent_id: 'r1' })
  })

  it('空值视作最大值：升序排末尾、降序排开头（对齐后端 NULLS 语义）', () => {
    const recordsSnapshot = new Map([
      ['r1', makeRecord({ [titleField.id_hex]: 'B' })],
      ['r2', makeRecord({ [titleField.id_hex]: '' })],
      ['r3', makeRecord({ [titleField.id_hex]: 'A' })],
    ])
    const input = {
      tableId: 'table-1',
      recordsSnapshot,
      rowOrder: ['r1', 'r2', 'r3'],
      fieldsMeta: [titleField],
    }

    const asc = buildCollabViewRecords({
      ...input,
      view: { ...baseView, sorts: [{ field_id: titleField.id, direction: 'asc' }] },
    })
    expect(asc.records.map(r => r.id)).toEqual(['r3', 'r1', 'r2'])

    const desc = buildCollabViewRecords({
      ...input,
      view: { ...baseView, sorts: [{ field_id: titleField.id, direction: 'desc' }] },
    })
    expect(desc.records.map(r => r.id)).toEqual(['r2', 'r1', 'r3'])
  })

  it('uses cumulative displayLimit for flat grid infinite scroll', () => {
    const recordsSnapshot = new Map(
      Array.from({ length: 5 }, (_, index) => {
        const id = `r${index + 1}`
        return [id, makeRecord({ [titleField.id_hex]: id, __order: index + 1 })] as const
      }),
    )

    const firstWindow = buildCollabViewRecords({
      tableId: 'table-1',
      recordsSnapshot,
      rowOrder: ['r1', 'r2', 'r3', 'r4', 'r5'],
      fieldsMeta: [titleField],
      view: baseView,
      pageSize: 2,
      displayLimit: 2,
    })
    expect(firstWindow.records.map(record => record.id)).toEqual(['r1', 'r2'])
    expect(firstWindow.total).toBe(5)

    const expandedWindow = buildCollabViewRecords({
      tableId: 'table-1',
      recordsSnapshot,
      rowOrder: ['r1', 'r2', 'r3', 'r4', 'r5'],
      fieldsMeta: [titleField],
      view: baseView,
      pageSize: 2,
      displayLimit: 4,
    })
    expect(expandedWindow.records.map(record => record.id)).toEqual(['r1', 'r2', 'r3', 'r4'])
    expect(expandedWindow.total).toBe(5)
  })
})

describe('canonical collaboration group ordering', () => {
  const ownerField = {
    id: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
    id_hex: 'cccccccccccccccccccccccccccccccc',
    name: 'Owner',
    field_type: 'user',
  }

  it('keeps distinct structured member values in distinct buckets and orders them by display name', () => {
    const alice = [{ id: '00000000-0000-4000-8000-000000000002', name: 'Alice' }]
    const bob = [{ id: '00000000-0000-4000-8000-000000000001', name: 'Bob' }]
    const recordsSnapshot = new Map([
      ['record-bob', makeRecord({ [ownerField.id_hex]: bob })],
      ['record-alice', makeRecord({ [ownerField.id_hex]: alice })],
    ])

    const result = buildCollabViewRecords({
      tableId: 'table-1',
      recordsSnapshot,
      rowOrder: ['record-bob', 'record-alice'],
      fieldsMeta: [ownerField],
      view: {
        ...baseView,
        groups: [{ field_id: ownerField.id, direction: 'asc' }],
      },
    })

    const nodes = (result.metadata as any).groups.nodes
    expect(nodes).toHaveLength(2)
    expect(nodes.map((node: any) => node.group_value[0].name)).toEqual(['Alice', 'Bob'])
    expect(nodes.map((node: any) => node.count)).toEqual([1, 1])
  })

  it('keeps the empty group last in descending order', () => {
    const recordsSnapshot = new Map([
      ['record-empty', makeRecord({ [titleField.id_hex]: null })],
      ['record-a', makeRecord({ [titleField.id_hex]: 'A' })],
      ['record-b', makeRecord({ [titleField.id_hex]: 'B' })],
    ])

    const result = buildCollabViewRecords({
      tableId: 'table-1',
      recordsSnapshot,
      rowOrder: ['record-empty', 'record-a', 'record-b'],
      fieldsMeta: [titleField],
      view: {
        ...baseView,
        groups: [{ field_id: titleField.id, direction: 'desc' }],
      },
    })

    expect((result.metadata as any).groups.nodes.map((node: any) => node.group_value)).toEqual([
      'B',
      'A',
      null,
    ])
  })
})

describe('mergeViewsLifecycleIntoYDoc', () => {
  const ydocView = (overrides: Record<string, unknown>) => ({
    id: 'v1',
    name: '视图一',
    view_type: 'grid',
    is_default: true,
    is_locked: false,
    order: 0,
    // 配置维度（以 Y.Doc 为权威）
    filters: [{ id: 'f1', field_id: 'x', operator: 'equals', value: '1', enabled: true }],
    sorts: [],
    config: { filter_logic: 'and' },
    ...overrides,
  })

  it('保留 Y.Doc 配置维度，仅同步元信息（改名）', () => {
    const ydoc = [ydocView({})]
    const rest = [{ ...ydocView({}), name: '改后的名字', filters: [] }]

    const { next, changed } = mergeViewsLifecycleIntoYDoc(rest, ydoc)

    expect(changed).toBe(true)
    expect(next[0].name).toBe('改后的名字')
    // 配置维度仍来自 Y.Doc，不被 REST 的空 filters 覆盖
    expect(next[0].filters).toEqual(ydoc[0].filters)
  })

  it('同步锁定状态到 Y.Doc', () => {
    const ydoc = [ydocView({ is_locked: false })]
    const rest = [{ ...ydocView({}), is_locked: true }]

    const { next, changed } = mergeViewsLifecycleIntoYDoc(rest, ydoc)

    expect(changed).toBe(true)
    expect(next[0].is_locked).toBe(true)
    expect(next[0].filters).toEqual(ydoc[0].filters)
  })

  it('新建视图整体写入（含初始配置）', () => {
    const ydoc = [ydocView({})]
    const created = {
      id: 'v2',
      name: '新视图',
      view_type: 'grid',
      is_default: false,
      is_locked: false,
      order: 1,
      filters: [],
      config: {},
    }
    const rest = [ydocView({}), created]

    const { next, changed } = mergeViewsLifecycleIntoYDoc(rest, ydoc)

    expect(changed).toBe(true)
    expect(next).toHaveLength(2)
    expect(next[1]).toEqual(created)
  })

  it('保留 Y.Doc 已有视图的 config_rev（回退防护版本号不被 REST 旧值覆盖）', () => {
    // Y.Doc 视图 config_rev=7（客户端刚写入），REST 列表仍是 config_rev=3 的旧值。
    const ydoc = [ydocView({ config_rev: 7 })]
    const rest = [{ ...ydocView({}), name: '改名', config_rev: 3, filters: [] }]

    const { next } = mergeViewsLifecycleIntoYDoc(rest, ydoc)

    // 生命周期维度（name）跟随 REST，但 config_rev 与配置维度保留 Y.Doc 更新值
    expect(next[0].name).toBe('改名')
    expect(next[0].config_rev).toBe(7)
    expect(next[0].filters).toEqual(ydoc[0].filters)
  })

  it('REST config_rev 更新时用权威配置修复旧 Y.Doc 分组', () => {
    const ydoc = [ydocView({
      view_type: 'kanban',
      config_rev: 3,
      config: {},
      groups: [],
    })]
    const rest = [{
      ...ydocView({}),
      view_type: 'kanban',
      config_rev: 4,
      config: { group_by_field: 'status' },
      groups: [{ field_id: 'status', direction: 'asc' }],
    }]

    const { next, changed } = mergeViewsLifecycleIntoYDoc(rest, ydoc)

    expect(changed).toBe(true)
    expect(next[0].config_rev).toBe(4)
    expect(next[0].config).toEqual({ group_by_field: 'status' })
    expect(next[0].groups).toEqual([{ field_id: 'status', direction: 'asc' }])
  })

  it('删除视图从结果中移除', () => {
    const ydoc = [ydocView({}), ydocView({ id: 'v2', name: '视图二', is_default: false, order: 1 })]
    const rest = [ydocView({})]

    const { next, changed } = mergeViewsLifecycleIntoYDoc(rest, ydoc)

    expect(changed).toBe(true)
    expect(next.map(v => v.id)).toEqual(['v1'])
  })

  it('REST 尚未确认时保留待持久化的新视图', () => {
    const pending = ydocView({ id: 'v-pending', name: '新视图', is_default: false, order: 1 })

    const { next, changed } = mergeViewsLifecycleIntoYDoc(
      [ydocView({})],
      [ydocView({}), pending],
      ['v-pending'],
    )

    expect(changed).toBe(false)
    expect(next.map(view => view.id)).toEqual(['v1', 'v-pending'])
  })

  it('所有协作者通过 Y.Doc 共享 pending 标记保留新视图', () => {
    const now = 1_000_000
    const pending = ydocView({
      id: 'v-pending',
      name: '新视图',
      is_default: false,
      order: 1,
      [COLLAB_PENDING_VIEW_CREATED_AT]: now - 10,
    })

    const { next } = mergeViewsLifecycleIntoYDoc(
      [ydocView({})],
      [ydocView({}), pending],
      [],
      now,
    )

    expect(next.map(view => view.id)).toEqual(['v1', 'v-pending'])
  })

  it('过期的 pending 标记交还 REST 作为删除权威', () => {
    const now = 1_000_000
    const expired = ydocView({
      id: 'v-pending',
      name: '新视图',
      is_default: false,
      order: 1,
      [COLLAB_PENDING_VIEW_CREATED_AT]: now - COLLAB_PENDING_VIEW_TTL_MS - 1,
    })

    const { next } = mergeViewsLifecycleIntoYDoc(
      [ydocView({})],
      [ydocView({}), expired],
      [],
      now,
    )

    expect(next.map(view => view.id)).toEqual(['v1'])
  })

  it('REST 确认后移除协作 pending 标记', () => {
    const pending = ydocView({ [COLLAB_PENDING_VIEW_CREATED_AT]: 1_000 })
    const { next } = mergeViewsLifecycleIntoYDoc([ydocView({})], [pending], [], 1_010)

    expect(next[0]).not.toHaveProperty(COLLAB_PENDING_VIEW_CREATED_AT)
  })

  it('Y.Doc 已删除的待确认视图不会被本地 pending 注册表复活', () => {
    const { next } = mergeViewsLifecycleIntoYDoc(
      [ydocView({})],
      [ydocView({})],
      ['v-pending'],
    )

    expect(next.map(view => view.id)).toEqual(['v1'])
  })

  it('重排视图顺序', () => {
    const a = ydocView({})
    const b = ydocView({ id: 'v2', name: '视图二', is_default: false, order: 1 })
    const ydoc = [a, b]
    const rest = [
      { ...b, order: 0 },
      { ...a, order: 1 },
    ]

    const { next, changed } = mergeViewsLifecycleIntoYDoc(rest, ydoc)

    expect(changed).toBe(true)
    expect(next.map(v => v.id)).toEqual(['v2', 'v1'])
  })

  it('无生命周期变化时 changed=false（防止与配置写入相互触发循环）', () => {
    const ydoc = [ydocView({})]
    // REST 配置维度陈旧（filters 为空）但元信息一致 → 不应触发写入
    const rest = [{ ...ydocView({}), filters: [], sorts: [{ field_id: 'y', direction: 'asc' }] }]

    const { changed } = mergeViewsLifecycleIntoYDoc(rest, ydoc)

    expect(changed).toBe(false)
  })
})

describe('resolveCollabViewUpdateBase', () => {
  it('Y.Doc 瞬时缺少新视图时仍能从本地乐观视图保存配置', () => {
    const optimisticView = {
      id: 'view-pending',
      view_type: 'kanban',
      config: {},
      [COLLAB_PENDING_VIEW_CREATED_AT]: 1_000,
    }

    expect(resolveCollabViewUpdateBase(
      'view-pending',
      undefined,
      [],
      [optimisticView],
    )).toBe(optimisticView)
  })
})

describe('applyViewUpdatePayload', () => {
  it('清空看板分组时删除协作基线里的 group_by_field，避免重载后恢复分组', () => {
    const base = {
      id: 'v1',
      view_type: 'kanban',
      filters: [],
      sorts: [],
      groups: [{ field_id: 'status', direction: 'asc' }],
      config: {
        group_by_field: 'status',
        freeze_columns: 1,
      },
    } as unknown as ViewMeta
    const payload = buildViewDraftSavePayload(base, {
      filters: [],
      sorts: [],
      groups: [],
      filter_logic: 'and',
      isDirty: true,
    })

    expect(payload.groups).toEqual([])
    expect(payload.config).not.toHaveProperty('group_by_field')

    const persisted = applyViewUpdatePayload(
      base as unknown as Record<string, unknown>,
      payload as unknown as Record<string, unknown>,
    ) as unknown as ViewMeta

    expect(persisted.groups).toEqual([])
    expect(persisted.config).not.toHaveProperty('group_by_field')
    expect(persisted.config).toMatchObject({ freeze_columns: 1, filter_logic: 'and' })
    expect(resolveViewGroups(persisted)).toEqual([])
  })

  it('仅在显式更新看板 groups 时同步 group_by_field', () => {
    const base = {
      id: 'v1',
      view_type: 'kanban',
      groups: [{ field_id: 'status', direction: 'asc' }],
      config: {
        group_by_field: 'status',
        freeze_columns: 1,
      },
    }

    const regrouped = applyViewUpdatePayload(base, {
      groups: [{ field_id: 'assignee', direction: 'asc' }],
      config: { card_title_field: 'title' },
    })
    expect(regrouped.config).toEqual({
      group_by_field: 'assignee',
      freeze_columns: 1,
      card_title_field: 'title',
    })

    const configOnly = applyViewUpdatePayload(base, {
      config: { card_title_field: 'title' },
    })
    expect(configOnly.config).toMatchObject({
      group_by_field: 'status',
      freeze_columns: 1,
      card_title_field: 'title',
    })
  })

  it('深合并 config，保留未触及的视图配置键（ 汇总行）', () => {
    const base = {
      id: 'v1',
      name: '表格视图',
      config: {
        filter_logic: 'and',
        freeze_columns: 1,
        column_widths: { f1: 120 },
      },
      column_meta: {
        f1: { width: 120 },
      },
    }

    const next = applyViewUpdatePayload(
      base,
      {
        config: {
          column_statistic_funcs: { f1: 'sum' },
        },
      },
      { viewId: 'v1', updatedAt: '2026-07-22T00:00:00.000Z' },
    )

    expect(next.config).toEqual({
      filter_logic: 'and',
      freeze_columns: 1,
      column_widths: { f1: 120 },
      column_statistic_funcs: { f1: 'sum' },
    })
    expect(next.column_meta).toEqual({ f1: { width: 120 } })
    expect(next.id).toBe('v1')
    expect(next.updated_at).toBe('2026-07-22T00:00:00.000Z')
  })

  it('深合并 column_meta，不整段替换', () => {
    const base = {
      id: 'v1',
      column_meta: {
        f1: { width: 120, hidden: false },
        f2: { width: 80 },
      },
    }

    const next = applyViewUpdatePayload(base, {
      column_meta: {
        f1: { width: 160 },
      },
    })

    expect(next.column_meta).toEqual({
      f1: { width: 160, hidden: false },
      f2: { width: 80 },
    })
  })
})
