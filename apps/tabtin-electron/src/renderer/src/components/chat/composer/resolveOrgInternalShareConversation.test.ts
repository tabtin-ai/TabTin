import { describe, expect, it, vi } from 'vitest'
import { CONVERSATION_TYPE_DM, CONVERSATION_TYPE_GROUP } from '@/constants/tabchat'
import type { Conversation } from '@/services/tabchatApi'
import {
  findOrgInternalDirectConversation,
  resolveOrgInternalShareConversationId,
} from './resolveOrgInternalShareConversation'

function conversation(overrides: Partial<Conversation> & Pick<Conversation, 'id'>): Conversation {
  return {
    organization_id: 'org-q',
    type: CONVERSATION_TYPE_DM,
    name: '沈',
    avatar_url: '',
    member_count: 2,
    last_message_at: null,
    last_message_preview: '',
    unread_count: 0,
    created_at: '2026-08-27T00:00:00Z',
    dm_peer_user_id: 'user-shen',
    ...overrides,
  }
}

describe('findOrgInternalDirectConversation', () => {
  it('returns the current-org DM with the selected colleague', () => {
    const conversationId = findOrgInternalDirectConversation({
      organizationId: 'org-q',
      peerUserId: 'user-shen',
      conversations: [
        conversation({ id: 'group-1', type: CONVERSATION_TYPE_GROUP, dm_peer_user_id: null }),
        conversation({ id: 'dm-other-org', organization_id: 'org-other' }),
        conversation({ id: 'dm-other-peer', dm_peer_user_id: 'user-other' }),
        conversation({ id: 'dm-shen' }),
      ],
    })

    expect(conversationId).toBe('dm-shen')
  })

  it('returns null when the current org has no DM with that colleague', () => {
    expect(findOrgInternalDirectConversation({
      organizationId: 'org-q',
      peerUserId: 'user-shen',
      conversations: [conversation({ id: 'dm-other-org', organization_id: 'org-other' })],
    })).toBeNull()
  })
})

describe('resolveOrgInternalShareConversationId', () => {
  it('reuses the current-org DM without creating another one', async () => {
    const createDirect = vi.fn()

    await expect(resolveOrgInternalShareConversationId({
      organizationId: 'org-q',
      peerUserId: 'user-shen',
      conversations: [conversation({ id: 'dm-shen' })],
      createDirect,
    })).resolves.toBe('dm-shen')
    expect(createDirect).not.toHaveBeenCalled()
  })

  it('creates the current-org DM when the list does not have one yet', async () => {
    const createDirect = vi.fn(async () => ({ conversation_id: 'dm-created' }))

    await expect(resolveOrgInternalShareConversationId({
      organizationId: 'org-q',
      peerUserId: 'user-shen',
      conversations: [],
      createDirect,
    })).resolves.toBe('dm-created')
    expect(createDirect).toHaveBeenCalledWith('org-q', 'user-shen')
  })
})
