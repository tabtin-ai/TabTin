export interface MenuPosition {
  x: number
  y: number
}

interface MenuSize {
  width: number
  height: number
}

/** 让脱离侧栏的固定定位菜单始终留在当前窗口可见范围内。 */
export function clampMenuPosition(
  anchor: MenuPosition,
  menu: MenuSize,
  viewport: MenuSize,
  inset = 8,
): MenuPosition {
  return {
    x: Math.max(inset, Math.min(anchor.x, viewport.width - menu.width - inset)),
    y: Math.max(inset, Math.min(anchor.y, viewport.height - menu.height - inset)),
  }
}

export function positionConversationMenu(anchor: MenuPosition): MenuPosition {
  return clampMenuPosition(anchor, { width: 176, height: 120 }, {
    width: window.innerWidth,
    height: window.innerHeight,
  })
}
