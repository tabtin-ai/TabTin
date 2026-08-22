import { GRID_FOCUS_TRAP_ATTR } from '../controller/tableUndoKeyboard'

/**
 * Restore keyboard focus to the TabData canvas grid after overlays
 * (FieldMenu / ConfirmDialog / FieldDeleteConfirmDialog) close.
 *
 * useUndoRedo 在焦点落在 pane 内（或 body/html 文档兜底焦点）时处理 Ctrl+Z。
 * 弹层关闭后仍优先拉回 focus-trap，避免焦点漂到其它可编辑区域。
 */
export function restoreTableGridFocus(): void {
  if (typeof document === 'undefined') return

  const grid =
    document.querySelector<HTMLElement>('[data-t-grid-view] [data-t-grid-container]') ??
    document.querySelector<HTMLElement>('[data-t-grid-container]')

  if (!grid) return

  const trap = grid.querySelector<HTMLElement>(`[${GRID_FOCUS_TRAP_ATTR}]`)

  requestAnimationFrame(() => {
    ;(trap ?? grid).focus({ preventScroll: true })
  })
}
