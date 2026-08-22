/**
 * Canonical WS Gateway event type registry.
 *
 * Single source of truth for all event type strings used across
 * Electron, Daemon, admindash, and referenced by Android/iOS constants.
 *
 * Agent-related events (stream, external, prompt, permission) are
 * re-exported from @tabtin/agent-wire — the shared protocol package.
 */

import {
  StreamEvents,
  SessionEvents,
  PromptEvents,
  PermissionEvents,
  isStreamEvent,
  isSessionEvent,
  stripStreamPrefix,
} from '@tabtin/agent-wire'
import type {
  StreamEventType,
  SessionEventType,
} from '@tabtin/agent-wire'

// ─── Agent Stream Events ────────────────────────────────────────────
// Re-exported from @tabtin/agent-wire with legacy name for backward compat.

export const AgentStreamEvents = StreamEvents

export type AgentStreamEventType = StreamEventType

// ─── Agent Session Events (session-level topic) ────────────────────
// 与 agent.stream 同属 Chat 运行态事件，但投递到 agent.session.{session_id}，
// 订阅生命周期跟随 ChatSession 激活/离开而非 stream slot cleanup。

export const AgentSessionEvents = SessionEvents

export type AgentSessionEventType = SessionEventType

// ─── Agent Action Events ────────────────────────────────────────────

export const AgentActionEvents = {
  REQUEST: 'agent.action.request',
  RESULT: 'agent.action.result',
  APPROVAL_REQUEST: 'agent.action.approval_request',
  APPROVAL_RESPONSE: 'agent.action.approval_response',
  APPROVAL_RESPONSE_NAK: 'agent.action.approval_response.nak',
  APPROVAL_RESOLVED: 'agent.action.approval_resolved',
  /**
   * v0.4 W2-轮 1（PRD 05 §7.3 / §8.1.2）：Agent.agent_config.approval_memo
   * 写入后由 Django 广播到 organization-level / agent-level topic，让所有客户端
   * （Electron / Daemon / iOS / Android / 其他 Electron 窗口）感知 generation
   * 自增并按需重拉 memo 全量。
   *
   * Payload: `{ agent_id: string, generation: number }`
   *
   * 注意：这是 `agent.action.*`（控制平面），不是 `agent.stream.*`（对话流），
   * 不进对话 stream / interrupt_state，仅作客户端缓存失效信号使用。
   */
  APPROVAL_MEMO_UPDATED: 'agent.action.approval_memo_updated',
  RESOLVED: 'agent.action.resolved',
} as const

export type AgentActionEventType = typeof AgentActionEvents[keyof typeof AgentActionEvents]

// ─── Local Runtime Events (本地 agent-runtime：Daemon / Electron) ──────────────
//
// 这些事件投递到设备 topic（`agent.action.device.{fingerprint}`），由
// 本地 runtime 宿主（DaemonAgentHost / ElectronAgentHost）订阅，用于把
// HITL 响应从前端经 Django 中继到设备端的 pending Promise 上。
//
// 与 `agent.permission.response`（通用权限通道，覆盖跨设备审批等场景）
// 区分：本地 runtime HITL 永远走 `localrt.*` 命名，避免两条 HITL 路径在
// 同一 device topic 上互相冒充对方的 request_id。

export const LocalRuntimeEvents = {
  /**
   * Frontend → Django → Daemon/Electron: user's HITL response (ask_user / review / permission).
   *
   * Envelope payload: `{ request_id: string, response: unknown }`
   * 由宿主的 `pendingAskUserRequests` / `pendingUserInputRequests` 按 request_id 路由。
   *
   * 历史命名：Daemon 早期只有 ask_user/review 两类，"user_response" 通用化覆盖
   * 全部宿主 HITL（含 LocalPermissionHandler 触发的 permission_required）。
   * Electron 路径（W7c）也复用本事件类型，因此 `permission_response` 含义被
   * 包含在 USER_RESPONSE 内——重要：不要为了 Electron 单独再定义 PERMISSION_RESPONSE
   * 常量，否则 Daemon/Electron 两边走不同路径会彻底破坏跨端遥控的同构性。
   */
  USER_RESPONSE: 'localrt.user_response',
  /**
   * Daemon/Electron → Django: confirms whether a forwarded USER_RESPONSE actually
   * resolved a local pending HITL promise.
   */
  USER_RESPONSE_DELIVERY: 'localrt.user_response.delivery',
  // PLAN_APPROVAL_RESPONSE 已删除：plan 审批 HITL 通道废弃，执行流程改为
  // 用户在 PlanProposalCard 上点击「执行」按钮，由本机 IPC 直接调 Django
  // `/api/plan/exit` 完成（不再有跨端 HITL 等待响应的需求）。
} as const

export type LocalRuntimeEventType = typeof LocalRuntimeEvents[keyof typeof LocalRuntimeEvents]

// ─── Gateway Protocol Events ────────────────────────────────────────

export const GatewayProtocolEvents = {
  AUTH: 'auth',
  AUTH_OK: 'auth.ok',
  AUTH_REVOKE: 'auth.revoke',
  SUBSCRIBE: 'subscribe',
  SUBSCRIBE_OK: 'subscribe.ok',
  UNSUBSCRIBE: 'unsubscribe',
  UNSUBSCRIBE_OK: 'unsubscribe.ok',
  RESUME: 'resume',
  RESUME_OK: 'resume.ok',
  PING: 'ping',
  PONG: 'pong',
  TICK: 'tick',
  ERROR: 'error',
} as const

export type GatewayProtocolEventType = typeof GatewayProtocolEvents[keyof typeof GatewayProtocolEvents]

// ─── Domain Events ──────────────────────────────────────────────────

export const DomainEvents = {
  CONTEXT_SYNC: 'context.sync',
  DEVICE_STATUS: 'device.status',
  DEVICE_UNBOUND: 'device.unbound',
  TABLE_DELTA: 'table.events.delta',
  TABLE_FIELD: 'table.events.field',
  TABLE_VIEW: 'table.events.view',
  APP_UPDATE: 'app.update.available',
  GIT_STATUS_REPORT: 'git.status.report',
  GIT_DIFF_REQUEST: 'git.diff.request',
  GIT_DIFF_RESPONSE: 'git.diff.response',
} as const

export type DomainEventType = typeof DomainEvents[keyof typeof DomainEvents]

// ─── Chat Session Presence (private gateway C2S) ─────────────────────
//
// GUI 客户端上报「前台正在看哪个 ChatSession」。私有 gateway 事件，
// 不进入 @tabtin/agent-wire。身份由服务端 consumer 决定，payload 仅含 session_id。
//
// Payload: `{ session_id: string | null }`
// - uuid：进入 / 续期该 session
// - null：离开

export const ChatSessionPresenceEvents = {
  PRESENCE: 'chat.session.presence',
  OK: 'chat.session.presence.ok',
  NAK: 'chat.session.presence.nak',
} as const

/**
 * Private gateway presence timing contract. Not part of `@tabtin/agent-wire`.
 *
 * - On reconnect, immediately re-report the current foreground session.
 * - Refresh the same foreground session at the recommended cadence.
 * - On `presence_unavailable`, wait for the next refresh or reconnect to retry;
 *   never synthesize a local lease.
 *
 * The backend contract test asserts `SERVER_LEASE_SECONDS` stays aligned with
 * its Redis presence TTL.
 */
export const ChatSessionPresenceTiming = {
  SERVER_LEASE_SECONDS: 90,
  RECOMMENDED_REFRESH_SECONDS: 30,
} as const

export type ChatSessionPresenceEventType =
  typeof ChatSessionPresenceEvents[keyof typeof ChatSessionPresenceEvents]

// ─── Tracker Events ────────────────────────────────────────────────────
//
// Tracker 模块波次 4 Stage 2.5 一刀切（2026-05-25）：
// - 类名从历史 ``Goal*`` 命名遗留改为 ``Tracker*``；字符串值 ``goal.*`` → ``tracker.*``。
// - 后端 ``apps/services/common/agent_protocol/constants.py`` 的 ``TrackerEvent``
//   类同步改名（PRD v2 §3 决策 1）。
//
// 单 Skill 执行模型下不再有「步骤」概念，已删除 STEP_STARTED / STEP_FINISHED /
// STEP_SUB_PROGRESS / CHECKPOINT 四个常量。

export const TrackerEvents = {
  PROGRESS: 'tracker.progress',
  RUN_STARTED: 'tracker.run.started',
  RUN_COMPLETED: 'tracker.run.completed',
  RUN_FAILED: 'tracker.run.failed',
  // Module F 续作（2026-05-26）：用户主动取消独立 event，避免与 RUN_FAILED 共用
  // 通道导致"event 是失败 / payload status 是 cancelled"的 wire 语义错位。
  // 后端 ``apps/services/common/agent_protocol/constants.py`` 的
  // ``TrackerEvent.RUN_CANCELLED`` 同步。
  RUN_CANCELLED: 'tracker.run.cancelled',
  NOTIFICATION: 'tracker.notification',
  HEALTH_ALERT: 'tracker.health_alert',
  TRIGGER_FILTERED: 'tracker.trigger.filtered',
} as const

export type TrackerEventType = typeof TrackerEvents[keyof typeof TrackerEvents]

// ─── Context Sync Events ─────────────────────────────────────────────

export const ContextSyncEvents = {
  PREFIX: 'context.sync',
} as const

export type ContextSyncEventType = typeof ContextSyncEvents[keyof typeof ContextSyncEvents]

// ─── Billing Events ─────────────────────────────────────────────────

export const BillingEvents = {
  BUDGET_WARNING: 'billing.budget_warning',
  BUDGET_CRITICAL: 'billing.budget_critical',
  BILLING_BLOCKED: 'billing.billing_blocked',
  BILLING_UNBLOCKED: 'billing.billing_unblocked',
  DEGRADATION_ALERT: 'billing.degradation_alert',
  INVOICE_REFUNDED: 'billing.invoice_refunded',
  CREDITS_RECHARGED: 'billing.credits_recharged',
  CASH_RECHARGED: 'billing.cash_recharged',
  MEMBERSHIP_ACTIVATED: 'billing.membership_activated',
  BALANCE_LOW: 'billing.balance_low',
  MEMBERSHIP_EXPIRING: 'billing.membership_expiring',
  MEMBERSHIP_EXPIRED: 'billing.membership_expired',
  AUTO_RENEW_FAILED: 'billing.auto_renew_failed',
  MEMBERSHIP_DOWNGRADED_OVERLIMIT: 'billing.membership_downgraded_overlimit',
  QUOTA_EXHAUSTED: 'billing.quota_exhausted',
  MEMBERSHIP_RENEWAL_CANCELLED: 'billing.membership_renewal_cancelled',
  BUDGET_RESOLVED: 'billing.budget_resolved',
  USAGE_AGGREGATED: 'billing.usage_aggregated',
  INVOICE_COLLECTION_SUCCEEDED: 'billing.invoice_collection_succeeded',
  INVOICE_COLLECTION_FAILED: 'billing.invoice_collection_failed',
  PLATFORM_REFUND_FAILED: 'billing.platform_refund_failed',
  PLATFORM_REFUND_COMPLETED: 'billing.platform_refund_completed',
  REFUND_PARTIAL_FAILURE: 'billing.refund_partial_failure',
  STORAGE_WARNING: 'billing.storage_warning',
  STORAGE_CRITICAL: 'billing.storage_critical',
  STORAGE_RESOLVED: 'billing.storage_resolved',
  STORAGE_PACKAGE_EXPIRING: 'billing.storage_package_expiring',
  STORAGE_AUTO_RENEW_FAILED: 'billing.storage_auto_renew_failed',
  MEMBER_BUDGET_WARNING: 'billing.member_budget_warning',
  MEMBER_BUDGET_EXHAUSTED: 'billing.member_budget_exhausted',
  MEMBER_BUDGET_RESOLVED: 'billing.member_budget_resolved',
  MEMBER_BUDGET_POLICY_CHANGED: 'billing.member_budget_policy_changed',
} as const

export type BillingEventType = typeof BillingEvents[keyof typeof BillingEvents]

export const BILLING_EVENTS_TOPIC = 'billing.events'

// ─── Media Pipeline Events ───────────────────────────────────────────

export const MediaPipelineEvents = {
  PROGRESS: 'media.pipeline.progress',
  COMPLETE: 'media.pipeline.complete',
  FAILED: 'media.pipeline.failed',
} as const

export type MediaPipelineEventType = typeof MediaPipelineEvents[keyof typeof MediaPipelineEvents]

export const MEDIA_PIPELINE_TOPIC_PREFIX = 'media.pipeline'

// ─── Capabilities ────────────────────────────────────────────────────

export const Capabilities = {
  AGENT_STREAM: 'agent.stream',
  AGENT_ACTION: 'agent.action',
  TABLE_EVENTS: 'table.events',
  CONTEXT_SYNC: 'context.sync',
  DOC_EVENTS: 'doc.events',
  SHARE_EVENTS: 'share.events',
  SESSION_COLLABORATION: 'session.collaboration',
  DOCPARSE_EVENTS: 'docparse.events',
  SCHEDULED_TASKS: 'scheduled.tasks',
  TRACE_STREAM: 'trace.stream',
  ASR_STREAM: 'asr.stream',
  TTS_STREAM: 'tts.stream',
  /** Note: subscribing to ssh.stream topics requires `agent.stream` capability (backend maps ssh.stream → agent.stream). */
  SSH_STREAM: 'ssh.stream',
  CHANNEL_INBOUND: 'channel.inbound',
  CHANNEL_OUTBOUND: 'channel.outbound',
  CHANNEL_STATUS: 'channel.status',
  TRACKER_EVENTS: 'tracker.events',
  GIT_STATUS: 'git.status',
  NOTIFICATIONS: 'notifications',
  EXTENSION_EVENTS: 'extension.events',
  BILLING_EVENTS: 'billing.events',
  MEDIA_PIPELINE: 'media.pipeline',
} as const

export type CapabilityType = typeof Capabilities[keyof typeof Capabilities]

// ─── Helpers ────────────────────────────────────────────────────────

export {
  isStreamEvent as isAgentStreamEvent,
  isSessionEvent as isAgentSessionEvent,
} from '@tabtin/agent-wire'

export function normalizeStreamEventType(eventType: string): string {
  return stripStreamPrefix(eventType)
}
