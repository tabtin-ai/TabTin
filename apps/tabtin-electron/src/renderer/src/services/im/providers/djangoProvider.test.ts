import { describe, expect, it, vi } from 'vitest'
import { createDjangoIMProvider } from './djangoProvider'

describe('createDjangoIMProvider search', () => {
  it('搜索分组沿用后端 conversation_type，不把私聊写成群', async () => {
    const request = vi.fn(async () => ({
      groups: [{
        conversation_id: 'dm-1',
        conversation_name: '',
        conversation_type: 1,
        conversation_avatar_url: '',
        match_count: 1,
        messages: [],
      }],
      has_more: false,
      next_group_offset: 1,
    }))
    const provider = createDjangoIMProvider({ request })

    const page = await provider.searchMessages({
      organizationId: 'org-1',
      query: '你好',
    })

    expect(page.conversations[0]?.conversation).toMatchObject({
      id: 'dm-1',
      type: 1,
    })
  })
})

describe('createDjangoIMProvider send', () => {
  it('发送回包保留服务端 read_receipt，确认后立刻能画已读圈', async () => {
    const request = vi.fn(async () => ({
      id: 44,
      seq: 44,
      conversation_id: 'conv-1',
      sender_id: 'user-1',
      sender_type: 'user',
      content: '刚发出',
      message_type: 1,
      reply_to_id: null,
      has_attachment: false,
      created_at: '2026-08-29T09:15:00Z',
      read_receipt: { read_count: 0, recipient_count: 1 },
    }))
    const provider = createDjangoIMProvider({ request })

    const result = await provider.sendMessage({
      conversationId: 'conv-1',
      content: '刚发出',
      messageType: 1,
      metadata: { client_request_id: 'req-1', message_ref: 'ref-1' },
      clientRequestId: 'req-1',
    })

    expect(result.read_receipt).toEqual({
      read_count: 0,
      recipient_count: 1,
    })
  })
})

describe('createDjangoIMProvider reactions', () => {
  it('用消息数字 id 打反应接口，而不是 UUID message_ref', async () => {
    const request = vi.fn(async () => ({ created: true }))
    const provider = createDjangoIMProvider({ request })

    await provider.messageActions!.addReaction({
      conversationId: 'conv-1',
      messageRef: '019f0000-0000-7000-8000-000000000042',
      sequence: 25,
      emoji: '👍',
    })

    expect(request).toHaveBeenCalledWith(
      'POST',
      '/conversations/conv-1/messages/25/reactions',
      { emoji: '👍' },
    )
  })

  it('取消反应把 emoji 放进 query，不发 JSON body', async () => {
    const request = vi.fn(async () => ({ removed: true }))
    const provider = createDjangoIMProvider({ request })

    await provider.messageActions!.removeReaction({
      conversationId: 'conv-1',
      messageRef: '019f0000-0000-7000-8000-000000000042',
      sequence: 25,
      emoji: '👍',
    })

    expect(request).toHaveBeenCalledWith(
      'DELETE',
      `/conversations/conv-1/messages/25/reactions?${new URLSearchParams({ emoji: '👍' })}`,
    )
  })

  it('退群走 POST /leave，不把自己当成员删掉', async () => {
    const request = vi.fn(async () => null)
    const provider = createDjangoIMProvider({ request })

    await provider.leaveConversation('conv-1')

    expect(request).toHaveBeenCalledWith('POST', '/conversations/conv-1/leave')
  })
})
