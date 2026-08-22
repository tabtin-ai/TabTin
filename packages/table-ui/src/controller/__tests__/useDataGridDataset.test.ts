import { renderHook } from '@testing-library/react'
import { useDataGridDataset } from '../useDataGridDataset'
import type { Field, TableRecord, ViewMeta, ViewRecordsResponse } from '../../types'

const createField = (id: string, name: string): Field => ({
  id,
  table_id: 'table-1',
  name,
  field_type: 'text',
  is_primary: false,
  is_hidden: false,
  sort_order: 0,
  created_at: '',
  updated_at: '',
})

describe('canonical REST to collaboration group handoff', () => {
  it('keeps member group order stable when collaboration metadata arrives in record order', () => {
    const fields: Field[] = [
      createField('f_title', 'Title'),
      { ...createField('f_owner', 'Owner'), field_type: 'user' },
    ]
    const alice = [{ id: 'member-alice', name: 'Stale Alice' }]
    const bob = [{ id: 'member-bob', name: 'Stale Bob' }]
    const records = [
      createRecord('r-bob', { Title: 'B', Owner: bob }),
      createRecord('r-alice', { Title: 'A', Owner: alice }),
    ]
    const currentView: ViewMeta = {
      ...createView(),
      groups: [{ field_id: 'f_owner', direction: 'asc' }],
      visible_fields: ['f_title', 'f_owner'],
      field_order: ['f_title', 'f_owner'],
    }
    const restRecords: ViewRecordsResponse = {
      view: { id: currentView.id, name: 'Grid', view_type: 'grid', config: {} },
      records,
      total: 2,
      page: 1,
      page_size: 50,
      metadata: {
        groups: {
          fields: [{ field_id: 'f_owner', direction: 'asc' }],
          nodes: [
            { group_value: alice, count: 1 },
            { group_value: bob, count: 1 },
          ],
        },
      },
    }
    const collaborationRecords: ViewRecordsResponse = {
      ...restRecords,
      metadata: {
        groups: {
          fields: restRecords.metadata!.groups!.fields,
          nodes: [
            { group_value: bob, count: 1 },
            { group_value: alice, count: 1 },
          ],
        },
      },
    }
    const common = {
      fields,
      currentView,
      records,
      userDisplayNameById: new Map([
        ['member-alice', 'Alice'],
        ['member-bob', 'Bob'],
      ]),
      useViewData: true,
      collapsedGroupIds: [],
      isRecordsLoading: false,
      isRecordLoading: false,
      recordsQueryPage: 1,
      recordsQueryPageSize: 50,
      page: 1,
      pageSize: 50,
      total: 2,
      t: (key: string) => key,
      locale: 'zh-CN',
    }
    const { result, rerender } = renderHook(
      ({ currentViewRecords }: { currentViewRecords: ViewRecordsResponse }) =>
        useDataGridDataset({ ...common, currentViewRecords }),
      { initialProps: { currentViewRecords: restRecords } },
    )
    const headers = () => result.current.groupedRows
      .filter(row => row.__rowType === 'group_header')
      .map(row => row.__groupLabel)

    expect(headers()).toEqual(['Alice', 'Bob'])
    rerender({ currentViewRecords: collaborationRecords })
    expect(headers()).toEqual(['Alice', 'Bob'])
  })
})

const createRecord = (id: string, data: Record<string, unknown>): TableRecord => ({
  id,
  table_id: 'table-1',
  created_by_id: 'u1',
  created_at: '',
  updated_at: '',
  data,
})

const createView = (): ViewMeta => ({
  id: 'view-1',
  table_id: 'table-1',
  name: 'Grid',
  view_type: 'grid',
  filters: [],
  sorts: [],
  groups: [{ field_id: 'f_status', direction: 'asc' }],
  visible_fields: ['f_title', 'f_status'],
  field_order: ['f_title', 'f_status'],
  config: {},
  is_shared: false,
  is_locked: false,
  order: 0,
  created_at: '',
})

const createViewRecords = (records: TableRecord[]): ViewRecordsResponse => ({
  view: {
    id: 'view-1',
    name: 'Grid',
    view_type: 'grid',
    config: {},
  },
  records,
  total: records.length,
  page: 1,
  page_size: 50,
  metadata: {
    groups: {
      fields: [{ field_id: 'f_status', direction: 'asc' }],
      nodes: [
        { group_value: 'Todo', group_label: 'Todo', count: 1 },
        { group_value: 'Done', group_label: 'Done', count: 1 },
      ],
    },
  },
})

describe('useDataGridDataset', () => {
  it('visible_fields 包含但 field_order 缺失时，应补齐显示字段', () => {
    const fields = [
      createField('f_title', 'Title'),
      createField('f_status', 'Status'),
      createField('f_owner', 'Owner'),
    ]
    const records = [createRecord('r1', { Title: 'Task 1', Status: 'Todo', Owner: 'Alice' })]

    const currentView = {
      ...createView(),
      visible_fields: ['f_title', 'f_status', 'f_owner'],
      field_order: ['f_title', 'f_status'],
      groups: [],
    }

    const { result } = renderHook(() =>
      useDataGridDataset({
        fields,
        currentView,
        currentViewRecords: null,
        records,
        useViewData: false,
        collapsedGroupIds: [],
        isRecordsLoading: false,
        isRecordLoading: false,
        recordsQueryPage: 1,
        recordsQueryPageSize: 50,
        page: 1,
        pageSize: 50,
        total: 1,
        t: (key: string) => key,
        locale: 'zh-CN',
      })
    )

    expect(result.current.orderedFields.map(field => field.id)).toEqual([
      'f_title',
      'f_status',
      'f_owner',
    ])
    expect(result.current.requestedFieldNames).toEqual(['Title', 'Status', 'Owner'])
    expect(result.current.requestedFieldIds).toEqual(['f_title', 'f_status', 'f_owner'])
  })

  it('无分组场景应在末尾包含 add 行', () => {
    const fields = [createField('f_title', 'Title')]
    const records = [createRecord('r1', { Title: 'Task 1' })]

    const { result } = renderHook(() =>
      useDataGridDataset({
        fields,
        currentView: null,
        currentViewRecords: null,
        records,
        useViewData: false,
        collapsedGroupIds: [],
        isRecordsLoading: false,
        isRecordLoading: false,
        recordsQueryPage: 1,
        recordsQueryPageSize: 50,
        page: 1,
        pageSize: 50,
        total: 1,
        t: (key: string) => key,
        locale: 'zh-CN',
      })
    )

    expect(result.current.groupedRows).toHaveLength(2)
    expect(result.current.groupedRows[0].id).toBe('r1')
    expect(result.current.groupedRows[1].__rowType).toBe('add')
  })

  it('无分组空表也应包含 add 行', () => {
    const fields = [createField('f_title', 'Title')]

    const { result } = renderHook(() =>
      useDataGridDataset({
        fields,
        currentView: null,
        currentViewRecords: null,
        records: [],
        useViewData: false,
        collapsedGroupIds: [],
        isRecordsLoading: false,
        isRecordLoading: false,
        recordsQueryPage: 1,
        recordsQueryPageSize: 50,
        page: 1,
        pageSize: 50,
        total: 0,
        t: (key: string) => key,
        locale: 'zh-CN',
      })
    )

    expect(result.current.rowsData).toHaveLength(0)
    expect(result.current.groupedRows).toEqual([
      {
        id: '__add_row__',
        row_id: '__add_row__',
        __rowType: 'add',
      },
    ])
  })

  it('视图记录为空时也应包含 add 行', () => {
    const fields = [createField('f_title', 'Title')]
    const currentView: ViewMeta = {
      ...createView(),
      groups: [],
    }
    const currentViewRecords: ViewRecordsResponse = {
      view: {
        id: 'view-1',
        name: 'Grid',
        view_type: 'grid',
        config: {},
      },
      records: [],
      total: 0,
      page: 1,
      page_size: 50,
    }

    const { result } = renderHook(() =>
      useDataGridDataset({
        fields,
        currentView,
        currentViewRecords,
        records: [],
        useViewData: true,
        collapsedGroupIds: [],
        isRecordsLoading: false,
        isRecordLoading: false,
        recordsQueryPage: 1,
        recordsQueryPageSize: 50,
        page: 1,
        pageSize: 50,
        total: 0,
        t: (key: string) => key,
        locale: 'zh-CN',
      })
    )

    expect(result.current.rowsData).toHaveLength(0)
    expect(result.current.groupedRows).toHaveLength(1)
    expect(result.current.groupedRows[0].__rowType).toBe('add')
  })

  it('应按 metadata groups 生成分组头并支持折叠', () => {
    const fields = [createField('f_title', 'Title'), createField('f_status', 'Status')]
    const currentView = createView()
    const records = [
      createRecord('r1', { Title: 'Task 1', Status: 'Todo' }),
      createRecord('r2', { Title: 'Task 2', Status: 'Done' }),
    ]
    const viewRecords = createViewRecords(records)

    const { result, rerender } = renderHook(
      ({ collapsedGroupIds }: { collapsedGroupIds: string[] }) =>
        useDataGridDataset({
          fields,
          currentView,
          currentViewRecords: viewRecords,
          records,
          useViewData: true,
          collapsedGroupIds,
          isRecordsLoading: false,
          isRecordLoading: false,
          recordsQueryPage: 1,
          recordsQueryPageSize: 50,
          page: 1,
          pageSize: 50,
          total: 2,
          t: (key: string) => key,
          locale: 'zh-CN',
        }),
      {
        initialProps: { collapsedGroupIds: [] },
      }
    )

    expect(result.current.groupedRows).toHaveLength(6)
    expect(result.current.groupedRows[0].__rowType).toBe('group_header')
    expect(result.current.groupedRows[0].__groupLabel).toBe('Done')
    expect(result.current.groupedRows[0].__groupIsLeaf).toBe(true)
    expect(result.current.groupedRows[1].id).toBe('r2')
    expect(result.current.groupedRows[2].__rowType).toBe('group_add')
    expect(result.current.groupedRows[2].__groupValues).toEqual({ Status: 'Done' })
    expect(result.current.groupedRows[3].__rowType).toBe('group_header')
    expect(result.current.groupedRows[3].__groupLabel).toBe('Todo')
    expect(result.current.groupedRows[3].__groupIsLeaf).toBe(true)
    expect(result.current.groupedRows[4].id).toBe('r1')
    expect(result.current.groupedRows[5].__rowType).toBe('group_add')
    expect(result.current.groupedRows[5].__groupValues).toEqual({ Status: 'Todo' })

    rerender({ collapsedGroupIds: ['Todo'] })
    expect(result.current.groupedRows).toHaveLength(4)
    expect(result.current.groupedRows[0].__groupLabel).toBe('Done')
    expect(result.current.groupedRows[0].__groupIsLeaf).toBe(true)
    expect(result.current.groupedRows[1].id).toBe('r2')
    expect(result.current.groupedRows[2].__rowType).toBe('group_add')
    expect(result.current.groupedRows[3].__groupLabel).toBe('Todo')
    expect(result.current.groupedRows[3].__groupIsLeaf).toBe(true)
  })

  it('折叠全部父组后，不应把后代记录重新展示到未分组', () => {
    const fields = [
      createField('f_title', 'Title'),
      createField('f_owner', 'Owner'),
      createField('f_status', 'Status'),
    ]
    const records = [
      createRecord('r1', { Title: 'Alice Todo', Owner: 'Alice', Status: 'Todo' }),
      createRecord('r2', { Title: 'Alice Ungrouped', Owner: 'Alice', Status: null }),
      createRecord('r3', { Title: 'Bob Done', Owner: 'Bob', Status: 'Done' }),
    ]
    const currentView: ViewMeta = {
      ...createView(),
      groups: [
        { field_id: 'f_owner', direction: 'asc' },
        { field_id: 'f_status', direction: 'asc' },
      ],
      visible_fields: ['f_title', 'f_owner', 'f_status'],
      field_order: ['f_title', 'f_owner', 'f_status'],
    }
    const currentViewRecords: ViewRecordsResponse = {
      view: { id: 'view-1', name: 'Grid', view_type: 'grid', config: {} },
      records,
      total: records.length,
      page: 1,
      page_size: 50,
      metadata: {
        groups: {
          fields: [
            { field_id: 'f_owner', direction: 'asc' },
            { field_id: 'f_status', direction: 'asc' },
          ],
          nodes: [
            {
              group_value: 'Alice',
              group_label: 'Alice',
              count: 2,
              children: [
                { group_value: 'Todo', group_label: 'Todo', count: 1 },
                { group_value: null, group_label: '未分组', count: 1 },
              ],
            },
            {
              group_value: 'Bob',
              group_label: 'Bob',
              count: 1,
              children: [{ group_value: 'Done', group_label: 'Done', count: 1 }],
            },
          ],
        },
      },
    }

    const { result } = renderHook(() =>
      useDataGridDataset({
        fields,
        currentView,
        currentViewRecords,
        records,
        useViewData: true,
        collapsedGroupIds: ['Alice', 'Bob'],
        isRecordsLoading: false,
        isRecordLoading: false,
        recordsQueryPage: 1,
        recordsQueryPageSize: 50,
        page: 1,
        pageSize: 50,
        total: records.length,
        t: (key: string) => key,
        locale: 'zh-CN',
      })
    )

    expect(result.current.groupedRows.map(row => row.__groupLabel)).toEqual(['Alice', 'Bob'])
    expect(result.current.groupedRows.some(row => !row.__rowType)).toBe(false)
  })

  it('切视图竞态：当前表格有分组但 records 仍属旧看板时，不用旧 nodes 且记录保持可见', () => {
    const fields = [
      createField('f_title', 'Title'),
      createField('f_status', 'Status'),
      createField('f_priority', 'Priority'),
    ]
    // 当前已切到按 Priority 分组的表格视图
    const currentView: ViewMeta = {
      ...createView(),
      id: 'grid-priority',
      name: 'Grid by Priority',
      groups: [{ field_id: 'f_priority', direction: 'asc' }],
      visible_fields: ['f_title', 'f_status', 'f_priority'],
      field_order: ['f_title', 'f_status', 'f_priority'],
    }
    const records = [
      createRecord('r1', { Title: 'Task 1', Status: 'Todo', Priority: 'P0' }),
      createRecord('r2', { Title: 'Task 2', Status: 'Done', Priority: 'P1' }),
    ]
    // 滞留的旧看板投影：view.id 不匹配，metadata 仍是 Status 分组
    const staleKanbanRecords: ViewRecordsResponse = {
      view: {
        id: 'kanban-status',
        name: 'Kanban',
        view_type: 'kanban',
        config: { group_by_field: 'f_status' },
      },
      records,
      total: records.length,
      page: 1,
      page_size: 50,
      metadata: {
        groups: {
          fields: [{ field_id: 'f_status', direction: 'asc' }],
          nodes: [
            { group_value: 'Todo', group_label: 'Todo', count: 1 },
            { group_value: 'Done', group_label: 'Done', count: 1 },
          ],
        },
      },
    }

    const { result } = renderHook(() =>
      useDataGridDataset({
        fields,
        currentView,
        currentViewRecords: staleKanbanRecords,
        records,
        useViewData: true,
        collapsedGroupIds: [],
        isRecordsLoading: false,
        isRecordLoading: false,
        recordsQueryPage: 1,
        recordsQueryPageSize: 50,
        page: 1,
        pageSize: 50,
        total: 2,
        t: (key: string) => key,
        locale: 'zh-CN',
      })
    )

    const labels = result.current.groupedRows
      .filter(row => row.__rowType === 'group_header')
      .map(row => row.__groupLabel)
    expect(labels).not.toContain('Todo')
    expect(labels).not.toContain('Done')

    const recordIds = result.current.groupedRows
      .filter(row => !row.__rowType || row.__rowType === 'record')
      .map(row => row.id)
    expect(recordIds).toEqual(expect.arrayContaining(['r1', 'r2']))
    expect(result.current.groupedRows.some(row => row.id === 'r1')).toBe(true)
    expect(result.current.groupedRows.some(row => row.id === 'r2')).toBe(true)
  })

  it('当前视图已清空分组时，不应被同视图残留 metadata 恢复分组样式', () => {
    const fields = [createField('f_title', 'Title'), createField('f_assignee', '指派人')]
    const currentView: ViewMeta = {
      ...createView(),
      id: 'grid-ungrouped',
      groups: [],
      visible_fields: ['f_title', 'f_assignee'],
      field_order: ['f_title', 'f_assignee'],
    }
    const records = [
      createRecord('r1', { Title: 'Task 1', 指派人: 'user-1' }),
    ]
    const recordsWithStaleGrouping: ViewRecordsResponse = {
      view: {
        id: currentView.id,
        name: currentView.name,
        view_type: 'grid',
        config: {},
      },
      records,
      total: records.length,
      page: 1,
      page_size: 50,
      metadata: {
        groups: {
          fields: [{ field_id: 'f_assignee', direction: 'asc' }],
          nodes: [
            { group_value: 'user-1', group_label: 'user-1', count: 1 },
          ],
        },
      },
    }

    const { result } = renderHook(() =>
      useDataGridDataset({
        fields,
        currentView,
        currentViewRecords: recordsWithStaleGrouping,
        records,
        useViewData: true,
        collapsedGroupIds: [],
        isRecordsLoading: false,
        isRecordLoading: false,
        recordsQueryPage: 1,
        recordsQueryPageSize: 50,
        page: 1,
        pageSize: 50,
        total: 1,
        t: (key: string) => key,
        locale: 'zh-CN',
      })
    )

    expect(result.current.hasGrouping).toBe(false)
    expect(result.current.groupedRows.some(row => row.__rowType === 'group_header')).toBe(false)
    expect(result.current.groupedRows.map(row => row.id)).toEqual(['r1', '__add_row__'])
  })

  it('分组头应展示原始 group_value，避免把 choice label 当成用户数据翻译', () => {
    const fields = [createField('f_title', 'Title'), createField('f_status', 'Status')]
    const currentView = createView()
    const records = [
      createRecord('r1', { Title: 'Task 1', Status: 'open' }),
      createRecord('r2', { Title: 'Task 2', Status: 'closed' }),
    ]
    const viewRecords: ViewRecordsResponse = {
      ...createViewRecords(records),
      metadata: {
        groups: {
          fields: [{ field_id: 'f_status', direction: 'asc' }],
          nodes: [
            { group_value: 'open', group_label: '打开', count: 1 },
            { group_value: 'closed', group_label: '关闭', count: 1 },
          ],
        },
      },
    }

    const { result } = renderHook(() =>
      useDataGridDataset({
        fields,
        currentView,
        currentViewRecords: viewRecords,
        records,
        useViewData: true,
        collapsedGroupIds: [],
        isRecordsLoading: false,
        isRecordLoading: false,
        recordsQueryPage: 1,
        recordsQueryPageSize: 50,
        page: 1,
        pageSize: 50,
        total: 2,
        t: (key: string) => key,
        locale: 'zh-CN',
      })
    )

    expect(result.current.groupedRows[0].__groupLabel).toBe('closed')
    expect(result.current.groupedRows[3].__groupLabel).toBe('open')
  })

  it('应优先使用 column_meta 计算字段显示和顺序', () => {
    const fields = [
      createField('f_title', 'Title'),
      createField('f_status', 'Status'),
      createField('f_owner', 'Owner'),
    ]
    const records = [createRecord('r1', { Title: 'Task 1', Status: 'Todo', Owner: 'Alice' })]
    const currentView: ViewMeta = {
      ...createView(),
      visible_fields: ['f_title', 'f_status', 'f_owner'],
      field_order: ['f_title', 'f_status', 'f_owner'],
      column_meta: {
        f_owner: { order: 0, visible: true },
        f_title: { order: 1, visible: true },
        f_status: { order: 2, hidden: true },
      },
      groups: [],
    }

    const { result } = renderHook(() =>
      useDataGridDataset({
        fields,
        currentView,
        currentViewRecords: null,
        records,
        useViewData: false,
        collapsedGroupIds: [],
        isRecordsLoading: false,
        isRecordLoading: false,
        recordsQueryPage: 1,
        recordsQueryPageSize: 50,
        page: 1,
        pageSize: 50,
        total: 1,
        t: (key: string) => key,
        locale: 'zh-CN',
      })
    )

    expect(result.current.orderedFields.map(field => field.id)).toEqual(['f_owner', 'f_title'])
  })

  it('grid 视图应优先按 hidden 语义解析 column_meta（兼容 visible 回退）', () => {
    const fields = [
      createField('f_title', 'Title'),
      createField('f_status', 'Status'),
      createField('f_owner', 'Owner'),
    ]
    const records = [createRecord('r1', { Title: 'Task 1', Status: 'Todo', Owner: 'Alice' })]
    const currentView: ViewMeta = {
      ...createView(),
      column_meta: {
        f_title: { order: 0, visible: false },
        f_status: { order: 1 },
        f_owner: { order: 2 },
      },
      groups: [],
    }

    const { result } = renderHook(() =>
      useDataGridDataset({
        fields,
        currentView,
        currentViewRecords: null,
        records,
        useViewData: false,
        collapsedGroupIds: [],
        isRecordsLoading: false,
        isRecordLoading: false,
        recordsQueryPage: 1,
        recordsQueryPageSize: 50,
        page: 1,
        pageSize: 50,
        total: 1,
        t: (key: string) => key,
        locale: 'zh-CN',
      })
    )

    expect(result.current.orderedFields.map(field => field.id)).toEqual(['f_status', 'f_owner'])
  })

  it('应兼容读取 record.fields（field id key）', () => {
    const fields = [createField('f_title', 'Title'), createField('f_status', 'Status')]
    const records: TableRecord[] = [
      {
        ...createRecord('r1', {}),
        fields: {
          f_title: 'Task 1',
          f_status: 'Todo',
        },
      },
    ]

    const { result } = renderHook(() =>
      useDataGridDataset({
        fields,
        currentView: createView(),
        currentViewRecords: null,
        records,
        useViewData: false,
        collapsedGroupIds: [],
        isRecordsLoading: false,
        isRecordLoading: false,
        recordsQueryPage: 1,
        recordsQueryPageSize: 50,
        page: 1,
        pageSize: 50,
        total: 1,
        t: (key: string) => key,
        locale: 'zh-CN',
      })
    )

    expect(result.current.rowsData[0].Title).toBe('Task 1')
    expect(result.current.rowsData[0].Status).toBe('Todo')
  })

  it('preserves an explicit null instead of falling back to a stale compatibility key', () => {
    const fieldId = 'e84e6de4-2552-4c0d-a52c-81c2f1493abc'
    const compactFieldId = fieldId.replace(/-/g, '')
    const fields = [createField(fieldId, 'Date')]
    const record: TableRecord = {
      ...createRecord('r1', {
        [compactFieldId]: '2026-08-09',
      }),
      fields: {
        [fieldId]: null,
      },
    }

    const { result } = renderHook(() =>
      useDataGridDataset({
        fields,
        currentView: null,
        currentViewRecords: null,
        records: [record],
        useViewData: false,
        collapsedGroupIds: [],
        isRecordsLoading: false,
        isRecordLoading: false,
        recordsQueryPage: 1,
        recordsQueryPageSize: 50,
        page: 1,
        pageSize: 50,
        total: 1,
        t: (key: string) => key,
        locale: 'zh-CN',
      })
    )

    expect(result.current.rowsData[0].Date).toBeNull()
  })

  it('业务字段名冲突 id/row_id 时，__recordId 隔离系统记录标识，业务单元格保留业务值', () => {
    const fields = [
      createField('f_id', 'id'),
      createField('f_row_id', 'row_id'),
      createField('f_title', 'Title'),
    ]
    const systemRecordId = 'sys-uuid-1234'
    const records: TableRecord[] = [
      {
        ...createRecord(systemRecordId, {}),
        fields: {
          f_id: 'business-id-value',
          f_row_id: 'business-row-id-value',
          f_title: 'Task 1',
        },
      },
    ]

    const { result } = renderHook(() =>
      useDataGridDataset({
        fields,
        currentView: null,
        currentViewRecords: null,
        records,
        useViewData: false,
        collapsedGroupIds: [],
        isRecordsLoading: false,
        isRecordLoading: false,
        recordsQueryPage: 1,
        recordsQueryPageSize: 50,
        page: 1,
        pageSize: 50,
        total: 1,
        t: (key: string) => key,
        locale: 'zh-CN',
      })
    )

    const row = result.current.rowsData[0] as Record<string, unknown>
    expect(row.__recordId).toBe(systemRecordId)
    expect(row.id).toBe('business-id-value')
    expect(row.id).not.toBe(systemRecordId)
    expect(row.id).not.toBe('__draft_row__')
    expect(row.row_id).toBe('business-row-id-value')
  })

  it('新建记录业务 id 为空时，单元格不应回落到系统 UUID', () => {
    const fields = [
      createField('f_id', 'id'),
      createField('f_name', 'name'),
    ]
    const systemRecordId = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890'
    const records: TableRecord[] = [
      {
        ...createRecord(systemRecordId, {
          f_name: 'just-created',
        }),
        fields: {
          f_name: 'just-created',
        },
      },
    ]

    const { result } = renderHook(() =>
      useDataGridDataset({
        fields,
        currentView: null,
        currentViewRecords: null,
        records,
        useViewData: false,
        collapsedGroupIds: [],
        isRecordsLoading: false,
        isRecordLoading: false,
        recordsQueryPage: 1,
        recordsQueryPageSize: 50,
        page: 1,
        pageSize: 50,
        total: 1,
        t: (key: string) => key,
        locale: 'zh-CN',
      })
    )

    const row = result.current.rowsData[0] as Record<string, unknown>
    expect(row.__recordId).toBe(systemRecordId)
    expect(row.name).toBe('just-created')
    expect(row.id).toBeNull()
    expect(row.id).not.toBe(systemRecordId)
  })

  it('业务字段 id 仅存在于 record.data 时，不应被系统 record.id 遮蔽', () => {
    const fields = [
      createField('f_id', 'id'),
      createField('f_name', 'name'),
    ]
    const systemRecordId = 'sys-uuid-data-shape'
    const records: TableRecord[] = [
      createRecord(systemRecordId, {
        f_id: 'csv-business-id',
        id: 'csv-business-id-by-name',
        f_name: 'imported',
        name: 'imported',
      }),
    ]

    const { result } = renderHook(() =>
      useDataGridDataset({
        fields,
        currentView: null,
        currentViewRecords: null,
        records,
        useViewData: false,
        collapsedGroupIds: [],
        isRecordsLoading: false,
        isRecordLoading: false,
        recordsQueryPage: 1,
        recordsQueryPageSize: 50,
        page: 1,
        pageSize: 50,
        total: 1,
        t: (key: string) => key,
        locale: 'zh-CN',
      })
    )

    const row = result.current.rowsData[0] as Record<string, unknown>
    expect(row.__recordId).toBe(systemRecordId)
    expect(row.id).toBe('csv-business-id')
    expect(row.id).not.toBe(systemRecordId)
    expect(row.name).toBe('imported')
  })

  it('按用户字段分组时应展示姓名并保持记录归属唯一', () => {
    const fields: Field[] = [
      createField('f_title', 'Title'),
      { ...createField('f_owner', 'Owner'), field_type: 'user' },
    ]
    const alice = [{ id: 'u-alice', name: 'Alice' }]
    const bob = [{ id: 'u-bob', name: 'Bob' }]
    const records = [
      createRecord('r1', { Title: 'Task 1', Owner: alice }),
      createRecord('r2', { Title: 'Task 2', Owner: bob }),
    ]
    const currentView: ViewMeta = {
      ...createView(),
      groups: [{ field_id: 'f_owner', direction: 'asc' }],
      visible_fields: ['f_title', 'f_owner'],
      field_order: ['f_title', 'f_owner'],
    }
    const currentViewRecords: ViewRecordsResponse = {
      view: { id: 'view-1', name: 'Grid', view_type: 'grid', config: {} },
      records,
      total: records.length,
      page: 1,
      page_size: 50,
      metadata: {
        groups: {
          fields: [{ field_id: 'f_owner', direction: 'asc' }],
          nodes: [
            { group_value: alice, group_label: 'Alice', count: 1 },
            { group_value: bob, group_label: 'Bob', count: 1 },
          ],
        },
      },
    }

    const { result } = renderHook(() =>
      useDataGridDataset({
        fields,
        currentView,
        currentViewRecords,
        records,
        useViewData: true,
        collapsedGroupIds: [],
        isRecordsLoading: false,
        isRecordLoading: false,
        recordsQueryPage: 1,
        recordsQueryPageSize: 50,
        page: 1,
        pageSize: 50,
        total: 2,
        t: (key: string) => key,
        locale: 'zh-CN',
      }),
    )

    const groupRows = result.current.groupedRows.filter(row => row.__rowType === 'group_header')
    expect(groupRows.map(row => row.__groupLabel)).toEqual(['Alice', 'Bob'])
    const recordIds = result.current.groupedRows
      .filter(row => !row.__rowType)
      .map(row => row.id)
    expect(recordIds).toEqual(['r1', 'r2'])
  })

  it('按组织成员 ID 分组时应展示成员姓名', () => {
    const userId = '634e1f02-0f40-426e-84cd-655335b5d247'
    const fields: Field[] = [
      createField('f_title', 'Title'),
      { ...createField('f_owner', 'Owner'), field_type: 'user' },
    ]
    const records = [createRecord('r1', { Title: 'Task 1', Owner: [userId] })]
    const currentView: ViewMeta = {
      ...createView(),
      groups: [{ field_id: 'f_owner', direction: 'asc' }],
      visible_fields: ['f_title', 'f_owner'],
      field_order: ['f_title', 'f_owner'],
    }
    const currentViewRecords: ViewRecordsResponse = {
      view: { id: 'view-1', name: 'Grid', view_type: 'grid', config: {} },
      records,
      total: 1,
      page: 1,
      page_size: 50,
      metadata: {
        groups: {
          fields: [{ field_id: 'f_owner', direction: 'asc' }],
          nodes: [{ group_value: [userId], group_label: userId, count: 1 }],
        },
      },
    }

    const { result } = renderHook(() =>
      useDataGridDataset({
        fields,
        currentView,
        currentViewRecords,
        records,
        userDisplayNameById: new Map([[userId, '张三']]),
        useViewData: true,
        collapsedGroupIds: [],
        isRecordsLoading: false,
        isRecordLoading: false,
        recordsQueryPage: 1,
        recordsQueryPageSize: 50,
        page: 1,
        pageSize: 50,
        total: 1,
        t: (key: string) => key,
        locale: 'zh-CN',
      }),
    )

    const groupRow = result.current.groupedRows.find(row => row.__rowType === 'group_header')
    expect(groupRow?.__groupLabel).toBe('张三')
    expect(groupRow?.__groupValue).toEqual([userId])
  })

  it('#9513 已加载行不在 metadata path 上时仍挂回画布（orphan 回收）', () => {
    const fields: Field[] = [
      createField('f_title', 'Title'),
      { ...createField('f_owner', 'Owner'), field_type: 'user' },
    ]
    const aliceMeta = [{ id: 'u-alice', name: 'Alice', avatar: 'a.png' }]
    const aliceRecord = [{ id: 'u-alice', name: 'Alice', avatar: 'b.png', open_id: 'u-alice' }]
    const orphanUser = [{ id: 'u-orphan', name: 'Orphan' }]
    const records = [
      createRecord('r1', { Title: 'Task 1', Owner: aliceRecord }),
      createRecord('r2', { Title: 'Task 2', Owner: orphanUser }),
    ]
    const currentView: ViewMeta = {
      ...createView(),
      groups: [{ field_id: 'f_owner', direction: 'asc' }],
      visible_fields: ['f_title', 'f_owner'],
      field_order: ['f_title', 'f_owner'],
    }
    const currentViewRecords: ViewRecordsResponse = {
      view: { id: 'view-1', name: 'Grid', view_type: 'grid', config: {} },
      records,
      total: 100,
      page: 1,
      page_size: 50,
      metadata: {
        groups: {
          fields: [{ field_id: 'f_owner', direction: 'asc' }],
          nodes: [
            { group_value: aliceMeta, group_label: 'Alice', count: 40 },
            // metadata 故意缺少 orphan 组；r2 应进入未归类
          ],
        },
      },
    }

    const { result } = renderHook(() =>
      useDataGridDataset({
        fields,
        currentView,
        currentViewRecords,
        records,
        useViewData: true,
        collapsedGroupIds: [],
        isRecordsLoading: false,
        isRecordLoading: false,
        recordsQueryPage: 1,
        recordsQueryPageSize: 50,
        page: 1,
        pageSize: 50,
        total: 100,
        t: (key: string) => key,
        locale: 'zh-CN',
      }),
    )

    const dataIds = result.current.groupedRows
      .filter(row => !row.__rowType)
      .map(row => row.id)
    expect(dataIds).toEqual(expect.arrayContaining(['r1', 'r2']))
    expect(dataIds).toHaveLength(2)

    const aliceHeader = result.current.groupedRows.find(
      row => row.__rowType === 'group_header' && row.__groupLabel === 'Alice',
    )
    expect(aliceHeader?.__groupCount).toBe(40)
    expect(aliceHeader?.__groupLoadedCount).toBe(1)

    // metadata 缺组时按自身 path 建「Orphan」组，不再丢进未归类
    const orphanHeader = result.current.groupedRows.find(
      row => row.__rowType === 'group_header' && row.__groupLabel === 'Orphan',
    )
    expect(orphanHeader?.__groupPath).toBe('user:["name:Orphan"]')
    expect(orphanHeader?.__groupLoadedCount).toBe(1)
    expect(
      result.current.groupedRows.some(
        row => row.__rowType === 'group_header' && row.__groupPath === '__unclassified__',
      ),
    ).toBe(false)
  })

  it('#0ca30578 增量新组按正式规则稳定插入，刷新后不跳位', () => {
    const fields: Field[] = [
      createField('f_title', 'Title'),
      { ...createField('f_owner', 'Owner'), field_type: 'user' },
      {
        ...createField('f_status', 'Status'),
        field_type: 'select',
        options: { choices: ['新提交', '处理中', '待部署'] },
      },
    ]
    const currentView: ViewMeta = {
      ...createView(),
      groups: [
        { field_id: 'f_owner', direction: 'asc' },
        { field_id: 'f_status', direction: 'asc' },
      ],
      visible_fields: ['f_title', 'f_owner', 'f_status'],
      field_order: ['f_title', 'f_owner', 'f_status'],
    }
    const records = [
      // r1 的合法状态变更先经实时增量到达；旧 metadata 尚无「处理中」子组。
      createRecord('r1', { Title: 'moved', Owner: ['00000000-0000-4000-8000-000000000001'], Status: '处理中' }),
      createRecord('r2', { Title: 'existing', Owner: ['00000000-0000-4000-8000-000000000001'], Status: '待部署' }),
      // 新负责人组在旧 metadata 中也不存在；同值并列记录保持源顺序。
      createRecord('r3', { Title: 'tie-1', Owner: ['00000000-0000-4000-8000-000000000002'], Status: '新提交' }),
      createRecord('r4', { Title: 'tie-2', Owner: ['00000000-0000-4000-8000-000000000002'], Status: '新提交' }),
      createRecord('r5', { Title: 'empty', Owner: null, Status: '新提交' }),
      createRecord('r6', { Title: 'collapsed', Owner: ['00000000-0000-4000-8000-000000000003'], Status: '新提交' }),
    ]
    const staleViewRecords: ViewRecordsResponse = {
      view: { id: 'view-1', name: 'Grid', view_type: 'grid', config: {} },
      records,
      total: records.length,
      page: 1,
      page_size: 50,
      metadata: {
        groups: {
          fields: [
            { field_id: 'f_owner', direction: 'asc' },
            { field_id: 'f_status', direction: 'asc' },
          ],
          nodes: [
            {
              group_value: ['00000000-0000-4000-8000-000000000001'],
              count: 2,
              children: [
                { group_value: '新提交', count: 1 },
                { group_value: '待部署', count: 1 },
              ],
            },
            {
              group_value: ['00000000-0000-4000-8000-000000000003'],
              count: 1,
              children: [{ group_value: '新提交', count: 1 }],
            },
          ],
        },
      },
    }
    const freshViewRecords: ViewRecordsResponse = {
      ...staleViewRecords,
      metadata: {
        groups: {
          fields: staleViewRecords.metadata!.groups!.fields,
          nodes: [
            {
              group_value: ['00000000-0000-4000-8000-000000000001'],
              count: 2,
              children: [
                { group_value: '处理中', count: 1 },
                { group_value: '待部署', count: 1 },
              ],
            },
            {
              group_value: ['00000000-0000-4000-8000-000000000002'],
              count: 2,
              children: [{ group_value: '新提交', count: 2 }],
            },
            {
              group_value: ['00000000-0000-4000-8000-000000000003'],
              count: 1,
              children: [{ group_value: '新提交', count: 1 }],
            },
            {
              group_value: null,
              count: 1,
              children: [{ group_value: '新提交', count: 1 }],
            },
          ],
        },
      },
    }
    const common = {
      fields,
      currentView,
      records,
      userDisplayNameById: new Map([
        ['00000000-0000-4000-8000-000000000001', 'A'],
        ['00000000-0000-4000-8000-000000000002', 'B'],
        ['00000000-0000-4000-8000-000000000003', 'C'],
      ]),
      useViewData: true,
      collapsedGroupIds: ['user:["00000000-0000-4000-8000-000000000003"]'],
      isRecordsLoading: false,
      isRecordLoading: false,
      recordsQueryPage: 1,
      recordsQueryPageSize: 50,
      page: 1,
      pageSize: 50,
      total: records.length,
      t: (key: string) => key,
      locale: 'zh-CN',
    }

    const { result, rerender } = renderHook(
      ({ currentViewRecords }: { currentViewRecords: ViewRecordsResponse }) =>
        useDataGridDataset({ ...common, currentViewRecords }),
      { initialProps: { currentViewRecords: staleViewRecords } },
    )

    const snapshot = () => result.current.groupedRows.map(row => ({
      id: row.id,
      type: row.__rowType,
      level: row.__groupLevel,
      label: row.__groupLabel,
      path: row.__groupPath,
      collapsed: row.__groupCollapsed,
    }))
    const incrementalRows = snapshot()
    const topGroups = incrementalRows
      .filter(row => row.type === 'group_header' && row.level === 0)
      .map(row => row.label)
    expect(topGroups).toEqual(['A', 'B', 'C', 'table:group.ungrouped'])
    expect(
      incrementalRows
        .filter(row => row.type === 'group_header' && row.path?.startsWith('user:["00000000-0000-4000-8000-000000000001"]||'))
        .map(row => row.label),
    ).toEqual(['处理中', '待部署'])
    expect(
      result.current.groupedRows.filter(row => !row.__rowType).map(row => row.id),
    ).toEqual(['r1', 'r2', 'r3', 'r4', 'r5'])
    expect(
      incrementalRows.find(row => row.path === 'user:["00000000-0000-4000-8000-000000000003"]')?.collapsed,
    ).toBe(true)

    rerender({ currentViewRecords: freshViewRecords })
    expect(snapshot()).toEqual(incrementalRows)
  })

  it('#0ca30578 用户改名后按稳定 id 使用最新显示名，且不改变分组路径', () => {
    const fields: Field[] = [
      createField('f_title', 'Title'),
      { ...createField('f_owner', 'Owner'), field_type: 'user' },
    ]
    const staleOwner = [{ id: 'user-1', name: '旧名字' }]
    const records = [createRecord('r1', { Title: 'Task', Owner: staleOwner })]
    const currentView: ViewMeta = {
      ...createView(),
      groups: [{ field_id: 'f_owner', direction: 'asc' }],
      visible_fields: ['f_title', 'f_owner'],
      field_order: ['f_title', 'f_owner'],
    }
    const currentViewRecords: ViewRecordsResponse = {
      view: { id: 'view-1', name: 'Grid', view_type: 'grid', config: {} },
      records,
      total: 1,
      page: 1,
      page_size: 50,
      metadata: {
        groups: {
          fields: [{ field_id: 'f_owner', direction: 'asc' }],
          nodes: [{ group_value: staleOwner, group_label: '旧名字', count: 1 }],
        },
      },
    }

    const { result, rerender } = renderHook(({ displayName }: { displayName: string }) =>
      useDataGridDataset({
        fields,
        currentView,
        currentViewRecords,
        records,
        userDisplayNameById: new Map([['user-1', displayName]]),
        useViewData: true,
        collapsedGroupIds: [],
        isRecordsLoading: false,
        isRecordLoading: false,
        recordsQueryPage: 1,
        recordsQueryPageSize: 50,
        page: 1,
        pageSize: 50,
        total: 1,
        t: (key: string) => key,
        locale: 'zh-CN',
      }),
      { initialProps: { displayName: '旧名字' } },
    )

    const beforeRows = result.current.groupedRows.map(row => row.id)
    const beforeHeader = result.current.groupedRows.find(row => row.__rowType === 'group_header')
    expect(beforeHeader?.__groupLabel).toBe('旧名字')
    expect(beforeHeader?.__groupPath).toBe('user:["user-1"]')

    rerender({ displayName: '新名字' })

    const header = result.current.groupedRows.find(row => row.__rowType === 'group_header')
    expect(header?.__groupLabel).toBe('新名字')
    expect(header?.__groupPath).toBe('user:["user-1"]')
    expect(result.current.groupedRows.map(row => row.id)).toEqual(beforeRows)
  })

  it('#9513 折叠组仍按已加载行数计 loaded，避免误显示 0 / N', () => {
    const fields: Field[] = [
      createField('f_title', 'Title'),
      { ...createField('f_owner', 'Owner'), field_type: 'user' },
    ]
    const alice = [{ id: 'u-alice', name: 'Alice' }]
    const records = [
      createRecord('r1', { Title: 'Task 1', Owner: alice }),
      createRecord('r2', { Title: 'Task 2', Owner: alice }),
    ]
    const currentView: ViewMeta = {
      ...createView(),
      groups: [{ field_id: 'f_owner', direction: 'asc' }],
      visible_fields: ['f_title', 'f_owner'],
      field_order: ['f_title', 'f_owner'],
    }
    const groupPath = 'user:["name:Alice"]'
    const currentViewRecords: ViewRecordsResponse = {
      view: { id: 'view-1', name: 'Grid', view_type: 'grid', config: {} },
      records,
      total: 40,
      page: 1,
      page_size: 50,
      metadata: {
        groups: {
          fields: [{ field_id: 'f_owner', direction: 'asc' }],
          nodes: [{ group_value: alice, group_label: 'Alice', count: 40 }],
        },
      },
    }

    const { result } = renderHook(() =>
      useDataGridDataset({
        fields,
        currentView,
        currentViewRecords,
        records,
        useViewData: true,
        collapsedGroupIds: [groupPath],
        isRecordsLoading: false,
        isRecordLoading: false,
        recordsQueryPage: 1,
        recordsQueryPageSize: 50,
        page: 1,
        pageSize: 50,
        total: 40,
        t: (key: string) => key,
        locale: 'zh-CN',
      }),
    )

    const header = result.current.groupedRows.find(row => row.__rowType === 'group_header')
    expect(header?.__groupCollapsed).toBe(true)
    expect(header?.__groupCount).toBe(40)
    expect(header?.__groupLoadedCount).toBe(2)
    expect(result.current.groupedRows.some(row => !row.__rowType)).toBe(false)
    expect(result.current.searchableRows.map(row => row.__recordId)).toEqual(['r1', 'r2'])
    expect(result.current.groupPathByRecordId).toEqual(new Map([
      ['r1', groupPath],
      ['r2', groupPath],
    ]))
  })

  it('#9513 同展示名裂变 node 只出一个组头并合并 count', () => {
    const fields: Field[] = [
      createField('f_title', 'Title'),
      { ...createField('f_owner', 'Owner'), field_type: 'user' },
    ]
    const shapeA = [{ id: 'ou_1', name: 'Alice', avatar: 'a.png' }]
    const shapeB = [{ id: 'ou_2', name: 'Alice', avatar: 'b.png' }]
    const records = [createRecord('r1', { Title: 'Task 1', Owner: shapeA })]
    const currentView: ViewMeta = {
      ...createView(),
      groups: [{ field_id: 'f_owner', direction: 'asc' }],
      visible_fields: ['f_title', 'f_owner'],
      field_order: ['f_title', 'f_owner'],
    }
    const currentViewRecords: ViewRecordsResponse = {
      view: { id: 'view-1', name: 'Grid', view_type: 'grid', config: {} },
      records,
      total: 5,
      page: 1,
      page_size: 50,
      metadata: {
        groups: {
          fields: [{ field_id: 'f_owner', direction: 'asc' }],
          nodes: [
            { group_value: shapeA, group_label: 'Alice', count: 3 },
            { group_value: shapeB, group_label: 'Alice', count: 2 },
          ],
        },
      },
    }

    const { result } = renderHook(() =>
      useDataGridDataset({
        fields,
        currentView,
        currentViewRecords,
        records,
        useViewData: true,
        collapsedGroupIds: [],
        isRecordsLoading: false,
        isRecordLoading: false,
        recordsQueryPage: 1,
        recordsQueryPageSize: 50,
        page: 1,
        pageSize: 50,
        total: 5,
        t: (key: string) => key,
        locale: 'zh-CN',
      }),
    )

    const groupRows = result.current.groupedRows.filter(row => row.__rowType === 'group_header')
    expect(groupRows).toHaveLength(1)
    expect(groupRows[0].__groupPath).toBe('user:["name:Alice"]')
    expect(groupRows[0].__groupCount).toBe(5)
    expect(groupRows[0].__groupLoadedCount).toBe(1)
  })

  it('#9513 组织成员与未匹配导入的同名「张三」拆成两组', () => {
    const memberId = '634e1f02-0f40-426e-84cd-655335b5d247'
    const fields: Field[] = [
      createField('f_title', 'Title'),
      { ...createField('f_owner', 'Owner'), field_type: 'user' },
    ]
    const memberValue = [{ id: memberId, name: '张三' }]
    const importedValue = [{ id: 'ou_feishu_xxx', name: '张三' }]
    const records = [
      createRecord('r-member', { Title: 'M', Owner: memberValue }),
      createRecord('r-import', { Title: 'I', Owner: importedValue }),
    ]
    const currentView: ViewMeta = {
      ...createView(),
      groups: [{ field_id: 'f_owner', direction: 'asc' }],
      visible_fields: ['f_title', 'f_owner'],
      field_order: ['f_title', 'f_owner'],
    }
    const currentViewRecords: ViewRecordsResponse = {
      view: { id: 'view-1', name: 'Grid', view_type: 'grid', config: {} },
      records,
      total: 2,
      page: 1,
      page_size: 50,
      metadata: {
        groups: {
          fields: [{ field_id: 'f_owner', direction: 'asc' }],
          nodes: [
            { group_value: memberValue, group_label: '张三', count: 1 },
            { group_value: importedValue, group_label: '张三', count: 1 },
          ],
        },
      },
    }

    const { result } = renderHook(() =>
      useDataGridDataset({
        fields,
        currentView,
        currentViewRecords,
        records,
        userDisplayNameById: new Map([[memberId, '张三']]),
        useViewData: true,
        collapsedGroupIds: [],
        isRecordsLoading: false,
        isRecordLoading: false,
        recordsQueryPage: 1,
        recordsQueryPageSize: 50,
        page: 1,
        pageSize: 50,
        total: 2,
        t: (key: string) => key,
        locale: 'zh-CN',
      }),
    )

    const headers = result.current.groupedRows.filter(row => row.__rowType === 'group_header')
    expect(headers).toHaveLength(2)
    expect(headers.map(row => row.__groupLabel)).toEqual(['张三', '张三'])
    expect(headers.map(row => row.__groupPath).sort()).toEqual(
      [`user:["${memberId}"]`, 'user:["name:张三"]'].sort(),
    )
  })
})
