import type {
  ForwardConversationRequest,
  ForwardEnvelope,
  ForwardDecodeFailure,
} from './conversation/forward-request-decoder.js'
import type {
  ConversationExecutionContext,
  ConversationSupervisorAdapter,
} from './conversation/conversation-supervisor.js'
import type {
  ApprovalMemoStore,
} from './interaction/approval-memo-registry.js'
import type {
  AgentTransportEnvelope,
  AgentTransportPort,
} from './realtime/agent-realtime.js'
import type {
  HumanInteractionContext,
  PlatformApprovalRequest,
} from '@tabtin/agent-runtime/permissions'
import type { StreamEvent } from '@tabtin/agent-runtime/engine'
import type { AgentRunSyncPayload } from '@tabtin/agent-wire'
import type {
  ExecutionOwner,
  ExecutionOwnerLifecycleAdapter,
  OwnerRuntimeBarrier,
} from './runtime/execution-owner-lifecycle.js'
import type { RuntimeSessionRegistry } from './runtime/runtime-session-registry.js'

export interface AgentHostLogger {
  debug(message: string): void
  warn(message: string, context?: Record<string, unknown>): void
  error?(message: string, context?: Record<string, unknown>): void
}

export interface AgentCancelCommand {
  sessionId?: string
  taskId?: string
  envelope?: AgentTransportEnvelope
}

export interface AgentSubagentCancelCommand {
  childId: string
}

/**
 * 子 Agent 对齐：跨设备暂停/恢复进行中的 turn。与 cancel 同走候选身份解析
 * （task_id / thread_id / session_id 都在 envelope 里），故只需透传 envelope。
 */
export interface AgentPauseCommand {
  envelope: AgentTransportEnvelope
}

export interface AgentUserResponseCommand {
  threadId?: string
  requestId?: string
  response: unknown
  batchId?: string
  decisions?: unknown[]
  submitId?: string
  envelope?: AgentTransportEnvelope
}

export interface AgentPermissionCommand {
  type:
    | 'agent.permission.response'
    | 'agent.permission.reset_session'
    | 'agent.permission.mode_update'
  payload: Record<string, unknown>
}

export interface AgentHostCommandHandlers {
  /**
   * `request` 为 null 表示共享 decode 未通过（缺 task_id / 用户内容等）。
   * Electron 可直接忽略；Daemon 仍应用本端 zod 校验并上报 lifecycle.error。
   */
  forward(
    request: ForwardConversationRequest | null,
    envelope: ForwardEnvelope,
  ): void | Promise<void>
  cancel(command: AgentCancelCommand): void | Promise<void>
  cancelSubagent(command: AgentSubagentCancelCommand): void | Promise<void>
  /** 子 Agent 对齐：暂停/恢复进行中的 turn（可选——未实现的宿主忽略该命令）。 */
  pause?(command: AgentPauseCommand): void | Promise<void>
  resume?(command: AgentPauseCommand): void | Promise<void>
  userResponse(command: AgentUserResponseCommand): void | Promise<void>
  permission(command: AgentPermissionCommand): void | Promise<void>
  actionRequest(
    payload: Record<string, unknown>,
    envelope: AgentTransportEnvelope,
  ): void | Promise<void>
}

export interface AgentOwnerAdapter<SessionState>
  extends ExecutionOwnerLifecycleAdapter<SessionState> {
  sessions: RuntimeSessionRegistry<SessionState>
  /**
   * Runtime barrier evaluated in parallel with the supervisor barrier during
   * owner transitions (typically the platform's `RuntimeSessionFactory`).
   *
   * Supervisor / coordinator scope is already quiesced through the built-in
   * seam; provide the factory here so pending `resolve` calls are rejected
   * with `RuntimeOwnerQuiescedError` while EOL drives teardown.
   */
  runtimeBarrier?: OwnerRuntimeBarrier
  initialOwner?: ExecutionOwner
}

/**
 * The only platform seam accepted by AgentHost.
 *
 * Electron and Daemon provide transport and concrete platform actions here;
 * wire routing, conversation ordering and lifecycle state remain inside Host.
 */
export interface AgentPlatformAdapter<Request, Result, SessionState> {
  transport: AgentTransportPort
  deviceId?: string
  logger: AgentHostLogger
  /**
   * @deprecated Legacy per-query execution seam (`conversation.execute`). The
   * main query path must use {@link AgentHost.composeQueryEngine} +
   * {@link AgentHost.submitHostQuery}; do not pass execute closures here.
   */
  conversation?: ConversationSupervisorAdapter<Request, Result>
  commands: AgentHostCommandHandlers
  owner?: AgentOwnerAdapter<SessionState>
  onApprovalMemoChanged?(workspaceId: string): void
  /**
   * conversation 的 run queue 真正转 idle（slot 已释放）后触发。平台在此补
   * push 通知 drain 的 schedule——turn 收尾时（onTurnFinally）排的 drain 会
   * 赶在 slot 释放前被 isBusy 闸吞掉。入参是 runQueue 提交键（conversationId，
   * 可能等于 businessThreadId 而非 threadId，平台需自行映射）。
   */
  onConversationIdle?(conversationId: string): void
  /**
   * ：执行态独立同步。平台负责 publish 到 renderer / 远端 watcher；
   * payload 已由 ConversationRunCoordinator 填好 seq / busy。
   */
  onRunSync?(payload: AgentRunSyncPayload): void
  /** Ensures a local UI target is watching the conversation before HITL emit. */
  ensureHumanInteractionWatcher?(sessionId: string): void | Promise<void>
  /**
   * Publishes a host-originated HITL event to remote clients / persistence.
   * Return true only when the transport accepted the event.
   */
  publishHumanInteraction?(
    context: HumanInteractionContext,
    request: PlatformApprovalRequest,
    event: StreamEvent,
  ): boolean | Promise<boolean>
  /** Mirrors a locally resolved or expired platform approval to other clients. */
  publishHumanInteractionResolution?(
    context: HumanInteractionContext,
    event: StreamEvent,
  ): boolean | Promise<boolean>
  rollback?(request: unknown): Promise<unknown>
  /**
   * PROMPT_FORWARD 解码失败上报钩子。Daemon 用它把 zod 校验失败 relay 成
   * `agent.stream.done(error)`；Electron 用它把生命周期错误发到 renderer。
   *
   * 缺省实现（未提供 hook）：AgentHost 打 error 日志后仍会调用 `commands.forward`
   * 并传入 `null`，与旧路径保持兼容（Electron 的 `commands.forward(null)`
   * 已经 no-op；Daemon 现在应实现此 hook 上报失败）。
   */
  onForwardDecodeFailed?(
    envelope: ForwardEnvelope,
    failure: ForwardDecodeFailure,
  ): void | Promise<void>
}

export type AgentQueryExecutor<Request, Result> = (
  request: Request,
  context: ConversationExecutionContext,
) => Promise<Result>

export interface RegisterApprovalMemoInput {
  sessionId: string
  workspaceId: string
  store: ApprovalMemoStore
}
