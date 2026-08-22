import { rememberLocallySubmittedSession } from '@/stores/chat/session/locallySubmittedSessionRegistry'
import type { ChatSession } from '@tabtin/chat-client'

/** 发送上屏时乐观 bump 会话列表预览 / message_count，并清 revert 横幅。 */
export function bumpSessionSidebarOnSend(params: {
  sessionId: string
  displayMessage: string
  sessions: ChatSession[]
  updateSessionInCaches: (sessionId: string, patch: Record<string, unknown>) => void
}): void {
  const previewSource = params.displayMessage ?? ''
  const previewText = previewSource.length > 200 ? previewSource.slice(0, 200) : previewSource
  const currentSession = params.sessions.find(s => s.id === params.sessionId)
  const nextMessageCount = (currentSession?.message_count ?? 0) + 1
  const revertClearPatch = currentSession?.rollback_state?.revert_active
    ? { rollback_state: { ...currentSession.rollback_state, revert_active: false, can_unrevert: false } }
    : {}
  params.updateSessionInCaches(params.sessionId, {
    last_message_at: new Date().toISOString(),
    message_count: nextMessageCount,
    ...(previewText ? { last_message_preview: previewText } : {}),
    ...revertClearPatch,
  })
  rememberLocallySubmittedSession(params.sessionId)
}
