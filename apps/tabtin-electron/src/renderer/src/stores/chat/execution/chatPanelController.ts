/**
 * Chat 面板生命周期副作用控制器（从 useChatPanelLifecycle 下沉）。
 *
 * 把「会话列表加载、pending 汇报检查、上下文同步防抖、restoring 看门狗、
 * proactive report 监听」等业务/编排/去重/定时逻辑从 React hook 移到 store 子树。
 * hook 只保留派生 memo 与「何时触发」的 useEffect 生命周期绑定，调用本控制器方法。
 *
 * 去重锁、防抖定时器等瞬态归属控制器实例（hook mount 期唯一），dispose 时清理。
 * proactive report 监听 / restoring 看门狗是自带 cleanup 的独立函数，由 hook 的
 * effect 直接挂载（返回 detach）。
 */

import { logger } from '@/utils/logger'
import { useChatStore } from '@/stores/chat/useChatStore'
import { useChatModelStore } from '@/stores/useChatModelStore'
import { useSpaceStore } from '@/stores/useSpaceStore'
import { usePendingReportStore } from '@/stores/usePendingReportStore'
import { getLocalAgentClient, isLocalRuntimeAvailable } from '@/services/localAgentClient'
import { abortActiveRollback } from '@/stores/chat/checkpoint/slices/checkpointSlice'
import { filterSendableChatModels } from '@/utils/chatModelGuards'
import { peekDraftModelIntent } from '@/stores/chat/session/draftMessage'
import {
  createRuntimeModelAvailabilityChecker,
  readRuntimeModelPreference,
  readRuntimeModelParamPreference,
  resolveLocalRuntimeAlignTarget,
  resolveRuntimeDefaultModelId,
  toProvisionModelId,
} from '@/stores/chat/session/runtimeModelPreference'
import { readCachedOrganizationDeviceModelPreferences } from '@/stores/chat/session/organizationDeviceModelPreference'

const RESTORING_WATCHDOG_MS = 65_000

export interface ContextSyncSnapshot {
  isForeground: boolean
  currentSessionId: string | null
  spaceId: string | null
  activeContextType: string | null
  activeAppMeta: Record<string, unknown> | null
  openTabs: Array<{ type: string; id: string; title?: string; active?: boolean; group_id?: string; path?: string; kind?: string; url?: string; session_id?: string }> | null
  tabScopeKey?: string | null
  /** 由 useChatPanelLifecycle 注入的上下文同步 store action。 */
  syncContext: (
    spaceId?: string | null,
    contextType?: string | null,
    appMeta?: Record<string, unknown> | null,
    openTabs?: ContextSyncSnapshot['openTabs'],
    options?: { force?: boolean; tabScopeKey?: string | null; workspaceScopeKey?: string | null },
  ) => Promise<void>
}

export interface PrefetchDraftParams {
  /** execution Space：sessions / ensure 桶 */
  spaceId: string
  /** 草稿 UI 旗标所在 host；缺省等同 spaceId */
  draftUiSpaceId?: string | null
  organizationId: string
  tabScopeKey?: string | null
}

export interface ChatPanelController {
  /** 会话列表加载：委托 loadSessions SWR。 */
  ensureSpaceSessionsLoaded: (
    spaceId: string,
    organizationId: string,
    loadSessions: (spaceId: string, organizationId: string) => Promise<void>,
  ) => void
  /** @deprecated no-op；保留给生命周期 cleanup 兼容调用 */
  resetSessionLoadLock: () => void
  /** 草稿欢迎态后台预热（：只 warm 不建会话；真 session 由首发落地）。 */
  prefetchDraftIfNeeded: (params: PrefetchDraftParams) => void
  /** 进入 Space 时检查后台 pending 汇报（per space 去重）。 */
  checkPendingReports: (spaceId: string, currentSessionId: string | null) => void
  resetCheckPendingLock: () => void
  /** 上下文同步（显式防抖）。 */
  requestContextSync: (snapshot: ContextSyncSnapshot, delayMs?: number) => void
  clearContextSyncTimer: () => void
  dispose: () => void
}

export function createChatPanelController(): ChatPanelController {
  let prefetchLock: string | null = null
  let checkPendingLock: string | null = null
  let contextSyncTimer: ReturnType<typeof setTimeout> | null = null

  return {
    ensureSpaceSessionsLoaded(spaceId, organizationId, loadSessions) {
      // ：与侧栏共用 loadSessions SWR（缓存命中立即渲染 + 后台 revalidate）。
      //  已把 effect 依赖从 currentSessionId 拆开，不再需要 per-space 锁挡重入；
      // in-flight 去重由 sessionCrudSlice 承担。
      logger.debug('[ChatPanel] 初始化:', { spaceId })
      void loadSessions(spaceId, organizationId).catch(error => {
        logger.error('[ChatPanel] 初始化失败:', error)
      })
    },

    resetSessionLoadLock() {
      // 保留 API：生命周期 cleanup 仍会调用；SWR 路径下无需清锁。
    },

    prefetchDraftIfNeeded(params) {
      const { spaceId } = params
      if (prefetchLock === spaceId) return
      prefetchLock = spaceId

      const draftScopeKey = params.tabScopeKey ?? `conversation:draft:${spaceId}`
      const sendable = filterSendableChatModels(useChatModelStore.getState().availableModels)
      const sendableIds = new Set(sendable.map(model => model.id))
      const catalogHas = (modelId: string) => sendableIds.has(modelId)
      const isAvailable = createRuntimeModelAvailabilityChecker(catalogHas)
      const selectedAgent = useSpaceStore.getState().selectedAgent
      const agentId = selectedAgent?.id
      const userDefaultModelId = useChatModelStore.getState().userDefaultModelId
      const preferredModelId = userDefaultModelId || selectedAgent?.preferred_model_id
      const configuredDeviceModelId = readCachedOrganizationDeviceModelPreferences(
        params.organizationId,
      ).mainModelId
      const deviceModelId = configuredDeviceModelId && catalogHas(configuredDeviceModelId)
        ? configuredDeviceModelId
        : undefined
      // ：草稿 UI 已选 → 当前设备默认 → Agent sticky → 当前用户默认 → Agent 平台首选
      const runtimeModelId = resolveRuntimeDefaultModelId({
        pendingModelId: peekDraftModelIntent(draftScopeKey),
        stickyModelId: deviceModelId ?? readRuntimeModelPreference(agentId),
        preferredModelId,
        isAvailable,
      })
      const provisionModelId = toProvisionModelId(runtimeModelId, {
        preferredModelId,
        isAvailable: catalogHas,
      })

      void useChatStore.getState().prefetchSessionForDraft({
        spaceId,
        draftUiSpaceId: params.draftUiSpaceId ?? spaceId,
        organizationId: params.organizationId,
        modelId: provisionModelId,
        tabScopeKey: draftScopeKey,
      }).finally(() => {
        if (prefetchLock === spaceId) prefetchLock = null
        // 预建开始时 catalog 可能还没 merge Codex；对齐前/后都重读 intent，避免迟到 switch 盖住用户刚选的平台模型
        void (async () => {
          const resolveAlignTarget = () => {
            const latestSendable = filterSendableChatModels(
              useChatModelStore.getState().availableModels,
            )
            const latestCatalogHas = (modelId: string) =>
              latestSendable.some(model => model.id === modelId)
            const latestAgentId = useSpaceStore.getState().selectedAgent?.id ?? agentId
            const latestConfiguredDeviceModelId = readCachedOrganizationDeviceModelPreferences(
              params.organizationId,
            ).mainModelId
            const latestDeviceModelId = latestConfiguredDeviceModelId
              && latestCatalogHas(latestConfiguredDeviceModelId)
              ? latestConfiguredDeviceModelId
              : undefined
            return resolveLocalRuntimeAlignTarget({
              pendingModelId: peekDraftModelIntent(draftScopeKey),
              stickyModelId: latestDeviceModelId ?? readRuntimeModelPreference(latestAgentId),
              catalogHas: latestCatalogHas,
            })
          }

          const sessionId = useChatStore.getState().currentSessionIdBySpaceId[spaceId]
          if (!sessionId) return
          const alignTarget = resolveAlignTarget()
          if (!alignTarget) return
          try {
            const beforeSwitch = resolveAlignTarget()
            if (!beforeSwitch || beforeSwitch !== alignTarget) return
            const sessionBefore = useChatStore.getState().getSessionById(sessionId)
            if (sessionBefore?.current_model_id !== beforeSwitch) {
              await useChatModelStore.getState().switchModel(sessionId, beforeSwitch)
            }
            // switch 等待期间用户可能又改了草稿意图 / sticky
            const afterSwitch = resolveAlignTarget()
            if (!afterSwitch) return
            const sessionAfter = useChatStore.getState().getSessionById(sessionId)
            if (sessionAfter?.current_model_id !== afterSwitch) {
              await useChatModelStore.getState().switchModel(sessionId, afterSwitch)
            }

            const finalTarget = resolveAlignTarget()
            const finalAgentId = useSpaceStore.getState().selectedAgent?.id ?? agentId
            if (!finalTarget || !finalAgentId) return
            const finalSession = useChatStore.getState().getSessionById(sessionId)
            if (finalSession?.current_model_id !== finalTarget) return
            const rememberedParams = readRuntimeModelParamPreference(finalAgentId, finalTarget)
            for (const [key, value] of Object.entries(rememberedParams ?? {})) {
              await useChatModelStore.getState().setModelParamOverride(sessionId, key, value)
            }
          } catch (error) {
            logger.warn('[ChatPanel] 草稿预建对齐 sticky 运行时模型/参数失败:', error)
          }
        })()
      })
    },

    checkPendingReports(spaceId, currentSessionId) {
      if (!isLocalRuntimeAvailable()) return
      if (checkPendingLock === spaceId) return

      const state = useChatStore.getState()
      const loadedSessions = state.sessionsBySpaceId[spaceId] ?? []
      if (loadedSessions.length === 0) return

      const loadedCurrentId = currentSessionId ?? loadedSessions[0]?.id
      if (!loadedCurrentId) return

      checkPendingLock = spaceId
      const threadId = `chat-session-${loadedCurrentId}`

      getLocalAgentClient().checkPending(threadId)
        .then((result) => {
          if (result.pending_count > 0) {
            usePendingReportStore.getState().setPendingCount(spaceId, result.pending_count)
            logger.debug(`[ChatPanel] checkPending: ${result.pending_count} pending reports for space=${spaceId}`)
          }
        })
        .catch((err) => {
          logger.warn('[ChatPanel] checkPending failed:', err)
        })
    },

    resetCheckPendingLock() {
      checkPendingLock = null
    },

    requestContextSync(snapshot, delayMs = 220) {
      if (!snapshot.isForeground) return
      if (contextSyncTimer) clearTimeout(contextSyncTimer)
      contextSyncTimer = setTimeout(() => {
        if (!snapshot.currentSessionId) return
        // 用户焦点在 Chat Panel 时 activeContextType 为 null —— 兜底 'chat'，让
        // context-injector 至少能告诉 Agent「现在用户在跟我对话，不在任何 App tab 上」，
        // 而不是退化成只剩 datetime + space_id 的空 context block。
        const focusType = snapshot.activeContextType || 'chat'
        snapshot.syncContext(snapshot.spaceId, focusType, snapshot.activeAppMeta, snapshot.openTabs, {
          tabScopeKey: snapshot.tabScopeKey,
          workspaceScopeKey: snapshot.tabScopeKey,
        }).catch(error => {
          logger.error('[ChatPanel] 同步上下文失败:', error)
        })
      }, delayMs)
    },

    clearContextSyncTimer() {
      if (contextSyncTimer) {
        clearTimeout(contextSyncTimer)
        contextSyncTimer = null
      }
    },

    dispose() {
      if (contextSyncTimer) {
        clearTimeout(contextSyncTimer)
        contextSyncTimer = null
      }
      prefetchLock = null
      checkPendingLock = null
    },
  }
}

/**
 * 监听冷启动 proactive report 完成事件，注入系统消息并清 pending 计数。
 * 返回 detach；本地 Runtime 不可用时为 no-op。
 */
export function attachProactiveReportListener(selectedSpaceId: string | null): () => void {
  if (!isLocalRuntimeAvailable()) return () => {}

  return getLocalAgentClient().onProactiveReport((data) => {
    const { threadId, content } = data
    const targetSessionId = threadId.startsWith('chat-session-')
      ? threadId.slice('chat-session-'.length)
      : threadId

    useChatStore.getState().injectSystemMessage(targetSessionId, {
      id: crypto.randomUUID(),
      role: 'assistant' as const,
      content,
      created_at: new Date().toISOString(),
      metadata: { proactive_report: true },
    })

    if (selectedSpaceId) {
      usePendingReportStore.getState().clearPendingCount(selectedSpaceId)
    }

    logger.debug(`[ChatPanel] proactive report injected for thread=${threadId.slice(0, 12)}…`)
  })
}

/**
 * restoring 超时保护：restoringSessionId 卡死 65s 后中止 rollback、标记 interrupted。
 * 返回 clear 定时器函数。
 */
export function startRestoringWatchdog(restoringSessionId: string): () => void {
  const timer = setTimeout(() => {
    const current = useChatStore.getState()
    if (current.restoringSessionId === restoringSessionId) {
      logger.error(`[ChatPanel] restoringSessionId stuck for 65s, aborting and marking interrupted: ${restoringSessionId}`)
      abortActiveRollback()
      useChatStore.setState(state => ({
        restoringSessionId: null,
        restoringPhase: null,
        restoreInterruptedBySessionId: {
          ...state.restoreInterruptedBySessionId,
          [restoringSessionId]: true,
        },
      }))
    }
  }, RESTORING_WATCHDOG_MS)

  return () => clearTimeout(timer)
}
