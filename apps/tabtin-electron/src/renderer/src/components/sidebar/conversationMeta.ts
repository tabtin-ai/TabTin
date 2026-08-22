import type { ChatSessionWithAgent } from '@tabtin/chat-client'

function getConversationAgentKey(session: ChatSessionWithAgent): string | null {
  const agentId = session.agent_id?.trim()
  const agentName = session.agent_name?.trim()

  if (!agentId && !agentName) return null
  return `${agentId ?? ''}:${agentName ?? ''}`
}

export function shouldShowConversationAgentMeta(
  sessions: ChatSessionWithAgent[],
  filterAgentId: string | null,
): boolean {
  if (filterAgentId) return false

  const agentKeys = new Set(
    sessions
      .map(getConversationAgentKey)
      .filter((value): value is string => value !== null),
  )
  if (agentKeys.size > 1) return true

  const organizationIds = new Set(
    sessions.map(s => s.organization_id).filter(Boolean),
  )
  return organizationIds.size > 1
}
