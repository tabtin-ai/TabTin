import type { StateCreator } from 'zustand'
import type { Slide } from '../../types/slides'

export interface HistoryStoreState {
  undoStack: Slide[][]
  redoStack: Slide[][]
  /** 是否处于协作 undo/redo 模式 */
  isCollabMode: boolean

  /** @internal 协作模式注入的函数（存于 store 内，避免模块级变量多实例冲突） */
  _collabUndoFn: (() => void) | null
  _collabRedoFn: (() => void) | null
  _collabCanUndoFn: (() => boolean) | null
  _collabCanRedoFn: (() => boolean) | null

  /** @internal debounce / 去重状态 */
  _lastPushedPages: Slide[] | null
  _debounceLocked: boolean
  _debounceTimer: ReturnType<typeof setTimeout> | null

  canUndo: () => boolean
  canRedo: () => boolean
  /** 保存当前状态快照（立即推入）。协作模式下为 no-op。 */
  pushSnapshot: (pages: Slide[]) => void
  /**
   * 带 debounce 的快照推入（leading-edge, 300ms 窗口）。
   * 连续快速调用（如滑块拖拽、颜色微调）只在首次调用时推入快照，
   * 窗口期内的后续调用静默跳过，避免栈被密集操作填满。
   */
  pushSnapshotDebounced: (pages: Slide[]) => void
  /** 撤销，返回恢复的页面数据。协作模式下返回 null（变更由 Y.js observer 推送）。 */
  undo: (currentPages: Slide[]) => Slide[] | null
  /** 重做，返回恢复的页面数据。协作模式下返回 null。 */
  redo: (currentPages: Slide[]) => Slide[] | null
  clear: () => void
  /**
   * 注入协作模式的 undo/redo 函数。
   *
   * 调用后进入协作模式，pushSnapshot 变为 no-op，
   * undo/redo 委托给注入的函数。
   *
   * 传 null 退出协作模式，恢复 legacy 快照行为。
   */
  setCollabUndoRedo: (fns: {
    undo: () => void
    redo: () => void
    canUndo: () => boolean
    canRedo: () => boolean
  } | null) => void
}

export type HistoryStoreSet = Parameters<StateCreator<HistoryStoreState>>[0]
export type HistoryStoreGet = () => HistoryStoreState
