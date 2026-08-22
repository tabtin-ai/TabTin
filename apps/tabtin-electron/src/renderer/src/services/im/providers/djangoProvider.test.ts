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
