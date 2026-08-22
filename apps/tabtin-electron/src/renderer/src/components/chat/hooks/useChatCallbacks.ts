/**
 * useChatCallbacks — 会话操作 + 发送流程 + 模型/群聊配置回调
 *
 * 提取自 ChatPanel.tsx，集中管理所有用户交互回调函数，
 * 包括会话切换/创建/删除/分叉、消息发送、模型切换、group runtime 更新。
 */

import { useCallback, useEffect, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from '@tabtin/smartsheet-ui'
import { logger } from '@/utils/logger'
import { useChatStore } from '@/stores/chat/useChatStore'
import { useChatModelStore } from '@/stores/useChatModelStore'
import { useChatSplitStore } from '@/stores/useChatSplitStore'
import { useSpaceListStore } from '@/stores/useSpaceListStore'
import { useSpaceStore } from '@/stores/useSpaceStore'
import { useSpaceContextTabsStore } from '@/stores/useSpaceContextTabsStore'
import { useSpaceViewPrefsStore } from '@/stores/useSpaceViewPrefsStore'
import { rehomeConversationScopeLayout } from '@/services/rehomeConversationScopeLayout'
import { rehomeConversationScopeRuntime } from '@/services/rehomeConversationScopeRuntime'
import { isCommunityDistribution } from '@/config/distribution'
import type { ModelParamValue } from '@tabtin/chat-client'
import type { ChatAttachment } from '../types'
import type { ChatInputSendOptions } from '../composer/ChatInput'
import type { SpaceContext } from '@components/context-space/SpaceContextContainer'
import {
  filterSendableChatModels,
  isSendableChatModelId,
} from '@/utils/chatModelGuards'
import { isOpenAICodexModel } from '../../../../../shared/openai-codex-models'
import {
  createRuntimeModelAvailabilityChecker,
  readRuntimeModelPreference,
  resolveLocalRuntimeAlignTarget,
  resolveRuntimeDefaultModelId,
  toProvisionModelId,
  writeRuntimeModelPreference,
  writeRuntimeModelParamPreference,
} from '@/stores/chat/session/runtimeModelPreference'
import {
  beginSendTimingTrace,
  clearSendTimingTrace,
  trackSendTimingTelemetry,
  type SendTimingTrace,
} from '@/stores/chat/execution/sendTimingTrace'
import {
  waitForInFlightSessionCreate,
  type EnsureSessionForSpaceResult,
} from '@/stores/chat/session/actions/sessionLifecycleAction'
import {
  allocatePendingFirstSendTarget,
  commitPendingFirstSendState,
  isLocalPendingSessionId,
  trackPendingFirstSendUserVisible,
} from '@/stores/chat/session/actions/pendingFirstSend'
import { rememberLocallySubmittedSession } from '@/stores/chat/session/locallySubmittedSessionRegistry'
import { registerPendingFirstSendRetryHandler } from '@/stores/chat/session/actions/pendingFirstSendRetry'
import {
  getDraftMessageByScopeKey,
  isDraftMessageActive,
  peekDraftModelIntent,
  peekDraftModelParamOverrides,
} from '@/stores/chat/session/draftMessage'
import {
  beginDraftMessageSession,
  syncDraftModelIntent,
} from '@/stores/chat/session/draftMessageSessionCoordinator'
import {
  bindDraftSessionToMessage,
  findBoundLocalPendingForDraftMessage,
  getDraftSessionBySessionId,
} from '@/stores/chat/session/draftSession'
import {
  buildDraftMessageMetadataFromLegacy,
  buildDraftMessageSessionContext,
  resolveConversationDraftScopeKey,
} from '@/stores/chat/session/draftMessageLegacyAdapter'
import { resolveExistingSessionIdForDraftFirstSend } from '@/stores/chat/session/draftSessionCoordinator'
import { isReclaimableDraftPrefetchShell } from '@/stores/chat/session/draftSessionTargetPolicy'
import type { DraftScopePointerOptions } from '@/stores/chat/session/slices/sessionPointerSlice'
import { takeFailedMessageEditResend } from '@/stores/chat/messages/actions/failedMessageEditResend'
import { notify } from '@/utils/notify'
import { confirmPromotionCreditModelSwitch } from '../model/providerCreditPresentation'
import { resolveDraftKey } from '../composer/chatInputDraft'

interface UseChatCallbacksParams {
  selectedSpaceId: string | null
  resolvedOrganizationId: string | null
  currentSessionId: string | null
  /** 嵌入式工作台固定的会话；存在时发送不得回退到全局会话指针。 */
  controlledSessionId?: string
  selectedSpace: SpaceContext | null
  /** 当前工作台 scope（可为 `conversation:S`）；不等于稳定新草稿 scope */
  tabScopeKey?: string | null
  /**
   * 产品宿主上的稳定新草稿 opaque scope A（`conversation:draft:…`）。
   * 与当前会话 scope 解耦；主链 start/select/cancel/首发必须用它，禁止用 execution B 推导。
   */
  draftScopeKey?: string | null
  /** 产品宿主 Space id（Project / 工作空间）；新任务 startDraft 写 UI 指针用，≠ execution B */
  conversationHostSpaceId?: string | null
  resolveSessionSpaceId?: (sessionId: string) => string | null

  effectiveGraphType: 'chat' | null
  activeContextType: string | null
  activeAppMeta: Record<string, unknown> | null
  openTabs: Array<{type: string; id: string; title?: string; active?: boolean; group_id?: string; [key: string]: unknown}> | null

  pendingModelId: string | null
  setPendingModelId: (id: string | null) => void
  setPendingModelParamOverride: (key: string, value: ModelParamValue) => void
  /** 草稿同步后用 session 全量 overrides 覆盖 pending（含 fast_by_model）。 */
  replacePendingModelParamOverrides?: (overrides: Record<string, ModelParamValue> | null) => void

  selectSession: (
    spaceId: string,
    sessionId: string,
    options?: DraftScopePointerOptions,
  ) => Promise<unknown>
  startDraftSessionForSpace: (
    spaceId: string,
    syncCurrent?: boolean,
    options?: DraftScopePointerOptions,
  ) => void
  deleteSession: (spaceId: string, sessionId: string) => Promise<void>
  renameSession: (spaceId: string, sessionId: string, title: string) => Promise<void>
  forkSession: (spaceId: string, sessionId: string, messageId?: string) => Promise<unknown>
  ensureSessionForSpace: (
    spaceId: string,
    organizationId?: string,
    modelId?: string,
    options?: {
      trigger?: 'pre_send' | 'explicit' | 'prefetch'
      preferQuickStart?: boolean
      contextPayload?: Record<string, unknown>
      expectedDraftMessageId?: string
    },
  ) => Promise<EnsureSessionForSpaceResult>
  sendMessage: (
    message: string,
    streaming: boolean,
    attachments?: ChatAttachment[],
    contextBlocks?: Array<Record<string, unknown>>,
    sessionId?: string,
    options?: ChatInputSendOptions & {
      sendTimingTrace?: SendTimingTrace
      existingClientMessageId?: string
      expectedDraftMessageId?: string
    },
  ) => Promise<unknown>
  /** 主 Composer 单一 Stop：按是否已有实质输出决定只停答或撤回回填 */
  abortStreamFromComposer: (sessionId: string) => Promise<void>
  syncContext: (spaceId?: string | null, contextType?: string | null, appMeta?: Record<string, unknown> | null, openTabs?: Array<{type: string; id: string; title?: string; active?: boolean; group_id?: string; app_key?: string; display_name?: string; is_home?: boolean; [key: string]: unknown}> | null, options?: { force?: boolean; deferHttpPersist?: boolean; tabScopeKey?: string | null; workspaceScopeKey?: string | null }) => Promise<void>
  switchModel: (sessionId: string, modelId: string, contextTierId?: string) => Promise<void>
  switchContextTier: (sessionId: string, tierId: string | null) => Promise<void>
  setModelParamOverride: (sessionId: string, key: string, value: ModelParamValue) => Promise<void>
  togglePinSession: (spaceId: string, sessionId: string) => void
}

export function useChatCallbacks(params: UseChatCallbacksParams) {
  const { t } = useTranslation('chat')
  const {
    selectedSpaceId, resolvedOrganizationId, currentSessionId, controlledSessionId, selectedSpace, tabScopeKey,
    draftScopeKey: stableDraftScopeKey,
    conversationHostSpaceId,
    resolveSessionSpaceId,
    effectiveGraphType, activeContextType, activeAppMeta, openTabs,
    pendingModelId, setPendingModelId, setPendingModelParamOverride,
    replacePendingModelParamOverrides,
    selectSession, startDraftSessionForSpace, deleteSession, renameSession, forkSession,
    ensureSessionForSpace, sendMessage, abortStreamFromComposer, syncContext, switchModel, switchContextTier, setModelParamOverride, togglePinSession,
  } = params

  const availableModels = useChatModelStore(s => s.availableModels)
  const sendableModels = useMemo(
    () => filterSendableChatModels(availableModels),
    [availableModels],
  )
  const sendableModelIds = useMemo(
    () => new Set(sendableModels.map(model => model.id)),
    [sendableModels],
  )
  const selectSpaceBySpaceId = useSpaceListStore(s => s.selectSpaceBySpaceId)

  // ── 会话操作 ──

  const getSessionSpaceId = useCallback((sessionId: string) => {
    return resolveSessionSpaceId?.(sessionId) ?? selectedSpaceId
  }, [resolveSessionSpaceId, selectedSpaceId])

  /**
   * 稳定 draft scope A：主链显式 stable 优先；
   * 仅当未提供 stable 时才允许 tab draft / legacy host fallback。
   */
  const resolvePanelDraftScopeKey = useCallback(() => {
    return resolveConversationDraftScopeKey({
      stableDraftScopeKey,
      tabScopeKey,
      // 无 stable 时才允许；有 stable 时 adapter 不会读到此 fallback
      legacyExecutionHostId: stableDraftScopeKey ? null : selectedSpaceId,
    })
  }, [selectedSpaceId, stableDraftScopeKey, tabScopeKey])

  const handleTabClick = useCallback(async (sessionId: string) => {
    if (sessionId === currentSessionId) return
    const targetSpaceId = getSessionSpaceId(sessionId)
    if (!targetSpaceId) return
    if (targetSpaceId !== selectedSpaceId) {
      selectSpaceBySpaceId(targetSpaceId)
    }
    const draftScopeKey = resolvePanelDraftScopeKey()
    await selectSession(targetSpaceId, sessionId, {
      draftScopeKey,
      organizationId: resolvedOrganizationId,
    })
  }, [
    currentSessionId,
    getSessionSpaceId,
    resolvePanelDraftScopeKey,
    resolvedOrganizationId,
    selectSession,
    selectSpaceBySpaceId,
    selectedSpaceId,
  ])

  const handleNewSession = useCallback(() => {
    // 新任务落在产品宿主 A 上；execution B 仅作元数据，绝不 begin B draftMessage
    const hostSpaceId = conversationHostSpaceId ?? selectedSpaceId
    if (!hostSpaceId) return
    const draftScopeKey = resolvePanelDraftScopeKey()
    if (!draftScopeKey) {
      logger.error('[ChatPanel] 无法解析稳定 draftScopeKey，放弃新建')
      return
    }
    startDraftSessionForSpace(hostSpaceId, true, {
      draftScopeKey,
      organizationId: resolvedOrganizationId,
      ...(selectedSpaceId && selectedSpaceId !== hostSpaceId
        ? { executionWorkspaceId: selectedSpaceId }
        : {}),
    })
  }, [
    conversationHostSpaceId,
    resolvePanelDraftScopeKey,
    resolvedOrganizationId,
    selectedSpaceId,
    startDraftSessionForSpace,
  ])

  const handleDeleteSession = useCallback(async (sessionId: string) => {
    const targetSpaceId = getSessionSpaceId(sessionId)
    if (!targetSpaceId) return
    // 关历史 Tab 不要 selectSpaceBySpaceId：组织级顶栏混显多 Space 会话时，
    // 切到被关会话所属 Space 会重跑生命周期 → draft + quick-start，表现为
    // 「关掉一个新任务又冒出一个」。归档只按 spaceId 写 store 即可。
    await deleteSession(targetSpaceId, sessionId)
    const pinned = useChatSplitStore.getState().pinnedSessionsBySpace[targetSpaceId]
    if (pinned?.includes(sessionId)) togglePinSession(targetSpaceId, sessionId)
  }, [deleteSession, getSessionSpaceId, togglePinSession])

  const handleForkSession = useCallback(async (sessionId: string, messageId?: string) => {
    const targetSpaceId = getSessionSpaceId(sessionId)
    if (!targetSpaceId) return
    if (targetSpaceId !== selectedSpaceId) {
      selectSpaceBySpaceId(targetSpaceId)
    }
    await forkSession(targetSpaceId, sessionId, messageId)
  }, [forkSession, getSessionSpaceId, selectSpaceBySpaceId, selectedSpaceId])

  const handleRenameSession = useCallback(async (sessionId: string, title: string) => {
    const targetSpaceId = getSessionSpaceId(sessionId)
    if (!targetSpaceId) return
    if (targetSpaceId !== selectedSpaceId) {
      selectSpaceBySpaceId(targetSpaceId)
    }
    await renameSession(targetSpaceId, sessionId, title)
  }, [getSessionSpaceId, renameSession, selectSpaceBySpaceId, selectedSpaceId])

  const pinnedSessionIds = useChatSplitStore(s =>
    selectedSpaceId ? s.pinnedSessionsBySpace[selectedSpaceId] : undefined,
  )
  const pinnedSessionIdsSet = useMemo(() => new Set(pinnedSessionIds ?? []), [pinnedSessionIds])

  // ── 发送流程 ──

  const resolveSendTabScopeKey = useCallback((sessionId: string, candidate?: string | null): string | null => {
    if (candidate?.startsWith('conversation:')) return `conversation:${sessionId}`
    return candidate ?? null
  }, [])

  const syncContextBeforeSend = useCallback(async (nextTabScopeKey: string | null) => {
    if (effectiveGraphType !== 'chat') return
    // R2-1 / Electron #7：发送前同步真实视觉 Focus，不再保留陈旧 project_task
    // 窗口。执行锚点由 Django 从 Session/TaskRun 恢复后经 _server_focus_authority
    // 注入；客户端不得用假视觉 Focus「保活」锚点。
    await syncContext(
      selectedSpace?.id || null,
      activeContextType,
      activeAppMeta,
      openTabs,
      {
        force: false,
        deferHttpPersist: true,
        tabScopeKey: nextTabScopeKey,
        workspaceScopeKey: nextTabScopeKey,
      },
    )
  }, [effectiveGraphType, selectedSpace?.id, activeContextType, activeAppMeta, openTabs, syncContext])

  const resolveSessionModelId = useCallback((sessionId: string, spaceId: string): string | null => {
    const state = useChatStore.getState()
    const session = state.sessions.find(s => s.id === sessionId)
      ?? state.sessionsBySpaceId[spaceId]?.find(s => s.id === sessionId)
    return session?.current_model_id ?? null
  }, [])

  const ensureSessionIdForSend = useCallback(async (
    expectedDraftMessageId?: string,
  ): Promise<string | null> => {
    // ：读 store 快照，禁止用 React 闭包里的陈旧 currentSessionId 短路到旧对话
    // ：local-pending 只是 UI 占位，不能当已建会话短路
    const liveCurrentSessionId = controlledSessionId ?? useChatStore.getState().currentSessionId
    if (liveCurrentSessionId && !isLocalPendingSessionId(liveCurrentSessionId)) {
      return liveCurrentSessionId
    }
    if (!resolvedOrganizationId || !selectedSpaceId) {
      logger.error('[ChatPanel] 无法创建会话：spaceId 或 organizationId 为空')
      return null
    }

    // ：预建可能仍在 in-flight；先等同一 Space 收口，再指针复用 / ensure 重试。
    await waitForInFlightSessionCreate(selectedSpaceId).catch((error) => {
      logger.warn('[ChatPanel] 会话创建 in-flight 失败，首发将通过 ensure 重试:', error)
    })

    const selectedAgent = useSpaceStore.getState().selectedAgent
    const preferredModelId = useChatModelStore.getState().userDefaultModelId
      || selectedAgent?.preferred_model_id
      || undefined
    const stickyModelId = readRuntimeModelPreference(selectedAgent?.id)
    const catalogHas = (modelId: string) => sendableModelIds.has(modelId)
    const isAvailable = createRuntimeModelAvailabilityChecker(catalogHas)
    // 草稿意图 → 本机 sticky（含 Codex）→ 当前用户默认 → Agent 平台首选
    const requestedModelId = resolveRuntimeDefaultModelId({
      pendingModelId,
      stickyModelId,
      preferredModelId,
      isAvailable,
    })
    if (pendingModelId && !requestedModelId) {
      logger.warn('[ChatPanel] 草稿模型不可发送或已失效，改用 sticky/平台默认:', pendingModelId)
    } else if (!pendingModelId && stickyModelId && requestedModelId !== stickyModelId) {
      logger.warn('[ChatPanel] sticky 模型不可发送或已失效，改用平台首选/默认:', stickyModelId)
    }
    // Django 不认识仅本机的 Codex model id；先按平台模型创建会话，再在 renderer
    // 内存状态切到 Codex，随后的 Agent query 会把该 id 传给 Electron 主进程。
    const effectiveModelId = toProvisionModelId(requestedModelId, {
      preferredModelId,
      isAvailable: catalogHas,
    })

    // 与草稿预建共用唯一建会话入口：复用指针或合并 in-flight，不再另走 createSession
    const provisioned = await ensureSessionForSpace(
      selectedSpaceId,
      resolvedOrganizationId,
      effectiveModelId,
      {
        trigger: 'pre_send',
        preferQuickStart: true,
        ...(expectedDraftMessageId ? { expectedDraftMessageId } : {}),
      },
    )
    const newSessionId = provisioned.sessionId
    if (newSessionId && requestedModelId) {
      const currentModelId = resolveSessionModelId(newSessionId, selectedSpaceId)
      if (currentModelId !== requestedModelId) {
        await switchModel(newSessionId, requestedModelId).catch(() => {})
      }
      setPendingModelId(null)
    } else if (pendingModelId && !requestedModelId) {
      setPendingModelId(null)
    }
    const draftOverrides = peekDraftModelParamOverrides(stableDraftScopeKey) ?? {}
    if (newSessionId) {
      for (const [key, value] of Object.entries(draftOverrides)) {
        await setModelParamOverride(newSessionId, key, value)
      }
    }
    return newSessionId
  // ：不再依赖闭包 currentSessionId；保留 260805 草稿模型参数 deps
  }, [controlledSessionId, resolvedOrganizationId, selectedSpaceId, ensureSessionForSpace, pendingModelId, sendableModelIds, switchModel, setPendingModelId, resolveSessionModelId, setModelParamOverride, stableDraftScopeKey])

  const markOptimisticSendFailed = useCallback((
    clientMessageId: string | undefined,
    /** 本轮捕获的 pending/target session，禁止用等待期间可能已切走的全局 current */
    targetSessionId: string | undefined,
  ) => {
    if (!clientMessageId || !targetSessionId) return
    useChatStore.setState((state) => {
      const msgs = state.messagesBySessionId[targetSessionId] ?? []
      if (!msgs.some((m) => m.id === clientMessageId)) return {}
      return {
        messagesBySessionId: {
          ...state.messagesBySessionId,
          [targetSessionId]: msgs.map((m) => (
            m.id === clientMessageId
              ? { ...m, sendStatus: 'failed' as const }
              : m
          )),
        },
      }
    })
  }, [])

  const handleSendMessage = useCallback(async (
    message: string,
    attachments?: ChatAttachment[],
    contextBlocks?: Array<Record<string, unknown>>,
    options?: ChatInputSendOptions,
  ) => {
    //  草稿首发：先解析/确保真 session，再 bootstrap——主路径不造 local-pending 壳。
    // draftMessage commit 统一在 sendMessageAction 前门禁；此处只负责 bootstrap + bind token。
    // ：draft UI 旗标在 conversation host A；execution B 只承载会话指针 / ensure。
    const draftUiSpaceId = conversationHostSpaceId ?? selectedSpaceId
    const chatSnap = useChatStore.getState()
    // ：发送判定一律读 store 快照，避免闭包仍持旧 currentSessionId
    const liveCurrentSessionId = controlledSessionId ?? chatSnap.currentSessionId
    const spaceSessionPointer = selectedSpaceId
      ? (chatSnap.currentSessionIdBySpaceId[selectedSpaceId] ?? null)
      : null
    const inDraft = Boolean(
      (draftUiSpaceId && chatSnap.draftSessionBySpaceId[draftUiSpaceId])
      || (selectedSpaceId && chatSnap.draftSessionBySpaceId[selectedSpaceId]),
    )
    const needsDraftFirstSend = Boolean(
      selectedSpaceId
      && (
        isLocalPendingSessionId(liveCurrentSessionId)
        || inDraft
        || (!liveCurrentSessionId && !spaceSessionPointer)
      ),
    )
    const submittedDraftKey = resolveDraftKey(
      needsDraftFirstSend ? null : liveCurrentSessionId,
      selectedSpaceId,
    )
    const sendTimingTrace = beginSendTimingTrace({
      isNewSession: !liveCurrentSessionId || isLocalPendingSessionId(liveCurrentSessionId),
    })
    trackSendTimingTelemetry('message.send.click', {
      hasAttachments: Boolean(attachments && attachments.length > 0),
      hasContextBlocks: Boolean(contextBlocks && contextBlocks.length > 0),
    }, sendTimingTrace, {
      counterKey: 'message.send.click',
      sessionId: liveCurrentSessionId,
    })

    let existingClientMessageId: string | undefined
    let capturedPendingSessionId: string | undefined
    let capturedDraftMessageId: string | undefined
    let capturedDraftScopeKey: string | undefined

    try {
      if (needsDraftFirstSend && selectedSpaceId) {
        // 主链稳定 A 优先；tabScopeKey 可能是 conversation:S，不得据此 fallback 到 execution B
        const draftScopeKey = resolveConversationDraftScopeKey({
          stableDraftScopeKey: stableDraftScopeKey,
          tabScopeKey: options?.tabScopeKey ?? tabScopeKey,
          legacyExecutionHostId: stableDraftScopeKey ? null : selectedSpaceId,
        })
        if (!draftScopeKey) {
          logger.error('[ChatPanel] 无法解析 draftScopeKey，放弃首发')
          return
        }
        capturedDraftScopeKey = draftScopeKey
        let draftMessage = getDraftMessageByScopeKey(draftScopeKey)
        if (!draftMessage) {
          draftMessage = beginDraftMessageSession(
            draftScopeKey,
            buildDraftMessageMetadataFromLegacy({
              organizationId: resolvedOrganizationId,
              agentId: useSpaceStore.getState().selectedAgent?.id,
              // executionWorkspaceId / projectId 仅调用方确知真实资源时再传；
              // 不得把 selectedSpaceId（可能是 Project host）冒充 execution 工作空间
            }),
          )
        }
        capturedDraftMessageId = draftMessage.draftMessageId

        // ：等预建 in-flight → 指针/单槽；仍无则 ensure 出真 id，再挂乐观气泡
        let existingSessionId = await resolveExistingSessionIdForDraftFirstSend({
          spaceId: selectedSpaceId,
          getState: () => useChatStore.getState(),
        })
        let alignedViaEnsure = false
        if (!existingSessionId) {
          try {
            existingSessionId = await ensureSessionIdForSend(capturedDraftMessageId)
            alignedViaEnsure = Boolean(existingSessionId)
          } catch (error) {
            logger.error('[ChatPanel] 首发 ensure 失败', { error, draftMessageId: capturedDraftMessageId })
            toast({
              title: t('errors.sessionCreateFailed', {
                defaultValue: '创建会话失败，请重试发送',
              }),
              variant: 'destructive',
            })
            return
          }
        }
        if (!existingSessionId) {
          toast({
            title: t('errors.sessionCreateFailed', {
              defaultValue: '创建会话失败，请重试发送',
            }),
            variant: 'destructive',
          })
          return
        }

        // 复用预建会话时 ensure 被跳过：草稿底栏可能已按 sticky 显示 Codex，
        // 但 session.current_model_id 仍是平台模型 → 首发前必须对齐，否则会发错模。
        // 与 prefetch finally 一致：优先 DraftMessage intent，再 React pending，再 sticky。
        if (!alignedViaEnsure) {
          const selectedAgent = useSpaceStore.getState().selectedAgent
          const draftIntent = peekDraftModelIntent(draftScopeKey) ?? pendingModelId
          const alignTarget = resolveLocalRuntimeAlignTarget({
            pendingModelId: draftIntent,
            stickyModelId: readRuntimeModelPreference(selectedAgent?.id),
            catalogHas: (modelId) => sendableModelIds.has(modelId),
          })
          if (alignTarget) {
            const currentModelId = resolveSessionModelId(existingSessionId, selectedSpaceId)
            if (currentModelId !== alignTarget) {
              try {
                await switchModel(existingSessionId, alignTarget)
              } catch (error) {
                logger.warn('[ChatPanel] 草稿首发复用预建会话时对齐 sticky 失败:', error)
                // Codex 对齐失败仍发送会再现「底栏 Sol、实际走平台模型」；中止让用户重选/登录
                if (isOpenAICodexModel(alignTarget)) {
                  toast({
                    title: t('errors.runtimeModelAlignFailed', {
                      defaultValue: '无法切换到本机 Codex 模型，请确认已登录 ChatGPT 后重试',
                    }),
                    variant: 'destructive',
                  })
                  return
                }
              }
            }
          }
        }

        // ensure / 等预建期间用户可能已切历史；commit 前 fail-closed，勿污染指针
        if (capturedDraftMessageId && !isDraftMessageActive(capturedDraftMessageId)) {
          logger.warn('[ChatPanel] 首发 commit 前 draftMessage 已失效，放弃 bootstrap', {
            draftMessageId: capturedDraftMessageId,
            sessionId: existingSessionId,
          })
          toast({
            title: t('errors.draftMessageCancelled', {
              defaultValue: '草稿会话已切换或取消，请重试发送',
            }),
            variant: 'destructive',
          })
          return
        }

        const latestSnap = useChatStore.getState()
        const ownedPending = findBoundLocalPendingForDraftMessage(capturedDraftMessageId)
        const foreignGlobalPending = isLocalPendingSessionId(latestSnap.currentSessionId)
          && getDraftSessionBySessionId(latestSnap.currentSessionId)?.draftScopeKey !== draftScopeKey
        const visibleMessage = options?.displayMessage || message
        // ：先 allocate（纯分配）→ ownership bind → 成功后再 commit UI。
        // ：foreign 仍停在 open 的预建空壳允许 reclaim，避免双草稿抢指针粘死。
        const allocation = allocatePendingFirstSendTarget(latestSnap, {
          spaceId: selectedSpaceId,
          message: visibleMessage,
          contextBlocks,
          attachments,
          replyTo: options?.replyTo,
          sendTimingTrace,
          existingSessionId,
          ownedPendingSessionId: ownedPending ?? undefined,
          preserveForeignGlobalCurrent: foreignGlobalPending,
        })
        const canReclaim = isReclaimableDraftPrefetchShell(
          allocation.pendingSessionId,
          latestSnap,
        )
        const bound = bindDraftSessionToMessage(draftScopeKey, allocation.pendingSessionId, {
          draftMessageId: capturedDraftMessageId,
          phase: 'sending',
          reclaimFromOpenDraftMessage: canReclaim,
        })
        if (!bound) {
          logger.error('[ChatPanel] bindDraftSessionToMessage 冲突，fail-closed（零 UI 副作用）', {
            draftScopeKey,
            pendingSessionId: allocation.pendingSessionId,
            draftMessageId: capturedDraftMessageId,
            canReclaim,
          })
          toast({
            title: t('errors.draftMessageBindConflict', {
              defaultValue: '草稿会话冲突，请重试发送',
            }),
            variant: 'destructive',
          })
          return
        }
        // 首发会把 shell 从草稿 scope 切到正式会话。布局偏好必须先迁，
        // 否则 React 可能在 chat store 指针更新后先渲染一次正式 scope，
        // 其默认折叠态会把 app-focus 瞬间覆盖成 chat-focus。
        {
          const sourceTabScopeKey =
            capturedDraftScopeKey ?? options?.tabScopeKey ?? tabScopeKey
          const nextTabScopeKey = resolveSendTabScopeKey(
            allocation.pendingSessionId,
            sourceTabScopeKey,
          )
          if (
            sourceTabScopeKey?.startsWith('conversation:draft:')
            && nextTabScopeKey?.startsWith('conversation:')
          ) {
            rehomeConversationScopeLayout(sourceTabScopeKey, nextTabScopeKey)
          }
        }
        useChatStore.setState((state) =>
          commitPendingFirstSendState(state, {
            spaceId: selectedSpaceId,
            draftSpaceId: draftUiSpaceId,
            allocation,
            preserveForeignGlobalCurrent: foreignGlobalPending,
          }),
        )
        // ：commit 后立刻登记，覆盖「进 sendMessageAction 前 fail-closed」窗口
        rememberLocallySubmittedSession(allocation.pendingSessionId)
        existingClientMessageId = allocation.clientMessageId
        capturedPendingSessionId = allocation.pendingSessionId
        if (allocation.kind === 'new_target') {
          trackPendingFirstSendUserVisible(
            allocation.pendingSessionId,
            allocation.clientMessageId,
            sendTimingTrace,
            {
              hasAttachments: Boolean(attachments && attachments.length > 0),
              hasContextBlocks: Boolean(contextBlocks && contextBlocks.length > 0),
            },
          )
        }
      }

      let sessionIdToUse: string | null = capturedPendingSessionId ?? null
      try {
        if (!sessionIdToUse) {
          sessionIdToUse = await ensureSessionIdForSend(capturedDraftMessageId)
        }
      } catch (error) {
        logger.error('[ChatPanel] ensureSessionForSpace 拒绝/异常，保留 pending 供重试', {
          error,
          draftMessageId: capturedDraftMessageId,
          pendingSessionId: capturedPendingSessionId,
        })
        markOptimisticSendFailed(existingClientMessageId, capturedPendingSessionId)
        toast({
          title: t('errors.sessionCreateFailed', {
            defaultValue: '创建会话失败，请重试发送',
          }),
          variant: 'destructive',
        })
        return
      }
      if (!sessionIdToUse) {
        markOptimisticSendFailed(
          existingClientMessageId,
          capturedPendingSessionId,
        )
        toast({
          title: t('errors.sessionCreateFailed', {
            defaultValue: '创建会话失败，请重试发送',
          }),
          variant: 'destructive',
        })
        return
      }

      // ：ensure 回包后若 draftMessage 已 cancel/切历史 → fail-closed，不得继续 send
      if (capturedDraftMessageId && !isDraftMessageActive(capturedDraftMessageId)) {
        logger.warn('[ChatPanel] ensure 回包时 draftMessage 已失效，放弃发送', {
          draftMessageId: capturedDraftMessageId,
          sessionId: sessionIdToUse,
          pendingSessionId: capturedPendingSessionId,
        })
        markOptimisticSendFailed(
          existingClientMessageId,
          capturedPendingSessionId ?? sessionIdToUse,
        )
        toast({
          title: t('errors.draftMessageCancelled', {
            defaultValue: '草稿会话已切换或取消，请重试发送',
          }),
          variant: 'destructive',
        })
        return
      }

      // ensure 可能 rehome 到真 session；绑定已在 lifecycle 迁移
      if (
        capturedDraftScopeKey
        && capturedDraftMessageId
        && isDraftMessageActive(capturedDraftMessageId)
      ) {
        const rebound = bindDraftSessionToMessage(capturedDraftScopeKey, sessionIdToUse, {
          draftMessageId: capturedDraftMessageId,
          phase: 'sending',
          reclaimFromOpenDraftMessage: isReclaimableDraftPrefetchShell(
            sessionIdToUse,
            useChatStore.getState(),
          ),
        })
        if (!rebound) {
          logger.error('[ChatPanel] ensure 后 bind 冲突，fail-closed', {
            draftScopeKey: capturedDraftScopeKey,
            sessionId: sessionIdToUse,
            draftMessageId: capturedDraftMessageId,
          })
          markOptimisticSendFailed(
            existingClientMessageId,
            capturedPendingSessionId ?? sessionIdToUse,
          )
          toast({
            title: t('errors.draftMessageBindConflict', {
              defaultValue: '草稿会话冲突，请重试发送',
            }),
            variant: 'destructive',
          })
          return
        }
      }

      trackSendTimingTelemetry('message.send.session_ready', {
        sessionId: sessionIdToUse,
      }, sendTimingTrace, {
        counterKey: 'message.send.session_ready',
        sessionId: sessionIdToUse,
      })

      const sourceTabScopeKey =
        capturedDraftScopeKey ?? options?.tabScopeKey ?? tabScopeKey
      const nextTabScopeKey = resolveSendTabScopeKey(sessionIdToUse, sourceTabScopeKey)
      if (
        sourceTabScopeKey?.startsWith('conversation:draft:') &&
        nextTabScopeKey?.startsWith('conversation:')
      ) {
        const tabsStore = useSpaceContextTabsStore.getState()
        rehomeConversationScopeRuntime(sourceTabScopeKey, nextTabScopeKey)
        // ：merge+clear 原子迁移；禁止 ensure(可 skip)+clear(总执行) 丢掉草稿标签
        tabsStore.rehomeScopeTabs(sourceTabScopeKey, nextTabScopeKey)
        // provision 路径已同步 rehome；此处再兜一层（含 overlay）
        rehomeConversationScopeLayout(sourceTabScopeKey, nextTabScopeKey)
        useSpaceViewPrefsStore.getState().clearTaskViewModeForScope(sourceTabScopeKey)
      }
      await syncContextBeforeSend(nextTabScopeKey)
      trackSendTimingTelemetry('message.send.context_ready', {
        sessionId: sessionIdToUse,
      }, sendTimingTrace, {
        counterKey: 'message.send.context_ready',
        sessionId: sessionIdToUse,
      })

      const editResendClientMessageId = takeFailedMessageEditResend(sessionIdToUse)
      const clientMessageIdToReuse = existingClientMessageId ?? editResendClientMessageId

      useChatStore.getState().registerComposerDraftKeyForSend(
        sessionIdToUse,
        submittedDraftKey,
      )
      await sendMessage(message, true, attachments, contextBlocks, sessionIdToUse, {
        ...options,
        spaceId: selectedSpaceId,
        tabScopeKey: nextTabScopeKey,
        sendTimingTrace,
        ...(clientMessageIdToReuse
          ? { existingClientMessageId: clientMessageIdToReuse }
          : {}),
        ...(capturedDraftMessageId
          ? { expectedDraftMessageId: capturedDraftMessageId }
          : {}),
      })
    } finally {
      clearSendTimingTrace(sendTimingTrace.traceId)
    }
  }, [
    conversationHostSpaceId,
    controlledSessionId,
    ensureSessionIdForSend,
    markOptimisticSendFailed,
    pendingModelId,
    resolveSendTabScopeKey,
    resolveSessionModelId,
    resolvedOrganizationId,
    sendableModelIds,
    stableDraftScopeKey,
    switchModel,
    syncContextBeforeSend,
    sendMessage,
    selectedSpaceId,
    tabScopeKey,
    t,
  ])

  // ：local-pending 首发失败的气泡「重试」经此注册路由回完整首发编排
  // （重新 ensure 建会话 → 迁 pending → 发送），不得直接 store.sendMessage。
  const panelDraftScopeKey = resolvePanelDraftScopeKey()
  useEffect(() => {
    if (!panelDraftScopeKey) return
    return registerPendingFirstSendRetryHandler(panelDraftScopeKey, (input) => {
      void handleSendMessage(input.message, undefined, input.contextBlocks)
    })
  }, [panelDraftScopeKey, handleSendMessage])

  /** 单一 Stop：尚无实质输出则撤回回填，已有输出则只停答。 */
  const handleStop = useCallback(() => {
    if (!currentSessionId) return
    void abortStreamFromComposer(currentSessionId)
  }, [currentSessionId, abortStreamFromComposer])

  // ── 模型 & Group Runtime ──

  /**
   * 模型 / 档位切换。tierId 仅在用户点击档位芯片时传入：
   *   - tierId 提供 + 同模型 → 仅切档（switchContextTier）
   *   - tierId 提供 + 跨模型 → switchModel(modelId, tierId) 同时切两者
   *   - tierId 未提供 → 仅切模型
   */
  const handleModelChange = useCallback(async (modelId: string, tierId?: string, controlChange?: { key: string; value: ModelParamValue }) => {
    if (!isSendableChatModelId(modelId)) {
      toast({
        title: t(isCommunityDistribution
          ? 'errors.communityModelNotConfigured'
          : 'errors.modelNotConfigured', {
          defaultValue: isCommunityDistribution
            ? 'AI NOT CONFIGURED · 请前往「设置 → 模型配置 → BYOK」'
            : '请先在管理后台配置模型 API Key 并开启路由',
        }),
        variant: 'destructive',
      })
      return
    }

    const activeModelId = currentSessionId
      ? useChatStore.getState().sessions
          .find(session => session.id === currentSessionId)?.current_model_id
      : pendingModelId
    const currentModel = (
      sendableModels.find(model => model.id === activeModelId)
      ?? useChatModelStore.getState().getCurrentModel()
    )
    const targetModel = sendableModels.find(model => model.id === modelId)
    const confirmed = await confirmPromotionCreditModelSwitch({
      currentModel,
      targetModel,
      t,
      confirm: notify.confirm,
    })
    if (!confirmed) return

    // ：会话模型切换与 Agent 首选解耦——本机 Codex 只改会话 current_model_id，
    // 不写 preferred_model_id（Django 不认该 id，写入会污染「Agent 配置」自述）。
    // 本机 sticky 两者都记，供新对话默认（Codex 也能跟上）。
    const { selectedAgent, setPreferredModel } = useSpaceStore.getState()
    if (selectedAgent?.id) {
      writeRuntimeModelPreference(selectedAgent.id, modelId)
      if (controlChange) {
        writeRuntimeModelParamPreference(
          selectedAgent.id,
          modelId,
          controlChange.key,
          controlChange.value,
        )
      }
      if (!isOpenAICodexModel(modelId)) {
        setPreferredModel(selectedAgent.id, modelId)
      }
    }

    if (!currentSessionId) {
      setPendingModelId(modelId)
      // ：草稿 UI 选中的模型 / 档位必须同步到预建 hidden session，
      // 不能只停在 pendingModelId（进入正式会话后 UI 读 session.current_model_id）。
      if (stableDraftScopeKey) {
        const chatState = useChatStore.getState()
        const syncCtx = buildDraftMessageSessionContext({
          draftScopeKey: stableDraftScopeKey,
          legacyExecutionHostId: selectedSpaceId,
          pointers: {
            draftSessionBySpaceId: chatState.draftSessionBySpaceId,
            currentSessionIdBySpaceId: chatState.currentSessionIdBySpaceId,
          },
        })
        const targetSessionId = syncDraftModelIntent(modelId, syncCtx, {
          contextTierId: tierId,
          controlChange,
        })
        if (targetSessionId) {
          let syncFailed = false
          const syncPromise = (async () => {
            if (tierId) {
              await switchModel(targetSessionId, modelId, tierId)
            } else {
              await switchModel(targetSessionId, modelId)
            }
            if (controlChange) {
              await setModelParamOverride(
                targetSessionId,
                controlChange.key,
                controlChange.value,
              )
            }
          })()
          await syncPromise.catch((error) => {
            syncFailed = true
            logger.error('[ChatPanel] 草稿预建 session 同步模型/档位失败:', error)
            toast({
              title: error instanceof Error
                ? error.message
                : t('panel.modelSwitchFailed', { defaultValue: '切换模型失败' }),
              variant: 'destructive',
            })
          })
          if (!syncFailed) {
            // 全量回写 pending：避免只写 service_tier 时丢掉 fast_by_model，导致 Fast 串模型。
            const synced = useChatStore.getState().getSessionById(targetSessionId)
            if (synced && replacePendingModelParamOverrides) {
              replacePendingModelParamOverrides(synced.model_param_overrides ?? null)
            } else if (controlChange) {
              setPendingModelParamOverride(controlChange.key, controlChange.value)
            }
          }
        } else if (controlChange) {
          setPendingModelParamOverride(controlChange.key, controlChange.value)
        }
      }
      return
    }

    const currentModelId = useChatStore.getState().sessions
      .find(s => s.id === currentSessionId)?.current_model_id

    try {
      if (controlChange && currentModelId === modelId) {
        await setModelParamOverride(currentSessionId, controlChange.key, controlChange.value)
        logger.debug('[ChatPanel] 模型参数已切换:', controlChange)
        return
      }
      if (tierId && currentModelId === modelId) {
        await switchContextTier(currentSessionId, tierId)
        logger.debug('[ChatPanel] 上下文档位已切换到:', tierId)
      } else if (tierId) {
        await switchModel(currentSessionId, modelId, tierId)
        logger.debug('[ChatPanel] 模型+档位已切换:', modelId, tierId)
      } else if (currentModelId !== modelId) {
        await switchModel(currentSessionId, modelId)
        logger.debug('[ChatPanel] 模型已切换到:', sendableModels.find(m => m.id === modelId)?.display_name || modelId)
      }
      // 切模型（或仅改参）后写入 controlChange——Codex Fast 等需随模型一并生效。
      if (controlChange) {
        await setModelParamOverride(currentSessionId, controlChange.key, controlChange.value)
        logger.debug('[ChatPanel] 模型参数已切换:', controlChange)
      }
    } catch (error) {
      logger.error('[ChatPanel] 切换模型/档位失败:', error)
      toast({
        title: error instanceof Error
          ? error.message
          : t('panel.modelSwitchFailed', { defaultValue: '切换模型失败' }),
        variant: 'destructive',
      })
    }
  }, [
    currentSessionId,
    pendingModelId,
    switchModel,
    switchContextTier,
    setModelParamOverride,
    sendableModels,
    t,
    setPendingModelId,
    setPendingModelParamOverride,
    replacePendingModelParamOverrides,
    stableDraftScopeKey,
    selectedSpaceId,
  ])

  return {
    handleTabClick,
    handleNewSession,
    handleDeleteSession,
    handleRenameSession,
    handleForkSession,
    pinnedSessionIdsSet,
    handleSendMessage,
    handleStop,
    handleModelChange,
  }
}
