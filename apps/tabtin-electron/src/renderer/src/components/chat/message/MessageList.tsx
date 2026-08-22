/**
 * MessageList - 虚拟化消息列表
 *
 * 使用 @tanstack/react-virtual 实现虚拟滚动，支持动态高度测量、
 * 向上加载更多历史消息、流式消息自动滚动到底部。
 */

import React, { useEffect, useLayoutEffect, useRef, useCallback, useMemo, useState, useImperativeHandle, forwardRef } from 'react'
import type { ChatMessage } from '@tabtin/chat-client'
import { MessageTimeTickProvider } from './MessageTimeTickContext'
import { resolveStreamingTurnAgentFace } from '@/stores/chat/shared/resolveStreamingTurnAgentId'
import { STREAMING_PREVIEW_HEIGHT_PX } from '../markdown/streamingPreviewHeight'
import { useAgentStreamingTailVisible } from '../hooks/useAgentStreamingTailVisible'
import { streamingContent } from '@/stores/chat/execution/streamingContent'
import type { ContextBlock } from '../context/ContextRefCard'
import { ErrorBoundary } from '../../common/ErrorBoundary'
import { cn } from '@utils/cn'
import { LoadingSpinner } from '@components/ui'
import { useTranslation } from 'react-i18next'
import type { SessionAccessCapabilities } from '../sessionAccessCapabilities'
import { useSessionBusy } from '@/stores/chat/execution/sessionRunProjection'
import { TurnEndLayoutProvider } from '../viewport/TurnEndLayoutContext'
import { useTurnEndLayoutController } from '../viewport/useTurnEndLayout'
import { useSpaceActivity } from '@components/layout/SpaceActivityContext'
import { useScopedInterval } from '@hooks/spaceActivity'
import { CHAT_PAGE_GUTTER } from '../registry/chatDesignTokens'
import { buildTurnNavigatorEntries } from '../turn/turnNavigator'
import { TurnNavigatorRail } from '../turn/TurnNavigatorRail'
import { useChatStore } from '@/stores/chat/useChatStore'
import { useSpaceStore } from '@stores/useSpaceStore'
import { SubagentDisclosureProvider } from '../subagent/SubagentDisclosureContext'
import { getCurrentStreamingAssistantMessageId, getTimelineItemKey } from './messageList/timelineItemIdentity'
import { useMessageListScrollStrategy } from './messageList/useMessageListScrollStrategy'
import { MessageListEmptyState } from './messageList/MessageListEmptyState'
import { MessageListVirtualContent } from './messageList/MessageListVirtualContent'
import { MessageListReturnToLatestButton } from './messageList/MessageListReturnToLatestButton'
import { useTaskEpisodeTimeline } from '@stores/chat/presentation/messageTimeline/useTaskEpisodeTimeline'
import { useMessageListTurnArtifacts } from './messageList/useMessageListTurnArtifacts'
import { MessageListTimelineRow, type MessageListTimelineRowRendering } from './messageList/MessageListTimelineRow'
import { TurnAgentBadge } from './messages/assistant/TurnAgentBadge'
import { AgentAwaitingThought } from '../turn/AgentAwaitingThought'
import { RevertBanner } from '../checkpoint/RevertBanner'
import { useStreamingTailFirstBlockPulse } from './useStreamingTailFirstBlockPulse'
import { isLlmAssistantSegment, isRegularUserMessage } from '@stores/chat/presentation/messageTimeline/turnTransparency'
import { CodeDiffReviewCard } from '../tool/CodeDiffReviewCard'
import { getLatestClosedTurnEndMessageId } from '../turn/turnBoundary'

export { getCurrentStreamingAssistantMessageId, getTimelineItemKey } from './messageList/timelineItemIdentity'

const BOTTOM_PADDING = 32
const BOTTOM_READING_SPACE = 100

/** 尚无 assistant 时「身份牌 + 思考中…」等待壳占位高度。 */
const AWAITING_THOUGHT_PLACEHOLDER_HEIGHT = STREAMING_PREVIEW_HEIGHT_PX + 56
interface MessageListProps {
  sessionId?: string | null
  tabScopeKey?: string | null
  /**
   * 子 Agent run 反查专用 session id（缺省 = sessionId）。仅子 Agent 详情面板
   * 透传真实父 chat session，让嵌套孙 Agent 的聚合卡能反查到 run 而不是卡「连接中」。
   * 透传给 MessageBubble → BlockTimeline。主对话不传，行为不变。
   */
  subagentRunSessionId?: string | null
  /**
   * 是否在本列表渲染子 Agent 消息（`subagent_run_id` 非空）。默认 false——主对话
   * 时间线隔离掉所有子消息。子 Agent 详情 Pane 传 true，并由调用方只喂某一 run 的
   * 子消息（隔离 = 单一契约：subagent_run_id）。
  */
  includeSubagentMessages?: boolean
  /** 调用场景附加的时间线可见性门。 */
  isMessageVisible?: (message: ChatMessage) => boolean
  isLoading?: boolean
  isLoadingMore?: boolean
  hasMore?: boolean
  onLoadMore?: () => void
  onSuggestionSelect?: (text: string) => void
  onForkFromMessage?: (messageId: string) => void
  accessCapabilities?: SessionAccessCapabilities
  onContextBlockNavigate?: (block: ContextBlock) => void
  /**
   * 右键资源 ref 卡片回调（机制 B / 与 markdown 链接右键菜单对齐）。
   * MessageList 仅透传，业务逻辑收口在 ChatContent.handleContextBlockContextMenu。
   */
  onContextBlockContextMenu?: (block: ContextBlock, x: number, y: number) => void
  /** 需要滚动定位并高亮的消息 ID（由 scrollToMessage 设置） */
  scrollTargetMessageId?: string | null
  /** 锚定后是否高亮 1.5s（PRD 3.5）。默认 true；为 false 时仅滚动不加高亮。 */
  scrollTargetHighlight?: boolean
  /** 滚动定位完成后的回调（清除 target） */
  onScrollTargetReached?: () => void
  /**
   * Agent 级推荐问题。仅当后端下发非空数组时显示（D4：空对话不做引导，
   * 无静态 i18n 兜底）。新建 Agent 恒为空。
   */
  agentSuggestions?: string[]
  emptyStateHint?: string
  contentPadding?: string
  /**
   * 输入区避让高度（px）。当输入框「浮在消息列表上层」时，由 ChatContent 测量
   * 浮动输入区高度后传入；列表会在避让高度之外追加固定阅读留白。
   */
  bottomPadding?: number
  /**
   * user 消息气泡对齐，透传给 MessageBubble。默认 'right'。子 Agent 详情面板传
   * 'left'——那里的 user 消息是主 Agent 给子 Agent 的指令，走左气泡。
   */
  userAlign?: 'left' | 'right'
  /**
   * 预览模式：透传给 MessageBubble 隐藏消息底部 footer（时间戳 + MessageActions）。
   * 子 Agent inline 就地展开用——预览从简，完整操作去工作台 tab。
   */
  previewMode?: boolean
  className?: string
}

/**
 * MessageList 通过 ref 暴露的命令式 API ——
 *
 * 当前只暴露 `scrollToBottom`：用户在 ChatContent 发送/重发消息后，需要
 * 主动滚到最新消息（即使 isAtBottom=false 也要强滚，因为是用户自己刚发的）。
 *
 * 历史 bug：之前 MessageList 是普通函数组件不接受 ref，
 * `messageListRef.current?.scrollToBottom()` 短路成 undefined，
 * 自动滚到底部静默失败。本次治理把 forwardRef + useImperativeHandle 补上。
 */
export interface MessageListHandle {
  scrollToBottom: () => void
}

export const MessageList = forwardRef<MessageListHandle, MessageListProps>(function MessageList(props, ref) {
  return (
    <SubagentDisclosureProvider>
      <ErrorBoundary variant="region" resetKeys={[props.sessionId ?? null, props.tabScopeKey ?? null, props.includeSubagentMessages ?? false]}>
        <MessageListInner {...props} ref={ref} />
      </ErrorBoundary>
    </SubagentDisclosureProvider>
  )
})

MessageList.displayName = 'MessageList'

// eslint-disable-next-line complexity -- 列表层需要协调虚拟化、视口锚点、流式尾巴和导航；子 hook 已承接主要业务分支。
const MessageListInner = forwardRef<MessageListHandle, MessageListProps>(function MessageListInner(
  {
    sessionId = null,
    tabScopeKey = null,
    subagentRunSessionId,
    includeSubagentMessages = false,
    isMessageVisible,
    userAlign = 'right',
    previewMode,
    isLoading,
    isLoadingMore,
    hasMore,
    onLoadMore,
    onSuggestionSelect,
    onForkFromMessage,
    accessCapabilities,
    onContextBlockNavigate,
    onContextBlockContextMenu,
    scrollTargetMessageId,
    scrollTargetHighlight = true,
    onScrollTargetReached,
    agentSuggestions,
    emptyStateHint,
    contentPadding = CHAT_PAGE_GUTTER.panel.content,
    bottomPadding,
    className,
  },
  ref,
) {
  const { t } = useTranslation('chat')
  const sessionAgentId = useChatStore((state) => (
    sessionId ? state.getSessionById(sessionId)?.agent_id ?? null : null
  ))
  const sessionAgentName = useChatStore((state) => (
    sessionId ? state.getSessionById(sessionId)?.agent_name ?? null : null
  ))
  const sessionAgentAvatar = useChatStore((state) => (
    sessionId ? state.getSessionById(sessionId)?.agent_avatar ?? null : null
  ))
  const selectedAgentId = useSpaceStore((state) => state.selectedAgent?.id ?? null)
  const awaitingTurnAgentFace = useMemo(() => resolveStreamingTurnAgentFace({
    sessionAgentId,
    sessionAgentName,
    sessionAgentAvatar,
    selectedAgentId,
  }), [selectedAgentId, sessionAgentAvatar, sessionAgentId, sessionAgentName])
  const timeline = useTaskEpisodeTimeline({
    sessionId,
    includeSubagentMessages,
    isMessageVisible,
  })
  const { messages, rows } = timeline
  // 消息入场 baseline：父组件 render 期同步，保证子气泡 mount 前已封口历史身份。
  const isRestoringSession = useChatStore((s) => (sessionId ? s.restoringSessionId === sessionId : s.restoringSessionId != null))
  const parentRef = useRef<HTMLDivElement>(null)
  const contentHeightRef = useRef<HTMLDivElement>(null)
  // 滚动容器 / 内容容器用 callback ref 承接为 state——空态先挂载、容器后渲染时，元素挂载会
  // 触发滚动策略重绑（RefObject 的 .current 变化不会触发 effect）。同时回填 RefObject：
  // virtualizer.getScrollElement 仍按 .current 读取。
  const [scrollEl, setScrollEl] = useState<HTMLDivElement | null>(null)
  const [contentEl, setContentEl] = useState<HTMLDivElement | null>(null)
  const [bottomMarkerEl, setBottomMarkerEl] = useState<HTMLDivElement | null>(null)
  const setScrollNode = useCallback((node: HTMLDivElement | null) => {
    parentRef.current = node
    setScrollEl(node)
  }, [])
  const setContentNode = useCallback((node: HTMLDivElement | null) => {
    contentHeightRef.current = node
    setContentEl(node)
  }, [])
  // D4「空对话不再做引导」：仅当后端真的下发 agentSuggestions（非空）时才显示
  // 推荐 chips；为空时不再 fallback 到 i18n 静态三条。新建 Agent 恒为空 → 干净空态。
  const suggestions = useMemo(() => {
    if (agentSuggestions && agentSuggestions.length > 0) {
      return agentSuggestions.map((text) => ({ icon: '💡', text }))
    }
    return []
  }, [agentSuggestions])

  const lastAssistantMsgId = useMemo(() => getCurrentStreamingAssistantMessageId(messages), [messages])

  // ：busy 改订阅执行态单一投影——经 useChatStore selector 间接读的话，
  // 重渲染时机依赖 chat store 变更，投影单独变化（乐观派发窗口）时会滞后。
  const isStreaming = useSessionBusy(sessionId)
  const sessionPulseVisible = useAgentStreamingTailVisible(sessionId ?? null)
  const { beginTurnEnd, providerValue: turnEndProviderValue } = useTurnEndLayoutController()
  const wasStreamingForRenderRef = useRef(isStreaming)
  const isTurnEndingRender = wasStreamingForRenderRef.current && !isStreaming
  useLayoutEffect(() => {
    wasStreamingForRenderRef.current = isStreaming
  }, [isStreaming])
  const effectiveTurnEndProviderValue = useMemo(
    () =>
      isTurnEndingRender
        ? {
            ...turnEndProviderValue,
            phase: 'committing' as const,
            closingUiReady: false,
            shouldHoldThinkingPreviewBudget: true,
            shouldHoldClosingSpacer: true,
          }
        : turnEndProviderValue,
    [isTurnEndingRender, turnEndProviderValue],
  )

  const showAwaitingThoughtPlaceholder = sessionPulseVisible && !lastAssistantMsgId

  // hot-spaces 模式：SpaceChatRailHost 同时挂载所有 hot Space 的 ChatSidePanel，用
  // display:none 隐藏 inactive 的。inactive 时列表不可见——虚拟化与吸底监听都随之关闭。
  // useSpaceActivity 在 Provider 之外默认返回 isForeground=true，独立使用不受影响。
  const { isForeground } = useSpaceActivity()

  const { turnArtifactsByEndIndex, priorTurnArtifactsByEndIndex } = useMessageListTurnArtifacts(
    sessionId,
    messages,
  )

  // Review Card 属于消息流末尾的交付内容：只取最近一个已闭合回合，随列表滚动，
  // 不固定在输入框或视口上方。子 Agent 详情和预览模式仍不展示主对话审阅入口。
  const latestReviewMessage = useMemo(() => {
    if (includeSubagentMessages || previewMode || !sessionId) return null
    const turnEndMessageId = getLatestClosedTurnEndMessageId(messages)
    return turnEndMessageId
      ? messages.find((message) => message.id === turnEndMessageId) ?? null
      : null
  }, [includeSubagentMessages, messages, previewMode, sessionId])

  // 底部留白只负责清出浮动输入区，不再叠加随视口变化的半屏居中策略。
  // 消息内容高度变化由虚拟列表与 viewport controller 处理，避免两个布局语义互相反馈。
  const bottomSpacerHeight = Math.max(BOTTOM_PADDING, bottomPadding ?? 0) + BOTTOM_READING_SPACE
  const getVirtualItemKey = useCallback(
    (index: number) => getTimelineItemKey(messages[index], index),
    [messages],
  )
  const estimateVirtualItemSize = useCallback((index: number) => {
    if (rows[index]?.isRunPlaceholder) return 1
    const message = messages[index]
    if (!message) return 120
    if (message.role === 'system') return 48
    if (Array.isArray(message.attachments_json) && message.attachments_json.length > 0) return 240
    const contentLength = message.content?.length ?? 0
    if (contentLength < 100) return 80
    if (contentLength < 500) return 160
    return 280
  }, [messages, rows])
  const lastItemContentVersion = messages[messages.length - 1]?.content ?? null
  const messageEnterKeys = useMemo(
    () => messages.map((message, index) => String(getTimelineItemKey(message, index))),
    [messages],
  )
  const awaitingThoughtHandoffKeys = useMemo(() => {
    const keys = new Set<string>()
    if (!lastAssistantMsgId) return keys
    for (let index = messages.length - 1; index >= 0; index--) {
      const message = messages[index]
      if (isRegularUserMessage(message)) break
      if (isLlmAssistantSegment(message)) {
        keys.add(String(getTimelineItemKey(message, index)))
      }
    }
    return keys
  }, [lastAssistantMsgId, messages])
  const showTurnNavigator = !previewMode && !includeSubagentMessages && userAlign === 'right'
  const turnNavigatorEntries = useMemo(
    () => (showTurnNavigator ? buildTurnNavigatorEntries(messages) : []),
    [showTurnNavigator, messages],
  )
  const resolveMessageIndex = useCallback(
    (messageId: string) => messages.findIndex((message) => message.id === messageId),
    [messages],
  )
  const scrollScopeKey = tabScopeKey ?? sessionId

  const {
    virtualizer,
    isBottomMarkerVisible,
    showReturnToLatest,
    highlightedMessageId,
    highlightKey,
    turnEntries,
    handleTurnSelect,
    handleUserMessageExpand,
    scrollToBottomFromSend,
    scrollToBottomFromReturnButton,
    notifyLayoutChanged,
  } = useMessageListScrollStrategy({
    parentRef,
    contentElementRef: contentHeightRef,
    scrollElement: scrollEl,
    contentElement: contentEl,
    bottomMarkerElement: bottomMarkerEl,
    itemCount: messages.length,
    getItemKey: getVirtualItemKey,
    estimateSize: estimateVirtualItemSize,
    lastItemContentVersion,
    messageEnterKeys,
    awaitingThoughtHandoffKeys,
    turnEntries: turnNavigatorEntries,
    resolveMessageIndex,
    scopeKey: scrollScopeKey,
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
    messageNotInWindowText: t('messageList.messageNotInWindow', {
      defaultValue: '未能定位到该消息，请重试',
    }),
  })

  useStreamingTailFirstBlockPulse({
    sessionId,
    lastAssistantMsgId,
    isStreaming,
    onFirstBlock: () => notifyLayoutChanged('streaming-tail-first-block'),
  })

  useEffect(() => {
    if (!isStreaming || !sessionId) return
    if (messages.length === 0 && !showAwaitingThoughtPlaceholder) return
    const unsub = streamingContent.subscribeSession(sessionId, () => {
      notifyLayoutChanged('streaming-tick')
    })
    return () => {
      unsub()
    }
  }, [isStreaming, sessionId, messages.length, notifyLayoutChanged, showAwaitingThoughtPlaceholder])

  // 暴露命令式 API 给 ChatContent ——见文件顶部 MessageListHandle 接口注释。
  useImperativeHandle(
    ref,
    () => ({
      scrollToBottom: scrollToBottomFromSend,
    }),
    [scrollToBottomFromSend],
  )

  const [timeTick, setTimeTick] = useState(0)
  useScopedInterval(
    () => {
      if (document.visibilityState === 'visible') {
        setTimeTick((t) => t + 1)
      }
    },
    isStreaming ? null : 60_000,
  )

  const loadingMoreOverlay = useMemo(() => {
    if (!isLoadingMore) return null
    return (
      <div className="flex items-center justify-center py-3 sticky top-0 z-sticky bg-background/80 backdrop-blur-sm">
        <LoadingSpinner size="sm" />
        <span className="ml-2 text-body text-muted-foreground/60">
          {t('messageList.loadingMore', '加载更多消息...')}
        </span>
      </div>
    )
  }, [isLoadingMore, t])

  const renderAwaitingThoughtPlaceholder = useCallback((top: number) => {
    if (!showAwaitingThoughtPlaceholder) return null
    return (
      <div
        data-testid="agent-awaiting-thought-placeholder"
        className={cn(contentPadding, 'chat-motion-message-enter')}
        style={{
          position: 'absolute',
          top,
          left: 0,
          width: '100%',
        }}
      >
        <TurnAgentBadge
          agentId={awaitingTurnAgentFace.agentId}
          displayNameOverride={awaitingTurnAgentFace.agentName}
          avatarUrlOverride={awaitingTurnAgentFace.agentAvatar}
        />
        <AgentAwaitingThought />
      </div>
    )
  }, [awaitingTurnAgentFace, contentPadding, showAwaitingThoughtPlaceholder])

  const afterVirtualContent = useMemo(() => (
    <>
      {latestReviewMessage ? (
        <div className={contentPadding} data-testid="code-diff-review-dock">
          <CodeDiffReviewCard
            message={latestReviewMessage}
            timelineMessages={messages}
            sessionId={sessionId}
            tabScopeKey={tabScopeKey}
            isLastInTurn
            isStreaming={isStreaming}
            isMiniMessage={false}
            isErrorEnvelope={false}
          />
        </div>
      ) : null}
      <div className="py-2" data-testid="message-list-revert-banner">
        <RevertBanner sessionId={sessionId ?? undefined} placement="messageList" />
      </div>
    </>
  ), [contentPadding, isStreaming, latestReviewMessage, messages, sessionId, tabScopeKey])

  const virtualItems = virtualizer.getVirtualItems()
  const totalVirtualSize = virtualizer.getTotalSize()
  const measureElementRef = virtualizer.measureElement as React.Ref<HTMLDivElement>
  const rowRendering = useMemo<MessageListTimelineRowRendering>(() => ({
    messages,
    sessionId,
    tabScopeKey,
    subagentRunSessionId,
    lastAssistantMsgId,
    includeSubagentMessages,
    isStreaming,
    highlightedMessageId,
    highlightKey,
    turnArtifactsByEndIndex,
    priorTurnArtifactsByEndIndex,
    onForkFromMessage,
    accessCapabilities,
    onContextBlockNavigate,
    onContextBlockContextMenu,
    userAlign,
    previewMode,
    onUserMessageExpand: handleUserMessageExpand,
  }), [
    accessCapabilities,
    handleUserMessageExpand,
    highlightKey,
    highlightedMessageId,
    includeSubagentMessages,
    isStreaming,
    lastAssistantMsgId,
    messages,
    onContextBlockContextMenu,
    onContextBlockNavigate,
    onForkFromMessage,
    previewMode,
    priorTurnArtifactsByEndIndex,
    sessionId,
    subagentRunSessionId,
    tabScopeKey,
    turnArtifactsByEndIndex,
    userAlign,
  ])
  const virtualRowsContent = useMemo(() => virtualItems.map((virtualRow) => {
    const row = rows[virtualRow.index]
    if (!row) return null
    return (
      <div
        key={virtualRow.key}
        data-index={row.index}
        data-message-enter-key={String(virtualRow.key)}
        ref={measureElementRef}
      >
        <MessageListTimelineRow row={row} rendering={rowRendering} />
      </div>
    )
  }), [
    measureElementRef,
    rowRendering,
    rows,
    virtualItems,
  ])
  const trailingPlaceholder = renderAwaitingThoughtPlaceholder(totalVirtualSize)

  if (!messages || messages.length === 0) {
    return (
      <MessageListEmptyState
        isLoading={isLoading}
        className={className}
        contentPadding={contentPadding}
        emptyStateHint={emptyStateHint}
        suggestions={suggestions}
        onSuggestionSelect={onSuggestionSelect}
        sessionId={sessionId}
      />
    )
  }

  return (
    <MessageTimeTickProvider tick={timeTick}>
      <TurnEndLayoutProvider value={effectiveTurnEndProviderValue}>
        <div
          className={cn('relative flex min-h-0 min-w-0 flex-1', className)}
          data-testid="chat-message-list"
          data-message-count={messages.length}
          data-virtual-row-count={virtualItems.length}
          data-is-foreground={String(isForeground)}
          data-turn-end-phase={effectiveTurnEndProviderValue.phase}
        >
          <div
            ref={setScrollNode}
            className="scrollbar-hover h-full min-h-0 flex-1 overflow-y-auto"
            data-testid="chat-message-list-scroller"
            // dataset.viewportMode 由 viewport controller 同步；关掉浏览器原生 scroll
            // anchoring，避免与 controller 的跟随 / 锚点校正抢写 scrollTop。
            style={{ overflowAnchor: 'none' }}
          >
            <MessageListVirtualContent
              contentRef={setContentNode}
              bottomMarkerRef={setBottomMarkerEl}
              topOverlay={loadingMoreOverlay}
              totalSize={totalVirtualSize}
              offsetTop={virtualItems[0]?.start ?? 0}
              contentPadding={contentPadding}
              trailingPlaceholderHeight={showAwaitingThoughtPlaceholder ? AWAITING_THOUGHT_PLACEHOLDER_HEIGHT : 0}
              bottomSpacerHeight={bottomSpacerHeight}
              trailingPlaceholder={trailingPlaceholder}
              afterContent={afterVirtualContent}
            >
              {virtualRowsContent}
            </MessageListVirtualContent>
          </div>

          {turnEntries.length >= 2 && <TurnNavigatorRail entries={turnEntries} virtualizer={virtualizer} scrollElementRef={parentRef} onSelect={handleTurnSelect} />}

          {showReturnToLatest && !isBottomMarkerVisible && (
            <MessageListReturnToLatestButton
              bottomPadding={bottomPadding}
              label={t('messageList.scrollToBottom', '回到底部')}
              onClick={scrollToBottomFromReturnButton}
            />
          )}
        </div>
      </TurnEndLayoutProvider>
    </MessageTimeTickProvider>
  )
})

MessageListInner.displayName = 'MessageListInner'
