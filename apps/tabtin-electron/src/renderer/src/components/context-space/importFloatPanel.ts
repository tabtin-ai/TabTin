/**
 * 右下角导入/扫描浮层面板（z-toast）与 Dialog mask（z-modal）叠层协作。
 *
 * Radix Dialog Content 开启 disableOutsidePointerEvents 后会把 body 设为
 * pointer-events:none；浮层必须显式 pointer-events-auto，否则点击穿透到
 * mask，outside-dismiss 的 event.target 也落不到面板上。
 */
export const IMPORT_FLOAT_PANEL_ATTR = 'data-import-float-panel'

/** 浮层根节点必带：叠层 + 在 Dialog 锁指针时仍可点击 */
export const IMPORT_FLOAT_PANEL_CLASS =
  'pointer-events-auto fixed z-toast'

type OutsideDismissEvent = {
  target: EventTarget | null
  detail?: { originalEvent?: Event }
}

export function getOutsideDismissEventTarget(
  event: OutsideDismissEvent,
): EventTarget | null {
  return event.detail?.originalEvent?.target ?? event.target
}

export function isImportFloatPanelEventTarget(target: EventTarget | null): boolean {
  return target instanceof Element
    && Boolean(target.closest(`[${IMPORT_FLOAT_PANEL_ATTR}]`))
}

/** 供 Dialog onPointerDownOutside / onInteractOutside / onFocusOutside 共用 */
export function preventDialogDismissOnImportFloatPanel(
  event: OutsideDismissEvent & { preventDefault: () => void },
): void {
  if (isImportFloatPanelEventTarget(getOutsideDismissEventTarget(event))) {
    event.preventDefault()
  }
}
