import type { DropSide } from './canvas-drag-types'
import { EDGE_SQUEEZE_SIZE } from './canvas-drag-types'

type SqueezeQueryRoot = ParentNode | null | undefined

const resolveQueryRoot = (root?: SqueezeQueryRoot): ParentNode | null => {
  if (root) return root
  return typeof document === 'undefined' ? null : document
}

/**
 * 获取 pane 内部的内容容器（带白底/边框的那层）
 * 结构：[data-canvas-pane-id] > div.rounded-md
 */
export const getPaneContentElement = (
  paneId: string,
  root?: SqueezeQueryRoot,
): HTMLElement | null => {
  const paneEl = resolveQueryRoot(root)?.querySelector<HTMLElement>(
    `[data-canvas-pane-id="${paneId}"]`,
  )
  if (!paneEl) return null
  return paneEl.querySelector<HTMLElement>(':scope > div') ?? paneEl
}

/**
 * 获取内容区域根元素
 */
export const getContentRootElement = (root?: SqueezeQueryRoot): HTMLElement | null => {
  if (
    typeof HTMLElement !== 'undefined' &&
    root instanceof HTMLElement &&
    root.dataset.canvasContentRoot === 'true'
  ) {
    return root
  }
  return resolveQueryRoot(root)?.querySelector<HTMLElement>(
    '[data-canvas-content-root="true"]',
  ) ?? null
}

/**
 * 获取 group 内部的布局容器（用于 dock 时挤压整个分屏组）
 * 结构：[data-canvas-group-id] > div
 */
export const getGroupContentElement = (
  groupId: string,
  root?: SqueezeQueryRoot,
): HTMLElement | null => {
  const groupEl = resolveQueryRoot(root)?.querySelector<HTMLElement>(
    `[data-canvas-group-id="${groupId}"]:not([data-canvas-pane-id])`,
  )
  if (!groupEl) return null
  return groupEl.querySelector<HTMLElement>(':scope > div') ?? groupEl
}

export const resetSqueezeStyles = (el: HTMLElement) => {
  el.style.transition = 'margin 150ms ease-out, width 150ms ease-out, height 150ms ease-out'
  el.style.marginTop = ''
  el.style.marginRight = ''
  el.style.marginBottom = ''
  el.style.marginLeft = ''
  el.style.width = ''
  el.style.height = ''
  el.style.boxSizing = 'border-box'
}

/**
 * 清除所有挤压效果（包括 pane 和内容区域）
 */
export const clearAllSqueezeEffects = (root?: SqueezeQueryRoot) => {
  const queryRoot = resolveQueryRoot(root)
  if (!queryRoot) return
  // 清除 pane 内容容器的挤压效果
  queryRoot.querySelectorAll<HTMLElement>('[data-canvas-pane-id] > div').forEach(el => {
    resetSqueezeStyles(el)
  })
  // 清除 group 容器的挤压效果
  queryRoot.querySelectorAll<HTMLElement>('[data-canvas-group-id] > div').forEach(el => {
    resetSqueezeStyles(el)
  })
  // 清除内容区域的挤压效果
  const contentRoot = getContentRootElement(root)
  if (contentRoot) {
    resetSqueezeStyles(contentRoot)
  }
  // 清除非 canvas 场景的内容面板挤压
  queryRoot.querySelectorAll<HTMLElement>('[data-table-tab-id], [data-table-pane-slot], [data-crawlspace-view-id], [data-terminal-pane-id]').forEach(el => {
    resetSqueezeStyles(el)
  })
}

/**
 * 应用挤压效果到指定元素
 * 通过 margin + width/height 缩放内容容器
 */
export const applySqueezeToElement = (el: HTMLElement, side: DropSide) => {
  resetSqueezeStyles(el)

  const squeezeSize = `${EDGE_SQUEEZE_SIZE}px`
  if (side === 'left' || side === 'right') {
    el.style.width = `calc(100% - ${squeezeSize})`
    if (side === 'left') {
      el.style.marginLeft = squeezeSize
    } else {
      el.style.marginRight = squeezeSize
    }
    return
  }

  el.style.height = `calc(100% - ${squeezeSize})`
  if (side === 'top') {
    el.style.marginTop = squeezeSize
  } else {
    el.style.marginBottom = squeezeSize
  }
}

/**
 * 应用挤压效果到指定 pane
 */
export const applySqueezeEffect = (
  paneId: string,
  side: DropSide,
  root?: SqueezeQueryRoot,
) => {
  const paneContentEl = getPaneContentElement(paneId, root)
  if (!paneContentEl) return
  applySqueezeToElement(paneContentEl, side)
}

/**
 * 应用挤压效果到内容区域（用于 create-group 场景）
 */
export const applySqueezeToContentRoot = (side: DropSide, root?: SqueezeQueryRoot) => {
  const contentRoot = getContentRootElement(root)
  if (!contentRoot) return
  applySqueezeToElement(contentRoot, side)
}
