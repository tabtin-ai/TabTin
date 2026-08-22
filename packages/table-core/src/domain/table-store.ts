import type { StateCreator } from 'zustand'
import type {
  Table,
  CreateTableRequest,
  UpdateTableRequest,
  TableStats,
  TableQueryParams,
  TableListResponse,
  Field,
  FieldListResponse,
} from '../data'
import {
  getTableSpaceId,
  normalizeTable,
  normalizeTableListResponse,
} from '../data'
import { normalizeFieldType } from '@tabtin/table-kernel'
import { mergeFieldsWithPendingOptimistic } from './merge-fields-with-pending'

export interface TableDetailLoadError {
  message: string
  code: string | null
  status: number | null
}

export interface TableStore extends LoadingState {
  errorCode?: string | null
  errorStatus?: number | null
  /**
   * 单表详情错误必须按 tableId 隔离。
   *
   * 全局 errorCode / errorStatus 保留给旧调用方，但并发加载其他表时会被覆盖，
   * 不能用于裁决某个具体 pane 的权限页。
   */
  tableDetailLoadErrors: Record<string, TableDetailLoadError | undefined>
  tables: Table[]
  selectedTable: Table | null
  fields: Field[]
  /**
   * 协作乐观创建后、REST 尚未返回的字段 id。
   * loadFields 合并时保留这些字段，避免旧快照盖掉刚建的列。
   */
  pendingOptimisticFieldIds: string[]
  tableStats: TableStats | null
  searchQuery: string

  setSearchQuery: (query: string) => void
  clearAll: () => void

  loadTablesBySpace: (
    organizationId: string,
    spaceId: string,
    params?: TableQueryParams
  ) => Promise<void>
  createTableInSpace: (
    organizationId: string,
    spaceId: string,
    data: Omit<CreateTableRequest, 'space_id' | 'organization_id'>
  ) => Promise<Table | null>

  loadTables: (organizationId: string, params?: TableQueryParams) => Promise<void>
  getTable: (tableId: string) => Promise<Table | null>
  createTable: (data: CreateTableRequest) => Promise<Table | null>
  updateTable: (tableId: string, data: UpdateTableRequest) => Promise<Table | null>
  deleteTable: (tableId: string) => Promise<boolean>
  archiveTable: (tableId: string) => Promise<boolean>
  restoreTable: (tableId: string) => Promise<boolean>
  selectTable: (table: Table | null, options?: { force?: boolean }) => void

  loadFields: (tableId: string) => Promise<void>
  /**
   * 乐观写入单个字段到本地 fields（不触网）。
   *
   * 协作在线时新建字段优先写 Y.Doc，但 grid 渲染源是本 store 的 fields；
   * 异步持久化完成前若直接走 REST loadFields 会拿到旧列表、覆盖刚建的字段。
   * 此方法让创建后字段立即出现在渲染源，最终一致性仍由持久化回流校正。
   */
  upsertFieldLocal: (
    tableId: string,
    field: Field,
    insert?: { referenceFieldId: string; position: 'before' | 'after' }
  ) => void
  /**
   * 乐观从本地 fields 移除字段（不触网）。
   *
   * 协作在线删除字段先写 Y.Doc；grid 渲染源仍是本 store 的 fields，
   * 因此需要同步移除本地字段，避免 REST 旧快照回灌前字段在 UI 中回弹。
   */
  removeFieldLocal: (tableId: string, fieldId: string) => void
  loadTableStats: (tableId: string) => Promise<void>
}

export interface LoadingState {
  isLoading: boolean
  error: string | null
}

export interface TableStoreTableService {
  getTablesBySpace: (
    organizationId: string,
    spaceId: string,
    params?: TableQueryParams
  ) => Promise<TableListResponse>
  getAllTablesInOrganization: (organizationId: string, params?: TableQueryParams) => Promise<TableListResponse>
  getTable: (tableId: string) => Promise<Table>
  createTableInSpace: (
    organizationId: string,
    spaceId: string,
    data: Omit<CreateTableRequest, 'space_id' | 'organization_id'>
  ) => Promise<Table>
  createTable: (data: CreateTableRequest) => Promise<Table>
  updateTable: (tableId: string, data: UpdateTableRequest) => Promise<Table>
  deleteTable: (tableId: string) => Promise<void>
  archiveTable: (tableId: string) => Promise<void>
  restoreTable: (tableId: string) => Promise<void>
  getTableStats: (tableId: string) => Promise<TableStats>
}

export interface TableStoreFieldService {
  getFields: (tableId: string) => Promise<FieldListResponse>
}

export interface TableStoreDeps {
  tableService: TableStoreTableService
  fieldService: TableStoreFieldService
  translate?: (key: string, fallback: string) => string
  logger?: Pick<Console, 'log' | 'warn' | 'error'>
}

const defaultLogger: Pick<Console, 'log' | 'warn' | 'error'> = {
  log: (...args: unknown[]) => console.log(...args),
  warn: (...args: unknown[]) => console.warn(...args),
  error: (...args: unknown[]) => console.error(...args),
}

const isValidTableId = (id: string | null | undefined): id is string => {
  if (!id || typeof id !== 'string') return false
  return id.trim() !== ''
}

const isValidTable = (table: unknown): table is Table => {
  return !!table && typeof table === 'object' && isValidTableId((table as Table).id)
}

const tableStoreMigrate = (persistedState: unknown, version: number): unknown => {
  if (version === 0) {
    return {
      selectedTable: null,
    }
  }
  return persistedState
}

const tableStoreMerge = (persistedState: unknown, currentState: TableStore): TableStore => {
  const state = (persistedState ?? {}) as Partial<TableStore>
  const selectedTable = isValidTable(state.selectedTable) ? normalizeTable(state.selectedTable) : null

  return {
    ...currentState,
    ...state,
    selectedTable,
  }
}

export interface CreateTableStorePersistOptionsInput {
  name?: string
}

export const createTableStorePersistOptions = (
  input: CreateTableStorePersistOptionsInput = {}
) => ({
  name: input.name ?? 'tabtin-table-store',
  partialize: (state: TableStore) => ({
    selectedTable: state.selectedTable,
  }),
  version: 1,
  migrate: tableStoreMigrate,
  merge: tableStoreMerge,
})

export const createTableStoreState = (deps: TableStoreDeps): StateCreator<TableStore> => {
  const { tableService, fieldService, translate, logger = defaultLogger } = deps

  const t = (key: string, fallback: string): string => {
    return translate?.(key, fallback) ?? fallback
  }

  return (set, get) => {
    const fieldLoadPromises = new Map<string, Promise<void>>()
    /** 同表 loadFields 请求代数：并发调用只让最新一代真正发请求（尾请求 coalesce）。 */
    const fieldLoadGenerations = new Map<string, number>()
    const statsLoadPromises = new Map<string, Promise<void>>()
    const _loadedSpaces = new Set<string>()

    return {
      tables: [],
      selectedTable: null,
      fields: [],
      pendingOptimisticFieldIds: [],
      tableStats: null,
      searchQuery: '',
      isLoading: false,
      error: null,
      errorCode: null,
      errorStatus: null,
      tableDetailLoadErrors: {},

      setSearchQuery: (query: string) => {
        set({ searchQuery: query })
      },

      clearAll: () => {
        _loadedSpaces.clear()
        fieldLoadGenerations.clear()
        set({
          tables: [],
          selectedTable: null,
          fields: [],
          pendingOptimisticFieldIds: [],
          tableStats: null,
          searchQuery: '',
          isLoading: false,
          error: null,
          errorCode: null,
          errorStatus: null,
          tableDetailLoadErrors: {},
        })
        logger.log('[TableStore] data cleared')
      },

      loadTablesBySpace: async (organizationId: string, spaceId: string, params?: TableQueryParams) => {
        if (!params && _loadedSpaces.has(spaceId)) return
        set({ isLoading: true, error: null })

        try {
          const response = normalizeTableListResponse(
            await tableService.getTablesBySpace(organizationId, spaceId, params)
          )

          set(state => {
            const otherSpaceTables = state.tables.filter(
              table => getTableSpaceId(table) !== spaceId
            )
            const mergedTables = new Map<string, Table>()
            otherSpaceTables.forEach((table) => {
              mergedTables.set(table.id, normalizeTable(table))
            })
            response.tables.forEach((table) => {
              mergedTables.set(table.id, normalizeTable(table))
            })
            return {
              tables: [...mergedTables.values()],
              isLoading: false,
              error: null,
            }
          })
          _loadedSpaces.add(spaceId)
        } catch (error) {
          const message = error instanceof Error ? error.message : t('table:apiErrors.fetchListFailed', 'load table list failed')
          logger.error('[TableStore] loadTablesBySpace failed', error)
          set({ error: message, isLoading: false })
        }
      },

      createTableInSpace: async (
        organizationId: string,
        spaceId: string,
        data: Omit<CreateTableRequest, 'space_id' | 'organization_id'>
      ) => {
        set({ isLoading: true, error: null })

        try {
          const table = normalizeTable(
            await tableService.createTableInSpace(organizationId, spaceId, data)
          )
          _loadedSpaces.delete(spaceId)
          set(state => ({
            tables: [...state.tables.filter(item => item.id !== table.id), table],
            isLoading: false,
          }))
          return table
        } catch (error) {
          const message = error instanceof Error ? error.message : t('table:apiErrors.createFailed', 'create table failed')
          logger.error('[TableStore] createTableInSpace failed', error)
          set({ error: message, isLoading: false })
          if (error instanceof Error) {
            throw error
          }
          throw new Error(message)
        }
      },

      loadTables: async (organizationId: string, params?: TableQueryParams) => {
        set({ isLoading: true, error: null })

        try {
          const response = normalizeTableListResponse(
            await tableService.getAllTablesInOrganization(organizationId, params)
          )
          set({
            tables: response.tables,
            isLoading: false,
            error: null,
          })
        } catch (error) {
          const message = error instanceof Error ? error.message : t('table:apiErrors.fetchListFailed', 'load table list failed')
          logger.error('[TableStore] loadTables failed', error)
          set({ error: message, isLoading: false })
        }
      },

      getTable: async (tableId: string) => {
        set(state => {
          const { [tableId]: _clearedError, ...remainingTableErrors } = state.tableDetailLoadErrors
          return {
            isLoading: true,
            error: null,
            errorCode: null,
            errorStatus: null,
            tableDetailLoadErrors: remainingTableErrors,
          }
        })

        try {
          const table = normalizeTable(await tableService.getTable(tableId))
          set(state => {
            const { [tableId]: _resolvedError, ...remainingTableErrors } = state.tableDetailLoadErrors
            const existingIndex = state.tables.findIndex(item => item.id === tableId)
            const updatedTables =
              existingIndex >= 0
                ? state.tables.map(item => (item.id === tableId ? table : item))
                : [...state.tables, table]

            return {
              tables: updatedTables,
              selectedTable: state.selectedTable?.id === tableId ? table : state.selectedTable,
              isLoading: false,
              errorCode: null,
              errorStatus: null,
              tableDetailLoadErrors: remainingTableErrors,
            }
          })
          return table
        } catch (error) {
          const message = error instanceof Error ? error.message : t('table:apiErrors.fetchDetailFailed', 'load table detail failed')
          const errorLike = error as { code?: unknown; status?: unknown }
          const errorCode = typeof errorLike?.code === 'string' ? errorLike.code : null
          const errorStatus = typeof errorLike?.status === 'number' ? errorLike.status : null
          logger.error(`[TableStore] getTable failed tableId=${tableId}`, error)
          set(state => ({
            error: message,
            errorCode,
            errorStatus,
            tableDetailLoadErrors: {
              ...state.tableDetailLoadErrors,
              [tableId]: {
                message,
                code: errorCode,
                status: errorStatus,
              },
            },
            isLoading: false,
          }))
          return null
        }
      },

      createTable: async (data: CreateTableRequest) => {
        set({ isLoading: true, error: null })

        try {
          const table = normalizeTable(await tableService.createTable(data))
          set(state => ({
            tables: [...state.tables.filter(item => item.id !== table.id), table],
            isLoading: false,
          }))
          return table
        } catch (error) {
          // ：与 createTableInSpace 一致——写入 store error 后重新抛出，
          // 让 useCreateHandlers.onError 能展示配额/权限等可读提示，避免静默失败。
          const message = error instanceof Error ? error.message : t('table:apiErrors.createFailed', 'create table failed')
          logger.error('[TableStore] createTable failed', error)
          set({ error: message, isLoading: false })
          if (error instanceof Error) {
            throw error
          }
          throw new Error(message)
        }
      },

      updateTable: async (tableId: string, data: UpdateTableRequest) => {
        set({ isLoading: true, error: null })

        try {
          const table = normalizeTable(await tableService.updateTable(tableId, data))
          set(state => ({
            tables: state.tables.map(item => (item.id === tableId ? table : item)),
            selectedTable: state.selectedTable?.id === tableId ? table : state.selectedTable,
            isLoading: false,
          }))
          return table
        } catch (error) {
          const message = error instanceof Error ? error.message : t('table:apiErrors.updateFailed', 'update table failed')
          logger.error('[TableStore] updateTable failed', error)
          set({ error: message, isLoading: false })
          return null
        }
      },

      deleteTable: async (tableId: string) => {
        set({ isLoading: true, error: null })

        try {
          await tableService.deleteTable(tableId)
          set(state => ({
            tables: state.tables.filter(item => item.id !== tableId),
            selectedTable: state.selectedTable?.id === tableId ? null : state.selectedTable,
            isLoading: false,
          }))
          return true
        } catch (error) {
          const message = error instanceof Error ? error.message : t('table:apiErrors.deleteFailed', 'delete table failed')
          logger.error('[TableStore] deleteTable failed', error)
          set({ error: message, isLoading: false })
          return false
        }
      },

      archiveTable: async (tableId: string) => {
        set({ isLoading: true, error: null })

        try {
          await tableService.archiveTable(tableId)
          await get().getTable(tableId)
          return true
        } catch (error) {
          const message = error instanceof Error ? error.message : t('table:apiErrors.archiveFailed', 'archive table failed')
          logger.error('[TableStore] archiveTable failed', error)
          set({ error: message, isLoading: false })
          return false
        }
      },

      restoreTable: async (tableId: string) => {
        set({ isLoading: true, error: null })

        try {
          await tableService.restoreTable(tableId)
          await get().getTable(tableId)
          return true
        } catch (error) {
          const message = error instanceof Error ? error.message : t('table:apiErrors.restoreFailed', 'restore table failed')
          logger.error('[TableStore] restoreTable failed', error)
          set({ error: message, isLoading: false })
          return false
        }
      },

      selectTable: (table: Table | null, options?: { force?: boolean }) => {
        if (table && !isValidTable(table)) {
          logger.error('[TableStore] invalid table selected', table)
          set({ selectedTable: null })
          return
        }

        const currentSelected = get().selectedTable
        if (!table && !currentSelected) {
          return
        }

        if (table && currentSelected?.id === table.id && !options?.force) {
          return
        }

        set({
          selectedTable: table ? normalizeTable(table) : null,
          pendingOptimisticFieldIds: [],
        })

        if (table) {
          get().loadFields(table.id)
          get().loadTableStats(table.id)
        } else {
          set({ fields: [], tableStats: null, pendingOptimisticFieldIds: [] })
        }
      },

      loadFields: async (tableId: string) => {
        const nextGen = (fieldLoadGenerations.get(tableId) ?? 0) + 1
        fieldLoadGenerations.set(tableId, nextGen)
        const myGen = nextGen

        // 等待同表 in-flight；结束后仅最新一代真正发请求（连续 create_field 尾请求 coalesce）。
        while (fieldLoadPromises.has(tableId)) {
          await fieldLoadPromises.get(tableId)
        }

        if (fieldLoadGenerations.get(tableId) !== myGen) {
          return
        }

        const loader = (async () => {
          try {
            const response = await fieldService.getFields(tableId)

            if (get().selectedTable?.id !== tableId) {
              return
            }

            const normalizedFields = response.fields.map(f => ({
              ...f,
              field_type: normalizeFieldType(f.field_type),
            }))

            set(state => {
              const { fields: mergedFields, pendingOptimisticFieldIds } =
                mergeFieldsWithPendingOptimistic(
                  normalizedFields,
                  state.fields,
                  state.pendingOptimisticFieldIds,
                )
              const fieldCount = mergedFields.length
              const nextSchemaVersion =
                typeof response.schema_version === 'number' ? response.schema_version : undefined

              const applyTableMeta = <T extends { field_count?: number; schema_version?: number }>(
                table: T,
              ): T => {
                const fieldChanged = table.field_count !== fieldCount
                const schemaChanged =
                  nextSchemaVersion !== undefined && table.schema_version !== nextSchemaVersion
                if (!fieldChanged && !schemaChanged) return table
                return {
                  ...table,
                  ...(fieldChanged ? { field_count: fieldCount } : {}),
                  ...(schemaChanged ? { schema_version: nextSchemaVersion } : {}),
                }
              }

              const currentTable = state.tables.find(table => table.id === tableId)
              const patchedCurrent = currentTable ? applyTableMeta(currentTable) : null
              const tables =
                currentTable && patchedCurrent && patchedCurrent !== currentTable
                  ? state.tables.map(table => (table.id === tableId ? patchedCurrent : table))
                  : state.tables

              const selectedTable =
                state.selectedTable?.id === tableId
                  ? applyTableMeta(state.selectedTable)
                  : state.selectedTable

              return {
                fields: mergedFields,
                pendingOptimisticFieldIds,
                tables,
                selectedTable,
              }
            })
          } catch (error) {
            logger.error('[TableStore] loadFields failed', error)

            if (get().selectedTable?.id !== tableId) {
              return
            }

            set(state => {
              const pending = new Set(state.pendingOptimisticFieldIds)
              const preserved = state.fields.filter(field => pending.has(field.id))
              if (preserved.length > 0) {
                const fieldCount = preserved.length
                const currentTable = state.tables.find(table => table.id === tableId)
                const shouldUpdateTable = (currentTable?.field_count ?? 0) !== fieldCount
                const selectedTableNeedsUpdate =
                  state.selectedTable?.id === tableId &&
                  state.selectedTable.field_count !== fieldCount
                return {
                  fields: preserved,
                  tables: shouldUpdateTable
                    ? state.tables.map(table =>
                        table.id === tableId ? { ...table, field_count: fieldCount } : table
                      )
                    : state.tables,
                  selectedTable: selectedTableNeedsUpdate
                    ? { ...state.selectedTable!, field_count: fieldCount }
                    : state.selectedTable,
                }
              }

              const selectedTableNeedsUpdate =
                state.selectedTable?.id === tableId && state.selectedTable.field_count !== 0
              const tableNeedsUpdate = state.tables.some(
                table => table.id === tableId && (table.field_count ?? 0) !== 0
              )

              return {
                fields: [],
                pendingOptimisticFieldIds: [],
                tables: tableNeedsUpdate
                  ? state.tables.map(table =>
                      table.id === tableId ? { ...table, field_count: 0 } : table
                    )
                  : state.tables,
                selectedTable: selectedTableNeedsUpdate
                  ? { ...state.selectedTable!, field_count: 0 }
                  : state.selectedTable,
              }
            })
          }
        })()

        fieldLoadPromises.set(tableId, loader)
        try {
          await loader
        } finally {
          if (fieldLoadPromises.get(tableId) === loader) {
            fieldLoadPromises.delete(tableId)
          }
        }
      },

      upsertFieldLocal: (tableId, field, insert) => {
        set(state => {
          if (state.selectedTable?.id !== tableId) {
            return {}
          }

          const existingIndex = state.fields.findIndex(f => f.id === field.id)
          const without = state.fields.filter(f => f.id !== field.id)
          let insertIndex = existingIndex >= 0 && !insert ? existingIndex : without.length
          if (insert) {
            const refIndex = without.findIndex(f => f.id === insert.referenceFieldId)
            if (refIndex >= 0) {
              insertIndex = insert.position === 'before' ? refIndex : refIndex + 1
            }
          }

          const nextFields = [
            ...without.slice(0, insertIndex),
            field,
            ...without.slice(insertIndex),
          ].map((f, idx) => (f.sort_order === idx ? f : { ...f, sort_order: idx }))

          const fieldCount = nextFields.length
          const currentTable = state.tables.find(table => table.id === tableId)
          const shouldUpdateTable = (currentTable?.field_count ?? 0) !== fieldCount
          const selectedTableNeedsUpdate =
            state.selectedTable?.id === tableId && state.selectedTable.field_count !== fieldCount
          const pendingOptimisticFieldIds = state.pendingOptimisticFieldIds.includes(field.id)
            ? state.pendingOptimisticFieldIds
            : [...state.pendingOptimisticFieldIds, field.id]

          return {
            fields: nextFields,
            pendingOptimisticFieldIds,
            tables: shouldUpdateTable
              ? state.tables.map(table =>
                  table.id === tableId ? { ...table, field_count: fieldCount } : table
                )
              : state.tables,
            selectedTable: selectedTableNeedsUpdate
              ? { ...state.selectedTable!, field_count: fieldCount }
              : state.selectedTable,
          }
        })
      },

      removeFieldLocal: (tableId, fieldId) => {
        set(state => {
          if (state.selectedTable?.id !== tableId) {
            return {}
          }

          const without = state.fields.filter(field => field.id !== fieldId)
          if (without.length === state.fields.length) {
            return {}
          }

          const nextFields = without.map((field, idx) =>
            field.sort_order === idx ? field : { ...field, sort_order: idx }
          )
          const fieldCount = nextFields.length
          const currentTable = state.tables.find(table => table.id === tableId)
          const shouldUpdateTable = (currentTable?.field_count ?? 0) !== fieldCount
          const selectedTableNeedsUpdate =
            state.selectedTable?.id === tableId && state.selectedTable.field_count !== fieldCount

          return {
            fields: nextFields,
            pendingOptimisticFieldIds: state.pendingOptimisticFieldIds.filter(id => id !== fieldId),
            tables: shouldUpdateTable
              ? state.tables.map(table =>
                  table.id === tableId ? { ...table, field_count: fieldCount } : table
                )
              : state.tables,
            selectedTable: selectedTableNeedsUpdate
              ? { ...state.selectedTable!, field_count: fieldCount }
              : state.selectedTable,
          }
        })
      },

      loadTableStats: async (tableId: string) => {
        const existingPromise = statsLoadPromises.get(tableId)
        if (existingPromise) {
          await existingPromise
          return
        }

        const loader = (async () => {
          try {
            const stats = await tableService.getTableStats(tableId)

            if (get().selectedTable?.id !== tableId) {
              return
            }

            set(state => {
              const currentTable = state.tables.find(table => table.id === tableId)
              const currentCount = currentTable?.row_count ?? 0
              const shouldUpdateTable = currentCount !== stats.record_count
              const selectedTableNeedsUpdate =
                state.selectedTable?.id === tableId && state.selectedTable.row_count !== stats.record_count

              return {
                tableStats: stats,
                tables: shouldUpdateTable
                  ? state.tables.map(table =>
                      table.id === tableId ? { ...table, row_count: stats.record_count } : table
                    )
                  : state.tables,
                selectedTable: selectedTableNeedsUpdate
                  ? { ...state.selectedTable!, row_count: stats.record_count }
                  : state.selectedTable,
              }
            })
          } catch (error) {
            logger.error('[TableStore] loadTableStats failed', error)

            if (get().selectedTable?.id !== tableId) {
              return
            }

            set(state => {
              const currentTable = state.tables.find(table => table.id === tableId)
              const shouldResetTable = currentTable?.row_count && currentTable.row_count !== 0
              const selectedTableNeedsUpdate =
                state.selectedTable?.id === tableId && state.selectedTable.row_count !== 0

              return {
                tableStats: null,
                tables: shouldResetTable
                  ? state.tables.map(table =>
                      table.id === tableId ? { ...table, row_count: 0 } : table
                    )
                  : state.tables,
                selectedTable: selectedTableNeedsUpdate
                  ? { ...state.selectedTable!, row_count: 0 }
                  : state.selectedTable,
              }
            })
          }
        })()

        statsLoadPromises.set(tableId, loader)
        try {
          await loader
        } finally {
          statsLoadPromises.delete(tableId)
        }
      },
    }
  }
}
