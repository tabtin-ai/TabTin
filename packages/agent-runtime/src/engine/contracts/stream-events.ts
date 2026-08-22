/**
 * Runtime-owned stream event type constants（ Stage 5b）。
 *
 * 字面量与 `@tabtin/agent-wire` `StreamEvents` / `ContentBlockEvents` 字节对齐；
 * runtime 生产路径不再 value-import agent-wire 常量表。wire 包仍保留同名常量
 * 供 Django / Renderer / mobile 消费；变更字面量须双端同步。
 */

export const StreamEvents = {
  LIFECYCLE: 'agent.stream.lifecycle',
  STEP: 'agent.stream.step',
  DONE: 'agent.stream.done',
  ASK_USER_REQUIRED: 'agent.stream.ask_user_required',
  ASK_FORM_REQUIRED: 'agent.stream.ask_form_required',
  REQUEST_APPROVAL_REQUIRED: 'agent.stream.request_approval_required',
  SINGLE_HITL_RESOLVED: 'agent.stream.single_hitl_resolved',
  MESSAGE_PERSISTED: 'agent.stream.message_persisted',
  MESSAGE_COMMITTED: 'agent.stream.message_committed',
  TODO: 'agent.stream.todo',
  ROLLBACK: 'agent.stream.rollback',
  UNREVERT: 'agent.stream.unrevert',
  SSH_OUTPUT: 'agent.stream.ssh_output',
  COMPACTION: 'agent.stream.compaction',
  REWIND: 'agent.stream.rewind',
  CONTEXT_PRESSURE: 'agent.stream.context_pressure',
  SUBAGENT_STARTED: 'agent.stream.subagent_started',
  SUBAGENT_COMPLETED: 'agent.stream.subagent_completed',
  SUBAGENT_FAILED: 'agent.stream.subagent_failed',
  SUBAGENT_PROGRESS: 'agent.stream.subagent_progress',
  /**  Wave3：W-H④ 幽灵——runtime 零 emit；主路径用 APPROVAL_REQUESTED。勿删。 */
  SUBAGENT_HITL_REQUIRED: 'agent.stream.subagent_hitl_required',
  /** 已接通：排队态 → Electron status=queued。 */
  SUBAGENT_QUEUED: 'agent.stream.subagent_queued',
  SUBAGENT_STREAM_EVENT: 'agent.stream.subagent_stream_event',
  /**  Wave3：W-H④ 幽灵——runtime 零 emit；生产 proactive 走 Electron IPC。勿删。 */
  SPEAKER_PUSH_MESSAGE: 'agent.stream.speaker_push_message',
  /**  Wave3：W-H④ 幽灵——runtime 零 emit；观测接线另开 issue。勿删。 */
  SUBAGENT_MODEL_CALL: 'agent.stream.subagent_model_call',
  PERSIST_ERROR: 'agent.stream.persist_error',
  CHECKPOINT_FAILED: 'agent.stream.checkpoint_failed',
  CHECKPOINT_SUCCESS: 'agent.stream.checkpoint_success',
  // ：agent.stream.plan / agent.stream.mode 已物理删。
  SYSTEM_NOTICE: 'agent.stream.system_notice',
  MONITOR_STATUS: 'agent.stream.monitor_status',
  LLM_HEARTBEAT: 'agent.stream.llm_heartbeat',
  LLM_REQUEST: 'agent.stream.llm_request',
  LLM_USAGE: 'agent.stream.llm_usage',
  USER: 'agent.stream.user',
  PERSIST_MESSAGE: 'agent.stream.persist_message',
  LLM_SNAPSHOT: 'agent.stream.llm_snapshot',
  STATE_SNAPSHOT: 'agent.stream.state_snapshot',
  BILLING: 'agent.stream.billing',
  PLAN_PROPOSAL: 'agent.stream.plan_proposal',
  MODE_SWITCH_PROPOSAL: 'agent.stream.mode_switch_proposal',
  APPROVAL_REQUESTED: 'agent.stream.approval_requested',
  APPROVAL_RESOLVED: 'agent.stream.approval_resolved',
  MESSAGE_QUEUED: 'agent.stream.message_queued',
  MESSAGE_DEQUEUED: 'agent.stream.message_dequeued',
} as const;

export type StreamEventType = (typeof StreamEvents)[keyof typeof StreamEvents];

export const ContentBlockEvents = {
  MESSAGE_START: 'agent.stream.message_start',
  MESSAGE_DELTA: 'agent.stream.message_delta',
  MESSAGE_STOP: 'agent.stream.message_stop',
  CONTENT_BLOCK_START: 'agent.stream.content_block_start',
  CONTENT_BLOCK_DELTA: 'agent.stream.content_block_delta',
  CONTENT_BLOCK_STOP: 'agent.stream.content_block_stop',
} as const;

export type ContentBlockEventType =
  (typeof ContentBlockEvents)[keyof typeof ContentBlockEvents];

const CONTENT_BLOCK_EVENT_TYPES = new Set<string>(Object.values(ContentBlockEvents));

export function isContentBlockEvent(
  eventType: string,
): eventType is ContentBlockEventType {
  return CONTENT_BLOCK_EVENT_TYPES.has(eventType);
}

/** Envelope protocol version（与 agent-wire stream-content-block 对齐）。 */
export const PROTOCOL_VERSION_V2 = 'v2' as const;
