/**
 * HITL stream handlers — shared between active send IPC path and background
 * push bridge (`useLocalPushStreamBridge` → `streamMessageHandler`).
 *
 * Root cause fix : `approval_requested` was only handled inside
 * `sendMessageAction.onMessage`; background / push turns never set
 * `pendingApprovalBySessionId`, so ApprovalPanel never rendered.
 */

import type { ReviewRequiredEventData } from '@tabtin/chat-client'
import { AskInteractionRequestSchema, StreamEvents } from '@tabtin/agent-wire'
import i18n from '@/i18n'
import { createLogger } from '@/utils/logger'
import { SystemNotification } from '@/services/systemNotification'
import type {
  ApprovalRequestState,
  AskUserRequestState,
  AskUserRequestStateApproval,
  AskUserRequestStateBase,
  AskUserRequestStateChoice,
  AskUserRequestStateForm,
} from '../../shared/types'
import { getChatStoreCallbacks, getHitlStoreAccess } from '../../shared/storeAccessRegistry'
import type { AgentStreamMessage } from '../../stream/handlers/streamHandlerTypes'
import { useAuthStore } from '@stores/useAuthStore'

const log = createLogger('E2E:Hitl')

// ── HITL 已解决墓碑（ review 追加：审批打开的重放复活兜底）────────────────
//
// 团队成员看审批的唯一实时通道是可重放的观察镜像流（无 owner 专属 user event），
// 无法像 ask 那样把“打开”迁到不可重放的权威 user event。为满足“已解决后重放不复活”，
// 在所有权威 resolved 信号（approval_resolved 可靠广播 / interaction_resolved·expired
// user event / sync 权威对账清除）落点记一条 per-session 墓碑；审批“打开”前查墓碑，
// 已解决的 batch/request key 拒绝重开。key（batch_id / request_id）每次交互唯一生成，
// 合法新交互不会撞墓碑，不会误挡。
const HITL_RESOLVED_TOMBSTONE_MAX_PER_SESSION = 50
const resolvedTombstoneBySession = new Map<string, Set<string>>()

/** Access Barrier 本地到期兜底：主路径靠 single_hitl_resolved；丢事件时按 expires_at 收卡。 */
const accessBarrierExpiryTimers = new Map<string, ReturnType<typeof setTimeout>>()

function accessBarrierExpiryKey(sessionId: string, requestId: string): string {
  return `${sessionId}:${requestId}`
}

function clearAccessBarrierExpiryTimer(sessionId: string, requestId: string | undefined | null): void {
  if (!sessionId || !requestId) return
  const key = accessBarrierExpiryKey(sessionId, requestId)
  const timer = accessBarrierExpiryTimers.get(key)
  if (timer) {
    clearTimeout(timer)
    accessBarrierExpiryTimers.delete(key)
  }
}

/** 本地清 Access Barrier 面板时顺带清到期兜底 timer（避免等 single_hitl_resolved）。 */
export function clearAccessBarrierExpiryForSession(
  sessionId: string,
  requestId: string | undefined | null,
): void {
  clearAccessBarrierExpiryTimer(sessionId, requestId)
}

function scheduleAccessBarrierExpiry(
  sessionId: string,
  requestId: string,
  expiresAt: number,
): void {
  clearAccessBarrierExpiryTimer(sessionId, requestId)
  const delay = Math.max(0, expiresAt - Date.now())
  const timer = setTimeout(() => {
    accessBarrierExpiryTimers.delete(accessBarrierExpiryKey(sessionId, requestId))
    handleSingleHitlResolvedStreamEvent(
      {
        type: StreamEvents.SINGLE_HITL_RESOLVED,
        payload: {
          request_id: requestId,
          interrupt_id: requestId,
          outcome: 'expired',
          schema_version: 1,
        },
      },
      { sessionId },
    )
  }, delay)
  accessBarrierExpiryTimers.set(accessBarrierExpiryKey(sessionId, requestId), timer)
}

/** 记一条“该会话下某 HITL key 已解决”的墓碑（来自权威 resolved 信号）。 */
export function recordHitlResolvedKey(sessionId: string, key: string | undefined | null): void {
  if (!sessionId || !key) return
  let set = resolvedTombstoneBySession.get(sessionId)
  if (!set) {
    set = new Set<string>()
    resolvedTombstoneBySession.set(sessionId, set)
  }
  set.add(key)
  // 有界：超过上限丢最早（Set 保插入序），墓碑只用于挡“刚解决后的重放”，不需长存。
  if (set.size > HITL_RESOLVED_TOMBSTONE_MAX_PER_SESSION) {
    const oldest = set.values().next().value
    if (oldest !== undefined) set.delete(oldest)
  }
}

/** 该会话下某 HITL key 是否已被标记解决（打开前守卫用）。 */
export function isHitlResolvedKey(sessionId: string, key: string | undefined | null): boolean {
  if (!sessionId || !key) return false
  return resolvedTombstoneBySession.get(sessionId)?.has(key) ?? false
}

/** 测试用：清空墓碑。 */
export function __resetHitlResolvedTombstoneForTest(): void {
  resolvedTombstoneBySession.clear()
}

export type AskInteractionKind = 'choice' | 'form' | 'approval'

export interface HitlStreamHandlerContext {
  sessionId: string
  spaceId?: string
  spaceName?: string
  sessionTitle?: string
  /** Active send path: mutable assistant placeholder id (optional for push/background). */
  aiMessageIdRef?: { current: string }
  onBeforeHandle?: () => void
  /**
   *  / ：从持久化 hitl_interaction 消息恢复面板时置 true。与实时弹出差异：
   *   1. 不重发系统通知（实时弹出时已通知过，重载 / 切会话 / 每轮 sync 不再打扰）；
   *   2. 不 append review 气泡——事实消息已在列表；禁止再造 hitl-review-* 合成 id。
   */
  restoredFromPersistedFact?: boolean
}

function buildReviewMessage(data: ReviewRequiredEventData): string {
  const lines: string[] = []
  lines.push(i18n.t('chat:reviewPrompt.title'))

  if (data.message) {
    lines.push(data.message)
  }

  data.action_requests?.forEach((action, index) => {
    const toolName = action.tool_name || action.name || 'unknown'
    const title =
      action.description || i18n.t('chat:reviewPrompt.toolCall', { name: toolName })
    lines.push(`${index + 1}. ${title}`)
  })

  lines.push(i18n.t('chat:reviewPrompt.actionChoice'))
  return lines.join('\n')
}

function resolveHitlAccess() {
  const access = getHitlStoreAccess()
  if (!access) {
    log.warn('HITL store access not registered — cannot apply stream HITL event')
    return null
  }
  return access
}

/** 前台正看该会话时跳过 OS 通知；面板状态由调用方照常写入。 */
function maybeNotifyHitlOsWaiting(
  ctx: Pick<HitlStreamHandlerContext, 'sessionId' | 'sessionTitle' | 'spaceId' | 'spaceName'>,
  opts: {
    titleKey: string
    titleDefault: string
    bodyFallback: string
    /** ：仅传稳定 UUID；缺省时通知只进会话、不带 around 定位。 */
    messageId?: string
    /** 与服务端持久 HITL 通知共享的 request_key。 */
    requestKey?: string
  },
): void {
  const prefix = ctx.spaceName ? `${ctx.spaceName} · ` : ''
  SystemNotification.agentHitlWaiting({
    title: `${prefix}${i18n.t(opts.titleKey, { defaultValue: opts.titleDefault })}`,
    body: opts.bodyFallback,
    sessionId: ctx.sessionId,
    spaceId: ctx.spaceId,
    ...(opts.messageId ? { messageId: opts.messageId } : {}),
    ...(opts.requestKey ? { dedupRef: `agent-hitl:${opts.requestKey}` } : {}),
    suppressWhenSourceWindowFocused:
      getChatStoreCallbacks()?.getCurrentSessionId() === ctx.sessionId,
  })
}

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

/** wire `subagent_context` → store / ApprovalPanel */
function normalizeSubagentContext(raw: unknown): {
  parent_tool_call_id: string
  subagent_run_id?: string
  label?: string
} | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const value = raw as Record<string, unknown>
  const parentToolCallId = stringField(value.parent_tool_call_id)
  if (!parentToolCallId) return undefined
  return {
    parent_tool_call_id: parentToolCallId,
    subagent_run_id: stringField(value.subagent_run_id),
    label: stringField(value.label),
  }
}

export function normalizeTeamSpaceExecution(raw: unknown): ApprovalRequestState['teamSpaceExecution'] | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const value = raw as Record<string, unknown>
  const executionOwnerUserId = stringField(value.execution_owner_user_id)
  if (!executionOwnerUserId) return undefined
  return {
    collaborationSpaceId: stringField(value.collaboration_space_id),
    executionSpaceId: stringField(value.execution_space_id),
    initiatorUserId: stringField(value.initiator_user_id),
    executionOwnerUserId,
    initiatorDisplayName: stringField(value.initiator_display_name),
    executionOwnerDisplayName: stringField(value.execution_owner_display_name),
  }
}

/**
 * Project 审批只允许执行 owner 处理（决策 Q5）：
 * payload 无 team_space_execution（Workspace / 旧事件）时不限制。
 * 发起端 IPC 流（本文件）与 WS 观察镜像流（useObserverStreamMirror）都必须
 * 用这一份判定，否则成员端会看到可操作的完整审批面板。
 */
export function computeApprovalCanResolve(
  teamSpaceExecution: ApprovalRequestState['teamSpaceExecution'],
): boolean {
  const ownerId = teamSpaceExecution?.executionOwnerUserId
  if (!ownerId) return true
  return stringField(useAuthStore.getState().user?.id) === ownerId
}

export function handleApprovalRequestedStreamEvent(
  event: AgentStreamMessage,
  ctx: HitlStreamHandlerContext,
): boolean {
  const access = resolveHitlAccess()
  if (!access) return false

  ctx.onBeforeHandle?.()

  const p = (event.payload ?? {}) as Record<string, unknown>
  const batchId = typeof p.batch_id === 'string' ? p.batch_id : undefined
  log.info('收到批量审批请求', { session: ctx.sessionId.slice(0, 8), batchId })

  const expiresAt = typeof p.expires_at === 'number' ? p.expires_at : undefined
  if (batchId && expiresAt !== undefined && expiresAt <= Date.now()) {
    log.info('审批请求已过期，收敛为终态', {
      session: ctx.sessionId.slice(0, 8),
      batchId,
    })
    return handlePendingInteractionTerminalEvent({
      type: 'agent.user.interaction_expired',
      payload: {
        interaction: {
          kind: 'tool_approval',
          request_key: batchId,
          session_id: ctx.sessionId,
          status: 'expired',
        },
      },
    } as AgentStreamMessage)
  }

  const existingPending = access.getState().pendingApprovalBySessionId[ctx.sessionId]
  if (batchId && existingPending?.batchId === batchId) {
    // 平台审批 local IPC + WS relay 双投递去重：同一 batch 只保留一条 Panel
    return true
  }

  // ：已解决的审批 batch 被重放（seq-gap 补拉 / user event offline buffer）时拒绝重开。
  const requestedBatchId = typeof p.batch_id === 'string' ? p.batch_id : undefined
  if (requestedBatchId && isHitlResolvedKey(ctx.sessionId, requestedBatchId)) {
    log.info('审批请求命中已解决墓碑，忽略重放', { session: ctx.sessionId.slice(0, 8), batchId: requestedBatchId })
    return true
  }

  const localThreadId = `chat-session-${ctx.sessionId}`

  const rawActionRequests = Array.isArray(p.action_requests) ? p.action_requests : []
  const actionRequests = rawActionRequests.map((raw) => {
    const r = (raw && typeof raw === 'object') ? raw as Record<string, unknown> : {}
    return {
      request_id: typeof r.request_id === 'string' ? r.request_id : undefined,
      tool_call_id: typeof r.tool_call_id === 'string' ? r.tool_call_id : undefined,
      tool_name: typeof r.tool_name === 'string' ? r.tool_name : undefined,
      arguments: (r.tool_input && typeof r.tool_input === 'object')
        ? r.tool_input as Record<string, unknown>
        : (r.arguments && typeof r.arguments === 'object')
          ? r.arguments as Record<string, unknown>
          : undefined,
      description: typeof r.description === 'string'
        ? r.description
        : (typeof (r.ask_hint as { summary?: string } | undefined)?.summary === 'string'
            ? (r.ask_hint as { summary: string }).summary
            : undefined),
      cli_spec: r.cli_spec as ReviewRequiredEventData['action_requests'][number]['cli_spec'],
      decision_reason: r.decision_reason,
      // ：judge 人话判决说明——ApprovalPanel 对新 reason type 没配 i18n 时兜底渲染
      user_visible_reason: typeof r.user_visible_reason === 'string' ? r.user_visible_reason : undefined,
      ask_hint: r.ask_hint,
      allowed_scopes: r.allowed_scopes,
      allowed_outcomes: r.allowed_outcomes,
      risk_level: r.risk_level,
      subagent_context: normalizeSubagentContext(r.subagent_context),
    }
  }) as unknown as ReviewRequiredEventData['action_requests']

  const reviewConfigs = (
    actionRequests.map((a) => ({
      action_name: (a.tool_name as string | undefined) || 'unknown',
      allowed_decisions: ['approve', 'reject'] as Array<'approve' | 'reject'>,
    }))
  ) as ReviewRequiredEventData['review_configs']

  const reviewDataForMessage: ReviewRequiredEventData = {
    thread_id: localThreadId,
    action_requests: actionRequests,
    review_configs: reviewConfigs,
    message: p.message as string | undefined,
    message_id: p.message_id as string | undefined,
  }
  const reviewMessage = access.buildReviewMessage?.(reviewDataForMessage) ?? buildReviewMessage(reviewDataForMessage)

  // ：只用 runtime 同源 message_id；禁止 hitl-review-* / aiMessageIdRef 合成，
  // 否则 OS 通知 → around= 会打非法 UUID（Sentry ValidationError）。
  const reviewMsgId = typeof p.message_id === 'string' && p.message_id.trim()
    ? p.message_id.trim()
    : undefined
  if (!reviewMsgId) {
    log.warn('approval_requested 缺少 message_id，仅开面板、不造本地气泡/不带通知定位', {
      session: ctx.sessionId.slice(0, 8),
      batchId,
      restored: ctx.restoredFromPersistedFact === true,
    })
  }
  const prevAiMsgId = ctx.aiMessageIdRef?.current
  // 恢复路径：hitl_interaction 已在消息列表，只开面板不造气泡。
  // 实时路径：有同源 message_id 才 upsert；缺 id 只开面板。
  if (reviewMsgId && !ctx.restoredFromPersistedFact) {
    access.upsertHitlBubble(ctx.sessionId, prevAiMsgId, {
      id: reviewMsgId,
      role: 'assistant',
      content: reviewMessage,
      created_at: new Date().toISOString(),
    })
  }

  const runtimeMode = (typeof p.runtime_mode === 'string'
    ? p.runtime_mode
    : 'interactive') as ApprovalRequestState['runtimeMode']
  const teamSpaceExecution = normalizeTeamSpaceExecution(p.team_space_execution)
  const canResolve = computeApprovalCanResolve(teamSpaceExecution)
  const approvalSource = (typeof p.approval_source === 'string'
    ? p.approval_source
    : undefined) as ApprovalRequestState['approvalSource']
  const approvalTtlSeconds = expiresAt
    ? Math.max(0, Math.floor((expiresAt - Date.now()) / 1000))
    : (typeof p.approval_ttl_seconds === 'number' ? p.approval_ttl_seconds : undefined)
  const interruptedAt = expiresAt
    ? Math.floor(Date.now() / 1000)
    : (typeof p.interrupted_at === 'number' ? p.interrupted_at : undefined)

  access.applyState((state) => ({
    pendingApprovalBySessionId: {
      ...state.pendingApprovalBySessionId,
      [ctx.sessionId]: {
        sessionId: ctx.sessionId,
        threadId: localThreadId,
        batchId,
        interactionType: (p.interaction_type ?? 'review') as ApprovalRequestState['interactionType'],
        blockingPolicy: (p.blocking_policy ?? 'hard') as ApprovalRequestState['blockingPolicy'],
        actionRequests,
        reviewConfigs,
        messageId: reviewMsgId,
        message: reviewDataForMessage.message,
        interruptedAt,
        approvalTtlSeconds,
        runtimeMode,
        expiresAt,
        teamSpaceExecution,
        canResolve,
        openedAt: Date.now(),
        approvalSource,
      },
    },
    approvalSubmittingBySessionId: {
      ...state.approvalSubmittingBySessionId,
      [ctx.sessionId]: false,
    },
  }))

  if (!ctx.restoredFromPersistedFact) {
    maybeNotifyHitlOsWaiting(ctx, {
      titleKey: 'chat:notification.reviewRequired',
      titleDefault: 'Agent 等待确认',
      bodyFallback: ctx.sessionTitle
        || i18n.t('chat:notification.reviewRequiredBody', { defaultValue: 'Agent 需要你审核操作后继续' }),
      messageId: reviewMsgId,
      requestKey: batchId,
    })
  }

  return true
}

export function handleApprovalResolvedStreamEvent(
  event: AgentStreamMessage,
  ctx: Pick<HitlStreamHandlerContext, 'sessionId'>,
): boolean {
  const access = resolveHitlAccess()
  if (!access) return false

  const p = (event.payload ?? {}) as Record<string, unknown>
  const resolvedBatchId = typeof p.batch_id === 'string' ? p.batch_id : undefined
  // ：无论本地是否还有面板，先记墓碑——resolved 可能先于/晚于本地状态到达，
  // 记下后即便随后 approval_requested 被重放也不再重开。
  recordHitlResolvedKey(ctx.sessionId, resolvedBatchId)
  const state = access.getState()
  const pending = state.pendingApprovalBySessionId[ctx.sessionId]
  if (!pending || (resolvedBatchId && pending.batchId !== resolvedBatchId)) {
    return true
  }

  access.applyState((current) => {
    const nextPending = { ...current.pendingApprovalBySessionId }
    delete nextPending[ctx.sessionId]
    const nextSubmitting = { ...current.approvalSubmittingBySessionId }
    delete nextSubmitting[ctx.sessionId]
    return {
      pendingApprovalBySessionId: nextPending,
      approvalSubmittingBySessionId: nextSubmitting,
    }
  })

  return true
}

/** ：单 HITL 终态收敛；IPC 与 WS 镜像共用。按 interruptId 精确匹配。 */
export function handleSingleHitlResolvedStreamEvent(
  event: AgentStreamMessage,
  ctx: Pick<HitlStreamHandlerContext, 'sessionId'>,
): boolean {
  const access = resolveHitlAccess()
  if (!access) return false

  const p = (event.payload ?? {}) as Record<string, unknown>
  const resolvedId =
    (typeof p.request_id === 'string' && p.request_id) ||
    (typeof p.interrupt_id === 'string' && p.interrupt_id) ||
    undefined
  // ：与 approval_resolved 对称——无论本地是否还有面板，先记墓碑。
  // 否则 single_hitl_resolved 抢在 clearAskUserForSession 之前清掉 pending 时，
  // 提交路径看不到 pending → 墓碑整段落空 → lifecycle-end 消息对账把仍
  // pending 的 hitl_interaction 派生回开（任务结束后又弹 ask 卡）。
  recordHitlResolvedKey(ctx.sessionId, resolvedId)
  clearAccessBarrierExpiryTimer(ctx.sessionId, resolvedId)
  const state = access.getState()
  const pending = state.pendingAskUserBySessionId[ctx.sessionId]
  if (!pending || (resolvedId && pending.interruptId && pending.interruptId !== resolvedId)) {
    return true
  }

  // 候选 key 一并记上（服务端 request_key 可能是 interrupt/toolCall/message 任一）。
  recordHitlResolvedKey(ctx.sessionId, pending.interruptId)
  recordHitlResolvedKey(ctx.sessionId, pending.toolCallId)
  recordHitlResolvedKey(ctx.sessionId, pending.messageId)
  clearAccessBarrierExpiryTimer(ctx.sessionId, pending.interruptId)

  access.applyState((current) => {
    const nextPending = { ...current.pendingAskUserBySessionId }
    delete nextPending[ctx.sessionId]
    const nextSubmitting = { ...current.askUserSubmittingBySessionId }
    delete nextSubmitting[ctx.sessionId]
    return {
      pendingAskUserBySessionId: nextPending,
      askUserSubmittingBySessionId: nextSubmitting,
    }
  })

  return true
}

function normalizeSessionIdFromInteraction(interaction: Record<string, unknown>): string | null {
  const sessionId = typeof interaction.session_id === 'string' ? interaction.session_id.trim() : ''
  if (sessionId) return sessionId

  const threadId = typeof interaction.thread_id === 'string' ? interaction.thread_id.trim() : ''
  if (threadId.startsWith('chat-session-')) return threadId.slice('chat-session-'.length)
  return null
}

export function handlePendingInteractionRequestedEvent(event: AgentStreamMessage): boolean {
  const payload = (event.payload ?? {}) as Record<string, unknown>
  const interaction = (payload.interaction && typeof payload.interaction === 'object' && !Array.isArray(payload.interaction))
    ? payload.interaction as Record<string, unknown>
    : null
  if (!interaction) return true

  const kind = typeof interaction.kind === 'string' ? interaction.kind : ''
  const interactionPayload = (interaction.payload && typeof interaction.payload === 'object' && !Array.isArray(interaction.payload))
    ? interaction.payload as Record<string, unknown>
    : null
  if (!interactionPayload) return true

  const sessionId = normalizeSessionIdFromInteraction(interaction)
  if (!sessionId) return true

  // ask 三件套（choice / form / 单 approval）： 起，ask 面板的“打开”收敛到权威
  // PendingInteraction 用户事件，不再靠可重放的 WS stream 镜像直塞（复活根因）。
  // 本地 IPC 仍由 handleAskInteractionRequiredStreamEvent 低延迟快开；跨设备 / 恢复
  // 由这条权威事件承接，与 stream 复用同一 builder。
  const askKind = askInteractionKindFromServerKind(kind)
  if (askKind) {
    // 只在 pending 时打开——挡住 offline buffer 重放的已解决 requested 事件复活面板
    // （权威 status 作准；serialize_interaction 始终带 status）。
    const status = typeof interaction.status === 'string' ? interaction.status : ''
    if (status && status !== 'pending') return true

    const access = resolveHitlAccess()
    if (!access) return false

    const requestKey = typeof interaction.request_key === 'string' ? interaction.request_key : ''
    // ：与审批打开路径对称——已解决 key 拒绝重开（挡对账/权威事件乱序）。
    if (requestKey && isHitlResolvedKey(sessionId, requestKey)) {
      log.info('ask 请求命中已解决墓碑，忽略重放', {
        session: sessionId.slice(0, 8),
        requestKey,
      })
      return true
    }
    // ：只用 payload.message_id；request_key 不是 ChatMessage.id，禁止 hitl-ask-*。
    const messageId = typeof interactionPayload.message_id === 'string'
      && interactionPayload.message_id.trim()
      ? interactionPayload.message_id.trim()
      : undefined
    const state = buildAskUserRequestState(sessionId, askKind, interactionPayload, messageId)

    access.applyState((s) => ({
      pendingAskUserBySessionId: {
        ...s.pendingAskUserBySessionId,
        [sessionId]: state,
      },
      askUserSubmittingBySessionId: {
        ...s.askUserSubmittingBySessionId,
        [sessionId]: false,
      },
    }))
    return true
  }

  // tool_approval（批量审批）：Project approval 详情不走共享 thread stream；
  // owner 专属 user event 承载完整 payload，在这里打开可操作的 ApprovalPanel。
  if (kind !== 'tool_approval') return true
  // ：收敛到 PendingInteraction(status=pending)——挡住 offline buffer 重放的
  // 已解决 requested user event 复活审批面板（与 ask 分支同口径）。
  const approvalStatus = typeof interaction.status === 'string' ? interaction.status : ''
  if (approvalStatus && approvalStatus !== 'pending') return true
  if (!normalizeTeamSpaceExecution(interactionPayload.team_space_execution)) return true

  return handleApprovalRequestedStreamEvent(
    {
      type: 'agent.stream.approval_requested',
      payload: interactionPayload,
    },
    { sessionId },
  )
}

function askKindMatchesInteractionKind(localKind: AskUserRequestState['kind'], interactionKind: string): boolean {
  switch (interactionKind) {
    case 'ask_choice':
      return localKind === 'choice'
    case 'ask_form':
      return localKind === 'form'
    case 'permission_request':
      return localKind === 'approval'
    default:
      return false
  }
}

/** 服务端 PendingInteraction.kind → 本地 ask 面板 discriminant（非 ask 返回 null）。 */
function askInteractionKindFromServerKind(interactionKind: string): AskInteractionKind | null {
  switch (interactionKind) {
    case 'ask_choice':
      return 'choice'
    case 'ask_form':
      return 'form'
    case 'permission_request':
      return 'approval'
    default:
      return null
  }
}

const KNOWN_ASK_RISK = ['safe', 'review', 'high'] as const
function pickAskRiskLevel(val: unknown): AskUserRequestStateApproval['riskLevel'] {
  if (typeof val === 'string' && (KNOWN_ASK_RISK as readonly string[]).includes(val)) {
    return val as AskUserRequestStateApproval['riskLevel']
  }
  return 'safe'
}

function normalizeLoginWallContextHint(value: unknown): AskUserRequestStateBase['contextHint'] | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const hint = value as Record<string, unknown>
  if (hint.kind !== 'login_wall' || typeof hint.domain !== 'string' || !hint.domain) return undefined
  const tabId = typeof hint.tab_id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(hint.tab_id)
    ? hint.tab_id
    : undefined
  return { kind: 'login_wall', domain: hint.domain, ...(tabId ? { tabId } : {}) }
}

/**
 * 从 wire / 序列化 payload 构建 pendingAskUser 面板状态（纯函数，无副作用）。
 *
 * 同一份映射被两条打开路径复用，避免漂移：
 *   - stream 快开：`handleAskInteractionRequiredStreamEvent`（本地 IPC 低延迟）
 *   - 权威用户事件打开：`handlePendingInteractionRequestedEvent`（跨设备 / 恢复，
 *     来自服务端 PendingInteraction 的 `agent.user.interaction_requested`）
 *
 * `p` 对两条路径同构：stream 是 wire ask_*_required payload；用户事件是
 * `serialize_interaction().payload`（upsert 时存的正是同一份 wire payload）。
 */
function buildAskUserRequestState(
  sessionId: string,
  kind: AskInteractionKind,
  p: Record<string, unknown>,
  messageId?: string,
): AskUserRequestState {
  // ：ask 三件套与 approval 同源计算 Project 只读遮蔽——payload 带
  // team_space_execution 且当前用户非 execution owner 时 canResolve=false。
  const askTeamSpaceExecution = normalizeTeamSpaceExecution(p.team_space_execution)
  const askCanResolve = computeApprovalCanResolve(askTeamSpaceExecution)

  const base = {
    sessionId,
    threadId: `chat-session-${sessionId}`,
    interruptId: (p.interrupt_id ?? p.request_id ?? p.ask_id ?? p.message_id) as string | undefined,
    interactionType: (p.interaction_type ?? 'ask_user') as AskUserRequestStateBase['interactionType'],
    blockingPolicy: (p.blocking_policy ?? 'soft') as AskUserRequestStateBase['blockingPolicy'],
    title: typeof p.title === 'string' ? p.title : undefined,
    toolCallId: (p.tool_call_id ?? p.request_id ?? p.ask_id ?? p.message_id) as string,
    messageId,
    message: typeof p.message === 'string' ? p.message : undefined,
    submitLabel: typeof p.submit_label === 'string' ? p.submit_label : undefined,
    declineLabel: typeof p.decline_label === 'string' ? p.decline_label : undefined,
    presetId: typeof p.preset_id === 'string' ? p.preset_id : undefined,
    teamSpaceExecution: askTeamSpaceExecution,
    canResolve: askCanResolve,
    contextHint: normalizeLoginWallContextHint(p.context_hint),
    openedAt: Date.now(),
  } satisfies Omit<AskUserRequestStateBase, 'submitError'>

  return kind === 'choice'
    ? {
        ...base,
        kind: 'choice',
        questions: (p.questions as AskUserRequestStateChoice['questions']) ?? [],
      }
    : kind === 'form'
      ? {
          ...base,
          kind: 'form',
          fields: (p.fields as AskUserRequestStateForm['fields']) ?? [],
          addons: p.addons as AskUserRequestStateForm['addons'],
          formMode: p.form_mode === 'text_fallback' ? 'text_fallback' : 'fields',
        }
      : {
          ...base,
          kind: 'approval',
          rationale: typeof p.rationale === 'string' ? p.rationale : '',
          riskLevel: pickAskRiskLevel(p.risk_level),
          details: p.details,
        }
}

function pendingAskMatchesRequestKey(pending: AskUserRequestState, requestKey: string): boolean {
  return pending.interruptId === requestKey ||
    pending.toolCallId === requestKey ||
    pending.messageId === requestKey
}

export function handlePendingInteractionTerminalEvent(event: AgentStreamMessage): boolean {
  const access = resolveHitlAccess()
  if (!access) return false

  const payload = (event.payload ?? {}) as Record<string, unknown>
  const interaction = (payload.interaction && typeof payload.interaction === 'object' && !Array.isArray(payload.interaction))
    ? payload.interaction as Record<string, unknown>
    : null
  if (!interaction) return true

  const kind = typeof interaction.kind === 'string' ? interaction.kind : ''
  const requestKey = typeof interaction.request_key === 'string' ? interaction.request_key : ''
  const sessionId = normalizeSessionIdFromInteraction(interaction)
  if (!kind || !requestKey || !sessionId) return true

  //  / ：终态用户事件是权威 resolved 事实——审批与 ask 一律记墓碑，
  // 挡住随后 requested 重放 / lifecycle-end 消息对账把面板派生回开。
  recordHitlResolvedKey(sessionId, requestKey)
  const current = access.getState()
  const pendingAsk = current.pendingAskUserBySessionId[sessionId]
  if (
    pendingAsk &&
    askKindMatchesInteractionKind(pendingAsk.kind, kind) &&
    pendingAskMatchesRequestKey(pendingAsk, requestKey)
  ) {
    recordHitlResolvedKey(sessionId, pendingAsk.interruptId)
    recordHitlResolvedKey(sessionId, pendingAsk.toolCallId)
    recordHitlResolvedKey(sessionId, pendingAsk.messageId)
  }

  access.applyState((state) => {
    const patch: Partial<ReturnType<typeof access.getState>> = {}

    if (kind === 'tool_approval') {
      const pending = state.pendingApprovalBySessionId[sessionId]
      if (pending && (!pending.batchId || pending.batchId === requestKey)) {
        const nextPending = { ...state.pendingApprovalBySessionId }
        delete nextPending[sessionId]
        const nextSubmitting = { ...state.approvalSubmittingBySessionId }
        delete nextSubmitting[sessionId]
        patch.pendingApprovalBySessionId = nextPending
        patch.approvalSubmittingBySessionId = nextSubmitting
      }
    }

    const ask = state.pendingAskUserBySessionId[sessionId]
    if (
      ask &&
      askKindMatchesInteractionKind(ask.kind, kind) &&
      pendingAskMatchesRequestKey(ask, requestKey)
    ) {
      const nextPendingAsk = { ...state.pendingAskUserBySessionId }
      delete nextPendingAsk[sessionId]
      const nextSubmittingAsk = { ...state.askUserSubmittingBySessionId }
      delete nextSubmittingAsk[sessionId]
      patch.pendingAskUserBySessionId = nextPendingAsk
      patch.askUserSubmittingBySessionId = nextSubmittingAsk
    }

    return patch
  })

  return true
}

export function handleAskInteractionRequiredStreamEvent(
  event: AgentStreamMessage,
  kind: AskInteractionKind,
  ctx: HitlStreamHandlerContext,
): boolean {
  const access = resolveHitlAccess()
  if (!access) return false

  ctx.onBeforeHandle?.()

  const p = (event.payload ?? {}) as Record<string, unknown>
  log.info('收到用户交互请求', { session: ctx.sessionId.slice(0, 8), kind })

  // ：本地 IPC 快开路径也查墓碑（与 approval_requested 对称），挡住
  // 已答完后的 stream 重放把面板再塞回来。
  const requestedId =
    (typeof p.request_id === 'string' && p.request_id)
    || (typeof p.interrupt_id === 'string' && p.interrupt_id)
    || undefined
  if (requestedId && isHitlResolvedKey(ctx.sessionId, requestedId)) {
    log.info('ask stream 请求命中已解决墓碑，忽略重放', {
      session: ctx.sessionId.slice(0, 8),
      requestId: requestedId,
    })
    return true
  }

  const parsed = AskInteractionRequestSchema.safeParse(p)
  if (!parsed.success) {
    const isDev =
      typeof process !== 'undefined' &&
      (process.env?.NODE_ENV === 'development' || process.env?.NODE_ENV === 'test')
    const logFn = isDev ? log.error.bind(log) : log.warn.bind(log)
    logFn('[handleAskInteractionRequired] wire payload 与 schema 不一致', {
      kind,
      issues: parsed.error.issues.slice(0, 5),
    })
  }

  // ：只用 runtime 同源 message_id；禁止 hitl-ask-* / aiMessageIdRef 合成。
  const askMsgId = typeof p.message_id === 'string' && p.message_id.trim()
    ? p.message_id.trim()
    : undefined
  if (!askMsgId) {
    log.warn('ask_*_required 缺少 message_id，仅开面板、不造本地气泡/不带通知定位', {
      session: ctx.sessionId.slice(0, 8),
      kind,
    })
  }
  const prevAiMsgId = ctx.aiMessageIdRef?.current

  const askContent = (p.message as string)
    || (p.title as string)
    || i18n.t('chat:messages.askUserWaiting', { defaultValue: '等待你的回答…' })

  if (askMsgId) {
    access.upsertHitlBubble(ctx.sessionId, prevAiMsgId, {
      id: askMsgId,
      role: 'assistant',
      content: askContent,
      created_at: new Date().toISOString(),
    })
  }

  const pendingAskUserState = buildAskUserRequestState(ctx.sessionId, kind, p, askMsgId)

  access.applyState((state) => ({
    pendingAskUserBySessionId: {
      ...state.pendingAskUserBySessionId,
      [ctx.sessionId]: pendingAskUserState,
    },
    askUserSubmittingBySessionId: {
      ...state.askUserSubmittingBySessionId,
      [ctx.sessionId]: false,
    },
  }))

  maybeNotifyHitlOsWaiting(ctx, {
    titleKey: 'chat:notification.askUserRequired',
    titleDefault: 'Agent 向你提问',
    bodyFallback: (p.title as string)
      || ctx.sessionTitle
      || i18n.t('chat:notification.askUserRequiredBody', { defaultValue: 'Agent 需要你回答问题后继续' }),
    messageId: askMsgId,
    requestKey: requestedId,
  })

  return true
}

export function handleHitlStreamEvent(
  event: AgentStreamMessage,
  ctx: HitlStreamHandlerContext,
): boolean {
  const eventType = event.type
  if (eventType === StreamEvents.APPROVAL_REQUESTED || eventType === 'agent.stream.approval_requested') {
    return handleApprovalRequestedStreamEvent(event, ctx)
  }
  if (eventType === StreamEvents.APPROVAL_RESOLVED || eventType === 'agent.stream.approval_resolved') {
    return handleApprovalResolvedStreamEvent(event, ctx)
  }
  if (eventType === StreamEvents.SINGLE_HITL_RESOLVED || eventType === 'agent.stream.single_hitl_resolved') {
    return handleSingleHitlResolvedStreamEvent(event, ctx)
  }
  if (eventType === StreamEvents.ASK_USER_REQUIRED) {
    return handleAskInteractionRequiredStreamEvent(event, 'choice', ctx)
  }
  if (eventType === StreamEvents.ASK_FORM_REQUIRED) {
    return handleAskInteractionRequiredStreamEvent(event, 'form', ctx)
  }
  if (eventType === StreamEvents.REQUEST_APPROVAL_REQUIRED) {
    return handleAskInteractionRequiredStreamEvent(event, 'approval', ctx)
  }
  if (
    eventType === StreamEvents.ACCESS_BARRIER_REQUIRED
    || eventType === 'agent.stream.access_barrier_required'
  ) {
    return handleAccessBarrierRequiredStreamEvent(event, ctx)
  }
  return false
}

const ACCESS_BARRIER_ACTION_LABELS: Record<string, { label: string; description: string }> = {
  resume_same_tab: {
    label: '我已在当前标签页完成，继续',
    description: '登录或验证完成后，Agent 复用同一标签页继续',
  },
  alternate_source: {
    label: '改用其他公开来源（须诚实标注）',
    description: '同意换源；后续交付必须标注真实来源，不得冒充本站',
  },
  abort_this_target: {
    label: '跳过该站',
    description: '本站内容本次不覆盖',
  },
}

function accessBarrierTitle(kind: string): string {
  if (kind === 'login') return '页面需要登录'
  if (kind === 'captcha' || kind === 'geetest' || kind === 'mfa') return '页面需要完成验证'
  return '页面受阻'
}

/**
 * Access Barrier HITL：系统撞墙 → 复用 AskUser 选择面板（固定选项 id = action），
 * 提交时由 askUserSlice 映射为 `{ action }` 决议（见 accessBarrierMeta）。
 */
export function handleAccessBarrierRequiredStreamEvent(
  event: AgentStreamMessage,
  ctx: HitlStreamHandlerContext,
): boolean {
  const access = resolveHitlAccess()
  if (!access) return false

  const p = (event.payload ?? {}) as Record<string, unknown>
  const requestId = typeof p.request_id === 'string' ? p.request_id.trim() : ''
  if (!requestId) {
    log.warn('access_barrier_required 缺少 request_id', { session: ctx.sessionId.slice(0, 8) })
    return true
  }

  if (isHitlResolvedKey(ctx.sessionId, requestId)) {
    log.info('access_barrier 命中已解决墓碑，忽略重放', {
      session: ctx.sessionId.slice(0, 8),
      requestId,
    })
    return true
  }

  const barrierRaw = p.barrier
  if (!barrierRaw || typeof barrierRaw !== 'object' || Array.isArray(barrierRaw)) {
    log.warn('access_barrier_required 缺少 barrier', { session: ctx.sessionId.slice(0, 8) })
    return true
  }
  const barrier = barrierRaw as Record<string, unknown>
  const kind = typeof barrier.kind === 'string' ? barrier.kind : 'unknown_wall'
  const domain = typeof barrier.domain === 'string' ? barrier.domain : 'unknown'
  const reason = typeof barrier.reason === 'string' ? barrier.reason : ''
  const tabId = typeof barrier.tabId === 'string' ? barrier.tabId : undefined
  const actions = Array.isArray(barrier.actions)
    ? barrier.actions.filter((a): a is string => typeof a === 'string')
    : ['resume_same_tab', 'alternate_source', 'abort_this_target']

  const options = actions.map((actionId) => {
    const copy = ACCESS_BARRIER_ACTION_LABELS[actionId] ?? {
      label: actionId,
      description: actionId,
    }
    return {
      id: actionId,
      label: copy.label,
      description: copy.description,
    }
  })

  const title = accessBarrierTitle(kind)
  const prompt = [
    domain !== 'unknown' ? `${domain}` : null,
    reason || null,
  ].filter(Boolean).join('：') || title

  const expiresAt = typeof p.expires_at === 'number' ? p.expires_at : undefined

  const pendingAskUserState: AskUserRequestStateChoice = {
    sessionId: ctx.sessionId,
    threadId: `chat-session-${ctx.sessionId}`,
    kind: 'choice',
    interruptId: requestId,
    toolCallId: requestId,
    title,
    message: prompt,
    interactionType: 'ask_user',
    blockingPolicy: 'hard',
    presetId: 'access_barrier',
    canResolve: true,
    openedAt: Date.now(),
    ...(expiresAt !== undefined ? { expiresAt } : {}),
    accessBarrierMeta: { tabId, domain, kind },
    questions: [
      {
        id: 'access_barrier_action',
        prompt,
        header: title,
        options,
        allow_multiple: false,
      },
    ],
  }

  access.applyState((state) => ({
    pendingAskUserBySessionId: {
      ...state.pendingAskUserBySessionId,
      [ctx.sessionId]: pendingAskUserState,
    },
    askUserSubmittingBySessionId: {
      ...state.askUserSubmittingBySessionId,
      [ctx.sessionId]: false,
    },
  }))

  // 到期兜底收卡（丢 single_hitl_resolved 时不挡发送）；权威仍以后端事件为准。
  if (expiresAt !== undefined) {
    scheduleAccessBarrierExpiry(ctx.sessionId, requestId, expiresAt)
  }

  // 对话内卡片即可；不走 OS / 跨 org toast（设计 §6.1 / criticalEventNotifier 注释）。
  log.info('access_barrier 面板已打开', {
    session: ctx.sessionId.slice(0, 8),
    kind,
    domain,
    requestId: requestId.slice(0, 8),
    expiresAt,
  })

  return true
}
