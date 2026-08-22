import assert from 'node:assert/strict'
import test from 'node:test'
import { createStore } from 'zustand/vanilla'
import {
  clearTreeLoadedCache,
  createViewStoreState,
  type ViewStore,
  type ViewStoreDeps,
  type ViewStoreService,
  type ViewMeta,
  type ViewRecordsResponse,
} from '../src'
import { structuralShareViewRecords } from '../src/domain/view-store'

// Must use valid UUIDs — view-store validates tableId format before loading.
const TABLE_ID = '11111111-1111-1111-8111-111111111111'
const VIEW_ID_A = '22222222-2222-2222-8222-222222222222'
const VIEW_ID_B = '33333333-3333-3333-8333-333333333333'
const VIEW_ID_C = '44444444-4444-4444-8444-444444444444'

const VIEW_A: ViewMeta = {
  id: VIEW_ID_A,
  table_id: TABLE_ID,
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
  visible_fields: ['f1', 'f2'],
  field_order: ['f1', 'f2'],
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
}

const VIEW_B: ViewMeta = {
  ...VIEW_A,
  id: VIEW_ID_B,
  name: 'Kanban',
  view_type: 'kanban',
  is_default: false,
  order: 1,
  config: { group_by_field: 'f1' },
}

const VIEW_C: ViewMeta = {
  ...VIEW_A,
  id: VIEW_ID_C,
  name: 'Calendar',
  view_type: 'calendar',
  is_default: false,
  order: 2,
  config: { date_field: 'f1', title_field: 'f2' },
}

const MOCK_VIEW_RECORDS_RESPONSE = {
  status: 200,
  data: {
    view: { id: VIEW_ID_A, name: 'Grid', view_type: 'grid' as const, config: {} },
    records: [],
    total: 0,
    page: 1,
    page_size: 100,
    metadata: {},
  },
}

const createViewService = (
  overrides: Partial<ViewStoreService> = {}
): ViewStoreService => ({
  getViewsByTable: async () => ({ views: [VIEW_A, VIEW_B], total: 2 }),
  createView: async (payload) => ({
    ...VIEW_A,
    id: '44444444-4444-4444-8444-444444444444',
    name: payload.name,
    view_type: payload.view_type ?? 'grid',
  }),
  updateView: async (viewId, payload) => {
    const base = viewId === VIEW_ID_A ? VIEW_A : VIEW_B
    return { ...base, ...payload } as ViewMeta
  },
  deleteView: async () => undefined,
  setDefaultView: async () => undefined,
  reorderViews: async () => undefined,
  validateViewConfig: async () => ({
    is_valid: true,
    errors: [],
    warnings: [],
    suggestions: {},
  }),
  getViewRecords: async () => MOCK_VIEW_RECORDS_RESPONSE,
  ...overrides,
})

const createTestStore = (
  service?: ViewStoreService,
  deps?: Pick<ViewStoreDeps, 'getCurrentUserId'>,
) =>
  createStore<ViewStore>()(
    createViewStoreState({
      viewService: service ?? createViewService(),
      ...deps,
    })
  )

const createMemoryStorage = () => {
  const values = new Map<string, string>()
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
    clear: () => values.clear(),
    keys: () => [...values.keys()],
  }
}

const recordFixture = (
  id: string,
  order: number,
): ViewRecordsResponse['records'][number] => ({
  id,
  table_id: TABLE_ID,
  created_by_id: 'user-1',
  data: { Name: id },
  order,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
})

test('view-store: setPageSize preserves existing query conditions and resets to page 1', async () => {
  let capturedQuery: Record<string, unknown> | undefined
  const store = createTestStore(
    createViewService({
      getViewRecords: async (_viewId, query) => {
        capturedQuery = query as Record<string, unknown> | undefined
        return {
          status: 200,
          data: {
            ...MOCK_VIEW_RECORDS_RESPONSE.data,
            page: query?.page ?? 1,
            page_size: query?.page_size ?? 100,
          },
        }
      },
    })
  )

  store.setState({
    currentViewId: VIEW_ID_A,
    recordsQuery: {
      page: 3,
      page_size: 100,
      search: 'hello',
      search_field_ids: ['field-1'],
      search_hide_not_match_rows: true,
    },
  })

  await store.getState().setPageSize(200)

  assert.equal(capturedQuery?.page, 1)
  assert.equal(capturedQuery?.page_size, 200)
  assert.equal(capturedQuery?.search, 'hello')
  assert.deepEqual(capturedQuery?.search_field_ids, ['field-1'])
  assert.equal(capturedQuery?.search_hide_not_match_rows, true)

  assert.equal(store.getState().recordsQuery.page, 1)
  assert.equal(store.getState().recordsQuery.page_size, 200)
  assert.equal(store.getState().recordsQuery.search, 'hello')
  assert.deepEqual(store.getState().recordsQuery.search_field_ids, ['field-1'])
  assert.equal(store.getState().recordsQuery.search_hide_not_match_rows, true)
})

test('view-store: initialize loads views and selects first ordered view', async () => {
  const store = createTestStore()
  await store.getState().initialize(TABLE_ID)

  const state = store.getState()
  assert.equal(state.tableId, TABLE_ID)
  assert.equal(state.views.length, 2)
  assert.equal(state.currentViewId, VIEW_ID_A)
})

test('view-store: reinitialize keeps the rendered view and records during refresh', async () => {
  let resolveViews!: (value: { views: ViewMeta[]; total: number }) => void
  const store = createTestStore(
    createViewService({
      getViewsByTable: async () => await new Promise(resolve => {
        resolveViews = resolve
      }),
    }),
  )

  const cachedRecords: ViewRecordsResponse = {
    view: { id: VIEW_ID_A, name: VIEW_A.name, view_type: 'grid', config: {} },
    records: [recordFixture('cached-row', 0)],
    total: 1,
    page: 1,
    page_size: 100,
    metadata: {},
  }
  store.setState({
    tableId: TABLE_ID,
    views: [VIEW_A],
    currentViewId: VIEW_ID_A,
    currentViewRecords: cachedRecords,
  })

  const refresh = store.getState().initialize(TABLE_ID, { defaultViewId: VIEW_ID_A })

  assert.equal(store.getState().currentViewId, VIEW_ID_A)
  assert.equal(store.getState().currentViewRecords?.records[0]?.id, 'cached-row')
  assert.equal(store.getState().isLoading, true)

  resolveViews({ views: [VIEW_A, VIEW_B], total: 2 })
  await refresh
  assert.equal(store.getState().currentViewId, VIEW_ID_A)
})

test('view-store: initialize restores collapsed groups for the selected view', async () => {
  const storage = createMemoryStorage()
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: storage,
  })
  clearTreeLoadedCache()

  const firstStore = createTestStore(undefined, { getCurrentUserId: () => 'user-1' })
  await firstStore.getState().initialize(TABLE_ID)
  firstStore.getState().toggleGroupCollapse(VIEW_ID_A, 'status:todo')

  clearTreeLoadedCache()
  const reopenedStore = createTestStore(undefined, { getCurrentUserId: () => 'user-1' })
  await reopenedStore.getState().initialize(TABLE_ID)

  assert.deepEqual(reopenedStore.getState().collapsedGroups[VIEW_ID_A], ['status:todo'])
})

test('view-store: reinitialize restores collapsed groups after resetting in-memory state', async () => {
  const storage = createMemoryStorage()
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: storage,
  })
  clearTreeLoadedCache()

  const store = createTestStore(undefined, { getCurrentUserId: () => 'user-1' })
  await store.getState().initialize(TABLE_ID)
  store.getState().toggleGroupCollapse(VIEW_ID_A, 'status:todo')

  await store.getState().initialize(TABLE_ID)

  assert.deepEqual(store.getState().collapsedGroups[VIEW_ID_A], ['status:todo'])
})

test('view-store: collapsed groups are isolated by current user', async () => {
  const storage = createMemoryStorage()
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: storage,
  })
  clearTreeLoadedCache()

  const firstUserStore = createTestStore(undefined, { getCurrentUserId: () => 'user-1' })
  await firstUserStore.getState().initialize(TABLE_ID)
  firstUserStore.getState().toggleGroupCollapse(VIEW_ID_A, 'status:todo')

  clearTreeLoadedCache()
  const secondUserStore = createTestStore(undefined, { getCurrentUserId: () => 'user-2' })
  await secondUserStore.getState().initialize(TABLE_ID)

  assert.deepEqual(secondUserStore.getState().collapsedGroups[VIEW_ID_A], [])
})

test('view-store: changed grouping options discard only that view collapsed state', async () => {
  const storage = createMemoryStorage()
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: storage,
  })
  clearTreeLoadedCache()

  const statusGroupedView: ViewMeta = {
    ...VIEW_A,
    groups: [{ field_id: 'status', direction: 'asc' }],
  }
  const firstStore = createTestStore(
    createViewService({
      getViewsByTable: async () => ({ views: [statusGroupedView, VIEW_B], total: 2 }),
    }),
    { getCurrentUserId: () => 'user-1' },
  )
  await firstStore.getState().initialize(TABLE_ID)
  firstStore.getState().toggleGroupCollapse(VIEW_ID_A, 'status:todo')
  firstStore.getState().toggleGroupCollapse(VIEW_ID_B, 'priority:high')

  clearTreeLoadedCache()
  const assigneeGroupedView: ViewMeta = {
    ...statusGroupedView,
    groups: [{ field_id: 'assignee', direction: 'asc' }],
  }
  const reopenedStore = createTestStore(
    createViewService({
      getViewsByTable: async () => ({ views: [assigneeGroupedView, VIEW_B], total: 2 }),
    }),
    { getCurrentUserId: () => 'user-1' },
  )
  await reopenedStore.getState().initialize(TABLE_ID)

  assert.deepEqual(reopenedStore.getState().collapsedGroups[VIEW_ID_A], [])
  reopenedStore.setState({ currentViewId: VIEW_ID_A })
  await reopenedStore.getState().selectView(VIEW_ID_B)
  assert.deepEqual(reopenedStore.getState().collapsedGroups[VIEW_ID_B], ['priority:high'])
})

test('view-store: editing grouping options immediately discards collapsed state', async () => {
  const storage = createMemoryStorage()
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: storage,
  })
  clearTreeLoadedCache()

  const statusGroupedView: ViewMeta = {
    ...VIEW_A,
    groups: [{ field_id: 'status', direction: 'asc' }],
  }
  const store = createTestStore(
    createViewService({
      getViewsByTable: async () => ({ views: [statusGroupedView], total: 1 }),
    }),
    { getCurrentUserId: () => 'user-1' },
  )
  await store.getState().initialize(TABLE_ID)
  store.getState().toggleGroupCollapse(VIEW_ID_A, 'status:todo')

  store.getState().setDraftGroups(VIEW_ID_A, [{ field_id: 'status', direction: 'asc' }])
  assert.deepEqual(store.getState().collapsedGroups[VIEW_ID_A], ['status:todo'])
  assert.equal(storage.keys().length, 1)

  store.getState().setDraftGroups(VIEW_ID_A, [{ field_id: 'assignee', direction: 'asc' }])
  assert.deepEqual(store.getState().collapsedGroups[VIEW_ID_A], [])
  assert.deepEqual(storage.keys(), [])
})

test('view-store: malformed collapsed state is discarded without breaking initialization', async () => {
  const storage = createMemoryStorage()
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: storage,
  })
  clearTreeLoadedCache()

  const firstStore = createTestStore(undefined, { getCurrentUserId: () => 'user-1' })
  await firstStore.getState().initialize(TABLE_ID)
  firstStore.getState().toggleGroupCollapse(VIEW_ID_A, 'status:todo')
  const persistedKey = storage.keys()[0]
  assert.ok(persistedKey)
  storage.setItem(persistedKey, '{not-valid-json')

  clearTreeLoadedCache()
  const reopenedStore = createTestStore(undefined, { getCurrentUserId: () => 'user-1' })
  await assert.doesNotReject(() => reopenedStore.getState().initialize(TABLE_ID))
  assert.deepEqual(reopenedStore.getState().collapsedGroups[VIEW_ID_A], [])
  assert.deepEqual(storage.keys(), [])
})

test('view-store: loadViews logs a sanitized grouping summary for the current view', async () => {
  const debugCalls: unknown[][] = []
  const store = createStore<ViewStore>()(
    createViewStoreState({
      viewService: createViewService(),
      logger: {
        log: () => undefined,
        warn: () => undefined,
        error: () => undefined,
        debug: (...args: unknown[]) => debugCalls.push(args),
      },
    }),
  )

  await store.getState().loadViews(TABLE_ID, { resetToViewId: VIEW_ID_B })

  const committedLog = debugCalls.find(
    ([message]) => message === '[ViewStore] loadViews committed currentViewId',
  )
  assert.deepEqual(committedLog?.[1], {
    tableId: TABLE_ID,
    requestSeq: 1,
    currentViewId: VIEW_ID_B,
    viewCount: 2,
    viewType: 'kanban',
    groupCount: 0,
    hasGroupByField: true,
  })
  assert.equal(JSON.stringify(committedLog).includes('f1'), false)
})

test('view-store: initialize throws when loadViews fails', async () => {
  const store = createTestStore(
    createViewService({
      getViewsByTable: async () => {
        throw new Error('network down')
      },
    }),
  )

  await assert.rejects(
    () => store.getState().initialize(TABLE_ID),
    (error: unknown) => error instanceof Error && error.message === 'network down',
  )
  assert.equal(store.getState().currentViewId, null)
  assert.equal(store.getState().isLoading, false)
})

test('view-store: initialize throws when table has no views', async () => {
  const store = createTestStore(
    createViewService({
      getViewsByTable: async () => ({ views: [], total: 0 }),
    }),
  )

  await assert.rejects(
    () => store.getState().initialize(TABLE_ID),
    (error: unknown) => error instanceof Error && /没有可用视图|no view/i.test(error.message),
  )
  assert.equal(store.getState().currentViewId, null)
})

test('view-store: supersede 后若同表已有 currentViewId，旧 initialize 可视为成功', async () => {
  type ViewsResponse = { views: ViewMeta[]; total: number }
  const pendingResolvers: Array<(value: ViewsResponse) => void> = []
  const store = createTestStore(
    createViewService({
      getViewsByTable: async () =>
        await new Promise<ViewsResponse>(resolve => {
          pendingResolvers.push(resolve)
        }),
    }),
  )

  const first = store.getState().initialize(TABLE_ID)
  assert.equal(pendingResolvers.length, 1)

  const second = store.getState().initialize(TABLE_ID)
  assert.equal(pendingResolvers.length, 2)

  pendingResolvers[1]({ views: [VIEW_A, VIEW_B], total: 2 })
  await second
  assert.equal(store.getState().currentViewId, VIEW_ID_A)

  pendingResolvers[0]({ views: [VIEW_A, VIEW_B], total: 2 })
  // 后到的请求已写出 currentViewId → 旧调用不必抛错
  await first
  assert.equal(store.getState().tableId, TABLE_ID)
  assert.equal(store.getState().currentViewId, VIEW_ID_A)
})

test('view-store: superseded loadViews while still loading must not leave initialize as silent success', async () => {
  type ViewsResponse = { views: ViewMeta[]; total: number }
  let resolveFirst!: (value: ViewsResponse) => void
  let resolveSecond!: (value: ViewsResponse) => void
  let call = 0
  const store = createTestStore(
    createViewService({
      getViewsByTable: async () => {
        call += 1
        if (call === 1) {
          return await new Promise<ViewsResponse>(resolve => {
            resolveFirst = resolve
          })
        }
        return await new Promise<ViewsResponse>(resolve => {
          resolveSecond = resolve
        })
      },
    }),
  )

  const first = store.getState().initialize(TABLE_ID)
  const second = store.getState().initialize(TABLE_ID)

  // 第一次被 supersede 时第二次仍在 loading → 旧逻辑会静默 return
  resolveFirst({ views: [VIEW_A], total: 1 })
  await assert.rejects(
    () => first,
    (error: unknown) => error instanceof Error && /覆盖|superseded|获取视图列表失败/i.test(error.message),
  )
  assert.equal(store.getState().currentViewId, null)
  assert.equal(store.getState().isLoading, true)

  resolveSecond({ views: [VIEW_A, VIEW_B], total: 2 })
  await second
  assert.equal(store.getState().currentViewId, VIEW_ID_A)
  assert.equal(store.getState().isLoading, false)
})

test('view-store: initialize ignores legacy default view when no preferred view is provided', async () => {
  const store = createTestStore(
    createViewService({
      getViewsByTable: async () => ({
        views: [
          { ...VIEW_B, is_default: true, order: 1 },
          { ...VIEW_A, is_default: false, order: 0 },
        ],
        total: 2,
      }),
    })
  )

  await store.getState().initialize(TABLE_ID)

  assert.equal(store.getState().currentViewId, VIEW_ID_A)
})

test('view-store: selectView switches to a different view', async () => {
  const store = createTestStore()
  await store.getState().initialize(TABLE_ID)
  await store.getState().selectView(VIEW_ID_B)

  assert.equal(store.getState().currentViewId, VIEW_ID_B)
})

test('view-store: selectView current view does not refetch records', async () => {
  let getViewRecordsCalls = 0
  const store = createTestStore(
    createViewService({
      getViewRecords: async () => {
        getViewRecordsCalls += 1
        return MOCK_VIEW_RECORDS_RESPONSE
      },
    })
  )

  await store.getState().initialize(TABLE_ID)
  assert.equal(getViewRecordsCalls, 1)

  await store.getState().selectView(VIEW_ID_A)
  assert.equal(store.getState().currentViewId, VIEW_ID_A)
  assert.equal(getViewRecordsCalls, 1)
})

test('view-store: reset clears all state', async () => {
  const store = createTestStore()
  await store.getState().initialize(TABLE_ID)
  store.getState().reset()

  const state = store.getState()
  assert.equal(state.tableId, null)
  assert.deepEqual(state.views, [])
  assert.equal(state.currentViewId, null)
  assert.equal(state.currentViewRecords, null)
})

test('view-store: initializeDraft creates draft from current view filters', async () => {
  const filtersView: ViewMeta = {
    ...VIEW_A,
    filters: [{ id: 'flt1', field_id: 'f1', operator: 'eq', value: 'test', enabled: true }],
  }
  const store = createTestStore(
    createViewService({
      getViewsByTable: async () => ({ views: [filtersView], total: 1 }),
    })
  )
  await store.getState().initialize(TABLE_ID)
  store.getState().initializeDraft(VIEW_ID_A)

  const draft = store.getState().draftStates[VIEW_ID_A]
  assert.ok(draft)
  assert.equal(draft.filters.length, 1)
  assert.equal(draft.filters[0].field_id, 'f1')
  assert.equal(draft.isDirty, false)
})

test('view-store: setDraftFilters marks draft as dirty', async () => {
  const store = createTestStore()
  await store.getState().initialize(TABLE_ID)
  store.getState().initializeDraft(VIEW_ID_A)

  store.getState().setDraftFilters(VIEW_ID_A, [
    { id: 'flt2', field_id: 'f2', operator: 'contains', value: 'hello', enabled: true },
  ])

  const draft = store.getState().draftStates[VIEW_ID_A]
  assert.equal(draft.filters.length, 1)
  assert.equal(draft.isDirty, true)
})

test('view-store: createView calls service and refreshes view list', async () => {
  const calls: string[] = []
  const store = createTestStore(
    createViewService({
      createView: async (payload) => {
        calls.push(payload.name)
        return { ...VIEW_A, id: '55555555-5555-5555-8555-555555555555', name: payload.name }
      },
    })
  )
  await store.getState().initialize(TABLE_ID)

  const result = await store.getState().createView({ name: 'New View' })
  assert.ok(result)
  assert.equal(result!.name, 'New View')
  assert.deepEqual(calls, ['New View'])
})

test('view-store: createView exposes persisted view before refreshing list and records', async () => {
  const calls: string[] = []
  const createdView: ViewMeta = {
    ...VIEW_A,
    id: '55555555-5555-5555-8555-555555555555',
    name: 'New View',
  }
  const store = createTestStore(
    createViewService({
      createView: async () => {
        calls.push('post')
        return createdView
      },
      getViewsByTable: async () => {
        calls.push('refresh')
        return { views: [VIEW_A, createdView], total: 2 }
      },
    })
  )
  await store.getState().initialize(TABLE_ID)
  calls.length = 0

  await store.getState().createView(
    { name: createdView.name },
    {
      onPersistedBeforeRefresh: view => {
        assert.equal(view.id, createdView.id)
        calls.push('mirror')
      },
    },
  )

  assert.deepEqual(calls.slice(0, 3), ['post', 'mirror', 'refresh'])
})

test('view-store: loadViews preserves an optimistic view until REST confirms it', async () => {
  const pendingView: ViewMeta = {
    ...VIEW_A,
    id: VIEW_ID_C,
    name: 'Pending copied view',
    is_default: false,
    order: 2,
  }
  const store = createTestStore(
    createViewService({
      getViewsByTable: async () => ({ views: [VIEW_A, VIEW_B], total: 2 }),
    })
  )
  await store.getState().initialize(TABLE_ID)
  store.setState({
    views: [VIEW_A, VIEW_B, pendingView],
    pendingOptimisticViewIds: [pendingView.id],
    currentViewId: pendingView.id,
  })

  await store.getState().loadViews(TABLE_ID)

  assert.deepEqual(store.getState().views.map(view => view.id), [VIEW_ID_A, VIEW_ID_B, VIEW_ID_C])
  assert.equal(store.getState().currentViewId, VIEW_ID_C)
  assert.deepEqual(store.getState().pendingOptimisticViewIds, [VIEW_ID_C])
})

test('view-store: loadViews clears pending after REST confirms the optimistic view', async () => {
  const pendingView: ViewMeta = {
    ...VIEW_C,
    name: 'Pending copied view',
  }
  const confirmedView: ViewMeta = {
    ...pendingView,
    name: 'Confirmed copied view',
  }
  const store = createTestStore(
    createViewService({
      getViewsByTable: async () => ({ views: [VIEW_A, VIEW_B, confirmedView], total: 3 }),
    })
  )
  store.setState({
    tableId: TABLE_ID,
    views: [VIEW_A, VIEW_B, pendingView],
    pendingOptimisticViewIds: [pendingView.id],
    currentViewId: pendingView.id,
  })

  await store.getState().loadViews(TABLE_ID)

  assert.equal(store.getState().views.find(view => view.id === VIEW_ID_C)?.name, 'Confirmed copied view')
  assert.deepEqual(store.getState().pendingOptimisticViewIds, [])
})

test('view-store: loadViews still removes a non-pending view missing from REST', async () => {
  const store = createTestStore(
    createViewService({
      getViewsByTable: async () => ({ views: [VIEW_A, VIEW_B], total: 2 }),
    })
  )
  store.setState({
    tableId: TABLE_ID,
    views: [VIEW_A, VIEW_B, VIEW_C],
    pendingOptimisticViewIds: [],
    currentViewId: VIEW_C.id,
  })

  await store.getState().loadViews(TABLE_ID)

  assert.deepEqual(store.getState().views.map(view => view.id), [VIEW_ID_A, VIEW_ID_B])
  assert.equal(store.getState().currentViewId, VIEW_ID_A)
})

test('view-store: createView 会发送后端兼容筛选算子', async () => {
  let createFiltersSent: Array<{ operator?: string }> | undefined
  const store = createTestStore(
    createViewService({
      createView: async payload => {
        createFiltersSent = payload.filters as Array<{ operator?: string }> | undefined
        return {
          ...VIEW_A,
          id: '77777777-7777-7777-8777-777777777777',
          name: payload.name,
          view_type: payload.view_type ?? 'grid',
        }
      },
    })
  )
  await store.getState().initialize(TABLE_ID)

  await store.getState().createView({
    name: 'View With Filter',
    filters: [{ id: 'flt-create', field_id: 'f1', operator: 'has_any_of', value: ['A'], enabled: true }],
  })

  assert.equal(createFiltersSent?.[0]?.operator, 'contains')
})

test('view-store: updateView 会发送后端兼容筛选算子', async () => {
  let updateFiltersSent: Array<{ operator?: string }> | undefined
  const store = createTestStore(
    createViewService({
      updateView: async (viewId, payload) => {
        updateFiltersSent = payload.filters as Array<{ operator?: string }> | undefined
        const base = viewId === VIEW_ID_A ? VIEW_A : VIEW_B
        return { ...base, ...payload } as ViewMeta
      },
    })
  )
  await store.getState().initialize(TABLE_ID)

  await store.getState().updateView(
    VIEW_ID_A,
    {
      filters: [{ id: 'flt-update', field_id: 'f1', operator: 'is_none_of', value: ['A'], enabled: true }],
    },
    { silent: true, refreshRecords: false }
  )

  assert.equal(updateFiltersSent?.[0]?.operator, 'not_in')
})

test('view-store: 纯 column_meta patch 优先走独立接口', async () => {
  let updateViewCalls = 0
  let updateViewColumnMetaCalls = 0
  let columnMetaSent: Record<string, unknown> | undefined

  const store = createTestStore(
    createViewService({
      updateView: async (viewId, payload) => {
        updateViewCalls += 1
        const base = viewId === VIEW_ID_A ? VIEW_A : VIEW_B
        return { ...base, ...payload } as ViewMeta
      },
      updateViewColumnMeta: async (viewId, payload) => {
        updateViewColumnMetaCalls += 1
        columnMetaSent = (payload.column_meta ?? payload.columnMeta) as Record<string, unknown> | undefined
        const base = viewId === VIEW_ID_A ? VIEW_A : VIEW_B
        return {
          ...base,
          column_meta: payload.column_meta,
          columnMeta: payload.columnMeta,
        } as ViewMeta
      },
    })
  )

  await store.getState().initialize(TABLE_ID)
  await store.getState().updateView(
    VIEW_ID_A,
    {
      column_meta: {
        f1: { width: 240 },
      },
    },
    { silent: true, refreshRecords: false }
  )

  assert.equal(updateViewCalls, 0)
  assert.equal(updateViewColumnMetaCalls, 1)
  assert.deepEqual(columnMetaSent, { f1: { width: 240 } })
})

test('view-store: column_meta + 兼容显示字段 patch 仍走独立接口', async () => {
  let updateViewCalls = 0
  let updateViewColumnMetaCalls = 0
  let columnMetaSent: Record<string, unknown> | undefined

  const store = createTestStore(
    createViewService({
      updateView: async (viewId, payload) => {
        updateViewCalls += 1
        const base = viewId === VIEW_ID_A ? VIEW_A : VIEW_B
        return { ...base, ...payload } as ViewMeta
      },
      updateViewColumnMeta: async (viewId, payload) => {
        updateViewColumnMetaCalls += 1
        columnMetaSent = (payload.column_meta ?? payload.columnMeta) as Record<string, unknown> | undefined
        const base = viewId === VIEW_ID_A ? VIEW_A : VIEW_B
        return {
          ...base,
          column_meta: payload.column_meta,
          columnMeta: payload.columnMeta,
        } as ViewMeta
      },
    })
  )

  await store.getState().initialize(TABLE_ID)
  await store.getState().updateView(
    VIEW_ID_A,
    {
      visible_fields: ['f1'],
      field_order: ['f1', 'f2'],
      column_meta: {
        f1: { order: 0 },
        f2: { order: 1, hidden: true },
      },
    },
    { silent: true, refreshRecords: false }
  )

  assert.equal(updateViewCalls, 0)
  assert.equal(updateViewColumnMetaCalls, 1)
  assert.deepEqual(columnMetaSent, {
    f1: { order: 0 },
    f2: { order: 1, hidden: true },
  })
})

test('view-store: 仅兼容显示字段 patch 仍走 updateView', async () => {
  let updateViewCalls = 0
  let updateViewColumnMetaCalls = 0

  const store = createTestStore(
    createViewService({
      updateView: async (viewId, payload) => {
        updateViewCalls += 1
        const base = viewId === VIEW_ID_A ? VIEW_A : VIEW_B
        return { ...base, ...payload } as ViewMeta
      },
      updateViewColumnMeta: async (viewId, payload) => {
        updateViewColumnMetaCalls += 1
        const base = viewId === VIEW_ID_A ? VIEW_A : VIEW_B
        return {
          ...base,
          column_meta: payload.column_meta,
          columnMeta: payload.columnMeta,
        } as ViewMeta
      },
    })
  )

  await store.getState().initialize(TABLE_ID)
  await store.getState().updateView(
    VIEW_ID_A,
    {
      visible_fields: ['f1'],
      field_order: ['f1', 'f2'],
    },
    { silent: true, refreshRecords: false }
  )

  assert.equal(updateViewCalls, 1)
  assert.equal(updateViewColumnMetaCalls, 0)
})

test('view-store: legacy columnMeta patch 不再走独立接口', async () => {
  let updateViewCalls = 0
  let updateViewColumnMetaCalls = 0

  const store = createTestStore(
    createViewService({
      updateView: async (viewId, payload) => {
        updateViewCalls += 1
        const base = viewId === VIEW_ID_A ? VIEW_A : VIEW_B
        return { ...base, ...payload } as ViewMeta
      },
      updateViewColumnMeta: async () => {
        updateViewColumnMetaCalls += 1
        return VIEW_A
      },
    })
  )

  await store.getState().initialize(TABLE_ID)
  await store.getState().updateView(
    VIEW_ID_A,
    {
      columnMeta: {
        f1: { width: 240 },
      },
    },
    { silent: true, refreshRecords: false }
  )

  assert.equal(updateViewCalls, 1)
  assert.equal(updateViewColumnMetaCalls, 0)
})

test('view-store: deleteView removes view and falls back', async () => {
  let deletedId: string | null = null
  const store = createTestStore(
    createViewService({
      deleteView: async (viewId) => {
        deletedId = viewId
      },
    })
  )
  await store.getState().initialize(TABLE_ID)

  const success = await store.getState().deleteView(VIEW_ID_B)
  assert.ok(success)
  assert.equal(deletedId, VIEW_ID_B)
})

test('view-store: setDefaultView moves target view to first order without marking a default', async () => {
  let reorderPayload: Array<{ view_id: string; order: number }> | undefined
  const store = createTestStore(
    createViewService({
      reorderViews: async (_tableId, payload) => {
        reorderPayload = payload.view_orders
      },
    })
  )
  await store.getState().initialize(TABLE_ID)

  const success = await store.getState().setDefaultView(VIEW_ID_B)

  assert.equal(success, true)
  assert.deepEqual(reorderPayload, [
    { view_id: VIEW_ID_B, order: 0 },
    { view_id: VIEW_ID_A, order: 1 },
  ])
  assert.equal(store.getState().views[0].id, VIEW_ID_B)
  assert.equal(store.getState().views[0].is_default, false)
})

test('view-store: fetchViewRecords 仅在查询未变化时携带 if-none-match', async () => {
  const queries: Array<Record<string, unknown> | undefined> = []
  const store = createTestStore(
    createViewService({
      getViewRecords: async (_viewId, query) => {
        queries.push(query as Record<string, unknown> | undefined)
        return {
          status: 200,
          etag: '"12"',
          data: {
            view: { id: VIEW_ID_A, name: 'Grid', view_type: 'grid' as const, config: {} },
            records: [],
            total: 0,
            page: Number(query?.page ?? 1),
            page_size: Number(query?.page_size ?? 100),
            metadata: {},
          },
        }
      },
    })
  )

  await store.getState().initialize(TABLE_ID)
  assert.equal(queries.length, 1)
  assert.equal(queries[0]?.ifNoneMatch, undefined)
  const defaultPageSize = store.getState().recordsQuery.page_size

  await store.getState().fetchViewRecords(VIEW_ID_A, { page: 1, page_size: defaultPageSize })
  assert.equal(queries[1]?.ifNoneMatch, '"12"')

  await store.getState().fetchViewRecords(VIEW_ID_A, {
    page: 1,
    page_size: defaultPageSize,
    groups: [{ field_id: 'f1', direction: 'asc' }],
  })
  assert.equal(queries[2]?.ifNoneMatch, undefined)

  await store.getState().fetchViewRecords(VIEW_ID_A, {
    page: 1,
    page_size: defaultPageSize,
    per_group_limit: 50,
    group_offsets: { High: 50 },
  })
  assert.equal(queries[3]?.ifNoneMatch, undefined)

  await store.getState().fetchViewRecords(VIEW_ID_A, { page: 2, page_size: defaultPageSize })
  assert.equal(queries[4]?.ifNoneMatch, undefined)
})

test('view-store: fetchViewRecords 可从签名 ETag 解析 latestVersion', async () => {
  const token = 4_000_000_000_321
  const etag = `"${token}:sig1234567890abcd"`
  const store = createTestStore(
    createViewService({
      getViewRecords: async () => ({
        status: 200,
        etag,
        data: {
          view: { id: VIEW_ID_A, name: 'Grid', view_type: 'grid' as const, config: {} },
          records: [],
          total: 0,
          page: 1,
          page_size: 100,
          metadata: {},
        },
      }),
    })
  )

  await store.getState().fetchViewRecords(VIEW_ID_A, { page: 1, page_size: 100 })
  const state = store.getState()
  assert.equal(state.currentViewLatestVersion, token)
  assert.equal(state.currentViewEtag, etag)
})

test('view-store: loadMoreCurrentViewRecords appends the next records page', async () => {
  const queries: Array<Record<string, unknown> | undefined> = []
  const store = createTestStore(
    createViewService({
      getViewRecords: async (_viewId, query) => {
        queries.push(query as Record<string, unknown> | undefined)
        const page = Number(query?.page ?? 1)
        const pageSize = Number(query?.page_size ?? 2)
        return {
          status: 200,
          data: {
            view: { id: VIEW_ID_A, name: 'Grid', view_type: 'grid' as const, config: {} },
            records:
              page === 1
                ? [recordFixture('r1', 1), recordFixture('r2', 2)]
                : [recordFixture('r2', 2), recordFixture('r3', 3), recordFixture('r4', 4)],
            total: 4,
            page,
            page_size: pageSize,
            metadata: {},
          },
        }
      },
    })
  )

  store.setState({ currentViewId: VIEW_ID_A })
  await store.getState().fetchViewRecords(VIEW_ID_A, {
    page: 1,
    page_size: 2,
    search: 'row',
  })
  await store.getState().loadMoreCurrentViewRecords()

  assert.equal(queries.length, 2)
  assert.equal(queries[1]?.page, 2)
  assert.equal(queries[1]?.page_size, 2)
  assert.equal(queries[1]?.search, 'row')
  assert.deepEqual(
    store.getState().currentViewRecords?.records.map(record => record.id),
    ['r1', 'r2', 'r3', 'r4']
  )
  assert.equal(store.getState().isLoadingMoreRecords, false)
  assert.equal(store.getState().recordsQuery.page, 1)
})

test('view-store: loadMoreCurrentViewGroupRecords appends only the requested kanban group', async () => {
  const queries: Array<Record<string, unknown> | undefined> = []
  const highInitial = recordFixture('high-1', 1)
  const highNext = recordFixture('high-2', 2)
  const lowInitial = recordFixture('low-1', 3)
  const store = createTestStore(
    createViewService({
      getViewRecords: async (_viewId, query) => {
        queries.push(query as Record<string, unknown> | undefined)
        return {
          status: 200,
          data: {
            view: { id: VIEW_ID_B, name: 'Kanban', view_type: 'kanban' as const, config: { group_by_field: 'f1' } },
            records: [highNext],
            total: 3,
            page: 1,
            page_size: 100,
            metadata: {
              view_type: 'kanban',
              groups: [
                {
                  group_value: 'High',
                  group_label: 'High',
                  count: 2,
                  records: [highNext],
                  offset: 1,
                  per_group_limit: 1,
                  has_more: false,
                },
                {
                  group_value: 'Low',
                  group_label: 'Low',
                  count: 1,
                  records: [lowInitial],
                  offset: 0,
                  per_group_limit: 1,
                  has_more: false,
                },
              ],
            },
          },
        }
      },
    })
  )

  store.setState({
    currentViewId: VIEW_ID_B,
    views: [VIEW_A, VIEW_B, VIEW_C],
    currentViewRecords: {
      view: { id: VIEW_ID_B, name: 'Kanban', view_type: 'kanban', config: { group_by_field: 'f1' } },
      records: [highInitial, lowInitial],
      total: 3,
      matched_total: 3,
      page: 1,
      page_size: 100,
      metadata: {
        view_type: 'kanban',
        groups: [
          {
            group_value: 'High',
            group_label: 'High',
            count: 2,
            records: [highInitial],
            offset: 0,
            per_group_limit: 1,
            has_more: true,
          },
          {
            group_value: 'Low',
            group_label: 'Low',
            count: 1,
            records: [lowInitial],
            offset: 0,
            per_group_limit: 1,
            has_more: false,
          },
        ],
      },
    },
    recordsQuery: { page: 1, page_size: 100, search: 'priority' },
  })

  await store.getState().loadMoreCurrentViewGroupRecords('High')

  assert.equal(queries.length, 1)
  assert.deepEqual(queries[0]?.group_offsets, { High: 1 })
  assert.equal(queries[0]?.per_group_limit, 1)
  assert.equal(queries[0]?.search, 'priority')

  const groups = store.getState().currentViewRecords?.metadata.groups as Array<{ group_value: string; records: ViewRecordsResponse['records']; has_more: boolean; offset: number }>
  const highGroup = groups.find(group => group.group_value === 'High')
  const lowGroup = groups.find(group => group.group_value === 'Low')
  assert.deepEqual(highGroup?.records.map(record => record.id), ['high-1', 'high-2'])
  assert.equal(highGroup?.has_more, false)
  assert.equal(highGroup?.offset, 2)
  assert.deepEqual(lowGroup?.records.map(record => record.id), ['low-1'])
  assert.deepEqual(
    store.getState().currentViewRecords?.records.map(record => record.id),
    ['high-1', 'low-1', 'high-2']
  )
})

test('view-store: loadMoreCurrentCalendarRange appends date-range occurrence wrappers', async () => {
  const queries: Array<Record<string, unknown> | undefined> = []
  const recordA = recordFixture('event-a', 1)
  const recordB = recordFixture('event-b', 2)
  const wrap = (date: string, record: ViewRecordsResponse['records'][number], occurrenceIndex = 0) =>
    ({
      date,
      record,
      is_start: true,
      is_end: true,
      span_total_days: 1,
      occurrence_index: occurrenceIndex,
      dirty: false,
      truncated: false,
    }) as unknown as ViewRecordsResponse['records'][number]
  const store = createTestStore(
    createViewService({
      getViewRecords: async (_viewId, query) => {
        queries.push(query as Record<string, unknown> | undefined)
        return {
          status: 200,
          data: {
            view: { id: VIEW_ID_C, name: 'Calendar', view_type: 'calendar' as const, config: VIEW_C.config },
            records: [wrap('2026-04-02', recordB)],
            total: 2,
            matched_total: 2,
            page: 2,
            page_size: 1,
            metadata: {
              view_type: 'calendar',
              pagination_unit: 'record',
              occurrence_count: 1,
              date_range: '2026-04-01,2026-04-30',
            },
          },
        }
      },
    })
  )

  store.setState({
    currentViewId: VIEW_ID_C,
    views: [VIEW_A, VIEW_B, VIEW_C],
    currentViewRecords: {
      view: { id: VIEW_ID_C, name: 'Calendar', view_type: 'calendar', config: VIEW_C.config },
      records: [wrap('2026-04-01', recordA)],
      total: 2,
      matched_total: 2,
      page: 1,
      page_size: 1,
      metadata: {
        view_type: 'calendar',
        pagination_unit: 'record',
        occurrence_count: 1,
        date_range: '2026-04-01,2026-04-30',
      },
    },
    recordsQuery: {
      page: 1,
      page_size: 1,
      date_range: '2026-04-01,2026-04-30',
      search: 'event',
    },
  })

  await store.getState().loadMoreCurrentCalendarRange()

  assert.equal(queries.length, 1)
  assert.equal(queries[0]?.page, 2)
  assert.equal(queries[0]?.page_size, 1)
  assert.equal(queries[0]?.date_range, '2026-04-01,2026-04-30')
  assert.equal(queries[0]?.search, 'event')
  assert.equal(store.getState().currentViewRecords?.page, 2)
  assert.deepEqual(
    store.getState().currentViewRecords?.records.map(item => (item as unknown as { record: { id: string } }).record.id),
    ['event-a', 'event-b']
  )
})

test('view-store: loadMoreCurrentViewRecords skips when all records are loaded', async () => {
  let getViewRecordsCalls = 0
  const store = createTestStore(
    createViewService({
      getViewRecords: async () => {
        getViewRecordsCalls += 1
        return MOCK_VIEW_RECORDS_RESPONSE
      },
    })
  )

  store.setState({
    currentViewId: VIEW_ID_A,
    currentViewRecords: {
      view: { id: VIEW_ID_A, name: 'Grid', view_type: 'grid', config: {} },
      records: [recordFixture('r1', 1)],
      total: 1,
      page: 1,
      page_size: 1000,
      metadata: {},
    },
    recordsQuery: { page: 1, page_size: 1000 },
  })

  await store.getState().loadMoreCurrentViewRecords()

  assert.equal(getViewRecordsCalls, 0)
  assert.equal(store.getState().isLoadingMoreRecords, false)
})

test('view-store: fetchViewRecords invalidates stale load-more responses', async () => {
  type RecordsResponse = Awaited<ReturnType<ViewStoreService['getViewRecords']>>
  const pendingResolvers: Array<(value: RecordsResponse) => void> = []
  const store = createTestStore(
    createViewService({
      getViewRecords: async () =>
        await new Promise<RecordsResponse>(resolve => {
          pendingResolvers.push(resolve)
        }),
    })
  )

  store.setState({
    currentViewId: VIEW_ID_A,
    currentViewRecords: {
      view: { id: VIEW_ID_A, name: 'Grid', view_type: 'grid', config: {} },
      records: [recordFixture('r1', 1), recordFixture('r2', 2)],
      total: 4,
      page: 1,
      page_size: 2,
      metadata: {},
    },
    recordsQuery: { page: 1, page_size: 2, search: 'old' },
  })

  const loadMoreRequest = store.getState().loadMoreCurrentViewRecords()
  assert.equal(pendingResolvers.length, 1)

  const refreshRequest = store.getState().fetchViewRecords(VIEW_ID_A, {
    page: 1,
    page_size: 2,
    search: 'new',
  })
  assert.equal(pendingResolvers.length, 2)

  pendingResolvers[1]({
    status: 200,
    data: {
      view: { id: VIEW_ID_A, name: 'Grid', view_type: 'grid', config: {} },
      records: [recordFixture('new-r1', 1)],
      total: 1,
      page: 1,
      page_size: 2,
      metadata: {},
    },
  })
  await refreshRequest

  pendingResolvers[0]({
    status: 200,
    data: {
      view: { id: VIEW_ID_A, name: 'Grid', view_type: 'grid', config: {} },
      records: [recordFixture('stale-r3', 3), recordFixture('stale-r4', 4)],
      total: 4,
      page: 2,
      page_size: 2,
      metadata: {},
    },
  })
  await loadMoreRequest

  const state = store.getState()
  assert.deepEqual(state.currentViewRecords?.records.map(record => record.id), ['new-r1'])
  assert.equal(state.recordsQuery.search, 'new')
  assert.equal(state.isLoadingMoreRecords, false)
})

test('view-store: fetchViewRecords 会将前端筛选算子映射为后端兼容值', async () => {
  const queries: Array<Record<string, unknown> | undefined> = []
  const store = createTestStore(
    createViewService({
      getViewRecords: async (_viewId, query) => {
        queries.push(query as Record<string, unknown> | undefined)
        return MOCK_VIEW_RECORDS_RESPONSE
      },
    })
  )

  await store.getState().fetchViewRecords(VIEW_ID_A, {
    page: 1,
    page_size: 100,
    filters: [{ id: 'flt-op', field_id: 'f1', operator: 'is_any_of', value: ['A'], enabled: true }],
  })

  const sentFilters = queries[0]?.filters as Array<{ operator?: string }> | undefined
  assert.equal(sentFilters?.[0]?.operator, 'in')
})

test('view-store: saveDraft/saveDraftAsView 会发送后端兼容筛选算子', async () => {
  let updateFiltersSent: Array<{ operator?: string }> | undefined
  let createFiltersSent: Array<{ operator?: string }> | undefined

  const store = createTestStore(
    createViewService({
      updateView: async (viewId, payload) => {
        updateFiltersSent = payload.filters as Array<{ operator?: string }> | undefined
        const base = viewId === VIEW_ID_A ? VIEW_A : VIEW_B
        return { ...base, ...payload } as ViewMeta
      },
      createView: async payload => {
        createFiltersSent = payload.filters as Array<{ operator?: string }> | undefined
        return {
          ...VIEW_A,
          id: '66666666-6666-6666-8666-666666666666',
          name: payload.name,
          view_type: payload.view_type ?? 'grid',
        }
      },
    })
  )

  await store.getState().initialize(TABLE_ID)
  store.getState().initializeDraft(VIEW_ID_A)
  store.getState().setDraftFilters(VIEW_ID_A, [
    { id: 'flt-multi', field_id: 'f1', operator: 'has_none_of', value: ['A'], enabled: true },
  ])

  await store.getState().saveDraft(VIEW_ID_A)
  assert.equal(updateFiltersSent?.[0]?.operator, 'not_contains')

  await store.getState().saveDraftAsView(VIEW_ID_A, 'Draft Copy')
  assert.equal(createFiltersSent?.[0]?.operator, 'not_contains')
})

test('view-store: saveDraft/saveDraftAsView 清空 kanban 分组时删除 group_by_field', async () => {
  let updateConfigSent: Record<string, unknown> | undefined
  let createConfigSent: Record<string, unknown> | undefined

  const store = createTestStore(
    createViewService({
      updateView: async (viewId, payload) => {
        updateConfigSent = payload.config as Record<string, unknown> | undefined
        const base = viewId === VIEW_ID_A ? VIEW_A : VIEW_B
        return { ...base, ...payload } as ViewMeta
      },
      createView: async payload => {
        createConfigSent = payload.config as Record<string, unknown> | undefined
        return {
          ...VIEW_B,
          id: '77777777-7777-4777-8777-777777777777',
          name: payload.name,
          config: payload.config ?? {},
        }
      },
    })
  )

  await store.getState().initialize(TABLE_ID)
  store.getState().initializeDraft(VIEW_ID_B)
  store.getState().setDraftGroups(VIEW_ID_B, [])

  await store.getState().saveDraft(VIEW_ID_B)
  assert.equal(updateConfigSent && 'group_by_field' in updateConfigSent, false)

  store.getState().setDraftGroups(VIEW_ID_B, [])
  await store.getState().saveDraftAsView(VIEW_ID_B, 'Kanban Without Group')
  assert.equal(createConfigSent && 'group_by_field' in createConfigSent, false)
})

// ---------------------------------------------------------------------------
// view-config-adapter 矩阵用例（ step 1）
// ---------------------------------------------------------------------------

test('view-store: initializeDraft(grid) 直接沿用 view.groups', async () => {
  const gridWithGroups: ViewMeta = {
    ...VIEW_A,
    groups: [{ field_id: 'f1', direction: 'asc' }],
    sorts: [{ field_id: 'f2', direction: 'desc' }],
  }
  const store = createTestStore(
    createViewService({
      getViewsByTable: async () => ({ views: [gridWithGroups], total: 1 }),
    })
  )
  await store.getState().initialize(TABLE_ID)
  store.getState().initializeDraft(VIEW_ID_A)

  const draft = store.getState().draftStates[VIEW_ID_A]
  assert.ok(draft)
  assert.deepEqual(draft.groups, [{ field_id: 'f1', direction: 'asc' }])
  assert.deepEqual(draft.sorts, [{ field_id: 'f2', direction: 'desc' }])
  assert.equal(draft.isDirty, false)
})

test('view-store: initializeDraft(kanban) 从 config.group_by_field 派生分组，忽略 view.groups', async () => {
  const store = createTestStore()
  await store.getState().initialize(TABLE_ID)
  store.getState().initializeDraft(VIEW_ID_B)

  const draft = store.getState().draftStates[VIEW_ID_B]
  assert.ok(draft)
  assert.deepEqual(draft.groups, [{ field_id: 'f1', direction: 'asc' }])
  assert.equal(draft.isDirty, false)
})

test('view-store: updateView 写入 group_by_field 后会 reconcile 未脏草稿', async () => {
  const emptyKanban: ViewMeta = {
    ...VIEW_B,
    config: {},
  }
  const store = createTestStore(
    createViewService({
      getViewsByTable: async () => ({ views: [VIEW_A, emptyKanban], total: 2 }),
      updateView: async (viewId, payload) => {
        const base = viewId === VIEW_ID_A ? VIEW_A : emptyKanban
        return {
          ...base,
          ...payload,
          config: {
            ...(base.config ?? {}),
            ...((payload.config as Record<string, unknown> | undefined) ?? {}),
          },
        } as ViewMeta
      },
    })
  )
  await store.getState().initialize(TABLE_ID)
  await store.getState().selectView(VIEW_ID_B)
  store.getState().initializeDraft(VIEW_ID_B)
  assert.deepEqual(store.getState().draftStates[VIEW_ID_B]?.groups, [])

  await store.getState().updateView(VIEW_ID_B, {
    config: { group_by_field: 'f2' },
  }, { silent: true, refreshRecords: false })

  const draft = store.getState().draftStates[VIEW_ID_B]
  assert.ok(draft)
  assert.deepEqual(draft.groups, [{ field_id: 'f2', direction: 'asc' }])
  assert.equal(draft.isDirty, false)
})

test('view-store: updateView 不覆盖已脏的草稿分组', async () => {
  const emptyKanban: ViewMeta = {
    ...VIEW_B,
    config: {},
  }
  const store = createTestStore(
    createViewService({
      getViewsByTable: async () => ({ views: [VIEW_A, emptyKanban], total: 2 }),
      updateView: async (viewId, payload) => {
        const base = viewId === VIEW_ID_A ? VIEW_A : emptyKanban
        return {
          ...base,
          ...payload,
          config: {
            ...(base.config ?? {}),
            ...((payload.config as Record<string, unknown> | undefined) ?? {}),
          },
        } as ViewMeta
      },
    })
  )
  await store.getState().initialize(TABLE_ID)
  await store.getState().selectView(VIEW_ID_B)
  store.getState().initializeDraft(VIEW_ID_B)
  store.getState().setDraftGroups(VIEW_ID_B, [{ field_id: 'f1', direction: 'asc' }])
  assert.equal(store.getState().draftStates[VIEW_ID_B]?.isDirty, true)

  await store.getState().updateView(VIEW_ID_B, {
    config: { group_by_field: 'f2' },
  }, { silent: true, refreshRecords: false })

  const draft = store.getState().draftStates[VIEW_ID_B]
  assert.ok(draft)
  assert.deepEqual(draft.groups, [{ field_id: 'f1', direction: 'asc' }])
  assert.equal(draft.isDirty, true)
})

test('view-store: setDraftGroups 按视图类型截断分组层级（grid 3 级 / kanban 1 级）', async () => {
  const store = createTestStore()
  await store.getState().initialize(TABLE_ID)

  store.getState().initializeDraft(VIEW_ID_A)
  store.getState().setDraftGroups(VIEW_ID_A, [
    { field_id: 'f1', direction: 'asc' },
    { field_id: 'f2', direction: 'asc' },
    { field_id: 'f3', direction: 'asc' },
    { field_id: 'f4', direction: 'asc' },
  ])
  assert.equal(store.getState().draftStates[VIEW_ID_A].groups.length, 3)

  store.getState().initializeDraft(VIEW_ID_B)
  store.getState().setDraftGroups(VIEW_ID_B, [
    { field_id: 'f1', direction: 'asc' },
    { field_id: 'f2', direction: 'asc' },
  ])
  assert.equal(store.getState().draftStates[VIEW_ID_B].groups.length, 1)
  assert.equal(store.getState().draftStates[VIEW_ID_B].groups[0]?.field_id, 'f1')
})

test('view-store: setDraftSorts 会把草稿标记为脏，且不影响 filters/groups', async () => {
  const store = createTestStore()
  await store.getState().initialize(TABLE_ID)
  store.getState().initializeDraft(VIEW_ID_A)

  store.getState().setDraftSorts(VIEW_ID_A, [{ field_id: 'f1', direction: 'desc' }])

  const draft = store.getState().draftStates[VIEW_ID_A]
  assert.deepEqual(draft.sorts, [{ field_id: 'f1', direction: 'desc' }])
  assert.equal(draft.isDirty, true)
  assert.deepEqual(draft.filters, [])
  assert.deepEqual(draft.groups, [])
})

test('view-store: setDraftSorts 还原为视图原始排序后 isDirty 复位', async () => {
  const sortedView: ViewMeta = {
    ...VIEW_A,
    sorts: [{ field_id: 'f1', direction: 'asc' }],
  }
  const store = createTestStore(
    createViewService({
      getViewsByTable: async () => ({ views: [sortedView], total: 1 }),
    })
  )
  await store.getState().initialize(TABLE_ID)
  store.getState().initializeDraft(VIEW_ID_A)

  store.getState().setDraftSorts(VIEW_ID_A, [{ field_id: 'f2', direction: 'desc' }])
  assert.equal(store.getState().draftStates[VIEW_ID_A].isDirty, true)

  store.getState().setDraftSorts(VIEW_ID_A, [{ field_id: 'f1', direction: 'asc' }])
  assert.equal(store.getState().draftStates[VIEW_ID_A].isDirty, false)
})

test('view-store: 取消分组只回滚分组，保留协作态已保存的筛选和排序', async () => {
  const persistedRestView: ViewMeta = {
    ...VIEW_A,
    groups: [{ field_id: 'f1', direction: 'asc' }],
  }
  const savedCollabView: ViewMeta = {
    ...persistedRestView,
    filters: [{ id: 'flt-saved', field_id: 'f2', operator: 'contains', value: 'bug', enabled: true }],
    sorts: [{ field_id: 'f2', direction: 'desc' }],
  }
  const store = createTestStore(
    createViewService({
      getViewsByTable: async () => ({ views: [persistedRestView], total: 1 }),
    })
  )
  await store.getState().initialize(TABLE_ID)
  store.getState().initializeDraft(VIEW_ID_A)

  store.getState().setDraftFilters(VIEW_ID_A, savedCollabView.filters ?? [])
  store.getState().setDraftSorts(VIEW_ID_A, savedCollabView.sorts ?? [])
  store.getState().setDraftGroups(VIEW_ID_A, [])
  store.getState().restoreDraftSection(VIEW_ID_A, 'groups', savedCollabView)

  const draft = store.getState().draftStates[VIEW_ID_A]
  assert.deepEqual(draft.filters, savedCollabView.filters)
  assert.deepEqual(draft.sorts, savedCollabView.sorts)
  assert.deepEqual(draft.groups, savedCollabView.groups)
  assert.equal(draft.isDirty, false)
})

test('view-store: Y.Doc 回读改变筛选对象键顺序时取消分组仍复位脏状态', async () => {
  const persistedRestView: ViewMeta = {
    ...VIEW_A,
    groups: [{ field_id: 'f1', direction: 'asc' }],
  }
  const store = createTestStore(
    createViewService({
      getViewsByTable: async () => ({ views: [persistedRestView], total: 1 }),
    })
  )
  await store.getState().initialize(TABLE_ID)
  store.getState().initializeDraft(VIEW_ID_A)

  store.getState().setDraftFilters(VIEW_ID_A, [
    { id: 'flt-saved', field_id: 'f2', operator: 'contains', value: 'bug', enabled: true },
  ])
  store.getState().setDraftSorts(VIEW_ID_A, [{ field_id: 'f2', direction: 'desc' }])
  store.getState().setDraftGroups(VIEW_ID_A, [])

  const savedCollabView: ViewMeta = {
    ...persistedRestView,
    filters: [
      { id: 'flt-saved', value: 'bug', enabled: true, field_id: 'f2', operator: 'contains' },
    ],
    sorts: [{ direction: 'desc', field_id: 'f2' }],
  }
  store.getState().restoreDraftSection(VIEW_ID_A, 'groups', savedCollabView)

  const draft = store.getState().draftStates[VIEW_ID_A]
  assert.deepEqual(draft.filters, [
    { id: 'flt-saved', field_id: 'f2', operator: 'contains', value: 'bug', enabled: true },
  ])
  assert.deepEqual(draft.sorts, [{ field_id: 'f2', direction: 'desc' }])
  assert.deepEqual(draft.groups, savedCollabView.groups)
  assert.equal(draft.isDirty, false)
})

test('view-store: saveDraft(grid) 会把草稿分组/排序一并发给后端且截断到 3 级', async () => {
  let updatePayload: { groups?: unknown; sorts?: unknown } | undefined
  const store = createTestStore(
    createViewService({
      updateView: async (viewId, payload) => {
        updatePayload = payload
        return { ...VIEW_A, ...payload } as ViewMeta
      },
    })
  )
  await store.getState().initialize(TABLE_ID)
  store.getState().initializeDraft(VIEW_ID_A)
  store.getState().setDraftGroups(VIEW_ID_A, [
    { field_id: 'f1', direction: 'asc' },
    { field_id: 'f2', direction: 'asc' },
    { field_id: 'f3', direction: 'asc' },
    { field_id: 'f4', direction: 'asc' },
  ])
  store.getState().setDraftSorts(VIEW_ID_A, [{ field_id: 'f2', direction: 'desc' }])

  await store.getState().saveDraft(VIEW_ID_A)

  assert.equal((updatePayload?.groups as unknown[] | undefined)?.length, 3)
  assert.deepEqual(updatePayload?.sorts, [{ field_id: 'f2', direction: 'desc' }])
})

test('view-store: saveDraft(kanban) 把草稿第一级分组同步进 config.group_by_field', async () => {
  let updatePayload: { groups?: unknown; config?: unknown } | undefined
  const store = createTestStore(
    createViewService({
      updateView: async (viewId, payload) => {
        updatePayload = payload
        return { ...VIEW_B, ...payload } as ViewMeta
      },
    })
  )
  await store.getState().initialize(TABLE_ID)
  store.getState().initializeDraft(VIEW_ID_B)
  store.getState().setDraftGroups(VIEW_ID_B, [{ field_id: 'f2', direction: 'asc' }])

  await store.getState().saveDraft(VIEW_ID_B)

  assert.equal((updatePayload?.groups as unknown[] | undefined)?.length, 1)
  assert.equal((updatePayload?.config as { group_by_field?: string } | undefined)?.group_by_field, 'f2')
})

test('view-store: fetchViewRecords 忽略过期请求响应，避免旧结果覆盖新筛选', async () => {
  const latestToken = 4_000_000_000_022
  const staleToken = 4_000_000_000_011
  type RecordsResponse = Awaited<ReturnType<ViewStoreService['getViewRecords']>>
  const pendingResolvers: Array<(value: RecordsResponse) => void> = []

  const store = createTestStore(
    createViewService({
      getViewRecords: async () =>
        await new Promise<RecordsResponse>(resolve => {
          pendingResolvers.push(resolve)
        }),
    })
  )

  const firstRequest = store.getState().fetchViewRecords(VIEW_ID_A, { page: 1, page_size: 10 })
  const secondRequest = store.getState().fetchViewRecords(VIEW_ID_A, { page: 2, page_size: 10 })

  assert.equal(pendingResolvers.length, 2)

  pendingResolvers[1]({
    status: 200,
    etag: `"${latestToken}"`,
    data: {
      view: { id: VIEW_ID_A, name: 'Grid', view_type: 'grid', config: {} },
      records: [],
      total: 0,
      page: 2,
      page_size: 10,
      latest_version: latestToken,
      metadata: {},
    },
  })
  await secondRequest

  assert.equal(store.getState().recordsQuery.page, 2)
  assert.equal(store.getState().currentViewLatestVersion, latestToken)

  pendingResolvers[0]({
    status: 200,
    etag: `"${staleToken}"`,
    data: {
      view: { id: VIEW_ID_A, name: 'Grid', view_type: 'grid', config: {} },
      records: [],
      total: 0,
      page: 1,
      page_size: 10,
      latest_version: staleToken,
      metadata: {},
    },
  })
  await firstRequest

  const state = store.getState()
  assert.equal(state.recordsQuery.page, 2)
  assert.equal(state.currentViewLatestVersion, latestToken)
  assert.equal(state.isRecordsLoading, false)
})

test('view-store: full reload can propagate fetch failures to the sync retry loop', async () => {
  const store = createTestStore(
    createViewService({
      getViewRecords: async () => {
        throw new Error('reload unavailable')
      },
    })
  )
  store.setState({
    tableId: TABLE_ID,
    views: [VIEW_A],
    currentViewId: VIEW_ID_A,
  })

  await assert.rejects(
    store.getState().refreshCurrentView({ throwOnError: true }),
    /reload unavailable/,
  )
  assert.equal(store.getState().error, 'reload unavailable')
  assert.equal(store.getState().isRecordsLoading, false)
})

test('view-store: fetchViewRecords 切离目标视图后丢弃响应，避免看板 groups 污染表格 ', async () => {
  type RecordsResponse = Awaited<ReturnType<ViewStoreService['getViewRecords']>>
  let resolveKanban!: (value: RecordsResponse) => void

  const store = createTestStore(
    createViewService({
      getViewRecords: async (viewId) => {
        if (viewId === VIEW_ID_B) {
          return await new Promise<RecordsResponse>(resolve => {
            resolveKanban = resolve
          })
        }
        return {
          status: 200,
          data: {
            view: { id: VIEW_ID_A, name: 'Grid', view_type: 'grid' as const, config: {} },
            records: [recordFixture('grid-1', 0)],
            total: 1,
            page: 1,
            page_size: 100,
            metadata: {},
          },
        }
      },
    })
  )

  store.setState({
    tableId: TABLE_ID,
    views: [VIEW_A, VIEW_B],
    currentViewId: VIEW_ID_B,
    currentViewRecords: null,
    recordsQuery: { page: 1, page_size: 100 },
  })

  const kanbanFetch = store.getState().fetchViewRecords(VIEW_ID_B, {
    page: 1,
    page_size: 100,
    groups: [{ field_id: 'f1', direction: 'asc' }],
  })

  // 模拟：看板请求尚未返回时已切到表格（且尚未发起表格 fetch，seq 仍属看板）
  store.setState({
    currentViewId: VIEW_ID_A,
    recordsQuery: { page: 1, page_size: 100 },
    currentViewRecords: {
      view: { id: VIEW_ID_A, name: 'Grid', view_type: 'grid', config: {} },
      records: [recordFixture('grid-kept', 0)],
      total: 1,
      page: 1,
      page_size: 100,
      metadata: {},
    },
  })

  resolveKanban({
    status: 200,
    data: {
      view: { id: VIEW_ID_B, name: 'Kanban', view_type: 'kanban', config: { group_by_field: 'f1' } },
      records: [],
      total: 0,
      page: 1,
      page_size: 100,
      metadata: {
        groups: {
          fields: [{ field_id: 'f1', field: 'Status' }],
          nodes: [{ group_value: 'todo', group_label: '待办', count: 1 }],
        },
      },
    },
  })
  await kanbanFetch

  const state = store.getState()
  assert.equal(state.currentViewId, VIEW_ID_A)
  assert.equal(state.currentViewRecords?.records[0]?.id, 'grid-kept')
  assert.equal(state.recordsQuery.groups, undefined)
  assert.equal(state.currentViewRecords?.metadata?.groups, undefined)
  assert.equal(state.isRecordsLoading, false)
})

test('view-store: applyDraft 在非当前视图时跳过，避免 draft.groups 串视图 ', async () => {
  let fetchedViewId: string | null = null
  const store = createTestStore(
    createViewService({
      getViewRecords: async (viewId) => {
        fetchedViewId = viewId
        return MOCK_VIEW_RECORDS_RESPONSE
      },
    })
  )

  store.setState({
    tableId: TABLE_ID,
    views: [VIEW_A, VIEW_B],
    currentViewId: VIEW_ID_A,
    draftStates: {
      [VIEW_ID_B]: {
        filters: [],
        groups: [{ field_id: 'f1', direction: 'asc' }],
        sorts: [],
        filter_logic: 'and',
        isDirty: true,
      },
    },
  })

  await store.getState().applyDraft(VIEW_ID_B)
  assert.equal(fetchedViewId, null)
  assert.equal(store.getState().recordsQuery.groups, undefined)
})

test('view-store: plain loadViews preserves currentViewRecords and query during refresh', async () => {
  let resolveViews!: (value: { views: ViewMeta[]; total: number }) => void
  const store = createTestStore(
    createViewService({
      getViewsByTable: () =>
        new Promise(resolve => {
          resolveViews = resolve
        }),
      getViewRecords: async () => ({
        ...MOCK_VIEW_RECORDS_RESPONSE,
        data: {
          ...MOCK_VIEW_RECORDS_RESPONSE.data,
          records: [recordFixture('kept-1', 0)],
          total: 1,
        },
      }),
    }),
  )

  store.setState({
    tableId: TABLE_ID,
    views: [VIEW_A, VIEW_B],
    currentViewId: VIEW_ID_A,
    currentViewRecords: {
      view: { id: VIEW_ID_A, name: 'Grid', view_type: 'grid', config: {} },
      records: [recordFixture('kept-1', 0)],
      total: 1,
      page: 1,
      page_size: 100,
      metadata: {},
    },
    recordsQuery: { page: 2, page_size: 50, search: 'keep-me' },
  })

  const loadPromise = store.getState().loadViews(TABLE_ID)
  // 请求进行中不得清空已有记录 / 查询——否则 ViewContainer 会进骨架屏并卸载工具栏
  assert.equal(store.getState().currentViewRecords?.records[0]?.id, 'kept-1')
  assert.equal(store.getState().recordsQuery.search, 'keep-me')
  assert.equal(store.getState().recordsQuery.page, 2)

  resolveViews({ views: [VIEW_A, VIEW_B], total: 2 })
  await loadPromise

  assert.equal(store.getState().currentViewId, VIEW_ID_A)
  assert.equal(store.getState().recordsQuery.search, 'keep-me')
  assert.equal(store.getState().currentViewRecords?.records[0]?.id, 'kept-1')
})

test('view-store: loadViews({ resetToViewId }) clears records and switches view', async () => {
  const store = createTestStore()

  store.setState({
    tableId: TABLE_ID,
    views: [VIEW_A, VIEW_B],
    currentViewId: VIEW_ID_A,
    currentViewRecords: {
      view: { id: VIEW_ID_A, name: 'Grid', view_type: 'grid', config: {} },
      records: [recordFixture('old-1', 0)],
      total: 1,
      page: 1,
      page_size: 100,
      metadata: {},
    },
    recordsQuery: { page: 3, page_size: 25, search: 'stale' },
  })

  await store.getState().loadViews(TABLE_ID, { resetToViewId: VIEW_ID_B })

  assert.equal(store.getState().currentViewId, VIEW_ID_B)
  assert.equal(store.getState().recordsQuery.page, 1)
  assert.equal(store.getState().recordsQuery.search, undefined)
})

test('view-store: loadViews clears cached records when the current view disappears', async () => {
  let resolveRecords!: (value: { status: number; data: ViewRecordsResponse }) => void
  const store = createTestStore(
    createViewService({
      getViewsByTable: async () => ({ views: [VIEW_B], total: 1 }),
      getViewRecords: async () => await new Promise(resolve => {
        resolveRecords = resolve
      }),
    }),
  )

  store.setState({
    tableId: TABLE_ID,
    views: [VIEW_A],
    currentViewId: VIEW_ID_A,
    currentViewRecords: {
      view: { id: VIEW_ID_A, name: 'Grid', view_type: 'grid', config: {} },
      records: [recordFixture('old-1', 0)],
      total: 1,
      page: 1,
      page_size: 100,
      metadata: {},
    },
  })

  const loadPromise = store.getState().loadViews(TABLE_ID)
  await Promise.resolve()
  assert.equal(store.getState().currentViewId, VIEW_ID_B)
  assert.equal(store.getState().currentViewRecords, null)

  resolveRecords({
    status: 200,
    data: {
      ...MOCK_VIEW_RECORDS_RESPONSE.data,
      view: { id: VIEW_ID_B, name: 'Kanban', view_type: 'kanban' as const, config: {} },
    },
  })
  await loadPromise
  assert.equal(store.getState().currentViewRecords?.view.id, VIEW_ID_B)
})

test('view-store: first tree toggle seeds default-expanded roots', () => {
  const store = createTestStore()
  const rootId = 'aaaaaaaa-aaaa-aaaa-8aaa-aaaaaaaaaaaa'
  const childId = 'bbbbbbbb-bbbb-bbbb-8bbb-bbbbbbbbbbbb'

  store.getState().toggleTreeRecordExpanded(VIEW_ID_A, childId, {
    seedExpandedIds: [rootId],
  })

  const expanded = store.getState().treeExpandedRecords[VIEW_ID_A]
  assert.ok(expanded)
  assert.equal(expanded.has(rootId), true)
  assert.equal(expanded.has(childId), true)
})

test('view-store: explicit empty tree set is not overwritten by seed', () => {
  const store = createTestStore()
  const rootId = 'aaaaaaaa-aaaa-aaaa-8aaa-aaaaaaaaaaaa'
  const childId = 'bbbbbbbb-bbbb-bbbb-8bbb-bbbbbbbbbbbb'

  store.getState().collapseAllTreeRecords(VIEW_ID_A)
  store.getState().toggleTreeRecordExpanded(VIEW_ID_A, childId, {
    seedExpandedIds: [rootId],
  })

  const expanded = store.getState().treeExpandedRecords[VIEW_ID_A]
  assert.ok(expanded)
  assert.equal(expanded.has(rootId), false)
  assert.equal(expanded.has(childId), true)
})

test('view-store: structuralShareViewRecords tolerates missing records (kanban payload)', () => {
  const gridPayload: ViewRecordsResponse = {
    view: { id: VIEW_ID_A, name: 'Grid', view_type: 'grid', config: {} },
    records: [{ id: 'r1', table_id: TABLE_ID, created_by_id: 'user-1', data: {}, order: 0, created_at: '', updated_at: '' }],
    total: 1,
    page: 1,
    page_size: 100,
    metadata: {},
  }
  const kanbanPayload: ViewRecordsResponse = {
    view: { id: VIEW_ID_B, name: 'Kanban', view_type: 'kanban', config: { group_by_field: 'f1' } },
    records: undefined as unknown as ViewRecordsResponse['records'],
    total: 97,
    page: 1,
    page_size: 100,
    metadata: {
      view_type: 'kanban',
      groups: [{ group_value: '高', group_label: '高', count: 20, records: [] }],
    },
  }

  const shared = structuralShareViewRecords(gridPayload, kanbanPayload)
  assert.deepEqual(shared.records, [])
  assert.equal(shared.total, 97)
  assert.equal((shared.metadata.groups as unknown[]).length, 1)
})
