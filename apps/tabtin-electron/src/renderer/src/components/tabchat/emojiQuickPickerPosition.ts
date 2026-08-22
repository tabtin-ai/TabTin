/**
 * EmojiQuickPicker 视口避让：面板挂 body(fixed) 后按锚点计算位置，
 * 避免贴侧栏 / 贴顶底时被裁切。
 */

export const EMOJI_QUICK_PICKER_WIDTH = 248
/** compact 8×4 网格的近似高度（含 padding），用于先选上下再微调 */
export const EMOJI_QUICK_PICKER_ESTIMATED_HEIGHT = 130
export const EMOJI_QUICK_PICKER_GAP = 6
export const EMOJI_QUICK_PICKER_VIEWPORT_MARGIN = 8

export type EmojiQuickPickerAlign = 'start' | 'end'
export type EmojiQuickPickerPlacement = 'above' | 'below'

export interface ViewportBounds {
  left: number
  right: number
  top: number
  bottom: number
}

export interface EmojiQuickPickerPosition {
  top: number
  left: number
  placement: EmojiQuickPickerPlacement
}

export function resolveEmojiQuickPickerBounds(
  viewportEl: Element | null | undefined,
  viewWidth: number,
  viewHeight: number,
  margin = EMOJI_QUICK_PICKER_VIEWPORT_MARGIN,
): ViewportBounds {
  if (viewportEl) {
    const rect = viewportEl.getBoundingClientRect()
    return {
      left: rect.left + margin,
      right: rect.right - margin,
      top: rect.top + margin,
      bottom: rect.bottom - margin,
    }
  }
  return {
    left: margin,
    right: viewWidth - margin,
    top: margin,
    bottom: viewHeight - margin,
  }
}

export function resolveEmojiQuickPickerPosition({
  anchorRect,
  bounds,
  align,
  panelWidth = EMOJI_QUICK_PICKER_WIDTH,
  panelHeight = EMOJI_QUICK_PICKER_ESTIMATED_HEIGHT,
  gap = EMOJI_QUICK_PICKER_GAP,
}: {
  anchorRect: Pick<DOMRect, 'top' | 'bottom' | 'left' | 'right'>
  bounds: ViewportBounds
  align: EmojiQuickPickerAlign
  panelWidth?: number
  panelHeight?: number
  gap?: number
}): EmojiQuickPickerPosition {
  const preferredLeft = align === 'end'
    ? anchorRect.right - panelWidth
    : anchorRect.left
  const maxLeft = bounds.right - panelWidth
  const left = Number.isFinite(preferredLeft)
    ? Math.max(bounds.left, Math.min(preferredLeft, maxLeft))
    : bounds.left

  const spaceAbove = anchorRect.top - bounds.top
  const spaceBelow = bounds.bottom - anchorRect.bottom
  const need = panelHeight + gap
  const canFitAbove = spaceAbove >= need
  const canFitBelow = spaceBelow >= need
  const placement: EmojiQuickPickerPlacement =
    canFitAbove || (!canFitBelow && spaceAbove >= spaceBelow) ? 'above' : 'below'

  if (placement === 'above') {
    const top = anchorRect.top - gap - panelHeight
    return {
      placement,
      left,
      top: Math.max(bounds.top, top),
    }
  }

  const top = anchorRect.bottom + gap
  return {
    placement,
    left,
    top: Math.min(top, Math.max(bounds.top, bounds.bottom - panelHeight)),
  }
}
