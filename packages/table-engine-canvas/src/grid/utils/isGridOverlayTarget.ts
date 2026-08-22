/**
 * Grid editors (date month/year Select、菜单等) 常把内容 portal 到 body。
 * click-away / stage mousedown 若只认容器内节点，会把这些点击误判为「点外面」而关掉编辑器。
 */
const GRID_OVERLAY_OR_PORTAL_SELECTOR = [
  '[data-grid-overlay]',
  '[data-radix-select-content]',
  '[data-radix-popper-content-wrapper]',
  '[data-radix-menu-content]',
  '[data-radix-dropdown-menu-content]',
].join(', ')

export const isGridOverlayTarget = (target: EventTarget | null): boolean =>
  target instanceof Element && Boolean(target.closest(GRID_OVERLAY_OR_PORTAL_SELECTOR))
