/** @store-category domain */

/**
 * 表格 Store（Electron 宿主包装层）
 *
 * 领域逻辑在 @tabtin/table-core/domain，此文件仅注入宿主服务。
 */

import { createStore, type StoreApi } from 'zustand'
import type { StateCreator } from 'zustand'
import { persist } from 'zustand/middleware'
import {
  createTableStoreState,
  createTableStorePersistOptions,
  clearTreeLoadedCache,
  clearDebugCounters,
  TableApiService,
  FieldApiService,
  normalizeTable,
  type Table,
  type TableStore,
} from '@tabtin/table-core'
import { createStoreHost, createHostAdapters } from '@tabtin/table-ui'
import i18n from '@/i18n'
import { registerResetAction } from './sessionResetRegistry'
import { useSpaceContextTabsStore } from './useSpaceContextTabsStore'
import { bindTableRequestHeaders } from './bindTableRequestHeaders'

const { translate, logger } = createHostAdapters(i18n)

let globalTableStoreRef: StoreApi<TableStore> | null = null

function patchGlobalTableStore(table: Table): void {
  globalTableStoreRef?.setState((state) => ({
    tables: state.tables.some((item) => item.id === table.id)
      ? state.tables.map((item) => (item.id === table.id ? table : item))
      : [...state.tables, table],
    selectedTable: state.selectedTable?.id === table.id ? table : state.selectedTable,
  }))
}

const tableServiceWithContextSync: typeof TableApiService = Object.assign(Object.create(TableApiService), {
  updateTable: async (tableId: string, data: Parameters<typeof TableApiService.updateTable>[1]) => {
    const table = normalizeTable(await TableApiService.updateTable(tableId, data))
    patchGlobalTableStore(table)
    if (typeof data.name === 'string') {
      useSpaceContextTabsStore.getState().syncOpenResourceTabTitle({
        type: 'tabdata',
        id: tableId,
        title: table.name || data.name,
        spaceId: (table as { space_id?: string | null }).space_id ?? null,
      })
    }
    return table
  },
})

const buildTableStoreCreator = (
  persisted: boolean,
  requestHeaders?: Record<string, string>,
): StateCreator<TableStore> => {
  const baseCreator = createTableStoreState({
    tableService: bindTableRequestHeaders(tableServiceWithContextSync, requestHeaders),
    fieldService: bindTableRequestHeaders(FieldApiService, requestHeaders),
    translate,
    logger,
  })
  if (!persisted) return baseCreator
  return persist(
    baseCreator,
    createTableStorePersistOptions(),
  ) as unknown as StateCreator<TableStore>
}

export const createTableStore = (
  persisted = false,
  requestHeaders?: Record<string, string>,
) => createStore<TableStore>()(buildTableStoreCreator(persisted, requestHeaders))

export type TableStoreApi = ReturnType<typeof createTableStore>

const {
  store: tableStore,
  Provider: TableStoreProvider,
  useStore: useTableStore,
  useStoreApi: useTableStoreApi,
} = createStoreHost<TableStore>(createTableStore(true))

globalTableStoreRef = tableStore

export { tableStore, TableStoreProvider, useTableStore, useTableStoreApi }

type CreateTableInSpace = TableStore['createTableInSpace']
type CreateTable = TableStore['createTable']

export const useCreateTableInSpace = () =>
  useTableStore((state) => state.createTableInSpace)

export const useCreateTable = () =>
  useTableStore((state) => state.createTable)

export const createTableInSpace: CreateTableInSpace = (...args) =>
  tableStore.getState().createTableInSpace(...args)

export const createTable: CreateTable = (...args) =>
  tableStore.getState().createTable(...args)

registerResetAction('table', 'reset', () => tableStore.getState().clearAll())

registerResetAction('table-core-caches', 'cleanup', () => {
  clearTreeLoadedCache()
  clearDebugCounters()
})
