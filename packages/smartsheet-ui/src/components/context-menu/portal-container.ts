export interface ContextMenuPortalContainerOptions {
  overlayContainer: HTMLElement | null
  anchorEl?: HTMLElement | null
  anchorPosition?: { x: number; y: number }
}

export function resolveContextMenuPortalContainer({
  overlayContainer,
  anchorEl,
  anchorPosition,
}: ContextMenuPortalContainerOptions): HTMLElement | null {
  if (!overlayContainer) return null

  // 容器已脱离 document（典型：所属 Space 工作台在画布折叠 / 切走时其 portal 宿主
  // 没有挂载点，整棵子树 detached）时，portal 进去的浮层永远不可见 —— 直接回退到
  // body，避免右键菜单 / Popover 等"打开了却看不见"。
  if (!overlayContainer.isConnected) return null

  if (anchorEl) {
    return overlayContainer.contains(anchorEl) ? overlayContainer : null
  }

  if (!anchorPosition) return overlayContainer

  const rect = overlayContainer.getBoundingClientRect()
  if (rect.width === 0 && rect.height === 0) {
    return overlayContainer
  }

  const isPointInsideContainer =
    anchorPosition.x >= rect.left &&
    anchorPosition.x <= rect.right &&
    anchorPosition.y >= rect.top &&
    anchorPosition.y <= rect.bottom

  return isPointInsideContainer ? overlayContainer : null
}
