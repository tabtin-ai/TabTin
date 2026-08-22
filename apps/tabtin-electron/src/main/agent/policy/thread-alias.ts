/**
 * ：thread 标识别名归一（进程内共享上下文的公共基建）。
 *
 * host 侧写各类 thread-scope 上下文用 sessionId（可能带 `chat-session-` 前缀），
 * 消费侧（FrontendActionBridge / 浏览器路由 / CLI bridge）读 action 的 `_thread_id`
 * （可能不带前缀）。二者靠本模块的别名归一桥接——写 / 读都覆盖「带前缀」和「不带前缀」
 * 两种形态，保证同一对话在不同子系统间对得上。
 *
 * `interaction-mode-context` 与 `approval-mode-context` 共用此逻辑，避免前缀规则漂移。
 */
export const CHAT_SESSION_PREFIX = 'chat-session-'

export function normalizeThreadAliases(threadId: string | undefined | null): string[] {
  if (typeof threadId !== 'string') return []
  const trimmed = threadId.trim()
  if (!trimmed) return []

  const aliases = new Set<string>([trimmed])
  if (trimmed.startsWith(CHAT_SESSION_PREFIX)) {
    const raw = trimmed.slice(CHAT_SESSION_PREFIX.length)
    if (raw) aliases.add(raw)
  } else {
    aliases.add(`${CHAT_SESSION_PREFIX}${trimmed}`)
  }
  return [...aliases]
}
