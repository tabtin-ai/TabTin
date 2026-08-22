/**
 * Session lifecycle — 唯一建会话入口。
 *
 * `ensureSessionForSpace`：复用指针 /  单槽空会话 / 合并 in-flight / 否则 provision。
 * `createSession`：显式新建（仍与 ensure 共用同一 in-flight 与写指针路径）。
 *
 * quickStart 只是 HTTP transport，不再另开一套 set()/in-flight。
 *
 * 草稿预建（trigger=prefetch）走 retainDraft：只写 Space 指针，不切全局 current。
 * 单槽复用决策见 `draftSessionTargetPolicy`——禁止在「+ 新对话」路径扫历史空会话
 * 塞消息；仅草稿预建 / 首发 ensure 可 adopt message_count=0 行。
 */

import type {
  ChatSession,
  ChatMessage,
  QuickStartSessionResponse,
  GroupRuntimeConfig,
} from '@tabtin/chat-client'
import { trackChatTelemetry } from '../../execution/chatTelemetry'
import {
  buildSendTimingPayload,
  getActiveSendTimingTrace,
} from '../../execution/sendTimingTrace'
import { buildCheckpointMapFromMessages } from '../slices/sessionRuntimeState'
import { useSpaceStore } from '@stores/useSpaceStore'
import { useChatModelStore } from '../../../useChatModelStore'
import { AgentApiService, type Agent, type Space } from '@tabtin/app-shell'
import { filterSendableChatModels } from '@/utils/chatModelGuards'
import { isOpenAICodexModel } from '../../../../../../shared/openai-codex-models'
import {
  createRuntimeModelAvailabilityChecker,
  readRuntimeModelPreference,
  resolveRuntimeDefaultModelId,
  toProvisionModelId,
} from '../runtimeModelPreference'
import {
  loadOrganizationDeviceModelPreferences,
  type OrganizationDeviceModelPreferences,
} from '../organizationDeviceModelPreference'
import { getProjectExecutionSpaceId } from '@utils/projectExecutionTarget'
import { resolveChatScopeHost } from '../utils/chatSessionScope'
import {
  isLocalPendingSessionId,
  mergePendingMessagesIntoSession,
} from './pendingFirstSend'
import {
  forgetLocallySubmittedSession,
  rememberLocallySubmittedSession,
} from '../locallySubmittedSessionRegistry'
import {
  isDraftMessageActive,
} from '../draftMessage'
import {
  findBoundLocalPendingForDraftMessage,
  rehomeDraftSessionForMessage,
} from '../draftSession'
import { rehomeConversationScopeLayoutAfterProvision } from '@/services/rehomeConversationScopeLayout'
import { rehomeSessionCodeRoot } from '@/services/sessionCodeRootBinding'
import { recordSpaceSessionListMutation } from '../spaceSessionListWriteGate'
import {
  resolveReusableEmptySessionId,
  shouldRehomeShellAfterProvision,
  shouldRetainDraftOnProvision,
  shouldSyncGlobalCurrentOnProvision,
} from '../draftSessionTargetPolicy'
import { getExternalOpenedSessionIds } from '@components/onboarding/external-import/externalOpenedSessionRegistry'

// ---------------------------------------------------------------------------
// Store shape needed by session provision
// ---------------------------------------------------------------------------

export interface SessionLifecycleStore {
  currentSessionId: string | null
  draftSessionBySpaceId: Record<string, boolean>
  messagesBySessionId: Record<string, ChatMessage[]>
  sessions: ChatSession[]
  sessionsBySpaceId: Record<string, ChatSession[]>
  currentSessionIdBySpaceId: Record<string, string | null>
  checkpointsBySessionId: Record<string, Record<string, string>>
  lastContextSyncFingerprintBySessionId: Record<string, string>
}

type GetFn = () => SessionLifecycleStore
type SetFn = (
  partial:
    | Partial<SessionLifecycleStore>
    | ((state: SessionLifecycleStore) => Partial<SessionLifecycleStore>),
) => void

// ---------------------------------------------------------------------------
// Dependencies injected from useChatStore closure
// ---------------------------------------------------------------------------

export interface SessionLifecycleDeps {
  getChatClient: () => {
    sessions: {
      create: (
        spaceId: string,
        organizationId: string | undefined,
        modelId: string | undefined,
        binding: { agentId: string; workspaceId?: string | null; projectId?: string | null },
      ) => Promise<ChatSession>
      quickStart?: (
        spaceId: string,
        organizationId: string | undefined,
        modelId: string | undefined,
        initialContext: Record<string, unknown> | undefined,
        binding: { agentId: string; workspaceId?: string | null; projectId?: string | null },
      ) => Promise<QuickStartSessionResponse>
    }
  }
  resolveActiveSpaceId: () => string | null
  emptySessions: ChatSession[]
  onGroupRuntime?: (sessionId: string, groupRuntime: GroupRuntimeConfig | null | undefined) => void
}

/**
 * 同一 Space 上的建会话 in-flight（send / explicit 共用）。
 * generation-aware：invalidate/reset 后不得复用旧 generation 的 promise。
 */
interface InFlightProvisionEntry {
  generation: number
  promise: Promise<string>
}

const inFlightProvisionBySpaceId = new Map<string, InFlightProvisionEntry>()

/**
 * reset/logout/组织切换时递增；迟到的 in-flight 用启动时 generation 比对，
 * 禁止在 finally 里盲目 delete 新任务，也禁止写 pointer / 迁消息。
 */
let sessionProvisionGeneration = 0

/** ：prefetch=草稿预建；pre_send=首发；explicit=显式新建 */
export type SessionCreateTrigger = 'prefetch' | 'pre_send' | 'explicit'

/** 使所有进行中的 provision 写路径失效（reset / logout / 组织切换） */
export function invalidateSessionProvisionGeneration(): void {
  sessionProvisionGeneration += 1
}

export function waitForInFlightSessionCreate(spaceId: string): Promise<void> {
  const entry = inFlightProvisionBySpaceId.get(spaceId)
  return entry ? entry.promise.then(() => undefined) : Promise.resolve()
}

export interface EnsureSessionForSpaceOptions {
  trigger?: SessionCreateTrigger
  /** 优先走 quick-start HTTP；失败或不可用则 fallback create */
  preferQuickStart?: boolean
  contextPayload?: Record<string, unknown>
  /**
   * ：provision 启动时捕获的 DraftMessage。
   * 回包前若已 cancel/切历史，不得覆盖指针或迁 pending 消息。
   */
  expectedDraftMessageId?: string
  /**
   * 预建保留欢迎态：只落 Space 指针，不切全局 current。
   * trigger=prefetch 时默认 true。
   */
  retainDraftMessage?: boolean
}

export interface EnsureSessionForSpaceResult {
  sessionId: string
  mode: 'existing' | 'quick_start' | 'create'
  contextFingerprint?: string | null
}

/** @internal 测试用 */
export function _resetSessionProvisionLatchesForTests(): void {
  inFlightProvisionBySpaceId.clear()
  sessionProvisionGeneration = 0
}

export async function resolveAgentForSessionCreation(
  spaceId: string,
  organizationId: string,
): Promise<Agent> {
  const spaceState = useSpaceStore.getState()
  const selectedAgent = spaceState.selectedAgent
  if (
    selectedAgent?.organization_id === organizationId
    && selectedAgent.is_active !== false
  ) {
    return selectedAgent
  }

  const activeAgent = (
    await AgentApiService.listAgents(organizationId)
  ).find(agent => agent.is_active !== false) ?? null
  if (!activeAgent) {
    throw new Error('当前组织没有可用 Agent')
  }
  if (useSpaceStore.getState().selectedSpace?.id === spaceId) {
    useSpaceStore.getState().selectAgent(activeAgent)
  }
  return activeAgent
}

export function resolveWorkspaceIdForSessionCreation(
  targetSpace: Space,
  spaces: Space[],
): string {
  if (targetSpace.type !== 'team_space') {
    return targetSpace.id
  }
  const workspaceId = getProjectExecutionSpaceId(targetSpace, spaces)
  if (!workspaceId) {
    throw new Error('当前团队 Space 没有可用的成员执行现场')
  }
  return workspaceId
}

/** @internal 导出供单测验证 stale provision 行为 */
export function applyProvisionedSessionPointer(
  state: SessionLifecycleStore,
  spaceId: string,
  session: ChatSession,
  shouldSync: boolean,
  emptySessions: ChatSession[],
  options?: {
    contextFingerprint?: string | null
    clearAllFingerprintsOnSync?: boolean
    expectedDraftMessageId?: string
    retainDraftMessage?: boolean
  },
): Partial<SessionLifecycleStore> {
  const spaceSessions = state.sessionsBySpaceId[spaceId] ?? emptySessions
  const deduped = spaceSessions.filter(s => s.id !== session.id)
  const nextSpaceSessions = [session, ...deduped]

  // ：迟到回包且 draftMessage 已 cancel/切历史——只把空 session 挂进列表供 GC，
  // 绝不覆盖历史指针 / 迁 pending / rehome token。
  const expectedDraftMessageId = options?.expectedDraftMessageId
  if (expectedDraftMessageId && !isDraftMessageActive(expectedDraftMessageId)) {
    return {
      sessionsBySpaceId: {
        ...state.sessionsBySpaceId,
        [spaceId]: nextSpaceSessions,
      },
      messagesBySessionId: {
        ...state.messagesBySessionId,
        [session.id]: state.messagesBySessionId[session.id] ?? [],
      },
      checkpointsBySessionId: {
        ...state.checkpointsBySessionId,
        [session.id]: {},
      },
    }
  }

  const retainDraft = Boolean(options?.retainDraftMessage)

  let fingerprintState = state.lastContextSyncFingerprintBySessionId
  if (options?.clearAllFingerprintsOnSync && shouldSync && !retainDraft) {
    fingerprintState = {}
  } else if (options?.contextFingerprint && shouldSync && !retainDraft) {
    fingerprintState = {
      ...state.lastContextSyncFingerprintBySessionId,
      [session.id]: options.contextFingerprint,
    }
  } else if (options?.contextFingerprint && retainDraft) {
    fingerprintState = {
      ...state.lastContextSyncFingerprintBySessionId,
      [session.id]: options.contextFingerprint,
    }
  }

  // ：按 draftMessage 绑定查找 pending，禁止读全局 currentSessionId 猜测
  const pendingId = findBoundLocalPendingForDraftMessage(expectedDraftMessageId)
    ?? (
      // 无 expected 的旧路径：仅当全局 current 正是本 host 指针空窗时的 pending
      !expectedDraftMessageId && isLocalPendingSessionId(state.currentSessionId)
        ? state.currentSessionId
        : null
    )

  // ownership fail-closed：先 rehome；失败则绝不迁消息 / 写 pointer
  if (pendingId) {
    const canRehome = expectedDraftMessageId
      ? isDraftMessageActive(expectedDraftMessageId)
      : true
    if (!canRehome) {
      return {
        sessionsBySpaceId: {
          ...state.sessionsBySpaceId,
          [spaceId]: nextSpaceSessions,
        },
        messagesBySessionId: {
          ...state.messagesBySessionId,
          [session.id]: state.messagesBySessionId[session.id] ?? [],
        },
        checkpointsBySessionId: {
          ...state.checkpointsBySessionId,
          [session.id]: {},
        },
      }
    }
    const rehomed = rehomeDraftSessionForMessage(pendingId, session.id)
    if (!rehomed) {
      return {
        sessionsBySpaceId: {
          ...state.sessionsBySpaceId,
          [spaceId]: nextSpaceSessions,
        },
        messagesBySessionId: {
          ...state.messagesBySessionId,
          [session.id]: state.messagesBySessionId[session.id] ?? [],
        },
        checkpointsBySessionId: {
          ...state.checkpointsBySessionId,
          [session.id]: {},
        },
      }
    }
  }

  const nextMessagesBySessionId = pendingId
    ? mergePendingMessagesIntoSession(
        state.messagesBySessionId,
        pendingId,
        session.id,
      )
    : {
        ...state.messagesBySessionId,
        [session.id]: state.messagesBySessionId[session.id] ?? [],
      }

  const nextDraftBySpaceId = retainDraft
    ? state.draftSessionBySpaceId
    : Object.fromEntries(
        Object.entries(state.draftSessionBySpaceId).filter(([key]) => key !== spaceId),
      )

  // 预建保留欢迎态：只落 Space 指针，不把全局 current 切到空会话
  const nextGlobalCurrent = shouldSync && !retainDraft
    ? session.id
    : state.currentSessionId

  return {
    sessions: shouldSync && !retainDraft ? nextSpaceSessions : state.sessions,
    sessionsBySpaceId: {
      ...state.sessionsBySpaceId,
      [spaceId]: nextSpaceSessions,
    },
    currentSessionId: nextGlobalCurrent,
    currentSessionIdBySpaceId: {
      ...state.currentSessionIdBySpaceId,
      [spaceId]: session.id,
    },
    draftSessionBySpaceId: nextDraftBySpaceId,
    messagesBySessionId: nextMessagesBySessionId,
    checkpointsBySessionId: { ...state.checkpointsBySessionId, [session.id]: {} },
    lastContextSyncFingerprintBySessionId: fingerprintState,
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createSessionLifecycleAction(
  get: GetFn,
  set: SetFn,
  deps: SessionLifecycleDeps,
) {
  const {
    getChatClient,
    resolveActiveSpaceId,
    emptySessions,
    onGroupRuntime,
  } = deps

  const EMPTY_CHAT_SESSIONS = emptySessions

  const provisionNewSession = async (
    spaceId: string,
    organizationId: string | undefined,
    modelId: string | undefined,
    options: EnsureSessionForSpaceOptions,
  ): Promise<EnsureSessionForSpaceResult> => {
    const generationAtStart = sessionProvisionGeneration
    const { currentSessionId } = get()
    const sendTiming = getActiveSendTimingTrace()
    const trigger = options.trigger
      ?? (sendTiming ? 'pre_send' : 'explicit')
    trackChatTelemetry('session.create.start', {
      spaceId,
      organizationId,
      trigger,
      preferQuickStart: Boolean(options.preferQuickStart),
      ...buildSendTimingPayload(sendTiming),
    }, {
      counterKey: 'session.create.start',
      sessionId: currentSessionId,
    })

    // 不要在这里置 isLoading=true：产出永远是空会话，没有历史可拉。
    // ChatContent 把 isLoading && messages.length===0 映射成 MessageListSkeleton。

    const client = getChatClient()
    const spaceState = useSpaceStore.getState()
    const { space: targetSpace, currentProjectId } = resolveChatScopeHost(spaceId)
    const targetOrganizationId = organizationId ?? targetSpace?.organization_id
    if (!targetSpace) {
      throw new Error('创建会话前必须加载目标 Space')
    }
    if (!targetOrganizationId) {
      throw new Error('创建会话前必须确定 Organization')
    }
    const agent = await resolveAgentForSessionCreation(spaceId, targetOrganizationId)
    const workspaceId = resolveWorkspaceIdForSessionCreation(
      targetSpace,
      spaceState.spaces,
    )
    const binding = {
      agentId: agent.id,
      workspaceId,
      projectId: currentProjectId ?? undefined,
    }

    // 调用方未显式传 modelId 时：当前设备默认 → Agent sticky → 当前用户默认 → Agent 平台首选。
    // 本机 Codex 只作运行时对齐，Django create 仍接收平台 UUID / undefined。
    const modelState = useChatModelStore.getState()
    const sendableIds = new Set(
      filterSendableChatModels(modelState.availableModels).map(model => model.id),
    )
    const catalogHas = (id: string) => sendableIds.has(id)
    const isAvailable = createRuntimeModelAvailabilityChecker(catalogHas)
    const preferredModelId = modelState.userDefaultModelId || agent.preferred_model_id
    const devicePreferences = await loadOrganizationDeviceModelPreferences(
      targetOrganizationId,
    ).catch((): OrganizationDeviceModelPreferences => ({}))
    const availableDeviceMainModelId = devicePreferences.mainModelId
      && catalogHas(devicePreferences.mainModelId)
      ? devicePreferences.mainModelId
      : undefined
    const stickyModelId = readRuntimeModelPreference(agent.id)
    const callerModelId = (modelId || '').trim() || undefined
    const runtimeModelId = callerModelId
      ?? resolveRuntimeDefaultModelId({
        stickyModelId: availableDeviceMainModelId ?? stickyModelId,
        preferredModelId,
        isAvailable,
      })
    const provisionModelId = toProvisionModelId(runtimeModelId, {
      preferredModelId,
      isAvailable: catalogHas,
    })

    let session: ChatSession
    let mode: 'quick_start' | 'create' = 'create'
    let contextFingerprint: string | null = null
    let groupRuntime: GroupRuntimeConfig | null | undefined

    // preferQuickStart 时发送路径也可能先打 quick-start；失败则静默 fallback create，
    // 避免统一入口后 pre_send 成为首个 provisioner 时把错误直接抛给用户。
    if (options.preferQuickStart && client.sessions.quickStart) {
      try {
        const result = await client.sessions.quickStart(
          spaceId,
          targetOrganizationId,
          provisionModelId,
          options.contextPayload,
          binding,
        )
        session = result.session
        mode = 'quick_start'
        contextFingerprint = result.context_fingerprint ?? null
        groupRuntime = result.group_runtime
      } catch (error) {
        trackChatTelemetry('session.create.quick_start_fallback', {
          spaceId,
          message: error instanceof Error ? error.message : String(error),
        }, {
          counterKey: 'session.create.quick_start_fallback',
          level: 'warn',
        })
        session = await client.sessions.create(
          spaceId,
          targetOrganizationId,
          provisionModelId,
          binding,
        )
      }
    } else {
      session = await client.sessions.create(
        spaceId,
        targetOrganizationId,
        provisionModelId,
        binding,
      )
    }

    console.log('[Chat] Chat session created:', session.id, mode)

    // reset/logout 后迟到回包：返回 sessionId 但不写 store（generation guard）
    if (generationAtStart !== sessionProvisionGeneration) {
      trackChatTelemetry('session.create.stale_generation', {
        spaceId,
        sessionId: session.id,
        trigger,
      }, {
        counterKey: 'session.create.stale_generation',
        sessionId: session.id,
        level: 'warn',
      })
      return {
        sessionId: session.id,
        mode,
        contextFingerprint,
      }
    }

    const expectedDraftMessageId = options.expectedDraftMessageId
    const retainDraft = shouldRetainDraftOnProvision({
      trigger,
      retainDraftMessage: options.retainDraftMessage,
    })
    // 布局第二跳的源：applyProvisionedSessionPointer 会把 draftMessage 绑定 rehome 到
    // 真 session 并解绑 local-pending，须在写指针前捕获
    const boundPendingSessionId = findBoundLocalPendingForDraftMessage(expectedDraftMessageId)

    // ：建会话写桶前 bump epoch，作废飞行中的陈旧 list。
    recordSpaceSessionListMutation(spaceId, 'createSession')
    set(state => {
      // retainDraft：仍要写 Space 指针与 sessionsBySpaceId；全局 current 在 apply 内抑制
      const applyShouldSync = retainDraft
        ? true
        : shouldSyncGlobalCurrentOnProvision({
            trigger,
            isActiveSpace: resolveActiveSpaceId() === spaceId,
            retainDraft: false,
          })
      return applyProvisionedSessionPointer(
        state,
        spaceId,
        session,
        applyShouldSync,
        EMPTY_CHAT_SESSIONS,
        {
          expectedDraftMessageId,
          retainDraftMessage: retainDraft,
          ...(mode === 'quick_start'
            ? { contextFingerprint }
            : { clearAllFingerprintsOnSync: true }),
        },
      )
    })

    // 预建 retain：shell 仍停草稿，延后到首发再 rehome
    if (shouldRehomeShellAfterProvision(retainDraft)) {
      rehomeConversationScopeLayoutAfterProvision({
        spaceId,
        sessionId: session.id,
        expectedDraftMessageId,
        pendingSessionId: boundPendingSessionId,
      })
    }

    // ：pending → 真 session 时迁移侧栏保活登记，避免仍挂 local-pending id
    if (boundPendingSessionId) {
      rememberLocallySubmittedSession(session.id)
      forgetLocallySubmittedSession(boundPendingSessionId)
      // 会话代码根：草稿内存绑定原子迁到真 session 并落盘，避免遗留 local-pending-* 键。
      // 须 await：否则首轮 query 可能仍按旧 draft key 查根，跑到 Space.working_dir。
      await rehomeSessionCodeRoot(boundPendingSessionId, session.id)
    }

    if (groupRuntime !== undefined) {
      onGroupRuntime?.(session.id, groupRuntime)
    }

    trackChatTelemetry('session.create.done', {
      mode: 'chat',
      sessionId: session.id,
      spaceId,
      trigger,
      provisionMode: mode,
      ...buildSendTimingPayload(sendTiming),
    }, {
      counterKey: 'session.create.done',
      sessionId: session.id,
    })

    // create/quickStart 只能落平台 UUID。prefetch / ensure 常把「Codex sticky 的平台回退」
    // 当作 modelId 传入；此时仍要对齐到 sticky。若 caller 显式传了别的平台模型（草稿已选），不要覆盖。
    // 设备默认 / sticky 在 await create 之后重读：等待期间用户可能改过设置或切模。
    const storedLatestDeviceMainModelId = (
      await loadOrganizationDeviceModelPreferences(targetOrganizationId).catch(
        (): OrganizationDeviceModelPreferences => ({}),
      )
    ).mainModelId
    const latestDeviceMainModelId = storedLatestDeviceMainModelId
      && catalogHas(storedLatestDeviceMainModelId)
      ? storedLatestDeviceMainModelId
      : undefined
    const latestStickyModelId = readRuntimeModelPreference(agent.id)
    const latestLocalTargetModelId = latestDeviceMainModelId ?? latestStickyModelId
    const localProvisionFallback = latestLocalTargetModelId && isOpenAICodexModel(latestLocalTargetModelId)
      ? toProvisionModelId(latestLocalTargetModelId, {
          preferredModelId,
          isAvailable: catalogHas,
        })
      : undefined
    const shouldAlignStickyCodex = Boolean(
      latestLocalTargetModelId
      && isOpenAICodexModel(latestLocalTargetModelId)
      && session.current_model_id !== latestLocalTargetModelId
      && (
        !callerModelId
        || callerModelId === latestLocalTargetModelId
        || callerModelId === localProvisionFallback
      ),
    )
    if (shouldAlignStickyCodex && latestLocalTargetModelId) {
      await useChatModelStore.getState().switchModel(session.id, latestLocalTargetModelId).catch((error) => {
        console.warn('[Chat] Failed to align local runtime model after create:', error)
      })
    }

    return {
      sessionId: session.id,
      mode,
      contextFingerprint,
    }
  }

  const runTrackedProvision = async (
    spaceId: string,
    run: () => Promise<EnsureSessionForSpaceResult>,
  ): Promise<EnsureSessionForSpaceResult> => {
    const generationAtStart = sessionProvisionGeneration
    const existing = inFlightProvisionBySpaceId.get(spaceId)
    // 仅同 generation 的 in-flight 可复用；invalidate/reset 后必须新开 provision
    if (existing && existing.generation === generationAtStart) {
      const sessionId = await existing.promise
      return {
        sessionId,
        mode: 'existing',
        contextFingerprint: get().lastContextSyncFingerprintBySessionId[sessionId] ?? null,
      }
    }

    let provisionResult: EnsureSessionForSpaceResult | null = null
    const trackedTask = (async () => {
      try {
        provisionResult = await run()
        return provisionResult.sessionId
      } catch (error) {
        console.error('[Chat] Failed to create session:', error)
        trackChatTelemetry('session.create.failed', {
          spaceId,
          message: error instanceof Error ? error.message : String(error),
        }, {
          counterKey: 'session.create.failed',
          level: 'error',
        })
        throw error
      }
    })()

    const entry: InFlightProvisionEntry = {
      generation: generationAtStart,
      promise: trackedTask,
    }
    inFlightProvisionBySpaceId.set(spaceId, entry)
    try {
      const sessionId = await trackedTask
      return provisionResult ?? {
        sessionId,
        mode: 'existing',
        contextFingerprint: get().lastContextSyncFingerprintBySessionId[sessionId] ?? null,
      }
    } finally {
      // entry identity guard：旧 finally 不得删掉新 generation 的 entry
      if (inFlightProvisionBySpaceId.get(spaceId) === entry) {
        inFlightProvisionBySpaceId.delete(spaceId)
      }
    }
  }

  const adoptReusableEmptySession = (
    spaceId: string,
    sessionId: string,
    options: EnsureSessionForSpaceOptions,
  ): EnsureSessionForSpaceResult => {
    const state = get()
    const session = (state.sessionsBySpaceId[spaceId] ?? EMPTY_CHAT_SESSIONS)
      .find((item) => item.id === sessionId)
    if (!session) {
      return {
        sessionId,
        mode: 'existing',
        contextFingerprint: state.lastContextSyncFingerprintBySessionId[sessionId] ?? null,
      }
    }
    const trigger = options.trigger ?? 'pre_send'
    const retainDraft = shouldRetainDraftOnProvision({
      trigger,
      retainDraftMessage: options.retainDraftMessage,
    })
    const boundPendingSessionId = findBoundLocalPendingForDraftMessage(options.expectedDraftMessageId)
    set((prev) => applyProvisionedSessionPointer(
      prev,
      spaceId,
      session,
      retainDraft
        ? true
        : shouldSyncGlobalCurrentOnProvision({
            trigger,
            isActiveSpace: resolveActiveSpaceId() === spaceId,
            retainDraft: false,
          }),
      EMPTY_CHAT_SESSIONS,
      {
        expectedDraftMessageId: options.expectedDraftMessageId,
        retainDraftMessage: retainDraft,
      },
    ))
    if (shouldRehomeShellAfterProvision(retainDraft)) {
      rehomeConversationScopeLayoutAfterProvision({
        spaceId,
        sessionId,
        expectedDraftMessageId: options.expectedDraftMessageId,
        pendingSessionId: boundPendingSessionId,
      })
    }
    if (boundPendingSessionId) {
      // adopt 路径同步返回；rehome 失败不影响指针，但尽量立刻迁完供下一轮 query。
      void rehomeSessionCodeRoot(boundPendingSessionId, sessionId)
    }
    return {
      sessionId,
      mode: 'existing',
      contextFingerprint: get().lastContextSyncFingerprintBySessionId[sessionId] ?? null,
    }
  }

  const ensureSessionForSpace = async (
    spaceId: string,
    organizationId?: string,
    modelId?: string,
    options: EnsureSessionForSpaceOptions = {},
  ): Promise<EnsureSessionForSpaceResult> => {
    const existingId = get().currentSessionIdBySpaceId[spaceId]
    if (existingId) {
      return {
        sessionId: existingId,
        mode: 'existing',
        contextFingerprint: get().lastContextSyncFingerprintBySessionId[existingId] ?? null,
      }
    }

    //  单槽：草稿预建 / 首发 ensure 可复用未使用空会话，禁止连点堆空行
    const trigger = options.trigger ?? 'pre_send'
    if (trigger === 'prefetch' || trigger === 'pre_send') {
      const state = get()
      const spaceSessions = state.sessionsBySpaceId[spaceId] ?? EMPTY_CHAT_SESSIONS
      // 外部档案展开会话服务端 message_count 常为 0，且可能已有本机注入消息——
      // 绝不能被草稿预热 adopt，否则「新任务」会被瞬间拉回外来历史。
      const excludeSessionIds = new Set(getExternalOpenedSessionIds())
      for (const session of spaceSessions) {
        if ((state.messagesBySessionId[session.id]?.length ?? 0) > 0) {
          excludeSessionIds.add(session.id)
        }
      }
      const reusableId = resolveReusableEmptySessionId(spaceSessions, {
        excludeSessionIds,
      })
      if (reusableId) {
        return adoptReusableEmptySession(spaceId, reusableId, options)
      }
    }

    return runTrackedProvision(spaceId, () =>
      provisionNewSession(spaceId, organizationId, modelId, options),
    )
  }

  return {
    /**
     * 首发发送 / 显式新建：复用指针或合并 in-flight，保证同一 Space 只 provision 一次。
     */
    ensureSessionForSpace,

    /**
     * 显式新建会话。若同 Space 已有 in-flight（含预建），则等待并复用，避免双写指针。
     * 无 in-flight 且无当前指针时新建；若指针已存在则再新建一行并覆盖指针
     * （保持历史「+ 新对话」显式 create 语义）。
     */
    createSession: async (
      spaceId: string,
      organizationId?: string,
      modelId?: string,
      lifecycleOptions?: { trigger?: SessionCreateTrigger },
    ) => {
      const generationNow = sessionProvisionGeneration
      const existing = inFlightProvisionBySpaceId.get(spaceId)
      if (existing && existing.generation === generationNow) {
        await existing.promise
        return
      }

      if (!get().currentSessionIdBySpaceId[spaceId]) {
        await ensureSessionForSpace(spaceId, organizationId, modelId, {
          trigger: lifecycleOptions?.trigger,
          preferQuickStart: false,
        })
        return
      }

      await runTrackedProvision(spaceId, () =>
        provisionNewSession(spaceId, organizationId, modelId, {
          trigger: lifecycleOptions?.trigger,
          preferQuickStart: false,
        }),
      )
    },
  }
}
