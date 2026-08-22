import { MESSAGE_TYPE_TEXT } from '@/constants/tabchat'
import type { IMMessageMetadata } from './contracts'

export function canSendToExternalConversation(
  messageType: number,
  metadata?: IMMessageMetadata,
): boolean {
  return messageType === MESSAGE_TYPE_TEXT
    && !metadata?.card
    && !metadata?.mentioned_agent_ids?.length
}
