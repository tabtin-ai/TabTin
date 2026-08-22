import { describe, expect, it } from 'vitest'
import {
  mapDjangoConversation,
  mapDjangoMessage,
  mapDjangoSearchGroupConversation,
  resolveDjangoReactionMessageId,
  type DjangoConversationRecord,
  type DjangoMessageRecord,
} from './djangoMapper'

function buildConversationRecord(
  overrides: Partial<DjangoConversationRecord> = {},
): DjangoConversationRecord {
  return {
    id: 'conversation-1',
    organization_id: 'host-organization',
    type: 2,
    name: '外部群',
    avatar_url: '',
    member_count: 3,
    last_message_at: null,
    last_message_preview: '',
    created_at: '2026-08-19T03:43:00Z',
    ...overrides,
  }
}

function buildRecord(overrides: Partial<DjangoMessageRecord> = {}): DjangoMessageRecord {
  return {
    id: 25,
    seq: 1,
    conversation_id: 'conv-1',
    sender_id: 'user-1',
    sender_type: 'user',
    content: '你好',
    message_type: 1,
    reply_to_id: null,
    has_attachment: false,
    created_at: '2026-08-19T03:43:00Z',
    ...overrides,
  }
}

describe('mapDjangoMessage', () => {
  it('保留服务端下发的私聊已读回执，避免重进会话后仍显示空心圆', () => {
    const message = mapDjangoMessage(buildRecord({
      read_receipt: { read_count: 1, recipient_count: 1 },
    }))

    expect(message.read_receipt).toEqual({
      read_count: 1,
      recipient_count: 1,
    })
  })
})

describe('mapDjangoConversation', () => {
  it('外部群按参与组织进入目录，同时保留服务端下发的作用域字段', () => {
    const conversation = mapDjangoConversation(buildConversationRecord({
      is_external: true,
      participant_organization_id: 'participant-organization',
      directory_scope_id: 'participant-organization',
    }))

    expect(conversation).toEqual(expect.objectContaining({
      organization_id: 'participant-organization',
      participant_organization_id: 'participant-organization',
      directory_scope_id: 'participant-organization',
    }))
  })

  it('兼容尚未下发作用域字段的旧 Django 服务端', () => {
    const conversation = mapDjangoConversation(
      buildConversationRecord({ is_external: true }),
      'requested-organization',
    )

    expect(conversation.organization_id).toBe('requested-organization')
  })

  it('保留外部私聊的对端组织，供联系人关系门禁精确匹配', () => {
    const conversation = mapDjangoConversation(buildConversationRecord({
      is_external: true,
      type: 1,
      dm_peer_user_id: 'peer-user',
      dm_peer_organization_id: 'peer-organization',
    }))

    expect(conversation).toEqual(expect.objectContaining({
      dm_peer_user_id: 'peer-user',
      dm_peer_organization_id: 'peer-organization',
    }))
  })
})

describe('mapDjangoSearchGroupConversation', () => {
  it('没有嵌套 conversation 时沿用 grouped 的私聊类型和头像', () => {
    const conversation = mapDjangoSearchGroupConversation({
      conversation_id: 'dm-1',
      conversation_name: '',
      conversation_type: 1,
      conversation_avatar_url: 'https://cdn.example/peer.png',
    }, 'org-1')

    expect(conversation).toMatchObject({
      id: 'dm-1',
      organization_id: 'org-1',
      type: 1,
      avatar_url: 'https://cdn.example/peer.png',
    })
  })

  it('群聊 grouped 字段保持 type=2，不再写死所有结果为群', () => {
    const conversation = mapDjangoSearchGroupConversation({
      conversation_id: 'group-1',
      conversation_name: '产品群',
      conversation_type: 2,
      conversation_avatar_url: 'https://cdn.example/group.png',
    }, 'org-1')

    expect(conversation).toMatchObject({
      id: 'group-1',
      type: 2,
      name: '产品群',
      avatar_url: 'https://cdn.example/group.png',
    })
  })

  it('缺少 conversation_type 时按私聊处理，避免再把结果画成群', () => {
    const conversation = mapDjangoSearchGroupConversation({
      conversation_id: 'dm-2',
      conversation_name: '对方',
    }, 'org-1')

    expect(conversation?.type).toBe(1)
  })

  it('嵌套外部群缺少作用域字段时使用请求组织目录', () => {
    const conversation = mapDjangoSearchGroupConversation({
      conversation: buildConversationRecord({ is_external: true }),
    }, 'participant-organization')

    expect(conversation?.organization_id).toBe('participant-organization')
  })
})

describe('resolveDjangoReactionMessageId', () => {
  it('优先使用 transport.sequence，避免把 UUID message_ref 打进整数路由', () => {
    expect(resolveDjangoReactionMessageId({
      messageRef: '019f0000-0000-7000-8000-000000000042',
      sequence: 25,
    })).toBe(25)
  })

  it('没有 sequence 时回退到数字 message_ref', () => {
    expect(resolveDjangoReactionMessageId({ messageRef: '31' })).toBe(31)
  })

  it('UUID message_ref 且没有 sequence 时抛错', () => {
    expect(() => resolveDjangoReactionMessageId({
      messageRef: '019f0000-0000-7000-8000-000000000042',
    })).toThrow('numeric message id')
  })
})
