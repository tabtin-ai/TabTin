/**
 * useChatPanelLifecycle — ChatPanel 生命周期绑定 + 派生视图计算
 *
 * 副作用业务（会话加载 / 指针对齐 / pending 检查 / 上下文同步 /
 * restoring 看门狗 / proactive report 监听）已下沉到 store 子树：
 *   - `stores/chat/session/reconcileSpacePointer.ts`（指针对齐 / 规范缓存同步）
 *   - `stores/chat/execution/chatPanelController.ts`（其余编排 + 去重锁 + 定时器 + 监听）
 *
 * 本 hook 只保留：
 *   - React 无法下沉的「何时触发」useEffect 生命周期绑定（薄触发器）；
 *   - 跨 store 的派生 memo（currentModel / currentContextTier / tokenUsage /
 *     canSend / disabledReason）与本地 UI state（pendingModelId）。
 */

import { useEffect, useLayoutEffect, useRef, useState, useCallback, useMemo } from 'react'
import { logger } from '@/utils/logger'
import { useBillingStore } from '@/stores/useBillingStore'
import { syncBillingBlockedFromWallet } from '@/lib/billingGuardSync'
import { useChatStore } from '@/stores/chat/useChatStore'
import { useChatRuntimeStore } from '@/stores/useChatRuntimeStore'
import { useChatModelStore } from '@/stores/useChatModelStore'
import { useSpaceStore } from '@/stores/useSpaceStore'
import { resolveAgentModeName } from '@/stores/chat/shared/types'
import { extractChatSessionTokenUsage } from '@/utils/chatSessionTokenUsage'
import { getCurrentContextTokens, getCurrentUsageSource } from '@/utils/chatMessageContextUsage'
import {
  filterSendableChatModels,
  findSendableChatModel,
  isSendableChatModelId,
  pickDefaultSendableChatModel,
} from '@/utils/chatModelGuards'
import {
  readRuntimeModelParamPreference,
  readRuntimeModelPreference,
} from '@/stores/chat/session/runtimeModelPreference'
import { useRemoteExecutionGate } from './useRemoteExecutionGate'
import { reconcileSpacePointer, syncSpaceCanonicalPointers } from '@/stores/chat/session/reconcileSpacePointer'
import {
  createChatPanelController,
  attachProactiveReportListener,
  startRestoringWatchdog,
  type ChatPanelController,
} from '@/stores/chat/execution/chatPanelController'
import { useDraftMessagePageLifecycle } from './useDraftMessagePageLifecycle'
import { isCommunityDistribution, noChatModelDisabledReason } from '@/config/distribution'
import type {
  ChatSession,
  ModelParamOverrides,
  ModelParamValue,
} from '@tabtin/chat-client'
import type { SpaceContext } from '@components/context-space/SpaceContextContainer'

function hasNonNegativeToken(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

interface UseChatPanelLifecycleParams {
  isForeground: boolean
  panelActive: boolean
  isAuthenticated: boolean
  selectedSpace: SpaceContext | null
  selectedSpaceId: string | null
  /** 产品宿主 Space；草稿 UI 旗标挂在此，≠ selectedSpaceId（execution）时仍要触发预建 */
  conversationHostSpaceId?: string | null
  resolvedOrganizationId: string | null
  currentSessionId: string | null
  tabScopeKey?: string | null
  draftScopeKey?: string | null
  sessions: ChatSession[]

  activeContextType: string | null
  activeAppMeta: Record<string, unknown> | null
  openTabs: Array<{ type: string; id: string; title?: string; active?: boolean; group_id?: string; path?: string; kind?: string; url?: string; session_id?: string }> | null
  loadSessions: (spaceId: string, organizationId: string) => Promise<void>
  loadModels: (organizationId?: string) => Promise<void>
  syncContext: (
    spaceId?: string | null,
    contextType?: string | null,
    appMeta?: Record<string, unknown> | null,
    openTabs?: Array<{ type: string; id: string; title?: string; active?: boolean; group_id?: string; path?: string; kind?: string; url?: string; session_id?: string }> | null,
    options?: { force?: boolean; tabScopeKey?: string | null; workspaceScopeKey?: string | null },
  ) => Promise<void>
  switchModel: (sessionId: string, modelId: string) => Promise<void>
}

export function useChatPanelLifecycle(params: UseChatPanelLifecycleParams) {
  const {
    isForeground,
    panelActive,
    isAuthenticated,
    selectedSpace,
    selectedSpaceId,
    conversationHostSpaceId,
    resolvedOrganizationId,
    currentSessionId,
    tabScopeKey,
    draftScopeKey,
    sessions,
    activeContextType,
    activeAppMeta,
    openTabs,
    loadSessions,
    loadModels,
    syncContext,
    switchModel,
  } = params

  // 生命周期副作用控制器（hook mount 期唯一；去重锁 / 防抖定时器归属其内部）。
  const controllerRef = useRef<ChatPanelController | null>(null)
  if (!controllerRef.current) controllerRef.current = createChatPanelController()
  useEffect(() => () => controllerRef.current?.dispose(), [])

  useDraftMessagePageLifecycle({
    active: isForeground && panelActive,
    draftScopeKey,
  })

  // ── Store reads (values only used by this hook's effects) ──
  const restoringSessionId = useChatStore(s => s.restoringSessionId)
  const rewindPreview = useChatStore(s => s.rewindPreview)
  const cancelRewindPreview = useChatStore(s => s.cancelRewindPreview)
  const draftSessionBySpaceId = useChatStore(s => s.draftSessionBySpaceId)
  /** 草稿态（全局 currentSessionId 为空）时，Space 上预建/当前会话仍可能有完整 overrides。 */
  const draftTargetSessionId = useChatStore(
    useCallback(
      (s) => (selectedSpaceId
        ? s.currentSessionIdBySpaceId[selectedSpaceId] ?? null
        : null),
      [selectedSpaceId],
    ),
  )

  // 供「current 未知 → 草稿」effect 在 loadSessions 写完列表后重跑（ 拆分后）
  const spaceSessionsLoaded = useChatStore(
    useCallback(
      (s) => (selectedSpaceId
        ? Object.prototype.hasOwnProperty.call(s.sessionsBySpaceId, selectedSpaceId)
        : false),
      [selectedSpaceId],
    ),
  )
  const spaceSessionCount = useChatStore(
    useCallback(
      (s) => (selectedSpaceId ? (s.sessionsBySpaceId[selectedSpaceId]?.length ?? 0) : 0),
      [selectedSpaceId],
    ),
  )

  const availableModels = useChatModelStore(s => s.availableModels)
  const loadedModelsOrganizationId = useChatModelStore(s => s.loadedOrganizationId)
  const isLoadingModels = useChatModelStore(s => s.isLoadingModels)
  const modelLoadError = useChatModelStore(s => s.modelLoadError)
  const selectedModelParamOverrides = useChatModelStore(
    useCallback(
      (s) => (currentSessionId
        ? s.modelParamSelectionsBySessionId[currentSessionId]?.overrides ?? null
        : null),
      [currentSessionId],
    ),
  )

  const fallbackAgentMode = useChatStore(s => s.agentMode)
  const sessionAgentMode = useChatRuntimeStore(
    useCallback(
      (s) => (currentSessionId ? s.agentModeBySessionId[currentSessionId] : undefined),
      [currentSessionId],
    ),
  )
  // ── Managed state ──
  const [pendingModelId, setPendingModelId] = useState<string | null>(null)
  const [pendingModelParamOverrides, setPendingModelParamOverrides] =
    useState<ModelParamOverrides | null>(null)
  const setPendingModelParamOverride = useCallback((
    key: string,
    value: ModelParamValue,
  ) => {
    setPendingModelParamOverrides((current) => {
      const next = { ...(current ?? {}) }
      if (value === null) {
        delete next[key]
      } else {
        next[key] = value
      }
      return Object.keys(next).length > 0 ? next : null
    })
  }, [])

  /** 草稿同步后用 session 全量 overrides 覆盖 pending（保留 fast_by_model）。 */
  const replacePendingModelParamOverrides = useCallback((
    overrides: ModelParamOverrides | null,
  ) => {
    setPendingModelParamOverrides(
      overrides && Object.keys(overrides).length > 0 ? { ...overrides } : null,
    )
  }, [])

  // ── Computed values ──
  const effectiveAgentMode = resolveAgentModeName(sessionAgentMode, fallbackAgentMode)

  const effectiveGraphType = 'chat' as const

  const isRestoring = restoringSessionId !== null && restoringSessionId === currentSessionId

  // ── Effect: rewindPreview 清理 ──
  useEffect(() => {
    if (rewindPreview && currentSessionId !== rewindPreview.sessionId) {
      cancelRewindPreview()
    }
  }, [currentSessionId, rewindPreview, cancelRewindPreview])

  // ── Effect: pendingModelId 清理 ──
  useEffect(() => {
    setPendingModelId(null)
    setPendingModelParamOverrides(null)
  }, [selectedSpaceId])

  const currentSessionModelParamOverrides = useMemo(() => {
    if (!currentSessionId) return null
    return sessions.find(s => s.id === currentSessionId)?.model_param_overrides ?? null
  }, [currentSessionId, sessions])

  useEffect(() => {
    if (currentSessionId) setPendingModelParamOverrides(null)
  }, [currentSessionId])

  // ── Effect: pendingModelId → switchModel ──
  useEffect(() => {
    if (!currentSessionId || !pendingModelId || !isSendableChatModelId(pendingModelId)) return
    let cancelled = false
    switchModel(currentSessionId, pendingModelId)
      .then(() => { if (!cancelled) setPendingModelId(null) })
      .catch(() => { if (!cancelled) setPendingModelId(null) })
    return () => { cancelled = true }
  }, [currentSessionId, pendingModelId, switchModel])

  // ── Effect: space sessions 规范引用同步（：不再回写 currentSessionId）──
  // 仅把全局 state.sessions 对齐到当前聚焦 Space 的规范引用
  // （store 里 sessionsBySpaceId[spaceId] 的原始引用），业务下沉见 reconcileSpacePointer.ts。
  useLayoutEffect(() => {
    if (!isForeground || !selectedSpaceId) return
    syncSpaceCanonicalPointers(selectedSpaceId)
  }, [
    isForeground,
    selectedSpaceId,
    sessions,
  ])

  // ── Effect: Space 切换时先按缓存对齐全局指针，避免 loadSessions 完成前闪旧组织正文 ──
  useLayoutEffect(() => {
    if (!isForeground || !panelActive || !selectedSpaceId) return
    const spaceSessionsLoadedNow = Object.prototype.hasOwnProperty.call(
      useChatStore.getState().sessionsBySpaceId,
      selectedSpaceId,
    )
    // 桶已就绪时交给下面的 effect 做完整判定（含列表失效 / tracker）；这里只挡闪帧。
    if (spaceSessionsLoadedNow) return
    reconcileSpacePointer(selectedSpaceId, sessions)
  }, [
    isForeground,
    panelActive,
    selectedSpaceId,
    sessions,
  ])

  // ── Effect: restoringSessionId 超时保护 ──
  useEffect(() => {
    if (!restoringSessionId) return
    return startRestoringWatchdog(restoringSessionId)
  }, [restoringSessionId])

  // ── Effect: 模型列表加载 ──
  useLayoutEffect(() => {
    if (!panelActive || !isAuthenticated || !resolvedOrganizationId) return
    if (loadedModelsOrganizationId === resolvedOrganizationId) return
    loadModels(resolvedOrganizationId).catch(error => {
      logger.error('[ChatPanel] 加载模型列表失败:', error)
    })
  }, [
    panelActive,
    isAuthenticated,
    resolvedOrganizationId,
    loadedModelsOrganizationId,
    loadModels,
  ])

  // ── Effect: 会话列表加载（只跟 Space / 面板可见性走，不跟 currentSessionId）──
  // ：旧依赖含 currentSessionId，关 Tab 切换 current 会清 initLock 并重打
  // loadSessions SWR，放大归档与旧 list 竞态。
  useEffect(() => {
    if (!isForeground || !panelActive || !resolvedOrganizationId || !effectiveGraphType) return
    if (effectiveGraphType === 'chat' && !selectedSpaceId) {
      logger.warn('[ChatPanel] Chat 模式需要选中 Space，跳过初始化')
      return
    }
    if (!selectedSpaceId) return
    controllerRef.current!.ensureSpaceSessionsLoaded(selectedSpaceId, resolvedOrganizationId, loadSessions)
    return () => { controllerRef.current?.resetSessionLoadLock() }
  }, [isForeground, panelActive, resolvedOrganizationId, effectiveGraphType, selectedSpaceId, loadSessions])

  // ── Effect: Space / 组织切换后对齐全局 currentSessionId（与 loadSessions 解耦）──
  // 空列表 / 已草稿 early-return 若不清全局，会出现「页签已换、正文仍是旧组织」串台。
  useEffect(() => {
    if (!isForeground || !panelActive || !resolvedOrganizationId || !effectiveGraphType) return
    if (!selectedSpaceId || !spaceSessionsLoaded) return
    reconcileSpacePointer(selectedSpaceId, sessions)
  }, [
    isForeground,
    panelActive,
    resolvedOrganizationId,
    effectiveGraphType,
    selectedSpaceId,
    currentSessionId,
    sessions,
    spaceSessionsLoaded,
    spaceSessionCount,
  ])

  // ── Effect: 草稿态预热──
  // draft UI 旗标在 host A；ensure / sessions 桶在 execution B。
  // 每 draft episode 只预热一次（闩锁在 sessionPrefetchAction ）。
  // ：桶未 settle 时不抢跑 quick-start，避免 list revalidate / 指针抖动窗口误建空会话。
  useEffect(() => {
    if (!isForeground || !panelActive || !selectedSpaceId || !resolvedOrganizationId) return
    if (!spaceSessionsLoaded) return
    const draftUiSpaceId = conversationHostSpaceId ?? selectedSpaceId
    const inDraftUi = Boolean(
      draftSessionBySpaceId[draftUiSpaceId]
      || draftSessionBySpaceId[selectedSpaceId],
    )
    if (!inDraftUi) return
    if (currentSessionId) return
    controllerRef.current!.prefetchDraftIfNeeded({
      spaceId: selectedSpaceId,
      draftUiSpaceId,
      organizationId: resolvedOrganizationId,
      tabScopeKey: tabScopeKey ?? null,
    })
  }, [
    isForeground,
    panelActive,
    selectedSpaceId,
    conversationHostSpaceId,
    resolvedOrganizationId,
    currentSessionId,
    draftSessionBySpaceId,
    tabScopeKey,
    spaceSessionsLoaded,
  ])

  // ── Effect: 进入 Space 时 checkPending（PRD 06 §5.6.3 状态 B）──
  useEffect(() => {
    if (!isForeground || !panelActive || !selectedSpaceId) return
    controllerRef.current!.checkPendingReports(selectedSpaceId, currentSessionId)
    return () => { controllerRef.current?.resetCheckPendingLock() }
  }, [isForeground, panelActive, selectedSpaceId, currentSessionId, sessions])

  // ── Effect: 监听冷启动 proactive report 完成事件（B-3 fix）──
  useEffect(() => {
    return attachProactiveReportListener(selectedSpaceId)
  }, [selectedSpaceId])

  // ── Effect: 上下文同步（显式防抖，业务下沉到控制器）──
  useEffect(() => {
    if (!isForeground) return
    if (effectiveGraphType === 'chat' && currentSessionId) {
      controllerRef.current!.requestContextSync({
        isForeground,
        currentSessionId,
        spaceId: selectedSpace?.id || null,
        activeContextType,
        activeAppMeta,
        openTabs,
        tabScopeKey,
        syncContext,
      }, 260)
    }
  }, [isForeground, effectiveGraphType, currentSessionId, selectedSpace?.id, activeContextType, activeAppMeta, openTabs, tabScopeKey, syncContext])

  // ── 计算值：currentModel ──
  const defaultModelName = useChatModelStore(s => s.defaultModelName)
  const selectedAgent = useSpaceStore(s => s.selectedAgent)
  const agentPreferredModelId = selectedAgent?.preferred_model_id
  const stickyRuntimeModelId = selectedAgent?.id
    ? readRuntimeModelPreference(selectedAgent.id)
    : null
  const sendableModels = useMemo(
    () => filterSendableChatModels(availableModels),
    [availableModels],
  )

  const currentModel = useMemo(() => {
    const fallbackModel = () => pickDefaultSendableChatModel(availableModels, {
      stickyModelId: stickyRuntimeModelId,
      preferredModelId: agentPreferredModelId,
      defaultModelName,
    })
    if (!currentSessionId) {
      if (pendingModelId) {
        return findSendableChatModel(availableModels, pendingModelId) ?? fallbackModel()
      }
      // 与 overrides 同源：草稿预建 session 上的 current_model_id
      if (draftTargetSessionId) {
        const draftSession = sessions.find(session => session.id === draftTargetSessionId)
        const draftModelId = draftSession?.current_model_id
          || (draftSession as typeof draftSession & { current_model?: string } | undefined)?.current_model
        if (draftModelId) {
          return findSendableChatModel(availableModels, draftModelId) ?? fallbackModel()
        }
      }
      return fallbackModel()
    }
    const currentSession = sessions.find(session => session.id === currentSessionId)
    const currentModelId = currentSession?.current_model_id
      || (currentSession as typeof currentSession & { current_model?: string } | undefined)?.current_model
    if (!currentSession || !currentModelId) return fallbackModel()
    return findSendableChatModel(availableModels, currentModelId) ?? fallbackModel()
  }, [
    availableModels,
    currentSessionId,
    defaultModelName,
    sessions,
    pendingModelId,
    agentPreferredModelId,
    stickyRuntimeModelId,
    draftTargetSessionId,
  ])
  // ── 计算值：currentContextTier ──
  // 优先 session.context_tier_id（用户显式选择），fallback 到模型默认档；
  // 单档或未配档位的模型返回 null（CompactModelSelector 据此不显示芯片）。
  const currentContextTier = useMemo(() => {
    const tiers = currentModel?.context_tiers ?? []
    if (!tiers.length) return null
    if (currentSessionId) {
      const session = sessions.find(s => s.id === currentSessionId)
      const explicitId = (session?.context_tier_id || '').trim()
      if (explicitId) {
        const found = tiers.find(t => t.id === explicitId)
        if (found) return found
      }
    }
    return tiers.find(t => t.is_default) ?? tiers[0] ?? null
  }, [currentModel, currentSessionId, sessions])

  const draftTargetSessionOverrides = useMemo(() => {
    if (currentSessionId || !draftTargetSessionId) return null
    return sessions.find(s => s.id === draftTargetSessionId)?.model_param_overrides
      ?? useChatStore.getState().getSessionById(draftTargetSessionId)?.model_param_overrides
      ?? null
  }, [currentSessionId, draftTargetSessionId, sessions])

  const currentModelParamOverrides = useMemo(() => {
    if (!currentSessionId) {
      // 草稿态：预建 session 上的 overrides（含 fast_by_model）是 SSoT。
      // pending 里若只有裸 service_tier，会把 Fast 误绑到「当前展示的任意模型」。
      if (draftTargetSessionOverrides) return draftTargetSessionOverrides
      const remembered = readRuntimeModelParamPreference(selectedAgent?.id, currentModel?.id)
      const merged = {
        ...(remembered ?? {}),
        ...(pendingModelParamOverrides ?? {}),
      }
      return Object.keys(merged).length > 0 ? merged : null
    }
    if (!selectedModelParamOverrides) return currentSessionModelParamOverrides
    const merged = {
      ...(currentSessionModelParamOverrides ?? {}),
      ...selectedModelParamOverrides,
    }
    return Object.keys(merged).length > 0 ? merged : null
  }, [
    currentSessionId,
    currentSessionModelParamOverrides,
    selectedModelParamOverrides,
    pendingModelParamOverrides,
    draftTargetSessionOverrides,
    selectedAgent?.id,
    currentModel?.id,
  ])

  // ── 计算值：tokenUsage ──
  // 从当前 session 的消息中汇总 DONE 回传的分项数据
  const messagesBySessionId = useChatStore(s => s.messagesBySessionId)
  const currentMessages = currentSessionId ? messagesBySessionId[currentSessionId] : undefined

  const CREDITS_PER_YUAN = 100
  const tokenUsage = useMemo(() => {
    if (!currentSessionId) return null
    const session = sessions.find(s => s.id === currentSessionId)
    if (!session) return null
    // ring 分母（contextWindow）：优先采用「用户当前选中档位」的真实窗口大小，
    // 缺失才回退到 currentModel 默认。
    //
    // 历史 bug：之前一律用 `currentModel.context_window_tokens`——但同一逻辑模型
    // 可以挂多档（如 Claude Opus 4.6 的 standard 200K + long_1m 1M），用户选了
    // 1M 档时分子已经能跑到 800K，分母却卡在 200K → ring 永远显示 100% +
    // destructive 配色，触发用户「快爆了」的虚假焦虑。
    //
    // `ContextTier.max_input_tokens` 是该档允许的最大 input token 数（来自后端
    // tiered_pricing.tiers[].max_input_tokens）；为 null 表示「不限定 / 走模型默认」，
    // 此时也回退到 currentModel.context_window_tokens。
    const contextWindow =
      currentContextTier?.max_input_tokens
      || currentModel?.context_window_tokens
      || currentModel?.max_tokens
      || 0
    if (contextWindow <= 0) return null

    // 「上下文用量环」messages-as-truth（2026-05-10 起）：
    //
    //   contextTokens **不再**取自 session.context_tokens——那是后端字段，在
    //   编排迁移到本地 agent-runtime 之后从未被写入（永远是 0），导致 ring
    //   长期不显示。改成从 messages 倒序找最后一条带真实 usage 的 assistant
    //   消息，取其「最近一次 LLM 调用的 input + cache_read + cache_creation」
    //   作为分子（不含 output——output 是当前轮刚生成的，下一轮才进上下文）。
    //
    //   这条路径不依赖任何后端持久化字段，只要 ChatMessage.metadata 还在落库
    //   就能算出正确值；刷新 / 切设备 / 历史会话恢复均自然有效。详细设计见
    //   `utils/chatMessageContextUsage.ts` 的文件头注释。
    //
    // 「会话累计」读 ChatSession 累计字段——input / output / cache_read 三者都由
    // streamTokenUsage（流式实时）+ 服务端 relay（DONE 权威）同一路径单调累加，
    // 各自单列（计费单价不同，不并成合计）。input 为非 cache 输入（按输入计费）。
    // 不用「求和 usage_json」——usage_json 是上下文环的 per-call 记录（取最后一条、
    // 只重输入侧、异常轮次会缺/回填），逐条求和会时高时低，不是计费账本。
    const sessionTokens = extractChatSessionTokenUsage(session)
    const inputTokens = sessionTokens.input_tokens ?? 0
    const outputTokens = sessionTokens.output_tokens ?? 0
    const hasSessionCacheReadTokens = hasNonNegativeToken(sessionTokens.cache_read_input_tokens)
    const sessionCacheReadTokens = hasSessionCacheReadTokens
      ? sessionTokens.cache_read_input_tokens
      : undefined

    // 传当前模型名让 runtime 估算器识别模型族（图片 token 算法按 provider 区分）；
    // 口径与 agent-runtime 压缩 / 压力判定一致（单一计算源）。
    const contextTokens = getCurrentContextTokens(currentMessages ?? [], undefined, currentModel?.name)
    // contextSource：'last_call'（精确）/ 'turn_accum'（fallback 偏高）/ 'none'。
    // 老会话（2026-05-10 之前的 turn）只有 turn 累加字段，多 LLM 调用 turn
    // 中 ring 数字会偏高 2-3x。让 ring tooltip 拿到此标记后展示「估算偏差」
    // 提示，避免老用户误判为「上下文快爆了」。
    const contextSource = getCurrentUsageSource(currentMessages ?? [])

    // PRD-04 Phase 5 B2/B3/B4：从 assistant 消息 metadata 汇总 DONE 回传的分项数据
    let creditsConsumed = 0
    let compactInputTokens = 0
    let reasoningTokens = 0
    let hasChargeFailed = false
    // PRD-04 Wave 5 任务 5 + Review 修复：
    //   - isByok 以"最近一条 assistant 消息"为准（lastByok）。之前用"任一 is_byok=true"
    //     聚合会在"BYOK → 非 BYOK"切换场景下系统性误导用户以为全程免费。
    //   - hasMixedBilling：会话内同时出现过 BYOK 与非 BYOK 扣费，UI 可据此展示
    //     "部分消费已用积分 / 部分走自带 Key"而非单一语义。
    //   - creditsConsumed 累计值包含所有非 BYOK 消息的扣费，与 isByok 独立。
    let lastByok: boolean | null = null
    let anyByokSeen = false
    let anyNonByokWithCredits = false
    const msgs = currentMessages ?? []
    for (let i = msgs.length - 1; i >= 0; i--) {
      const msg = msgs[i] as typeof msgs[number] & { metadata?: Record<string, unknown> }
      if (msg.role !== 'assistant' || !msg.metadata) continue
      const meta = msg.metadata
      const msgIsByok = meta.is_byok === true
      const msgCredits = typeof meta.credits_consumed === 'number' ? meta.credits_consumed : 0
      if (lastByok === null && (msgIsByok || msgCredits > 0)) {
        lastByok = msgIsByok
      }
      if (msgIsByok) anyByokSeen = true
      if (!msgIsByok && msgCredits > 0) anyNonByokWithCredits = true
      if (msgCredits > 0) creditsConsumed += msgCredits
      if (typeof meta.compact_input_tokens === 'number') compactInputTokens += meta.compact_input_tokens
      if (typeof meta.reasoning_tokens === 'number') reasoningTokens += meta.reasoning_tokens
      if (meta.charge_failed === true) hasChargeFailed = true
    }
    const isByok = lastByok === true
    const hasMixedBilling = anyByokSeen && anyNonByokWithCredits

    // B4：后端实际扣费优先于前端估算
    // 任务 5：BYOK 当前会话不展示"预估费用"——BYOK 不扣 TabTin 点券
    let estimatedCost: number | undefined
    if (!isByok && creditsConsumed <= 0) {
      const inputPrice = currentModel?.input_price_per_1k
      const outputPrice = currentModel?.output_price_per_1k
      if (inputPrice != null && outputPrice != null && (inputPrice > 0 || outputPrice > 0)) {
        estimatedCost = ((inputTokens * inputPrice + outputTokens * outputPrice) / 1000) * CREDITS_PER_YUAN
      }
    }

    return {
      inputTokens,
      outputTokens,
      contextTokens,
      contextSource,
      contextWindow,
      estimatedCost,
      creditsConsumed: creditsConsumed > 0 ? creditsConsumed : undefined,
      cacheReadTokens: sessionCacheReadTokens,
      hasCacheReadTokens: hasSessionCacheReadTokens,
      compactInputTokens: compactInputTokens > 0 ? compactInputTokens : undefined,
      reasoningTokens: reasoningTokens > 0 ? reasoningTokens : undefined,
      chargeFailed: hasChargeFailed || undefined,
      isByok: isByok || undefined,
      hasMixedBilling: hasMixedBilling || undefined,
    }
  }, [currentSessionId, sessions, currentModel, currentContextTier, currentMessages])

  // ── 计算值：canSend / disabledReason ──
  const billingBlocked = useBillingStore(s => s.billingBlocked)
  const memberLimitReached = useBillingStore(s => s.memberLimitReached)
  const memberLimitReason = useBillingStore(s => s.memberLimitReason)

  // [#882] 设置页 React Query 已刷新余额时，chat guard 可能仍停留在旧的 billingBlocked。
  // 进入前台 chat 时再拉一次钱包，与设置页共用同一 API 字段校正。
  useEffect(() => {
    if (!isForeground || !panelActive || !resolvedOrganizationId || !billingBlocked) return
    syncBillingBlockedFromWallet(resolvedOrganizationId)
  }, [isForeground, panelActive, resolvedOrganizationId, billingBlocked])
  const hasSendableChatModel = sendableModels.length > 0
  // 遥控器在线时允许发消息，sendMessageAction 会走 chat.send_message 转发到绑定
  // 执行设备；这里只有绑定执行设备离线 / 未知时才禁发，避免用户提交后撞 runtime offline。
  const remoteExecution = useRemoteExecutionGate(selectedSpaceId)
  // billingBlocked 只承载余额风险提示，不作为 Chat 硬门禁。Provider Sponsored
  // Credit 是模型维度资金，钱包与套餐均为 0 时仍可能由服务端 funding precheck
  // 放行；最终发送资格由服务端按 Provider → Monthly → Wallet 判定。
  const canSend = Boolean(
    isForeground
    && isAuthenticated
    && effectiveGraphType
    && resolvedOrganizationId
    && selectedSpaceId
    && !memberLimitReached
    && hasSendableChatModel
    && !remoteExecution.isBlocked
  )
  const disabledReason = useMemo<string | null>(() => {
    if (isRestoring) return 'restoring'
    if (memberLimitReached) return memberLimitReason ?? 'member_monthly_limit'
    if (!isForeground) return 'inactive'
    if (!isAuthenticated) return 'unauthenticated'
    if (!effectiveGraphType) return 'no_graph_type'
    if (!resolvedOrganizationId) return 'no_organization'
    if (!selectedSpaceId) return 'no_space'
    if (remoteExecution.isBlocked) {
      return remoteExecution.controlDeviceOffline ? 'remote_device_offline' : 'remote_device'
    }
    if (!isLoadingModels && !modelLoadError && availableModels.length > 0 && !hasSendableChatModel) {
      return isCommunityDistribution ? noChatModelDisabledReason : 'no_chat_model'
    }
    return null
  }, [
    isRestoring,
    memberLimitReached,
    memberLimitReason,
    isForeground,
    isAuthenticated,
    effectiveGraphType,
    resolvedOrganizationId,
    selectedSpaceId,
    remoteExecution.isBlocked,
    remoteExecution.controlDeviceOffline,
    isLoadingModels,
    modelLoadError,
    availableModels.length,
    hasSendableChatModel,
  ])

  useEffect(() => {
    if (!canSend || isRestoring) {
      logger.warn(
        `[ChatPanel] Chat disabled — reason=${disabledReason}` +
        ` | isForeground=${isForeground}` +
        ` | isAuthenticated=${isAuthenticated}` +
        ` | effectiveGraphType=${effectiveGraphType}` +
        ` | resolvedOrganizationId=${resolvedOrganizationId ? 'yes' : 'null'}` +
        ` | selectedSpaceId=${selectedSpaceId ? 'yes' : 'null'}`,
      )
    }
  }, [canSend, isRestoring, disabledReason, isForeground, isAuthenticated, effectiveGraphType, resolvedOrganizationId, selectedSpaceId])

  return {
    effectiveGraphType,
    effectiveAgentMode,
    isRestoring,
    pendingModelId,
    setPendingModelId,
    setPendingModelParamOverride,
    replacePendingModelParamOverrides,
    sendableModels,
    currentModel,
    currentContextTier,
    currentModelParamOverrides,
    tokenUsage,
    canSend,
    disabledReason,
  }
}
