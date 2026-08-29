import { CONVERSATION_TYPE_DM } from '@/constants/tabchat'
import type { Conversation } from '@/services/tabchatApi'

export function findOrgInternalDirectConversation(params: {
  conversations: readonly Conversation[]
  organizationId: string
  peerUserId: string
}): string | null {
  const organizationId = params.organizationId.trim()
  const peerUserId = params.peerUserId.trim()
  if (!organizationId || !peerUserId) return null
  const match = params.conversations.find((conversation) => (
    conversation.type === CONVERSATION_TYPE_DM
    && conversation.organization_id === organizationId
    && conversation.dm_peer_user_id === peerUserId
  ))
  return match?.id ?? null
}

export async function resolveOrgInternalShareConversationId(params: {
  conversations: readonly Conversation[]
  organizationId: string
  peerUserId: string
  createDirect: (
    organizationId: string,
    peerUserId: string,
  ) => Promise<{ conversation_id: string }>
}): Promise<string> {
  const existing = findOrgInternalDirectConversation(params)
  if (existing) return existing
  const created = await params.createDirect(params.organizationId, params.peerUserId)
  const conversationId = created.conversation_id.trim()
  if (!conversationId) {
    throw new Error('组织内私聊未返回会话')
  }
  return conversationId
}
