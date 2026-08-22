/**
 * 计算 to-rail morph 的最终矩形：必须与辅位 maxWidth / 主位最低可读宽一致，
 * 否则小窗口下 ghost 会飞向「未夹紧的目标宽」，和真实列宽对不上。
 */
import { LayoutConstraints } from '@/constants/layout'

/** 与 ShellResizableSplits.SHELL_WORKBENCH_MIN_WIDTH / SHELL_WORKSPACE_SPLIT_GAP 对齐 */
const SHELL_WORKBENCH_MIN_WIDTH = 360
const SHELL_WORKSPACE_SPLIT_GAP = 4

export function resolveMorphFinalRailRect(railEl: HTMLElement): DOMRect | undefined {
  const railRect = railEl.getBoundingClientRect()
  const secondaryHost = railEl.closest('[data-shell-secondary-rail]') as HTMLElement | null

  if (secondaryHost) {
    // 聊天在辅位（右侧）：用夹紧后的最终宽，锚在行右缘。
    const rawFinalWidth = Number(secondaryHost.dataset.morphFinalWidth)
    if (!Number.isFinite(rawFinalWidth) || rawFinalWidth <= 0) return undefined
    const row = secondaryHost.parentElement
    if (!row) return undefined
    const rowRect = row.getBoundingClientRect()
    const primaryMin = SHELL_WORKBENCH_MIN_WIDTH
    const maxSecondary = Math.max(0, rowRect.width - primaryMin - SHELL_WORKSPACE_SPLIT_GAP)
    const finalWidth = Math.min(rawFinalWidth, maxSecondary)
    if (finalWidth <= 0) return undefined
    const height = railRect.height > 0 ? railRect.height : rowRect.height
    return new DOMRect(rowRect.right - finalWidth, railRect.top || rowRect.top, finalWidth, height)
  }

  // 聊天在主位（左侧）：辅位最终宽先按主位最低宽夹紧，再反推主位宽。
  const siblingRail = document.querySelector('[data-shell-secondary-rail]') as HTMLElement | null
  const rawSecondaryWidth = siblingRail ? Number(siblingRail.dataset.morphFinalWidth) : NaN
  const row = siblingRail?.parentElement
  if (!row || !Number.isFinite(rawSecondaryWidth) || rawSecondaryWidth <= 0) return undefined
  const rowRect = row.getBoundingClientRect()
  const primaryMin = LayoutConstraints.chatSidePanel.minWidth
  const maxSecondary = Math.max(0, rowRect.width - primaryMin - SHELL_WORKSPACE_SPLIT_GAP)
  const clampedSecondary = Math.min(rawSecondaryWidth, maxSecondary)
  const finalWidth = Math.max(primaryMin, rowRect.width - clampedSecondary)
  if (finalWidth <= 0) return undefined
  const height = railRect.height > 0 ? railRect.height : rowRect.height
  return new DOMRect(rowRect.left, railRect.top || rowRect.top, finalWidth, height)
}
