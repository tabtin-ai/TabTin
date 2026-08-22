/**
 * Workspace 快照「跳转到对话」目标解析。
 *
 * 优先 agent_run → decision-context / 列表上的会话锚点 → 无可跳目标。
 */

export interface CheckpointBrowseListItem {
  agent_run_id?: string | null
  anchor_session_id?: string | null
  anchor_message_id?: string | null
}

export interface CheckpointDecisionContextLike {
  anchor_session_id?: string | null
  anchor_message_id?: string | null
  context?: {
    agent_run_id?: string | null
    assistant_message_id?: string | null
    user_message_id?: string | null
  } | null
}

export type CheckpointNavigateTarget =
  | { kind: 'agent_run'; agentRunId: string; sessionId?: string; messageId?: string }
  | { kind: 'session'; sessionId: string; messageId?: string }
  | { kind: 'none' }

function nonEmpty(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed ? trimmed : undefined
}

/** 列表项是否已具备可跳对话的线索（无需再拉 decision-context）。 */
export function checkpointHasConversationTarget(item: CheckpointBrowseListItem): boolean {
  return Boolean(nonEmpty(item.agent_run_id) || nonEmpty(item.anchor_session_id))
}

export function filterCheckpointsWithConversationTarget<T extends CheckpointBrowseListItem>(
  items: T[],
): T[] {
  return items.filter(checkpointHasConversationTarget)
}

export function resolveCheckpointNavigateTarget(
  item: CheckpointBrowseListItem,
  ctx?: CheckpointDecisionContextLike | null,
): CheckpointNavigateTarget {
  const listAgentRunId = nonEmpty(item.agent_run_id)
  if (listAgentRunId) {
    return { kind: 'agent_run', agentRunId: listAgentRunId }
  }

  const ctxAgentRunId = nonEmpty(ctx?.context?.agent_run_id)
  const sessionId = nonEmpty(ctx?.anchor_session_id) || nonEmpty(item.anchor_session_id)
  const messageId =
    nonEmpty(ctx?.anchor_message_id)
    || nonEmpty(ctx?.context?.assistant_message_id)
    || nonEmpty(ctx?.context?.user_message_id)
    || nonEmpty(item.anchor_message_id)

  if (ctxAgentRunId) {
    return {
      kind: 'agent_run',
      agentRunId: ctxAgentRunId,
      sessionId,
      messageId,
    }
  }

  if (sessionId) {
    return { kind: 'session', sessionId, messageId }
  }

  return { kind: 'none' }
}
