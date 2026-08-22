/**
 * Web 端 TabDoc 表格嵌入 Store 运行时
 *
 * 与 Electron 版 createElectronTabDocTableEmbedRuntime 对等实现，
 * 使用 Web 端的 tableStorePool 提供 store 池化管理。
 */
import type { TabDocTableEmbedRuntime } from '@tabtin/tabdoc-ui'
import {
  getOrCreateTableStore,
  getOrCreateViewStore,
  getOrCreateRecordStore,
  retainStoreForTable,
  releaseStoreForTable,
  forceRebuildStoreForTable,
} from '@/stores/table/tableStorePool'

const STORE_RETAIN_SAFETY_TIMEOUT_MS = 5 * 60 * 1000

export function createWebTabDocTableEmbedRuntime(): TabDocTableEmbedRuntime {
  const retainCounts = new Map<string, number>()
  const retainSafetyTimers = new Map<string, ReturnType<typeof setTimeout>>()

  function resetSafetyTimer(tableId: string) {
    const prevTimer = retainSafetyTimers.get(tableId)
    if (prevTimer != null) {
      clearTimeout(prevTimer)
    }
    const timer = setTimeout(() => {
      const count = retainCounts.get(tableId) ?? 0
      console.warn(
        `[webTabDocTableEmbedRuntime] safety net triggered: tableId=${tableId} ` +
        `retain count=${count}, exceeded ${STORE_RETAIN_SAFETY_TIMEOUT_MS / 1000}s without release, force-releasing`,
      )
      for (let i = 0; i < count; i++) {
        releaseStoreForTable(tableId)
      }
      retainCounts.delete(tableId)
      retainSafetyTimers.delete(tableId)
    }, STORE_RETAIN_SAFETY_TIMEOUT_MS)
    retainSafetyTimers.set(tableId, timer)
  }

  return {
    getOrCreateStores(tableId) {
      const tableStoreApi = getOrCreateTableStore(tableId)
      const viewStoreApi = getOrCreateViewStore(tableId)
      const recordStoreApi = getOrCreateRecordStore(tableId, viewStoreApi)
      return {
        tableStore: tableStoreApi,
        viewStore: viewStoreApi,
        recordStore: recordStoreApi,
      }
    },

    retainStore(tableId) {
      retainStoreForTable(tableId)
      const count = (retainCounts.get(tableId) ?? 0) + 1
      retainCounts.set(tableId, count)
      resetSafetyTimer(tableId)
    },

    releaseStore(tableId) {
      const count = retainCounts.get(tableId) ?? 0
      if (count <= 1) {
        retainCounts.delete(tableId)
        const timer = retainSafetyTimers.get(tableId)
        if (timer != null) {
          clearTimeout(timer)
          retainSafetyTimers.delete(tableId)
        }
      } else {
        retainCounts.set(tableId, count - 1)
        resetSafetyTimer(tableId)
      }
      releaseStoreForTable(tableId)
    },

    rebuildStore(tableId) {
      forceRebuildStoreForTable(tableId)
    },
  }
}
