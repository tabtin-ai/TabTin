/**
 * 表格 Store 池化管理 — Web 宿主
 *
 * 使用 @tabtin/table-core 的共享 createTableStorePool 工厂，
 * 注入 Web 端的 store 创建函数和重置注册。
 */

import { registerResetAction } from '@tabtin/app-shell'
import { createTableStorePool } from '@tabtin/table-core'
import { createRecordStore, type RecordStoreApi } from './useRecordStore'
import { createTableStore, type TableStoreApi } from './useTableStore'
import { createViewStore, type ViewStoreApi } from './useViewStore'

const pool = createTableStorePool<TableStoreApi, ViewStoreApi, RecordStoreApi>({
  createTableStore: () => createTableStore(),
  createViewStore: () => createViewStore(),
  createRecordStore: (options) => createRecordStore({ viewStore: options?.viewStore }),
  registerResetAction,
  resetActionName: 'web-table-store-pools',
})

export const getOrCreateTableStore = pool.getOrCreateTableStore
export const getOrCreateViewStore = pool.getOrCreateViewStore
export const getOrCreateRecordStore = pool.getOrCreateRecordStore
export const retainStoreForTable = pool.retainStoreForTable
export const releaseStoreForTable = pool.releaseStoreForTable
export const forceRebuildStoreForTable = pool.forceRebuildStoreForTable
export const resetAllStorePools = pool.resetAllStorePools
