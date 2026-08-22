/**
 * UndoTimeline — 会话级统一时间线（只存 source 标记，不复制操作内容）
 *
 * 设计要点：
 * - collab（Yjs）与 backend（REST）操作交错时，按时间线决定下一次 Ctrl+Z 走哪条路径
 * - 新操作 push 到 undo 时清空 redo 标记栈（与常见编辑器语义一致）
 * - undo/redo 失败时用 pushBack* 把标记回栈，避免丢序
 * - forceReconnect 后 clearCollabMarks 修剪所有 collab 标记（Yjs 栈已清空）
 */

export type UndoTimelineSource = 'collab' | 'backend'

export type UndoTimelineListener = () => void

export interface UndoTimeline {
  push(source: UndoTimelineSource): void
  popUndo(): UndoTimelineSource | null
  popRedo(): UndoTimelineSource | null
  peekUndo(): UndoTimelineSource | null
  peekRedo(): UndoTimelineSource | null
  /** 后端 undo 失败时把刚弹出的标记压回 undo 栈顶 */
  pushBackUndo(source: UndoTimelineSource): void
  /** 后端 redo 失败时把刚弹出的标记压回 redo 栈顶 */
  pushBackRedo(source: UndoTimelineSource): void
  /** forceReconnect / Yjs 栈清空后，修剪时间线里所有 collab 标记 */
  clearCollabMarks(): void
  clear(): void
  getUndoDepth(): number
  getRedoDepth(): number
  subscribe(listener: UndoTimelineListener): () => void
}

export function createUndoTimeline(): UndoTimeline {
  const undoStack: UndoTimelineSource[] = []
  const redoStack: UndoTimelineSource[] = []
  const listeners = new Set<UndoTimelineListener>()

  const notify = () => {
    for (const listener of listeners) {
      listener()
    }
  }

  return {
    push(source) {
      undoStack.push(source)
      // 新操作使 redo 历史失效
      redoStack.length = 0
      notify()
    },

    popUndo() {
      if (undoStack.length === 0) return null
      const source = undoStack.pop()!
      redoStack.push(source)
      notify()
      return source
    },

    popRedo() {
      if (redoStack.length === 0) return null
      const source = redoStack.pop()!
      undoStack.push(source)
      notify()
      return source
    },

    peekUndo() {
      return undoStack.length > 0 ? undoStack[undoStack.length - 1]! : null
    },

    peekRedo() {
      return redoStack.length > 0 ? redoStack[redoStack.length - 1]! : null
    },

    pushBackUndo(source) {
      // 失败回栈：从 redo 顶去掉刚 push 的同 source，再压回 undo
      if (redoStack.length > 0 && redoStack[redoStack.length - 1] === source) {
        redoStack.pop()
      }
      undoStack.push(source)
      notify()
    },

    pushBackRedo(source) {
      if (undoStack.length > 0 && undoStack[undoStack.length - 1] === source) {
        undoStack.pop()
      }
      redoStack.push(source)
      notify()
    },

    clearCollabMarks() {
      const nextUndo = undoStack.filter((s) => s !== 'collab')
      const nextRedo = redoStack.filter((s) => s !== 'collab')
      if (nextUndo.length === undoStack.length && nextRedo.length === redoStack.length) {
        return
      }
      undoStack.length = 0
      undoStack.push(...nextUndo)
      redoStack.length = 0
      redoStack.push(...nextRedo)
      notify()
    },

    clear() {
      if (undoStack.length === 0 && redoStack.length === 0) return
      undoStack.length = 0
      redoStack.length = 0
      notify()
    },

    getUndoDepth() {
      return undoStack.length
    },

    getRedoDepth() {
      return redoStack.length
    },

    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}
