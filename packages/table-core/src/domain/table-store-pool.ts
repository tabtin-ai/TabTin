/**
 * Shared table store pool factory.
 *
 * Creates a pool manager for Table/View/Record stores keyed by tableId,
 * with reference counting for cleanup. Both Electron and Web use the same
 * pool logic — platform differences are injected via the `deps` argument.
 */

export interface StorePoolTableStoreApi {
  getState(): { clearAll: () => void }
}

export interface StorePoolViewStoreApi {
  getState(): { reset: () => void }
}

export interface StorePoolRecordStoreApi {
  getState(): { reset: () => void }
}

export interface TableStorePoolDeps<
  TTable extends StorePoolTableStoreApi = StorePoolTableStoreApi,
  TView extends StorePoolViewStoreApi = StorePoolViewStoreApi,
  TRecord extends StorePoolRecordStoreApi = StorePoolRecordStoreApi,
> {
  createTableStore: () => TTable
  createViewStore: () => TView
  createRecordStore: (options?: { viewStore?: TView }) => TRecord
  registerResetAction?: (name: string, phase: 'reset', fn: () => void) => void
  resetActionName?: string
}

export interface TableStorePoolInstance<
  TTable extends StorePoolTableStoreApi = StorePoolTableStoreApi,
  TView extends StorePoolViewStoreApi = StorePoolViewStoreApi,
  TRecord extends StorePoolRecordStoreApi = StorePoolRecordStoreApi,
> {
  getOrCreateTableStore: (tableId: string) => TTable
  getOrCreateViewStore: (tableId: string) => TView
  getOrCreateRecordStore: (tableId: string, viewStore?: TView) => TRecord
  /**
   * 只读查询：返回池中已存在的 ViewStore，不会分配新实例。
   *
   * 用例：appMeta.resolve / attachToChat.buildRef 等「跨表全局」场景需要读取
   * 某张表的当前视图状态，但不希望仅因为读一次就把这张表的 store 永久驻留在
   * 池中（getOrCreate 会触发 LRU 入队，影响驱逐顺序）。
   */
  peekViewStoreForTable: (tableId: string) => TView | null
  retainStoreForTable: (tableId: string) => void
  releaseStoreForTable: (tableId: string) => void
  forceRebuildStoreForTable: (tableId: string) => void
  resetAllStorePools: () => void
}

const DEFAULT_LRU_CAPACITY = 5

export interface TableStorePoolOptions {
  lruCapacity?: number
}

export function createTableStorePool<
  TTable extends StorePoolTableStoreApi,
  TView extends StorePoolViewStoreApi,
  TRecord extends StorePoolRecordStoreApi,
>(deps: TableStorePoolDeps<TTable, TView, TRecord>, options?: TableStorePoolOptions): TableStorePoolInstance<TTable, TView, TRecord> {
  const tableStorePool = new Map<string, TTable>()
  const viewStorePool = new Map<string, TView>()
  const recordStorePool = new Map<string, TRecord>()
  const refCountMap = new Map<string, number>()

  // LRU cache for recently released stores (insertion order = age)
  const lruQueue: string[] = []
  const lruCapacity = options?.lruCapacity ?? DEFAULT_LRU_CAPACITY

  const evictFromLru = (tableId: string): void => {
    const rStore = recordStorePool.get(tableId)
    if (rStore) { rStore.getState().reset(); recordStorePool.delete(tableId) }

    const vStore = viewStorePool.get(tableId)
    if (vStore) { vStore.getState().reset(); viewStorePool.delete(tableId) }

    const tStore = tableStorePool.get(tableId)
    if (tStore) { tStore.getState().clearAll(); tableStorePool.delete(tableId) }
  }

  const removeLruEntry = (tableId: string): void => {
    const idx = lruQueue.indexOf(tableId)
    if (idx !== -1) lruQueue.splice(idx, 1)
  }

  const getOrCreateTableStore = (tableId: string): TTable => {
    if (!tableStorePool.has(tableId)) {
      tableStorePool.set(tableId, deps.createTableStore())
    }
    return tableStorePool.get(tableId)!
  }

  const getOrCreateViewStore = (tableId: string): TView => {
    if (!viewStorePool.has(tableId)) {
      viewStorePool.set(tableId, deps.createViewStore())
    }
    return viewStorePool.get(tableId)!
  }

  const peekViewStoreForTable = (tableId: string): TView | null => {
    return viewStorePool.get(tableId) ?? null
  }

  const getOrCreateRecordStore = (tableId: string, viewStore?: TView): TRecord => {
    if (!recordStorePool.has(tableId)) {
      const resolvedViewStore = viewStore ?? getOrCreateViewStore(tableId)
      recordStorePool.set(tableId, deps.createRecordStore({ viewStore: resolvedViewStore }))
    }
    return recordStorePool.get(tableId)!
  }

  const retainStoreForTable = (tableId: string): void => {
    const prev = refCountMap.get(tableId) ?? 0
    refCountMap.set(tableId, prev + 1)

    if (prev === 0) {
      removeLruEntry(tableId)
    }
  }

  const releaseStoreForTable = (tableId: string): void => {
    const prev = refCountMap.get(tableId) ?? 0
    if (prev <= 0) return
    const next = prev - 1
    refCountMap.set(tableId, next)
    if (next > 0) return

    refCountMap.delete(tableId)

    // Move to LRU instead of immediate destruction
    removeLruEntry(tableId)
    lruQueue.push(tableId)

    // Evict oldest if over capacity
    while (lruQueue.length > lruCapacity) {
      const evictId = lruQueue.shift()!
      evictFromLru(evictId)
    }
  }

  const forceRebuildStoreForTable = (tableId: string): void => {
    removeLruEntry(tableId)
    evictFromLru(tableId)
  }

  const resetAllStorePools = (): void => {
    for (const store of tableStorePool.values()) store.getState().clearAll()
    tableStorePool.clear()

    for (const store of viewStorePool.values()) store.getState().reset()
    viewStorePool.clear()

    for (const store of recordStorePool.values()) store.getState().reset()
    recordStorePool.clear()

    refCountMap.clear()
    lruQueue.length = 0
  }

  if (deps.registerResetAction && deps.resetActionName) {
    deps.registerResetAction(deps.resetActionName, 'reset', resetAllStorePools)
  }

  return {
    getOrCreateTableStore,
    getOrCreateViewStore,
    getOrCreateRecordStore,
    peekViewStoreForTable,
    retainStoreForTable,
    releaseStoreForTable,
    forceRebuildStoreForTable,
    resetAllStorePools,
  }
}
