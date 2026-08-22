import type { ChatSession } from '@tabtin/chat-client'

const manualTitleBySessionId = new Map<string, string>()

export function markSessionManualTitle(sessionId: string, title: string): void {
  manualTitleBySessionId.set(sessionId, title)
}

export function shouldApplyGeneratedTitleUpdate(
  sessionId: string,
  title: string,
  session?: Pick<ChatSession, 'title' | 'title_is_default'>,
): boolean {
  const manualTitle = manualTitleBySessionId.get(sessionId)
  if (manualTitle != null && manualTitle !== title) {
    return false
  }
  if (session?.title_is_default === false) {
    const currentTitle = (session.title ?? '').trim()
    if (currentTitle && currentTitle !== title.trim()) {
      return false
    }
  }
  return true
}

/** @internal 仅供测试清理 module-scope 状态。 */
export function _resetManualTitleDedupeForTests(): void {
  manualTitleBySessionId.clear()
}
