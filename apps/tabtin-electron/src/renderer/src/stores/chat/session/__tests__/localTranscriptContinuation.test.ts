import { describe, expect, it } from 'vitest'
import type { ChatMessage, ChatSession } from '@tabtin/chat-client'
import {
  hydrateLocalTranscriptWithContinuationSnapshot,
  isShareSnapshotMessage,
  localTranscriptMissesContinuationSnapshot,
  mergeTranscriptPreservingShareSnapshot,
} from '../localTranscriptContinuation'

function message(partial: Partial<ChatMessage> & { id: string }): ChatMessage {
  return {
    role: 'user',
    content: partial.content ?? partial.id,
    created_at: partial.created_at ?? '2026-08-17T13:00:00.000Z',
    ...partial,
  } as ChatMessage
}

describe('localTranscriptContinuation', () => {
  it('识别 share_snapshot 行', () => {
    expect(isShareSnapshotMessage(message({
      id: 'snap',
      metadata: { share_snapshot: true },
    }))).toBe(true)
    expect(isShareSnapshotMessage(message({ id: 'plain' }))).toBe(false)
  })

  it('本机短记录缺快照时从缓存插回 share_snapshot', () => {
    const local = [
      message({ id: 'new-user', content: '继续任务', created_at: '2026-08-17T13:37:54.000Z' }),
    ]
    const cached = [
      message({
        id: 'snap-1',
        content: '原任务',
        created_at: '2026-08-17T12:00:00.000Z',
        metadata: { share_snapshot: true },
      }),
      message({ id: 'new-user', content: '继续任务', created_at: '2026-08-17T13:37:54.000Z' }),
    ]

    expect(mergeTranscriptPreservingShareSnapshot(local, cached).map((item) => item.id))
      .toEqual(['snap-1', 'new-user'])
  })

  it('本机已误把快照接在末尾时仍按时间排回前面', () => {
    const local = [
      message({ id: 'new-user', content: '继续任务', created_at: '2026-08-17T13:37:54.000Z' }),
      message({
        id: 'snap-1',
        content: '原任务',
        created_at: '2026-08-17T12:00:00.000Z',
        metadata: { share_snapshot: true },
      }),
    ]

    expect(mergeTranscriptPreservingShareSnapshot(local, local).map((item) => item.id))
      .toEqual(['snap-1', 'new-user'])
  })

  it('本机已有快照、或普通本机会话，不视为缺快照', () => {
    expect(localTranscriptMissesContinuationSnapshot([
      message({ id: 'snap', metadata: { share_snapshot: true } }),
    ], { message_count: 80 } as ChatSession)).toBe(false)

    expect(localTranscriptMissesContinuationSnapshot([
      message({ id: 'u1' }),
      message({ id: 'a1', role: 'assistant' }),
    ], { message_count: 2 } as ChatSession)).toBe(false)

    expect(localTranscriptMissesContinuationSnapshot([
      message({ id: 'u1' }),
    ])).toBe(false)
  })

  it('有 briefing 无快照，或服务端条数明显更多，视为缺快照', () => {
    expect(localTranscriptMissesContinuationSnapshot([
      message({
        id: 'brief',
        role: 'system',
        message_kind: 'environment_context',
        metadata: { share_briefing: true },
      }),
      message({ id: 'new-user', content: '继续任务' }),
    ])).toBe(true)

    expect(localTranscriptMissesContinuationSnapshot([
      message({ id: 'new-user', content: '继续任务' }),
      message({ id: 'new-asst', role: 'assistant', content: '目录里有 car json' }),
    ], { message_count: 88 } as ChatSession)).toBe(true)

    expect(localTranscriptMissesContinuationSnapshot([
      message({ id: 'u1' }),
      message({ id: 'a1', role: 'assistant' }),
    ], { message_count: 4 } as ChatSession)).toBe(false)
  })

  it('内存里已有快照时不整表覆盖，也不改 hasEarlier', async () => {
    const result = await hydrateLocalTranscriptWithContinuationSnapshot({
      local: [
        message({ id: 'new-user', content: '继续任务', created_at: '2026-08-17T13:37:54.000Z' }),
      ],
      prior: [
        message({
          id: 'snap-1',
          content: '原任务',
          created_at: '2026-08-17T12:00:00.000Z',
          metadata: { share_snapshot: true },
        }),
      ],
      session: { message_count: 88 } as ChatSession,
      listLatest: async () => {
        throw new Error('should not fetch when prior already has snapshot')
      },
    })

    expect(result.usedServerSnapshot).toBe(false)
    expect(result.hasEarlier).toBeUndefined()
    expect(result.messages.map((item) => item.id)).toEqual(['snap-1', 'new-user'])
  })
})
