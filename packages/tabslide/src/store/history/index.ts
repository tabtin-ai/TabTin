import { create } from 'zustand'
import type { StateCreator } from 'zustand'
import { createHistorySlice } from './action'
import {
  estimateSnapshotBytes,
  MAX_MEMORY_BYTES,
  trimStackByMemory,
} from './helpers'
import { initialHistoryStoreState } from './initial-state'
import type { HistoryStoreState } from './history-store-types'

/**
 * 撤销/重做 — 双模式支持
 *
 * ## Legacy 模式（默认）
 * 基于全量页面快照。pushSnapshot 保存状态，undo/redo 恢复快照。
 *
 * ## Collab 模式（Y.js UndoManager）
 * 当通过 setCollabUndoRedo 注入协作撤销函数后自动切换：
 * - pushSnapshot 变为 no-op（Y.js 事务自动捕获 undo 状态）
 * - undo/redo 委托给 Y.js UndoManager
 * - canUndo/canRedo 读取协作状态
 *
 * 对所有调用方完全透明 — 无需修改任何组件代码。
 */

export type {
  HistoryStoreGet,
  HistoryStoreSet,
  HistoryStoreState,
} from './history-store-types'

const createHistoryStore: StateCreator<HistoryStoreState> = (...params) => ({
  ...initialHistoryStoreState,
  ...createHistorySlice(...params),
})

export const useHistoryStore = create<HistoryStoreState>(createHistoryStore)

/** @internal 仅供单元测试直接验证内存管理逻辑 */
export const __test__ = {
  estimateSnapshotBytes,
  trimStackByMemory,
  MAX_MEMORY_BYTES,
}
