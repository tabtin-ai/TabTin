/**
 * 从 chat baseURL 推导 orchestration baseURL。
 *
 * 输入: http://localhost:6060/api/chat
 * 输出: http://localhost:6060/api/orchestration
 *
 * 如果 baseURL 不以 /api/chat 结尾，则 fallback 到去尾斜杠后直接替换最后一段。
 */
export function deriveOrchestrationBaseURL(chatBaseURL: string): string {
  const trimmed = chatBaseURL.replace(/\/$/, '')
  const stripped = trimmed.replace(/\/api\/chat$/, '')
  if (stripped !== trimmed) {
    return `${stripped}/api/orchestration`
  }
  const lastSlash = trimmed.lastIndexOf('/')
  return lastSlash > 0 ? `${trimmed.slice(0, lastSlash)}/orchestration` : `${trimmed}/orchestration`
}

/** @deprecated Use deriveOrchestrationBaseURL */
export const deriveMultiagentBaseURL = deriveOrchestrationBaseURL
