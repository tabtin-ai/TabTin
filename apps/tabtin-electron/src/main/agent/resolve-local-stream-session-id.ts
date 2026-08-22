const CHAT_SESSION_PREFIX = 'chat-session-'

export function isPromptTaskId(id: string): boolean {
  return id.startsWith('prompt_')
}

/** 剥 `chat-session-` 前缀；无前缀原样返回。 */
export function normalizeChatSessionId(id: string): string {
  if (id.startsWith(CHAT_SESSION_PREFIX) && id.length > CHAT_SESSION_PREFIX.length) {
    return id.slice(CHAT_SESSION_PREFIX.length)
  }
  return id
}

export interface ResolveLocalStreamSessionIdInput {
  conversationId?: string | null
  sessionId?: string | null
  /** 当候选仍是 `prompt_*` 时，用 sessions 表反查业务 UUID。 */
  resolveBusinessId?: (candidate: string) => string | null | undefined
}

/**
 * 选出本地流 envelope 使用的 sessionId：优先稳定业务会话，绝不优先 task id。
 */
export function resolveLocalStreamSessionId(input: ResolveLocalStreamSessionIdInput): string {
  const candidates = [input.conversationId, input.sessionId].filter(
    (value): value is string => typeof value === 'string' && value.length > 0,
  )

  for (const raw of candidates) {
    const normalized = normalizeChatSessionId(raw)
    if (!isPromptTaskId(normalized)) return normalized
  }

  for (const raw of candidates) {
    const lookedUp = input.resolveBusinessId?.(raw)
    if (typeof lookedUp === 'string' && lookedUp.length > 0) {
      const normalized = normalizeChatSessionId(lookedUp)
      if (!isPromptTaskId(normalized)) return normalized
    }
  }

  return normalizeChatSessionId(candidates[0] ?? '')
}
