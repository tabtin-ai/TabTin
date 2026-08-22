/**
 * ChatContent — 消息列表 + 输入框的组装区域
 *
 * 提取自 ChatPanel.tsx 的 renderChatContent 内联函数。
 * 负责渲染聊天内容区（上下文指示条、消息列表、Todo 面板、输入框等），
 * 不包含布局外壳和会话切换 UI。
 *
 * 会话级关注点（权限审批、断连通知、外部 Agent 标记）也在此处渲染，
 * 放在输入框上方。步骤详情已内联到每条 MessageBubble 中。
 */

import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Image as ImageIcon, Share2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { logger } from '@/utils/logger'
import { cn } from '@utils/cn'
import { ConfirmDialog, toast } from '@tabtin/smartsheet-ui'
import type { OpenOutcome } from '@tabtin/resource-router'
import { buildRichResourcePointer } from '../context/buildRichResourcePointer'
import { shouldToastRichResourceOpenFailure } from '../context/richResourceOpenFailure'
import { useChatStore } from '@/stores/chat/useChatStore'
import { getPendingDraftSessionByScopeKey } from '@/stores/chat/session/draftSession'
import { resolveConversationDraftScopeKey } from '@/stores/chat/session/draftMessageLegacyAdapter'
import { useChatRuntimeStore } from '@/stores/useChatRuntimeStore'
import { useIMStore } from '@/stores/useIMStore'
import { useScopedResizeObserver } from '@/hooks/spaceActivity'
import { useSessionReconcile } from '@/hooks/useSessionReconcile'
import { useChatSessionEventStream } from '@/hooks/useChatSessionEventStream'
import { useConversationStream } from '@/services/agentService/useConversationStream'
import { getChatClient } from '@/services/chatApi'
import { applyDecisionSummaryUpdate } from '@/stores/chat/checkpoint/handlers/checkpointHandler'
import { fetchCheckpointDecisionContext } from '@/services/chatExtraApi'
import type { ChatSession, DecisionSummary } from '@tabtin/chat-client'
import { useChatModelStore } from '@/stores/useChatModelStore'
import { useSpaceStore } from '@stores/useSpaceStore'
import { filterSendableChatModels } from '@/utils/chatModelGuards'
import { isCommunityDistribution } from '@/config/distribution'
import { useChatActions } from '../hooks/useChatActions'
import { useSessionChatSurface } from '../hooks/useSessionChatSurface'
import { useRetryLastMessageListener } from '../hooks/useRetryLastMessageListener'
import { continueAgentAfterError } from '@/stores/chat/messages/actions/continueAgentAfterError'
import { usePendingRevertSend } from '../hooks/usePendingRevertSend'
import { MessageList, type MessageListHandle } from '../message'
import {
  resolveCanChangeAgent,
  resolveCanSwitchDraftWorkspace,
  resolveNewTaskWelcomeVisible,
  resolveWelcomeSuggestionBarVisible,
  resolveWelcomeComposerTop,
} from './chatContentState'
import { beginSendScroll } from './sendScrollPolicy'
import { useCurrentAgentDisplay } from '../model/useCurrentAgentDisplayName'
import { AgentAvatar } from '../message'
// ：执行记录 UI 收敛后去掉 SystemNote / BreadcrumbHost；顶栏 + StatusIndicator 承载
import { TrackerRunStatusIndicator } from '../tracker/TrackerRunStatusIndicator'
import { ChatInput, type ChatInputSendOptions } from '../composer/ChatInput'
import { ComposerWelcomeMascot } from '../composer/ComposerWelcomeMascot'
import {
  composerDraftScopeKey,
  resolveDraftKey,
  setComposerDraftExternally,
} from '../composer/chatInputDraft'
import { WelcomeSuggestionBar } from '../welcome/WelcomeSuggestionBar'
import { AppOpenDraftWelcome } from './AppOpenDraftWelcome'
import { PendingTasksNotice } from '../notice/PendingTasksNotice'
import { RemoteExecutionNoticeGate } from '../notice/RemoteExecutionNoticeGate'
import { useRemoteExecutionGate } from '../hooks/useRemoteExecutionGate'
import { CapabilityBanners } from '../notice/CapabilityBanners'
import { SystemNoticeBanner } from '../notice/SystemNoticeBanner'
import { ChatNoticeStack } from '../notice/ChatNoticeStack'
import { isSimpleRollback } from '@utils/chat/checkpointFeedback'
import type { ChatAttachment } from '../types'
import type { SpaceContext } from '@components/context-space/SpaceContextContainer'
import { navigateContextBlock } from '../context/contextBlockNavigation'
import type { ChatContextDisplay } from '../context/resolveChatContextDisplay'
import { CHAT_PAGE_GUTTER, WELCOME_COMPOSER_LAYOUT } from '../registry/chatDesignTokens'
import { expandCanvasAfterInSpaceOpen, expandCanvasForScope } from '@/services/openResourceLink'
import { useSpaceContextTabsStore } from '@stores/useSpaceContextTabsStore'
import {
  isChatFileRefDropAcceptable,
  resolveChatFileRefDrop,
} from '../composer/chatFileRefDrop'
import {
  filterSharedTimelineMessages,
  isSharedTimelineMessageVisible,
  loadLatestSharedTimelinePage,
  mergeSharedTimelineMessages,
} from '../shared-view/sharedSessionMessages'
import { useSessionAccessComposer } from '../composer/useSessionAccessComposer'
import { SharedSessionPreviewProvider } from '../shared-view/preview'
import { openSharedSessionCloudResourceFromBlock } from '../shared-view/openSharedSessionCloudResource'
import { ExecutionTargetWizard } from '../shared-view/ExecutionTargetWizard'
import { isSharedAccessDenied } from '../shared-view/sharedSessionAccess'
import { sharedFork } from '@/services/sessionShareApi'
import { enterChatSession } from '@/services/chatSessionNavigation'

interface ChatContentProps {
  currentSessionId: string | null
  /** 共享会话仍走正常 ChatContent；该字段只作为读取授权上下文。 */
  sharedAccessShareId?: string | null
  /** 受控侧边会话即使不是 grantee，也必须主动 hydrate，不能依赖首页缓存。 */
  forceSessionHydration?: boolean
  selectedSpace: SpaceContext | null
  selectedSpaceId: string | null
  onExecutionSpaceChange?: (spaceId: string) => void
  /** 当前工作台 scope（可为 `conversation:S`） */
  tabScopeKey?: string | null
  /** 产品宿主上的稳定新草稿 scope A；与 tabScopeKey 解耦 */
  draftScopeKey?: string | null

  compactLeft: boolean

  effectiveGraphType: 'chat' | null
  isRestoring: boolean
  canSend: boolean
  disabledReason: string | null

  currentModel: import('@tabtin/chat-client').Model | null
  /** 当前生效的上下文档位（仅多档模型有意义） */
  currentContextTier?: import('@tabtin/chat-client').ContextTier | null
  currentModelParamOverrides?: import('@tabtin/chat-client').ModelParamOverrides | null
  tokenUsage: {
    inputTokens: number
    outputTokens: number
    contextTokens: number
    contextSource?: 'last_call' | 'turn_accum' | 'post_compact' | 'none'
    contextWindow: number
    estimatedCost?: number
    creditsConsumed?: number
    cacheReadTokens?: number
    hasCacheReadTokens?: boolean
    compactInputTokens?: number
    reasoningTokens?: number
    chargeFailed?: boolean
    isByok?: boolean
    hasMixedBilling?: boolean
  } | null
  presetScopeId: string | null

  activeTable: { id: string; name: string } | null
  /** 当前聚焦标签的 App 类型；用于欢迎建议条按现场切换 */
  activeContextType?: string | null
  contextDisplay: ChatContextDisplay | null

  contextInjection: {
    contextRefs: import('../types').ContextRef[]
    addContextRef: (
      type: import('../types').ContextRefType,
      resourceId: string,
      label: string,
      extra?: Partial<import('../types').ContextRef>,
    ) => void
    removeRef: (id: string) => void
    clearRefs: () => void
  }

  onSendMessage: (
    message: string,
    attachments?: ChatAttachment[],
    contextBlocks?: Array<Record<string, unknown>>,
    options?: ChatInputSendOptions,
  ) => Promise<void>
  onStop: () => void
  onModelChange: (modelId: string, tierId?: string, controlChange?: { key: string; value: import('@tabtin/chat-client').ModelParamValue }) => void
}

export const ChatContent: React.FC<ChatContentProps> = React.memo(({
  currentSessionId,
  sharedAccessShareId = null,
  forceSessionHydration = false,
  selectedSpace,
  selectedSpaceId,
  onExecutionSpaceChange,
  tabScopeKey = null,
  draftScopeKey: stableDraftScopeKeyProp = null,
  compactLeft,
  effectiveGraphType,
  isRestoring,
  canSend,
  disabledReason,
  currentModel,
  currentContextTier = null,
  currentModelParamOverrides = null,
  tokenUsage,
  presetScopeId,
  activeTable,
  activeContextType = null,
  contextDisplay,
  contextInjection,
  onSendMessage,
  onStop,
  onModelChange,
}) => {
  const { t } = useTranslation('chat')
  const currentAgentDisplay = useCurrentAgentDisplay(currentSessionId)
  const welcomeAgentName = currentAgentDisplay?.displayName || t('input.defaultAgentName')

  const applyLoadedMessages = useChatStore(s => s.applyLoadedMessages)
  const updateSessionInCaches = useChatStore(s => s.updateSessionInCaches)
  const cachedSharedSession = useChatStore(s => (
    currentSessionId && (sharedAccessShareId || forceSessionHydration)
      ? s.getSessionById(currentSessionId) ?? null
      : null
  ))
  const [loadedSharedSession, setLoadedSharedSession] = useState<ChatSession | null>(null)
  const [sharedForkWizardOpen, setSharedForkWizardOpen] = useState(false)
  const sharedSession = loadedSharedSession ?? cachedSharedSession
  useEffect(() => {
    setLoadedSharedSession(null)
  }, [currentSessionId, sharedAccessShareId])
  const refreshSharedConversation = useCallback(async () => {
    if (!currentSessionId || (!sharedAccessShareId && !forceSessionHydration)) return
    try {
      const client = getChatClient()
      const accessOptions = sharedAccessShareId ? { shareId: sharedAccessShareId } : undefined
      const [session, page] = await Promise.all([
        client.sessions.get(currentSessionId, accessOptions),
        loadLatestSharedTimelinePage(
          (sessionId, params) => client.messages.list(
            sessionId,
            params,
            accessOptions,
          ),
          currentSessionId,
        ),
      ])
      setLoadedSharedSession(session)
      const live = useChatStore.getState().messagesBySessionId[currentSessionId] ?? []
      const mergedMessages = mergeSharedTimelineMessages(page.messages, live)
      applyLoadedMessages(
        currentSessionId,
        sharedAccessShareId
          ? filterSharedTimelineMessages(mergedMessages)
          : mergedMessages,
      )
      updateSessionInCaches(currentSessionId, session)
      useChatStore.setState(state => ({
        hasMoreBySessionId: {
          ...state.hasMoreBySessionId,
          [currentSessionId]: page.hasEarlier,
        },
      }))
    } catch (error) {
      logger.warn('[ChatContent] load shared conversation failed', {
        error,
      })
      if (sharedAccessShareId && isSharedAccessDenied(error)) {
        applyLoadedMessages(currentSessionId, [])
        useIMStore.getState().denySessionShareAccess(sharedAccessShareId)
      }
    }
  }, [applyLoadedMessages, currentSessionId, forceSessionHydration, sharedAccessShareId, updateSessionInCaches])

  useEffect(() => {
    if (!currentSessionId || (!sharedAccessShareId && !forceSessionHydration)) return
    let cancelled = false
    void refreshSharedConversation().then(() => {
      if (cancelled) return
    })
    return () => {
      cancelled = true
    }
  }, [currentSessionId, forceSessionHydration, refreshSharedConversation, sharedAccessShareId])
  const sharedComposer = useSessionAccessComposer({
    sessionId: sharedAccessShareId ? currentSessionId : null,
    shareId: sharedAccessShareId,
    onSent: () => { void refreshSharedConversation() },
  })
  const sharedGrantee = Boolean(
    sharedAccessShareId && sharedComposer.capabilities.sendMode !== 'owner',
  )
  useChatSessionEventStream({
    sessionId: currentSessionId,
    enabled: sharedGrantee,
    onModelChanged: refreshSharedConversation,
  })
  useEffect(() => {
    if (sharedComposer.capabilities.canForkWholeSession) return
    setSharedForkWizardOpen(false)
  }, [sharedComposer.capabilities.canForkWholeSession])

  // 遥控器在线时保留状态提示；执行设备不可达时同一提示条升级为禁发原因。
  const remoteExecution = useRemoteExecutionGate(selectedSpaceId)
  // 分层模型：owner 代执行已下线；发送门控不再受 team owner 执行影响。
  const effectiveCanSend = canSend
  const effectiveDisabledReason = disabledReason

  useSessionReconcile(currentSessionId ?? null)

  // 消息 / HITL / busy / 队列 / decision_summary 订阅 —— 与 ChatSplitPane 共用。
  const {
    messages,
    hasMore,
    isLoadingMore,
    onLoadMore,
    isBusy: isCurrentSessionStreaming,
    isReverted,
    queueCount,
    isSendInFlight,
    hitlProps,
  } = useSessionChatSurface(currentSessionId, { shareId: sharedAccessShareId })

  // W7c P0-2：会话事实流镜像。
  //
  // 只要打开会话，就订阅 `agent.stream.chat-session-{sessionId}` topic 接收多端
  // stream；没有本地 IPC 权威的观察端会把它灌进与发起端相同的 streamMessageHandler。
  // 本窗口一旦通过 IPC 发起/接收过同一 session，则该 session 的 `agent.stream.*`
  // 以 IPC 为唯一权威，WS 镜像只保留订阅但不消费，避免迟到 relay 事件覆盖本地终态。
  //
  // `agent.session.*` 后端事实事件由 useChatSessionEventStream 独立订阅，不受此
  // stream 镜像消费门禁影响。
  const observerSessionTitle = useChatStore(
    s => currentSessionId ? s.sessions.find(sess => sess.id === currentSessionId)?.title : undefined,
  )
  const observerAddStreaming = useChatStore(s => s.addStreamingSession)
  const observerRemoveStreaming = useChatStore(s => s.removeStreamingSession)
  const observerUpdateTokenUsage = useChatStore(s => s.updateSessionTokenUsageInCaches)
  const observerUpdateSession = useChatStore(s => s.updateSessionInCaches)
  // 订阅当前会话实时流——本机 IPC 后台 push + WS 观察两条来源由 hub 内部协调，
  // 应用层不感知来源类型（见 useConversationStream）。
  useConversationStream({
    sessionId: currentSessionId,
    shareId: sharedAccessShareId ?? undefined,
    client: getChatClient(),
    spaceId: selectedSpaceId ?? undefined,
    spaceName: selectedSpace?.name ?? undefined,
    sessionTitle: observerSessionTitle,
    addStreamingSession: observerAddStreaming,
    removeStreamingSession: observerRemoveStreaming,
    updateSessionTokenUsageInCaches: observerUpdateTokenUsage,
    updateSessionInCaches: observerUpdateSession,
  })

  // Wave 13 真实用户视角 Review 修正：
  // 切回 session 时主动扫描所有非终态 decision_summary 并触发兜底拉取。
  //
  // 为什么必要：
  //   用户在 A 触发 LLM 生成 → 切到 B → LLM 在 A 切走期间完成 →
  //   agent.session.{A} 无订阅者 → WS 事件丢弃 →
  //   切回 A 时 loadSessionMessages 命中 memory 缓存不刷新 →
  //   decision_summary 永远停留在 pending/basic，用户看不到 ready。
  //
  // 本 effect 在 sessionId 变化或首次订阅建立后，对当前 session 所有
  // 非终态 checkpoint 执行一次兜底拉取（每个 checkpoint 在本 effect 触发
  // 周期内至多一次，避免轰炸后端）。
  const lastSyncedSessionIdRef = useRef<string | null>(null)
  useEffect(() => {
    if (!currentSessionId) return
    if (lastSyncedSessionIdRef.current === currentSessionId) return
    lastSyncedSessionIdRef.current = currentSessionId
    const currentMessages = useChatStore.getState().messagesBySessionId[currentSessionId] ?? []
    const nonTerminalCheckpoints: Array<{ checkpointId: string; messageId: string }> = []
    for (const msg of currentMessages) {
      const cpRecord = msg.checkpoint_record
      if (!cpRecord?.checkpoint_id) continue
      const ds = cpRecord.context_summary?.decision_summary
      if (!ds || !ds.status) continue
      if (ds.status === 'ready' || ds.status === 'failed') continue
      nonTerminalCheckpoints.push({
        checkpointId: cpRecord.checkpoint_id,
        messageId: msg.id,
      })
    }
    if (nonTerminalCheckpoints.length === 0) return

    let cancelled = false
    const sessionAtEffect = currentSessionId
    // 串行 + 小延迟：避免短时间内大量并发请求冲击后端
    void (async () => {
      for (const { checkpointId, messageId } of nonTerminalCheckpoints) {
        if (cancelled) return
        try {
          const res = await fetchCheckpointDecisionContext(checkpointId)
          if (cancelled) return
          if (!res) continue
          const fresh = res.context?.decision_summary as DecisionSummary | undefined
          if (!fresh || !fresh.status) continue
          void applyDecisionSummaryUpdate({
            targetSessionId: sessionAtEffect,
            messageId,
            checkpointId,
            decisionSummary: fresh,
          })
        } catch {
          /* best-effort，单项失败不阻塞后续 */
        }
      }
    })()

    return () => {
      cancelled = true
    }
  }, [currentSessionId])

  // ── Store reads（布局独有：草稿 / 滚动目标 / 简单回退）──
  const isLoading = useChatStore(s => s.isLoading)
  const scrollTargetMessageId = useChatStore(s => s.scrollTargetMessageId)
  const scrollTargetHighlight = useChatStore(s => s.scrollTargetHighlight)
  const clearScrollTarget = useChatStore(s => s.clearScrollTarget)
  const isDraftSession = useChatStore(
    useCallback(
      (s) => (selectedSpaceId ? s.draftSessionBySpaceId[selectedSpaceId] ?? false : false),
      [selectedSpaceId],
    ),
  )
  const currentSessionMessageCount = useChatStore(
    useCallback((s) => {
      if (!currentSessionId || !selectedSpaceId) return null
      return s.sessionsBySpaceId[selectedSpaceId]
        ?.find(session => session.id === currentSessionId)
        ?.message_count ?? null
    }, [currentSessionId, selectedSpaceId]),
  )
  const currentRollbackState = useChatStore(
    useCallback(
      (s) => {
        if (!currentSessionId) return null
        return s.sessions.find(session => session.id === currentSessionId)?.rollback_state ?? null
      },
      [currentSessionId],
    ),
  )
  const isSimpleRevert = isReverted && isSimpleRollback(null, currentRollbackState)

  // Wave 5：末尾 Run 状态指示器。必须走 getSessionById（Tracker 桶优先）。
  const currentTrackerRun = useChatStore(
    useCallback(
      (s) => {
        if (!currentSessionId) return null
        return s.getSessionById(currentSessionId)?.tracker_run ?? null
      },
      [currentSessionId],
    ),
  )

  const availableModels = useChatModelStore(s => s.availableModels)
  const isLoadingModels = useChatModelStore(s => s.isLoadingModels)
  const modelLoadError = useChatModelStore(s => s.modelLoadError)
  const sendableModels = useMemo(
    () => filterSendableChatModels(availableModels),
    [availableModels],
  )
  const effectiveModelLoadError = modelLoadError ?? (
    !isLoadingModels && availableModels.length > 0 && sendableModels.length === 0
      ? t(isCommunityDistribution
        ? 'model.communityNeedsProviderConfig'
        : 'model.needsProviderConfig')
      : null
  )
  // ── Actions（分叉 / 模型 —— HITL 已由 useSessionChatSurface 提供）──
  const {
    forkSession, loadModels,
  } = useChatActions()

  const chatMessages = useMemo(
    () => messages.map(m => ({ role: m.role, content: m.content || '' })),
    [messages],
  )

  const isNewTaskWelcome = resolveNewTaskWelcomeVisible({
    currentSessionId,
    currentSessionMessageCount,
    localMessageCount: messages.length,
    isDraftSession,
    isLoading,
  })
  const draftMessageHint = isNewTaskWelcome
    ? t('messageList.draftHint', { defaultValue: '当前是新对话草稿，发送第一条消息后会出现在列表中。' })
    : undefined
  const draftHasOpenApp = useSpaceContextTabsStore(state => (
    tabScopeKey
      ? (state.tabOrderBySpace[tabScopeKey]?.length ?? 0) > 0
      : false
  ))
  const draftWithApp = Boolean(draftMessageHint && draftHasOpenApp)
  const showWelcomeSuggestionBar = resolveWelcomeSuggestionBarVisible({
    isNewTaskWelcome,
    hasOpenApp: draftHasOpenApp,
  })
  const handleStarterSuggestionSelect = useCallback((prompt: string) => {
    const draftKey = resolveDraftKey(currentSessionId, selectedSpaceId)
    if (!draftKey) return
    setComposerDraftExternally(draftKey, prompt)
  }, [currentSessionId, selectedSpaceId])

  const isTeamDraftSpace = useSpaceStore(useCallback(
    (s) => s.spaces.find(space => space.id === selectedSpaceId)?.type === 'team_space',
    [selectedSpaceId],
  ))
  // ：工作空间切换仍以待发送消息的 open/sending 阶段为准；
  // ：Agent 身份与工作空间门闩拆开——个人正式会话可换 Agent，工作空间仍只读。
  // 主链稳定 A 优先；tabScopeKey 可能是 conversation:S，禁止据此 fallback 到 B。
  const draftScopeKey = resolveConversationDraftScopeKey({
    stableDraftScopeKey: stableDraftScopeKeyProp,
    tabScopeKey,
    legacyExecutionHostId: stableDraftScopeKeyProp ? null : selectedSpaceId,
  })
  const canSwitchDraftWorkspace = resolveCanSwitchDraftWorkspace({
    isTeamDraftSpace,
    isDraftSession,
    currentSessionId,
    draftSessionPhase: getPendingDraftSessionByScopeKey(draftScopeKey)?.phase ?? null,
  })
  const canChangeAgent = resolveCanChangeAgent({ isTeamDraftSpace })

  // ── Handlers ──
  const {
    deferOrRun,
    confirmPending,
    clearPending,
    dialogOpen: revertConfirmOpen,
  } = usePendingRevertSend()

  // 浮动输入区：输入区改为 absolute 覆盖在消息列表上层（毛玻璃）。测量它的实际高度，
  // 反馈给 MessageList 作为滚动内容底部留白，保证最后一条消息能滚到浮层之上、不被遮住。
  const [composerOverlayEl, setComposerOverlayEl] = useState<HTMLDivElement | null>(null)
  const [composerOverlayHeight, setComposerOverlayHeight] = useState(0)
  useLayoutEffect(() => {
    const h = composerOverlayEl?.getBoundingClientRect().height ?? 0
    if (h > 0) setComposerOverlayHeight(h)
  }, [composerOverlayEl, draftMessageHint, draftWithApp])
  useScopedResizeObserver(composerOverlayEl, (entries) => {
    const h = entries[0]?.contentRect.height ?? 0
    // 忽略 0 高观测，保留上次非 0 高度：Composer 始终含输入框、真实高度不会为 0；
    // display:none 前后台切换 / 观察器重挂 / 布局瞬时都会瞬报 0，若采纳会让底部留白
    // （bottomPadding spacer）塌回最小值 32、末条消息被浮动输入框遮住（留白「有时消失」）。
    if (h > 0) setComposerOverlayHeight(h)
  })

  // MessageList ref —— 用户主动发消息后调 scrollToBottom 强制跳底（绕过
  // isAtBottom 守卫）。iMessage / WeChat / Telegram / ChatGPT 通用约定：
  // 用户自己刚发的消息一定要可见，即使原本在阅读历史中段。普通的"新消息
  // 到达"路径仍受 isAtBottom 守卫保护，不会打扰中段读历史的用户。
  const messageListRef = useRef<MessageListHandle | null>(null)
  const pendingInitialSendScrollAfterCountRef = useRef<number | null>(null)
  const pendingForkScrollSessionIdRef = useRef<string | null>(null)
  const markPendingInitialSendScroll = useCallback(() => {
    pendingInitialSendScrollAfterCountRef.current = beginSendScroll({
      messageCount: messages.length,
      requestFollow: () => messageListRef.current?.scrollToBottom(),
    })
    return messages.length
  }, [messages.length])
  const clearPendingInitialSendScrollIfUnchanged = useCallback((initialCount: number) => {
    if (pendingInitialSendScrollAfterCountRef.current === initialCount) {
      pendingInitialSendScrollAfterCountRef.current = null
    }
  }, [])
  const schedulePendingInitialSendScrollCleanup = useCallback((initialCount: number) => {
    requestAnimationFrame(() => clearPendingInitialSendScrollIfUnchanged(initialCount))
  }, [clearPendingInitialSendScrollIfUnchanged])

  useEffect(() => {
    const previousCount = pendingInitialSendScrollAfterCountRef.current
    if (previousCount == null || messages.length <= previousCount) return

    pendingInitialSendScrollAfterCountRef.current = null
    messageListRef.current?.scrollToBottom()
  }, [messages.length])

  useEffect(() => {
    if (!currentSessionId || pendingForkScrollSessionIdRef.current !== currentSessionId) return
    if (messages.length === 0) return

    pendingForkScrollSessionIdRef.current = null
    requestAnimationFrame(() => {
      messageListRef.current?.scrollToBottom()
    })
  }, [currentSessionId, messages.length])

  const runSendWithScroll = useCallback(async (
    message: string,
    attachments?: ChatAttachment[],
    contextBlocks?: Array<Record<string, unknown>>,
    options?: ChatInputSendOptions,
  ) => {
    const initialCount = markPendingInitialSendScroll()
    const sendPromise = onSendMessage(message, attachments, contextBlocks, options)
    contextInjection.clearRefs()
    try {
      await sendPromise
      schedulePendingInitialSendScrollCleanup(initialCount)
    } catch (error) {
      clearPendingInitialSendScrollIfUnchanged(initialCount)
      throw error
    }
  }, [
    clearPendingInitialSendScrollIfUnchanged,
    contextInjection,
    markPendingInitialSendScroll,
    onSendMessage,
    schedulePendingInitialSendScrollCleanup,
  ])

  const handleSend = useCallback(async (
    message: string,
    attachments?: ChatAttachment[],
    contextBlocks?: Array<Record<string, unknown>>,
    options?: ChatInputSendOptions,
  ) => {
    await deferOrRun(
      isReverted && !isSimpleRevert,
      { message, attachments, contextBlocks, options },
      async (payload) => {
        await runSendWithScroll(
          payload.message,
          payload.attachments,
          payload.contextBlocks,
          payload.options,
        )
      },
    )
  }, [deferOrRun, isReverted, isSimpleRevert, runSendWithScroll])

  const handleContinueAfterError = useCallback(() => {
    if (!currentSessionId) return
    void deferOrRun(
      isReverted && !isSimpleRevert,
      { message: '', continueAfterError: true },
      async () => {
        await continueAgentAfterError(currentSessionId)
      },
    )
  }, [currentSessionId, deferOrRun, isReverted, isSimpleRevert])

  useRetryLastMessageListener({
    sessionId: currentSessionId,
    isStreaming: isCurrentSessionStreaming,
    messages,
    onContinue: handleContinueAfterError,
  })

  const handleQuickPrompt = useCallback(async (text: string) => {
    if (!effectiveCanSend) return
    await runSendWithScroll(text)
  }, [effectiveCanSend, runSendWithScroll])

  const handleForkFromMessage = useCallback((messageId: string) => {
    if (sharedAccessShareId) {
      setSharedForkWizardOpen(true)
      return
    }
    if (currentSessionId && selectedSpaceId) {
      void forkSession(selectedSpaceId, currentSessionId, messageId).then((newSession) => {
        if (!newSession) return
        pendingForkScrollSessionIdRef.current = newSession.id
        requestAnimationFrame(() => {
          const latestState = useChatStore.getState()
          if (latestState.currentSessionId !== newSession.id) return
          messageListRef.current?.scrollToBottom()
          if ((latestState.messagesBySessionId[newSession.id]?.length ?? 0) > 0) {
            pendingForkScrollSessionIdRef.current = null
          }
        })
      })
    }
  }, [currentSessionId, selectedSpaceId, forkSession, sharedAccessShareId])

  const handleSharedForkConfirm = useCallback(async (agentId: string, workspaceId: string) => {
    if (!currentSessionId || !sharedComposer.forkShareId || !sharedComposer.capabilities.canForkWholeSession) {
      return
    }
    const newSession = await sharedFork(currentSessionId, {
      agentId,
      workspaceId,
      shareId: sharedComposer.forkShareId,
    })
    setSharedForkWizardOpen(false)
    const hostSpaceId = newSession.space_id ?? newSession.workspace_id ?? workspaceId
    await enterChatSession(hostSpaceId, newSession.id, {
      organizationId: newSession.organization_id,
    })
    toast({ title: t('sharedPane.forkSuccess', { defaultValue: '已创建共享副本' }) })
  }, [currentSessionId, sharedComposer.capabilities.canForkWholeSession, sharedComposer.forkShareId, t])

  const reportRichResourceOpenFailure = useCallback((
    outcome: OpenOutcome | null | undefined,
    opts?: { modifierExternal?: boolean },
  ) => {
    if (!shouldToastRichResourceOpenFailure(outcome, opts)) return
    if (outcome?.outcome === 'system_app_opened') {
      toast({
        title: t('contextBlock.openFailed', { defaultValue: '在工作空间内打开失败，请重试' }),
        description: t('contextBlock.openFellBackToSystem', {
          defaultValue: '未能在工作空间内打开该资源，已尝试用系统应用打开。',
        }),
        variant: 'destructive',
      })
      return
    }
    toast({
      title: t('contextBlock.openFailed', { defaultValue: '在工作空间内打开失败，请重试' }),
      description: outcome?.errorMessage,
      variant: 'destructive',
    })
  }, [t])

  const handleContextBlockNavigate = useCallback(async (block: import('../context/ContextRefCard').ContextBlock) => {
    if (sharedAccessShareId) {
      const result = await openSharedSessionCloudResourceFromBlock({
        block,
        organizationId: sharedSession?.organization_id ?? null,
        tabScopeKey,
      })
      if (result.ok || result.reason === 'unsupported') return
      toast({
        title: t('sharedPane.openResourceFailed', {
          defaultValue: '无法打开该产物',
        }),
        description: t('sharedPane.openResourceFailedDesc', {
          defaultValue: '资源可能已删除，或你没有访问权限',
        }),
        variant: 'destructive',
      })
      return
    }
    await navigateContextBlock(
      { block, selectedSpaceId, tabScopeKey },
      {
        expandCanvasAfterInSpaceOpen,
        expandCanvasForScope,
        reportRichResourceOpenFailure,
        warn: (...args: unknown[]) => logger.warn(...args),
        toastNoSpace: () => {
          toast({
            title: t('contextBlock.openFailedNoSpace', {
              defaultValue: '当前无工作空间上下文，无法在工作空间内打开',
            }),
            variant: 'destructive',
          })
        },
        toastOpenFailed: (description) => {
          toast({
            title: t('contextBlock.openFailed', { defaultValue: '在工作空间内打开失败，请重试' }),
            description,
            variant: 'destructive',
          })
        },
      },
    )
  }, [
    reportRichResourceOpenFailure,
    currentSessionId,
    selectedSpaceId,
    sharedAccessShareId,
    sharedSession?.organization_id,
    tabScopeKey,
    t,
  ])

  /**
   * 右键资源 ref 卡片 → 弹 ResourceLinkContextMenu（与 markdown 链接右键菜单对齐）。
   * 「Agent 产物在 Space 内的打开」机制 B。
   */
  const handleContextBlockContextMenu = useCallback(async (
    block: import('../context/ContextRefCard').ContextBlock,
    x: number,
    y: number,
  ) => {
    if (!block.resource_id || !block.type) return
    const spaceId = block.space_id ?? selectedSpaceId ?? ''
    const targetTabScopeKey = tabScopeKey || selectedSpaceId || spaceId
    try {
      const { showResourceLinkContextMenu } = await import('../context/ResourceLinkContextMenu')
      // ：与左键同源，经 parseResourcePointer 归一化 doc→document
      const pointer = buildRichResourcePointer(
        block.type,
        block.resource_id,
        block.hint_carrier_app_id,
      )
      showResourceLinkContextMenu({
        x,
        y,
        href: pointer.raw,
        spaceId,
        tabScopeKey: targetTabScopeKey,
        pointer,
      })
    } catch (err) {
      logger.warn('[ChatPanel] context block context menu failed:', err)
    }
  }, [selectedSpaceId, tabScopeKey])

  // ── ：整个对话面板都可作为文件拖拽落点 ──
  // ChatInput 通过 dropApiRef 暴露统一的文件注入能力；这里在面板外层兜住外部文件
  // 与对话内 file-ref，使用户不必精准命中底部输入框。
  // 不干扰 TabDoc 上下文块拖拽等内部 DnD（它们由 ChatInput 输入框 onDrop 处理）。
  const chatInputDropApiRef = useRef<{
    ingestFiles: (files: File[]) => void
    ingestAttachments?: (attachments: ChatAttachment[]) => void
  } | null>(null)
  const [isPanelFileDragOver, setIsPanelFileDragOver] = useState(false)
  // dragover 持续触发：用定时器在拖拽离开后自动隐藏遮罩，避免子元素 stopPropagation
  // 造成的 enter/leave 计数失衡（输入框 onDragLeave 会吞掉 leave 冒泡）。
  const panelDragHideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => {
    if (panelDragHideTimerRef.current) clearTimeout(panelDragHideTimerRef.current)
  }, [])
  const dragEventAcceptsComposerFiles = useCallback(
    (e: React.DragEvent) => {
      const types = Array.from(e.dataTransfer?.types ?? [])
      return types.includes('Files') || isChatFileRefDropAcceptable(e.dataTransfer)
    },
    [],
  )
  const handlePanelFileDragOver = useCallback((e: React.DragEvent) => {
    if (!dragEventAcceptsComposerFiles(e)) return
    e.preventDefault()
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
    setIsPanelFileDragOver(true)
    if (panelDragHideTimerRef.current) clearTimeout(panelDragHideTimerRef.current)
    panelDragHideTimerRef.current = setTimeout(() => setIsPanelFileDragOver(false), 150)
  }, [dragEventAcceptsComposerFiles])
  const handlePanelFileDrop = useCallback((e: React.DragEvent) => {
    if (!dragEventAcceptsComposerFiles(e)) return
    e.preventDefault()
    e.stopPropagation()
    if (panelDragHideTimerRef.current) clearTimeout(panelDragHideTimerRef.current)
    setIsPanelFileDragOver(false)

    const dt = e.dataTransfer
    if (!dt) return
    const filesSnapshot = Array.from(dt.files ?? [])
    if (filesSnapshot.length > 0 && !isChatFileRefDropAcceptable(dt)) {
      chatInputDropApiRef.current?.ingestFiles(filesSnapshot)
      return
    }
    if (isChatFileRefDropAcceptable(dt)) {
      void (async () => {
        const result = await resolveChatFileRefDrop(dt, filesSnapshot)
        if (result.kind === 'files') {
          chatInputDropApiRef.current?.ingestFiles(result.files)
          return
        }
        if (result.kind === 'attachments') {
          chatInputDropApiRef.current?.ingestAttachments?.(result.attachments)
          return
        }
        if (result.kind === 'missing_url') {
          toast.warning(t('input.fileRefDropMissingUrl', {
            name: result.name,
            defaultValue: '「{{name}}」缺少可访问地址，无法添加到对话',
          }))
          return
        }
        if (result.kind === 'error') {
          toast.warning(t('input.fileRefDropFailed', {
            name: result.name,
            defaultValue: '「{{name}}」添加到对话失败，请重试或另存后再拖入',
          }))
        }
      })()
      return
    }
    if (filesSnapshot.length > 0) {
      chatInputDropApiRef.current?.ingestFiles(filesSnapshot)
    }
  }, [dragEventAcceptsComposerFiles, t])

  return (
    <div
      onDragOver={handlePanelFileDragOver}
      onDrop={handlePanelFileDrop}
      className={cn(
        'flex h-full min-w-0 w-full flex-col overflow-hidden relative',
      )}
    >
      {isPanelFileDragOver && (
        <div className="pointer-events-none absolute inset-0 z-overlay flex items-center justify-center bg-accent/5 backdrop-blur-[1px]">
          <div className="surface-glass-overlay flex items-center gap-2 rounded-[12px] px-5 py-3 text-body font-medium text-accent-text">
            <ImageIcon className="h-5 w-5" />
            <span>{t('input.panelDropHint', { defaultValue: '松开以添加文件到对话' })}</span>
          </div>
        </div>
      )}
      <div
        className={cn(
          'relative flex min-w-0 min-h-0 h-full flex-1 flex-col w-full',
        )}
      >
        {/* ：对话区上方通知带——永远只显示一条；≥2 条时卡片内右下角 ◀ x/y ▶ 翻历史，
            默认最新（x=y）。各横幅自身逻辑不变，ChatNoticeStack 按 data-chat-notice
            锚点排序分页。 */}
        <ChatNoticeStack compactLeft={compactLeft}>
          <CapabilityBanners sessionId={currentSessionId} />
          {/* BudgetAlertBanner 已软下线：团队预算告警等计费管理重做后再挂回 */}
          {/* W4.5-A3-followup：≥9 条 SYSTEM_NOTICE 路径
              （context_truncated / tool_failure_* / tool_repetition_* /
              subagent_spawn_blocked / model_override / model_fallback /
              tool_timeout / subagent_hitl_required / speaker_push_message）
              写入 agentStepsBySessionId 后，W4c 退役 MessageSteps 组件后
              components/ 下 0 处订阅——本 banner 区订阅并展示。 */}
          <SystemNoticeBanner sessionId={currentSessionId} spaceId={selectedSpaceId} />
        </ChatNoticeStack>

        {/* mb-4：消息列表不直通到底，留出底部边距，避免浮动输入卡片的下圆角处漏出后面的消息 */}
        <div className={cn(
          'relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden',
          !sharedAccessShareId && 'mb-4',
        )}>
          {/*
            切 session **不要** 用 key 强制 remount MessageList。
            useSafeVirtualizer 的 observeElementRect 首次量走 RAF（避 React ），
            remount 后会空窗几百 ms（data-virtual-row-count=0）再出内容——体感「闪一下」。
            跨 session 的 prevMessageCount / wasLoadingMore / 高亮等局部状态由
            MessageList 内 sessionId 变化时的 layout effect 主动 reset；
            视口 controller 本身按 sessionId 重建，初始即为 follow-latest。
          */}
          <div
            className={cn('flex min-h-0 flex-1', draftMessageHint && 'invisible')}
            aria-hidden={draftMessageHint ? true : undefined}
          >
            {sharedAccessShareId && sharedComposer.denied ? (
              <div className="flex h-full flex-1 flex-col items-center justify-center gap-1.5 px-4 text-center">
                <Share2 className="h-6 w-6 text-muted-foreground/40" aria-hidden />
                <p className="text-body text-muted-foreground">
                  {t('sharedPane.deniedEmpty', { defaultValue: '共享已停止或无权查看' })}
                </p>
              </div>
            ) : (
              <SharedSessionPreviewProvider
              sessionId={sharedAccessShareId ? currentSessionId : null}
              shareId={sharedAccessShareId}
              organizationId={sharedSession?.organization_id ?? null}
              tabScopeKey={sharedAccessShareId ? tabScopeKey : null}
            >
              <MessageList
                ref={messageListRef}
                sessionId={currentSessionId}
                isMessageVisible={sharedAccessShareId
                  ? isSharedTimelineMessageVisible
                  : undefined}
                tabScopeKey={tabScopeKey}
                isLoading={isLoading && messages.length === 0}
                isLoadingMore={isLoadingMore}
                hasMore={hasMore}
                onLoadMore={currentSessionId ? onLoadMore : undefined}
                onSuggestionSelect={effectiveCanSend ? handleQuickPrompt : undefined}
                agentSuggestions={selectedSpace?.suggested_prompts}
                onForkFromMessage={currentSessionId && (
                  sharedComposer.capabilities.canMutateHistory
                  || sharedComposer.capabilities.canForkWholeSession
                )
                  ? handleForkFromMessage
                  : undefined}
                accessCapabilities={sharedComposer.capabilities}
                onContextBlockNavigate={handleContextBlockNavigate}
                onContextBlockContextMenu={handleContextBlockContextMenu}
                scrollTargetMessageId={scrollTargetMessageId}
                scrollTargetHighlight={scrollTargetHighlight}
                onScrollTargetReached={clearScrollTarget}
                contentPadding={compactLeft ? CHAT_PAGE_GUTTER.compact.content : undefined}
                bottomPadding={composerOverlayHeight > 0
                  ? composerOverlayHeight + 8
                  : undefined}
              />
              </SharedSessionPreviewProvider>
            )}
          </div>
          <ExecutionTargetWizard
            open={sharedForkWizardOpen}
            onOpenChange={setSharedForkWizardOpen}
            title={t('sharedPane.forkWizardTitle', { defaultValue: '复制到我的任务' })}
            onConfirm={handleSharedForkConfirm}
          />
          {draftMessageHint && draftWithApp ? (
            <AppOpenDraftWelcome
              title={t('input.starterSuggestions.appOpenFallbackTitle', {
                defaultValue: '应用已经打开',
              })}
              hint={t('input.starterSuggestions.appOpenHint', {
                defaultValue: '可以先查看或编辑右侧内容，然后在输入框说明要做的事。',
              })}
            />
          ) : null}
          {/* Wave 5 (charter v1.8 §6.7 表达点 #4): 末尾 Run 状态指示器 */}
          {currentTrackerRun && (
            <TrackerRunStatusIndicator trackerRun={currentTrackerRun} />
          )}
        </div>

        {/*
         * 浮动输入区：绝对定位覆盖在消息列表上层。消息从其下方滚动穿过（毛玻璃 +
         * 半透明背景柔化），底部留白由 MessageList.bottomPadding（测量本浮层高度）保证。
         */}
        {(!sharedAccessShareId || sharedComposer.visible) ? <div
          ref={setComposerOverlayEl}
          className={cn(
            'absolute inset-x-0 z-sticky',
            draftMessageHint && !draftWithApp
              ? 'flex max-h-[calc(100%-2rem)] min-h-0 flex-col'
              : 'bottom-3',
          )}
          style={draftMessageHint && !draftWithApp
            ? {
              top: resolveWelcomeComposerTop(composerOverlayHeight),
            }
            : undefined}
        >
          <div
            className={cn(
              'relative',
              draftMessageHint && !draftWithApp && 'flex min-h-0 flex-1 flex-col',
            )}
          >
            {draftMessageHint && !draftWithApp ? (
              <h1 className={cn(
                'w-full max-w-2xl shrink-0 self-center px-6 text-center',
                'font-semibold tracking-tight text-display leading-[1.25] text-foreground text-balance',
                WELCOME_COMPOSER_LAYOUT.titleGap,
              )}>
                {t('input.welcomeTitleBefore')}
                <AgentAvatar
                  agentId={currentAgentDisplay?.agentId}
                  name={welcomeAgentName}
                  avatarUrl={currentAgentDisplay?.avatarUrl}
                  // 行内嵌入「和」与分身名之间；随 display 标题用 em 缩放
                  className="mx-2 inline-block !h-[1.25em] !w-[1.25em] !rounded-full align-[-0.22em]"
                />
                <span className="whitespace-nowrap">{welcomeAgentName}</span>
                {t('input.welcomeTitleAfter')}
              </h1>
            ) : null}
            <div
              className={cn(
                // 外层 backplate 作为灰「托盘」完整框住输入井（四周对称 padding），
                // 对齐 release/0.0.3：白底输入井在上、工作空间/模型底栏在下；
                // 新任务欢迎态居中悬浮，不需要托盘背板。
                'no-drag space-y-1.5 overflow-visible rounded-[12px] chat-composer-backplate',
                !(draftMessageHint && !draftWithApp) && 'flex-shrink-0',
                compactLeft ? 'p-1' : 'p-1.5',
                draftMessageHint && !draftWithApp
                  ? 'relative mx-auto flex min-h-0 w-[calc(100%-2rem)] max-w-4xl flex-1 flex-col'
                  : compactLeft || draftWithApp
                  ? CHAT_PAGE_GUTTER.compact.composerMargin
                  : CHAT_PAGE_GUTTER.panel.composerMargin,
              )}
            >
            {draftMessageHint && !draftWithApp ? <ComposerWelcomeMascot /> : null}
            {/* 遥控器状态 / 执行设备不可达提示：不把“遥控”误解成“不能聊天”。 */}
            {!sharedGrantee ? <RemoteExecutionNoticeGate
              gate={remoteExecution}
              compact={Boolean(draftMessageHint)}
            /> : null}
            {/* 「异步任务感知」B：turn 结束但仍有子 Agent / 后台命令在跑时的预告条。 */}
            {!sharedGrantee ? <PendingTasksNotice sessionId={currentSessionId} spaceId={selectedSpaceId} /> : null}
            <ChatInput
            key={composerDraftScopeKey(currentSessionId, selectedSpaceId)}
            dropApiRef={chatInputDropApiRef}
            onSend={sharedGrantee ? sharedComposer.onSend : handleSend}
            onStop={sharedGrantee ? undefined : onStop}
            allowInterruptedEditRecovery
            disabled={sharedGrantee
              ? !sharedComposer.capabilities.canSendSharedChat || sharedComposer.offline
              : !effectiveCanSend || isRestoring || isSendInFlight}
            disabledReason={sharedGrantee ? sharedComposer.disabledReason : effectiveDisabledReason}
            isStreaming={!sharedGrantee && (isCurrentSessionStreaming || isRestoring)}
            contextRefs={sharedGrantee ? [] : contextInjection.contextRefs}
            onAddContextRef={sharedGrantee ? undefined : contextInjection.addContextRef}
            onRemoveContextRef={sharedGrantee ? undefined : contextInjection.removeRef}
            onClearContextRefs={sharedGrantee ? undefined : contextInjection.clearRefs}
            models={sharedGrantee ? [] : sendableModels}
            currentModel={sharedGrantee ? null : currentModel}
            onModelChange={sharedGrantee ? undefined : onModelChange}
            readOnlyModelName={sharedGrantee
              ? sharedSession?.current_model_name ?? sharedSession?.current_model_id ?? null
              : null}
            currentContextTier={sharedGrantee ? null : currentContextTier}
            currentModelParamOverrides={sharedGrantee ? null : currentModelParamOverrides}
            canChangeModel={!sharedGrantee}
            isLoadingModels={!sharedGrantee && isLoadingModels}
            modelLoadError={sharedGrantee ? null : effectiveModelLoadError}
            onRetryLoadModels={sharedGrantee ? undefined : () => { void loadModels() }}
            {...(!sharedGrantee ? hitlProps : {})}
            tokenUsage={sharedGrantee ? null : tokenUsage}
            queueCount={sharedGrantee ? 0 : queueCount}
            isSendInFlight={!sharedGrantee && isSendInFlight}
            compactLeft={compactLeft || draftWithApp}
            enableAgentPicker={!sharedGrantee && canSwitchDraftWorkspace}
            canChangeAgent={!sharedGrantee && canChangeAgent}
            draftScopeKey={draftScopeKey}
            showAgentIdentity={!sharedGrantee}
            showAddMenu={!sharedGrantee}
            composerWelcomeLayout={Boolean(draftMessageHint && !draftWithApp)}
            chatMessages={chatMessages}
            spaceId={sharedGrantee ? null : selectedSpaceId}
            spaceName={sharedGrantee ? null : selectedSpace?.name ?? null}
            onExecutionSpaceChange={sharedGrantee ? undefined : onExecutionSpaceChange}
            tabScopeKey={tabScopeKey}
            sessionId={currentSessionId}
            presetScopeId={presetScopeId}
            fieldTableId={activeTable?.id ?? null}
            fieldTableName={activeTable?.name ?? null}
            contextDisplay={effectiveGraphType === 'chat' ? contextDisplay : null}
            />
            </div>
            {showWelcomeSuggestionBar ? (
              <div className="pointer-events-auto absolute inset-x-0 top-full z-sticky mt-2">
                <WelcomeSuggestionBar
                  activeContextType={null}
                  onSelect={handleStarterSuggestionSelect}
                  className="mt-0"
                />
              </div>
            ) : null}
          </div>
        </div> : null}
      </div>
      <ConfirmDialog
        open={revertConfirmOpen}
        onOpenChange={(open) => { if (!open) clearPending() }}
        title={t('checkpoint.sendWhileRevertedTitle', { defaultValue: '确认继续' })}
        description={t('checkpoint.sendWhileRevertedDesc', { defaultValue: '发送新消息后，被回退的对话将被永久删除且无法撤销。确定继续？' })}
        variant="destructive"
        onConfirm={() => confirmPending(async (payload) => {
          if (payload.continueAfterError) {
            if (currentSessionId) await continueAgentAfterError(currentSessionId)
            return
          }
          await onSendMessage(payload.message, payload.attachments, payload.contextBlocks, payload.options)
          contextInjection.clearRefs()
        })}
      />
    </div>
  )
})
ChatContent.displayName = 'ChatContent'
