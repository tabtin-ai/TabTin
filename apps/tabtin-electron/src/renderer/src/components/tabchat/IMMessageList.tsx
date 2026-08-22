/**
 * IMMessageList — 消息列表（react-virtuoso 虚拟滚动）
 *
 * 支持：向上加载历史、新消息自动滚动、"回到底部"按钮。
 */

import React, { useRef, useCallback, useEffect, useLayoutEffect, useState, useMemo, forwardRef, useImperativeHandle } from 'react'
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso'
import { Loader2, ArrowDown, MessageSquare } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { toast } from '@tabtin/smartsheet-ui'
import { IMMessageBubble } from './IMMessageBubble'
import { useIMStore } from '@stores/useIMStore'
import { useAuthStore } from '@stores/useAuthStore'
import type { IMMessage } from '@/services/tabchatApi'
import { CONVERSATION_TYPE_DM, CONVERSATION_TYPE_GROUP } from '@/constants/tabchat'
import { VirtuosoHoverScroller } from '@components/common/VirtuosoHoverScroller'
import { OVERLAY_SURFACE_CLASS } from '@components/ui'
import { useScopedResizeObserver } from '@hooks/spaceActivity'
import { IMMessageScrollLockProvider } from './imMessageScrollLock'
import { IM_SCROLL_TO_BOTTOM_RIGHT } from './tabchatUi'
import { GroupCreatedAtMarker } from './GroupCreatedAtMarker'
import { messageStableKey } from '@/services/im/messageMerge'

// Virtuoso firstItemIndex 起点：足够大，向前加载历史时递减不会触底。
const START_ITEM_INDEX = 1_000_000
const AUTO_LOCATE_MAX_PAGES = 20
const AUTO_STICK_TO_BOTTOM_MS = 1000
const AUTO_STICK_MAX_FRAMES = 40
const AUTO_STICK_STABLE_FRAMES = 2
const BOTTOM_EPSILON_PX = 2
const NAVIGATION_HIGHLIGHT_DURATION_MS = 2000
/** 搜索/引用跳转定位窗口：抑制贴底，避免长消息高度回稳把视图拽回底部 */
const NAVIGATION_LOCATE_SUPPRESS_MS = 1800
const NAVIGATION_SCROLL_RETRY_MS = 120
// 预先测量一段反向历史，避免图片行首次进入视口时从文本行高度膨胀。
const HISTORY_MEASURE_AHEAD_ITEMS = 15

/** 命令式 API —— 用户发送消息后强制滚底（绕过 isAtBottom 守卫，对齐 Agent MessageList） */
export interface IMMessageListHandle {
  scrollToBottom: () => void
}

interface Props {
  messages: IMMessage[]
  conversationId?: string
  isLoading: boolean
  isInitialLoading?: boolean
  onLoadMore: () => Promise<boolean | void>
  onReply?: (message: IMMessage) => void
  onOpenReplyThread?: (message: IMMessage) => void
  onReEdit?: (content: string) => void
  onEdit?: (message: IMMessage) => void
  canManagePins?: boolean
  agentMemberIds?: readonly string[]
  currentHumanMemberIds?: readonly string[]
  emptyLabel?: string
  /** 顶部浮动栏（顶栏）高度，作为列表上内衬，避免首条消息被遮挡 */
  topInset?: number
  /** 底部浮动栏（输入框）高度，作为列表下内衬，避免末条消息被遮挡 */
  bottomInset?: number
}

export const IMMessageList = forwardRef<IMMessageListHandle, Props>(function IMMessageList(
  { messages, conversationId, isLoading, isInitialLoading = false, onLoadMore, onReply, onOpenReplyThread, onReEdit, onEdit, canManagePins, agentMemberIds, currentHumanMemberIds, emptyLabel, topInset = 0, bottomInset = 0 },
  ref,
) {
  const { t } = useTranslation('tabchat')
  const replyCountByMessageId = useMemo(() => {
    const counts = new Map<string | number, number>()
    messages.forEach(({ reply_to_id, reply_to_ref }) => {
      const key = reply_to_ref ?? reply_to_id
      if (key != null) counts.set(key, (counts.get(key) ?? 0) + 1)
    })
    return counts
  }, [messages])
  const virtuosoRef = useRef<VirtuosoHandle>(null)
  const scrollerRef = useRef<HTMLDivElement | null>(null)
  const [scrollerEl, setScrollerEl] = useState<HTMLDivElement | null>(null)
  const viewportRef = useRef<HTMLDivElement | null>(null)
  const prevLenRef = useRef(0)
  const prevFirstKeyRef = useRef<string | null>(null)
  const prevLastKeyRef = useRef<string | null>(null)
  // react-virtuoso prepend 锚定：firstItemIndex 必须与 data 增长「同一帧」生效，
  // 否则会有一帧用旧值渲染、把头部插入误判为尾部追加而抖动回弹。因此用渲染期
  // 同步派生（ref 累计），而非 useState（滞后一帧）。
  const firstItemIndexRef = useRef(START_ITEM_INDEX)
  const fiiConvRef = useRef<string | undefined>(undefined)
  const fiiPrevFirstKeyRef = useRef<string | null>(null)
  const fiiPrevLenRef = useRef(0)
  const autoLocateRef = useRef<{ key: string | null; attempts: number; loading: boolean }>({
    key: null,
    attempts: 0,
    loading: false,
  })
  const [isAtBottom, setIsAtBottom] = useState(true)
  const isAtBottomRef = useRef(true)
  const [highlightedMessageId, setHighlightedMessageId] = useState<number | null>(null)
  const [highlightedMessageRef, setHighlightedMessageRef] = useState<string | null>(null)
  const highlightTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const getScrollMetrics = useCallback(() => {
    const el = scrollerRef.current
    if (!el) return null
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
    return {
      scrollTop: Math.round(el.scrollTop),
      scrollHeight: Math.round(el.scrollHeight),
      clientHeight: Math.round(el.clientHeight),
      distanceFromBottom: Math.round(distanceFromBottom),
    }
  }, [])

  const setScrollerNode = useCallback((node: HTMLDivElement | null, forwardedRef: React.ForwardedRef<HTMLDivElement>) => {
    scrollerRef.current = node
    setScrollerEl(node)
    if (typeof forwardedRef === 'function') {
      forwardedRef(node)
    } else if (forwardedRef) {
      forwardedRef.current = node
    }
  }, [])

  // 经典滚动条会吃掉 clientWidth；把差值挂到 layout，供输入井 / 回底按钮与消息列右缘对齐。
  useScopedResizeObserver(scrollerEl, () => {
    const layout = viewportRef.current?.closest('[data-im-chat-layout]') as HTMLElement | null
    if (!scrollerEl || !layout) return
    const compensation = Math.max(0, scrollerEl.offsetWidth - scrollerEl.clientWidth)
    layout.style.setProperty('--im-scrollbar-compensation', `${compensation}px`)
  })

  const VirtuosoScroller = useMemo(() => {
    const Scroller = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>((props, forwardedRef) => (
      <VirtuosoHoverScroller
        {...props}
        ref={(node) => setScrollerNode(node, forwardedRef)}
      />
    ))
    Scroller.displayName = 'IMMessageListVirtuosoScroller'
    return Scroller
  }, [setScrollerNode])

  const userId = useAuthStore((s) => s.user?.id)
  const conversation = useIMStore(
    useCallback((s) => (conversationId ? s.conversations.find((c) => c.id === conversationId) : undefined), [conversationId]),
  )
  const hasMoreMessages = useIMStore(
    useCallback((s) => (conversationId ? s.hasMoreMessages?.[conversationId] : true), [conversationId]),
  )
  const scrollTargetConversationId = useIMStore((s) => s.scrollTargetConversationId)
  const scrollToMessageId = useIMStore((s) => s.scrollToMessageId)
  const scrollToMessageRef = useIMStore((s) => s.scrollToMessageRef)
  const clearScrollTarget = useIMStore((s) => s.clearScrollTarget)
  const retryFailedMessage = useIMStore((s) => s.retryFailedMessage)
  const isDM = conversation?.type === CONVERSATION_TYPE_DM
  const groupCreatedAt = conversation?.type === CONVERSATION_TYPE_GROUP
    && conversation.created_at
    && hasMoreMessages === false
    ? conversation.created_at
    : null

  useEffect(() => {
    setHighlightedMessageId(null)
    if (highlightTimerRef.current) {
      clearTimeout(highlightTimerRef.current)
      highlightTimerRef.current = null
    }
  }, [conversationId])

  const scrollThrottleRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingScrollRef = useRef(false)
  const autoStickUntilRef = useRef(0)
  const stickRafRef = useRef<number | null>(null)
  const stickFrameCountRef = useRef(0)
  const stickStableFrameCountRef = useRef(0)
  const lastStickHeightRef = useRef(0)
  // 加载历史（prepend）期间硬性禁用一切自动贴底，避免被贴底兜底/残留 stick 循环拽到底部。
  const historyLoadUntilRef = useRef(0)
  // 搜索/引用跳转定位期间同样禁用贴底；长消息进视口后高度回稳最容易误触发。
  const navigationLocateUntilRef = useRef(0)
  const navigationScrollRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const isAutoStickActive = useCallback(() => {
    return Date.now() < autoStickUntilRef.current
  }, [])

  const isLoadingHistory = useCallback(() => {
    return Date.now() < historyLoadUntilRef.current
  }, [])

  const isNavigatingToMessage = useCallback(() => {
    return Date.now() < navigationLocateUntilRef.current
  }, [])

  const shouldSuppressAutoStick = useCallback(() => {
    return isLoadingHistory() || isNavigatingToMessage()
  }, [isLoadingHistory, isNavigatingToMessage])

  const forceDomScrollToBottom = useCallback(() => {
    const el = scrollerRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
  }, [])

  const stopBottomStickLoop = useCallback(() => {
    if (stickRafRef.current != null) {
      cancelAnimationFrame(stickRafRef.current)
      stickRafRef.current = null
    }
    stickFrameCountRef.current = 0
    stickStableFrameCountRef.current = 0
    lastStickHeightRef.current = 0
  }, [])

  const beginNavigationLocate = useCallback(() => {
    navigationLocateUntilRef.current = Date.now() + NAVIGATION_LOCATE_SUPPRESS_MS
    autoStickUntilRef.current = 0
    stopBottomStickLoop()
    isAtBottomRef.current = false
    setIsAtBottom(false)
  }, [stopBottomStickLoop])

  const startBottomStickLoop = useCallback(() => {
    autoStickUntilRef.current = Date.now() + AUTO_STICK_TO_BOTTOM_MS
    if (stickRafRef.current != null) return

    stickFrameCountRef.current = 0
    stickStableFrameCountRef.current = 0
    lastStickHeightRef.current = 0

    const tick = () => {
      stickRafRef.current = null

      // 加载历史 / 跳转定位期间不抢滚动，否则会把用户从目标消息拽回底部。
      if (shouldSuppressAutoStick()) {
        stopBottomStickLoop()
        return
      }

      const el = scrollerRef.current
      if (!el) return

      el.scrollTop = el.scrollHeight

      const height = el.scrollHeight
      const distanceFromBottom = height - el.scrollTop - el.clientHeight
      const heightStable = Math.abs(height - lastStickHeightRef.current) <= 1

      if (heightStable && distanceFromBottom <= BOTTOM_EPSILON_PX) {
        stickStableFrameCountRef.current += 1
      } else {
        stickStableFrameCountRef.current = 0
      }

      lastStickHeightRef.current = height
      stickFrameCountRef.current += 1

      const shouldContinue =
        stickFrameCountRef.current < AUTO_STICK_MAX_FRAMES
        && stickStableFrameCountRef.current < AUTO_STICK_STABLE_FRAMES
        && Date.now() <= autoStickUntilRef.current

      if (shouldContinue) {
        stickRafRef.current = requestAnimationFrame(tick)
      } else {
        stickRafRef.current = null
      }
    }

    stickRafRef.current = requestAnimationFrame(tick)
  }, [shouldSuppressAutoStick, stopBottomStickLoop])

  const scrollToBottom = useCallback((behavior: 'auto' | 'smooth' = 'auto') => {
    if (messages.length === 0) return
    startBottomStickLoop()
    const run = (scrollBehavior: 'auto' | 'smooth') => {
      if (messages.length === 0) return
      virtuosoRef.current?.scrollToIndex({
        index: 'LAST',
        align: 'end',
        behavior: scrollBehavior,
      })
      virtuosoRef.current?.autoscrollToBottom()
      if (scrollBehavior === 'auto') {
        // 自动贴底走同步锚定；smooth 在内容高度继续变化时容易产生追尾抖动。
        forceDomScrollToBottom()
        startBottomStickLoop()
      }
      isAtBottomRef.current = true
      setIsAtBottom(true)
      pendingScrollRef.current = false
    }
    requestAnimationFrame(() => requestAnimationFrame(() => run(behavior)))
  }, [forceDomScrollToBottom, messages.length, startBottomStickLoop])

  const handleTotalListHeightChanged = useCallback(() => {
    // 加载历史 / 跳转定位导致的高度变化绝不贴底（长消息回稳时尤甚）。
    if (shouldSuppressAutoStick()) return
    const metrics = getScrollMetrics()
    const shouldStick =
      isAutoStickActive()
      || isAtBottomRef.current
      || (metrics != null && metrics.distanceFromBottom <= BOTTOM_EPSILON_PX)
    if (!shouldStick) return
    forceDomScrollToBottom()
    if (isAutoStickActive()) {
      startBottomStickLoop()
    }
    isAtBottomRef.current = true
    setIsAtBottom(true)
  }, [forceDomScrollToBottom, getScrollMetrics, isAutoStickActive, shouldSuppressAutoStick, startBottomStickLoop])

  const scheduleScrollToBottom = useCallback((behavior: 'auto' | 'smooth' = 'auto') => {
    if (!scrollThrottleRef.current) {
      scrollToBottom(behavior)
      scrollThrottleRef.current = setTimeout(() => {
        scrollThrottleRef.current = null
        if (pendingScrollRef.current) {
          pendingScrollRef.current = false
          scrollToBottom(behavior)
        }
      }, 200)
    } else {
      pendingScrollRef.current = true
    }
  }, [scrollToBottom])

  useImperativeHandle(ref, () => ({
    scrollToBottom: () => scheduleScrollToBottom('auto'),
  }), [scheduleScrollToBottom])

  useEffect(() => {
    prevLenRef.current = 0
    prevFirstKeyRef.current = null
    prevLastKeyRef.current = null
    isAtBottomRef.current = true
    setIsAtBottom(true)
    if (scrollThrottleRef.current) {
      clearTimeout(scrollThrottleRef.current)
      scrollThrottleRef.current = null
    }
    pendingScrollRef.current = false
    autoStickUntilRef.current = 0
    historyLoadUntilRef.current = 0
    navigationLocateUntilRef.current = 0
    if (navigationScrollRetryTimerRef.current) {
      clearTimeout(navigationScrollRetryTimerRef.current)
      navigationScrollRetryTimerRef.current = null
    }
    stopBottomStickLoop()
  }, [conversationId, stopBottomStickLoop])

  const lastMessage = messages[messages.length - 1]
  const lastMessageScrollKey = lastMessage
    ? `${messageStableKey(lastMessage)}:${lastMessage._optimistic ? 1 : 0}:${lastMessage.content?.length ?? 0}`
    : ''

  // 只对本客户端"刚发送、尚未确认"的尾部消息强制跟随（optimistic 阶段）。
  // 不能用 client_request_id 判定：它被原样持久化存库，历史里自己发的最后一条
  // 也带它，会让 followOutput 永久为 'auto'、isOwnTailChange 永久为真，与用户滚动
  // 及 DM 已读回执的高度变化反复竞争而抖动。确认态替换的瞬间由 isAtBottomRef 兜底
  // 继续贴底（optimistic 阶段已贴底），不会丢失"看到自己刚发的消息"。
  const isLocalOwnMessageAtTail = !!(
    lastMessage
    && userId
    && lastMessage.sender_id === userId
    && lastMessage._optimistic === true
  )

  const handleFollowOutput = useCallback(
    (atBottom: boolean): 'auto' | false => {
      if (shouldSuppressAutoStick()) return false
      const result = atBottom || isLocalOwnMessageAtTail ? 'auto' : false
      if (result) return result
      return false
    },
    [isLocalOwnMessageAtTail, shouldSuppressAutoStick],
  )

  // useLayoutEffect：消息（来自 store）变长与 firstItemIndex 递减必须在同一 paint 前完成，
  // 否则会有一帧用旧 firstItemIndex 渲染更多条目、把头部插入误判为尾部追加而视觉跳动。
  useLayoutEffect(() => {
    const len = messages.length
    const prevLen = prevLenRef.current
    const prevFirstKey = prevFirstKeyRef.current
    const prevLastKey = prevLastKeyRef.current
    const firstKey = len > 0 ? messageStableKey(messages[0]) : null
    const lastKey = lastMessage ? messageStableKey(lastMessage) : null

    const commit = () => {
      prevLenRef.current = len
      prevFirstKeyRef.current = firstKey
      prevLastKeyRef.current = lastKey
    }

    if (len === 0) {
      commit()
      return
    }

    const grew = len > prevLen
    const headChanged = firstKey !== prevFirstKey
    const tailChanged = lastKey !== prevLastKey

    // 头部插入历史（上滑加载）：长度增长、头部变化、尾部不变。
    // firstItemIndex 已在渲染期同步派生，这里只需「绝不滚动」即可。
    if (grew && headChanged && !tailChanged && prevLastKey !== null) {
      commit()
      return
    }

    // 尾部新消息 / 内容更新（已读回执、撤回等）
    const isContentUpdated = len === prevLen
    const isOwnTailChange = (grew || isContentUpdated) && isLocalOwnMessageAtTail

    // 历史加载 / 跳转定位窗口内绝不自动贴底（兜底，防止与 prepend/定位竞争）。
    if (!shouldSuppressAutoStick() && (isOwnTailChange || isAtBottomRef.current)) {
      scheduleScrollToBottom('auto')
    }

    commit()
  }, [
    conversationId,
    getScrollMetrics,
    shouldSuppressAutoStick,
    isLocalOwnMessageAtTail,
    lastMessage,
    lastMessageScrollKey,
    messages,
    scheduleScrollToBottom,
    userId,
  ])

  useEffect(() => {
    return () => {
      if (scrollThrottleRef.current) clearTimeout(scrollThrottleRef.current)
      if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current)
      if (navigationScrollRetryTimerRef.current) {
        clearTimeout(navigationScrollRetryTimerRef.current)
        navigationScrollRetryTimerRef.current = null
      }
      stopBottomStickLoop()
    }
  }, [stopBottomStickLoop])

  useEffect(() => {
    if (!scrollToMessageId || !conversationId || scrollTargetConversationId !== conversationId) return
    if (messages.length === 0) return

    const targetMessageId = scrollToMessageId
    const targetMessageRef = scrollToMessageRef
    const targetKey = `${conversationId}:${targetMessageRef ?? targetMessageId}`
    if (autoLocateRef.current.key !== targetKey) {
      autoLocateRef.current = {
        key: targetKey,
        attempts: 0,
        loading: false,
      }
    }

    // 一进入定位就关掉贴底，避免 loadMessages / 长消息测高把视图拽回底部。
    beginNavigationLocate()

    const targetIndex = messages.findIndex((message) => (
      targetMessageRef
        ? message.metadata.message_ref === targetMessageRef
        : message.id === targetMessageId
    ))
    if (targetIndex >= 0) {
      autoLocateRef.current = { key: null, attempts: 0, loading: false }
      const runScroll = () => {
        virtuosoRef.current?.scrollToIndex({
          index: targetIndex,
          align: 'center',
          // auto 比 smooth 更稳；长消息高度回稳后再靠重试校正一次。
          behavior: 'auto',
        })
      }
      runScroll()
      requestAnimationFrame(() => {
        requestAnimationFrame(runScroll)
      })
      if (navigationScrollRetryTimerRef.current) {
        clearTimeout(navigationScrollRetryTimerRef.current)
      }
      navigationScrollRetryTimerRef.current = setTimeout(() => {
        runScroll()
        navigationScrollRetryTimerRef.current = null
      }, NAVIGATION_SCROLL_RETRY_MS)
      setHighlightedMessageId(targetMessageId)
      setHighlightedMessageRef(targetMessageRef)
      if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current)
      highlightTimerRef.current = setTimeout(() => {
        setHighlightedMessageId(null)
        setHighlightedMessageRef(null)
        highlightTimerRef.current = null
      }, NAVIGATION_HIGHLIGHT_DURATION_MS)
      clearScrollTarget({ conversationId, messageId: targetMessageId, messageRef: targetMessageRef ?? undefined })
      return
    }

    if (isLoading || autoLocateRef.current.loading) return

    if (autoLocateRef.current.attempts >= AUTO_LOCATE_MAX_PAGES) {
      autoLocateRef.current = { key: null, attempts: 0, loading: false }
      clearScrollTarget({ conversationId, messageId: targetMessageId, messageRef: targetMessageRef ?? undefined })
      toast({
        title: t('searchMessageLocatePartialTitle', { defaultValue: '已打开会话' }),
        description: t('searchMessageLocatePartialDescription', {
          defaultValue: '暂时无法自动定位到目标消息，请继续向上加载历史消息',
        }),
      })
      return
    }

    autoLocateRef.current.loading = true
    autoLocateRef.current.attempts += 1
    void onLoadMore()
      .then((hasMore) => {
        if (autoLocateRef.current.key !== targetKey) return
        autoLocateRef.current.loading = false
        if (hasMore) return

        autoLocateRef.current = { key: null, attempts: 0, loading: false }
        clearScrollTarget({ conversationId, messageId: targetMessageId, messageRef: targetMessageRef ?? undefined })
        toast({
          title: t('searchMessageLocatePartialTitle', { defaultValue: '已打开会话' }),
          description: t('searchMessageLocatePartialDescription', {
            defaultValue: '暂时无法自动定位到目标消息，请继续向上加载历史消息',
          }),
        })
      })
      .catch(() => {
        if (autoLocateRef.current.key !== targetKey) return
        autoLocateRef.current = { key: null, attempts: 0, loading: false }
        clearScrollTarget({ conversationId, messageId: targetMessageId, messageRef: targetMessageRef ?? undefined })
        toast({
          title: t('searchMessageLocateFailed', { defaultValue: '定位目标消息失败，请稍后重试' }),
          variant: 'destructive',
        })
      })
  }, [
    scrollToMessageId,
    scrollToMessageRef,
    scrollTargetConversationId,
    conversationId,
    messages,
    isLoading,
    clearScrollTarget,
    beginNavigationLocate,
    onLoadMore,
    t,
  ])

  const startReached = useCallback(async () => {
    // 进入历史加载窗口：覆盖 prepend 渲染 + 高度回稳，期间禁用一切自动贴底。
    historyLoadUntilRef.current = Date.now() + 1500
    autoStickUntilRef.current = 0
    stopBottomStickLoop()
    try {
      await onLoadMore()
    } finally {
      // 给 prepend 后的高度回稳留一点缓冲，再解除抑制。
      historyLoadUntilRef.current = Date.now() + 600
    }
  }, [onLoadMore, stopBottomStickLoop])

  const handleAtBottomChange = useCallback((atBottom: boolean) => {
    isAtBottomRef.current = atBottom
    setIsAtBottom(atBottom)
    // 用户一旦离开底部即取消自动贴底（含 autoStick 宽限窗口）——用户滚动意图优先，
    // 否则进入会话后 1s 内上滑会被高度回稳触发的贴底兜底反复拽回底部。
    if (!atBottom) {
      autoStickUntilRef.current = 0
      stopBottomStickLoop()
    }
  }, [stopBottomStickLoop])

  const handleScrollToBottomClick = useCallback(() => {
    scheduleScrollToBottom('smooth')
  }, [scheduleScrollToBottom])

  // 渲染期同步派生 firstItemIndex：与 data 增长同一帧生效，消除滞后帧导致的抖动。
  // 仅在「头部插入（prepend）」时递减；尾部追加不变。对同一 messages 幂等。
  if (fiiConvRef.current !== conversationId) {
    fiiConvRef.current = conversationId
    firstItemIndexRef.current = START_ITEM_INDEX
    fiiPrevFirstKeyRef.current = null
    fiiPrevLenRef.current = 0
  }
  {
    const len = messages.length
    if (len === 0) {
      fiiPrevFirstKeyRef.current = null
      fiiPrevLenRef.current = 0
    } else {
      const firstKey = messageStableKey(messages[0])
      const previousFirstKey = fiiPrevFirstKeyRef.current
      if (previousFirstKey !== null && firstKey !== previousFirstKey && len > fiiPrevLenRef.current) {
        const idx = messages.findIndex((message) => messageStableKey(message) === previousFirstKey)
        const prepended = idx > 0 ? idx : len - fiiPrevLenRef.current
        if (prepended > 0) firstItemIndexRef.current -= prepended
      }
      fiiPrevFirstKeyRef.current = firstKey
      fiiPrevLenRef.current = len
    }
  }
  const firstItemIndex = firstItemIndexRef.current

  if (messages.length === 0 && isInitialLoading) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center" data-testid="im-message-list-initial-loading">
        <div className="flex items-center gap-2 text-body text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          <span>{t('loadingMessages', { defaultValue: '正在加载聊天记录…' })}</span>
        </div>
      </div>
    )
  }

  if (messages.length === 0 && !isLoading) {
    return (
      <div className="flex-1 min-h-0 flex flex-col">
        {groupCreatedAt ? <GroupCreatedAtMarker createdAt={groupCreatedAt} /> : null}
        <div className="flex-1 flex items-center justify-center px-6">
          <div className="text-center space-y-3 max-w-xs">
            <div className="w-12 h-12 mx-auto rounded-full bg-muted/30 border border-border/40 flex items-center justify-center">
              <MessageSquare className="h-5 w-5 text-muted-foreground/80" />
            </div>
            <p className="text-body text-muted-foreground leading-relaxed">{emptyLabel || t('noMessages')}</p>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div
      ref={viewportRef}
      data-im-message-list-viewport
      className="flex-1 min-h-0 min-w-0 relative"
    >
      <IMMessageScrollLockProvider scrollerRef={scrollerRef} viewportRef={viewportRef}>
        <Virtuoso
          ref={virtuosoRef}
          className="virtuoso-container"
          style={{ height: '100%', width: '100%' }}
          data={messages}
          computeItemKey={(_index, message) => message.metadata.message_ref ?? message._tempId ?? message.id}
          firstItemIndex={firstItemIndex}
          initialTopMostItemIndex={Math.max(0, messages.length - 1)}
          followOutput={handleFollowOutput}
          totalListHeightChanged={handleTotalListHeightChanged}
          startReached={startReached}
          atBottomStateChange={handleAtBottomChange}
          atBottomThreshold={60}
          minOverscanItemCount={{ top: HISTORY_MEASURE_AHEAD_ITEMS, bottom: 3 }}
          components={{
            Scroller: VirtuosoScroller,
            Header: () => (
              <>
                <div style={{ height: topInset }} aria-hidden />
                {groupCreatedAt ? <GroupCreatedAtMarker createdAt={groupCreatedAt} /> : null}
              </>
            ),
            Footer: () => <div style={{ height: bottomInset }} aria-hidden />,
          }}
          itemContent={(index, message) => {
            // 使用 firstItemIndex 后，index 为虚拟绝对索引，需换算回数组下标取上一条。
            const dataIndex = index - firstItemIndex
            const prevMessage = dataIndex > 0 ? messages[dataIndex - 1] : null
            return (
              <IMMessageBubble
                message={message}
                prevMessage={prevMessage}
                onReply={onReply}
                onOpenReplyThread={onOpenReplyThread}
                replyCount={replyCountByMessageId.get(message.metadata.message_ref ?? message.id) ?? 0}
                onReEdit={onReEdit}
                onEdit={onEdit}
                onRetryFailed={retryFailedMessage}
                isDM={isDM}
                isHighlighted={highlightedMessageRef
                  ? message.metadata.message_ref === highlightedMessageRef
                  : message.id === highlightedMessageId}
                canManagePins={canManagePins}
                agentMemberIds={agentMemberIds}
                currentHumanMemberIds={currentHumanMemberIds}
              />
            )
          }}
        />

        {/* 回到底部按钮 */}
        {!isAtBottom && messages.length > 0 && (
          <button
            type="button"
            onClick={handleScrollToBottomClick}
            aria-label={t('contentListLoadMore', { defaultValue: '回到最新' })}
            style={{ bottom: bottomInset + 12, right: IM_SCROLL_TO_BOTTOM_RIGHT }}
            className={`absolute h-9 w-9 rounded-full flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted/40 transition-colors animate-in fade-in slide-in-from-bottom-2 duration-200 ${OVERLAY_SURFACE_CLASS}`}
          >
            <ArrowDown className="h-4 w-4" />
          </button>
        )}
      </IMMessageScrollLockProvider>
    </div>
  )
})
IMMessageList.displayName = 'IMMessageList'
