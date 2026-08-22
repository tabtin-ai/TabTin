import { StreamEvents } from '@tabtin/agent-wire'

/**
 * 子 Agent 正文与主 Agent 同构，但仍不属于父 session 历史。
 * 旧包装事件与带 `subagent_run_id` 的原事件都不写入父 events.jsonl。
 */
export function shouldPersistInParentSession(
  eventType: string,
  payload?: Record<string, unknown>,
): boolean {
  if (eventType === StreamEvents.SUBAGENT_STREAM_EVENT) return false
  const subagentRunId = payload?.subagent_run_id
  return typeof subagentRunId !== 'string' || subagentRunId.length === 0
}
