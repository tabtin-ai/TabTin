/**
 * 跨 React 树边界的 backend 时间线压标记桥接。
 *
 * ViewSwitcher 在 TablePaneHeader（UndoRedoProvider 外），字段删除在 Provider 内；
 * 两者都需要在 schema 操作成功后压 backend 标记，故用 tableId → recorder 注册表。
 */

type Recorder = () => void

const recorders = new Map<string, Recorder>()

export function registerBackendUndoableRecorder(
  tableId: string,
  recorder: Recorder,
): () => void {
  recorders.set(tableId, recorder)
  return () => {
    if (recorders.get(tableId) === recorder) {
      recorders.delete(tableId)
    }
  }
}

export function notifyBackendUndoable(tableId: string): void {
  recorders.get(tableId)?.()
}
