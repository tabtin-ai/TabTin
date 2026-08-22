import type { ThreadChatMessagesExport } from '@/types/agent-debug'

export type { ThreadChatMessageExportItem, ThreadChatMessagesExport } from '@/types/agent-debug'

export function buildChatMessagesFilename(
  threadId: string | null | undefined,
  payload: Pick<ThreadChatMessagesExport, 'session_id'>
): string {
  const id = payload.session_id || threadId || 'session'
  return `chat-messages-${id}.json`
}
