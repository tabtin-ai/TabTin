/**
 * host-query.ts — the platform-neutral, normalized input that crosses the
 * AgentHost seam.
 *
 * Electron (`QueryRequest + sender + owner`) and Daemon (`DaemonQueryRequest`)
 * must be mapped into a `HostQuery` *before* entering the host. Everything past
 * `AgentHost.query()` reasons only about `HostQuery`; no `BrowserWindow`,
 * `webContents`, `StreamEventSink`, gateway envelope, `TokenManager`, or platform
 * callback is allowed to ride inside it.
 *
 * The host stays platform-neutral by carrying platform intent as *data*:
 *  - `clientDisconnect` is a standard `AbortSignal` (Electron maps
 *    `webContents 'destroyed'` onto it; Daemon leaves it undefined).
 *  - `runtime` is an already-normalized {@link RuntimeSessionRequest}; the
 *    platform decides *what* to build, `RuntimeSessionLifecycle` decides *when*
 *    to reuse / rebuild.
 */

import type { StreamEvent } from '@tabtin/agent-runtime'
import type { ExecutionOwner } from '../runtime/execution-owner-lifecycle.js'
import type { RuntimeSessionRequest } from '../runtime/runtime-session-factory.js'
import type { QueryWorkspaceSnapshotIncoming } from './query-session-mutate.js'

/** Where a turn originated. Mirrors runtime `QueryParams.triggeredBy`. */
export type HostTriggerSource = 'user' | 'push-notification' | 'continuation'

/**
 * A user-supplied attachment reference (already uploaded / addressable).
 * Platform-neutral: no local file handle, no Electron/Daemon object.
 */
export interface HostAttachment {
  type: string
  file_id?: string
  filename?: string
  mime_type?: string
  size?: number
  url?: string
  preview_url?: string
}

/** Cross-turn history entry (time-ascending). Content may carry tool blocks. */
export interface HostHistoryMessage {
  role: 'user' | 'assistant'
  content: unknown
}

/**
 * Per-turn policy inputs applied to the live session (PD-13 in-place mutate).
 * The authoritative source is Django; wire/IPC `yoloMode`/`approvalMode` are
 * telemetry only. These are platform-neutral values, not runtime resources.
 */
/** 本轮当前 Agent 档案（贴用户消息前注入，支持对话中切 Agent）。 */
export interface HostAgentProfileInput {
  agentName?: string
  /** 配置页「人设与规则」——`Agent.custom_rules` */
  customRules?: string
  /** ：当前 Workspace 现场规则——`Workspace.custom_rules` */
  workspaceRules?: string
}

export interface HostQueryPolicyInput {
  agentId?: string
  agentMode?: string
  approvalMode?: string
  isGroupSpace?: boolean
  yoloModeFromWire?: boolean
  /**
   * 当前执行 Workspace id（ /  follow-up）。
   * 权威 fetch 必须叠 Workspace `approval_grant`；缺省则 ForWorkspace fail-closed。
   */
  workspaceId?: string
  workspaceSnapshot?: QueryWorkspaceSnapshotIncoming
  appContext?: unknown
  /** ：每轮写入 session，供 agent-profile hook 读取。 */
  agentProfile?: HostAgentProfileInput | null
}

/** Stable identity of a single hosted turn. */
export interface HostQueryIdentity {
  /** Business conversation key — the FIFO ordering key. */
  conversationId: string
  /** Host runtime / task key — session registry + pending interaction key. */
  sessionId: string
  /** Unique id of this run within the conversation. */
  runId: string
  /** Execution owner (account/org scope). Drives quiesce + carry-forward isolation. */
  owner: ExecutionOwner
}

/** The domain payload of a turn — prompt, attachments, history, correlation. */
export interface HostTurnInput {
  prompt: string
  /** 高优先级外部指令（如群聊 @）到达时，抢占同一 Agent 的当前 run。 */
  interruptActive?: boolean
  attachments?: HostAttachment[]
  history?: HostHistoryMessage[]
  clientMessageId?: string
  /** 本轮可见 user 消息的真实发送者，随本地 transcript 持久化。 */
  senderUserId?: string
  /** 用户显式选择的 /skill，由 runtime prelude 确定性展开。 */
  skillSlashInvoke?: { skillKey: string; args?: string }
  triggeredBy?: HostTriggerSource
  /** Optional business/display fields forwarded verbatim to runtime.query. */
  displayMessage?: string
  /**
   * 随本轮 user 消息持久化的业务 blocks（ChatInput @ 引用 / table_selection 等）。
   * ：须在 appendUserBlockRecord 时写入本机 transcript，与 DB blocks_json 同源，
   * 否则切会话后 ContextRef 卡会消失。
   */
  userMessageBlocks?: Array<Record<string, unknown>>
  taskId?: string
  /** Real ChatSession UUID used for relay attribution on forward paths. */
  relaySessionId?: string
}

/**
 * Normalized host query. `RuntimeInput` / `Mode` / `ExtraKey` are the platform's
 * runtime-session request generics (Electron `RuntimeBuildInput` etc.); the host
 * never inspects their internals, it only forwards them to
 * `RuntimeSessionLifecycle`.
 */
export interface HostQuery<RuntimeInput, Mode extends string = string, ExtraKey = never> {
  identity: HostQueryIdentity
  runtime: RuntimeSessionRequest<RuntimeInput, Mode, ExtraKey>
  turn: HostTurnInput
  /** Per-turn authoritative policy inputs (PD-13 live mutate). */
  policy?: HostQueryPolicyInput
  /**
   * Fires when the originating client can no longer receive the stream
   * (Electron: window/webContents destroyed). The host aborts the active run.
   * Daemon has no local viewer, so this is undefined there.
   */
  clientDisconnect?: AbortSignal
}

/** Uniform result of a hosted turn — mirrors legacy `{ success, error }`. */
export interface HostQueryResult {
  success: boolean
  error?: string
  /** 用户停止 / abort signal：与 failed 区分，renderer 不得标「发送失败」。 */
  aborted?: boolean
}

/** Host FIFO 队列接受态（IPC ACK 同步带回）。 */
export type HostQueryRunDisposition = 'started' | 'queued'

export interface HostQueryAcceptance {
  runId: string
  runDisposition: HostQueryRunDisposition
  /** queued 时为 1 基位置；started 时省略。 */
  queuePosition?: number
}

export type HostQueryBeginSubmitResult =
  | { ok: false; result: HostQueryResult }
  | { ok: true; acceptance: HostQueryAcceptance; completion: Promise<HostQueryResult> }

/** Terminal classification of a completed turn (single source of truth). */
export type HostQueryOutcome =
  | { kind: 'succeeded' }
  | { kind: 'failed'; error: Error; lifecycleErrorEvent?: StreamEvent }
  | { kind: 'aborted' }
