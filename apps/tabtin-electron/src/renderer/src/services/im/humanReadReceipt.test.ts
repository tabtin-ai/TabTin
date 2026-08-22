import { describe, expect, it } from 'vitest'
import { projectHumanReadReceipt } from './humanReadReceipt'

describe('projectHumanReadReceipt', () => {
  const detail = {
    message_id: 10,
    readers: [],
    unreaders: [
      { user_id: 'human-1', name: '甲', username: 'human-1', avatar: '' },
      { user_id: 'human-2', name: '乙', username: 'human-2', avatar: '' },
      { user_id: 'human-3', name: '丙', username: 'human-3', avatar: '' },
      { user_id: 'human-4', name: '丁', username: 'human-4', avatar: '' },
      { user_id: 'a_provider-agent-account', name: '', username: '', avatar: '' },
    ],
  }

  const project = (overrides: Partial<Parameters<typeof projectHumanReadReceipt>[0]> = {}) => (
    projectHumanReadReceipt({
      receipt: { read_count: 0, recipient_count: 5 },
      detail,
      agentIds: ['agent-domain-id'],
      senderId: 'sender',
      ...overrides,
    })
  )

  it('returns one human-only projection for counts and member details', () => {
    const result = project()

    expect(result).toMatchObject({
      readCount: 0,
      unreadCount: 4,
      recipientCount: 4,
      hasAuthoritativeStatus: true,
      progress: 0,
      isComplete: false,
    })
    expect(result.detail?.unreaders).toEqual(detail.unreaders.slice(0, 4))
  })

  it('leaves no visible status when an Agent is the only recipient', () => {
    expect(project({
      receipt: { read_count: 0, recipient_count: 1 },
      detail: null,
    })).toMatchObject({
      readCount: 0,
      unreadCount: 0,
      recipientCount: 0,
      hasAuthoritativeStatus: false,
      progress: 0,
      isComplete: false,
    })
  })

  it('subtracts an Agent reader after details identify it', () => {
    const agentReadDetail = {
      ...detail,
      readers: [detail.unreaders[4]],
      unreaders: detail.unreaders.slice(0, 4),
    }

    expect(project({
      receipt: { read_count: 1, recipient_count: 5 },
      detail: agentReadDetail,
    })).toMatchObject({ readCount: 0, unreadCount: 4, recipientCount: 4 })
  })

  it('keeps authoritative summary counts when receipt details are incomplete', () => {
    expect(project({
      receipt: { read_count: 2, recipient_count: 5 },
      detail: { message_id: 10, readers: [], unreaders: [] },
    })).toMatchObject({ readCount: 2, unreadCount: 2, recipientCount: 4 })
  })

  it('never renders counts that disagree with a complete visible member detail', () => {
    const result = project({
      receipt: { read_count: 1, recipient_count: 3 },
      agentIds: ['agent-domain-1', 'agent-domain-2'],
      detail: {
        message_id: 10,
        readers: [{ user_id: 'u_human', name: '真人', username: 'human', avatar: '' }],
        unreaders: [
          { user_id: 'legacy-agent-1', name: 'AI 1', username: 'ai-1', avatar: '' },
          { user_id: 'legacy-agent-2', name: 'AI 2', username: 'ai-2', avatar: '' },
        ],
      },
    })

    expect(result.readCount).toBe(result.detail?.readers.length)
    expect(result.unreadCount).toBe(result.detail?.unreaders.length)
    expect(result.recipientCount).toBe(
      (result.detail?.readers.length ?? 0) + (result.detail?.unreaders.length ?? 0),
    )
  })

  it('excludes the sender and removed members from the current human snapshot', () => {
    const result = project({
      currentHumanMemberIds: ['sender', 'human-1', 'human-2', 'human-3'],
    })

    expect(result).toMatchObject({ readCount: 0, unreadCount: 3, recipientCount: 3 })
    expect(result.detail?.unreaders.map((member) => member.user_id)).toEqual([
      'human-1',
      'human-2',
      'human-3',
    ])
  })

  it('subtracts a removed reader from both the read total and member details', () => {
    const detailWithRemovedReader = {
      ...detail,
      readers: [detail.unreaders[3]],
      unreaders: detail.unreaders.slice(0, 3),
    }
    const result = project({
      receipt: { read_count: 1, recipient_count: 5 },
      detail: detailWithRemovedReader,
      currentHumanMemberIds: ['sender', 'human-1', 'human-2', 'human-3'],
    })

    expect(result).toMatchObject({ readCount: 0, unreadCount: 3, recipientCount: 3 })
    expect(result.detail?.readers).toEqual([])
  })

  it('projects complete read progress once for every presentation consumer', () => {
    expect(project({
      receipt: { read_count: 4, recipient_count: 5 },
      detail: null,
    })).toMatchObject({
      readCount: 4,
      unreadCount: 0,
      recipientCount: 4,
      progress: 1,
      isComplete: true,
    })
  })
})
