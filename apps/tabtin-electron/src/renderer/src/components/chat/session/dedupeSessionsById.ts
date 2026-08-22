import type { ChatSession } from '@tabtin/chat-client'

export function dedupeSessionsById(sessions: ChatSession[]): ChatSession[] {
  const seen = new Set<string>()
  const result: ChatSession[] = []
  for (const session of sessions) {
    if (seen.has(session.id)) continue
    seen.add(session.id)
    result.push(session)
  }
  return result
}
