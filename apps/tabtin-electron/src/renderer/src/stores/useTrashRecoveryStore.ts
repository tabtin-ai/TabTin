/** @store-category domain */

/**
 * Trash Recovery Store
 *
 * W1.4 / C2(老软删恢复降级标记)+ 后续 Wave 2 字段回收站
 *
 * 职责:
 * - 记录"本会话内"被恢复但 degraded 的 record_id 集合,供:
 *   1. DataGridAdapter 给行加角标 / 行 hover tooltip
 *   2. RecordEditor / TrashDialog 显示降级标识
 * - 切表时按 table_id 自动隔离(避免老表的 degraded id 污染当前表)
 * - 不持久化:仅 session 内有效,刷新页面后清空(因为后端在恢复成功后该 record
 *   就是普通的"空数据"行,无需永久标记)
 */
import { create } from 'zustand'

interface TrashRecoveryState {
  /** key = tableId, value = degraded record_id 集合 */
  degradedByTable: Record<string, Set<string>>

  /** 标记一批 record 为降级(C2 老软删兜底) */
  markDegraded: (tableId: string, recordIds: string[]) => void

  /** 检查某个 record 是否处于降级状态 */
  isDegraded: (tableId: string, recordId: string) => boolean

  /** 拿到某表的所有降级 record_id(供 banner / 角标渲染) */
  getDegraded: (tableId: string) => string[]

  /** 用户主动清除某个 record 的降级标记(已确认) */
  clearDegradedRecord: (tableId: string, recordId: string) => void

  /** 切表时清空当前表的 degraded(避免污染) */
  clearForTable: (tableId: string) => void

  reset: () => void
}

export const useTrashRecoveryStore = create<TrashRecoveryState>((set, get) => ({
  degradedByTable: {},

  markDegraded: (tableId, recordIds) => {
    if (!tableId || !Array.isArray(recordIds) || recordIds.length === 0) return
    set((state) => {
      const existing = state.degradedByTable[tableId] ?? new Set<string>()
      const next = new Set(existing)
      for (const id of recordIds) {
        if (id) next.add(String(id))
      }
      return {
        degradedByTable: { ...state.degradedByTable, [tableId]: next },
      }
    })
  },

  isDegraded: (tableId, recordId) => {
    if (!tableId || !recordId) return false
    const set_ = get().degradedByTable[tableId]
    return Boolean(set_?.has(String(recordId)))
  },

  getDegraded: (tableId) => {
    if (!tableId) return []
    const set_ = get().degradedByTable[tableId]
    return set_ ? Array.from(set_) : []
  },

  clearDegradedRecord: (tableId, recordId) => {
    if (!tableId || !recordId) return
    set((state) => {
      const existing = state.degradedByTable[tableId]
      if (!existing || !existing.has(String(recordId))) return state
      const next = new Set(existing)
      next.delete(String(recordId))
      if (next.size === 0) {
        const { [tableId]: _removed, ...rest } = state.degradedByTable
        return { degradedByTable: rest }
      }
      return {
        degradedByTable: { ...state.degradedByTable, [tableId]: next },
      }
    })
  },

  clearForTable: (tableId) => {
    if (!tableId) return
    set((state) => {
      if (!state.degradedByTable[tableId]) return state
      const { [tableId]: _removed, ...rest } = state.degradedByTable
      return { degradedByTable: rest }
    })
  },

  reset: () => set({ degradedByTable: {} }),
}))
