import type { ChatSession } from '@tabtin/chat-client'

/**
 * 会话是否应出现在主侧栏（非空草稿）。
 *
 *  契约优先级：
 * 1. `has_messages`（activity / 新后端权威布尔）
 * 2. `message_count > 0`
 * 3. 两者皆缺时：有 `last_message_at` 视为有消息（旧后端兼容）
 *
 * `has_messages === false` 或 `message_count === 0` 时**不**再被
 * `last_message_at` 抬成非空——避免权威空会话被时间戳误亮。
 */
export function sessionHasVisibleMessages(session: ChatSession): boolean {
  if (typeof session.has_messages === 'boolean') {
    return session.has_messages
  }
  if (typeof session.message_count === 'number') {
    return session.message_count > 0
  }
  return typeof session.last_message_at === 'string' && session.last_message_at.length > 0
}
