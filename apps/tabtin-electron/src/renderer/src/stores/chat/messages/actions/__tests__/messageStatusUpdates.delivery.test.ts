/**
 * ：用户气泡 sendStatus 只认 source_client_event_id。
 * 经  markUserMessageDelivered 单一入口落地。
 */
import { describe, expect, it, vi } from 'vitest'
import type { ChatMessage } from '@tabtin/chat-client'
import {
  markUserMessageDelivered,
  resolveSourceClientEventId,
} from '../messageStatusUpdates'

function userMsg(overrides: Partial<ChatMessage> & { id: string }): ChatMessage {
  return {
    role: 'user',
    content: 'hello',
    created_at: '2026-07-22T00:00:00.000Z',
    sendStatus: 'sending',
    ...overrides,
  } as ChatMessage
}

describe('markUserMessageDelivered · ', () => {
  it('source_client_event_id 匹配 client_message_id → sent（run_id 不命中）', () => {
    const clientId = '11111111-1111-4111-8111-111111111111'
    const runId = '9796076a-2faa-48ba-957b-ea76667a05be'
    const messages = [
      userMsg({
        id: 'temp-user-1',
        metadata: { client_message_id: clientId },
      }),
    ]
    const patchMessageById = vi.fn((
      _sessionId: string,
      messageId: string,
      patcher: (message: ChatMessage) => ChatMessage,
    ) => {
      const idx = messages.findIndex((m) => m.id === messageId)
      if (idx >= 0) messages[idx] = patcher(messages[idx])
    })

    markUserMessageDelivered('session-1', clientId, {
      getMessages: () => messages,
      patchMessageById,
    })
    expect(messages[0]).toMatchObject({ sendStatus: 'sent' })
    expect(patchMessageById).toHaveBeenCalledTimes(1)

    // 反向：用 run_id 当 identity 不得命中
    messages[0] = userMsg({
      id: 'temp-user-1',
      metadata: { client_message_id: clientId },
    })
    patchMessageById.mockClear()
    markUserMessageDelivered('session-1', runId, {
      getMessages: () => messages,
      patchMessageById,
    })
    expect(messages[0]).toMatchObject({ sendStatus: 'sending' })
    expect(patchMessageById).not.toHaveBeenCalled()
  })

  it('无 source_client_event_id 时 resolve 为 undefined（禁止 run_id 兜底）', () => {
    expect(resolveSourceClientEventId({
      phase: 'start',
      run_id: '9796076a-2faa-48ba-957b-ea76667a05be',
    })).toBeUndefined()
    expect(resolveSourceClientEventId({
      source_client_event_id: '11111111-1111-4111-8111-111111111111',
      run_id: '9796076a-2faa-48ba-957b-ea76667a05be',
    })).toBe('11111111-1111-4111-8111-111111111111')
  })

  it('已 sent 不重复 patch', () => {
    const clientId = '22222222-2222-4222-8222-222222222222'
    const messages = [
      userMsg({
        id: 'user-1',
        client_event_id: clientId,
        sendStatus: 'sent',
      } as Partial<ChatMessage> & { id: string }),
    ]
    const patchMessageById = vi.fn()
    markUserMessageDelivered('session-1', clientId, {
      getMessages: () => messages,
      patchMessageById,
    })
    expect(patchMessageById).not.toHaveBeenCalled()
  })
})
