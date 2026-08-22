import type { StateCreator } from 'zustand'
import type {
  TableRecord,
  CreateRecordRequest,
  UpdateRecordRequest,
  RecordQueryParams,
  RecordFieldKeyType,
  BulkCreateRecordsRequest,
  BulkUpdateRecordsRequest,
  BulkDeleteRecordsRequest,
  BulkDeleteRecordsResult,
  BulkOperationResponse,
  RecordListResponse,
  ViewRecordsResponse,
} from '../data'
import type { LoadingState } from './table-store'
import { structuralShareViewRecords } from './view-store'
import {
  buildVersionEtag,
  coerceMonotonicVersionToken,
  encodeMonotonicVersionToken,
  parseVersionTokenFromEtag,
} from '../data/version-token'

const EMPTY_RECORDS: TableRecord[] = []
const EMPTY_STRING_LIST: string[] = []
const EMPTY_RECORD_MAP: Map<string, TableRecord> = new Map()
const CLIENT_BULK_CHUNK_SIZE = 200
const MAX_CLIENT_PAGE_SIZE = 1000
const DEFAULT_RECORD_PAGE_SIZE = MAX_CLIENT_PAGE_SIZE

const createOperationGroupId = (): string => {
  if (
    typeof globalThis.crypto !== 'undefined' &&
    typeof globalThis.crypto.randomUUID === 'function'
  ) {
    return globalThis.crypto.randomUUID()
  }
  const segment = (length: number) =>
    Array.from({ length }, () => Math.floor(Math.random() * 16).toString(16)).join('')
  return [
    segment(8),
    segment(4),
    `4${segment(3)}`,
    `${(8 + Math.floor(Math.random() * 4)).toString(16)}${segment(3)}`,
    segment(12),
  ].join('-')
}

const defaultLogger: Pick<Console, 'log' | 'warn' | 'error'> = {
  log: (...args: unknown[]) => console.log(...args),
  warn: (...args: unknown[]) => console.warn(...args),
  error: (...args: unknown[]) => console.error(...args),
}

const areStringArraysEqual = (a?: string[], b?: string[]): boolean => {
  const arrA = (a ?? EMPTY_STRING_LIST).filter(Boolean)
  const arrB = (b ?? EMPTY_STRING_LIST).filter(Boolean)
  if (arrA.length !== arrB.length) return false
  const sortedA = [...arrA].sort()
  const sortedB = [...arrB].sort()
  return sortedA.every((value, index) => value === sortedB[index])
}

const chunkArray = <T,>(items: T[], chunkSize: number): T[][] => {
  if (items.length === 0) {
    return []
  }
  if (chunkSize <= 0 || items.length <= chunkSize) {
    return [items]
  }
  const chunks: T[][] = []
  for (let index = 0; index < items.length; index += chunkSize) {
    chunks.push(items.slice(index, index + chunkSize))
  }
  return chunks
}

const normalizePage = (value?: number): number => {
  if (!Number.isFinite(value)) {
    return 1
  }
  return Math.max(1, Math.floor(value as number))
}

const normalizePageSize = (value?: number): number => {
  if (!Number.isFinite(value)) {
    return DEFAULT_RECORD_PAGE_SIZE
  }
  return Math.max(1, Math.min(MAX_CLIENT_PAGE_SIZE, Math.floor(value as number)))
}

const deriveRecords = (map: Map<string, TableRecord>, ids: string[]): TableRecord[] => {
  if (ids.length === 0) return EMPTY_RECORDS
  const result: TableRecord[] = []
  for (const id of ids) {
    const record = map.get(id)
    if (record) result.push(record)
  }
  return result
}

const isPartialRecordSnapshot = (state: Pick<RecordStore, 'page' | 'recordIds' | 'total'>): boolean => {
  if (normalizePage(state.page) > 1) {
    return true
  }
  const normalizedTotal = Number.isFinite(state.total) ? Math.max(0, Math.floor(state.total)) : 0
  return normalizedTotal > state.recordIds.length
}

const toRecordObject = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {}
  }
  return value as Record<string, unknown>
}

const resolveRecordData = (record: TableRecord): Record<string, unknown> => {
  const data = toRecordObject(record.data)
  const fields = toRecordObject(record.fields)
  if (Object.keys(data).length === 0 && Object.keys(fields).length > 0) {
    return fields
  }
  return data
}

const mergeRecord = (origin: TableRecord, incoming: TableRecord): TableRecord => ({
  ...origin,
  ...incoming,
  data: {
    ...resolveRecordData(origin),
    ...resolveRecordData(incoming),
  },
  fields: {
    ...toRecordObject(origin.fields),
    ...toRecordObject(incoming.fields),
  },
})

interface PendingCellUpdateWaiter {
  resolve: (record: TableRecord | null) => void
}

interface CellUpdateQueueEntry {
  inFlight: boolean
  pendingData: UpdateRecordRequest | null
  waiters: PendingCellUpdateWaiter[]
  confirmedData: Record<string, unknown> | null
}

export interface RecordStore extends LoadingState {
  recordsMap: Map<string, TableRecord>
  recordIds: string[]
  /** @deprecated 兼容字段 — 优先使用 recordsMap + recordIds */
  records: TableRecord[]
  selectedRecord: TableRecord | null
  total: number
  page: number
  pageSize: number
  searchQuery: string
  sortBy: string
  sortOrder: 'asc' | 'desc'
  currentTableId: string | null
  matchedTotal: number
  latestVersion: number | null
  recordsEtag: string | null
  requestedFields: string[] | null
  syncRequestedAt: number
  lastConflicts: Array<{ record_id: string; field_id: string; your_value: unknown; server_value: unknown }>

  setSearchQuery: (query: string) => void
  setSorting: (sortBy: string, sortOrder: 'asc' | 'desc') => void
  setPage: (page: number) => void
  setPageSize: (pageSize: number) => void

  loadRecordsByTable: (tableId: string, params?: RecordQueryParams) => Promise<void>
  getRecord: (recordId: string) => Promise<void>

  createRecord: (data: CreateRecordRequest, options?: { skipLocalInsert?: boolean }) => Promise<TableRecord | null>
  updateRecord: (recordId: string, data: UpdateRecordRequest) => Promise<TableRecord | null>
  deleteRecord: (recordId: string) => Promise<boolean>

  bulkCreateRecords: (data: BulkCreateRecordsRequest) => Promise<TableRecord[]>
  bulkUpdateRecords: (
    data: BulkUpdateRecordsRequest,
    options?: { fields?: string[] | string; field_key_type?: RecordFieldKeyType }
  ) => Promise<{ records: TableRecord[]; errors: string[] }>
  bulkDeleteRecords: (
    recordIds: string[],
    options?: { operation_group_id?: string | null }
  ) => Promise<BulkDeleteRecordsResult>

  mergeIncrementalRecords: (records: TableRecord[], newVersion: number) => void
  mergeRestoredRecords: (
    tableId: string,
    records: TableRecord[],
    options?: { incrementTotal?: boolean; newVersion?: number; syncView?: boolean },
  ) => void
  removeRecordsByIds: (recordIds: string[], newVersion?: number) => void

  getRecordById: (id: string) => TableRecord | undefined

  selectRecord: (record: TableRecord | null) => void

  /** 手动清除 error 状态，避免旧错误泄露到不相关上下文 */
  clearError: () => void

  reset: () => void
}

export interface RecordStoreService {
  getRecordsByTable: (
    tableId: string,
    params?: RecordQueryParams
  ) => Promise<{ status: number; data: RecordListResponse | null; etag?: string }>
  getRecord: (recordId: string) => Promise<TableRecord>
  createRecord: (data: CreateRecordRequest) => Promise<TableRecord>
  deleteRecord: (recordId: string) => Promise<void>
  bulkCreateRecords: (data: BulkCreateRecordsRequest) => Promise<BulkOperationResponse>
  bulkUpdateRecords: (
    data: BulkUpdateRecordsRequest,
    options?: { fields?: string[] | string; field_key_type?: RecordFieldKeyType }
  ) => Promise<BulkOperationResponse>
  bulkDeleteRecords: (data: BulkDeleteRecordsRequest) => Promise<BulkOperationResponse>
}

export interface RecordStoreViewState {
  currentViewRecords: ViewRecordsResponse | null
}

export interface RecordStoreViewBridge {
  getState: () => RecordStoreViewState
  setState: (
    partial:
      | Partial<RecordStoreViewState>
      | ((state: RecordStoreViewState) => Partial<RecordStoreViewState>),
    replace?: boolean
  ) => void
}

export interface RecordStoreDeps {
  recordService: RecordStoreService
  viewStore?: RecordStoreViewBridge
  translate?: (key: string, fallback: string, options?: Record<string, unknown>) => string
  logger?: Pick<Console, 'log' | 'warn' | 'error'>
}

const recordStoreMerge = (persistedState: unknown, currentState: RecordStore): RecordStore => {
  const state = (persistedState ?? {}) as Partial<RecordStore>
  return {
    ...currentState,
    ...state,
    pageSize: DEFAULT_RECORD_PAGE_SIZE,
    recordsMap: EMPTY_RECORD_MAP,
    recordIds: EMPTY_STRING_LIST,
    records: EMPTY_RECORDS,
    selectedRecord: null,
  }
}

export interface CreateRecordStorePersistOptionsInput {
  name?: string
}

export const createRecordStorePersistOptions = (
  input: CreateRecordStorePersistOptionsInput = {}
) => ({
  name: input.name ?? 'tabtin-record-store',
  partialize: (state: RecordStore) => ({
    sortBy: state.sortBy,
    sortOrder: state.sortOrder,
  }),
  version: 1,
  merge: recordStoreMerge,
})

export const createRecordStoreState = (deps: RecordStoreDeps): StateCreator<RecordStore> => {
  const { recordService, viewStore, translate, logger = defaultLogger } = deps

  const t = (key: string, fallback: string, options?: Record<string, unknown>): string => {
    return translate?.(key, fallback, options) ?? fallback
  }

  return (set, get) => {
    const recordLoadPromises = new Map<string, Promise<void>>()
    const cellUpdateQueues = new Map<string, CellUpdateQueueEntry>()

    let _pendingMergeRecords: TableRecord[] = []
    let _pendingMergeVersion = 0
    let _mergeFlushScheduled = false
    const _pendingOptimisticCounts = new Map<string, number>()
    let _resetGeneration = 0

    function retainOptimistic(id: string) {
      _pendingOptimisticCounts.set(id, (_pendingOptimisticCounts.get(id) ?? 0) + 1)
    }
    function releaseOptimistic(id: string) {
      const c = (_pendingOptimisticCounts.get(id) ?? 1) - 1
      if (c <= 0) _pendingOptimisticCounts.delete(id)
      else _pendingOptimisticCounts.set(id, c)
    }
    function isOptimisticPending(id: string) {
      return (_pendingOptimisticCounts.get(id) ?? 0) > 0
    }

    const buildCellUpdateKey = (recordId: string, fieldKey: string) => `${recordId}:${fieldKey}`

    const _flushIncrementalMerge = () => {
      _mergeFlushScheduled = false
      const currentGen = _resetGeneration
      const batchedRecords = _pendingMergeRecords
      const batchedVersion = _pendingMergeVersion
      _pendingMergeRecords = []
      _pendingMergeVersion = 0

      if (batchedRecords.length === 0) return

      logger.log(
        t('record:logs.mergeIncremental', '合并增量记录', {
          count: batchedRecords.length,
          version: batchedVersion,
        })
      )

      if (_resetGeneration !== currentGen) return

      set(state => {
        const newMap = new Map(state.recordsMap)
        const newIds = [...state.recordIds]
        const partialSnapshot = isPartialRecordSnapshot(state)

        for (const record of batchedRecords) {
          if (isOptimisticPending(record.id)) {
            continue
          }
          const existing = newMap.get(record.id)
          if (existing) {
            const safeOrder = record.order === 0 && existing.order !== 0 ? existing.order : record.order
            newMap.set(record.id, { ...mergeRecord(existing, record), order: safeOrder })
          } else if (!partialSnapshot) {
            newMap.set(record.id, record)
            newIds.push(record.id)
          }
        }

        const normalizedVersion = coerceMonotonicVersionToken(batchedVersion)
        const nextLatestVersion = normalizedVersion ?? coerceMonotonicVersionToken(state.latestVersion)
        const nextTotal = partialSnapshot ? state.total : newIds.length
        return {
          recordsMap: newMap,
          recordIds: newIds,
          records: deriveRecords(newMap, newIds),
          latestVersion: nextLatestVersion,
          recordsEtag: nextLatestVersion != null ? buildVersionEtag(nextLatestVersion) : state.recordsEtag,
          total: nextTotal,
          matchedTotal:
            state.searchQuery.trim().length === 0
              ? Math.max(state.matchedTotal, nextTotal)
              : state.matchedTotal,
        }
      })
    }

    const rollbackUpdateOptimistic = (
      rid: string, keys: string[], snapshot: Record<string, unknown>, optimistic: TableRecord,
    ): Record<string, unknown> | null => {
      const currentRecord = get().recordsMap.get(rid)
      if (!currentRecord) return null
      const currentData = resolveRecordData(currentRecord)
      const optimisticData = resolveRecordData(optimistic)
      const patchObj: Record<string, unknown> = {}
      let hasRollback = false
      for (const key of keys) {
        if (currentData[key] === optimisticData[key]) {
          patchObj[key] = snapshot[key]
          hasRollback = true
        }
      }
      if (!hasRollback) return null
      const rollbackPatch = { id: rid, data: patchObj, fields: patchObj } as TableRecord
      set(state => {
        const record = state.recordsMap.get(rid)
        if (!record) return {}
        const newMap = new Map(state.recordsMap)
        newMap.set(rid, mergeRecord(record, rollbackPatch))
        return { recordsMap: newMap, records: deriveRecords(newMap, state.recordIds) }
      })
      return patchObj
    }

    type ViewSyncMode =
      | { type: 'merge'; recordId: string; patch: TableRecord }
      | { type: 'mergeMany'; patches: Map<string, TableRecord> }
      | { type: 'append'; records: TableRecord[] }
      | { type: 'remove'; recordIds: string[] }
      | { type: 'remap'; fromId: string; toRecord: TableRecord }
      | { type: 'insertAt'; record: TableRecord; index: number }

    const syncViewRecords = (mode: ViewSyncMode): void => {
      if (!viewStore) return
      try {
        const viewState = viewStore.getState()
        if (!viewState.currentViewRecords) return
        const currentRecords = viewState.currentViewRecords.records ?? EMPTY_RECORDS

        let nextRecords: TableRecord[]
        switch (mode.type) {
          case 'merge':
            nextRecords = currentRecords.map(r =>
              r.id === mode.recordId ? mergeRecord(r, mode.patch) : r
            )
            break
          case 'mergeMany': {
            const existing = new Set(currentRecords.map(r => r.id))
            nextRecords = currentRecords.map(r => {
              const patch = mode.patches.get(r.id)
              return patch ? mergeRecord(r, patch) : r
            })
            for (const [id, record] of mode.patches) {
              if (!existing.has(id)) {
                nextRecords.push(record)
              }
            }
            break
          }
          case 'append':
            nextRecords = [...currentRecords, ...mode.records]
            break
          case 'remove': {
            const removeSet = new Set(mode.recordIds)
            nextRecords = currentRecords.filter(r => !removeSet.has(r.id))
            break
          }
          case 'remap':
            nextRecords = currentRecords.map(r => r.id === mode.fromId ? mode.toRecord : r)
            break
          case 'insertAt': {
            nextRecords = [...currentRecords]
            const idx = Math.min(mode.index, nextRecords.length)
            nextRecords.splice(idx >= 0 ? idx : nextRecords.length, 0, mode.record)
            break
          }
        }

        const next = structuralShareViewRecords(
          viewState.currentViewRecords,
          { ...viewState.currentViewRecords, records: nextRecords },
        )
        if (next !== viewState.currentViewRecords) {
          viewStore.setState({ currentViewRecords: next })
        }
      } catch (err) {
        logger.warn(t('record:logs.syncViewRecordsFailed', '同步视图记录失败'), err)
      }
    }

    return {
      recordsMap: EMPTY_RECORD_MAP,
      recordIds: EMPTY_STRING_LIST,
      records: EMPTY_RECORDS,
      selectedRecord: null,
      total: 0,
      page: 1,
      pageSize: DEFAULT_RECORD_PAGE_SIZE,
      searchQuery: '',
      sortBy: 'created_at',
      sortOrder: 'desc',
      isLoading: false,
      error: null,
      currentTableId: null,
      matchedTotal: 0,
      latestVersion: null,
      recordsEtag: null,
      requestedFields: null,
      syncRequestedAt: 0,
      lastConflicts: [],

      setSearchQuery: (query: string) => {
        set({ searchQuery: query, page: 1 })
      },

      setSorting: (sortBy: string, sortOrder: 'asc' | 'desc') => {
        set({ sortBy, sortOrder })
      },

      setPage: (page: number) => {
        set({ page: normalizePage(page) })
      },

      setPageSize: (pageSize: number) => {
        set({ pageSize: normalizePageSize(pageSize), page: 1 })
      },

      loadRecordsByTable: async (tableId: string, params?: RecordQueryParams) => {
        const currentState = get()

        let incomingFields: string[] | undefined
        let explicitFieldsProvided = false

        if (params?.fields !== undefined) {
          explicitFieldsProvided = true
          if (Array.isArray(params.fields)) {
            incomingFields = params.fields.filter(Boolean)
          } else if (typeof params.fields === 'string') {
            incomingFields = params.fields
              .split(',')
              .map(field => field.trim())
              .filter(Boolean)
          }
        }

        const prevFields = currentState.requestedFields ?? undefined
        const normalizedPrev = prevFields ?? EMPTY_STRING_LIST
        const fieldsChanged = incomingFields
          ? !areStringArraysEqual(incomingFields, normalizedPrev)
          : explicitFieldsProvided && normalizedPrev.length > 0

        const selectedFields = incomingFields ?? prevFields

        const queryParams: RecordQueryParams = {
          page: normalizePage(currentState.page),
          page_size: normalizePageSize(currentState.pageSize),
          search: currentState.searchQuery || undefined,
          sort_by: currentState.sortBy,
          sort_order: currentState.sortOrder,
          ...params,
        }
        queryParams.page = normalizePage(queryParams.page)
        queryParams.page_size = normalizePageSize(queryParams.page_size)

        if (selectedFields && selectedFields.length > 0) {
          queryParams.fields = selectedFields
        }

        if (!fieldsChanged && currentState.recordsEtag) {
          queryParams.ifNoneMatch = currentState.recordsEtag
        }

        const cacheKey = `${tableId}::${JSON.stringify(queryParams)}`
        const existingPromise = recordLoadPromises.get(cacheKey)
        if (existingPromise) {
          await existingPromise
          return
        }

        set(state => ({
          isLoading: true,
          error: null,
          currentTableId: tableId,
          ...(incomingFields ? { requestedFields: incomingFields } : {}),
          ...(fieldsChanged ? { recordsEtag: null } : {}),
        }))

        const loader = (async () => {
          const generation = _resetGeneration
          try {
            const { status, data, etag } = await recordService.getRecordsByTable(tableId, queryParams)
            if (_resetGeneration !== generation) return
            if (status === 304 || !data) {
              set({
                isLoading: false,
                currentTableId: tableId,
              })
              return
            }

            const nextRecords = data.records ?? EMPTY_RECORDS
            const matchedTotal = data.matched_total ?? data.total ?? nextRecords.length

            const resolvedVersion = (() => {
              const fromPayload = coerceMonotonicVersionToken(data.latest_version)
              if (fromPayload != null) {
                return fromPayload
              }
              const fromEtag = parseVersionTokenFromEtag(etag)
              if (fromEtag != null) {
                return fromEtag
              }
              return coerceMonotonicVersionToken(get().latestVersion)
            })()

            const nextLatestVersion = resolvedVersion ?? null
            const nextEtag =
              etag ?? (nextLatestVersion != null ? buildVersionEtag(nextLatestVersion) : get().recordsEtag ?? null)

            const nextMap = new Map(nextRecords.map(r => [r.id, r]))
            const nextIds = nextRecords.map(r => r.id)

            set({
              recordsMap: nextMap,
              recordIds: nextIds,
              records: nextRecords,
              total: data.total ?? nextRecords.length,
              matchedTotal,
              page: data.page ?? queryParams.page ?? 1,
              pageSize: data.page_size ?? queryParams.page_size ?? nextRecords.length,
              isLoading: false,
              currentTableId: tableId,
              latestVersion: nextLatestVersion,
              recordsEtag: nextEtag,
              requestedFields: selectedFields ?? null,
            })
          } catch (error) {
            if (_resetGeneration !== generation) return
            const errorMessage =
              error instanceof Error ? error.message : t('record:apiErrors.fetchListFailed', '获取记录列表失败')
            logger.error('[RecordStore] loadRecordsByTable failed', errorMessage)
            set({ error: errorMessage, isLoading: false })
            throw error
          }
        })()

        recordLoadPromises.set(cacheKey, loader)
        try {
          await loader
        } finally {
          recordLoadPromises.delete(cacheKey)
        }
      },

      getRecord: async (recordId: string) => {
        set({ isLoading: true, error: null })
        try {
          const record = await recordService.getRecord(recordId)
          set({ selectedRecord: record, isLoading: false })
          logger.log(t('record:logs.fetchDetailSuccess', '获取记录详情成功'))
        } catch (error) {
          const errorMessage =
            error instanceof Error ? error.message : t('record:apiErrors.fetchDetailFailed', '获取记录详情失败')
          logger.error('[RecordStore] getRecord failed', errorMessage)
          set({ error: errorMessage, isLoading: false })
        }
      },

      createRecord: async (data: CreateRecordRequest, options?: { skipLocalInsert?: boolean }) => {
        if (options?.skipLocalInsert) {
          try {
            const record = await recordService.createRecord(data)
            logger.log(t('record:logs.createSuccess', '创建记录成功'))
            return record
          } catch (error) {
            const errorMessage =
              error instanceof Error ? error.message : t('record:apiErrors.createFailed', '创建记录失败')
            logger.error('[RecordStore] createRecord failed', errorMessage)
            set({ error: errorMessage })
            return null
          }
        }

        const currentTableId = data.table_id ?? get().currentTableId
        const isCurrentTable = !get().currentTableId || get().currentTableId === currentTableId

        if (!isCurrentTable) {
          try {
            const record = await recordService.createRecord(data)
            logger.log(t('record:logs.createSuccess', '创建记录成功'))
            return record
          } catch (error) {
            const errorMessage =
              error instanceof Error ? error.message : t('record:apiErrors.createFailed', '创建记录失败')
            logger.error('[RecordStore] createRecord failed', errorMessage)
            set({ error: errorMessage })
            return null
          }
        }

        // ── 阶段 1：乐观写入 ──
        const tmpId = '__tmp_' + createOperationGroupId()
        const now = new Date().toISOString()
        const requestData = (data.fields ?? data.data ?? {}) as Record<string, unknown>
        const optimisticRecord = {
          id: tmpId,
          data: requestData,
          fields: requestData,
          created_at: now,
          updated_at: now,
          order: 0,
        } as TableRecord

        retainOptimistic(tmpId)

        const partialSnapshot = isPartialRecordSnapshot(get())
        const optimisticInserted = !partialSnapshot

        set(state => {
          if (partialSnapshot) {
            return {
              total: state.total + 1,
              matchedTotal: state.searchQuery.trim().length === 0
                ? state.matchedTotal + 1
                : state.matchedTotal,
            }
          }
          const newMap = new Map(state.recordsMap)
          newMap.set(tmpId, optimisticRecord)
          const newIds = [...state.recordIds, tmpId]
          const nextTotal = state.total + 1
          return {
            recordsMap: newMap,
            recordIds: newIds,
            records: deriveRecords(newMap, newIds),
            total: nextTotal,
            matchedTotal: state.searchQuery.trim().length === 0
              ? state.matchedTotal + 1
              : state.matchedTotal,
          }
        })

        if (optimisticInserted) {
          syncViewRecords({ type: 'append', records: [optimisticRecord] })
        }

        // ── 阶段 2：发起请求 ──
        try {
          const record = await recordService.createRecord(data)

          // ── 阶段 3a：成功确认 ──
          releaseOptimistic(tmpId)

          if (optimisticInserted) {
            set(state => {
              const newMap = new Map(state.recordsMap)
              newMap.delete(tmpId)
              newMap.set(record.id, record)
              const newIds = state.recordIds
                .filter(id => id !== record.id)
                .map(id => id === tmpId ? record.id : id)

              const nextRecordVersion =
                typeof record.version === 'number' && !Number.isNaN(record.version)
                  ? record.version
                  : null
              const nextLatestVersion =
                encodeMonotonicVersionToken(nextRecordVersion) ??
                coerceMonotonicVersionToken(state.latestVersion)
              const nextEtag = nextLatestVersion != null ? buildVersionEtag(nextLatestVersion) : state.recordsEtag

              return {
                recordsMap: newMap,
                recordIds: newIds,
                records: deriveRecords(newMap, newIds),
                latestVersion: nextLatestVersion,
                recordsEtag: nextEtag,
              }
            })

            syncViewRecords({ type: 'remap', fromId: tmpId, toRecord: record })
          }

          logger.log(t('record:logs.createSuccess', '创建记录成功'))
          return record
        } catch (error) {
          // ── 阶段 3b：失败回滚 ──
          releaseOptimistic(tmpId)

          const errorMessage =
            error instanceof Error ? error.message : t('record:apiErrors.createFailed', '创建记录失败')
          logger.error('[RecordStore] createRecord failed', errorMessage)

          if (optimisticInserted) {
            set(state => {
              const newMap = new Map(state.recordsMap)
              newMap.delete(tmpId)
              const newIds = state.recordIds.filter(id => id !== tmpId)
              return {
                recordsMap: newMap,
                recordIds: newIds,
                records: deriveRecords(newMap, newIds),
                total: Math.max(0, state.total - 1),
                matchedTotal: state.searchQuery.trim().length === 0
                  ? Math.max(0, state.matchedTotal - 1)
                  : state.matchedTotal,
                syncRequestedAt: Date.now(),
                error: errorMessage,
              }
            })
            syncViewRecords({ type: 'remove', recordIds: [tmpId] })
          } else {
            set(state => ({
              total: Math.max(0, state.total - 1),
              matchedTotal: state.searchQuery.trim().length === 0
                ? Math.max(0, state.matchedTotal - 1)
                : state.matchedTotal,
              syncRequestedAt: Date.now(),
              error: errorMessage,
            }))
          }

          return null
        }
      },

      updateRecord: async (recordId: string, data: UpdateRecordRequest) => {
        const performUpdateRecord = async (
          nextData: UpdateRecordRequest,
          options: { baseSnapshot?: Record<string, unknown> } = {},
        ): Promise<TableRecord | null> => {
          set({ lastConflicts: [] })
          const patchData = (nextData.fields ?? nextData.data ?? {}) as Record<string, unknown>
          const patchKeys = Object.keys(patchData)

          // ── 阶段 1：乐观写入 ──
          const existingRecord = get().recordsMap.get(recordId)
          if (!existingRecord) {
            try {
              const { records: updates } = await get().bulkUpdateRecords(
                { updates: [{ record_id: recordId, data: patchData }] },
                nextData.fieldKeyType ? { field_key_type: nextData.fieldKeyType } : undefined,
              )
              return updates.find(r => r.id === recordId) ?? null
            } catch (error) {
              const errorMessage =
                error instanceof Error ? error.message : t('record:apiErrors.updateFailed', '更新记录失败')
              logger.error('[RecordStore] updateRecord failed', errorMessage)
              set({ error: errorMessage })
              return null
            }
          }

          const oldData = resolveRecordData(existingRecord)
          const snapshotFields: Record<string, unknown> = {}
          for (const key of patchKeys) {
            snapshotFields[key] = Object.prototype.hasOwnProperty.call(options.baseSnapshot ?? {}, key)
              ? options.baseSnapshot?.[key]
              : oldData[key]
          }

          const optimisticIncoming = { id: recordId, data: patchData, fields: patchData } as TableRecord
          const optimisticRecord = mergeRecord(existingRecord, optimisticIncoming)
          retainOptimistic(recordId)

          set(state => {
            const newMap = new Map(state.recordsMap)
            newMap.set(recordId, optimisticRecord)
            return {
              recordsMap: newMap,
              records: deriveRecords(newMap, state.recordIds),
            }
          })

          syncViewRecords({ type: 'merge', recordId, patch: optimisticIncoming })

          // ── 阶段 2：发起请求 ──
          try {
            const result = await recordService.bulkUpdateRecords(
              {
                updates: [{ record_id: recordId, data: patchData, base_snapshot: snapshotFields }],
                operation_group_id: createOperationGroupId(),
              },
              nextData.fieldKeyType ? { field_key_type: nextData.fieldKeyType } : undefined,
            )

            // ── 阶段 3a：成功确认 ──
            const serverRecord = Array.isArray(result.records)
              ? result.records.find(r => r.id === recordId)
              : undefined

            if (!serverRecord) {
              releaseOptimistic(recordId)
              const rollbackData = rollbackUpdateOptimistic(recordId, patchKeys, snapshotFields, optimisticRecord)
              if (rollbackData) {
                syncViewRecords({ type: 'merge', recordId, patch: { id: recordId, data: rollbackData, fields: rollbackData } as TableRecord })
              }
              set({ syncRequestedAt: Date.now() })
              logger.warn(t('record:logs.bulkUpdateMissingRecord', '批量更新结果中缺少目标记录'), recordId)
              return null
            }

            releaseOptimistic(recordId)

            const conflicts = Array.isArray(result.conflicts) ? result.conflicts : []

            set(state => {
              const newMap = new Map(state.recordsMap)
              const current = newMap.get(recordId)
              newMap.set(recordId, current ? mergeRecord(current, serverRecord) : serverRecord)

              const nextRecordVersion =
                typeof serverRecord.version === 'number' && !Number.isNaN(serverRecord.version)
                  ? serverRecord.version
                  : null
              const nextLatestVersion =
                encodeMonotonicVersionToken(nextRecordVersion) ??
                coerceMonotonicVersionToken(state.latestVersion)
              const nextEtag = nextLatestVersion != null ? buildVersionEtag(nextLatestVersion) : state.recordsEtag

              return {
                recordsMap: newMap,
                records: deriveRecords(newMap, state.recordIds),
                latestVersion: nextLatestVersion,
                recordsEtag: nextEtag,
                selectedRecord: state.selectedRecord?.id === recordId
                  ? (newMap.get(recordId) ?? state.selectedRecord)
                  : state.selectedRecord,
                ...(conflicts.length > 0 ? { lastConflicts: conflicts } : {}),
              }
            })

            syncViewRecords({ type: 'merge', recordId, patch: serverRecord })

            return serverRecord
          } catch (error) {
            // ── 阶段 3b：失败回滚 ──
            releaseOptimistic(recordId)

            const rollbackData = rollbackUpdateOptimistic(recordId, patchKeys, snapshotFields, optimisticRecord)
            if (rollbackData) {
              syncViewRecords({ type: 'merge', recordId, patch: { id: recordId, data: rollbackData, fields: rollbackData } as TableRecord })
            }

            const errorMessage =
              error instanceof Error ? error.message : t('record:apiErrors.updateFailed', '更新记录失败')
            logger.error('[RecordStore] updateRecord failed', errorMessage)
            set({ error: errorMessage, syncRequestedAt: Date.now() })
            return null
          }
        }

        const patchData = (data.fields ?? data.data ?? {}) as Record<string, unknown>
        const patchKeys = Object.keys(patchData)
        if (patchKeys.length !== 1 || !get().recordsMap.has(recordId)) {
          return performUpdateRecord(data)
        }

        const fieldKey = patchKeys[0]
        const queueKey = buildCellUpdateKey(recordId, fieldKey)
        const existingQueue = cellUpdateQueues.get(queueKey)
        if (existingQueue?.inFlight) {
          existingQueue.pendingData = data
          return new Promise<TableRecord | null>(resolve => {
            existingQueue.waiters.push({ resolve })
          })
        }

        const queue: CellUpdateQueueEntry = {
          inFlight: true,
          pendingData: null,
          waiters: [],
          confirmedData: null,
        }
        cellUpdateQueues.set(queueKey, queue)

        let result: TableRecord | null = await performUpdateRecord(data)
        if (result) {
          queue.confirmedData = resolveRecordData(result)
        }

        while (queue.pendingData) {
          const pendingData = queue.pendingData
          const waiters = queue.waiters.splice(0)
          queue.pendingData = null
          const baseSnapshot = queue.confirmedData
            ? { [fieldKey]: queue.confirmedData[fieldKey] }
            : undefined
          result = await performUpdateRecord(pendingData, { baseSnapshot })
          if (result) {
            queue.confirmedData = resolveRecordData(result)
          }
          for (const waiter of waiters) {
            waiter.resolve(result)
          }
        }

        queue.inFlight = false
        cellUpdateQueues.delete(queueKey)
        return result
      },

      deleteRecord: async (recordId: string) => {
        // ── 阶段 1：乐观删除 ──
        const existingRecord = get().recordsMap.get(recordId)
        const snapshotRecord = existingRecord ? { ...existingRecord } : null
        const snapshotIndex = get().recordIds.indexOf(recordId)

        retainOptimistic(recordId)

        set(state => {
          const newMap = new Map(state.recordsMap)
          newMap.delete(recordId)
          const newIds = state.recordIds.filter(id => id !== recordId)
          const nextTotal = Math.max(0, state.total - 1)
          return {
            recordsMap: newMap,
            recordIds: newIds,
            records: deriveRecords(newMap, newIds),
            selectedRecord: state.selectedRecord?.id === recordId ? null : state.selectedRecord,
            total: nextTotal,
            matchedTotal: state.searchQuery.trim().length === 0
              ? Math.max(0, state.matchedTotal - 1)
              : state.matchedTotal,
          }
        })

        syncViewRecords({ type: 'remove', recordIds: [recordId] })

        // ── 阶段 2：发起请求 ──
        try {
          await recordService.deleteRecord(recordId)

          // ── 阶段 3a：成功确认 ──
          releaseOptimistic(recordId)

          logger.log(t('record:logs.deleteSuccess', '删除记录成功'))
          return true
        } catch (error) {
          // ── 阶段 3b：失败回滚 ──
          releaseOptimistic(recordId)

          const errorMessage =
            error instanceof Error ? error.message : t('record:apiErrors.deleteFailed', '删除记录失败')
          logger.error('[RecordStore] deleteRecord failed', errorMessage)

          if (snapshotRecord) {
            set(state => {
              const newMap = new Map(state.recordsMap)
              newMap.set(recordId, snapshotRecord)
              const newIds = [...state.recordIds]
              if (snapshotIndex >= 0 && snapshotIndex <= newIds.length) {
                newIds.splice(snapshotIndex, 0, recordId)
              } else {
                newIds.push(recordId)
              }
              return {
                recordsMap: newMap,
                recordIds: newIds,
                records: deriveRecords(newMap, newIds),
                total: state.total + 1,
                matchedTotal: state.searchQuery.trim().length === 0
                  ? state.matchedTotal + 1
                  : state.matchedTotal,
                syncRequestedAt: Date.now(),
                error: errorMessage,
              }
            })
            syncViewRecords({ type: 'insertAt', record: snapshotRecord, index: snapshotIndex })
          } else {
            set({ syncRequestedAt: Date.now(), error: errorMessage })
          }
          return false
        }
      },

      bulkCreateRecords: async (data: BulkCreateRecordsRequest) => {
        set({ isLoading: true, error: null })
        try {
          const operationGroupId = data.operation_group_id ?? createOperationGroupId()
          const chunks = chunkArray(data.records, CLIENT_BULK_CHUNK_SIZE)
          let totalSuccess = 0
          const mergedErrors: string[] = []
          const mergedCreatedRecords: TableRecord[] = []
          let nextOrderContext = data.order_context

          for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex += 1) {
            const chunk = chunks[chunkIndex]
            try {
              const result = await recordService.bulkCreateRecords({
                table_id: data.table_id,
                records: chunk,
                ...(data.fieldKeyType ? { fieldKeyType: data.fieldKeyType } : {}),
                ...(nextOrderContext ? { order_context: nextOrderContext } : {}),
                operation_group_id: operationGroupId,
              })
              totalSuccess += result.success_count
              if (result.errors.length > 0) {
                mergedErrors.push(...result.errors.map(message => `[分批 ${chunkIndex + 1}/${chunks.length}] ${message}`))
              }
              if (Array.isArray(result.records) && result.records.length > 0) {
                mergedCreatedRecords.push(...result.records)
                const lastCreatedRecord = result.records[result.records.length - 1]
                if (lastCreatedRecord?.id && nextOrderContext) {
                  nextOrderContext = {
                    ...nextOrderContext,
                    anchor_record_id: lastCreatedRecord.id,
                    position: 'after',
                  }
                }
              }
            } catch (chunkError) {
              const msg = chunkError instanceof Error ? chunkError.message : String(chunkError)
              mergedErrors.push(
                t('record:errors.chunkFailed', '[分批 {{current}}/{{total}}] {{message}}（{{count}} 条受影响）', {
                  current: chunkIndex + 1, total: chunks.length, message: msg, count: chunk.length,
                })
              )
              logger.error(`[RecordStore] bulkCreate chunk ${chunkIndex + 1}/${chunks.length} failed`, msg)
            }
            logger.log(
              t('record:logs.bulkProgress', '批量执行进度', {
                current: chunkIndex + 1,
                total: chunks.length,
              })
            )
          }

          logger.log(t('record:logs.bulkCreateSuccess', '批量创建记录成功', { count: totalSuccess }))
          if (mergedErrors.length > 0) {
            logger.warn(t('record:logs.bulkCreatePartialFailed', '批量创建部分失败'), mergedErrors)
          }

          const createdRecords =
            mergedCreatedRecords.length > 0 ? mergedCreatedRecords : EMPTY_RECORDS

          const tableId = data.table_id ?? get().currentTableId
          const currentPage = get().page
          const currentPageSize = get().pageSize

          if (tableId) {
            try {
              await get().loadRecordsByTable(tableId, {
                page: currentPage,
                page_size: currentPageSize,
              })
            } catch (refreshError) {
              const refreshMessage =
                refreshError instanceof Error
                  ? refreshError.message
                  : t('record:apiErrors.fetchListFailed', '获取记录列表失败')
              logger.warn('[RecordStore] bulkCreateRecords reload failed after create', refreshMessage)
              set({ error: refreshMessage, isLoading: false })
              if (createdRecords.length === 0) {
                throw refreshError
              }
            }
          } else {
            set({ isLoading: false })
          }
          return createdRecords
        } catch (error) {
          const errorMessage =
            error instanceof Error ? error.message : t('record:apiErrors.bulkCreateFailed', '批量创建记录失败')
          logger.error('[RecordStore] bulkCreateRecords failed', errorMessage)
          set({ error: errorMessage, isLoading: false })
          throw error
        }
      },

      bulkUpdateRecords: async (data: BulkUpdateRecordsRequest, options?: { fields?: string[] | string; field_key_type?: RecordFieldKeyType }) => {
        set({ isLoading: true, error: null })
        try {
          const operationGroupId = data.operation_group_id ?? createOperationGroupId()
          const chunks = chunkArray(data.updates, CLIENT_BULK_CHUNK_SIZE)
          let totalSuccess = 0
          const mergedErrors: string[] = []
          const mergedUpdatedRecords: TableRecord[] = []

          for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex += 1) {
            const chunk = chunks[chunkIndex]
            try {
              const result = await recordService.bulkUpdateRecords(
                { updates: chunk, operation_group_id: operationGroupId },
                options
              )
              totalSuccess += result.success_count
              if (result.errors.length > 0) {
                mergedErrors.push(...result.errors.map(message => `[分批 ${chunkIndex + 1}/${chunks.length}] ${message}`))
              }
              if (Array.isArray(result.records) && result.records.length > 0) {
                mergedUpdatedRecords.push(...result.records)
              }
            } catch (chunkError) {
              const msg = chunkError instanceof Error ? chunkError.message : String(chunkError)
              mergedErrors.push(
                t('record:errors.chunkFailed', '[分批 {{current}}/{{total}}] {{message}}（{{count}} 条受影响）', {
                  current: chunkIndex + 1, total: chunks.length, message: msg, count: chunk.length,
                })
              )
              logger.error(`[RecordStore] bulkUpdate chunk ${chunkIndex + 1}/${chunks.length} failed`, msg)
            }
            logger.log(
              t('record:logs.bulkProgress', '批量执行进度', {
                current: chunkIndex + 1,
                total: chunks.length,
              })
            )
          }

          logger.log(t('record:logs.bulkUpdateSuccess', '批量更新记录成功', { count: totalSuccess }))
          if (mergedErrors.length > 0) {
            logger.warn(t('record:logs.bulkUpdatePartialFailed', '批量更新部分失败'), mergedErrors)
          }

          const updatedRecords = mergedUpdatedRecords.length > 0 ? mergedUpdatedRecords : EMPTY_RECORDS
          if (updatedRecords.length === 0) {
            set({ isLoading: false })
            return { records: [], errors: mergedErrors }
          }

          set(state => {
            const newMap = new Map(state.recordsMap)
            const newIds = [...state.recordIds]
            let addedCount = 0

            for (const updatedRecord of updatedRecords) {
              const existing = newMap.get(updatedRecord.id)
              if (existing) {
                newMap.set(updatedRecord.id, mergeRecord(existing, updatedRecord))
              } else {
                newMap.set(updatedRecord.id, updatedRecord)
                newIds.push(updatedRecord.id)
                addedCount += 1
              }
            }

            const nextRecordVersion = updatedRecords.reduce<number | null>((current, record) => {
              if (typeof record.version !== 'number' || Number.isNaN(record.version)) {
                return current
              }
              if (current == null) {
                return record.version
              }
              return Math.max(current, record.version)
            }, null)

            const nextLatestVersion =
              encodeMonotonicVersionToken(nextRecordVersion) ??
              coerceMonotonicVersionToken(state.latestVersion)
            const nextEtag = nextLatestVersion != null ? buildVersionEtag(nextLatestVersion) : null

            const updatedLookup = new Map(updatedRecords.map(r => [r.id, r]))
            const nextTotal = state.total + addedCount
            return {
              recordsMap: newMap,
              recordIds: newIds,
              records: deriveRecords(newMap, newIds),
              total: nextTotal,
              latestVersion: nextLatestVersion,
              recordsEtag: nextEtag,
              selectedRecord: state.selectedRecord
                ? updatedLookup.get(state.selectedRecord.id) ?? state.selectedRecord
                : state.selectedRecord,
            }
          })

          syncViewRecords({ type: 'mergeMany', patches: new Map(updatedRecords.map(r => [r.id, r])) })

          set({ isLoading: false })
          return { records: updatedRecords, errors: mergedErrors }
        } catch (error) {
          const errorMessage =
            error instanceof Error ? error.message : t('record:apiErrors.bulkUpdateFailed', '批量更新记录失败')
          logger.error('[RecordStore] bulkUpdateRecords failed', errorMessage)
          set({ error: errorMessage, isLoading: false })
          throw error
        }
      },

      bulkDeleteRecords: async (
        recordIds: string[],
        options?: { operation_group_id?: string | null }
      ) => {
        set({ isLoading: true, error: null })
        try {
          const operationGroupId = options?.operation_group_id ?? createOperationGroupId()
          const chunks = chunkArray(recordIds, CLIENT_BULK_CHUNK_SIZE)
          let totalSuccess = 0
          const mergedErrors: string[] = []
          const deletedIds: string[] = []
          const failedIds: string[] = []

          for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex += 1) {
            const chunk = chunks[chunkIndex]
            try {
              const result = await recordService.bulkDeleteRecords({
                record_ids: chunk,
                operation_group_id: operationGroupId,
              })
              totalSuccess += result.success_count
              if (result.errors.length > 0) {
                mergedErrors.push(...result.errors.map(message => `[分批 ${chunkIndex + 1}/${chunks.length}] ${message}`))
              }
              const chunkDeleted =
                result.deleted_record_ids ??
                (result.errors.length === 0 ? chunk : [])
              const chunkFailed =
                result.failed_record_ids ??
                (result.errors.length > 0
                  ? chunk.filter(id => !chunkDeleted.includes(id))
                  : [])
              deletedIds.push(...chunkDeleted)
              failedIds.push(...chunkFailed)
            } catch (chunkError) {
              const msg = chunkError instanceof Error ? chunkError.message : String(chunkError)
              mergedErrors.push(
                t('record:errors.chunkFailed', '[分批 {{current}}/{{total}}] {{message}}（{{count}} 条受影响）', {
                  current: chunkIndex + 1, total: chunks.length, message: msg, count: chunk.length,
                })
              )
              failedIds.push(...chunk)
              logger.error(`[RecordStore] bulkDelete chunk ${chunkIndex + 1}/${chunks.length} failed`, msg)
            }
            logger.log(
              t('record:logs.bulkProgress', '批量执行进度', {
                current: chunkIndex + 1,
                total: chunks.length,
              })
            )
          }

          if (mergedErrors.length === 0) {
            logger.log(t('record:logs.bulkDeleteSuccess', '批量删除记录成功', { count: totalSuccess }))
          }
          if (mergedErrors.length > 0) {
            logger.warn(t('record:logs.bulkDeletePartialFailed', '批量删除部分失败'), mergedErrors)
          }

          const tableId = get().currentTableId
          const currentPage = get().page
          const currentPageSize = get().pageSize

          if (tableId) {
            await get().loadRecordsByTable(tableId, {
              page: currentPage,
              page_size: currentPageSize,
            })
          } else {
            set(state => {
              if (deletedIds.length === 0) {
                return { isLoading: false }
              }
              const idSet = new Set(deletedIds)
              const newMap = new Map(state.recordsMap)
              for (const id of deletedIds) {
                newMap.delete(id)
              }
              const newIds = state.recordIds.filter(id => !idSet.has(id))
              const deletedCount = state.recordIds.length - newIds.length
              return {
                recordsMap: newMap,
                recordIds: newIds,
                records: deriveRecords(newMap, newIds),
                total: Math.max(0, state.total - deletedCount),
                selectedRecord:
                  state.selectedRecord && idSet.has(state.selectedRecord.id)
                    ? null
                    : state.selectedRecord,
                isLoading: false,
              }
            })
          }
          return {
            ok: mergedErrors.length === 0,
            deletedIds,
            failedIds,
            errors: mergedErrors,
          }
        } catch (error) {
          const errorMessage =
            error instanceof Error ? error.message : t('record:apiErrors.bulkDeleteFailed', '批量删除记录失败')
          logger.error('[RecordStore] bulkDeleteRecords failed', errorMessage)
          set({ error: errorMessage, isLoading: false })
          throw error
        }
      },

      mergeIncrementalRecords: (records: TableRecord[], newVersion: number) => {
        _pendingMergeRecords.push(...records)
        _pendingMergeVersion = Math.max(_pendingMergeVersion, newVersion)

        if (!_mergeFlushScheduled) {
          _mergeFlushScheduled = true
          queueMicrotask(_flushIncrementalMerge)
        }
      },

      mergeRestoredRecords: (tableId: string, records: TableRecord[], options) => {
        const scopedRecords = records.filter(record => record.table_id === tableId)
        if (scopedRecords.length === 0) return

        const incomingVersion = Math.max(
          coerceMonotonicVersionToken(options?.newVersion) ?? 0,
          ...scopedRecords.map(record => coerceMonotonicVersionToken(record.version) ?? 0),
        )

        set(state => {
          if (state.currentTableId && state.currentTableId !== tableId) {
            return {}
          }

          const newMap = new Map(state.recordsMap)
          const newIds = [...state.recordIds]
          let addedCount = 0
          const appendMissingRecords = state.searchQuery.trim().length === 0

          for (const record of scopedRecords) {
            const existing = newMap.get(record.id)
            if (existing) {
              const safeOrder = record.order === 0 && existing.order !== 0 ? existing.order : record.order
              newMap.set(record.id, { ...mergeRecord(existing, record), order: safeOrder })
            } else if (appendMissingRecords) {
              newMap.set(record.id, record)
              newIds.push(record.id)
              addedCount += 1
            }
          }

          const nextLatestVersion =
            incomingVersion > 0
              ? incomingVersion
              : coerceMonotonicVersionToken(state.latestVersion)

          return {
            recordsMap: newMap,
            recordIds: newIds,
            records: deriveRecords(newMap, newIds),
            total: options?.incrementTotal ? state.total + addedCount : Math.max(state.total, newIds.length),
            matchedTotal: options?.incrementTotal ? state.matchedTotal + addedCount : Math.max(state.matchedTotal, newIds.length),
            latestVersion: nextLatestVersion,
            recordsEtag: nextLatestVersion != null ? buildVersionEtag(nextLatestVersion) : state.recordsEtag,
          }
        })

        if (options?.syncView === false) return

        const stateAfterMerge = get()
        if (stateAfterMerge.currentTableId && stateAfterMerge.currentTableId !== tableId) {
          return
        }
        const visibleIds = new Set(stateAfterMerge.recordIds)
        const patches = new Map(
          scopedRecords
            .filter(record => visibleIds.has(record.id))
            .map(record => [record.id, record]),
        )
        if (patches.size === 0) return
        syncViewRecords({ type: 'mergeMany', patches })
      },

      removeRecordsByIds: (recordIds: string[], newVersion?: number) => {
        if (recordIds.length === 0) return

        logger.log(
          t('record:logs.removeByIds', '移除记录', {
            count: recordIds.length,
          })
        )

        const idSet = new Set(recordIds)
        set(state => {
          const newMap = new Map(state.recordsMap)
          for (const id of recordIds) {
            newMap.delete(id)
          }
          const newIds = state.recordIds.filter(id => !idSet.has(id))
          const nextTotal = Math.max(0, state.total - idSet.size)
          const nextVersion =
            coerceMonotonicVersionToken(newVersion) ?? coerceMonotonicVersionToken(state.latestVersion)

          return {
            recordsMap: newMap,
            recordIds: newIds,
            records: deriveRecords(newMap, newIds),
            total: nextTotal,
            matchedTotal: state.searchQuery.trim().length === 0
              ? Math.min(state.matchedTotal, nextTotal)
              : state.matchedTotal,
            latestVersion: nextVersion,
            recordsEtag: nextVersion != null ? buildVersionEtag(nextVersion) : state.recordsEtag,
            selectedRecord:
              state.selectedRecord && idSet.has(state.selectedRecord.id) ? null : state.selectedRecord,
          }
        })
      },

      getRecordById: (id: string) => {
        return get().recordsMap.get(id)
      },

      selectRecord: (record: TableRecord | null) => {
        set({ selectedRecord: record })
      },

      reset: () => {
        _resetGeneration += 1
        recordLoadPromises.clear()
        _pendingMergeRecords = []
        _pendingMergeVersion = 0
        _mergeFlushScheduled = false
        _pendingOptimisticCounts.clear()
        set({
          recordsMap: EMPTY_RECORD_MAP,
          recordIds: EMPTY_STRING_LIST,
          records: EMPTY_RECORDS,
          selectedRecord: null,
          total: 0,
          page: 1,
          pageSize: DEFAULT_RECORD_PAGE_SIZE,
          searchQuery: '',
          sortBy: 'created_at',
          sortOrder: 'desc',
          isLoading: false,
          error: null,
          currentTableId: null,
          matchedTotal: 0,
          latestVersion: null,
          recordsEtag: null,
          requestedFields: null,
          syncRequestedAt: 0,
          lastConflicts: [],
        })
      },

      clearError: () => {
        set({ error: null })
      },
    }
  }
}
