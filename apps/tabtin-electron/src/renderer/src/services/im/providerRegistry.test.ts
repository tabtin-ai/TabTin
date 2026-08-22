import { describe, expect, it, vi } from 'vitest'
import type {
  Conversation,
  IMMessage,
  IMProvider,
  IMProviderEvent,
  IMProviderEventListener,
  IMProviderUnsubscribe,
  ListConversationsInput,
  ListMessagesInput,
  MarkReadInput,
  SearchMessagesInput,
  SendMessageInput,
} from './contracts'
import {
  createDefaultIMProviderRegistry,
  IMProviderRegistry,
  IMProviderUnavailableError,
} from '.'

class EventingDjangoProvider implements IMProvider {
  readonly id = 'django' as const
  private readonly listeners = new Set<IMProviderEventListener>()

  start = vi.fn(async () => undefined)
  stop = vi.fn(async () => undefined)

  subscribe(listener: IMProviderEventListener): IMProviderUnsubscribe {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  listConversations(_input: ListConversationsInput): Promise<Conversation[]> {
    return Promise.resolve([])
  }

  listMessages(_input: ListMessagesInput): Promise<IMMessage[]> {
    return Promise.resolve([])
  }

  searchMessages(_input: SearchMessagesInput) {
    return Promise.resolve({ conversations: [], cursor: '', totalCount: 0 })
  }

  sendMessage(input: SendMessageInput) {
    return Promise.resolve({
      id: 1,
      seq: 1,
      conversation_id: input.conversationId,
      created_at: '2026-07-30T08:00:00.000Z',
    })
  }

  markRead(_input: MarkReadInput) {
    return Promise.resolve({ marked_count: 0 })
  }

  getUnreadSnapshot() {
    return Promise.resolve({ total: 0, conversations: {} })
  }

  emit(event: IMProviderEvent): void {
    for (const listener of this.listeners) listener(event)
  }
}

describe('single Django IM provider registry', () => {
  it('starts and stops only the registered Django provider', async () => {
    const provider = new EventingDjangoProvider()
    const registry = createDefaultIMProviderRegistry({
      djangoProvider: provider,
    })
    const context = {
      organizationId: 'organization-a',
      userId: 'user-a',
    }

    await registry.start(context)
    await registry.stop()

    expect(provider.start).toHaveBeenCalledExactlyOnceWith(context)
    expect(provider.stop).toHaveBeenCalledOnce()
  })

  it('rejects a non-Django runtime provider', () => {
    const provider = new EventingDjangoProvider()
    Object.defineProperty(provider, 'id', { value: 'tencent' })

    expect(() => new IMProviderRegistry(provider as IMProvider)).toThrow(
      'Electron runtime requires the Django IM provider',
    )
  })

  it('isolates one Organization event stream from another', () => {
    const provider = new EventingDjangoProvider()
    const registry = new IMProviderRegistry(provider)
    const listenerA = vi.fn()
    const listenerB = vi.fn()
    registry.subscribe('organization-a', listenerA)
    registry.subscribe('organization-b', listenerB)

    provider.emit({ type: 'connection.changed', state: 'connected' })
    const message: IMMessage = {
      id: 1,
      seq: 1,
      conversation_id: 'conversation-a',
      sender_id: 'user-a',
      content: 'hello',
      message_type: 1,
      reply_to_id: null,
      has_attachment: false,
      metadata: {
        message_ref: 'message-a',
        client_request_id: 'request-a',
      },
      created_at: '2026-07-30T08:00:00.000Z',
    }
    provider.emit({
      type: 'message.upserted',
      organizationId: 'organization-a',
      message,
    })
    provider.emit({
      type: 'unread.updated',
      organizationId: 'organization-b',
      snapshot: {
        total: 2,
        conversations: { 'conversation-b': 2 },
      },
    })

    expect(listenerA.mock.calls.map(([event]) => event)).toEqual([
      { type: 'connection.changed', state: 'connected' },
      {
        type: 'message.upserted',
        organizationId: 'organization-a',
        message,
      },
    ])
    expect(listenerB.mock.calls.map(([event]) => event)).toEqual([
      { type: 'connection.changed', state: 'connected' },
      {
        type: 'unread.updated',
        organizationId: 'organization-b',
        snapshot: {
          total: 2,
          conversations: { 'conversation-b': 2 },
        },
      },
    ])
    expect(
      registry.getConversationOrganization('conversation-a'),
    ).toBe('organization-a')
  })

  it('returns an explicit capability error instead of calling a legacy API', () => {
    const provider = new EventingDjangoProvider()
    const registry = createDefaultIMProviderRegistry({
      djangoProvider: provider,
    })
    registry.rememberConversationRoute('conversation-a', 'organization-a')

    const message = {
      transport: { kind: 'group' as const, sequence: 11 },
      message_ref: 'message-ref-11',
    }
    expect(() => registry.deleteMessage('conversation-a', message)).toThrow(
      IMProviderUnavailableError,
    )
    try {
      registry.deleteMessage('conversation-a', message)
    } catch (error) {
      expect(error).toMatchObject({
        providerId: 'django',
        operation: 'deleteMessage',
      })
    }
  })
})
