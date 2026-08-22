/**
 * Monaco DiffEditor 安全释放：必须先解除 model 引用，再 dispose TextModel。
 * 否则滚动卸载会抛 TextModel got disposed before DiffEditorWidget model got reset。
 */

export interface DisposableLike {
  dispose: () => void
}

export interface DiffEditorDisposeTarget {
  setModel: (model: null) => void
  dispose: () => void
}

export function disposeDiffEditorSafely(
  editor: DiffEditorDisposeTarget | null | undefined,
  originalModel: DisposableLike | null | undefined,
  modifiedModel: DisposableLike | null | undefined,
): void {
  if (editor) {
    try {
      editor.setModel(null)
    } catch {
      /* editor 可能已部分失效 */
    }
  }
  try {
    originalModel?.dispose()
  } catch { /* ignore */ }
  try {
    modifiedModel?.dispose()
  } catch { /* ignore */ }
  if (editor) {
    try {
      editor.dispose()
    } catch { /* ignore */ }
  }
}
