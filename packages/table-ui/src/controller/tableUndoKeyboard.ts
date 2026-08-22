/**
 * 表级 Cmd/Ctrl+Z 键盘守卫：哪些焦点目标应留给「原生编辑器 undo」，
 * 哪些应交给表级 undo（Yjs / REST 时间线）。
 *
 * 与 canvas Grid 的焦点哨兵约定：`data-grid-focus-trap`
 *（见 `@tabtin/table-engine-canvas` EditorContainer）。
 */
export const GRID_FOCUS_TRAP_ATTR = 'data-grid-focus-trap'

/** 单元格编辑器浮层：未进入编辑态时焦点可能落在内部 input/textarea 上 */
export const GRID_CELL_EDITOR_OVERLAY_ATTR = 'data-grid-overlay'
export const GRID_CELL_EDITOR_OVERLAY_VALUE = 'cell-editor'
export const GRID_CELL_EDITING_ATTR = 'data-grid-editing'

/**
 * 返回 true 时，document 级表撤销快捷键应忽略该按键目标
 *（避免抢走单元格编辑器 / 代码编辑器的原生撤销）。
 */
export function shouldDeferTableUndoToNativeEditor(
  target: EventTarget | null,
): boolean {
  if (!(target instanceof HTMLElement)) return false

  if (
    target.isContentEditable ||
    target.closest('[data-no-table-undo]') ||
    target.closest('.cm-editor') ||
    target.closest('.monaco-editor')
  ) {
    return true
  }

  const tag = target.tagName
  if (tag === 'TEXTAREA' || tag === 'SELECT' || tag === 'INPUT') {
    // 非编辑态 Grid 把焦点放在零尺寸哨兵 input 上；此处必须放行表级 undo。
    if (target.hasAttribute(GRID_FOCUS_TRAP_ATTR)) return false

    // 选中态但未编辑：EditorContainer 仍可能把焦点落到 TextEditor 的 textarea/input。
    // 该浮层 data-grid-editing="false" 时不应当成原生编辑器撤销。
    const overlay = target.closest(
      `[${GRID_CELL_EDITOR_OVERLAY_ATTR}="${GRID_CELL_EDITOR_OVERLAY_VALUE}"]`,
    )
    if (
      overlay instanceof HTMLElement &&
      overlay.getAttribute(GRID_CELL_EDITING_ATTR) === 'false'
    ) {
      return false
    }

    return true
  }

  return false
}

/**
 * 刷子拖拽等手势常用 preventDefault，焦点会落到 body / html（或 activeElement 为空）。
 * 这类「文档级兜底焦点」不算离开表格，活跃表 pane 仍应响应 Cmd/Ctrl+Z。
 */
export function isDocumentFallbackFocus(el: Element | null): boolean {
  if (!el) return true
  const doc = el.ownerDocument
  return el === doc.body || el === doc.documentElement
}

/**
 * 表级 undo 快捷键是否应在当前焦点下触发（对齐 useUndoRedo document 监听）。
 * 覆盖「刷子填充后焦点在 trap / body / idle cell editor」这类场景的判定。
 */
export function shouldHandleTableUndoShortcut(params: {
  activeElement: Element | null
  eventTarget: EventTarget | null
  container: HTMLElement | null
  /** 当前表 pane 是否为活跃 tab；非活跃时绝不抢快捷键 */
  isActive?: boolean
}): boolean {
  const { activeElement, eventTarget, container, isActive = true } = params
  if (!isActive) return false

  if (container && activeElement && !container.contains(activeElement)) {
    // 焦点在聊天输入框 / 其它面板：不抢。body/html 泄漏则放行。
    if (!isDocumentFallbackFocus(activeElement)) return false
  }

  if (shouldDeferTableUndoToNativeEditor(eventTarget)) return false
  // keydown 的 target 有时是 body，同时真正可编辑焦点在别处——再看 activeElement
  if (
    eventTarget !== activeElement &&
    shouldDeferTableUndoToNativeEditor(activeElement)
  ) {
    return false
  }

  return true
}
