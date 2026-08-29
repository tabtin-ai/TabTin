import { randomUUID } from 'node:crypto'
import {
  ApprovalRequestedPayloadSchema,
  ApprovalResolvedPayloadSchema,
  PERMISSION_TIMEOUTS,
  PromptCancelPayloadSchema,
  StreamEvents,
  SubagentCancelPayloadSchema,
} from '@tabtin/agent-wire'
import {
  type HumanInteractionContext,
  type PlatformApprovalRequest,
  type PlatformApprovalResult,
  createInterruptAdapter,
} from '@tabtin/agent-runtime/permissions'
import {
  presentAccessBarrier as presentAccessBarrierCore,
  type AccessBarrier,
  type AccessBarrierResolution,
} from '@tabtin/agent-runtime'
import type { ConversationLifecycleIdentity } from './conversation/conversation-identity.js'
import type {
  AgentPlatformAdapter,
  RegisterApprovalMemoInput,
} from './agent-platform-adapter.js'
import {
  decodeForwardRequestDetailed,
  type ForwardEnvelope,
} from './conversation/forward-request-decoder.js'
import type { ConversationExecutionState } from './conversation/conversation-supervisor.js'
import { ConversationSupervisor } from './conversation/conversation-supervisor.js'
import {
  ConversationStore,
} from './state/conversation/conversation-store.js'
import {
  DefaultQueryTurnPipeline,
  type QueryAbortResult,
  type QueryTurnDataPort,
} from './conversation/query-turn-pipeline.js'
import type { HostQuery, HostQueryBeginSubmitResult, HostQueryResult } from './conversation/host-query.js'
import {
  DefaultRuntimeSessionLifecycle,
  type LivePolicyApplier,
  type RuntimeSessionLifecycle,
} from './runtime/runtime-session-lifecycle.js'
import type { RuntimeResourceFactory } from './runtime/runtime-resource-factory.js'
import type { RuntimeSessionFactory } from './runtime/runtime-session-factory.js'
import type { RuntimeSessionRegistry } from './runtime/runtime-session-registry.js'
import {
  DefaultDeliveryCoordinator,
  type DeliveryCoordinator,
  type DeliveryCoordinatorConfig,
  type DeliveryDurableLayer,
} from './delivery/delivery-coordinator.js'
import { SessionPauseController } from './delivery/session-pause-controller.js'
import type { DeliveryTransportPort } from './delivery/delivery-transport-port.js'
import type { LlmSnapshotLedgerDirectory } from './delivery/llm-snapshot-http-ledger.js'
import { approvalGateSessionId } from './interaction/approval-gate.js'
import type { HumanInteractionDecision } from './interaction/human-interaction-registry.js'
import {
  AgentRealtime,
  AGENT_REALTIME_EVENT_TYPES,
  type AgentCommand,
  type AgentStreamEnvelope,
  type AgentStreamTarget,
  type AgentWatchOptions,
  type PublishBody,
} from './realtime/agent-realtime.js'
import {
  ExecutionOwnerLifecycle,
  type ExecutionOwner,
} from './runtime/execution-owner-lifecycle.js'
import type { ConversationRunSubmission } from './conversation/conversation-run-coordinator.js'
import { createStateRoot, type StateRoot } from './state/root.js'
import type { PendingPlatformApproval } from './state/hitl/hitl-store.js'

type PlatformApprovalResolutionDecision = {
  request_id?: string
  tool_call_id: string
  /** 与 HumanInteractionDecision / wire 四档 outcome 对齐。 */
  outcome: 'allow' | 'deny' | 'cancelled' | 'expired'
  scope?: 'once' | 'thread' | 'always'
  rejection_message?: string
}

/** Type-erased handle for the installed deep-module query pipeline. */
interface HostQueryPipelineHandle {
  submit(query: HostQuery<unknown, string, never>): Promise<HostQueryResult>
  beginSubmit(query: HostQuery<unknown, string, never>): HostQueryBeginSubmitResult
  abort(identity: ConversationLifecycleIdentity): QueryAbortResult
  getState(conversationId: string): ConversationExecutionState
}

/**
 * Access Barrier HITL registry 安全网超时（设计 §8.3）：`HumanInteractionRegistry.
 * waitForInput` 自带的 fallback timer，只用来防止 registry 条目无限挂着——真正
 * 的用户超时由 `presentAccessBarrier`（`@tabtin/agent-runtime`）自己的
 * `interrupt()` race 控制（默认 10 分钟），所以这里给一个远大于它的安全网。
 */
const ACCESS_BARRIER_REGISTRY_SAFETY_TIMEOUT_MS = 24 * 60 * 60 * 1000

/** Type-erased handle for the composed RuntimeSessionLifecycle. */
interface ComposedLifecycleHandle {
  replaceOwner(owner: ExecutionOwner): Promise<boolean>
  disposeOwner(owner: ExecutionOwner): Promise<void>
  stop(): Promise<void>
  readonly owner?: ExecutionOwner
}

export type AgentHostStartOptions = {
  /** 注入已有 StateRoot（如 Electron 在 sharedHost 之前预创建）；缺省新建 */
  state?: StateRoot
}

export class AgentHost<Request, Result, SessionState = unknown> {
  /** 权威状态根（owner / turn / …） */
  readonly state: StateRoot
  private readonly conversationStore: ConversationStore<Request, Result, SessionState>
  private readonly realtime: AgentRealtime
  private readonly ownerLifecycle?: ExecutionOwnerLifecycle<Request, Result, SessionState>
  private hostQueryPipeline?: HostQueryPipelineHandle
  private composedRuntimeLifecycle?: ComposedLifecycleHandle
  private composedDelivery?: DeliveryCoordinator
  private stopped = false

  private constructor(
    private readonly adapter: AgentPlatformAdapter<Request, Result, SessionState>,
    state: StateRoot,
  ) {
    this.state = state
    this.state.hitl.configureApprovalMemos({
      logger: adapter.logger,
      onWorkspaceChanged: adapter.onApprovalMemoChanged,
    })
    this.conversationStore = this.state.conversation as ConversationStore<
      Request,
      Result,
      SessionState
    >
    this.conversationStore.ensureSupervisor(
      adapter.conversation,
      this.state.hitl.interactions,
      {
        onIdle: conversationId => adapter.onConversationIdle?.(conversationId),
        onRunSync: payload => adapter.onRunSync?.(payload),
      },
    )
    if (adapter.owner) {
      this.ownerLifecycle = new ExecutionOwnerLifecycle({
        supervisor: this.conversation,
        sessions: adapter.owner.sessions,
        runtimeBarrier: adapter.owner.runtimeBarrier,
        adapter: adapter.owner,
        initialOwner: adapter.owner.initialOwner,
        ownerStore: this.state.owner,
      })
    }
    this.realtime = new AgentRealtime({
      transport: adapter.transport,
      deviceId: adapter.deviceId,
      logger: adapter.logger,
      onCommand: command => this.dispatchCommand(command),
      onReady: () => {
        void this.state.hitl.approvalMemos.refresh()
      },
    })
  }

  /** Host-owned pending human-interaction registry (shared into the supervisor). */
  get interactions() {
    return this.state.hitl.interactions
  }

  /** Host-owned runtime session registry. */
  get sessions(): RuntimeSessionRegistry<SessionState> {
    return this.state.session.registry as RuntimeSessionRegistry<SessionState>
  }

  private get conversation() {
    return this.conversationStore.supervisor
  }

  static async start<Request, Result, SessionState = unknown>(
    adapter: AgentPlatformAdapter<Request, Result, SessionState>,
    options?: AgentHostStartOptions,
  ): Promise<AgentHost<Request, Result, SessionState>> {
    return new AgentHost(adapter, options?.state ?? createStateRoot())
  }

  /**
   * Submit a normalized {@link HostQuery} through the composed deep modules.
   * Requires {@link composeQueryEngine} / {@link installQueryPipeline} first.
   */
  query(query: HostQuery<unknown, string, never>): Promise<HostQueryResult> {
    return this.submitHostQuery(query)
  }

  // ─── Deep-module query engine (agent-host-full-migration cutover) ─────
  // AgentHost directly composes the three deep modules. The platform supplies
  // only the atomic ports (RuntimeSessionLifecycle / DeliveryCoordinator via
  // `ports`); the pipeline shares this host's coordinator so busy / scope state
  // stays a single source of truth. This replaces the legacy
  // `adapter.conversation.execute` seam once a platform maps its requests into
  // {@link HostQuery} and installs the engine.

  installQueryPipeline<RuntimeInput, Mode extends string, ExtraKey>(
    ports: QueryTurnDataPort<SessionState, RuntimeInput, Mode, ExtraKey>,
  ): DefaultQueryTurnPipeline<SessionState, RuntimeInput, Mode, ExtraKey> {
    const pipeline = new DefaultQueryTurnPipeline<SessionState, RuntimeInput, Mode, ExtraKey>({
      ports,
      supervisor: this.conversation as unknown as ConversationSupervisor<
        HostQuery<RuntimeInput, Mode, ExtraKey>,
        HostQueryResult,
        SessionState
      >,
    })
    this.hostQueryPipeline = pipeline as unknown as HostQueryPipelineHandle
    return pipeline
  }

  /**
   * Compose the three deep modules into this host's query engine in one call.
   * Builds a single {@link ConversationSupervisor} (sharing this host's
   * coordinator and session registry) shared by the pipeline and owner teardown,
   * a {@link DefaultRuntimeSessionLifecycle} over the platform
   * {@link RuntimeResourceFactory}, and a {@link DefaultDeliveryCoordinator} over
   * the platform {@link DeliveryTransportPort}. Owner replace/dispose/stop route
   * through the composed lifecycle so owner reset cancels in-flight pipeline runs.
   */
  composeQueryEngine<RuntimeInput, Mode extends string, CarryForward, ExtraKey>(config: {
    resources: RuntimeResourceFactory<RuntimeInput, SessionState, Mode, CarryForward, ExtraKey>
    /** Reuse an existing factory (single serialization lock over the registry). */
    factory?: RuntimeSessionFactory<RuntimeInput, SessionState, Mode, CarryForward, ExtraKey>
    deliveryTransport: DeliveryTransportPort
    deliveryConfig?: DeliveryCoordinatorConfig
    durable?: DeliveryDurableLayer
    llmSnapshotLedgerDirectory?: LlmSnapshotLedgerDirectory
    buildDataPort: (deps: {
      lifecycle: RuntimeSessionLifecycle<RuntimeInput, SessionState, Mode, ExtraKey>
      delivery: DeliveryCoordinator
    }) => QueryTurnDataPort<SessionState, RuntimeInput, Mode, ExtraKey>
    initialOwner?: ExecutionOwner
    applyLivePolicy?: LivePolicyApplier<SessionState>
  }): {
    pipeline: DefaultQueryTurnPipeline<SessionState, RuntimeInput, Mode, ExtraKey>
    lifecycle: RuntimeSessionLifecycle<RuntimeInput, SessionState, Mode, ExtraKey>
    delivery: DeliveryCoordinator
  } {
    const supervisor = this.conversation as unknown as ConversationSupervisor<
      HostQuery<RuntimeInput, Mode, ExtraKey>,
      HostQueryResult,
      SessionState
    >
    const lifecycle = new DefaultRuntimeSessionLifecycle<
      RuntimeInput, SessionState, Mode, CarryForward, ExtraKey,
      HostQuery<RuntimeInput, Mode, ExtraKey>, HostQueryResult
    >({
      resources: config.resources,
      factory: config.factory,
      supervisor,
      sessions: this.sessions,
      initialOwner: config.initialOwner,
      applyLivePolicy: config.applyLivePolicy,
    })
    const delivery = new DefaultDeliveryCoordinator({
      transport: config.deliveryTransport,
      config: config.deliveryConfig,
      durable: config.durable,
      llmSnapshotLedgerDirectory: config.llmSnapshotLedgerDirectory,
    })
    const ports = config.buildDataPort({ lifecycle, delivery })
    const pipeline = new DefaultQueryTurnPipeline<SessionState, RuntimeInput, Mode, ExtraKey>({
      ports,
      supervisor,
    })
    this.hostQueryPipeline = pipeline as unknown as HostQueryPipelineHandle
    this.composedRuntimeLifecycle = lifecycle as unknown as ComposedLifecycleHandle
    this.composedDelivery = delivery
    return { pipeline, lifecycle, delivery }
  }

  /**
   * Startup / reconnect recover：先 durable outbox，再 drain LLM 快照旁路账本。
   * 宿主应走这里，不要只调 RelaySessionOrchestrator（会漏掉快照回补）。
   */
  async kickRecoverAndBackfill(opts: { activateOwner: boolean }): Promise<void> {
    if (this.composedDelivery) {
      await this.composedDelivery.kickRecoverAndBackfill(opts)
      return
    }
    // compose 前的兜底：只走 durable 注入口时由宿主自己的 orchestrator 负责。
  }

  /** Submit a normalized {@link HostQuery} through the composed deep modules. */
  submitHostQuery(query: HostQuery<unknown, string, never>): Promise<HostQueryResult> {
    this.assertRunning()
    if (!this.hostQueryPipeline) {
      throw new Error('AgentHost query pipeline is not installed')
    }
    const claim = this.beginQuerySessionClaim(query)
    if (!claim.accepted) {
      return Promise.resolve({
        success: false,
        error: 'Provisional session discard is already in progress',
      })
    }
    const begun = this.hostQueryPipeline.beginSubmit(query)
    this.completeQuerySessionClaim(query, claim.tracked, begun.ok)
    return begun.ok ? begun.completion : Promise.resolve(begun.result)
  }

  /**
   * 队列接受后立即返回 disposition；turn 在 completion 后台 settle（ IPC ACK）。
   */
  beginSubmitHostQuery(query: HostQuery<unknown, string, never>): HostQueryBeginSubmitResult {
    this.assertRunning()
    if (!this.hostQueryPipeline) {
      throw new Error('AgentHost query pipeline is not installed')
    }
    const claim = this.beginQuerySessionClaim(query)
    if (!claim.accepted) {
      return {
        ok: false,
        result: {
          success: false,
          error: 'Provisional session discard is already in progress',
        },
      }
    }
    const begun = this.hostQueryPipeline.beginSubmit(query)
    this.completeQuerySessionClaim(query, claim.tracked, begun.ok)
    return begun
  }

  /** Renderer 预建成功后，在应用 Host 登记未接管会话。 */
  registerProvisionalSession(sessionId: string): boolean {
    this.assertRunning()
    return this.state.session.provisional.register(sessionId)
  }

  beginProvisionalSessionClaim(sessionId: string) {
    this.assertRunning()
    return this.state.session.provisional.beginClaim(sessionId)
  }

  completeProvisionalSessionClaim(sessionId: string, accepted: boolean): void {
    this.assertRunning()
    this.state.session.provisional.completeClaim(sessionId, accepted)
  }

  beginProvisionalSessionDiscard(sessionId: string) {
    this.assertRunning()
    return this.state.session.provisional.beginDiscard(sessionId)
  }

  completeProvisionalSessionDiscard(sessionId: string, deleted: boolean): void {
    this.assertRunning()
    this.state.session.provisional.completeDiscard(sessionId, deleted)
  }

  private beginQuerySessionClaim(query: HostQuery<unknown, string, never>) {
    const sessionId = query.turn.relaySessionId ?? query.identity.conversationId
    return this.state.session.provisional.beginClaim(sessionId)
  }

  private completeQuerySessionClaim(
    query: HostQuery<unknown, string, never>,
    tracked: boolean,
    accepted: boolean,
  ): void {
    if (!tracked) return
    const sessionId = query.turn.relaySessionId ?? query.identity.conversationId
    this.state.session.provisional.completeClaim(sessionId, accepted)
  }

  /** True after this Host accepted the run, including completed runs retained for replay dedup. */
  hasAdmittedHostQuery(runId: string): boolean {
    return this.conversation.hasAdmittedRun(runId)
  }

  /** Abort a conversation via the composed query pipeline. */
  abortHostQuery(identity: ConversationLifecycleIdentity): QueryAbortResult {
    this.assertRunning()
    if (!this.hostQueryPipeline) {
      throw new Error('AgentHost query pipeline is not installed')
    }
    return this.hostQueryPipeline.abort(identity)
  }

  abort(identity: ConversationLifecycleIdentity): string[] {
    this.assertRunning()
    return this.conversation.abort(identity)
  }

  /**
   * Cancel **queued** runs + pending HITL for a conversation.
   *
   * Does **not** abort the active/running run — that requires {@link abort}
   * (or {@link abortHostQuery}), which also calls `abortActiveRun`.
   *
   * Host stop paths (`abortSessionByKey`) must call {@link abort} **and** this
   * helper : `abort` alone skips `clearQueued` when queued runs mix
   * different `sessionId`s (`canCancelWholeQueue`), which would leave other
   * task queues alive after a user stop.
   */
  abortConversationRuns(identity: ConversationLifecycleIdentity): string[] {
    this.assertRunning()
    return this.conversation.abortConversationRuns(identity)
  }

  /**
   * Host 级插队：promote 指定排队 run + abort active（不清其它排队）。
   * 供 Composer Zap / 空回车 / HostPending「立即发送」——禁止 renderer 再本地 flush。
   */
  interruptAndPromote(
    identity: ConversationLifecycleIdentity,
    runId: string,
  ): {
    promoted: boolean
    abortedActive: boolean
    abortedRunId: string | null
    queuedRunIds: string[]
  } {
    this.assertRunning()
    return this.conversation.interruptAndPromote(identity, runId)
  }

  /** 取消单条 Host 排队（不 abort active）。供抽屉「移除 / 撤回编辑」。 */
  cancelQueuedRun(
    identity: ConversationLifecycleIdentity,
    runId: string,
  ): { cancelled: boolean; queuedRunIds: string[] } {
    this.assertRunning()
    return this.conversation.cancelQueuedRun(identity, runId)
  }

  getState(conversationId: string): ConversationExecutionState {
    return this.conversationStore.getState(conversationId)
  }

  /**
   * True iff the shared run coordinator considers this conversation busy —
   * i.e. an active run is executing or runs are queued. This is the authoritative
   * "session 忙 / 排队" flag; hosts must not maintain their own shadow set.
   */
  isBusy(conversationId: string): boolean {
    return this.conversationStore.isBusy(conversationId)
  }

  /**
   * Submit an arbitrary execute closure through the shared run coordinator.
   * Used by bypass paths (譬如 compact 旁路) that need FIFO ordering + owner
   * scope quiescing but do not want to go through {@link query} + supervisor
   * (which routes to `adapter.conversation.execute`).
   */
  submitRun<Result>(submission: ConversationRunSubmission<Result>): Promise<Result> {
    this.assertRunning()
    return this.conversation.submitRun(submission)
  }

  watch(
    sessionId: string,
    target: AgentStreamTarget,
    options?: AgentWatchOptions,
  ): void {
    this.assertRunning()
    this.realtime.watch(sessionId, target, options)
  }

  observe(sessionId: string, options?: AgentWatchOptions): void {
    this.assertRunning()
    this.realtime.observe(sessionId, options)
  }

  unwatch(sessionId: string, targetId: string | number): void {
    this.realtime.unwatch(sessionId, targetId)
  }

  removeWatchTarget(targetId: string | number): void {
    this.realtime.removeTarget(targetId)
  }

  publish(sessionId: string, body: PublishBody): number {
    return this.realtime.publish(sessionId, body)
  }

  async requestPlatformApproval(
    context: HumanInteractionContext,
    request: PlatformApprovalRequest,
  ): Promise<PlatformApprovalResult> {
    const sessionId = approvalGateSessionId(context.threadId)
    if (!sessionId) {
      this.adapter.logger.warn('[HITL] platform approval denied: missing thread identity')
      return { approved: false }
    }

    const interrupt = buildPlatformApprovalInterrupt(
      context,
      request,
      PERMISSION_TIMEOUTS.FINAL_MS,
    )
    const timeoutMs = Math.max(0, interrupt.expiresAt - Date.now())
    this.state.hitl.setPendingPlatformApproval(interrupt.batchId, {
      context,
      isStrict: request.isStrict === true,
    })
    try {
      const waiter = this.interactions.waitForInput({
        requestId: interrupt.batchId,
        conversationId: sessionId,
        timeoutMs,
        timeoutValue: {
          batch_id: interrupt.batchId,
          decisions: [{
            request_id: interrupt.batchId,
            tool_call_id: interrupt.batchId,
            outcome: 'expired',
          }],
        },
      })

      const localDeliveries = this.realtime.publish(sessionId, { event: interrupt.event })
      const remoteDelivery = Promise.resolve()
        .then(() => this.adapter.publishHumanInteraction?.(
          context,
          request,
          interrupt.event,
        ) ?? false)
        .catch((error) => {
          this.adapter.logger.warn('[HITL] remote platform approval publish failed', {
            sessionId,
            error: error instanceof Error ? error.message : String(error),
          })
          return false
        })
      const remoteDelivered = localDeliveries === 0
        ? await settleBeforeDeadline(remoteDelivery, interrupt.expiresAt)
        : false

      if (localDeliveries === 0 && !remoteDelivered) {
        this.interactions.resolve(interrupt.batchId, {
          batch_id: interrupt.batchId,
          decisions: [{
            request_id: interrupt.batchId,
            tool_call_id: interrupt.batchId,
            outcome: 'deny',
            rejection_message: 'No approval UI is watching this conversation',
          }],
        })
        this.adapter.logger.warn('[HITL] platform approval denied: no delivery target', {
          sessionId,
        })
        return { approved: false }
      }

      const response = await waiter
      if (isExpiredPlatformApprovalResponse(response, interrupt.batchId)) {
        this.publishPlatformApprovalResolution(context, interrupt.batchId, [{
          request_id: interrupt.batchId,
          tool_call_id: interrupt.batchId,
          outcome: 'expired',
        }])
      }
      return readPlatformApprovalDecision(response, interrupt.batchId, request.isStrict === true)
    } finally {
      this.state.hitl.deletePendingPlatformApproval(interrupt.batchId)
    }
  }

  /**
   * Access Barrier HITL：浏览器编排出口拿到 `AccessBarrier` 后经此落到真实
   * 会话通道——委托 `presentAccessBarrier`（`@tabtin/agent-runtime`）做「emit
   * 专用卡片 + interrupt 挂起 + 超时」，本方法只负责把 threadId 解析成
   * session 并组出 `InterruptPort`（`realtime.publish` + `interactions.waitForInput`）。
   *
   * 同时对 session 的 `SessionPauseController.acquireHitlPark()`：主循环已有
   * `waitIfPaused` 边界，shell 把 `browser open` 甩后台后模型也不会继续跑工具。
   * `finally releaseHitlPark` 覆盖用户点选 / 超时 / abort cancel（假死双清）。
   *
   * 与 {@link requestPlatformApproval} 同构但更薄：不做审批 memo / 远程 fanout /
   * 零投递探测——关联不到 session（`approvalGateSessionId` 判空）直接诚实失败
   * `host_unavailable`，其余交给 `presentAccessBarrier` 自身的运行时模式判定
   * 与超时。`interactions.waitForInput` 的 `timeoutMs` 只是内存安全网（防止
   * registry 条目无限挂着），真正的用户超时由 `presentAccessBarrier` 的
   * `interrupt()` race 控制。
   */
  async presentAccessBarrier(
    context: HumanInteractionContext,
    barrier: AccessBarrier,
  ): Promise<AccessBarrierResolution> {
    const sessionId = approvalGateSessionId(context.threadId)
    if (!sessionId) {
      this.adapter.logger.warn('[access_barrier] host_unavailable: missing thread identity')
      return { action: 'host_unavailable' }
    }
    // 会话级 park：与 shell wait_ms 后台化正交——卡挂着时主循环 waitIfPaused 停住，
    // 避免「弹卡了模型还在跑」。finally 覆盖决议 / 超时 / abort cancel（双清）。
    const pauseController = resolveSessionPauseController(this.sessions.get(sessionId))
    pauseController?.acquireHitlPark()
    try {
      const interrupt = createInterruptAdapter({
        emitStreamEvent: (event) => { this.realtime.publish(sessionId, { event }) },
        waitForUserInput: (requestId) => this.interactions.waitForInput({
          requestId,
          conversationId: sessionId,
          timeoutMs: ACCESS_BARRIER_REGISTRY_SAFETY_TIMEOUT_MS,
        }),
        threadId: context.threadId,
      })
      return await presentAccessBarrierCore({
        interrupt,
        barrier,
        runtimeMode: context.interactionMode,
        sessionId,
        // 与 interrupt 开卡同出口：超时/取消/点选后对称补发 single_hitl_resolved 收卡。
        emitStreamEvent: (event) => { this.realtime.publish(sessionId, { event }) },
      })
    } finally {
      pauseController?.releaseHitlPark()
    }
  }

  broadcast(envelope: AgentStreamEnvelope): number {
    return this.realtime.broadcast(envelope)
  }

  registerApprovalMemo(input: RegisterApprovalMemoInput): void {
    this.state.hitl.approvalMemos.register(input.sessionId, input.workspaceId, input.store)
  }

  unregisterApprovalMemo(sessionId: string): void {
    this.state.hitl.approvalMemos.unregister(sessionId)
  }

  getApprovalMemoStore(sessionId: string) {
    return this.state.hitl.approvalMemos.get(sessionId)
  }

  refreshApprovalMemos(workspaceId?: string): Promise<void> {
    return this.state.hitl.approvalMemos.refresh(workspaceId)
  }

  resolveApprovalBatch(
    batchId: string,
    decisions: HumanInteractionDecision[],
    options: { mirrorPlatformResolution?: boolean } = {},
  ): boolean {
    const pending = this.state.hitl.getPendingPlatformApproval(batchId)
    const normalized = normalizePlatformApprovalDecisions(pending, decisions)
    const resolved = this.interactions.resolveBatch({
      batchId,
      decisions: normalized.decisions,
    })
    if (
      resolved
      && pending
      && (options.mirrorPlatformResolution || normalized.correctedStrictScope)
    ) {
      this.publishPlatformApprovalResolution(
        pending.context,
        batchId,
        normalized.decisions,
      )
    }
    return resolved
  }

  private publishPlatformApprovalResolution(
    context: HumanInteractionContext,
    batchId: string,
    decisions: PlatformApprovalResolutionDecision[],
  ): void {
    const event = buildPlatformApprovalResolvedEvent(batchId, decisions)
    void Promise.resolve(
      this.adapter.publishHumanInteractionResolution?.(context, event) ?? false,
    ).catch((error) => {
      this.adapter.logger.warn('[HITL] remote platform approval resolution publish failed', {
        batchId,
        error: error instanceof Error ? error.message : String(error),
      })
    })
  }

  resolveHumanAnswer(requestId: string, response: unknown): boolean {
    return this.interactions.resolveAnswer(requestId, response)
  }

  // ─── Facade: host-owned lifecycle / registries ───────────────────────
  // AgentHost 自持 sessions / interactions registry、delivery buffer 与
  // conversation supervisor；平台通过这些门面方法访问，不再直取内部 core。

  getRunState(conversationId: string) {
    return this.conversationStore.getRunState(conversationId)
  }

  syncCurrentRunState(conversationId: string): boolean {
    this.assertRunning()
    return this.conversationStore.syncCurrentRunState(conversationId)
  }

  async cancelSessionDelivery(sessionId: string): Promise<void> {
    this.state.delivery.cancelSessionDelivery(sessionId)
  }

  quiesceScope(scopeId: string): void {
    this.conversation.quiesceScope(scopeId)
  }

  resumeScope(scopeId: string): void {
    this.conversation.restoreScope(scopeId)
  }

  waitForScopeIdle(scopeId: string): Promise<void> {
    return this.conversation.waitForScopeIdle(scopeId)
  }

  quiesceConversation(identity: ConversationLifecycleIdentity): string[] {
    return this.conversation.quiesceConversation(identity)
  }

  resumeConversation(conversationId: string): void {
    this.conversation.restore(conversationId)
  }

  getBusyConversationIds(): string[] {
    return this.conversationStore.getBusyConversationIds()
  }

  removeSession(sessionId: string): boolean {
    return this.sessions.delete(sessionId)
  }

  replaceExecutionOwner(owner: ExecutionOwner): Promise<boolean> {
    this.assertRunning()
    if (this.composedRuntimeLifecycle) {
      return this.composedRuntimeLifecycle.replaceOwner(owner)
    }
    if (!this.ownerLifecycle) {
      throw new Error('AgentPlatformAdapter.owner is required for owner replacement')
    }
    return this.ownerLifecycle.replace(owner)
  }

  clearExecutionOwner(): Promise<boolean> {
    this.assertRunning()
    if (!this.ownerLifecycle?.owner) return Promise.resolve(false)
    return this.ownerLifecycle.clear(this.ownerLifecycle.owner)
  }

  /**
   * Standardized "reset for this owner" flow. Runs the same
   * quiesce → interrupt → wait → teardown → disposeOwnerResources
   * sequence as {@link clearExecutionOwner}, but works regardless of
   * whether EOL currently tracks the owner. Intended for platform
   * "logout / reset account sync" entry points where the caller supplies
   * the owner being cleared.
   */
  disposeExecutionOwner(owner: ExecutionOwner): Promise<void> {
    this.assertRunning()
    if (this.composedRuntimeLifecycle) {
      return this.composedRuntimeLifecycle.disposeOwner(owner)
    }
    if (!this.ownerLifecycle) {
      throw new Error('AgentPlatformAdapter.owner is required for owner disposal')
    }
    return this.ownerLifecycle.disposeOwner(owner)
  }

  rollback(request: unknown): Promise<unknown> {
    this.assertRunning()
    if (!this.adapter.rollback) {
      throw new Error('AgentPlatformAdapter.rollback is not configured')
    }
    return this.adapter.rollback(request)
  }

  async stop(): Promise<void> {
    if (this.stopped) return
    if (this.composedRuntimeLifecycle) {
      await this.composedRuntimeLifecycle.stop()
    } else if (this.ownerLifecycle?.owner) {
      await this.ownerLifecycle.clear(this.ownerLifecycle.owner)
    }
    if (this.composedDelivery) {
      await this.composedDelivery.stop()
    }
    this.stopped = true
    this.realtime.dispose()
    this.state.hitl.clear()
    this.state.delivery.clearAll()
    this.state.session.provisional.clear()
    this.conversation.dispose()
    this.sessions.clear()
    this.interactions.clear()
  }

  private dispatchCommand(command: AgentCommand): void {
    switch (command.type) {
      case AGENT_REALTIME_EVENT_TYPES.PROMPT_FORWARD: {
        this.dispatchForward(command.envelope)
        return
      }
      case AGENT_REALTIME_EVENT_TYPES.PROMPT_CANCEL: {
        const parsed = PromptCancelPayloadSchema.safeParse(command.payload)
        if (!parsed.success) {
          this.adapter.logger.warn(
            `Ignored prompt.cancel with invalid payload: ${parsed.error.message}`,
          )
          return
        }
        this.runCommand(() => this.adapter.commands.cancel({
          sessionId: readString(command.payload.session_id)
            ?? readString(command.envelope.session_id)
            ?? readString(command.envelope.thread_id),
          taskId: readString(parsed.data.task_id),
          envelope: command.envelope,
        }))
        return
      }
      case AGENT_REALTIME_EVENT_TYPES.PROMPT_PAUSE: {
        const pause = this.adapter.commands.pause
        if (pause) this.runCommand(() => pause({ envelope: command.envelope }))
        return
      }
      case AGENT_REALTIME_EVENT_TYPES.PROMPT_RESUME: {
        const resume = this.adapter.commands.resume
        if (resume) this.runCommand(() => resume({ envelope: command.envelope }))
        return
      }
      case AGENT_REALTIME_EVENT_TYPES.SUBAGENT_CANCEL: {
        const parsed = SubagentCancelPayloadSchema.safeParse(command.payload)
        if (!parsed.success) {
          this.adapter.logger.warn(
            `Ignored subagent cancel with invalid payload: ${parsed.error.message}`,
          )
          return
        }
        this.runCommand(() => this.adapter.commands.cancelSubagent({
          childId: parsed.data.child_id,
        }))
        return
      }
      case AGENT_REALTIME_EVENT_TYPES.USER_RESPONSE:
      case AGENT_REALTIME_EVENT_TYPES.APPROVAL_RESPONSE: {
        const response = command.payload.response
        const responseRecord = asRecord(response)
        this.runCommand(() => this.adapter.commands.userResponse({
          threadId: readString(command.payload.thread_id)
            ?? readString(command.envelope.thread_id),
          requestId: readString(command.payload.request_id),
          response,
          batchId: readString(responseRecord.batch_id),
          decisions: Array.isArray(responseRecord.decisions)
            ? responseRecord.decisions
            : undefined,
          submitId: readString(command.payload.submit_id),
          envelope: command.envelope,
        }))
        return
      }
      case AGENT_REALTIME_EVENT_TYPES.APPROVAL_MEMO_UPDATED: {
        const workspaceId = readString(command.payload.workspace_id)
        const generation = command.payload.generation
        this.state.hitl.approvalMemos.routeUpdate(
          workspaceId ?? '',
          typeof generation === 'number' ? generation : -1,
        )
        return
      }
      case AGENT_REALTIME_EVENT_TYPES.PERMISSION_RESPONSE:
      case AGENT_REALTIME_EVENT_TYPES.PERMISSION_RESET_SESSION:
      case AGENT_REALTIME_EVENT_TYPES.PERMISSION_MODE_UPDATE:
        this.runCommand(() => this.adapter.commands.permission({
          type: command.type,
          payload: command.payload,
        }))
        return
      case AGENT_REALTIME_EVENT_TYPES.ACTION_REQUEST:
        this.runCommand(() =>
          this.adapter.commands.actionRequest(command.payload, command.envelope))
    }
  }

  private dispatchForward(envelope: ForwardEnvelope): void {
    const result = decodeForwardRequestDetailed(envelope, {
      warn: (message) => this.adapter.logger.warn(message),
      debug: (message) => this.adapter.logger.debug(message),
    })
    if (!result.ok) {
      const failure = result
      const errorContext = { reason: failure.reason, error: failure.error }
      if (this.adapter.logger.error) {
        this.adapter.logger.error(
          `Agent forward decode failed: ${failure.error}`,
          errorContext,
        )
      } else {
        this.adapter.logger.warn(
          `Agent forward decode failed: ${failure.error}`,
          errorContext,
        )
      }
      if (this.adapter.onForwardDecodeFailed) {
        this.runCommand(() =>
          this.adapter.onForwardDecodeFailed!(envelope, failure))
      } else {
        // 兼容旧接线：宿主未实现 hook 时仍调用 commands.forward(null)，
        // 让宿主自行决定是否走 legacy handling（Electron 直接忽略；Daemon
        // 早期通过再次 safeParse 走 reportPromptForwardFailure）。
        this.runCommand(() => this.adapter.commands.forward(null, envelope))
      }
      return
    }
    this.runCommand(() => this.adapter.commands.forward(result.request, envelope))
  }

  private runCommand(command: () => void | Promise<void>): void {
    try {
      void Promise.resolve(command()).catch((error: unknown) => {
        this.adapter.logger.warn('Agent command failed', { error })
      })
    } catch (error) {
      this.adapter.logger.warn('Agent command failed', { error })
    }
  }

  private assertRunning(): void {
    if (this.stopped) throw new Error('AgentHost is stopped')
  }
}

function buildPlatformApprovalInterrupt(
  context: HumanInteractionContext,
  request: PlatformApprovalRequest,
  defaultTimeoutMs: number,
) {
  const batchId = randomUUID()
  const timeoutMs = request.timeoutMs && request.timeoutMs > 0
    ? request.timeoutMs
    : defaultTimeoutMs
  const expiresAt = Date.now() + timeoutMs
  const payload = ApprovalRequestedPayloadSchema.parse({
    batch_id: batchId,
    event_id: `approval-req:${batchId}`,
    approval_type: 'tool_permission',
    action_requests: [{
      request_id: batchId,
      tool_call_id: batchId,
      tool_name: request.actionType,
      tool_input: {
        detail: request.detail,
        ...(request.reason ? { reason: request.reason } : {}),
      },
      decision_reason: {
        type: 'user_interactive',
        scope: 'once',
      },
      ask_hint: {
        summary: request.reason || request.detail || request.actionType,
        suggested_scope: 'once',
      },
      allowed_scopes: request.isStrict
        ? ['once']
        : ['once', 'thread', 'always'],
      allowed_outcomes: ['allow', 'deny'],
      risk_level: 'high',
      description: request.detail,
    }],
    runtime_mode: context.interactionMode,
    expires_at: expiresAt,
    schema_version: 1,
    approval_source: 'platform',
  })
  return {
    batchId,
    expiresAt,
    event: {
      type: StreamEvents.APPROVAL_REQUESTED,
      payload,
    },
  }
}

function normalizePlatformApprovalDecisions(
  pending: PendingPlatformApproval | undefined,
  decisions: HumanInteractionDecision[],
): {
  decisions: HumanInteractionDecision[]
  correctedStrictScope: boolean
} {
  if (!pending?.isStrict) {
    return { decisions, correctedStrictScope: false }
  }
  let correctedStrictScope = false
  const normalized = decisions.map((decision) => {
    if (decision.outcome !== 'allow' || decision.scope === 'once') return decision
    correctedStrictScope = true
    return {
      request_id: decision.request_id,
      tool_call_id: decision.tool_call_id,
      outcome: 'deny' as const,
      rejection_message: 'Strict approval only permits one-time authorization',
    }
  })
  return { decisions: normalized, correctedStrictScope }
}

function readPlatformApprovalDecision(
  response: unknown,
  batchId: string,
  isStrict: boolean,
): PlatformApprovalResult {
  if (!response || typeof response !== 'object') return { approved: false }
  const decisions = (response as { decisions?: unknown }).decisions
  if (!Array.isArray(decisions)) return { approved: false }
  const decision = decisions.find((entry) => {
    if (!entry || typeof entry !== 'object') return false
    const value = entry as { request_id?: unknown; tool_call_id?: unknown }
    return value.request_id === batchId || value.tool_call_id === batchId
  })
  if (!decision || typeof decision !== 'object') return { approved: false }
  const value = decision as { outcome?: unknown; scope?: unknown }
  if (value.outcome !== 'allow') return { approved: false }
  if (isStrict && value.scope !== 'once') {
    return { approved: false }
  }
  const scope = value.scope === 'once' || value.scope === 'thread' || value.scope === 'always'
    ? value.scope
    : undefined
  return { approved: true, ...(scope ? { scope } : {}) }
}

function isExpiredPlatformApprovalResponse(response: unknown, batchId: string): boolean {
  if (!response || typeof response !== 'object') return false
  const decisions = (response as { decisions?: unknown }).decisions
  if (!Array.isArray(decisions)) return false
  return decisions.some((entry) => {
    if (!entry || typeof entry !== 'object') return false
    const value = entry as {
      request_id?: unknown
      tool_call_id?: unknown
      outcome?: unknown
    }
    const matches = value.request_id === batchId || value.tool_call_id === batchId
    return matches && value.outcome === 'expired'
  })
}

function buildPlatformApprovalResolvedEvent(
  batchId: string,
  decisions: PlatformApprovalResolutionDecision[],
) {
  const payload = ApprovalResolvedPayloadSchema.parse({
    batch_id: batchId,
    event_id: `approval-res:${batchId}:${decisions.map(decision => decision.outcome).join(',')}`,
    decisions: decisions.map(decision => ({
      ...decision,
      request_id: decision.request_id ?? decision.tool_call_id,
    })),
    schema_version: 1,
  })
  return {
    type: StreamEvents.APPROVAL_RESOLVED,
    payload,
  }
}

/**
 * HostState（Electron）等 session 载体上挂着 `pauseController`；Daemon / 测试桩
 * 可能没有。duck-type 取用，避免 AgentHost 绑死具体 SessionState 形状。
 */
function resolveSessionPauseController(
  session: unknown,
): SessionPauseController | undefined {
  if (!session || typeof session !== 'object') return undefined
  const pauseController = (session as { pauseController?: unknown }).pauseController
  return pauseController instanceof SessionPauseController ? pauseController : undefined
}

async function settleBeforeDeadline(
  delivery: Promise<boolean>,
  expiresAt: number,
): Promise<boolean> {
  const remainingMs = Math.max(0, expiresAt - Date.now())
  if (remainingMs === 0) return false
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      delivery,
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), remainingMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}
