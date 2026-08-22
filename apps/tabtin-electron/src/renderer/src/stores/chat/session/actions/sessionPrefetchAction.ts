/**
 * Draft-session prefetch— 触发预建真 session + 预热 runtime / LLM。
 *
 * 决策集中在 `draftSessionTargetPolicy`：
 * - 每 Space 单槽复用未使用空会话（不堆  空行）
 * - 无空槽才 ensureSession(trigger=prefetch, retainDraft)
 * - 保留欢迎态：只写 Space 指针，不切全局 current
 *
 * warm-only（无 create）已不足以消除首发 local-pending 两跳；本文件恢复预建，
 * 并用单槽保住「连点新任务不新增堆积」。
 */

import { useSpaceStore } from '@stores/useSpaceStore'
import { useOrganizationStore } from '@stores/useOrganizationStore'
import { useMemoRecordStyleStore } from '@stores/useMemoRecordStyleStore'
import { useChatModelStore } from '../../../useChatModelStore'
import { useChatStore } from '../../useChatStore'
import { apiService } from '@/services/api'
import { trackChatTelemetry } from '../../execution/chatTelemetry'
import { prepareRuntimeDispatchContext } from '../../execution/runtimeDispatchPrep'
import { captureEnabledAppsForSend } from '../../execution/captureEnabledAppsForSend'
import { resolveSendAgentPolicy } from '../resolveSendAgentPolicy'
import { ensureGroupRuntimeSynced } from '../../group/groupRuntimeSessionSync'
import {
  getDraftMessageByScopeKey,
  isDraftMessageActive,
  peekDraftAgentIntent,
  peekDraftContextTierIntent,
  peekDraftModelIntent,
  peekDraftModelParamOverrides,
} from '../draftMessage'
import {
  reapplyDraftModeAfterPrefetchSeed,
  syncDraftAgentIntent,
} from '../draftMessageSessionCoordinator'
import { bindDraftSessionToMessage } from '../draftSession'
import {
  legacyHiddenDraftSessionId,
  resolveConversationDraftScopeKey,
} from '../draftMessageLegacyAdapter'
import { resolveChatScopeHost } from '../utils/chatSessionScope'
import { decideDraftSessionPrefetch } from '../draftSessionTargetPolicy'
import { getExternalOpenedSessionIds } from '@components/onboarding/external-import/externalOpenedSessionRegistry'
import { getDraftSession, registerDraftSession, releaseDraftSession } from '../draftSession'
import { registerProvisionalSessionWithHost } from '../provisionalSessionHost'
import type {
  EnsureSessionForSpaceOptions,
  EnsureSessionForSpaceResult,
  SessionCreateTrigger,
} from './sessionLifecycleAction'

export interface SessionPrefetchStore {
  currentSessionIdBySpaceId: Record<string, string | null>
  draftSessionBySpaceId: Record<string, boolean>
  sessionsBySpaceId: Record<string, Array<{
    id: string
    message_count?: number | null
    status?: string | null
  }> | undefined>
  /** 本地气泡：message_count 未回写时仍视为已使用，禁止单槽复用 */
  messagesBySessionId?: Record<string, unknown[] | undefined>
  /** ：预建过期时清空会话 */
  discardAbandonedEmptySessions: (input: {
    sessionIds: readonly string[]
    reason: 'draft_cancel' | 'prefetch_stale'
    draftSessionPhase?: 'open' | 'sending' | null
    sessionSpaceById?: Record<string, string | undefined>
  }) => void
}

type GetFn = () => SessionPrefetchStore

export interface SessionPrefetchDeps {
  ensureSessionForSpace: (
    spaceId: string,
    organizationId?: string,
    modelId?: string,
    options?: EnsureSessionForSpaceOptions,
  ) => Promise<EnsureSessionForSpaceResult>
  syncContext: (
    spaceId?: string | null,
    appType?: string | null,
    appMeta?: Record<string, unknown> | null,
    openTabs?: Array<{
      type: string
      id: string
      title?: string
      active?: boolean
      group_id?: string
      app_key?: string
      display_name?: string
      is_home?: boolean
      [key: string]: unknown
    }> | null,
    options?: {
      force?: boolean
      tabScopeKey?: string | null
      workspaceScopeKey?: string | null
    },
  ) => Promise<void>
  /** ：prefetch 后对账草稿 Agent；缺省则跳过 Agent 对账 */
  updateSessionInCaches?: (
    sessionId: string,
    patch: { id: string; agent_id?: string | null },
  ) => void
  patchSessionAgent?: (
    sessionId: string,
    agentId: string,
  ) => Promise<{ id: string; agent_id?: string | null }>
}

export interface PrefetchSessionForDraftParams {
  spaceId: string
  /** 草稿 UI 旗标 Space（host A）；缺省用 spaceId（A=B） */
  draftUiSpaceId?: string | null
  organizationId: string
  modelId?: string
  contextType?: string | null
  appMeta?: Record<string, unknown> | null
  openTabs?: Array<{
    type: string
    id: string
    title?: string
    active?: boolean
    group_id?: string
    app_key?: string
    display_name?: string
    is_home?: boolean
    [key: string]: unknown
  }> | null
  /** Composer 显式 opaque draft scope；优先于 legacy host */
  tabScopeKey?: string | null
}

/**
 * 每个 DraftMessage 只允许预建一次真实 session（ /  单槽）。
 *
 * 关历史 Tab / 切宿主时若仍停在 draft && current=null，effect 会重跑。
 * 闩锁在 startDraft 开启新 draftMessage 时清掉；deleteSession 不得清它。
 * reset/logout 用 clearAllDraftPrefetchLatches。
 */
const draftPrefetchDoneBySpaceId = new Set<string>()

/** 开启新的 DraftMessage：允许下一次 prefetch。 */
export function resetDraftPrefetchMessage(spaceId: string): void {
  draftPrefetchDoneBySpaceId.delete(spaceId)
}

export function isDraftPrefetchDone(spaceId: string): boolean {
  return draftPrefetchDoneBySpaceId.has(spaceId)
}

/** reset / logout：清全部 prefetch 闩锁 */
export function clearAllDraftPrefetchLatches(): void {
  draftPrefetchDoneBySpaceId.clear()
}

/** @internal 测试用 */
export function _resetDraftPrefetchLatchesForTests(): void {
  clearAllDraftPrefetchLatches()
}

/** @internal 测试用：标记 prefetch 已完成 */
export function _markDraftPrefetchDoneForTests(spaceId: string): void {
  draftPrefetchDoneBySpaceId.add(spaceId)
}

async function warmRuntimeDispatchForSession(sessionId: string, spaceId: string): Promise<void> {
  try {
    const currentAgent = useSpaceStore.getState().selectedAgent
    await prepareRuntimeDispatchContext({
      sessionId,
      spaceId,
      currentAgent,
    })
    const warmModel = useChatModelStore.getState().getCurrentModel()
    const warmModelId = warmModel?.id
    if (warmModelId) {
      void apiService.warmupLlmConnection(warmModelId).catch(() => { /* best effort */ })
    }
    //  C3：草稿 session 预 acquire Runtime（与首发同 cache key 字段）。
    // fire-and-forget：失败不阻断 prefetch；首发仍可冷建。
    void prewarmHostRuntimeForDraftSession({
      sessionId,
      spaceId,
      currentAgent,
      warmModel,
    }).catch(() => { /* logged inside */ })
    trackChatTelemetry('session.prefetch.runtime_warm.done', {
      spaceId,
      sessionId,
    }, {
      counterKey: 'session.prefetch.runtime_warm.done',
      sessionId,
    })
  } catch (error) {
    trackChatTelemetry('session.prefetch.runtime_warm.failed', {
      spaceId,
      sessionId,
      message: error instanceof Error ? error.message : String(error),
    }, {
      counterKey: 'session.prefetch.runtime_warm.failed',
      sessionId,
      level: 'warn',
    })
  }
}

/** 与 send 路径 getCapabilityOverride(shell, operation_switches) 对齐的轻量读取。 */
function readShellOperationSwitches(
  agentConfig: unknown,
): Record<string, 'allow' | 'confirm' | 'block'> | undefined {
  if (!agentConfig || typeof agentConfig !== 'object') return undefined
  const raw = (agentConfig as {
    capabilities?: { overrides?: { shell?: { operation_switches?: unknown } } }
  }).capabilities?.overrides?.shell?.operation_switches
  if (!raw || typeof raw !== 'object') return undefined
  const entries = Object.entries(raw as Record<string, unknown>).filter(
    (entry): entry is [string, 'allow' | 'confirm' | 'block'] =>
      entry[1] === 'allow' || entry[1] === 'confirm' || entry[1] === 'block',
  )
  return entries.length > 0 ? Object.fromEntries(entries) : undefined
}

/**
 *  阶段 C：拼装与首发同构的 cache key 字段，经 IPC 预 acquire Runtime。
 * 缺 identity / preload API 时静默跳过（不假成功）。
 */
async function prewarmHostRuntimeForDraftSession(args: {
  sessionId: string
  spaceId: string
  currentAgent: { id?: string; agent_config?: unknown; working_dir_type?: string | null } | null | undefined
  warmModel: {
    id?: string
    context_window_tokens?: number
    max_output_tokens?: number
    supports_vision?: boolean
    supports_function_calling?: boolean
    capabilities_config?: Record<string, unknown>
    provider?: string
    provider_scope?: string | null
    resolved_capabilities?: {
      supports_vision?: boolean
      supports_function_calling?: boolean
    }
  } | null | undefined
}): Promise<void> {
  const { sessionId, spaceId, currentAgent, warmModel } = args
  const prewarmApi = window.tabtin?.agentEngine?.prewarmRuntime
  if (typeof prewarmApi !== 'function') return
  const agentId = currentAgent?.id?.trim()
  const modelId = warmModel?.id?.trim()
  const organizationId = useOrganizationStore.getState().selectedOrganization?.id?.trim()
  if (!agentId || !modelId || !organizationId) return

  const spaceStore = useSpaceStore.getState()
  const runtimeSpace = (spaceStore.spaces ?? []).find((s) => s.id === spaceId) as
    | { id: string; working_dir?: string | null; name?: string | null }
    | undefined
  const workingDir = runtimeSpace?.working_dir?.trim() || undefined
  const rawWorkingDirType = currentAgent?.working_dir_type
  const workingDirType =
    rawWorkingDirType === 'code' || rawWorkingDirType === 'doc' || rawWorkingDirType === 'mixed'
      ? rawWorkingDirType
      : undefined
  const operationSwitches = readShellOperationSwitches(currentAgent?.agent_config)
  const chatState = useChatStore.getState()
  const policy = resolveSendAgentPolicy(sessionId, {
    agentMode: chatState.agentMode,
    approvalModeBySessionId: chatState.approvalModeBySessionId,
  })
  const enabledApps = captureEnabledAppsForSend(spaceId, {
    warn: (...msg) => {
      trackChatTelemetry('session.prefetch.runtime_prewarm.enabled_apps_skip', {
        spaceId,
        sessionId,
        detail: msg.map(String).join(' '),
      }, {
        counterKey: 'session.prefetch.runtime_prewarm.enabled_apps_skip',
        sessionId,
        level: 'warn',
      })
    },
  })
  const org = useOrganizationStore.getState().selectedOrganization
  const providerScope = warmModel?.provider_scope
  const result = await prewarmApi({
    threadId: sessionId,
    workspaceId: spaceId,
    spaceId,
    organizationId,
    agentId,
    modelId,
    agentMode: policy.currentAgentMode,
    approvalMode: policy.currentApprovalMode,
    workingDir,
    workingDirType,
    enabledApps: enabledApps.length > 0 ? enabledApps : undefined,
    operationSwitches,
    memoryCapability: useMemoRecordStyleStore.getState().isEnabled(organizationId) || undefined,
    modelContextWindow: warmModel?.context_window_tokens,
    modelMaxOutput: warmModel?.max_output_tokens,
    modelSupportsVision: warmModel?.supports_vision
      ?? warmModel?.resolved_capabilities?.supports_vision
      ?? (warmModel?.capabilities_config as { supports_vision?: boolean } | undefined)?.supports_vision,
    modelSupportsFunctionCalling: warmModel?.supports_function_calling
      ?? warmModel?.resolved_capabilities?.supports_function_calling
      ?? (warmModel?.capabilities_config as { supports_function_calling?: boolean } | undefined)
        ?.supports_function_calling,
    modelCapabilitiesConfig: warmModel?.capabilities_config,
    modelProvider: warmModel?.provider,
    isByokMode: providerScope != null && providerScope !== 'global',
    spaceName: runtimeSpace?.name ?? undefined,
    organizationName: org?.name ?? undefined,
    isGroupSpace: policy.resolutionContext.isGroupSpace,
  })
  trackChatTelemetry(
    result.success
      ? 'session.prefetch.runtime_prewarm.done'
      : 'session.prefetch.runtime_prewarm.failed',
    {
      spaceId,
      sessionId,
      success: result.success,
      error: result.error,
    },
    {
      counterKey: result.success
        ? 'session.prefetch.runtime_prewarm.done'
        : 'session.prefetch.runtime_prewarm.failed',
      sessionId,
      level: result.success ? undefined : 'warn',
    },
  )
}

async function reapplyDraftModelAndTierAfterPrefetch(
  draftScopeKey: string,
  sessionId: string,
): Promise<void> {
  const modelIntent = peekDraftModelIntent(draftScopeKey)
  if (!modelIntent) return
  const tierIntent = peekDraftContextTierIntent(draftScopeKey)
  try {
    if (tierIntent) {
      await useChatModelStore.getState().switchModel(sessionId, modelIntent, tierIntent)
    } else {
      await useChatModelStore.getState().switchModel(sessionId, modelIntent)
    }
    const overrides = peekDraftModelParamOverrides(draftScopeKey) ?? {}
    for (const [key, value] of Object.entries(overrides)) {
      await useChatModelStore.getState().setModelParamOverride(sessionId, key, value)
    }
  } catch {
    // fail-soft：不阻断预建主路径；正式发送前还会再同步一次。
  }
}

function reapplyDraftAgentAfterPrefetch(
  draftScopeKey: string,
  sessionId: string,
  deps: Pick<SessionPrefetchDeps, 'updateSessionInCaches' | 'patchSessionAgent'>,
): void {
  const agentIntent = peekDraftAgentIntent(draftScopeKey)
  if (!agentIntent || !deps.updateSessionInCaches || !deps.patchSessionAgent) return
  void syncDraftAgentIntent(
    agentIntent,
    {
      draftScopeKey,
      isUiDraft: true,
      hiddenSessionId: sessionId,
    },
    {
      updateSessionInCaches: deps.updateSessionInCaches,
      patchSessionAgent: deps.patchSessionAgent,
      canMutatePrefetchedSession: () => true,
    },
  ).catch(() => { /* fail-soft：不阻断预建主路径 */ })
}

export function createSessionPrefetchAction(
  get: GetFn,
  deps: SessionPrefetchDeps,
) {
  const { ensureSessionForSpace, syncContext } = deps

  const prefetchSessionForDraft = async (params: PrefetchSessionForDraftParams): Promise<void> => {
    const { spaceId, organizationId, modelId, contextType, appMeta, openTabs, tabScopeKey } = params
    const draftUiSpaceId = params.draftUiSpaceId || spaceId

    const capturedDraftScopeKey = resolveConversationDraftScopeKey({
      tabScopeKey,
      legacyExecutionHostId: spaceId,
    })
    if (!capturedDraftScopeKey) return
    const capturedDraftMessage = getDraftMessageByScopeKey(capturedDraftScopeKey)
    const capturedExpectedDraftMessageId = capturedDraftMessage?.draftMessageId
    if (!capturedExpectedDraftMessageId) {
      return
    }

    const state = get()
    const hasLocalMessages = (sessionId: string | null | undefined): boolean => (
      Boolean(sessionId && (state.messagesBySessionId?.[sessionId]?.length ?? 0) > 0)
    )
    const rawPointer = state.currentSessionIdBySpaceId[spaceId] ?? null
    // 刚首发过的会话可能 message_count 尚未回写；有本地气泡则不算空槽
    const spacePointer = hasLocalMessages(rawPointer) ? null : rawPointer
    const spaceSessions = (state.sessionsBySpaceId[spaceId] ?? []).filter(
      (session) => (
        !hasLocalMessages(session.id)
        && getDraftSession(session.id)?.status !== 'released'
      ),
    )
    const decision = decideDraftSessionPrefetch({
      isDraftUi: Boolean(
        state.draftSessionBySpaceId[draftUiSpaceId]
        || state.draftSessionBySpaceId[spaceId],
      ),
      hasActiveDraftMessage: isDraftMessageActive(capturedExpectedDraftMessageId),
      prefetchLatchDone: draftPrefetchDoneBySpaceId.has(spaceId),
      spacePointer,
      spaceSessions,
      excludeSessionIds: getExternalOpenedSessionIds(),
    })

    if (decision.action === 'skip') {
      return
    }

    // ：reuse_pointer 若 bind 失败（foreign 占用且不可回收）不得 latch，改走 create
    let prefetchDecision: 'reuse_pointer' | 'reuse_empty' | 'create' =
      decision.action === 'reuse_empty' ? 'reuse_empty' : 'create'

    if (decision.action === 'reuse_pointer') {
      await registerProvisionalSessionWithHost(decision.sessionId)
      const boundPointer = bindDraftSessionToMessage(capturedDraftScopeKey, decision.sessionId, {
        draftMessageId: capturedExpectedDraftMessageId,
        reclaimFromOpenDraftMessage: true,
      })
      if (boundPointer) {
        draftPrefetchDoneBySpaceId.add(spaceId)
        reapplyDraftModeAfterPrefetchSeed(capturedDraftScopeKey, decision.sessionId, {
          expectedHiddenSessionId: decision.sessionId,
        })
        // ：预建复用指针后对账草稿 Mode/Model/Tier/Agent
        await reapplyDraftModelAndTierAfterPrefetch(
          capturedDraftScopeKey,
          decision.sessionId,
        )
        reapplyDraftAgentAfterPrefetch(capturedDraftScopeKey, decision.sessionId, deps)
        await warmRuntimeDispatchForSession(decision.sessionId, spaceId)
        trackChatTelemetry('session.prefetch.done', {
          spaceId,
          sessionId: decision.sessionId,
          mode: 'reuse_pointer',
          draftScopeKey: capturedDraftScopeKey,
          expectedDraftMessageId: capturedExpectedDraftMessageId,
        }, {
          counterKey: 'session.prefetch.done',
          sessionId: decision.sessionId,
        })
        return
      }
      trackChatTelemetry('session.prefetch.bind_conflict', {
        spaceId,
        sessionId: decision.sessionId,
        draftScopeKey: capturedDraftScopeKey,
        expectedDraftMessageId: capturedExpectedDraftMessageId,
        mode: 'reuse_pointer',
      }, {
        counterKey: 'session.prefetch.bind_conflict',
        sessionId: decision.sessionId,
        level: 'warn',
      })
      prefetchDecision = 'create'
    }

    trackChatTelemetry('session.prefetch.start', {
      spaceId,
      draftScopeKey: capturedDraftScopeKey,
      expectedDraftMessageId: capturedExpectedDraftMessageId,
      decision: prefetchDecision,
    }, {
      counterKey: 'session.prefetch.start',
    })

    try {
      const trigger: SessionCreateTrigger = 'prefetch'
      const { currentProjectId } = resolveChatScopeHost(spaceId)
      const provisioned = await ensureSessionForSpace(spaceId, organizationId, modelId, {
        trigger,
        preferQuickStart: true,
        retainDraftMessage: true,
        expectedDraftMessageId: capturedExpectedDraftMessageId,
        contextPayload: {
          current_space_id: currentProjectId ? null : spaceId,
          current_project_id: currentProjectId,
          current_app_type: contextType ?? null,
          open_tabs: Array.isArray(openTabs) ? openTabs : [],
          ...(appMeta ?? {}),
        },
      })

      const sessionId = provisioned.sessionId
      if (!sessionId) return
      await registerProvisionalSessionWithHost(sessionId)

      if (!isDraftMessageActive(capturedExpectedDraftMessageId)) {
        trackChatTelemetry('session.prefetch.stale_episode', {
          spaceId,
          sessionId,
          expectedDraftMessageId: capturedExpectedDraftMessageId,
          draftScopeKey: capturedDraftScopeKey,
        }, {
          counterKey: 'session.prefetch.stale_episode',
          sessionId,
          level: 'warn',
        })
        // 只有能证明来自已结束 DraftMessage 的预建 session 才允许释放并清理。
        if (!capturedExpectedDraftMessageId) return
        registerDraftSession({
          sessionId,
          draftMessageId: capturedExpectedDraftMessageId,
          draftScopeKey: capturedDraftScopeKey,
        })
        releaseDraftSession(sessionId)
        get().discardAbandonedEmptySessions({
          sessionIds: [sessionId],
          reason: 'prefetch_stale',
          sessionSpaceById: { [sessionId]: spaceId },
        })
        return
      }

      draftPrefetchDoneBySpaceId.add(spaceId)
      await ensureGroupRuntimeSynced(sessionId)

      const pointers = get()
      const expectedHidden = legacyHiddenDraftSessionId(spaceId, pointers)
      const bound = bindDraftSessionToMessage(capturedDraftScopeKey, sessionId, {
        draftMessageId: capturedExpectedDraftMessageId,
        reclaimFromOpenDraftMessage: true,
      })
      if (bound) {
        reapplyDraftModeAfterPrefetchSeed(capturedDraftScopeKey, sessionId, {
          expectedHiddenSessionId: expectedHidden ?? sessionId,
        })
        // ：预建完成后对账草稿 UI 已选 Model/Tier/Agent（可能比 create 时更新）
        await reapplyDraftModelAndTierAfterPrefetch(
          capturedDraftScopeKey,
          sessionId,
        )
        reapplyDraftAgentAfterPrefetch(capturedDraftScopeKey, sessionId, deps)
      }

      if (!provisioned.contextFingerprint) {
        await syncContext(spaceId, contextType, appMeta, openTabs, {
          force: true,
          tabScopeKey: tabScopeKey ?? `conversation:${sessionId}`,
          workspaceScopeKey: tabScopeKey ?? `conversation:${sessionId}`,
        })
      }

      trackChatTelemetry('session.prefetch.done', {
        spaceId,
        sessionId,
        mode: prefetchDecision === 'reuse_empty'
          ? 'reuse_empty'
          : provisioned.mode === 'quick_start'
            ? 'quick_start'
            : 'create',
        draftScopeKey: capturedDraftScopeKey,
        expectedDraftMessageId: capturedExpectedDraftMessageId,
      }, {
        counterKey: 'session.prefetch.done',
        sessionId,
      })
      await warmRuntimeDispatchForSession(sessionId, spaceId)
    } catch (error) {
      trackChatTelemetry('session.prefetch.failed', {
        spaceId,
        message: error instanceof Error ? error.message : String(error),
      }, {
        counterKey: 'session.prefetch.failed',
        level: 'error',
      })
    }
  }

  return { prefetchSessionForDraft }
}
