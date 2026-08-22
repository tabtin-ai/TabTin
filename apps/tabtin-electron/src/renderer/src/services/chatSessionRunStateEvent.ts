import type {
  ChatSession,
  ChatSessionRunState,
} from '@tabtin/chat-client'
import { isChatSessionRunState } from '@/stores/chat/execution/sessionRunProjectionReducer'

export interface ParsedChatSessionRunStateEvent {
  sessionId: string
  organizationId: string
  runState: ChatSessionRunState
}

export function parseChatSessionRunStateEvent(
  value: unknown,
  context: {
    currentOrganizationId: string | null
    cachedSession?: Pick<ChatSession, 'organization_id'>
  },
): ParsedChatSessionRunStateEvent | null {
  if (!value || typeof value !== 'object') return null
  const payload = value as Record<string, unknown>
  const sessionId = typeof payload.session_id === 'string' ? payload.session_id : ''
  const organizationId = typeof payload.organization_id === 'string'
    ? payload.organization_id
    : ''
  if (
    !sessionId
    || !organizationId
    || !context.currentOrganizationId
    || organizationId !== context.currentOrganizationId
    || (
      context.cachedSession?.organization_id
      && context.cachedSession.organization_id !== organizationId
    )
    || !isChatSessionRunState(payload.run_state)
  ) {
    return null
  }
  return {
    sessionId,
    organizationId,
    runState: payload.run_state,
  }
}
