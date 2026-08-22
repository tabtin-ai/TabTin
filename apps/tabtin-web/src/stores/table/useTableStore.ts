/**
 * 表格 Store（Web 宿主包装层）
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
import { registerResetAction } from '@tabtin/app-shell'
import i18n from '@/i18n'

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
    return table
  },
})

const baseCreator: StateCreator<TableStore> = createTableStoreState({
  tableService: tableServiceWithContextSync,
  fieldService: FieldApiService,
  translate,
  logger,
})

const persistedCreator = persist(
  baseCreator,
  createTableStorePersistOptions(),
) as unknown as StateCreator<TableStore>

export const createTableStore = (persisted = false) =>
  createStore<TableStore>()(persisted ? persistedCreator : baseCreator)

export type TableStoreApi = ReturnType<typeof createTableStore>

const {
  store: tableStore,
  Provider: TableStoreProvider,
  useStore: useTableStore,
} = createStoreHost<TableStore>(createTableStore(true))

globalTableStoreRef = tableStore

export { tableStore, TableStoreProvider, useTableStore }

type CreateTableInSpace = TableStore['createTableInSpace']

export const useCreateTableInSpace = () =>
  useTableStore((state) => state.createTableInSpace)

export const createTableInSpace: CreateTableInSpace = (...args) =>
  tableStore.getState().createTableInSpace(...args)

registerResetAction('web-table', 'reset', () => tableStore.getState().clearAll())

registerResetAction('web-table-core-caches', 'cleanup', () => {
  clearTreeLoadedCache()
  clearDebugCounters()
})
