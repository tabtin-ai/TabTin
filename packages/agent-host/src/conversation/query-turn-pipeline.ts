/**
 * query-turn-pipeline.ts — deep module that completely owns one hosted turn:
 * normalized-input validation, FIFO + queued/dequeued signalling, active run +
 * abort signal, authoritative-config read ordering, agent/approval mode
 * normalization, security/workspace/appContext live mutate, runtime acquisition,
 * attachment/effective-prompt/history/rewind/backfill, the `for await` main loop,
 * a single terminal state (`succeeded | failed | aborted`), and idempotent
 * cleanup.
 *
 * It absorbs the platform `submitQuery / handleQueryInternal / executeQueryInternal`
 * and the previously-exported helpers (`runHostedQuery`,
 * `runQueryExecutionPipeline`, `runQueryStreamTurn`, `ConversationSupervisor`) as
 * private implementation: the PD-13 authoritative read + in-place mutate sequence
 * is inlined into {@link DefaultQueryTurnPipeline.runTurn}, the `for await` main
 * loop into {@link DefaultQueryTurnPipeline.consumeRuntime}, and the early
 * validation constants into {@link QUERY_TURN_ERROR}. The platform provides only
 * the `RuntimeSessionLifecycle`, `DeliveryCoordinator`, and the narrow
 * query-data/diagnostics ports — never an execution closure.
 */

import { dirname } from 'node:path'
import {
  buildInitialMessages,
  buildUserMessageWithAttachments,
  extractTraceIdFromLifecycleStart,
  ContentBlockEvents,
  StreamEvents,
  type ContentBlock,
  type Message,
  type MessageBlockRecord,
  type QueryParams,
  type StreamEvent,
} from '@tabtin/agent-runtime'
import { injectTurnIdentity } from './inject-turn-identity.js'
import {
  rememberAgentDisplayName,
  resolveAgentDisplayName,
} from './agent-display-name-store.js'
import {
  hydrateMessageAgentAttributions,
  rememberMessageSenderAttribution,
} from './message-agent-attribution-store.js'
import { resolveAgentModeName } from '@tabtin/agent-modes'
import {
  buildReplayHistoryFromTranscript,
} from '@tabtin/agent-runtime/history'
import type { ApprovalMode } from '@tabtin/security-policy'
import type { ConversationLifecycleIdentity } from './conversation-identity.js'
import type { RuntimeSessionLifecycle } from '../runtime/runtime-session-lifecycle.js'
import type {
  DeliveryCoordinator,
  DeliveryPersistenceSinks,
  DeliveryTurn,
} from '../delivery/delivery-coordinator.js'
import {
  ConversationSupervisor,
  type ConversationExecutionState,
} from './conversation-supervisor.js'
import {
  applyAuthoritativeSecurityMutate,
  applyWorkspaceSnapshotMutate,
  type QueryPipelineSession,
} from './query-session-mutate.js'
import { hasUserInputContent } from './forward-request-decoder.js'
import type {
  HostQuery,
  HostQueryBeginSubmitResult,
  HostQueryOutcome,
  HostQueryPolicyInput,
  HostQueryResult,
} from './host-query.js'

/**
 * 沿用两端 host 既有失败文案（原 `query-skeleton.ts` 常量），避免 renderer 侧
 * UI 分支需要新增分支。吸收进 pipeline 后作为私有常量。
 */
const QUERY_TURN_ERROR = {
  MISSING_SESSION_ID: 'sessionId is required',
  MISSING_CONTENT: 'prompt or attachments are required',
} as const

/**
 * ：用户 abort 后仍须投递的收尾事件白名单。
 * `DONE` 由 host 在 drain 完成后统一补发带 `host_confirmed` 的权威终态，
 * 因此不能透传 runtime 的 DONE，以免同一 run 出现两个 terminal。
 * 不含普通 content_block_delta —— 避免中断后继续刷半截流。
 */
const ABORT_TERMINAL_EVENT_TYPES = new Set<string>([
  StreamEvents.PERSIST_MESSAGE,
  StreamEvents.SYSTEM_NOTICE,
  ContentBlockEvents.MESSAGE_DELTA,
  ContentBlockEvents.MESSAGE_STOP,
  ContentBlockEvents.CONTENT_BLOCK_STOP,
])

function isAbortTerminalEvent(event: StreamEvent): boolean {
  return ABORT_TERMINAL_EVENT_TYPES.has(event.type)
}

function isBlankUserTranscriptContent(content: Message['content']): boolean {
  if (typeof content === 'string') return content.trim().length === 0
  if (!Array.isArray(content) || content.length === 0) return true
  return content.every((block) => {
    if (!block || typeof block !== 'object') return true
    const type = (block as { type?: unknown }).type
    const text = (block as { text?: unknown }).text
    return type === 'text' && typeof text === 'string' && text.trim().length === 0
  })
}

/**
 * abort 后 drain 白名单收尾事件的硬上限。超时则放弃继续读 generator，
 * 避免旧轮卡住插队/下轮开跑（ promote 延迟）。
 */
const ABORT_DRAIN_DEADLINE_MS = 1_500

/**
 * abort 信号已置位后，继续 drain runtime generator 并只 emit 非 terminal 的
 * 白名单收尾事件，确保 partial persist / envelope 收尾进入 transcript；最终
 * terminal 由 host 统一发出。硬超时后放弃继续 drain。
 */
async function drainAbortTerminalEvents(
  generator: AsyncIterable<StreamEvent>,
  deliveryTurn: DeliveryTurn,
  firstEvent: StreamEvent,
): Promise<void> {
  if (isAbortTerminalEvent(firstEvent)) {
    await deliveryTurn.emit(firstEvent)
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), ABORT_DRAIN_DEADLINE_MS)
  })
  const drain = (async (): Promise<'done'> => {
    for await (const event of generator) {
      if (isAbortTerminalEvent(event)) {
        await deliveryTurn.emit(event)
      }
    }
    return 'done'
  })()
  try {
    await Promise.race([drain, deadline])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** Result of aborting a conversation's runs. */
export interface QueryAbortResult {
  /** Run ids cancelled from the queue (active run is aborted via signal). */
  cancelledRunIds: string[]
}

/** Deep module interface. `RuntimeInput`/`Mode`/`ExtraKey` match the platform runtime request generics. */
export interface QueryTurnPipeline<RuntimeInput, Mode extends string = string, ExtraKey = never> {
  /** Submit one turn; resolves when the run reaches its single terminal state. */
  submit(query: HostQuery<RuntimeInput, Mode, ExtraKey>): Promise<HostQueryResult>

  /** 队列接受后立即返回 disposition；turn 在 completion 后台 settle。 */
  beginSubmit(query: HostQuery<RuntimeInput, Mode, ExtraKey>): HostQueryBeginSubmitResult

  /** Abort a conversation (cancel queued runs + abort the active run). */
  abort(identity: ConversationLifecycleIdentity): QueryAbortResult

  /** Authoritative busy/queue state for a conversation. */
  getState(conversationId: string): ConversationExecutionState

  /** Quiesce an owner scope (used during owner teardown / shutdown). */
  quiesce(scope: string): Promise<void>
}

// ─── Default implementation ──────────────────────────────────────────

/**
 * A runtime-ready attachment reference (platform已改写私网图片 / 映射 wire
 * 字段）。原 `query-stream-turn.ts` 端口 type，吸收进本 deep module。
 */
export interface QueryStreamRuntimeAttachment {
  type: 'image' | 'file' | 'video'
  /** ：与 DB / FileBlock 对齐，供本机 transcript 还原附件卡 */
  file_id?: string
  filename?: string
  mime_type?: string
  size?: number
  url?: string
  preview_url?: string
}

/**
 * 主循环一轮内读写的窄 session 存储视图。原 `query-stream-turn.ts` 端口 type，
 * 吸收进本 deep module。
 */
export interface QueryStreamSessionStorage {
  hasPendingRewind(): boolean
  commitRewind(): Promise<number | null>
  ensureBlockBackfillFromTranscript(): Promise<void>
  recordUserMessage(
    message: Message,
    opts?: { messageId?: string; triggeredBy?: string },
  ): Promise<void>
  appendUserBlockRecord(
    message: Message,
    opts?: { messageId?: string; triggeredBy?: string },
  ): Promise<void>
  restoreMessages(): Promise<Message[]>
  /** 读取本会话 message-blocks；无文件时返回 []。 */
  loadBlockRecords(): Promise<MessageBlockRecord[]>
  appendStreamEvent(event: StreamEvent): Promise<void>
}

/**
 * Narrow, platform-neutral view of a session bag the main loop needs. Storage /
 * emitter / abort are data ports; the loop owns *when* they run.
 */
export interface QueryTurnSessionView {
  abortController: AbortController
  /**
   * Cooperative execution gate owned by the platform session. The runtime
   * evaluates it before each safe iteration boundary.
   */
  pauseController: {
    readonly isPaused?: boolean
    waitIfPaused(signal?: AbortSignal): Promise<void>
  }
  sessionStorage: QueryStreamSessionStorage
  eventStorage: {
    truncateFrom(cutTs: number): Promise<void>
    append(entry: { type: string; payload: unknown; timestamp: number }): Promise<void>
  }
  snapshotStorage: { append(payload: Record<string, unknown>): Promise<void> }
  toolProvider: {
    setSubagentTraceWiring(
      push?: (evt: StreamEvent) => void | Promise<void>,
      getTraceId?: () => string | undefined,
    ): void
  }
  eventEmitter: { buildStream(event: StreamEvent): StreamEvent }
  eventInterceptor?: ((evt: StreamEvent) => void) | undefined
}

/**
 * 宿主在执行前提交的原子本轮状态。Identity 与用户输入由 AgentHost 保持不变；
 * 平台只能补齐会影响 Runtime 构建和 Session mutate 的两个投影。
 */
export interface PreparedQueryTurnInputs<RuntimeInput, Mode extends string, ExtraKey> {
  runtime: HostQuery<RuntimeInput, Mode, ExtraKey>['runtime']
  policy?: HostQueryPolicyInput
}

/**
 * Platform data / IO ports for the pipeline. Every method is data or a single
 * IO — none of them decides FIFO, terminal state, delivery routing, or the loop.
 */
export interface QueryTurnDataPort<Session, RuntimeInput, Mode extends string, ExtraKey> {
  lifecycle: RuntimeSessionLifecycle<RuntimeInput, Session, Mode, ExtraKey>
  delivery: DeliveryCoordinator
  log: { info(msg: string): void; warn(msg: string, detail?: unknown): void }

  /** Narrow session accessors. */
  sessionView(session: Session): QueryTurnSessionView
  runtimeOf(session: Session): { query(params: QueryParams): AsyncIterable<StreamEvent> }
  organizationIdOf(session: Session, query: HostQuery<RuntimeInput, Mode, ExtraKey>): string | undefined

  /** Authoritative Django agent config (drives PD-13 mutate). */
  fetchAuthoritative(args: {
    agentId: string
    sessionId: string
    /** Electron：叠 Workspace approval_grant；缺省 fail-closed。 */
    workspaceId?: string
  }): Promise<
    { security: { allow_yolo_mode?: boolean; approval_grant?: import('@tabtin/security-policy').ApprovalMode } } | null
  >
  /** Electron injects tracker reconcile; Daemon derives from sources. */
  reconcileAllowedPaths?: (dst: import('./query-session-mutate.js').QuerySessionWorkspaceSnapshotLike) => void
  /**
   * ACK/enqueue 之后、lifecycle.acquire 之前：宿主返回补齐后的本轮快照
   *（规则、execution_limits、workspaceSnapshot 等）。流水线只消费返回值，
   * 禁止通过修改传入 query 的副作用提交半完成状态；禁止挡 IPC ACK。
   */
  prepareTurnInputs?(ctx: {
    query: HostQuery<RuntimeInput, Mode, ExtraKey>
  }): void | PreparedQueryTurnInputs<RuntimeInput, Mode, ExtraKey>
    | Promise<void | PreparedQueryTurnInputs<RuntimeInput, Mode, ExtraKey>>
  /** Register client-disconnect abort / interaction-mode etc. after runtime is ready. */
  afterSessionReady?(ctx: { session: Session; query: HostQuery<RuntimeInput, Mode, ExtraKey> }): void | Promise<void>
  /** Resolve attachments into the effective prompt (local docparse / cloud summary). */
  buildEffectivePrompt?(ctx: { session: Session; query: HostQuery<RuntimeInput, Mode, ExtraKey> }): Promise<string>
  /** Platform attachment rewriting (Electron: private-net image → data URL). */
  prepareRuntimeAttachments(ctx: {
    attachments: unknown
    query: HostQuery<RuntimeInput, Mode, ExtraKey>
  }): Promise<QueryStreamRuntimeAttachment[]>
  /** Platform historical-image rewriting; identity on Daemon. */
  prepareInitialMessages?(messages: Message[]): Promise<Message[] | undefined>
  /** Merge platform-only runtime.query fields. */
  buildQueryParams(base: QueryParams, query: HostQuery<RuntimeInput, Mode, ExtraKey>): QueryParams
  /** Whitelisted session-storage write (handles tool log writer). */
  appendStreamEventToSessionStorage(session: Session, event: StreamEvent): Promise<void>
  /** `agent.stream.done` 已完成本地持久化后的窄观察点。 */
  onTurnTerminalPersisted?(
    sessionId: string,
    query: HostQuery<RuntimeInput, Mode, ExtraKey>,
    event: StreamEvent,
  ): void | Promise<void>
  /** Flush session/snapshot/event storage at turn end (per-turn dispose). */
  flushTurnStorage?(session: Session): Promise<void> | void
  /** Pre-query relay backfill reconcile (reconnect recovery); fire-and-forget. */
  reconcileSessionRelayBackfill?(session: Session, conversationId: string): void
  /** Build the lifecycle error event for a failed turn. */
  buildLifecycleErrorEvent(session: Session, error: unknown): StreamEvent
  /** Build the local persisted event from relay message ids. */
  projectPersistedEvent?(session: Session, messageIds: string[]): StreamEvent | undefined

  /** Queue observers (Electron MESSAGE_QUEUED / DEQUEUED). */
  onQueued?(query: HostQuery<RuntimeInput, Mode, ExtraKey>, position: number): void
  onDequeued?(query: HostQuery<RuntimeInput, Mode, ExtraKey>): void
  /**
   * busy≈streaming：本轮 streaming 逻辑终态、即将释放 Host 队列槽位时调用。
   * 须在 drain 下一轮之前释放轮次绑定资源（如 CLI workspace scope lease）。
   * 后台 seal / storage / onTurnFinally 可能更晚。
   */
  onTurnStreamingDone?(
    sessionId: string,
    query: HostQuery<RuntimeInput, Mode, ExtraKey>,
    result: HostQueryResult,
  ): void | Promise<void>
  /** Observe one terminal turn failure after cancellation has been excluded. */
  onTurnError?(
    error: Error,
    query: HostQuery<RuntimeInput, Mode, ExtraKey>,
    aborted: boolean,
  ): void | Promise<void>
  /** Post-turn hook (notification drain / platform turn-scoped resource release). */
  onTurnFinally?(
    sessionId: string,
    query: HostQuery<RuntimeInput, Mode, ExtraKey>,
  ): void | Promise<void>
}

export interface DefaultQueryTurnPipelineOptions<Session, RuntimeInput, Mode extends string, ExtraKey> {
  ports: QueryTurnDataPort<Session, RuntimeInput, Mode, ExtraKey>
  /**
   * Host-owned supervisor (the single {@link AgentHost} instance). Owner
   * teardown (via RuntimeSessionLifecycle) and the pipeline quiesce the *same*
   * supervisor, so owner reset correctly cancels in-flight pipeline runs and the
   * FIFO / scope / busy state has exactly one owner.
   */
  supervisor: ConversationSupervisor<HostQuery<RuntimeInput, Mode, ExtraKey>, HostQueryResult, Session>
}

/**
 * Default {@link QueryTurnPipeline}. Owns FIFO (via {@link ConversationSupervisor}),
 * the single terminal state machine, runtime acquisition (via
 * {@link RuntimeSessionLifecycle}), and cleanup; routes every runtime event
 * through one {@link DeliveryTurn}. No platform execute closure exists.
 */
export class DefaultQueryTurnPipeline<Session, RuntimeInput, Mode extends string = string, ExtraKey = never>
  implements QueryTurnPipeline<RuntimeInput, Mode, ExtraKey> {
  private readonly ports: QueryTurnDataPort<Session, RuntimeInput, Mode, ExtraKey>
  private readonly supervisor: ConversationSupervisor<
    HostQuery<RuntimeInput, Mode, ExtraKey>,
    HostQueryResult,
    Session
  >

  constructor(options: DefaultQueryTurnPipelineOptions<Session, RuntimeInput, Mode, ExtraKey>) {
    this.ports = options.ports
    // Owner teardown + pipeline share the one host-owned supervisor; execute +
    // queue observers are (re)bound to this pipeline instance.
    options.supervisor.bindAdapter({
      execute: (query, context) => this.runTurn(query, context.signal),
      onQueued: (q, position) => this.ports.onQueued?.(q.request, position),
      onDequeued: (q) => this.ports.onDequeued?.(q.request),
    })
    this.supervisor = options.supervisor
  }

  /**
   *  / busy≈streaming /  promote：
   * - seal：delivery.complete（本地流已关）——下轮 runTurn 必等
   * - storage：flushTurnStorage + onTurnFinally —— 不挡下轮；quiesce / wait 排空
   * relay ACK 在 DeliveryTurn.complete 内异步 settle，不进这两条链。
   */
  private readonly pendingSealByConversation = new Map<string, Promise<void>>()
  private readonly pendingStorageByConversation = new Map<string, Promise<void>>()

  private async awaitPendingSeal(conversationId: string): Promise<void> {
    const pending = this.pendingSealByConversation.get(conversationId)
    if (pending) await pending
  }

  private enqueueTracked(
    map: Map<string, Promise<void>>,
    conversationId: string,
    work: () => Promise<void>,
  ): void {
    const prev = map.get(conversationId) ?? Promise.resolve()
    const next = prev.then(work, work).finally(() => {
      if (map.get(conversationId) === next) {
        map.delete(conversationId)
      }
    })
    map.set(conversationId, next)
  }

  /** Test / quiesce：等待某会话后台 seal + storage 收尾。 */
  async waitForPendingFinalize(conversationId: string): Promise<void> {
    await this.awaitPendingSeal(conversationId)
    const storage = this.pendingStorageByConversation.get(conversationId)
    if (storage) await storage
  }

  /** Shared supervisor so RuntimeSessionLifecycle / owner teardown can quiesce it. */
  getSupervisor(): ConversationSupervisor<HostQuery<RuntimeInput, Mode, ExtraKey>, HostQueryResult, Session> {
    return this.supervisor
  }

  submit(query: HostQuery<RuntimeInput, Mode, ExtraKey>): Promise<HostQueryResult> {
    const begun = this.beginSubmit(query)
    return begun.ok ? begun.completion : Promise.resolve(begun.result)
  }

  beginSubmit(query: HostQuery<RuntimeInput, Mode, ExtraKey>): HostQueryBeginSubmitResult {
    if (!query.identity.sessionId) {
      return { ok: false, result: { success: false, error: QUERY_TURN_ERROR.MISSING_SESSION_ID } }
    }
    // ：preset / @ 引用可能只在 userMessageBlocks，prompt 为空仍算有效输入。
    if (!hasUserInputContent(
      query.turn.prompt,
      query.turn.attachments,
      query.turn.userMessageBlocks,
    )) {
      return { ok: false, result: { success: false, error: QUERY_TURN_ERROR.MISSING_CONTENT } }
    }
    const handle = this.supervisor.beginSubmit({
      conversationId: query.identity.conversationId,
      sessionId: query.identity.sessionId,
      lifecycleScopeId: `${query.identity.owner.userId}|${query.identity.owner.organizationId}`,
      interruptScopeId: query.identity.owner.agentId,
      interruptActive: query.turn.interruptActive === true,
      runId: query.identity.runId,
      request: query,
    })
    return {
      ok: true,
      acceptance: {
        runId: query.identity.runId,
        runDisposition: handle.acceptance.status,
        ...(handle.acceptance.status === 'queued'
          ? { queuePosition: handle.acceptance.position }
          : {}),
      },
      completion: handle.completion,
    }
  }

  abort(identity: ConversationLifecycleIdentity): QueryAbortResult {
    return { cancelledRunIds: this.supervisor.abort(identity) }
  }

  getState(conversationId: string): ConversationExecutionState {
    return this.supervisor.getState(conversationId)
  }

  async quiesce(scope: string): Promise<void> {
    this.supervisor.quiesceScope(scope)
    await this.supervisor.waitForScopeIdle(scope)
    // streaming 已 idle 后仍可能有后台 seal / storage；排空避免 teardown 竞态。
    await Promise.all([
      ...this.pendingSealByConversation.values(),
      ...this.pendingStorageByConversation.values(),
    ])
  }

  /**
   * Absorbed `runQueryExecutionPipeline`: PD-13 authoritative read → in-place
   * mutate → effective prompt, all before the main loop. Steps 1-8 run here so
   * `buildJudgePolicy` closures read this turn's latest authoritative policy on
   * the next `runTools` entry; step 9 delegates to {@link runLoopAndDeliver}.
   */
  private async runTurn(
    query: HostQuery<RuntimeInput, Mode, ExtraKey>,
    signal: AbortSignal,
  ): Promise<HostQueryResult> {
    const ports = this.ports
    const sessionId = query.identity.sessionId
    const conversationId = query.identity.conversationId
    const runId = query.identity.runId
    /** 当前 setup/loop 步骤，失败时写入日志与 DONE.setup_step 便于定位吞队。 */
    let setupStep = 'await_seal'
    let effectiveQuery = query
    let session: Session | undefined
    /** streaming 已返回、delivery/storage 改由后台 seal/storage 链收尾时为 true。 */
    let finalizeEnqueued = false
    try {
      // 只等 seal：storage dispose 不挡插队 / 队列下一轮。
      await this.awaitPendingSeal(conversationId)

      // 步骤 1：宿主原子补齐本轮快照（规则 / limits / snapshot）。
      setupStep = 'prepare_turn_inputs'
      const preparedInputs = await ports.prepareTurnInputs?.({ query })
      effectiveQuery = preparedInputs
        ? { ...query, runtime: preparedInputs.runtime, policy: preparedInputs.policy }
        : query
      const policy = effectiveQuery.policy

      // 步骤 2：任务模式归一。policy.approvalMode 是旧 wire 兼容字段，
      //  起不再参与权限判决。
      setupStep = 'resolve_modes'
      const resolvedAgentMode = resolveAgentModeName(policy?.agentMode, 'agent')

      // 步骤 3：权威 fetch（agentId 缺失时跳过——沿用旧路径 gate=false 的行为）
      // ：workspaceId 一并透传，Electron 走 ForWorkspace 叠现场 grant。
      setupStep = 'fetch_authoritative'
      const agentId = policy?.agentId
      const authoritativeAgentConfig = agentId
        ? await ports.fetchAuthoritative({
            agentId,
            sessionId,
            workspaceId: policy?.workspaceId,
          })
        : null
      const authoritativeAllowYolo =
        authoritativeAgentConfig?.security.allow_yolo_mode === true
      const authoritativeGrant: ApprovalMode | undefined =
        authoritativeAgentConfig?.security.approval_grant

      // 步骤 4：yolo mismatch telemetry（客户端 claim vs 服务端 actual）
      setupStep = 'yolo_mismatch_check'
      if (agentId && policy?.yoloModeFromWire !== undefined) {
        const clientClaim = policy.yoloModeFromWire === true
        if (clientClaim !== authoritativeAllowYolo) {
          ports.log.info(
            `[yolo-gate] client-claim vs server-actual mismatch agent=${agentId.slice(0, 8)}… `
              + `claim=${clientClaim} actual=${authoritativeAllowYolo}`,
          )
        }
      }

      // 步骤 5：runtime 就位
      setupStep = 'lifecycle_acquire'
      const handle = await ports.lifecycle.acquire(effectiveQuery.runtime)
      session = handle.session
      const mutableSession = session as unknown as QueryPipelineSession

      // 步骤 5a：security mutate（PD-13）
      setupStep = 'security_mutate'
      applyAuthoritativeSecurityMutate(mutableSession, {
        allowYolo: authoritativeAllowYolo,
        approvalGrant: authoritativeGrant,
        agentMode: resolvedAgentMode,
        requestedApprovalMode: undefined,
        isGroupSpace: policy?.isGroupSpace,
      })

      // 步骤 5b：workspace mutate（PD-13）—— 只在有 incoming 且 dst 已就位时刷
      setupStep = 'workspace_mutate'
      if (policy?.workspaceSnapshot && mutableSession.workspaceSnapshot) {
        applyWorkspaceSnapshotMutate(mutableSession.workspaceSnapshot, policy.workspaceSnapshot, {
          reconcileAllowedPaths: ports.reconcileAllowedPaths,
        })
      }

      // 步骤 6：appContext 写入（!== undefined 语义，避免误吞 falsy 非 undefined 值）
      setupStep = 'app_context'
      if (policy?.appContext !== undefined) {
        mutableSession.appContext = policy.appContext
      }

      // 步骤 6b：agentProfile 写入——对话中可切 Agent，每轮覆盖；hook 贴用户消息前注入
      setupStep = 'agent_profile'
      if (policy?.agentProfile !== undefined) {
        mutableSession.agentProfile = policy.agentProfile
      }

      // 步骤 7：after-session-ready（Electron destroyed listener / Daemon interactionMode 登记）
      setupStep = 'after_session_ready'
      await ports.afterSessionReady?.({ session, query: effectiveQuery })

      // 步骤 8：附件 → effectivePrompt
      setupStep = 'build_effective_prompt'
      const effectivePrompt = ports.buildEffectivePrompt
        ? await ports.buildEffectivePrompt({ session, query: effectiveQuery })
        : effectiveQuery.turn.prompt

      // 步骤 9：主循环 + delivery（streaming 终态即返回；flush 后台化）
      setupStep = 'run_loop'
      return await this.runLoopAndDeliver(session, effectiveQuery, effectivePrompt, signal, () => {
        finalizeEnqueued = true
      })
    } catch (error) {
      const aborted =
        signal.aborted
        || (session !== undefined && ports.sessionView(session).abortController.signal.aborted)
      const errorMessage = error instanceof Error ? error.message : String(error)
      const errorName = error instanceof Error ? error.name : 'NonError'
      const stackHead = error instanceof Error && typeof error.stack === 'string'
        ? error.stack.split('\n').slice(0, 4).join(' | ')
        : ''
      // 单行结构化：诊断包 / main.log 可按 HOST_SETUP_ERROR / setup_step 检索。
      ports.log.warn(
        `[query-turn] turn failed `
          + `run=${runId.slice(0, 8)}… `
          + `session=${sessionId.slice(0, 8)}… `
          + `setup_step=${setupStep} `
          + `aborted=${aborted} `
          + `error_name=${errorName} `
          + `error_message=${errorMessage}`
          + (stackHead ? ` stack=${stackHead}` : ''),
      )
      const relayConversationId =
        query.turn.relaySessionId ?? query.identity.conversationId
      try {
        await ports.delivery.publishHostEvent(
          {
            sessionId: relayConversationId,
            conversationId: relayConversationId,
            owner: query.identity.owner,
            organizationId: query.identity.owner.organizationId,
          },
          {
            type: 'agent.stream.done',
            payload: aborted
              ? {
                  run_id: query.identity.runId,
                  stop_reason: 'aborted',
                  error: true,
                  error_class: 'ABORT',
                  error_message: 'Run aborted by user.',
                  host_confirmed: true,
                  setup_step: setupStep,
                }
              : {
                  run_id: query.identity.runId,
                  stop_reason: 'host_setup_failed',
                  error: true,
                  error_class: 'HOST_SETUP_ERROR',
                  error_message: errorMessage,
                  host_confirmed: true,
                  setup_step: setupStep,
                },
          },
        )
      } catch (publishError) {
        const publishMessage = publishError instanceof Error
          ? publishError.message
          : String(publishError)
        ports.log.warn(
          `[query-turn] setup terminal delivery failed `
            + `run=${runId.slice(0, 8)}… setup_step=${setupStep} `
            + `error_message=${publishMessage}`,
        )
      }
      await this.notifyTurnError(
        error instanceof Error ? error : new Error(errorMessage),
        query,
        aborted,
      )
      return aborted
        ? { success: false, aborted: true }
        : { success: false, error: errorMessage }
    } finally {
      if (session) {
        const view = ports.sessionView(session)
        view.eventInterceptor = undefined
        view.toolProvider.setSubagentTraceWiring(undefined, undefined)
        if (!finalizeEnqueued) {
          await ports.flushTurnStorage?.(session)
        }
      }
      if (!finalizeEnqueued) {
        await ports.onTurnFinally?.(sessionId, query)
      }
    }
  }

  private async runLoopAndDeliver(
    session: Session,
    query: HostQuery<RuntimeInput, Mode, ExtraKey>,
    effectivePrompt: string,
    signal: AbortSignal,
    onFinalizeEnqueued: () => void,
  ): Promise<HostQueryResult> {
    const ports = this.ports
    const view = ports.sessionView(session)
    const sessionId = query.identity.sessionId
    const persist: DeliveryPersistenceSinks = {
      appendSessionStreamEvent: (event) => ports.appendStreamEventToSessionStorage(session, event),
      appendEventLog: (entry) => view.eventStorage.append(entry),
      appendSnapshot: (payload) => view.snapshotStorage.append(payload),
    }
    const deliveryTurn: DeliveryTurn = ports.delivery.openTurn({
      lifecycleSessionId: query.identity.sessionId,
      conversationId: query.turn.relaySessionId ?? query.identity.conversationId,
      businessRunId: query.identity.runId,
      owner: query.identity.owner,
      organizationId: ports.organizationIdOf(session, query),
      clientMessageId: query.turn.clientMessageId,
      taskId: query.turn.taskId,
      persist,
      projectPersistedEvent: ports.projectPersistedEvent
        ? (ids) => ports.projectPersistedEvent!(session, ids)
        : undefined,
      buildStream: (event) => view.eventEmitter.buildStream(event),
    })

    const outcome =
      await this.consumeRuntime(view, session, query, effectivePrompt, signal, deliveryTurn)
    if (outcome.kind === 'aborted') {
      // runtime 的 ABORT DONE 可能在 signal 已置位后才从 generator 产出；consumeRuntime
      // 会停止转发后续 runtime 数据。由 host 在确认执行循环已退出后补一个权威终态，
      // 保证 Django projection 只在“确已停止”后从 cancelling 收敛。
      await deliveryTurn.emit({
        type: 'agent.stream.done',
        payload: {
          run_id: query.identity.runId,
          stop_reason: 'aborted',
          error: true,
          error_class: 'ABORT',
          error_message: 'Run aborted by user.',
          suggested_action: 'retry_later',
          host_confirmed: true,
        },
      })
    }
    if (outcome.kind === 'failed') {
      await this.notifyTurnError(outcome.error, query, false)
    }

    const result: HostQueryResult = outcome.kind === 'aborted'
      ? { success: false, aborted: true }
      : {
          success: outcome.kind === 'succeeded',
          ...(outcome.kind === 'failed' ? { error: outcome.error.message } : {}),
        }

    // busy≈streaming：逻辑终态后立即释放 queue 槽位 → run_sync idle。
    // 先通知宿主释放「挡下一轮 start」的轮次资源（CLI scope 等），再 enqueue 后台收尾。
    try {
      await ports.onTurnStreamingDone?.(sessionId, query, result)
    } catch (error) {
      ports.log.warn('[query-turn] onTurnStreamingDone failed', error)
    }
    onFinalizeEnqueued()
    const conversationId = query.identity.conversationId
    this.enqueueTracked(this.pendingSealByConversation, conversationId, async () => {
      try {
        await deliveryTurn.complete(outcome)
      } catch (error) {
        ports.log.warn('[query-turn] delivery complete failed', error)
      }
    })
    const sealPromise = this.pendingSealByConversation.get(conversationId) ?? Promise.resolve()
    this.enqueueTracked(this.pendingStorageByConversation, conversationId, async () => {
      await sealPromise
      try {
        await ports.flushTurnStorage?.(session)
      } catch (error) {
        ports.log.warn('[query-turn] flushTurnStorage failed', error)
      }
      try {
        await ports.onTurnFinally?.(sessionId, query)
      } catch (error) {
        ports.log.warn('[query-turn] onTurnFinally failed', error)
      }
    })

    return result
  }

  private async notifyTurnError(
    error: Error,
    query: HostQuery<RuntimeInput, Mode, ExtraKey>,
    aborted: boolean,
  ): Promise<void> {
    try {
      await this.ports.onTurnError?.(error, query, aborted)
    } catch (observerError) {
      this.ports.log.warn('[query-turn] error observer failed', observerError)
    }
  }

  private async consumeRuntime(
    view: QueryTurnSessionView,
    session: Session,
    query: HostQuery<RuntimeInput, Mode, ExtraKey>,
    effectivePrompt: string,
    signal: AbortSignal,
    deliveryTurn: DeliveryTurn,
  ): Promise<HostQueryOutcome> {
    const ports = this.ports
    let currentTraceId: string | undefined

    view.eventInterceptor = (evt) => { void deliveryTurn.emit(evt) }
    view.toolProvider.setSubagentTraceWiring(
      (evt) => deliveryTurn.emitRouted(evt, { source: 'subagent_trace' }),
      () => currentTraceId,
    )

    try {
      const preparedAttachments = await ports.prepareRuntimeAttachments({
        attachments: query.turn.attachments,
        query,
      })
      // ：平台 prepare 若只改写 url、漏带 file_id，按 url 从 turn.attachments 补回，
      // 避免本机 transcript 只剩 source.url、切会话后无法走 OSS 换链。
      const turnAttachments = query.turn.attachments ?? []
      const fileIdByUrl = new Map(
        turnAttachments
          .filter((a): a is typeof a & { url: string; file_id: string } =>
            typeof a.url === 'string' && !!a.url && typeof a.file_id === 'string' && !!a.file_id)
          .map((a) => [a.url, a.file_id]),
      )
      const runtimeAttachments = preparedAttachments.map((a) => (
        a.file_id || !a.url
          ? a
          : { ...a, file_id: fileIdByUrl.get(a.url) ?? a.file_id }
      ))
      // LLM 多模态装配用 effectivePrompt（可含 `<context>` wrapper / Tracker 模板）。
      // 本机 transcript / 冷读气泡：有非空 displayMessage 时只落可见正文，
      // continuation 即使 display 为空也不回落 effectivePrompt，避免冷读露出续跑提示。
      // 其它路径无 display 时仍落 effectivePrompt，由 UI toDisplayBlocks 剥 context wrapper。
      const userMessage: Message = buildUserMessageWithAttachments(effectivePrompt, runtimeAttachments)
      const displayMessage = query.turn.displayMessage
      const persistPrompt =
        query.turn.triggeredBy === 'continuation'
          ? (typeof displayMessage === 'string' ? displayMessage : '')
          : typeof displayMessage === 'string' && displayMessage.length > 0
            ? displayMessage
            : effectivePrompt
      const displayUserMessage: Message =
        persistPrompt === effectivePrompt
          ? userMessage
          : buildUserMessageWithAttachments(persistPrompt, runtimeAttachments)
      // ：把全部非 text 的 userMessageBlocks（table_selection/document/…）追加进
      // 本机 transcript。附件已在 displayUserMessage 里；勿再扁平拼一遍以免与 source 形态重复。
      const contextBlocks = (query.turn.userMessageBlocks ?? []).filter(
        (block): block is Record<string, unknown> => {
          if (!block || typeof block !== 'object') return false
          const type = (block as { type?: unknown }).type
          return typeof type === 'string' && type !== 'text'
        },
      )
      const persistUserMessage: Message = contextBlocks.length === 0
        ? displayUserMessage
        : {
            role: 'user',
            content: [
              ...(typeof displayUserMessage.content === 'string'
                ? (displayUserMessage.content.trim().length > 0
                  ? [{ type: 'text', text: displayUserMessage.content } as ContentBlock]
                  : [])
                : displayUserMessage.content),
              // wire 侧还有 table_selection/document 等，尚未进 ContentBlock 联合；落库原样透传
              ...(contextBlocks as unknown as ContentBlock[]),
            ],
          }

      if (view.sessionStorage.hasPendingRewind()) {
        const cutTs = await view.sessionStorage.commitRewind()
        if (cutTs !== null) {
          await view.eventStorage.truncateFrom(cutTs)
        }
      }
      // rewind 已由回退链路确认，必须先提交并同步截断 event storage；否则提前
      // aborted 会把 staged rewind 遗留给下一次发送。退出仍放在写入 user
      // transcript 之前，避免留下“一条用户消息 + Agent 静默无回应”的半轮状态。
      if (signal.aborted || view.abortController.signal.aborted) {
        return { kind: 'aborted' }
      }
      const relayConversationId = query.turn.relaySessionId ?? query.identity.conversationId
      ports.reconcileSessionRelayBackfill?.(session, relayConversationId)

      await view.sessionStorage.ensureBlockBackfillFromTranscript().catch((err) => {
        ports.log.warn('[query-turn] block backfill failed', err)
      })

      const clientMessageId = query.turn.clientMessageId
      const triggeredBy = query.turn.triggeredBy
      const runtimeTriggeredBy =
        triggeredBy === 'user' || triggeredBy === 'push-notification'
          ? triggeredBy
          : undefined
      const userRecordOpts = {
        ...(clientMessageId ? { messageId: clientMessageId } : {}),
        ...(triggeredBy && triggeredBy !== 'user' ? { triggeredBy } : {}),
      }
      // 续跑对用户隐藏提示（displayMessage=''）。空 user 不能落盘，否则下一轮
      // 会原样发给 Kimi/K3 并 400。LLM 仍用上方 userMessage=effectivePrompt。
      const skipBlankContinuationUser =
        triggeredBy === 'continuation'
        && isBlankUserTranscriptContent(persistUserMessage.content)
      if (!skipBlankContinuationUser) {
        await view.sessionStorage.recordUserMessage(displayUserMessage, userRecordOpts)
        await view.sessionStorage.appendUserBlockRecord(persistUserMessage, userRecordOpts)
      }
      const blockFilePath = (view.sessionStorage as { blockStorage?: { filePath?: string } })
        .blockStorage?.filePath
      if (clientMessageId && query.turn.senderUserId && blockFilePath) {
        rememberMessageSenderAttribution(
          clientMessageId,
          query.turn.senderUserId,
          dirname(blockFilePath),
        )
      }

      // ：跨 Agent 身份注解是会话策略——在 buildInitialMessages 之后由 host
      // 注入（不改 agent-runtime）。归属只在 host attribution store；对齐用与
      // replay 相同的可见性过滤，条数不一致则 fail-closed。
      const currentAgentId = query.policy?.agentId
      const currentAgentName = query.policy?.agentProfile?.agentName
      if (currentAgentId && currentAgentName) {
        rememberAgentDisplayName(currentAgentId, currentAgentName)
      }
      const blockRecords = await view.sessionStorage.loadBlockRecords().catch(() => [] as MessageBlockRecord[])
      // SessionStorage.blockStorage.filePath 与 sidecar 同目录（host 专有，非 runtime 契约）
      if (typeof blockFilePath === 'string' && blockFilePath) {
        hydrateMessageAgentAttributions(dirname(blockFilePath))
      }
      const localTranscript = (await view.sessionStorage.restoreMessages()).slice(0, -1)
      // ：跨轮记忆仅本机 transcript；不再读 renderer 传来的 query.turn.history。
      //  canonical result 契约：transcript 里的 tool_result 是产生时已限长
      // 一次的正式记录（「tool_result 保留 raw」），跨轮原样复用——不再用
      // model projection 逐轮改写历史（保证前缀稳定 + 批量取证证据可累积）。
      const replayHistory = localTranscript.length > 0
        ? buildReplayHistoryFromTranscript(localTranscript)
        : []

      const rawInitialMessages = buildInitialMessages(replayHistory, userMessage)
      const preparedInitialMessages = ports.prepareInitialMessages && rawInitialMessages
        ? await ports.prepareInitialMessages(rawInitialMessages)
        : rawInitialMessages
      const initialMessages = preparedInitialMessages
        ? injectTurnIdentity(
          preparedInitialMessages,
          blockRecords,
          {
            ...(currentAgentId ? { currentAgentId } : {}),
            resolveAgentName: resolveAgentDisplayName,
          },
        )
        : preparedInitialMessages

      // 开跑前再认一次：abort 常发生在 acquire / 写 transcript 的 await 窗口内。
      if (signal.aborted || view.abortController.signal.aborted) {
        try { view.abortController.abort() } catch { /* best effort */ }
        return { kind: 'aborted' }
      }
      // supervisor + session 合并交给 runtime——只绑 session 时，Map-miss 仅掐
      // supervisor 无法打断已在飞的 LLM HTTP。无 AbortSignal.any 时退化为
      // session signal（Electron 41+ 必有 any；测/旧 Node 打 warn）。
      let querySignal: AbortSignal
      if (typeof AbortSignal.any === 'function') {
        querySignal = AbortSignal.any([signal, view.abortController.signal])
      } else {
        ports.log.warn(
          'AbortSignal.any unavailable; query only binds session signal — supervisor-only abort may not cancel in-flight LLM HTTP',
        )
        querySignal = view.abortController.signal
      }
      const baseParams: QueryParams = {
        prompt: effectivePrompt,
        signal: querySignal,
        // Keep the platform-owned pause gate on the shared host → runtime
        // path. This used to be injected separately by Electron and Daemon;
        // keeping it here prevents either host from silently losing pause
        // semantics during orchestration refactors.
        waitIfPaused: async (runtimeSignal) => {
          const aborted = Boolean(runtimeSignal?.aborted || signal.aborted)
          if (view.pauseController.isPaused && !aborted) {
            await deliveryTurn.emit({
              type: StreamEvents.LIFECYCLE,
              payload: {
                phase: 'paused',
                run_id: query.identity.runId,
                thread_id: query.turn.relaySessionId ?? query.identity.conversationId,
              },
            })
          }
          await view.pauseController.waitIfPaused(runtimeSignal)
        },
        attachments: runtimeAttachments,
        initialMessages,
        clientMessageId,
        triggeredBy: runtimeTriggeredBy,
        hostRunId: query.identity.runId,
      }
      const runtime = ports.runtimeOf(session)
      const generator = runtime.query(ports.buildQueryParams(baseParams, query))

      for await (const runtimeEvent of generator) {
        if (querySignal.aborted) {
          try { view.abortController.abort() } catch { /* best effort */ }
          // ：勿提前 return 吞掉 persist/done；drain 白名单终态后再 aborted。
          await drainAbortTerminalEvents(generator, deliveryTurn, runtimeEvent)
          return { kind: 'aborted' }
        }
        const traceId = extractTraceIdFromLifecycleStart(runtimeEvent)
        if (traceId) currentTraceId = traceId
        const deliveredEvent = runtimeEvent.type === StreamEvents.USER
          ? {
              ...runtimeEvent,
              payload: {
                ...(runtimeEvent.payload ?? {}),
                ...(query.turn.senderUserId
                  ? { sender_user_id: query.turn.senderUserId }
                  : {}),
                ...(triggeredBy && triggeredBy !== 'user'
                  ? { triggered_by: triggeredBy }
                  : {}),
              },
            }
          : runtimeEvent
        if (deliveredEvent.type === StreamEvents.USER && query.turn.senderUserId && blockFilePath) {
          const messageId = deliveredEvent.payload.client_event_id
          if (typeof messageId === 'string') {
            rememberMessageSenderAttribution(
              messageId,
              query.turn.senderUserId,
              dirname(blockFilePath),
            )
          }
        }
        await deliveryTurn.emit(deliveredEvent)
        if (deliveredEvent.type === StreamEvents.DONE) {
          try {
            await ports.onTurnTerminalPersisted?.(
              query.identity.sessionId,
              query,
              deliveredEvent,
            )
          } catch (error) {
            ports.log.warn('[query-turn] onTurnTerminalPersisted failed', error)
          }
        }
      }
      return { kind: 'succeeded' }
    } catch (error) {
      // ：取消只认 abort signal——用户点停止必已 abort；禁止猜错误文案/类型
      // （否则 streamHost.fail → terminal errored → 用户气泡误标「发送失败」）。
      if (signal.aborted || view.abortController.signal.aborted) {
        return { kind: 'aborted' }
      }
      return {
        kind: 'failed',
        error: error instanceof Error ? error : new Error(String(error)),
        lifecycleErrorEvent: ports.buildLifecycleErrorEvent(session, error),
      }
    }
  }
}
