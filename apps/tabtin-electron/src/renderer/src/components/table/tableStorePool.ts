/**
 * 表格 Store 池化管理 — Electron 宿主
 *
 * 使用 @tabtin/table-core 的共享 createTableStorePool 工厂，
 * 注入 Electron 端的 store 创建函数和重置注册。
 */

import { createTableStorePool } from '@tabtin/table-core'
import { createRecordStore, type RecordStoreApi } from '@stores/useRecordStore'
import { createTableStore, type TableStoreApi } from '@stores/useTableStore'
import { createViewStore, type ViewStoreApi } from '@stores/useViewStore'
import { registerResetAction } from '@/stores/sessionResetRegistry'

const pool = createTableStorePool<TableStoreApi, ViewStoreApi, RecordStoreApi>({
  createTableStore: () => createTableStore(),
  createViewStore: () => createViewStore(),
  createRecordStore: (options) => createRecordStore({ viewStore: options?.viewStore }),
  registerResetAction,
  resetActionName: 'table-store-pools',
})

export const getOrCreateTableStore = pool.getOrCreateTableStore
export const getOrCreateViewStore = pool.getOrCreateViewStore
export const getOrCreateRecordStore = pool.getOrCreateRecordStore
export const peekViewStoreForTable = pool.peekViewStoreForTable
export const retainStoreForTable = pool.retainStoreForTable
export const releaseStoreForTable = pool.releaseStoreForTable
export const forceRebuildStoreForTable = pool.forceRebuildStoreForTable
export const resetAllStorePools = pool.resetAllStorePools

export function createEmbeddedTableStorePool(parentDocumentId: string) {
  const requestHeaders = {
    'X-TabTin-Parent-Document-Id': parentDocumentId,
  }
  return createTableStorePool<TableStoreApi, ViewStoreApi, RecordStoreApi>({
    createTableStore: () => createTableStore(false, requestHeaders),
    createViewStore: () => createViewStore(requestHeaders),
    createRecordStore: (options) => createRecordStore({
      viewStore: options?.viewStore,
      requestHeaders,
    }),
  })
}
