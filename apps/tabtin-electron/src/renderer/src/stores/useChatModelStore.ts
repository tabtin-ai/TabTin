/** @store-category domain */

/**
 * Chat Model Store
 *
 * 管理模型列表、默认模型、加载状态。
 * 从 useChatStore 拆分而来；session 数据通过中立 leaf
 * `chat/storeAccessRegistry` 注入的 `ChatSessionAccess` 间接读写
 * （而非顶部静态 import useChatStore，避免 module 间循环依赖）。
 */

import { create } from 'zustand'
import { getChatClient } from '../services/chatApi'
import { useOrganizationStore } from './useOrganizationStore'
import { useSpaceStore } from './useSpaceStore'
import { useChatRuntimeStore } from './useChatRuntimeStore'
import type { Model, ChatSession, ContextTier, ModelParamOverrides, ModelParamValue } from '@tabtin/chat-client'
import i18n from '@/i18n'
import { createLogger } from '@/utils/logger'
import { updateProviderMetas } from '@/utils/provider-registry'
import { mergeConnectedOpenAICodexModels } from '@/utils/openaiCodexCatalog'
import {
  applyFastParamForModel,
  isFastOnValue,
  retainFastOverridesAfterServerPersist,
  resolveModelFastToggle,
  seedFastMapFromLegacyParam,
  writeFastForModel,
  type ModelFastToggle,
} from '@/utils/modelFastToggle'
import { isOpenAICodexModel } from '../../../shared/openai-codex-models'
import {
  clearSessionLocalModelPreference,
  writeSessionLocalModelPreference,
} from './chat/session/sessionLocalModelPreference'

const log = createLogger('ChatModel')
import { getChatSessionAccess } from './chat/shared/storeAccessRegistry'
import {
  mergeRuntimeProfileSources,
  normalizeModelParamOverrides,
  runtimeProfileOrNull,
  toCodexModelParamsForTransport,
  toRuntimeProfileV2ForTransport,
} from './chat/runtimeProfileIntent'
import {
  applyRuntimeProfileForModel,
  retainRuntimeProfileByModelAfterServerPersist,
  seedRuntimeProfileMapsFromLegacy,
  writePerformanceForModel,
  writeThinkingForModel,
} from './chat/runtimeProfileByModel'
import { predictRuntimeProfileNoticesOnModelSwitch } from '@/components/chat/notice/runtimeProfileNotice'
import {
  findSendableChatModel,
  pickDefaultSendableChatModel,
} from '@/utils/chatModelGuards'
import { readRuntimeModelPreference } from '@/stores/chat/session/runtimeModelPreference'
import {
  loadOrganizationDeviceModelPreferences,
  readCachedOrganizationDeviceModelPreferences,
} from '@/stores/chat/session/organizationDeviceModelPreference'
import { normalizeCatalogModelCapabilities } from '@/utils/normalizeCatalogModelCapabilities'

// useChatModelStore → useChatStore 的反向访问通过中立 leaf
// `chat/storeAccessRegistry` 注入。由 `useChatStore.ts` module body 末尾
// 调用 `registerChatSessionAccess` 写入实现；本文件只通过
// `getChatSessionAccess()` 读出。这样 useChatModelStore 与 useChatStore
// 都单向依赖 leaf，避免互相 import 形成 ESM 循环加载。

interface SessionModelParamSelection {
  modelId: string | null
  overrides: ModelParamOverrides
}

interface ChatModelState {
  availableModels: Model[]
  defaultModelName: string | null
  userDefaultModelId: string | null
  /** 当前列表归属的 Organization；加载中也立即切换，避免继续展示上一组织模型。 */
  loadedOrganizationId: string | null
  /** 最近一次完整模型目录成功写入的时间，用于低频静默刷新。 */
  modelsLoadedAt: number | null
  isLoadingModels: boolean
  modelLoadError: string | null
  /** 当前客户端中用户明确选择的会话参数，跨过草稿转正式会话时的组件重挂载。 */
  modelParamSelectionsBySessionId: Record<string, SessionModelParamSelection>

  loadModels: (organizationId?: string) => Promise<void>
  /** 保留当前列表并静默刷新完整模型目录，在时效窗口内自动去重。 */
  refreshModelsIfStale: (
    organizationId?: string,
    options?: { maxAgeMs?: number; force?: boolean },
  ) => Promise<void>
  /** 对话结算后静默刷新专项点券余额，不清空模型列表或触发加载态。 */
  refreshPromotionCredits: (organizationId?: string) => Promise<void>
  switchModel: (sessionId: string, modelId: string, contextTierId?: string) => Promise<void>
  switchContextTier: (sessionId: string, tierId: string | null) => Promise<void>
  setModelParamOverride: (sessionId: string, key: string, value: ModelParamValue) => Promise<void>
  /**
   * 把当前 session 的 context tier 主动同步给 main 进程。
   *
   * 主要使用场景：用户切换到一个之前选过 1M 档的 session 时，
   * sendMessageAction 在发起 LLM 调用前调用一次，确保 ElectronAgentHost
   * 的 sessionContextTiers Map 是最新的（renderer 切 session 不会自动同步，
   * 否则需要监听 currentSessionId 变化太重）。
   */
  syncTierForActiveSession: (sessionId?: string) => Promise<void>
  /** 把会话持久化的模型运行参数同步给 main，确保恢复会话后下一轮立即生效。 */
  syncModelParamsForActiveSession: (sessionId?: string) => Promise<void>
  getCurrentModel: () => Model | null
  /**
   * 解析 (sessionId, model) 组合下当前生效的上下文档位。
   *
   * 优先级：
   *   1) session.context_tier_id（用户显式选过且仍存在）
   *   2) model.context_tiers 中 is_default = true
   *   3) model.context_tiers[0]
   *   4) null（模型未配档位）
   */
  getCurrentContextTier: () => ContextTier | null
  getCurrentModelParamOverrides: () => ModelParamOverrides
  reset: () => void
}

/**
 * 记住每个 session 上次成功推给 main 进程的 tierId，用于去重。
 *
 * main 侧 `sessionContextTiers` 按 sessionId 幂等 `Map.set`/`delete`——相同
 * (sessionId, tierId) 重复推送结果完全一致。因此当值未变时跳过 IPC 是行为
 * 等价的纯提速（省掉发送前 prep 里这趟 renderer↔main 往返）。
 *
 * 语义：仅在推送成功后记录；失败不记录，下次调用会重试。session 级重置时由
 * reset() 清空。已知边界——若 main 侧 Map 在渲染进程不知情的情况下被清（如
 * main 单独重启而 renderer 未 reload），此记录可能与 main 不一致而误跳过；
 * Electron 下 main 崩溃通常连带整个 app，风险极低，暂不额外加固。
 */
const lastSyncedTierBySession = new Map<string, string | null>()
const lastSyncedModelParamsBySession = new Map<string, string>()

/**
 * Electron 模式下，把当前 session 的档位同步给 main 进程。
 * main 写到 sessionContextTiers Map，下次 LLM 请求 buildHeaders 时透传。
 *
 * Daemon / web / 测试环境下 window.tabtin 不存在，无操作。
 */
async function syncTierToMainProcess(sessionId: string, tierId: string | null): Promise<void> {
  try {
    const bridge = (typeof window !== 'undefined'
      ? (window as unknown as { tabtin?: { agentEngine?: { setSessionContextTier?: (sid: string, tid: string | null) => Promise<unknown> } } }).tabtin?.agentEngine?.setSessionContextTier
      : undefined)
    if (typeof bridge !== 'function') return
    // 值未变则 main 侧 Map 已是该值，重推纯冗余，跳过 IPC。
    if (lastSyncedTierBySession.get(sessionId) === tierId) return
    await bridge(sessionId, tierId)
    lastSyncedTierBySession.set(sessionId, tierId)
  } catch (err) {
    log.warn('同步 context tier 到 main 进程失败:', { sessionId, tierId, err })
  }
}

function findAvailableModelById(
  getState: () => ChatModelState,
  modelId: string,
): Model | undefined {
  const id = modelId.trim()
  if (!id) return undefined
  return getState().availableModels.find(
    (item) => item.id === id || item.name === id || item.model_name === id,
  )
}

function resolveFastToggleForModelId(
  getState: () => ChatModelState,
  modelId: string,
): ModelFastToggle | null {
  const id = modelId.trim()
  if (!id) return null
  // Codex 可不依赖目录条目（尚未 merge 进 availableModels 时也能切）。
  if (isOpenAICodexModel(id)) {
    return resolveModelFastToggle({ id } as Model)
  }
  return resolveModelFastToggle(findAvailableModelById(getState, id))
}

/** W2f PR2：切模型后即时 Runtime Profile banner；绝不改 overrides / thinking_mode。 */
function pushRuntimeProfileSwitchNotices(
  sessionId: string,
  preservedProfile: ModelParamOverrides,
  modelId: string,
  getState: () => ChatModelState,
): void {
  const model = findAvailableModelById(getState, modelId)
  const drafts = predictRuntimeProfileNoticesOnModelSwitch(preservedProfile, model)
  if (drafts.length === 0) return
  const runtime = useChatRuntimeStore.getState()
  for (const draft of drafts) {
    runtime.pushCapabilityBanner(sessionId, draft)
  }
}

async function syncModelParamsToMainProcess(
  sessionId: string,
  overrides: ModelParamOverrides,
  options: { throwOnError?: boolean; modelId?: string } = {},
): Promise<void> {
  try {
    const bridge = (typeof window !== 'undefined'
      ? (window as unknown as { tabtin?: { agentEngine?: { setSessionModelParamOverrides?: (sid: string, overrides: ModelParamOverrides | null) => Promise<unknown> } } }).tabtin?.agentEngine?.setSessionModelParamOverrides
      : undefined)
    if (typeof bridge !== 'function') return
    const modelId = (
      options.modelId
      || getChatSessionAccess()?.getSessionById(sessionId)?.current_model_id
      || ''
    ).trim()
    // Codex：保留 reasoning_effort；平台模型：W2d v2（不回写可推导 effort）
    const normalized = isOpenAICodexModel(modelId)
      ? toCodexModelParamsForTransport(overrides)
      : toRuntimeProfileV2ForTransport(overrides)
    const serialized = JSON.stringify(normalized)
    if (lastSyncedModelParamsBySession.get(sessionId) === serialized) return
    await bridge(sessionId, Object.keys(normalized).length > 0 ? normalized : null)
    lastSyncedModelParamsBySession.set(sessionId, serialized)
  } catch (err) {
    log.warn('同步模型参数覆盖到 main 进程失败:', { sessionId, err })
    if (options.throwOnError) throw err
  }
}

// 单例 store 会跨 Organization 存活。序号保证切换后较晚发起的请求拥有写入权，
// 防止旧 Organization 的慢响应覆盖新前台列表。
let _loadModelsRequestSequence = 0
let _promotionCreditRefreshSequence = 0
let _modelCatalogRefreshInFlight: {
  organizationId: string
  promise: Promise<void>
} | null = null

export const useChatModelStore = create<ChatModelState>()((set, get) => ({
  availableModels: [],
  defaultModelName: null,
  userDefaultModelId: null,
  loadedOrganizationId: null,
  modelsLoadedAt: null,
  isLoadingModels: false,
  modelLoadError: null,
  modelParamSelectionsBySessionId: {},

  loadModels: async (explicitOrganizationId) => {
    const requestSequence = ++_loadModelsRequestSequence
    // 完整目录加载拥有更高权威，必须使此前所有静默余额刷新响应失效。
    _promotionCreditRefreshSequence += 1
    const organizationId = (
      typeof explicitOrganizationId === 'string' && explicitOrganizationId.trim()
    )
      ? explicitOrganizationId.trim()
      : useOrganizationStore.getState().getEffectiveOrganizationId()
    if (!organizationId) {
      set({
        availableModels: [],
        defaultModelName: null,
        userDefaultModelId: null,
        loadedOrganizationId: null,
        modelsLoadedAt: null,
        isLoadingModels: false,
        modelLoadError: i18n.t('chat:errors.modelLoadFailed'),
      })
      return
    }

    const MAX_RETRIES = 3
    const BASE_DELAY_MS = 2000

    set({
      availableModels: [],
      defaultModelName: null,
      userDefaultModelId: null,
      loadedOrganizationId: organizationId,
      modelsLoadedAt: null,
      isLoadingModels: true,
      modelLoadError: null,
    })

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (requestSequence !== _loadModelsRequestSequence) return
      try {
        const client = getChatClient()
        const [response] = await Promise.all([
          client.models.list(organizationId),
          loadOrganizationDeviceModelPreferences(organizationId).catch((error) => {
            log.warn('读取当前设备模型偏好失败:', { organizationId, error })
            return {}
          }),
        ])

        // 用户可能已切到其他 Organization；旧请求只能结束，不能覆盖新列表。
        if (requestSequence !== _loadModelsRequestSequence) return

        if (response.providers) {
          updateProviderMetas(response.providers)
        }

        let availableModels = response.models.map(normalizeCatalogModelCapabilities)
        try {
          const status = await window.tabtin?.openaiCodex?.getStatus()
          if (status) {
            availableModels = mergeConnectedOpenAICodexModels(availableModels, status)
          }
        } catch (error) {
          // 本机登录状态不可用不应阻断平台模型目录。
          log.warn('读取 ChatGPT Codex 本机登录状态失败:', error)
        }

        set({
          availableModels,
          defaultModelName: response.default_model_name,
          userDefaultModelId: response.user_default_model_id || null,
          loadedOrganizationId: organizationId,
          modelsLoadedAt: Date.now(),
          isLoadingModels: false,
          modelLoadError: null,
        })

        log.info('加载了模型:', { organizationId, count: availableModels.length })
        return
      } catch (error) {
        if (requestSequence !== _loadModelsRequestSequence) return
        if (attempt < MAX_RETRIES) {
          const delay = Math.min(BASE_DELAY_MS * Math.pow(2, attempt), 16000)
          log.warn('模型加载失败，将重试:', {
            organizationId,
            delayMs: delay,
            attempt: attempt + 1,
            maxRetries: MAX_RETRIES,
          })
          await new Promise<void>(r => setTimeout(r, delay))
        } else {
          log.error('Failed to load model list (retries exhausted):', {
            organizationId,
            maxRetries: MAX_RETRIES,
            error,
          })
          set({
            isLoadingModels: false,
            modelLoadError: error instanceof Error
              ? error.message
              : i18n.t('chat:errors.modelLoadFailed'),
          })
        }
      }
    }
  },

  refreshModelsIfStale: async (explicitOrganizationId, options) => {
    const currentState = get()
    const organizationId = (
      typeof explicitOrganizationId === 'string' && explicitOrganizationId.trim()
    )
      ? explicitOrganizationId.trim()
      : currentState.loadedOrganizationId
        || useOrganizationStore.getState().getEffectiveOrganizationId()
    if (!organizationId) return

    if (
      currentState.loadedOrganizationId !== organizationId
      || currentState.availableModels.length === 0
    ) {
      await get().loadModels(organizationId)
      return
    }
    if (currentState.isLoadingModels) return

    const maxAgeMs = Math.max(0, options?.maxAgeMs ?? 30_000)
    if (
      options?.force !== true
      && currentState.modelsLoadedAt !== null
      && Date.now() - currentState.modelsLoadedAt < maxAgeMs
    ) {
      return
    }

    if (_modelCatalogRefreshInFlight?.organizationId === organizationId) {
      await _modelCatalogRefreshInFlight.promise
      return
    }

    const requestSequence = ++_loadModelsRequestSequence
    _promotionCreditRefreshSequence += 1
    const refreshPromise = (async () => {
      try {
        const [response] = await Promise.all([
          getChatClient().models.list(organizationId),
          loadOrganizationDeviceModelPreferences(organizationId).catch((error) => {
            log.warn('刷新当前设备模型偏好失败:', { organizationId, error })
            return {}
          }),
        ])
        if (
          requestSequence !== _loadModelsRequestSequence
          || get().loadedOrganizationId !== organizationId
        ) {
          return
        }

        if (response.providers) {
          updateProviderMetas(response.providers)
        }
        let availableModels = response.models.map(normalizeCatalogModelCapabilities)
        try {
          const status = await window.tabtin?.openaiCodex?.getStatus()
          if (status) {
            availableModels = mergeConnectedOpenAICodexModels(availableModels, status)
          }
        } catch (error) {
          log.warn('读取 ChatGPT Codex 本机登录状态失败:', error)
        }

        if (
          requestSequence !== _loadModelsRequestSequence
          || get().loadedOrganizationId !== organizationId
        ) {
          return
        }

        set({
          availableModels,
          defaultModelName: response.default_model_name,
          userDefaultModelId: response.user_default_model_id || null,
          modelsLoadedAt: Date.now(),
          modelLoadError: null,
        })
        log.info('模型目录已静默刷新:', {
          organizationId,
          count: availableModels.length,
        })
      } catch (error) {
        log.warn('模型目录静默刷新失败，保留当前列表:', { organizationId, error })
      }
    })()
    _modelCatalogRefreshInFlight = { organizationId, promise: refreshPromise }
    try {
      await refreshPromise
    } finally {
      if (_modelCatalogRefreshInFlight?.promise === refreshPromise) {
        _modelCatalogRefreshInFlight = null
      }
    }
  },

  refreshPromotionCredits: async (explicitOrganizationId) => {
    const refreshSequence = ++_promotionCreditRefreshSequence
    const currentState = get()
    const organizationId = (
      typeof explicitOrganizationId === 'string' && explicitOrganizationId.trim()
    )
      ? explicitOrganizationId.trim()
      : currentState.loadedOrganizationId
        || useOrganizationStore.getState().getEffectiveOrganizationId()
    if (
      !organizationId
      || currentState.loadedOrganizationId !== organizationId
      || !currentState.availableModels.some(model => model.promotion_credit)
    ) {
      return
    }

    try {
      const response = await getChatClient().models.list(organizationId)
      if (
        refreshSequence !== _promotionCreditRefreshSequence
        || get().loadedOrganizationId !== organizationId
      ) {
        return
      }

      const latestById = new Map(response.models.map(model => [model.id, model]))
      set(state => ({
        availableModels: state.availableModels.map(model => {
          const latest = latestById.get(model.id)
          if (
            !latest
            || !Object.prototype.hasOwnProperty.call(latest, 'promotion_credit')
          ) {
            return model
          }
          return {
            ...model,
            promotion_credit: latest.promotion_credit ?? null,
          }
        }),
      }))
      log.info('专项点券余额已刷新:', { organizationId })
    } catch (error) {
      log.warn('专项点券余额刷新失败，保留当前展示:', { organizationId, error })
    }
  },

  switchModel: async (sessionId, modelId, contextTierId) => {
    const access = getChatSessionAccess()
    const session = access?.getSessionById(sessionId)
    const modelParamSelection =
      get().modelParamSelectionsBySessionId[sessionId]
    const previousSnapshot = {
      current_model_id: session?.current_model_id ?? null,
      context_tier_id: session?.context_tier_id ?? null,
      model_param_overrides: session?.model_param_overrides ?? null,
      selection: modelParamSelection
        ? { ...modelParamSelection }
        : undefined,
    }

    try {
      // 合并后：上一模型意图进 map，再按目标模型重算生效键（无记录 → 走 Catalog 默认，不串参）
      const mergedProfile = mergeRuntimeProfileSources(
        session?.model_param_overrides,
        modelParamSelection?.overrides,
      )

      if (
        contextTierId === undefined
        && modelParamSelection?.modelId === modelId
      ) {
        if (isOpenAICodexModel(modelId)) {
          writeSessionLocalModelPreference(sessionId, modelId)
        } else {
          clearSessionLocalModelPreference(sessionId)
        }
        await syncModelParamsToMainProcess(sessionId, mergedProfile)
        log.debug('跳过同模型冗余切换:', { sessionId, modelId })
        return
      }

      const previousModelId = (
        session?.current_model_id
        || (session as typeof session & { current_model?: string } | undefined)
          ?.current_model
        || modelParamSelection?.modelId
        || ''
      ).trim()
      const previousToggle = resolveFastToggleForModelId(get, previousModelId)
      const nextToggle = resolveFastToggleForModelId(get, modelId)

      let nextProfile = seedRuntimeProfileMapsFromLegacy(
        mergedProfile,
        previousModelId,
      )
      nextProfile = applyRuntimeProfileForModel(nextProfile, modelId)
      if (previousToggle && previousModelId) {
        nextProfile = seedFastMapFromLegacyParam(
          nextProfile,
          previousModelId,
          previousToggle,
        )
      }
      nextProfile = applyFastParamForModel(nextProfile, modelId, nextToggle)
      const nextProfileOrNull = runtimeProfileOrNull(nextProfile)

      const applyLocalModelState = (
        nextModelId: string,
        nextTierId: string | null,
      ) => {
        access?.setSessionFields(sessionId, {
          current_model_id: nextModelId,
          context_tier_id: nextTierId,
          model_param_overrides: nextProfileOrNull,
        })
        set((state) => ({
          modelParamSelectionsBySessionId: {
            ...state.modelParamSelectionsBySessionId,
            [sessionId]: {
              modelId: nextModelId,
              overrides: nextProfile,
            },
          },
        }))
      }

      if (isOpenAICodexModel(modelId)) {
        const status = await window.tabtin?.openaiCodex?.getStatus()
        if (!status?.connected) {
          throw new Error('请先在「订阅套餐」中登录 ChatGPT，才能使用 Codex 模型。')
        }

        applyLocalModelState(modelId, null)
        writeSessionLocalModelPreference(sessionId, modelId)
        await syncTierToMainProcess(sessionId, null)
        await syncModelParamsToMainProcess(sessionId, nextProfile)
        useChatRuntimeStore.getState().clearCapabilityBanners(sessionId)
        pushRuntimeProfileSwitchNotices(sessionId, nextProfile, modelId, get)
        log.info('Chat 本机 Codex 模型已切换（按模型隔离 Runtime Profile）:', {
          sessionId,
          modelId,
        })
        return
      }

      // 乐观更新：先切本地模型与右栏参数，再打 API（避免点选卡顿 / 串参观感）
      applyLocalModelState(modelId, contextTierId ?? session?.context_tier_id ?? null)
      useChatRuntimeStore.getState().clearCapabilityBanners(sessionId)
      pushRuntimeProfileSwitchNotices(sessionId, nextProfile, modelId, get)
      void syncModelParamsToMainProcess(sessionId, nextProfile)

      const client = getChatClient()
      const result = await client.models.switchModel(sessionId, modelId, contextTierId)

      const newTierId = result.context_tier_id ?? null
      const nextModelId = result.current_model_id || result.current_model || modelId

      applyLocalModelState(nextModelId, newTierId)
      clearSessionLocalModelPreference(sessionId)
      await syncTierToMainProcess(sessionId, newTierId)
      await syncModelParamsToMainProcess(sessionId, nextProfile)

      // 把按模型重算后的 thinking/performance 同步到服务端，避免刷新后又串回
      void client.models.updateModelParams(sessionId, nextProfile).then((resp) => {
        const persisted = retainRuntimeProfileByModelAfterServerPersist(
          retainFastOverridesAfterServerPersist(
            toRuntimeProfileV2ForTransport(resp.model_param_overrides),
            nextProfile,
          ),
          nextProfile,
        )
        access?.setSessionFields(sessionId, {
          model_param_overrides: runtimeProfileOrNull(persisted),
        })
        set((state) => ({
          modelParamSelectionsBySessionId: {
            ...state.modelParamSelectionsBySessionId,
            [sessionId]: {
              modelId: nextModelId,
              overrides: persisted,
            },
          },
        }))
        void syncModelParamsToMainProcess(sessionId, persisted)
      }).catch((error) => {
        log.warn('切模型后同步 Runtime Profile 失败（本地已按模型隔离）:', {
          sessionId,
          modelId: nextModelId,
          error,
        })
      })

      log.info('Chat 模型已切换（按模型隔离 Runtime Profile）:', {
        sessionId,
        modelId,
        contextTierId: newTierId,
      })
    } catch (error) {
      // 回滚乐观更新
      access?.setSessionFields(sessionId, {
        current_model_id: previousSnapshot.current_model_id,
        context_tier_id: previousSnapshot.context_tier_id,
        model_param_overrides: previousSnapshot.model_param_overrides,
      })
      set((state) => {
        const next = { ...state.modelParamSelectionsBySessionId }
        if (previousSnapshot.selection) {
          next[sessionId] = previousSnapshot.selection
        } else {
          delete next[sessionId]
        }
        return { modelParamSelectionsBySessionId: next }
      })
      if (
        previousSnapshot.current_model_id
        && isOpenAICodexModel(previousSnapshot.current_model_id)
      ) {
        writeSessionLocalModelPreference(sessionId, previousSnapshot.current_model_id)
      } else {
        clearSessionLocalModelPreference(sessionId)
      }
      log.error('Failed to switch model:', { sessionId, modelId, error })
      throw error
    }
  },

  switchContextTier: async (sessionId, tierId) => {
    try {
      const client = getChatClient()
      const result = await client.models.switchContextTier(sessionId, tierId)

      const newTierId = result.current_tier_id ?? null

      getChatSessionAccess()?.setSessionFields(sessionId, { context_tier_id: newTierId })

      await syncTierToMainProcess(sessionId, newTierId)

      log.info('上下文档位已切换:', { sessionId, tierId: newTierId })
    } catch (error) {
      log.error('Failed to switch context tier:', { sessionId, tierId, error })
      throw error
    }
  },

  setModelParamOverride: async (sessionId, key, value) => {
    const trimmedKey = key.trim()
    if (!trimmedKey) return
    const access = getChatSessionAccess()
    const session = access?.getSessionById(sessionId)
    const modelParamSelection = get().modelParamSelectionsBySessionId[sessionId]
    const currentModelId = (
      session?.current_model_id
      || (session as typeof session & { current_model?: string } | undefined)
        ?.current_model
      || modelParamSelection?.modelId
      || ''
    ).trim()
    const previousOverrides = runtimeProfileOrNull(
      mergeRuntimeProfileSources(
        session?.model_param_overrides,
        modelParamSelection?.overrides,
      ),
    )
    const previousSelection = modelParamSelection
      ? { ...modelParamSelection }
      : undefined

    let next = normalizeModelParamOverrides({
      ...normalizeModelParamOverrides(session?.model_param_overrides),
      ...(modelParamSelection?.overrides ?? {}),
    })
    const isCodex = isOpenAICodexModel(currentModelId)
    // Fast / thinking / performance：与按模型 map 同步（调用方应已先 switchModel）。
    const fastToggle = resolveFastToggleForModelId(get, currentModelId)
    if (fastToggle && trimmedKey === fastToggle.key) {
      next = writeFastForModel(
        next,
        currentModelId,
        isFastOnValue(value, fastToggle),
        fastToggle,
      )
    } else if (trimmedKey === 'thinking_mode') {
      next = writeThinkingForModel(next, currentModelId, value)
    } else if (trimmedKey === 'performance_profile') {
      next = writePerformanceForModel(next, currentModelId, value)
    } else if (value === null) {
      delete next[trimmedKey]
    } else if (
      typeof value === 'string'
      || typeof value === 'number'
      || typeof value === 'boolean'
    ) {
      next[trimmedKey] = value
    }
    // Codex 思考强度：清掉会被误投影的 thinking_mode，保证右栏按 effort 高亮
    if (isCodex && trimmedKey === 'reasoning_effort') {
      delete next.thinking_mode
      if (value === null) delete next.reasoning_effort
    }
    let payload = isCodex
      ? toCodexModelParamsForTransport(next)
      : toRuntimeProfileV2ForTransport(next)
    // 平台模型：reasoning_effort 升级路径也要落到当前模型 map
    if (!isCodex && currentModelId) {
      if (typeof payload.thinking_mode === 'string') {
        payload = writeThinkingForModel(
          payload,
          currentModelId,
          payload.thinking_mode,
        )
      }
      if (typeof payload.performance_profile === 'string') {
        payload = writePerformanceForModel(
          payload,
          currentModelId,
          payload.performance_profile,
        )
      }
    }
    const selectionModelId = currentModelId || modelParamSelection?.modelId || null

    const applyLocalParams = (overrides: ModelParamOverrides) => {
      access?.setSessionFields(sessionId, {
        model_param_overrides: runtimeProfileOrNull(overrides),
      })
      set((state) => ({
        modelParamSelectionsBySessionId: {
          ...state.modelParamSelectionsBySessionId,
          [sessionId]: {
            modelId: selectionModelId,
            overrides,
          },
        },
      }))
    }

    // 乐观更新：右栏立即高亮，再打 API
    applyLocalParams(payload)
    void syncModelParamsToMainProcess(sessionId, payload, { modelId: currentModelId })

    if (isCodex) {
      log.info('模型参数已切换（本机 Codex）:', { sessionId, key: trimmedKey, value })
      return
    }

    try {
      const client = getChatClient()
      const result = await client.models.updateModelParams(sessionId, payload)
      // Django 可能剥 Fast / *_by_model；客户端补回。
      const persisted = retainRuntimeProfileByModelAfterServerPersist(
        retainFastOverridesAfterServerPersist(
          toRuntimeProfileV2ForTransport(result.model_param_overrides),
          payload,
        ),
        payload,
      )
      applyLocalParams(persisted)
      await syncModelParamsToMainProcess(sessionId, persisted)
      log.info('模型参数已切换:', { sessionId, key: trimmedKey, value })
    } catch (error) {
      applyLocalParams(previousOverrides ?? {})
      set((state) => {
        const nextSelections = { ...state.modelParamSelectionsBySessionId }
        if (previousSelection) {
          nextSelections[sessionId] = previousSelection
        } else {
          delete nextSelections[sessionId]
        }
        return { modelParamSelectionsBySessionId: nextSelections }
      })
      if (previousOverrides) {
        void syncModelParamsToMainProcess(sessionId, previousOverrides)
      }
      log.error('模型参数切换失败，已回滚本地状态:', {
        sessionId,
        key: trimmedKey,
        value,
        error,
      })
      throw error
    }
  },

  getCurrentModel: () => {
    const access = getChatSessionAccess()
    const currentSessionId = access?.getCurrentSessionId() ?? null
    const { availableModels, defaultModelName, loadedOrganizationId, userDefaultModelId } = get()

    const selectedAgent = useSpaceStore.getState().selectedAgent
    const agentPreferred = selectedAgent?.preferred_model_id
    const stickyModelId = readRuntimeModelPreference(selectedAgent?.id)
    const deviceMainModelId = readCachedOrganizationDeviceModelPreferences(
      loadedOrganizationId,
    ).mainModelId
    const fallback = () => pickDefaultSendableChatModel(availableModels, {
      stickyModelId: deviceMainModelId ?? stickyModelId,
      preferredModelId: userDefaultModelId || agentPreferred,
      defaultModelName,
    })

    if (!currentSessionId) return fallback()

    const currentSession = access?.getSessionById(currentSessionId)
    const currentModelId =
      currentSession?.current_model_id
      || (currentSession as ChatSession & { current_model?: string } | undefined)?.current_model
    if (!currentSession || !currentModelId) return fallback()

    return findSendableChatModel(availableModels, currentModelId) ?? fallback()
  },

  getCurrentContextTier: () => {
    const model = get().getCurrentModel()
    const tiers = model?.context_tiers ?? []
    if (!tiers.length) return null

    const access = getChatSessionAccess()
    const currentSessionId = access?.getCurrentSessionId() ?? null
    const session = currentSessionId ? access?.getSessionById(currentSessionId) : undefined
    const explicitId = (session?.context_tier_id || '').trim()
    if (explicitId) {
      const found = tiers.find(t => t.id === explicitId)
      if (found) return found
    }
    return tiers.find(t => t.is_default) ?? tiers[0] ?? null
  },

  getCurrentModelParamOverrides: () => {
    const access = getChatSessionAccess()
    const currentSessionId = access?.getCurrentSessionId() ?? null
    const session = currentSessionId ? access?.getSessionById(currentSessionId) : undefined
    return toRuntimeProfileV2ForTransport(session?.model_param_overrides)
  },

  syncTierForActiveSession: async (sessionId) => {
    const access = getChatSessionAccess()
    const targetId = sessionId ?? access?.getCurrentSessionId() ?? null
    if (!targetId) return
    const session = access?.getSessionById(targetId)
    const tierId = (session?.context_tier_id || '').trim() || null
    await syncTierToMainProcess(targetId, tierId)
  },

  syncModelParamsForActiveSession: async (sessionId) => {
    const access = getChatSessionAccess()
    const targetId = sessionId ?? access?.getCurrentSessionId() ?? null
    if (!targetId) return
    const session = access?.getSessionById(targetId)
    const overrides = toRuntimeProfileV2ForTransport(session?.model_param_overrides)
    await syncModelParamsToMainProcess(targetId, overrides, { throwOnError: true })
  },

  reset: () => {
    _loadModelsRequestSequence += 1
    _promotionCreditRefreshSequence += 1
    _modelCatalogRefreshInFlight = null
    lastSyncedTierBySession.clear()
    lastSyncedModelParamsBySession.clear()
    set({
      availableModels: [],
      defaultModelName: null,
      userDefaultModelId: null,
      loadedOrganizationId: null,
      modelsLoadedAt: null,
      isLoadingModels: false,
      modelLoadError: null,
      modelParamSelectionsBySessionId: {},
    })
  },
}))

import { registerResetAction } from './sessionResetRegistry'
registerResetAction('chat-model', 'reset', () => useChatModelStore.getState().reset())
