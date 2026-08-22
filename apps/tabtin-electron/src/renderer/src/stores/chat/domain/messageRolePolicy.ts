import type { ChatMessage } from '@tabtin/chat-client'

const SYSTEM_AUTHORED_MESSAGE_KINDS = new Set([
  'environment_context',
  'agent_profile_context',
  'system_prompt_context',
  'compaction_summary',
  'hitl_interaction',
  'external_archive_context',
])

const SYSTEM_AUTHORED_MESSAGE_SOURCES = new Set([
  'skill_invoke',
  'tool_injected',
])

export function isSystemAuthoredMessage(
  message: Pick<ChatMessage, 'message_kind' | 'metadata'> & {
    source?: unknown
    triggered_by?: unknown
  },
): boolean {
  if (SYSTEM_AUTHORED_MESSAGE_KINDS.has(message.message_kind ?? '')) return true
  const metadata = message.metadata && typeof message.metadata === 'object'
    ? message.metadata as Record<string, unknown>
    : {}
  const source = message.source ?? metadata.source
  const triggeredBy = message.triggered_by ?? metadata.triggered_by
  return (typeof source === 'string' && SYSTEM_AUTHORED_MESSAGE_SOURCES.has(source))
    || triggeredBy === 'push-notification'
    || triggeredBy === 'parent_midflight'
}
