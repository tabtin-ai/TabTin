/**
 * Monaco / 文件预览共用的代码选区载荷与浮动条定位。
 */

export interface CodeSelectionAnchor {
  /** 选区顶部相对视口（CSS px） */
  top: number
  /** 选区底部相对视口 */
  bottom: number
  /** 选区水平中心相对视口 */
  centerX: number
}

export interface CodeSelectionData {
  text: string
  startLine: number
  endLine: number
  /** 视口坐标；用于选区上方浮动条。滚动后需重新计算。 */
  anchor?: CodeSelectionAnchor
}

export const CODE_SELECTION_TOOLBAR_HEIGHT = 36
export const CODE_SELECTION_TOOLBAR_GAP = 8
export const CODE_SELECTION_FLIP_THRESHOLD = 56

export interface CodeSelectionToolbarPosition {
  top: number
  left: number
  placement: 'above' | 'below'
}

/** 根据选区锚点与视口计算浮动条 fixed 位置（水平居中、上下翻转）。 */
export function resolveCodeSelectionToolbarPosition(
  anchor: CodeSelectionAnchor,
  options?: {
    toolbarHeight?: number
    gap?: number
    flipThreshold?: number
    viewportWidth?: number
    viewportHeight?: number
    toolbarWidth?: number
  },
): CodeSelectionToolbarPosition {
  const toolbarHeight = options?.toolbarHeight ?? CODE_SELECTION_TOOLBAR_HEIGHT
  const gap = options?.gap ?? CODE_SELECTION_TOOLBAR_GAP
  const flipThreshold = options?.flipThreshold ?? CODE_SELECTION_FLIP_THRESHOLD
  const viewportWidth = options?.viewportWidth ?? (typeof window !== 'undefined' ? window.innerWidth : 1280)
  const toolbarWidth = options?.toolbarWidth ?? 280

  const aboveY = anchor.top - toolbarHeight - gap
  const placement: 'above' | 'below' = aboveY >= flipThreshold ? 'above' : 'below'
  const top = placement === 'above' ? aboveY : anchor.bottom + gap

  const half = toolbarWidth / 2
  const left = Math.min(
    viewportWidth - half - 8,
    Math.max(half + 8, anchor.centerX),
  )

  return { top, left, placement }
}
