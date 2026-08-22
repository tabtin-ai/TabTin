/**
 * controller 与 TanStack Virtual 之间的内部 adapter。
 * 不持有产品状态，不成为第二 scroll owner——只翻译校正门控与物化命令。
 */

import { recordConversationViewportWrite } from './conversationViewportProbe'
import type { ConversationViewportEvent, ViewportMode } from './types'

export type MeasuredSizeAdjustInput = {
  mode: ViewportMode
  itemStart: number
  itemEnd: number
  scrollOffset: number
  scrollAdjustments?: number
}

/** 纯谓词：无探针副作用，可被其它调用安全复用。 */
export function evaluateShouldAdjustForMeasuredSizeChange(
  _input: MeasuredSizeAdjustInput,
): boolean {
  // Size changes are reconciled by the viewport controller: follow mode targets the legal
  // bottom and reading mode restores a visual anchor. Letting TanStack also mutate scrollTop
  // creates a second owner and can double-compensate the same resize.
  return false
}

/**
 * TanStack measured-size callback adapter（MessageList 已调用此导出）。
 * 仅在将要调整时记一次 virtualizer 写；false 路径不记账。
 */
export function shouldAdjustForMeasuredSizeChange(
  input: MeasuredSizeAdjustInput,
): boolean {
  const shouldAdjust = evaluateShouldAdjustForMeasuredSizeChange(input)
  if (shouldAdjust) {
    recordConversationViewportWrite('virtualizer-size-adjust', undefined, 'virtualizer')
  }
  return shouldAdjust
}

export function applyPrependCompensation(
  dispatch: (event: ConversationViewportEvent) => void,
  scrollTop: number,
): void {
  // prepend 经 controller write seam 记账，此处不额外 virtualizer 记账，避免双计。
  dispatch({ type: 'history-prepended', scrollTop })
}

export function navigateToVirtualItem(input: {
  messageKey: string
  index: number
  align: 'start' | 'center'
  dispatch: (event: ConversationViewportEvent) => void
  scrollToIndex: (
    index: number,
    options: { align: 'start' | 'center'; behavior: 'smooth' },
  ) => void
}): void {
  input.dispatch({
    type: 'navigate',
    messageKey: input.messageKey,
    align: input.align,
  })
  recordConversationViewportWrite('navigate', undefined, 'virtualizer')
  input.scrollToIndex(input.index, {
    align: input.align,
    behavior: 'smooth',
  })
}

export function restoreForegroundViewport(input: {
  measure: () => void
  dispatch: (event: ConversationViewportEvent) => void
}): void {
  // measure 可能触发 size adjust；由 shouldAdjust adapter 单独记账，此处不记。
  input.measure()
  input.dispatch({ type: 'layout-changed', reason: 'foreground-restored' })
}

export function recoverEmptyVirtualWindow(input: {
  mode: ViewportMode
  itemCount: number
  virtualItemCount: number
  scrollToIndex: (index: number, options: { align: 'end' }) => void
}): boolean {
  if (input.mode.kind !== 'follow-latest') return false
  if (input.itemCount <= 0) return false
  if (input.virtualItemCount !== 0) return false
  recordConversationViewportWrite('empty-window', undefined, 'virtualizer')
  input.scrollToIndex(input.itemCount - 1, { align: 'end' })
  return true
}
