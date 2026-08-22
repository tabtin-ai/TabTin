import type { ChatSession } from '@tabtin/chat-client'

/**
 * 任务侧栏是否应隐藏该会话。
 *
 * 与后端 ``fetch_agent_mention_session_ids`` 同口径：API 计算字段
 * ``is_agent_mention_session``，或侧栏 list 明确排除的 id。
 * 禁止用标题 ``[私信@…]`` 判断，也不依赖会话表专用列。
 */
export function isHiddenAgentMentionSession(
  session: Pick<ChatSession, 'id' | 'is_agent_mention_session'>,
  excludedSessionIds?: ReadonlySet<string>,
): boolean {
  if (session.is_agent_mention_session === true) return true
  return excludedSessionIds?.has(session.id) === true
}
