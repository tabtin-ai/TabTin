import assert from 'node:assert/strict'
import test from 'node:test'
import { createStore } from 'zustand/vanilla'
import {
  createRecordStoreState,
  createRecordStorePersistOptions,
  type RecordStore,
  type RecordStoreViewState,
  type RecordStoreService,
  type RecordStoreDeps,
  type TableRecord,
  type BulkUpdateRecordsRequest,
  VERSION_TOKEN_BASE_DEFAULT,
} from '../src'

const silentLogger = {
  log: () => {},
  warn: () => {},
  error: () => {},
}

const stubRecordService: RecordStoreService = {
  getRecordsByTable: async () => ({
    status: 200,
    data: { records: [], total: 0, page: 1, page_size: 100 },
  }),
  getRecord: async () => {
    throw new Error('not implemented')
  },
  createRecord: async () => {
    throw new Error('not implemented')
  },
  deleteRecord: async () => {},
  bulkCreateRecords: async () => ({ success_count: 0, errors: [] }),
  bulkUpdateRecords: async () => ({ success_count: 0, errors: [] }),
  bulkDeleteRecords: async () => ({ success_count: 0, errors: [] }),
}

function createTestStore(
  initialRecords: TableRecord[] = [],
  total?: number
) {
  const deps: RecordStoreDeps = {
    recordService: stubRecordService,
    logger: silentLogger,
  }
  const store = createStore<RecordStore>()(createRecordStoreState(deps))
  if (initialRecords.length > 0) {
    store.setState({
      records: initialRecords,
      recordsMap: new Map(initialRecords.map(r => [r.id, r])),
      recordIds: initialRecords.map(r => r.id),
      total: total ?? initialRecords.length,
    })
  }
  return store
}

function makeRecord(
  id: string,
  data: Record<string, unknown> = {},
  order = 1,
  version = 1
): TableRecord {
  return {
    id,
    table_id: 'table-1',
    created_by_id: 'user-1',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    data,
    order,
    version,
  }
}

// ── mergeIncrementalRecords ──
// mergeIncrementalRecords uses queueMicrotask batching, so we must
// await a microtask flush before asserting state changes.
const flushMicrotasks = () => new Promise<void>(resolve => queueMicrotask(resolve))

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

test('mergeIncrementalRecords: updates existing record data', async () => {
  const store = createTestStore([makeRecord('r1', { f1: 'old' })])

  store.getState().mergeIncrementalRecords(
    [makeRecord('r1', { f1: 'new' }, 1, 2)],
    2
  )
  await flushMicrotasks()

  const state = store.getState()
  assert.equal(state.records.length, 1)
  assert.equal((state.records[0].data as Record<string, unknown>).f1, 'new')
})

test('mergeIncrementalRecords: appends new records', async () => {
  const store = createTestStore([makeRecord('r1', { f1: 'a' })])

  store.getState().mergeIncrementalRecords(
    [makeRecord('r2', { f1: 'b' }, 2, 2)],
    2
  )
  await flushMicrotasks()

  const state = store.getState()
  assert.equal(state.records.length, 2)
  assert.equal(state.records[1].id, 'r2')
})

test('mergeIncrementalRecords: paginated snapshot keeps total stable and ignores off-page records', async () => {
  const store = createTestStore([makeRecord('r1', { f1: 'a' }), makeRecord('r2', { f1: 'b' })], 10)
  store.setState({ page: 1, pageSize: 2 })

  store.getState().mergeIncrementalRecords(
    [makeRecord('r9', { f1: 'updated elsewhere' }, 9, 2)],
    2
  )
  await flushMicrotasks()

  const state = store.getState()
  assert.equal(state.records.length, 2)
  assert.ok(!state.records.some(record => record.id === 'r9'))
  assert.equal(state.total, 10)
})

test('mergeRestoredRecords: inserts restored records without double-counting refreshed totals', () => {
  const store = createTestStore([makeRecord('r1', { f1: 'a' }), makeRecord('r2', { f1: 'b' })], 10)
  store.setState({ currentTableId: 'table-1', page: 1, pageSize: 2, matchedTotal: 10 })
  const validVersion = VERSION_TOKEN_BASE_DEFAULT + 11

  store.getState().mergeRestoredRecords('table-1', [makeRecord('r9', { f1: 'restored' }, 9, validVersion)])

  const state = store.getState()
  assert.equal(state.records.length, 3)
  assert.equal(state.records[2].id, 'r9')
  assert.equal(state.total, 10)
  assert.equal(state.matchedTotal, 10)
  assert.equal(state.latestVersion, validVersion)
})

test('mergeRestoredRecords: increments totals only when refresh fallback requests it', () => {
  const store = createTestStore([makeRecord('r1', { f1: 'a' }), makeRecord('r2', { f1: 'b' })], 10)
  store.setState({ currentTableId: 'table-1', page: 1, pageSize: 2, matchedTotal: 10 })

  store.getState().mergeRestoredRecords('table-1', [makeRecord('r9', { f1: 'restored' }, 9, 11)], {
    incrementTotal: true,
  })

  const state = store.getState()
  assert.equal(state.records.length, 3)
  assert.equal(state.total, 11)
  assert.equal(state.matchedTotal, 11)
})

test('mergeRestoredRecords: does not append off-page records while search is active', () => {
  const store = createTestStore([makeRecord('r1', { f1: 'a' }), makeRecord('r2', { f1: 'b' })], 10)
  store.setState({ currentTableId: 'table-1', page: 1, pageSize: 2, matchedTotal: 2, searchQuery: 'a' })

  store.getState().mergeRestoredRecords('table-1', [makeRecord('r9', { f1: 'restored' }, 9, 11)])

  const state = store.getState()
  assert.equal(state.records.length, 2)
  assert.ok(!state.records.some(record => record.id === 'r9'))
  assert.equal(state.total, 10)
  assert.equal(state.matchedTotal, 2)
})

test('mergeRestoredRecords: syncView false keeps current view records untouched', () => {
  let viewState: RecordStoreViewState = {
    currentViewRecords: {
      view: { id: 'view-1', name: 'Grid', view_type: 'grid', config: {} },
      records: [makeRecord('r1', { f1: 'a' }), makeRecord('r2', { f1: 'b' })],
      total: 2,
      page: 1,
      page_size: 100,
      metadata: {},
    },
  }
  const deps: RecordStoreDeps = {
    recordService: stubRecordService,
    logger: silentLogger,
    viewStore: {
      getState: () => viewState,
      setState: (partial) => {
        viewState = { ...viewState, ...(typeof partial === 'function' ? partial(viewState) : partial) }
      },
    },
  }
  const store = createStore<RecordStore>()(createRecordStoreState(deps))
  store.setState({
    currentTableId: 'table-1',
    records: [makeRecord('r1', { f1: 'a' }), makeRecord('r2', { f1: 'b' })],
    recordsMap: new Map([
      ['r1', makeRecord('r1', { f1: 'a' })],
      ['r2', makeRecord('r2', { f1: 'b' })],
    ]),
    recordIds: ['r1', 'r2'],
    total: 2,
    matchedTotal: 2,
  })

  store.getState().mergeRestoredRecords('table-1', [makeRecord('r9', { f1: 'restored' }, 9, 11)], {
    syncView: false,
  })

  assert.equal(store.getState().records.length, 3)
  const currentViewRecords = viewState.currentViewRecords
  assert.ok(currentViewRecords)
  assert.equal(currentViewRecords.records.length, 2)
  assert.ok(!currentViewRecords.records.some(record => record.id === 'r9'))
})

test('mergeIncrementalRecords: merges data fields (shallow)', async () => {
  const store = createTestStore([makeRecord('r1', { f1: 'keep', f2: 'old' })])

  store.getState().mergeIncrementalRecords(
    [makeRecord('r1', { f2: 'updated' }, 1, 2)],
    2
  )
  await flushMicrotasks()

  const data = store.getState().records[0].data as Record<string, unknown>
  assert.equal(data.f1, 'keep')
  assert.equal(data.f2, 'updated')
})

test('mergeIncrementalRecords: preserves non-zero order when incoming order is 0', async () => {
  const store = createTestStore([makeRecord('r1', { f1: 'a' }, 5)])

  store.getState().mergeIncrementalRecords(
    [makeRecord('r1', { f1: 'b' }, 0, 2)],
    2
  )
  await flushMicrotasks()

  assert.equal(store.getState().records[0].order, 5)
})

test('mergeIncrementalRecords: updates latestVersion with valid monotonic token', async () => {
  const store = createTestStore([makeRecord('r1', {})])

  const validVersion = VERSION_TOKEN_BASE_DEFAULT + 10
  store.getState().mergeIncrementalRecords(
    [makeRecord('r1', { f1: 'v' }, 1, validVersion)],
    validVersion
  )
  await flushMicrotasks()

  assert.equal(store.getState().latestVersion, validVersion)
})

test('mergeIncrementalRecords: handles empty incoming array', async () => {
  const store = createTestStore([makeRecord('r1', { f1: 'a' })])

  store.getState().mergeIncrementalRecords([], 5)
  await flushMicrotasks()

  assert.equal(store.getState().records.length, 1)
})

test('mergeIncrementalRecords: handles multiple updates + new in one call', async () => {
  const store = createTestStore([
    makeRecord('r1', { f1: 'a' }),
    makeRecord('r2', { f1: 'b' }),
  ])

  store.getState().mergeIncrementalRecords(
    [
      makeRecord('r1', { f1: 'A' }, 1, 3),
      makeRecord('r3', { f1: 'c' }, 3, 3),
    ],
    3
  )
  await flushMicrotasks()

  const state = store.getState()
  assert.equal(state.records.length, 3)
  assert.equal((state.records[0].data as Record<string, unknown>).f1, 'A')
  assert.equal(state.records[2].id, 'r3')
})

test('mergeIncrementalRecords: batches multiple rapid calls into one state update', async () => {
  const store = createTestStore([makeRecord('r1', { f1: 'a' })])
  let updateCount = 0
  store.subscribe(() => { updateCount++ })

  store.getState().mergeIncrementalRecords([makeRecord('r2', { f1: 'b' }, 2, 2)], 2)
  store.getState().mergeIncrementalRecords([makeRecord('r3', { f1: 'c' }, 3, 3)], 3)
  store.getState().mergeIncrementalRecords([makeRecord('r4', { f1: 'd' }, 4, 4)], 4)
  await flushMicrotasks()

  const state = store.getState()
  assert.equal(state.records.length, 4)
  assert.equal(updateCount, 1, 'should batch into a single state update')
})

// ── updateRecord ──

test('updateRecord: serializes rapid same-cell saves and uses confirmed base snapshot', async () => {
  const firstRequest = deferred<void>()
  const requests: BulkUpdateRecordsRequest[] = []
  const service: RecordStoreService = {
    ...stubRecordService,
    bulkUpdateRecords: async (data) => {
      requests.push(data)
      if (requests.length === 1) {
        await firstRequest.promise
      }
      const value = data.updates[0]?.data?.f1
      return {
        success_count: 1,
        errors: [],
        records: [makeRecord('r1', { f1: value }, 1, VERSION_TOKEN_BASE_DEFAULT + requests.length)],
      }
    },
  }
  const store = createStore<RecordStore>()(createRecordStoreState({
    recordService: service,
    logger: silentLogger,
  }))
  store.setState({
    records: [makeRecord('r1', { f1: 'old' })],
    recordsMap: new Map([['r1', makeRecord('r1', { f1: 'old' })]]),
    recordIds: ['r1'],
    total: 1,
  })

  const firstSave = store.getState().updateRecord('r1', { data: { f1: 'A' } })
  await flushMicrotasks()
  const secondSave = store.getState().updateRecord('r1', { data: { f1: 'B' } })
  const thirdSave = store.getState().updateRecord('r1', { data: { f1: 'C' } })

  assert.equal(requests.length, 1)
  assert.deepEqual(requests[0]?.updates[0]?.base_snapshot, { f1: 'old' })

  firstRequest.resolve()
  const [firstResult, secondResult, thirdResult] = await Promise.all([firstSave, secondSave, thirdSave])

  assert.equal(requests.length, 2)
  assert.equal(requests[1]?.updates[0]?.data?.f1, 'C')
  assert.deepEqual(requests[1]?.updates[0]?.base_snapshot, { f1: 'A' })
  assert.equal((firstResult?.data as Record<string, unknown>).f1, 'C')
  assert.equal((secondResult?.data as Record<string, unknown>).f1, 'C')
  assert.equal((thirdResult?.data as Record<string, unknown>).f1, 'C')
  assert.equal((store.getState().records[0].data as Record<string, unknown>).f1, 'C')
})

// ── removeRecordsByIds ──

test('removeRecordsByIds: removes specified records', () => {
  const store = createTestStore([
    makeRecord('r1', { f1: 'a' }),
    makeRecord('r2', { f1: 'b' }),
    makeRecord('r3', { f1: 'c' }),
  ])

  store.getState().removeRecordsByIds(['r2'])

  const state = store.getState()
  assert.equal(state.records.length, 2)
  assert.ok(!state.records.some((r: TableRecord) => r.id === 'r2'))
})

test('bulkDeleteRecords: does not log success when a chunk fails', async () => {
  const logs: string[] = []
  const service: RecordStoreService = {
    ...stubRecordService,
    bulkDeleteRecords: async () => ({
      success_count: 0,
      errors: ['操作失败，请稍后重试'],
    }),
  }
  const store = createStore<RecordStore>()(createRecordStoreState({
    recordService: service,
    logger: {
      log: (message: string) => logs.push(message),
      warn: () => {},
      error: () => {},
    },
  }))

  const result = await store.getState().bulkDeleteRecords(['r1'])

  assert.equal(result.ok, false)
  assert.equal(logs.some(message => message.includes('批量删除记录成功')), false)
})

test('removeRecordsByIds: updates total correctly', () => {
  const store = createTestStore(
    [makeRecord('r1', {}), makeRecord('r2', {}), makeRecord('r3', {})],
    10
  )

  store.getState().removeRecordsByIds(['r1', 'r2'])

  assert.equal(store.getState().total, 8)
})

test('removeRecordsByIds: decrements total for deleted off-page records', () => {
  const store = createTestStore([makeRecord('r1', {}), makeRecord('r2', {})], 10)
  store.setState({ page: 1, pageSize: 2 })

  store.getState().removeRecordsByIds(['r9'])

  const state = store.getState()
  assert.equal(state.records.length, 2)
  assert.equal(state.total, 9)
})

test('removeRecordsByIds: does nothing for empty array', () => {
  const store = createTestStore([makeRecord('r1', {})])

  store.getState().removeRecordsByIds([])

  assert.equal(store.getState().records.length, 1)
})

test('removeRecordsByIds: handles non-existent ids gracefully', () => {
  const store = createTestStore([makeRecord('r1', { f1: 'a' })])

  store.getState().removeRecordsByIds(['r_nonexistent'])

  assert.equal(store.getState().records.length, 1)
})

test('removeRecordsByIds: clears selectedRecord if it was removed', () => {
  const record = makeRecord('r1', { f1: 'a' })
  const store = createTestStore([record, makeRecord('r2', {})])
  store.setState({ selectedRecord: record })

  store.getState().removeRecordsByIds(['r1'])

  assert.equal(store.getState().selectedRecord, null)
})

test('removeRecordsByIds: keeps selectedRecord if it was not removed', () => {
  const r2 = makeRecord('r2', { f1: 'b' })
  const store = createTestStore([makeRecord('r1', {}), r2])
  store.setState({ selectedRecord: r2 })

  store.getState().removeRecordsByIds(['r1'])

  assert.equal(store.getState().selectedRecord?.id, 'r2')
})

test('persist: ignores old pageSize after table pagination removal', () => {
  const store = createTestStore()
  const persistOptions = createRecordStorePersistOptions()
  const merged = persistOptions.merge(
    { pageSize: 50, sortBy: 'name', sortOrder: 'asc' },
    store.getState()
  ) as RecordStore

  assert.equal(merged.pageSize, store.getState().pageSize)
  assert.equal(merged.sortBy, 'name')
  assert.equal(merged.sortOrder, 'asc')
})

test('removeRecordsByIds: total does not go below zero', () => {
  const store = createTestStore([makeRecord('r1', {})], 1)

  store.getState().removeRecordsByIds(['r1', 'r_extra'])

  assert.ok(store.getState().total >= 0)
})
