import { useCallback, type Key, type RefObject } from 'react'
import { useConversationViewport } from '../../viewport/useConversationViewport'
import { useTaskEpisodeVirtualizer } from '../../viewport/useTaskEpisodeVirtualizer'
import type { TurnNavigatorEntry } from '../../turn/turnNavigator'
import { useBottomMarkerVisibility } from './useBottomMarkerVisibility'
import { useMessageEnterMotion } from './useMessageEnterMotion'
import { useMessageListNavigation } from './useMessageListNavigation'
import { useMessageListViewportLifecycle } from './useMessageListViewportLifecycle'
import type { ConversationViewportEvent } from '../../viewport/types'

export interface UseMessageListScrollStrategyInput {
  parentRef: RefObject<HTMLDivElement | null>
  contentElementRef: RefObject<HTMLDivElement | null>
  scrollElement: HTMLDivElement | null
  contentElement: HTMLDivElement | null
  bottomMarkerElement: HTMLDivElement | null
  itemCount: number
  getItemKey: (index: number) => Key
  estimateSize: (index: number) => number
  lastItemContentVersion: unknown
  messageEnterKeys: readonly string[]
  awaitingThoughtHandoffKeys: ReadonlySet<string>
  turnEntries: TurnNavigatorEntry[]
  resolveMessageIndex: (messageId: string) => number
  scopeKey: string | null
  isForeground: boolean
  isRestoringSession: boolean
  isStreaming: boolean
  showAwaitingThoughtPlaceholder: boolean
  beginTurnEnd: () => void
  isLoadingMore?: boolean
  hasMore?: boolean
  onLoadMore?: () => void
  scrollTargetMessageId?: string | null
  scrollTargetHighlight: boolean
  onScrollTargetReached?: () => void
  messageNotInWindowText: string
}

export function useMessageListScrollStrategy({
  parentRef,
  contentElementRef,
  scrollElement,
  contentElement,
  bottomMarkerElement,
  itemCount,
  getItemKey,
  estimateSize,
  lastItemContentVersion,
  messageEnterKeys,
  awaitingThoughtHandoffKeys,
  turnEntries,
  resolveMessageIndex,
  scopeKey,
  isForeground,
  isRestoringSession,
  isStreaming,
  showAwaitingThoughtPlaceholder,
  beginTurnEnd,
  isLoadingMore,
  hasMore,
  onLoadMore,
  scrollTargetMessageId,
  scrollTargetHighlight,
  onScrollTargetReached,
  messageNotInWindowText,
}: UseMessageListScrollStrategyInput) {
  const isBottomMarkerVisible = useBottomMarkerVisibility(scrollElement, bottomMarkerElement)
  const {
    mode: viewportMode,
    showReturnToLatest,
    dispatch: dispatchViewport,
  } = useConversationViewport({
    scrollElement,
    contentElement,
    enabled: isForeground,
    scopeKey,
  })

  const virtualizer = useTaskEpisodeVirtualizer({
    scrollElementRef: parentRef,
    itemCount,
    getItemKey,
    estimateSize,
    viewportMode,
    enabled: isForeground,
  })

  const handleUserMessageExpand = useCallback(
    (messageId: string) => {
      dispatchViewport({
        type: 'user-read-here',
        source: 'expand',
        messageKey: messageId,
      })
    },
    [dispatchViewport],
  )

  const scrollToBottomFromSend = useCallback(() => {
    dispatchViewport({ type: 'follow-latest', source: 'send' })
  }, [dispatchViewport])

  const scrollToBottomFromReturnButton = useCallback(() => {
    dispatchViewport({ type: 'follow-latest', source: 'return-button' })
  }, [dispatchViewport])

  const notifyLayoutChanged = useCallback((reason: Extract<ConversationViewportEvent, { type: 'layout-changed' }>['reason']) => {
    dispatchViewport({
      type: 'layout-changed',
      reason,
    })
  }, [dispatchViewport])

  const {
    highlightedMessageId,
    highlightKeyRef,
    turnEntries: navigationTurnEntries,
    handleTurnSelect,
    clearNavigationHighlight,
  } = useMessageListNavigation({
    itemCount,
    turnEntries,
    resolveMessageIndex,
    virtualizer,
    dispatchViewport,
    scrollTargetMessageId,
    scrollTargetHighlight,
    onScrollTargetReached,
    messageNotInWindowText,
  })

  useMessageListViewportLifecycle({
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
    onSessionChanged: clearNavigationHighlight,
  })

  useMessageEnterMotion({
    contentElementRef,
    messageEnterKeys,
    scopeKey,
    isRestoringSession,
    showAwaitingThoughtPlaceholder,
    awaitingThoughtHandoffKeys,
  })

  return {
    virtualizer,
    isBottomMarkerVisible,
    showReturnToLatest,
    highlightedMessageId,
    highlightKey: String(highlightKeyRef.current),
    turnEntries: navigationTurnEntries,
    handleTurnSelect,
    handleUserMessageExpand,
    scrollToBottomFromSend,
    scrollToBottomFromReturnButton,
    notifyLayoutChanged,
  }
}
