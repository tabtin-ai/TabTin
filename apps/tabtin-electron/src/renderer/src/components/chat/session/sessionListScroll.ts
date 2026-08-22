export interface SessionVirtualItemPosition {
  index: number
  start: number
  size: number
}

export interface SessionListScrollIntent {
  sessionId: string
  sequence: number
}

interface ShouldScrollToSessionInput {
  targetSessionId: string | null
  scrollIntent: SessionListScrollIntent | null
  lastConsumedIntentSequence: number | null
  targetIndex: number
  virtualItems: readonly SessionVirtualItemPosition[]
  scrollTop: number
  viewportHeight: number
}

function isItemInViewport(
  item: SessionVirtualItemPosition,
  scrollTop: number,
  viewportHeight: number,
): boolean {
  const viewportBottom = scrollTop + viewportHeight
  const itemBottom = item.start + item.size
  return item.start < viewportBottom && itemBottom > scrollTop
}

export function shouldScrollToSession({
  targetSessionId,
  scrollIntent,
  lastConsumedIntentSequence,
  targetIndex,
  virtualItems,
  scrollTop,
  viewportHeight,
}: ShouldScrollToSessionInput): boolean {
  if (!targetSessionId || !scrollIntent || scrollIntent.sessionId !== targetSessionId) {
    return false
  }
  if (
    lastConsumedIntentSequence !== null
    && scrollIntent.sequence <= lastConsumedIntentSequence
  ) {
    return false
  }

  const targetItem = virtualItems.find(item => item.index === targetIndex)
  if (!targetItem) return true

  return !isItemInViewport(targetItem, scrollTop, viewportHeight)
}
