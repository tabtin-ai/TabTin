import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const {
  instances,
  authState,
  spacePresence,
  profileCache,
  imState,
  resetRegistrations,
} = vi.hoisted(() => ({
  instances: [] as any[],
  authState: { authPhase: 'authenticated', accessToken: 'token', user: { id: 'user-1' } } as any,
  spacePresence: {
    reset: vi.fn(),
    addSpaceConnection: vi.fn(),
    removeSpaceConnection: vi.fn(),
    setSpacePresenceBulk: vi.fn(),
    clearSpace: vi.fn(),
  },
  profileCache: { upsertProfile: vi.fn(), refreshProfiles: vi.fn() },
  imState: {
    conversations: [{ id: 'conv-1', organization_id: 'org-1' }],
    messages: { 'conv-1': [] as any[] } as Record<string, any[]>,
    currentConversationId: null,
    navigateToMessage: vi.fn(),
    setCurrentConversation: vi.fn(),
    onRealtimeMessage: vi.fn(),
    removePendingMessageByRef: vi.fn(),
    loadMessages: vi.fn().mockResolvedValue([]),
  } as any,
  resetRegistrations: [] as any[][],
}))

vi.mock('centrifuge', () => {
  const makeSubscription = (channel: string) => {
    const handlers: Record<string, Function[]> = {}
    return {
      channel,
      state: 'unsubscribed',
      on: vi.fn((event: string, listener: Function) => (handlers[event] ??= []).push(listener)),
      _emit: (event: string, context?: unknown) =>
        (handlers[event] ?? []).forEach((listener) => listener(context)),
      subscribe: vi.fn(),
      unsubscribe: vi.fn(),
      removeAllListeners: vi.fn(),
      presence: vi.fn().mockResolvedValue({ clients: {} }),
    }
  }
  class Centrifuge {
    options: any
    handlers: Record<string, Function[]> = {}
    subscriptions = new Map<string, any>()
    connect = vi.fn()
    disconnect = vi.fn()
    constructor(_url: string, options: any) {
      this.options = options
      instances.push(this)
    }
    on(event: string, listener: Function) { (this.handlers[event] ??= []).push(listener) }
    _emit(event: string, context?: unknown) {
      (this.handlers[event] ?? []).forEach((listener) => listener(context))
    }
    newSubscription(channel: string) {
      const sub = makeSubscription(channel)
      this.subscriptions.set(channel, sub)
      return sub
    }
    getSubscription(channel: string) { return this.subscriptions.get(channel) ?? null }
    removeSubscription(sub: { channel: string }) { this.subscriptions.delete(sub.channel) }
    removeAllListeners() { this.handlers = {} }
  }
  return {
    Centrifuge,
    SubscriptionState: { Subscribed: 'subscribed' },
    UnauthorizedError: class UnauthorizedError extends Error {},
    disconnectedCodes: { unauthorized: 3 },
  }
})

vi.mock('@stores/useAuthStore', () => {
  const useAuthStore: any = (selector: Function) => selector(authState)
  useAuthStore.getState = () => authState
  return {
    useAuthStore,
    selectIsAuthenticated: (state: any) => state.authPhase === 'authenticated',
  }
})
vi.mock('@stores/useSpacePresenceStore', () => ({
  useSpacePresenceStore: { getState: () => spacePresence },
}))
vi.mock('@stores/useIMStore', () => ({
  useIMStore: { getState: () => imState },
  isConversationVisibleForRead: () => false,
}))
vi.mock('@stores/useUserProfileCache', () => ({
  useUserProfileCache: { getState: () => profileCache },
}))
vi.mock('@/services/api', () => ({
  apiService: { ensureValidToken: vi.fn(), tryRefreshTokens: vi.fn() },
}))
vi.mock('@/stores/sessionResetRegistry', () => ({
  registerResetAction: (...args: any[]) => resetRegistrations.push(args),
}))
vi.mock('@/utils/authPersistence', () => ({ notifyLogoutRequired: vi.fn() }))
vi.mock('@/utils/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}))
vi.mock('@/i18n', () => ({ default: { t: (key: string) => key } }))
vi.mock('@tabtin/smartsheet-ui', () => ({ toast: vi.fn() }))

import { toast } from '@tabtin/smartsheet-ui'
import {
  disconnectCentrifugo,
  reconnectCentrifugo,
  subscribeChat,
  subscribeSpacePresence,
} from '../useCentrifugoClient'

beforeEach(() => {
  vi.clearAllMocks()
  instances.length = 0
  imState.messages = { 'conv-1': [] }
  imState.onRealtimeMessage.mockImplementation((convId: string, message: any) => {
    const messages = imState.messages[convId] ?? []
    const messageRef = message.metadata?.message_ref
    const index = messages.findIndex((current: any) => current.metadata?.message_ref === messageRef)
    imState.messages[convId] = index >= 0
      ? messages.map((current: any, currentIndex: number) => currentIndex === index ? message : current)
      : [...messages, message]
  })
  imState.removePendingMessageByRef.mockImplementation((convId: string, messageRef: string) => {
    imState.messages[convId] = (imState.messages[convId] ?? [])
      .filter((message: any) => message.metadata?.message_ref !== messageRef)
  })
})

afterEach(() => disconnectCentrifugo())

describe('Centrifugo non-IM channels', () => {
  it('converges Agent stream final and error events without replaying duplicate chunks', () => {
    reconnectCentrifugo()
    subscribeChat('conv-1')
    const sub = instances[0].subscriptions.get('chat:conv-1')
    const publish = (type: string, data: Record<string, unknown>) => sub._emit('publication', {
      data: { type, data },
    })
    const identity = {
      conversation_id: 'conv-1',
      message_ref: 'job-1',
      agent_session_ref: 'session-1',
      sender_id: 'agent-1',
      sender_name: '研究员',
      sender_avatar: '',
    }

    publish('im.agent.message.stream', { ...identity, delta: '你', stream_seq: 1, created_at: '2026-08-22T10:00:00Z' })
    publish('im.agent.message.stream', { ...identity, delta: '错误重复', stream_seq: 1, created_at: '2026-08-22T10:00:01Z' })
    publish('im.agent.message.stream', { ...identity, delta: '好', stream_seq: 3, created_at: '2026-08-22T10:00:02Z' })
    expect(imState.messages['conv-1']).toEqual([
      expect.objectContaining({
        content: '你好',
        metadata: expect.objectContaining({ kind: 'agent_stream', message_ref: 'job-1', stream_seq: 3 }),
      }),
    ])

    publish('im.agent.message.final', {
      ...identity,
      content: '完整回答',
      message_type: 1,
      metadata: {},
      created_at: '2026-08-22T10:00:03Z',
    })
    publish('im.agent.message.stream', { ...identity, delta: '迟到', stream_seq: 4, created_at: '2026-08-22T10:00:04Z' })
    expect(imState.messages['conv-1'][0]).toEqual(expect.objectContaining({
      content: '完整回答',
      metadata: expect.objectContaining({ kind: 'agent_final', message_ref: 'job-1' }),
    }))

    const errorIdentity = { ...identity, message_ref: 'job-2', agent_session_ref: 'session-2' }
    publish('im.agent.message.stream', { ...errorIdentity, delta: '临时', stream_seq: 1, created_at: '2026-08-22T10:00:05Z' })
    publish('im.agent.message.error', errorIdentity)
    expect(imState.removePendingMessageByRef).toHaveBeenCalledWith('conv-1', 'job-2')
    expect(imState.messages['conv-1'].some((message: any) => message.metadata?.message_ref === 'job-2')).toBe(false)
  })

  it('subscribes personal notifications without creating chat channels', () => {
    reconnectCentrifugo()
    const client = instances[0]
    expect(client.subscriptions.has('personal:user-1')).toBe(true)
    expect([...client.subscriptions.keys()].some((channel) => channel.startsWith('chat:'))).toBe(false)
  })

  it('reconciles latest history only after the chat subscription is confirmed', () => {
    reconnectCentrifugo()
    subscribeChat('conv-1')
    const sub = instances[0].subscriptions.get('chat:conv-1')

    expect(imState.loadMessages).not.toHaveBeenCalled()
    sub._emit('subscribed')

    expect(imState.loadMessages).toHaveBeenCalledWith('conv-1')
  })

  it('keeps Space presence on Centrifugo', () => {
    reconnectCentrifugo()
    expect(subscribeSpacePresence('space-a')).toBe(true)
    const sub = instances[0].subscriptions.get('space:space-a')
    sub._emit('join', { info: { user: 'user-2' } })
    sub._emit('leave', { info: { user: 'user-2' } })
    expect(spacePresence.addSpaceConnection).toHaveBeenCalledWith('space-a', 'user-2')
    expect(spacePresence.removeSpaceConnection).toHaveBeenCalledWith('space-a', 'user-2')
  })

  it('registers session teardown', () => {
    expect(resetRegistrations).toContainEqual([
      'centrifugo',
      'teardown',
      expect.any(Function),
    ])
  })

  it('shows im.ai.error reason on the toast', () => {
    reconnectCentrifugo()
    const sub = instances[0].subscriptions.get('personal:user-1')
    sub._emit('publication', {
      data: {
        type: 'im.ai.error',
        data: { agent_name: '小Tin', reason: '请重新指定执行现场' },
      },
    })
    expect(toast).toHaveBeenCalledWith({
      title: 'aiReplyFailed',
      description: '请重新指定执行现场',
      variant: 'destructive',
    })
  })
})
