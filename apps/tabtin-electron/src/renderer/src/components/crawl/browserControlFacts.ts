import type { ChatMessage } from '@tabtin/chat-client'

export type BrowserControlFactAction = 'take-over' | 'hand-back'

export function uniqueSessionIds(sessionIds: readonly string[]): string[] {
  return [...new Set(sessionIds.filter(Boolean))]
}

export function injectBrowserControlFacts(options: {
  action: BrowserControlFactAction
  sessionIds: readonly string[]
  releasedSessionIds?: readonly string[]
  defaultContent: string
  releasedContent?: string
  inject: (sessionId: string, message: ChatMessage) => void
}): void {
  const {
    action,
    sessionIds,
    releasedSessionIds = [],
    defaultContent,
    releasedContent,
    inject,
  } = options
  const released = new Set(uniqueSessionIds(releasedSessionIds))
  const systemFact = action === 'take-over'
    ? 'browser_control_taken_over'
    : 'browser_control_handed_back'

  for (const sessionId of uniqueSessionIds(sessionIds)) {
    const message = {
      id: `browser-control-${action}-${crypto.randomUUID()}`,
      role: 'system',
      content: releasedContent && released.has(sessionId)
        ? releasedContent
        : defaultContent,
      created_at: new Date().toISOString(),
      metadata: { system_fact: systemFact },
    } satisfies ChatMessage
    inject(sessionId, message)
  }
}
