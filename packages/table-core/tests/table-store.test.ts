import assert from 'node:assert/strict'
import test from 'node:test'
import { createStore } from 'zustand/vanilla'
import {
  createTableStoreState,
  type TableStore,
  type TableStoreFieldService,
  type TableStoreTableService,
} from '../src'

const createTableService = (overrides: Partial<TableStoreTableService> = {}): TableStoreTableService => ({
  getTablesBySpace: async (_organizationId, spaceId) => ({
    tables: [
      {
        id: `${spaceId}-table`,
        space_id: spaceId,
        name: `${spaceId}-name`,
        created_by_id: 'user-1',
        row_count: 0,
        field_count: 0,
        is_archived: false,
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
      },
    ],
    total: 1,
  }),
  getAllTablesInOrganization: async () => ({ tables: [], total: 0 }),
  getTable: async () => {
    throw new Error('not implemented in test')
  },
  createTableInSpace: async () => {
    throw new Error('not implemented in test')
  },
  createTable: async () => {
    throw new Error('not implemented in test')
  },
  updateTable: async () => {
    throw new Error('not implemented in test')
  },
  deleteTable: async () => undefined,
  archiveTable: async () => undefined,
  restoreTable: async () => undefined,
  getTableStats: async () => {
    throw new Error('not implemented in test')
  },
  ...overrides,
})

const createFieldService = (overrides: Partial<TableStoreFieldService> = {}): TableStoreFieldService => ({
  getFields: async () => ({ fields: [], total: 0 }),
  ...overrides,
})

const createTestStore = (
  tableService: TableStoreTableService = createTableService(),
  fieldService: TableStoreFieldService = createFieldService()
) => createStore<TableStore>()(createTableStoreState({ tableService, fieldService }))

test('table-store: loadTablesBySpace 会保留其他 Space 表并更新当前 Space 表', async () => {
  const store = createTestStore()
  store.setState({
    tables: [
      {
        id: 'p1-table',
        space_id: 'p1',
        name: 'p1-old',
        created_by_id: 'user-1',
        row_count: 1,
        field_count: 1,
        is_archived: false,
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
      },
    ],
  })

  await store.getState().loadTablesBySpace('ws1', 'p2')
  const tables = store.getState().tables

  assert.equal(tables.length, 2)
  assert.ok(tables.some(table => table.space_id === 'p1'))
  assert.ok(tables.some(table => table.space_id === 'p2'))
})

test('table-store: loadTablesBySpace 兼容仅返回 space_id 的列表响应', async () => {
  const store = createTestStore(createTableService({
    getTablesBySpace: async () => ({
      tables: [
        {
          id: 'p1-fresh',
          space_id: 'p1',
          name: 'p1-fresh',
          created_by_id: 'user-1',
          row_count: 0,
          field_count: 0,
          is_archived: false,
          created_at: '2026-01-01T00:00:00Z',
          updated_at: '2026-01-01T00:00:00Z',
        },
      ],
      total: 1,
    }),
  }))

  store.setState({
    tables: [
      {
        id: 'p1-stale',
        space_id: 'p1',
        name: 'p1-stale',
        created_by_id: 'user-1',
        row_count: 1,
        field_count: 1,
        is_archived: false,
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
      },
      {
        id: 'p2-keep',
        space_id: 'p2',
        name: 'p2-keep',
        created_by_id: 'user-1',
        row_count: 1,
        field_count: 1,
        is_archived: false,
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
      },
    ],
  })

  await store.getState().loadTablesBySpace('ws1', 'p1')
  const tables = store.getState().tables
  const fresh = tables.find(table => table.id === 'p1-fresh')

  assert.equal(tables.length, 2)
  assert.ok(fresh)
  assert.equal(fresh?.space_id, 'p1')
  assert.ok(tables.some(table => table.id === 'p2-keep'))
  assert.equal(tables.some(table => table.id === 'p1-stale'), false)
})

const makeField = (id: string, sortOrder: number): import('../src').Field => ({
  id,
  table_id: 't1',
  name: id,
  field_type: 'text',
  is_primary: false,
  is_hidden: false,
  sort_order: sortOrder,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
})

const selectTableT1 = (store: ReturnType<typeof createTestStore>) => {
  store.setState({
    selectedTable: {
      id: 't1',
      space_id: 'p1',
      name: 'demo',
      created_by_id: 'user-1',
      row_count: 0,
      field_count: 0,
      is_archived: false,
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
    },
    fields: [makeField('f1', 0), makeField('f2', 1)],
  })
}

test('table-store: upsertFieldLocal 默认追加到末尾并重排 sort_order', () => {
  const store = createTestStore()
  selectTableT1(store)

  store.getState().upsertFieldLocal('t1', makeField('f3', 99))
  const fields = store.getState().fields

  assert.deepEqual(fields.map(f => f.id), ['f1', 'f2', 'f3'])
  assert.deepEqual(fields.map(f => f.sort_order), [0, 1, 2])
  assert.equal(store.getState().selectedTable?.field_count, 3)
})

test('table-store: upsertFieldLocal 支持 before / after 插入参考字段', () => {
  const store = createTestStore()
  selectTableT1(store)

  store.getState().upsertFieldLocal('t1', makeField('fbefore', 0), {
    referenceFieldId: 'f2',
    position: 'before',
  })
  assert.deepEqual(store.getState().fields.map(f => f.id), ['f1', 'fbefore', 'f2'])

  store.getState().upsertFieldLocal('t1', makeField('fafter', 0), {
    referenceFieldId: 'f1',
    position: 'after',
  })
  assert.deepEqual(store.getState().fields.map(f => f.id), ['f1', 'fafter', 'fbefore', 'f2'])
  assert.deepEqual(store.getState().fields.map(f => f.sort_order), [0, 1, 2, 3])
})

test('table-store: upsertFieldLocal 同 id 去重（更新而非重复插入）', () => {
  const store = createTestStore()
  selectTableT1(store)

  store.getState().upsertFieldLocal('t1', { ...makeField('f1', 0), name: 'renamed' })
  const fields = store.getState().fields

  assert.equal(fields.length, 2)
  assert.deepEqual(fields.map(f => f.id), ['f1', 'f2'])
  assert.deepEqual(fields.map(f => f.sort_order), [0, 1])
  assert.equal(fields.find(f => f.id === 'f1')?.name, 'renamed')
})

test('table-store: upsertFieldLocal 对非当前选中表是 no-op', () => {
  const store = createTestStore()
  selectTableT1(store)

  store.getState().upsertFieldLocal('other-table', makeField('fx', 0))

  assert.deepEqual(store.getState().fields.map(f => f.id), ['f1', 'f2'])
})

test('table-store: removeFieldLocal 删除字段并重排 sort_order', () => {
  const store = createTestStore()
  selectTableT1(store)
  store.setState(state => ({
    tables: [
      {
        ...state.selectedTable!,
        field_count: 2,
      },
    ],
    selectedTable: {
      ...state.selectedTable!,
      field_count: 2,
    },
  }))

  store.getState().removeFieldLocal('t1', 'f1')
  const fields = store.getState().fields

  assert.deepEqual(fields.map(f => f.id), ['f2'])
  assert.deepEqual(fields.map(f => f.sort_order), [0])
  assert.equal(store.getState().selectedTable?.field_count, 1)
  assert.equal(store.getState().tables.find(table => table.id === 't1')?.field_count, 1)
})

test('table-store: removeFieldLocal 对非当前选中表是 no-op', () => {
  const store = createTestStore()
  selectTableT1(store)

  store.getState().removeFieldLocal('other-table', 'f1')

  assert.deepEqual(store.getState().fields.map(f => f.id), ['f1', 'f2'])
})

test('table-store: upsertFieldLocal 登记 pendingOptimisticFieldIds', () => {
  const store = createTestStore()
  selectTableT1(store)

  store.getState().upsertFieldLocal('t1', makeField('f-new', 2))

  assert.deepEqual(store.getState().pendingOptimisticFieldIds, ['f-new'])
  assert.ok(store.getState().fields.some(f => f.id === 'f-new'))
})

test('table-store: loadFields 同步响应中的 schema_version', async () => {
  const store = createTestStore(
    createTableService(),
    createFieldService({
      getFields: async () => ({
        fields: [makeField('f1', 0), makeField('f2', 1)],
        total: 2,
        schema_version: 7,
      }),
    }),
  )
  selectTableT1(store)
  store.setState({
    selectedTable: {
      ...store.getState().selectedTable!,
      schema_version: 6,
      field_count: 2,
    },
    tables: [
      {
        ...store.getState().selectedTable!,
        schema_version: 6,
        field_count: 2,
      },
    ],
  })

  await store.getState().loadFields('t1')

  assert.equal(store.getState().selectedTable?.schema_version, 7)
  assert.equal(store.getState().tables.find(t => t.id === 't1')?.schema_version, 7)
})

test('table-store: loadFields 旧快照不得覆盖尚未确认的乐观字段', async () => {
  const store = createTestStore(
    createTableService(),
    createFieldService({
      getFields: async () => ({
        fields: [makeField('f1', 0), makeField('f2', 1)],
        total: 2,
      }),
    }),
  )
  selectTableT1(store)
  store.getState().upsertFieldLocal('t1', makeField('f-new', 2))

  await store.getState().loadFields('t1')

  assert.deepEqual(store.getState().fields.map(f => f.id), ['f1', 'f2', 'f-new'])
  assert.deepEqual(store.getState().pendingOptimisticFieldIds, ['f-new'])
})

test('table-store: 连续 loadFields 尾请求 coalesce，最终应包含后建乐观字段对应的 REST', async () => {
  let resolveFirst!: (value: { fields: import('../src').Field[]; total: number }) => void
  const firstResponse = new Promise<{ fields: import('../src').Field[]; total: number }>(resolve => {
    resolveFirst = resolve
  })
  let callCount = 0

  const store = createTestStore(
    createTableService(),
    createFieldService({
      getFields: async () => {
        callCount += 1
        if (callCount === 1) {
          return firstResponse
        }
        return {
          fields: [makeField('f1', 0), makeField('f2', 1), makeField('f-a', 2), makeField('f-b', 3)],
          total: 4,
        }
      },
    }),
  )
  selectTableT1(store)

  store.getState().upsertFieldLocal('t1', makeField('f-a', 2))
  const load1 = store.getState().loadFields('t1')

  // 第一个请求仍在飞时再建字段并触发第二次 refresh
  await Promise.resolve()
  store.getState().upsertFieldLocal('t1', makeField('f-b', 3))
  const load2 = store.getState().loadFields('t1')

  resolveFirst({
    fields: [makeField('f1', 0), makeField('f2', 1), makeField('f-a', 2)],
    total: 3,
  })

  await Promise.all([load1, load2])

  assert.ok(callCount >= 2, `expected coalesce reload, got callCount=${callCount}`)
  assert.deepEqual(store.getState().fields.map(f => f.id), ['f1', 'f2', 'f-a', 'f-b'])
  assert.deepEqual(store.getState().pendingOptimisticFieldIds, [])
})

test('table-store: createTable 失败时写入 error 并重新抛出', async () => {
  const quotaError = new Error('ENTITLEMENT_TABLE_LIMIT_EXCEEDED: 当前套餐表格额度已用完')
  const store = createTestStore(
    createTableService({
      createTable: async () => {
        throw quotaError
      },
    }),
  )

  await assert.rejects(
    () => store.getState().createTable({
      organization_id: 'org-1',
      name: '超限表',
    }),
    (error: unknown) => error === quotaError,
  )

  const state = store.getState()
  assert.equal(state.isLoading, false)
  assert.match(state.error ?? '', /ENTITLEMENT_TABLE_LIMIT_EXCEEDED/)
  assert.equal(state.tables.length, 0)
})

test('table-store: createTableInSpace 失败时写入 error 并重新抛出', async () => {
  const quotaError = new Error('ENTITLEMENT_TABLE_LIMIT_EXCEEDED: QuotaExceededError')
  const store = createTestStore(
    createTableService({
      createTableInSpace: async () => {
        throw quotaError
      },
    }),
  )

  await assert.rejects(
    () => store.getState().createTableInSpace('org-1', 'space-1', { name: '超限表' }),
    (error: unknown) => error === quotaError,
  )

  const state = store.getState()
  assert.equal(state.isLoading, false)
  assert.match(state.error ?? '', /ENTITLEMENT_TABLE_LIMIT_EXCEEDED/)
})

test('table-store: 其他表详情成功不得清掉当前表的权限错误', async () => {
  const permissionError = Object.assign(new Error('permission denied'), {
    code: 'PERMISSION_DENIED',
    status: 403,
  })
  const store = createTestStore(
    createTableService({
      getTable: async (tableId) => {
        if (tableId === 'denied-table') throw permissionError
        return {
          id: tableId,
          space_id: 'space-1',
          name: 'available table',
          created_by_id: 'user-1',
          row_count: 0,
          field_count: 0,
          is_archived: false,
          created_at: '2026-01-01T00:00:00Z',
          updated_at: '2026-01-01T00:00:00Z',
        }
      },
    }),
  )

  await store.getState().getTable('denied-table')
  await store.getState().getTable('available-table')

  const state = store.getState()
  assert.deepEqual(state.tableDetailLoadErrors['denied-table'], {
    message: 'permission denied',
    code: 'PERMISSION_DENIED',
    status: 403,
  })
  assert.equal(state.tableDetailLoadErrors['available-table'], undefined)
})

test('table-store: 同一张表重试成功会清掉旧详情错误', async () => {
  let attempt = 0
  const store = createTestStore(
    createTableService({
      getTable: async (tableId) => {
        attempt += 1
        if (attempt === 1) {
          throw Object.assign(new Error('permission denied'), {
            code: 'PERMISSION_DENIED',
            status: 403,
          })
        }
        return {
          id: tableId,
          space_id: 'space-1',
          name: 'available table',
          created_by_id: 'user-1',
          row_count: 0,
          field_count: 0,
          is_archived: false,
          created_at: '2026-01-01T00:00:00Z',
          updated_at: '2026-01-01T00:00:00Z',
        }
      },
    }),
  )

  await store.getState().getTable('retried-table')
  assert.equal(store.getState().tableDetailLoadErrors['retried-table']?.code, 'PERMISSION_DENIED')

  await store.getState().getTable('retried-table')
  assert.equal(store.getState().tableDetailLoadErrors['retried-table'], undefined)
})

test('table-store: clearAll 会重置核心状态', () => {
  const store = createTestStore()
  store.setState({
    tables: [
      {
        id: 't1',
        space_id: 'p1',
        name: 'demo',
        created_by_id: 'user-1',
        row_count: 1,
        field_count: 1,
        is_archived: false,
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
      },
    ],
    selectedTable: {
      id: 't1',
      space_id: 'p1',
      name: 'demo',
      created_by_id: 'user-1',
      row_count: 1,
      field_count: 1,
      is_archived: false,
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
    },
    searchQuery: 'abc',
    isLoading: true,
    error: 'err',
    tableDetailLoadErrors: {
      t1: {
        message: 'permission denied',
        code: 'PERMISSION_DENIED',
        status: 403,
      },
    },
  })

  store.getState().clearAll()
  const state = store.getState()

  assert.deepEqual(state.tables, [])
  assert.equal(state.selectedTable, null)
  assert.deepEqual(state.fields, [])
  assert.deepEqual(state.pendingOptimisticFieldIds, [])
  assert.equal(state.tableStats, null)
  assert.equal(state.searchQuery, '')
  assert.equal(state.isLoading, false)
  assert.equal(state.error, null)
  assert.deepEqual(state.tableDetailLoadErrors, {})
})
