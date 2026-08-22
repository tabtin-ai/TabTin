import { useCallback, useEffect, useLayoutEffect, useRef, type RefObject } from 'react'
import {
  applyPrependCompensation,
  recoverEmptyVirtualWindow,
  restoreForegroundViewport,
} from '../../viewport/virtualizerViewportBridge'
import type { ConversationViewportEvent, ViewportMode } from '../../viewport/types'

const SCROLL_TOP_THRESHOLD = 100

type VirtualizerLike = {
  measure: () => void
  getVirtualItems: () => readonly unknown[]
  getTotalSize: () => number
  scrollToIndex: (index: number, options: { align: 'end' }) => void
}

export interface UseMessageListViewportLifecycleInput {
  parentRef: RefObject<HTMLDivElement | null>
  scrollElement: HTMLDivElement | null
  itemCount: number
  lastItemContentVersion: unknown
  scopeKey: string | null
  isForeground: boolean
  viewportMode: ViewportMode
  virtualizer: VirtualizerLike
  isLoadingMore?: boolean
  hasMore?: boolean
  onLoadMore?: () => void
  isStreaming: boolean
  dispatchViewport: (event: ConversationViewportEvent) => void
  beginTurnEnd: () => void
  onSessionChanged?: () => void
}

export function useMessageListViewportLifecycle({
  parentRef,
  scrollElement,
  itemCount,
  lastItemContentVersion,
  scopeKey,
  isForeground,
  viewportMode,
  virtualizer,
  isLoadingMore,
  hasMore,
  onLoadMore,
  isStreaming,
  dispatchViewport,
  beginTurnEnd,
  onSessionChanged,
}: UseMessageListViewportLifecycleInput): void {
  const itemCountRef = useRef(itemCount)
  itemCountRef.current = itemCount
  const prevItemCountRef = useRef(itemCount)
  const wasLoadingMoreRef = useRef(false)
  const prevScrollTopRef = useRef(0)
  const prevTotalSizeRef = useRef(0)
  const didFinishHistoryPrependRef = useRef(false)
  const scrollRafRef = useRef<number | null>(null)
  const wasStreamingRef = useRef(isStreaming)
  const scrollScopeRef = useRef(scopeKey)

  useEffect(() => {
    if (!isForeground) return
    const rafId = requestAnimationFrame(() => {
      restoreForegroundViewport({
        measure: () => {
          virtualizer.measure()
        },
        dispatch: dispatchViewport,
      })
    })
    return () => cancelAnimationFrame(rafId)
  }, [isForeground, virtualizer, dispatchViewport])

  useLayoutEffect(() => {
    if (!isForeground || !scrollElement || itemCount === 0) return
    recoverEmptyVirtualWindow({
      mode: viewportMode,
      itemCount,
      virtualItemCount: virtualizer.getVirtualItems().length,
      scrollToIndex: (index, options) => {
        virtualizer.scrollToIndex(index, options)
      },
    })
  }, [isForeground, scrollElement, itemCount, virtualizer, viewportMode])

  useEffect(() => {
    if (wasLoadingMoreRef.current && !isLoadingMore) {
      didFinishHistoryPrependRef.current = true
      const newTotalSize = virtualizer.getTotalSize()
      const sizeDiff = newTotalSize - prevTotalSizeRef.current
      if (sizeDiff > 0 && parentRef.current) {
        const nextScrollTop = prevScrollTopRef.current + sizeDiff
        applyPrependCompensation(dispatchViewport, nextScrollTop)
      }
    }
    wasLoadingMoreRef.current = !!isLoadingMore
  }, [isLoadingMore, parentRef, virtualizer, dispatchViewport])

  useEffect(() => {
    if (didFinishHistoryPrependRef.current) {
      didFinishHistoryPrependRef.current = false
      prevItemCountRef.current = itemCount
      return
    }
    if (itemCount > 0 && !wasLoadingMoreRef.current) {
      const isNewMessageAppended = itemCount > prevItemCountRef.current
      const isContentUpdated = itemCount === prevItemCountRef.current
      if (isNewMessageAppended || isContentUpdated) {
        dispatchViewport({
          type: 'layout-changed',
          reason: 'message-appended',
        })
      }
    }
    prevItemCountRef.current = itemCount
  }, [itemCount, lastItemContentVersion, isLoadingMore, dispatchViewport])

  useLayoutEffect(() => {
    if (wasStreamingRef.current && !isStreaming) {
      dispatchViewport({ type: 'layout-changed', reason: 'turn-ended' })
      beginTurnEnd()
    }
    wasStreamingRef.current = isStreaming
  }, [dispatchViewport, isStreaming, beginTurnEnd])

  useLayoutEffect(() => {
    if (scrollScopeRef.current === scopeKey) return
    scrollScopeRef.current = scopeKey
    const currentItemCount = itemCountRef.current
    prevItemCountRef.current = currentItemCount
    wasLoadingMoreRef.current = false
    prevScrollTopRef.current = 0
    prevTotalSizeRef.current = 0
    didFinishHistoryPrependRef.current = false
    onSessionChanged?.()
    if (currentItemCount === 0) return
    recoverEmptyVirtualWindow({
      mode: { kind: 'follow-latest' },
      itemCount: currentItemCount,
      virtualItemCount: 0,
      scrollToIndex: (index, options) => {
        virtualizer.scrollToIndex(index, options)
      },
    })
  }, [onSessionChanged, scopeKey, virtualizer])

  const handleLoadMoreScroll = useCallback(() => {
    if (!hasMore || isLoadingMore || !onLoadMore) return
    if (scrollRafRef.current != null) return
    scrollRafRef.current = requestAnimationFrame(() => {
      scrollRafRef.current = null
      const container = parentRef.current
      if (!container) return
      if (container.scrollTop < SCROLL_TOP_THRESHOLD) {
        prevScrollTopRef.current = container.scrollTop
        prevTotalSizeRef.current = virtualizer.getTotalSize()
        onLoadMore()
      }
    })
  }, [hasMore, isLoadingMore, onLoadMore, parentRef, virtualizer])

  useEffect(() => {
    const container = parentRef.current
    if (!container) return
    container.addEventListener('scroll', handleLoadMoreScroll, {
      passive: true,
    })
    return () => container.removeEventListener('scroll', handleLoadMoreScroll)
  }, [handleLoadMoreScroll, parentRef])

  useEffect(() => {
    return () => {
      if (scrollRafRef.current) cancelAnimationFrame(scrollRafRef.current)
    }
  }, [])

}
