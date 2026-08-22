export const FLOATING_MENU_VIEWPORT_PADDING = 16
export const FLOATING_MENU_PANEL_PADDING = 8
export const FLOATING_MENU_TRIGGER_GAP = 8
export const FLOATING_MENU_MIN_WIDTH = 280
const FLOATING_MENU_MIN_SIZE = 1

export function findFloatingMenuBoundaryRect(trigger: HTMLElement): DOMRect {
  const viewportWidth = window.innerWidth
  const viewportHeight = window.innerHeight
  const fallback = new DOMRect(0, 0, viewportWidth, viewportHeight)
  const triggerRect = trigger.getBoundingClientRect()
  const candidates: DOMRect[] = []
  let node: HTMLElement | null = trigger.parentElement

  while (node && node !== document.body) {
    const rect = node.getBoundingClientRect()
    if (
      rect.width >= FLOATING_MENU_MIN_WIDTH &&
      rect.height >= viewportHeight * 0.5 &&
      rect.left <= triggerRect.left &&
      rect.right >= triggerRect.right &&
      rect.top <= triggerRect.top &&
      rect.bottom >= triggerRect.bottom
    ) {
      candidates.push(rect)
    }
    node = node.parentElement
  }

  return candidates.sort((a, b) => a.width - b.width)[0] ?? fallback
}

export interface FloatingMenuLayout {
  width: number
  height: number
  left: number
  /** 'up' = 菜单在 trigger 上方（用 bottom 定位）；'down' = 下方（用 top 定位） */
  placement: 'up' | 'down'
  /** placement === 'up' 时给出，距视口底部的偏移 */
  bottom?: number
  /** placement === 'down' 时给出，距视口顶部的偏移 */
  top?: number
}

export function resolveFloatingMenuLayout(options: {
  trigger: HTMLElement | null
  maxWidth: number
  minHeight?: number
  contentHeight?: number
}): FloatingMenuLayout {
  const {
    trigger,
    maxWidth,
    minHeight = 160,
    contentHeight = 0,
  } = options
  const viewportWidth = window.innerWidth
  const viewportHeight = window.innerHeight
  const boundaryRect = trigger
    ? findFloatingMenuBoundaryRect(trigger)
    : new DOMRect(0, 0, viewportWidth, viewportHeight)
  const viewportLeftLimit = Math.max(0, viewportWidth - FLOATING_MENU_MIN_SIZE)
  const boundaryLeft = Math.min(
    Math.max(
      boundaryRect.left + FLOATING_MENU_PANEL_PADDING,
      FLOATING_MENU_VIEWPORT_PADDING,
    ),
    viewportLeftLimit,
  )
  const rawBoundaryRight = Math.min(
    boundaryRect.right - FLOATING_MENU_PANEL_PADDING,
    viewportWidth - FLOATING_MENU_VIEWPORT_PADDING,
  )
  const boundaryRight = Math.min(
    viewportWidth,
    Math.max(boundaryLeft + FLOATING_MENU_MIN_SIZE, rawBoundaryRight),
  )
  const boundaryWidth = Math.max(FLOATING_MENU_MIN_SIZE, boundaryRight - boundaryLeft)
  const width = Math.min(maxWidth, boundaryWidth)
  const triggerRect = trigger?.getBoundingClientRect()
  const maxLeft = Math.max(boundaryLeft, boundaryRight - width)
  const left = triggerRect
    ? Math.min(
        Math.max(triggerRect.right - width, boundaryLeft),
        maxLeft,
      )
    : boundaryLeft

  // 无 trigger（极少见兜底）：保持原行为，固定贴底向上。
  if (!triggerRect) {
    const fallbackHeight = Math.min(
      minHeight,
      Math.max(FLOATING_MENU_MIN_SIZE, viewportHeight - FLOATING_MENU_VIEWPORT_PADDING * 2),
    )
    return {
      width,
      height: fallbackHeight,
      left,
      placement: 'up',
      bottom: FLOATING_MENU_VIEWPORT_PADDING,
    }
  }

  // 上 / 下两侧的可用高度，挑空间更足的一侧弹出。
  const spaceAbove = Math.max(
    FLOATING_MENU_MIN_SIZE,
    triggerRect.top - FLOATING_MENU_VIEWPORT_PADDING - FLOATING_MENU_TRIGGER_GAP,
  )
  const spaceBelow = Math.max(
    FLOATING_MENU_MIN_SIZE,
    viewportHeight - triggerRect.bottom - FLOATING_MENU_VIEWPORT_PADDING - FLOATING_MENU_TRIGGER_GAP,
  )
  const desiredHeight = contentHeight > 0
    ? Math.max(minHeight, contentHeight)
    : minHeight

  // 优先向上（与底部输入区一致）；仅当上方放不下且下方空间更大时才翻转向下。
  const placeDown = spaceAbove < desiredHeight && spaceBelow > spaceAbove
  const availableHeight = placeDown ? spaceBelow : spaceAbove
  const height = Math.min(desiredHeight, availableHeight)

  if (placeDown) {
    const rawTop = triggerRect.bottom + FLOATING_MENU_TRIGGER_GAP
    const maxTop = Math.max(
      FLOATING_MENU_VIEWPORT_PADDING,
      viewportHeight - FLOATING_MENU_VIEWPORT_PADDING - height,
    )
    const top = Math.max(
      FLOATING_MENU_VIEWPORT_PADDING,
      Math.min(rawTop, maxTop),
    )
    return { width, height, left, placement: 'down', top }
  }

  const rawBottom = viewportHeight - triggerRect.top + FLOATING_MENU_TRIGGER_GAP
  const maxBottom = Math.max(
    FLOATING_MENU_VIEWPORT_PADDING,
    viewportHeight - FLOATING_MENU_VIEWPORT_PADDING - height,
  )
  const bottom = Math.max(
    FLOATING_MENU_VIEWPORT_PADDING,
    Math.min(rawBottom, maxBottom),
  )

  return { width, height, left, placement: 'up', bottom }
}
