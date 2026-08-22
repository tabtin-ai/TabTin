import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from '@tabtin/smartsheet-ui/toast'
import { navigateToVirtualItem } from '../../viewport/virtualizerViewportBridge'
import type { TurnNavigatorEntry } from '../../turn/turnNavigator'
import type { ConversationViewportEvent } from '../../viewport/types'

type VirtualizerLike = {
  scrollToIndex: (
    index: number,
    options: { align: 'start' | 'center'; behavior: 'smooth' },
  ) => void
}

export interface UseMessageListNavigationInput {
  itemCount: number
  turnEntries: TurnNavigatorEntry[]
  resolveMessageIndex: (messageId: string) => number
  virtualizer: VirtualizerLike
  dispatchViewport: (event: ConversationViewportEvent) => void
  scrollTargetMessageId?: string | null
  scrollTargetHighlight: boolean
  onScrollTargetReached?: () => void
  messageNotInWindowText: string
}

export function useMessageListNavigation({
  itemCount,
  turnEntries,
  resolveMessageIndex,
  virtualizer,
  dispatchViewport,
  scrollTargetMessageId,
  scrollTargetHighlight,
  onScrollTargetReached,
  messageNotInWindowText,
}: UseMessageListNavigationInput) {
  const [highlightedMessageId, setHighlightedMessageId] = useState<string | null>(null)
  const highlightKeyRef = useRef(0)
  const turnHighlightTimerRef = useRef<number | null>(null)

  const clearNavigationHighlight = useCallback(() => {
    setHighlightedMessageId(null)
    highlightKeyRef.current += 1
  }, [])

  const handleTurnSelect = useCallback(
    (entry: TurnNavigatorEntry) => {
      navigateToVirtualItem({
        messageKey: entry.id,
        index: entry.index,
        align: 'start',
        dispatch: dispatchViewport,
        scrollToIndex: (index, options) => {
          virtualizer.scrollToIndex(index, options)
        },
      })
      highlightKeyRef.current += 1
      setHighlightedMessageId(entry.id)
      if (turnHighlightTimerRef.current != null) window.clearTimeout(turnHighlightTimerRef.current)
      turnHighlightTimerRef.current = window.setTimeout(() => setHighlightedMessageId(null), 1500)
    },
    [virtualizer, dispatchViewport],
  )

  useEffect(
    () => () => {
      if (turnHighlightTimerRef.current != null) window.clearTimeout(turnHighlightTimerRef.current)
    },
    [],
  )

  useEffect(() => {
    if (!scrollTargetMessageId || itemCount === 0) return
    const idx = resolveMessageIndex(scrollTargetMessageId)
    if (idx >= 0) {
      navigateToVirtualItem({
        messageKey: scrollTargetMessageId,
        index: idx,
        align: 'center',
        dispatch: dispatchViewport,
        scrollToIndex: (index, options) => {
          virtualizer.scrollToIndex(index, options)
        },
      })
      if (scrollTargetHighlight) {
        highlightKeyRef.current += 1
        setHighlightedMessageId(scrollTargetMessageId)
        onScrollTargetReached?.()
        const timer = setTimeout(() => setHighlightedMessageId(null), 1500)
        return () => clearTimeout(timer)
      }
      onScrollTargetReached?.()
      return
    }

    const missingTimer = setTimeout(() => {
      const fresh = resolveMessageIndex(scrollTargetMessageId)
      if (fresh < 0) {
        toast.info(messageNotInWindowText)
        onScrollTargetReached?.()
      }
    }, 800)
    return () => clearTimeout(missingTimer)
  }, [
    scrollTargetMessageId,
    scrollTargetHighlight,
    itemCount,
    resolveMessageIndex,
    virtualizer,
    onScrollTargetReached,
    dispatchViewport,
    messageNotInWindowText,
  ])

  return {
    highlightedMessageId,
    highlightKeyRef,
    turnEntries,
    handleTurnSelect,
    clearNavigationHighlight,
  }
}
