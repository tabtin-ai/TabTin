import { describe, expect, it } from 'vitest'
import type { Conversation } from '@/services/tabchatApi'
import { groupConversationsForInbox } from './groupConversationsForInbox'

function buildConversation(partial: Partial<Conversation> & Pick<Conversation, 'id'>): Conversation {
  return {
    organization_id: 'wt-1',
    type: 2,
    name: '#general',
    avatar_url: '',
    member_count: 2,
    last_message_at: null,
    last_message_preview: '',
    unread_count: 0,
    created_at: '2026-07-01T00:00:00Z',
    is_team_space_channel: true,
    space_id: 'team-1',
    space_name: '研发组',
    ...partial,
  }
}

describe('groupConversationsForInbox', () => {
  it('按 Project 分组频道并保留默认顺序', () => {
    const grouped = groupConversationsForInbox([
      buildConversation({ id: 'c-updates', name: '#agent-updates', last_message_at: '2026-07-04T11:00:00Z' }),
      buildConversation({ id: 'c-general', name: '#general', last_message_at: '2026-07-04T12:00:00Z' }),
      buildConversation({ id: 'c-custom', name: '#111', last_message_at: '2026-07-04T10:00:00Z' }),
    ])

    expect(grouped.teamSpaceGroups).toHaveLength(1)
    expect(grouped.teamSpaceGroups[0]?.spaceName).toBe('研发组')
    expect(grouped.teamSpaceGroups[0]?.channels.map((item) => item.id)).toEqual([
      'c-general',
      'c-updates',
      'c-custom',
    ])
  })

  it('私信与普通群聊单独成组', () => {
    const grouped = groupConversationsForInbox([
      buildConversation({ id: 'c-general', name: '#general' }),
      {
        id: 'dm-1',
        organization_id: 'wt-1',
        type: 1,
        name: '王五',
        avatar_url: '',
        member_count: 2,
        last_message_at: '2026-07-04T13:00:00Z',
        last_message_preview: '你好',
        unread_count: 0,
        created_at: '2026-07-01T00:00:00Z',
      },
    ])

    expect(grouped.directConversations.map((item) => item.id)).toEqual(['dm-1'])
  })
})
