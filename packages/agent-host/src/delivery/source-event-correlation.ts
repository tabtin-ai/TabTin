import type { StreamEvent } from '@tabtin/agent-runtime'

const MAIN_TURN_CORRELATED_EVENT_TYPES: ReadonlySet<string> = new Set([
  'agent.stream.lifecycle',
  'agent.stream.done',
  'agent.stream.assistant',
  'agent.stream.persist_message',
  'agent.stream.message_start',
  'agent.stream.message_delta',
  'agent.stream.message_stop',
  'agent.stream.content_block_start',
  'agent.stream.content_block_delta',
  'agent.stream.content_block_stop',
])

function isSubagentPayload(payload: Record<string, unknown>): boolean {
  return Boolean(
    payload.subagent_run_id
      || payload.child_trace_id
      || payload.parent_trace_id,
  )
}
/**
 * 把本轮用户提交的稳定 client event id 焊到主轮 assistant / lifecycle 事件上。
 *
 * runtime 的 run_id / trace_id 是执行身份，不能用来判断一条 assistant 消息由哪条
 * user 消息触发。宿主掌握 QueryRequest.clientMessageId，因此在 stream 离开宿主前
 * 统一补 `source_client_event_id`。子 Agent raw stream 不继承父 user 身份，避免移动端
 * 把子执行消息误配为主轮回复。
 *
 * clientMessageId 缺失或事件不属于相关集合时原对象透传，保持旧 IPC / WS 客户端兼容。
 */
export function correlateSourceClientEvent(
  event: StreamEvent,
  clientMessageId?: string,
): StreamEvent {
  if (!clientMessageId || !MAIN_TURN_CORRELATED_EVENT_TYPES.has(event.type)) {
    return event
  }
  if (isSubagentPayload(event.payload)) return event
  if (event.payload.source_client_event_id === clientMessageId) return event

  return {
    ...event,
    payload: {
      ...event.payload,
      source_client_event_id: clientMessageId,
    },
  }
}
