import { renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Conversation, IMMessage } from '@/services/im'

const {
  authState,
  imState,
  organizationState,
  mockStartIMProvider,
  mockStopIMProvider,
  mockSubscribeIMProvider,
  mockToast,
  mockEnsureProfiles,
  mockUpsertProfileHint,
  mockRefreshConversationMembers,
} = vi.hoisted(() => ({
  authState: {
    isAuthenticated: true,
    user: { id: 'user-a' } as { id: string } | null,
  },
  imState: {
    conversations: [] as Conversation[],
    messages: {} as Record<string, IMMessage[]>,
    connectionStatus: 'disconnected' as 'disconnected' | 'connecting' | 'connected',
    setConnectionStatus: vi.fn(),
    onNewConversation: vi.fn(),
    updateConversation: vi.fn(),
    removeConversation: vi.fn(),
    onRealtimeMessage: vi.fn(),
    onMessagePinned: vi.fn(),
    onMessageUnpinned: vi.fn(),
    onReactionUpdated: vi.fn(),
    onReactionSnapshot: vi.fn(),
    onReadReceipt: vi.fn(),
    patchSessionShare: vi.fn(),
    bumpSessionShareListVersion: vi.fn(),
    bumpSessionShareDetailVersion: vi.fn(),
    bumpHandoffVersion: vi.fn(),
    loadSessionShareV2: vi.fn(async () => null),
    loadSessionContinuation: vi.fn(async () => null),
    loadConversations: vi.fn(async () => undefined),
    applyUnreadSnapshot: vi.fn(),
  },
  organizationState: {
    selectedOrganization: { id: 'organization-a' } as { id: string } | null,
    organizations: [
      { id: 'organization-a' },
      { id: 'organization-b' },
    ],
  },
  mockStartIMProvider: vi.fn(async (
    _context: { organizationId: string; userId: string },
  ) => undefined),
  mockStopIMProvider: vi.fn(async () => undefined),
  mockSubscribeIMProvider: vi.fn((
    _organizationId: string,
    _listener: (event: unknown) => void,
  ) => vi.fn()),
  mockToast: vi.fn(),
  mockEnsureProfiles: vi.fn(),
  mockUpsertProfileHint: vi.fn(),
  mockRefreshConversationMembers: vi.fn(async () => []),
}))

vi.mock('@tabtin/smartsheet-ui', () => ({ toast: mockToast }))

vi.mock('@/i18n', () => ({
  default: {
    t: (_key: string, options?: { defaultValue?: string }) => options?.defaultValue,
  },
}))

vi.mock('@stores/useAuthStore', () => ({
  selectIsAuthenticated: (state: typeof authState) => state.isAuthenticated,
  useAuthStore: Object.assign(vi.fn(
    (selector: (state: typeof authState) => unknown) => selector(authState),
  ), {
    getState: vi.fn(() => authState),
  }),
}))

vi.mock('@stores/useIMStore', () => ({
  useIMStore: Object.assign(vi.fn(
    (selector: (state: typeof imState) => unknown) => selector(imState),
  ), {
    getState: () => ({
      ...imState,
      refreshConversationMembers: mockRefreshConversationMembers,
    }),
  }),
}))

vi.mock('@stores/useOrganizationStore', () => ({
  useOrganizationStore: Object.assign(vi.fn(
    (selector: (state: typeof organizationState) => unknown) =>
      selector(organizationState),
  ), {
    getState: vi.fn(() => organizationState),
  }),
}))

vi.mock('@stores/useUserProfileCache', () => ({
  useUserProfileCache: {
    getState: () => ({
      ensureProfiles: mockEnsureProfiles,
      upsertProfileHint: mockUpsertProfileHint,
    }),
  },
}))

vi.mock('@/services/tabchatApi', () => ({
  startIMProvider: mockStartIMProvider,
  stopIMProvider: mockStopIMProvider,
  subscribeIMProvider: mockSubscribeIMProvider,
}))

import {
  applyIMProviderEvent,
  useIMProviderClient,
} from '../useIMProviderClient'

function conversation(): Conversation {
  return {
    id: 'conversation-a',
    organization_id: 'organization-a',
    type: 2,
    name: 'Project',
    avatar_url: '',
    member_count: 3,
    last_message_at: null,
    last_message_preview: '',
    unread_count: 0,
    created_at: '2026-07-30T08:00:00.000Z',
  }
}

function message(): IMMessage {
  return {
    id: 42,
    seq: 42,
    conversation_id: 'conversation-a',
    sender_id: 'user-a',
    content: 'hello',
    message_type: 1,
    reply_to_id: null,
    has_attachment: false,
    metadata: {
      message_ref: '0198-message-ref',
      client_request_id: '0198-client-request',
    },
    created_at: '2026-07-30T08:01:00.000Z',
  }
}

describe('IM provider events', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    authState.isAuthenticated = true
    authState.user = { id: 'user-a' }
    imState.conversations = []
    imState.messages = {}
    imState.connectionStatus = 'disconnected'
    organizationState.organizations = [
      { id: 'organization-a' },
      { id: 'organization-b' },
    ]
    organizationState.selectedOrganization = { id: 'organization-a' }
    mockStartIMProvider.mockResolvedValue(undefined)
    mockStopIMProvider.mockResolvedValue(undefined)
    mockSubscribeIMProvider.mockImplementation(() => vi.fn())
  })

  it('lets Tencent connection state directly own the IM connection status', () => {
    applyIMProviderEvent({ type: 'connection.changed', state: 'connecting' })
    applyIMProviderEvent({ type: 'connection.changed', state: 'connected' })

    expect(imState.setConnectionStatus.mock.calls).toEqual([
      ['connecting'],
      ['connected'],
    ])
  })

  it('notifies the app shell when Tencent kicks out the active session', () => {
    const dispatch = vi.spyOn(window, 'dispatchEvent')

    applyIMProviderEvent({
      type: 'connection.changed',
      state: 'disconnected',
      reason: 'kicked_out',
      kickType: 'multipleAccount',
    })

    expect(imState.setConnectionStatus).toHaveBeenCalledWith(
      'disconnected',
      'kicked_out',
    )
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({
      type: 'im:session-kicked',
    }))
  })

  it('notifies the app shell when Tencent automatic recovery is exhausted', () => {
    const dispatch = vi.spyOn(window, 'dispatchEvent')

    applyIMProviderEvent({
      type: 'connection.changed',
      state: 'disconnected',
      reason: 'recovery_failed',
    })

    expect(imState.setConnectionStatus).toHaveBeenCalledWith('disconnected')
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({
      type: 'im:connection-recovery-failed',
    }))
  })

  it('applies full conversation and message events to the existing store', () => {
    const nextConversation = conversation()
    imState.conversations = [nextConversation]

    applyIMProviderEvent({
      type: 'conversation.updated',
      organizationId: 'organization-a',
      conversation: nextConversation,
    })
    applyIMProviderEvent({
      type: 'message.upserted',
      organizationId: 'organization-a',
      message: message(),
    })

    expect(imState.onNewConversation).toHaveBeenCalledWith(nextConversation)
    expect(imState.updateConversation).toHaveBeenCalledWith(
      nextConversation.id,
      nextConversation,
    )
    expect(imState.onRealtimeMessage).toHaveBeenCalledWith(
      'conversation-a',
      expect.objectContaining({ id: 42, seq: 42 }),
      { incrementUnread: false },
    )
  })

  it('updates the visible pinned-message state from a peer realtime event', () => {
    imState.conversations = [conversation()]
    const pinned = { ...message(), is_pinned: true as const }

    applyIMProviderEvent({
      type: 'message.upserted',
      organizationId: 'organization-a',
      message: pinned,
    })

    expect(imState.onMessagePinned).toHaveBeenCalledWith('conversation-a', pinned)
    expect(imState.onRealtimeMessage).not.toHaveBeenCalled()
  })

  it('reloads handoff authority when Tencent modifies its card projection', () => {
    imState.conversations = [conversation()]
    imState.messages = {
      'conversation-a': [{
        ...message(),
        metadata: {
          message_ref: '0198-message-ref',
          business_projection_revision: '0198-old-revision',
          card: { type: 'handoff', handoff_id: 'handoff-a' },
        },
      }],
    }

    applyIMProviderEvent({
      type: 'message.upserted',
      organizationId: 'organization-a',
      message: {
        ...message(),
        metadata: {
          message_ref: '0198-message-ref',
          business_projection_revision: '0198-new-revision',
          card: { type: 'handoff', handoff_id: 'handoff-a' },
        },
      },
    })

    expect(imState.bumpHandoffVersion).toHaveBeenCalledWith('handoff-a')
  })

  it('silently removes a conversation dropped by the realtime group list', () => {
    applyIMProviderEvent({
      type: 'conversation.removed',
      organizationId: 'organization-a',
      conversationId: 'conversation-a',
    })

    expect(imState.removeConversation).toHaveBeenCalledWith('conversation-a')
    expect(mockToast).not.toHaveBeenCalled()
  })

  it('hydrates the user profile cache from a Tencent sender snapshot', () => {
    imState.conversations = [conversation()]
    const incomingMessage = {
      ...message(),
      sender_id: 'user-b',
      sender_name: ' 沈庾涛 ',
      sender_avatar: ' https://example.com/avatar.png ',
    }

    applyIMProviderEvent({
      type: 'message.upserted',
      organizationId: 'organization-a',
      message: incomingMessage,
    })

    expect(mockUpsertProfileHint).toHaveBeenCalledWith({
      id: 'user-b',
      nickname: '沈庾涛',
      avatar: 'https://example.com/avatar.png',
    })
    expect(mockEnsureProfiles).toHaveBeenCalledWith(['user-b'])
  })

  it('uses a Tencent DM update as an immediate peer hint and schedules authoritative reconciliation', () => {
    const dm = {
      ...conversation(),
      type: 1,
      name: ' 沈庾涛 ',
      avatar_url: ' https://example.com/dm-avatar.png ',
      dm_peer_user_id: 'user-b',
    }

    applyIMProviderEvent({
      type: 'conversation.updated',
      organizationId: 'organization-a',
      conversation: dm,
    })

    expect(mockUpsertProfileHint).toHaveBeenCalledWith({
      id: 'user-b',
      nickname: '沈庾涛',
      avatar: 'https://example.com/dm-avatar.png',
    })
    expect(mockEnsureProfiles).toHaveBeenCalledWith(['user-b'])
  })

  it('refreshes the shared member snapshot after a Tencent membership event', async () => {
    imState.conversations = [conversation()]

    applyIMProviderEvent({
      type: 'membership.changed',
      organizationId: 'organization-a',
      conversationId: 'conversation-a',
      memberCount: 4,
    })

    await waitFor(() => {
      expect(mockRefreshConversationMembers).toHaveBeenCalledWith(
        'conversation-a',
        {
          supersede: true,
          invalidateSnapshot: true,
          expectMembershipChange: true,
          expectedMemberCount: 4,
        },
      )
    })
  })

  it('retries group-tip reconciliation even when Tencent omits member count', async () => {
    imState.conversations = [conversation()]

    applyIMProviderEvent({
      type: 'membership.changed',
      organizationId: 'organization-a',
      conversationId: 'conversation-a',
    })

    await waitFor(() => {
      expect(mockRefreshConversationMembers).toHaveBeenCalledWith(
        'conversation-a',
        {
          supersede: true,
          invalidateSnapshot: true,
          expectMembershipChange: true,
        },
      )
    })
  })

  it('applies Tencent reaction control events by message_ref', () => {
    imState.conversations = [conversation()]

    applyIMProviderEvent({
      type: 'reaction.changed',
      organizationId: 'organization-a',
      conversationId: 'conversation-a',
      messageRef: '0198-message-ref',
      emoji: '👍',
      userId: 'user-b',
      action: 'add',
    })

    expect(imState.onReactionUpdated).toHaveBeenCalledWith(
      'conversation-a',
      '0198-message-ref',
      '👍',
      'user-b',
      'add',
      'remote',
    )

    applyIMProviderEvent({
      type: 'reaction.snapshot',
      organizationId: 'organization-a',
      conversationId: 'conversation-a',
      messageRef: '0198-message-ref',
      reactions: { 'tabtin:party:v1': ['user-b'] },
      reactionCounts: { 'tabtin:party:v1': 12 },
    })

    expect(imState.onReactionSnapshot).toHaveBeenCalledWith(
      'conversation-a',
      '0198-message-ref',
      { 'tabtin:party:v1': ['user-b'] },
      { 'tabtin:party:v1': 12 },
    )
  })

  it('advances the DM peer read watermark from an authoritative Tencent receipt', () => {
    imState.conversations = [{
      ...conversation(),
      type: 1,
      dm_peer_user_id: 'peer-user',
    }]
    const receiptMessage = {
      ...message(),
      read_receipt: { read_count: 1, recipient_count: 1 },
    }

    applyIMProviderEvent({
      type: 'message.upserted',
      organizationId: 'organization-a',
      message: receiptMessage,
    })

    expect(imState.onRealtimeMessage).toHaveBeenCalledWith(
      'conversation-a',
      receiptMessage,
      { incrementUnread: false },
    )
    expect(imState.onReadReceipt).toHaveBeenCalledWith(
      'conversation-a',
      'peer-user',
      42,
      42,
    )
  })

  it('uses a continuation card update only to reload authoritative detail', () => {
    imState.conversations = [conversation()]
    const continuationMessage: IMMessage = {
      ...message(),
      metadata: {
        ...message().metadata,
        card: {
          type: 'session_continuation',
          schema_version: 1,
          object_id: 'continuation-1',
          version: 4,
          title_snapshot: '季度经营复盘',
          sender_id: 'user-a',
          recipient_id: 'user-b',
        },
      },
    }

    applyIMProviderEvent({
      type: 'message.upserted',
      organizationId: 'organization-a',
      message: continuationMessage,
    })

    expect(imState.loadSessionContinuation).toHaveBeenCalledWith('continuation-1', 4)
  })

  it('uses a shared task card update only to reload authoritative detail', () => {
    imState.conversations = [conversation()]
    const sharedTaskMessage: IMMessage = {
      ...message(),
      metadata: {
        ...message().metadata,
        card: {
          type: 'session_share_v2',
          schema_version: 1,
          object_id: 'share-1',
          version: 3,
          title_snapshot: '季度经营复盘',
          sender_id: 'user-a',
          recipient_id: 'user-b',
        },
      },
    }

    applyIMProviderEvent({
      type: 'message.upserted',
      organizationId: 'organization-a',
      message: sharedTaskMessage,
    })

    expect(imState.loadSessionShareV2).toHaveBeenCalledWith('share-1', 3)
  })

  it('loads an unknown conversation before applying its Tencent message', async () => {
    applyIMProviderEvent({
      type: 'message.upserted',
      organizationId: 'organization-a',
      message: message(),
    })

    await vi.waitFor(() => {
      expect(imState.loadConversations).toHaveBeenCalledWith('organization-a')
      expect(imState.onRealtimeMessage).toHaveBeenCalledWith(
        'conversation-a',
        expect.objectContaining({ id: 42 }),
        { incrementUnread: false },
      )
    })
  })

  it('applies a session share domain event without depending on message visibility', () => {
    applyIMProviderEvent({
      type: 'session-share.changed',
      organizationId: 'organization-a',
      conversationId: 'conversation-a',
      projection: {
        shareId: 'share-new',
        sessionId: 'session-new',
        sessionTitle: '新协作任务',
        canFork: true,
        canChat: true,
        status: 'active',
      },
    })

    expect(imState.patchSessionShare).toHaveBeenCalledWith('share-new', {
      session_id: 'session-new',
      session_title: '新协作任务',
      can_fork: true,
      can_chat: true,
      status: 'active',
    })
    expect(imState.bumpSessionShareListVersion).toHaveBeenCalledWith('conversation-a')
    expect(imState.bumpSessionShareDetailVersion).toHaveBeenCalledWith('share-new')
    expect(imState.onRealtimeMessage).not.toHaveBeenCalled()
  })

  it('drops an in-flight Tencent event after organization access is removed', async () => {
    imState.loadConversations.mockImplementationOnce(async () => {
      organizationState.organizations = [{ id: 'organization-b' }]
    })

    applyIMProviderEvent({
      type: 'message.upserted',
      organizationId: 'organization-a',
      message: message(),
    })

    await waitFor(() => {
      expect(imState.loadConversations).toHaveBeenCalledWith('organization-a')
    })
    await Promise.resolve()
    expect(imState.onRealtimeMessage).not.toHaveBeenCalled()
  })

  it('uses absolute unread snapshots and membership changes', () => {
    imState.conversations = [{
      ...conversation(),
      id: 'conversation-b',
      name: '项目群',
    }]
    const snapshot = {
      total: 5,
      conversations: { 'conversation-a': 5 },
    }

    applyIMProviderEvent({
      type: 'unread.updated',
      organizationId: 'organization-a',
      snapshot,
    })
    applyIMProviderEvent({
      type: 'membership.changed',
      organizationId: 'organization-a',
      conversationId: 'conversation-a',
      memberCount: 4,
    })
    applyIMProviderEvent({
      type: 'membership.changed',
      organizationId: 'organization-a',
      conversationId: 'conversation-b',
      removedCurrentUser: true,
    })

    expect(imState.applyUnreadSnapshot).toHaveBeenCalledWith(
      'organization-a',
      snapshot,
    )
    expect(imState.updateConversation).toHaveBeenCalledWith(
      'conversation-a',
      { member_count: 4 },
    )
    expect(imState.removeConversation).toHaveBeenCalledWith('conversation-b')
    expect(mockToast).toHaveBeenCalledWith({
      title: '你已不在此群聊中',
      description: '项目群',
    })
  })

  it('restarts Django IM when store connection status drops while still signed in', async () => {
    const hook = renderHook(() => useIMProviderClient())

    await waitFor(() => {
      expect(mockStartIMProvider).toHaveBeenCalledOnce()
    })
    mockStartIMProvider.mockClear()
    imState.connectionStatus = 'connected'
    hook.rerender()
    expect(mockStartIMProvider).not.toHaveBeenCalled()

    imState.connectionStatus = 'disconnected'
    hook.rerender()

    await waitFor(() => {
      expect(mockStartIMProvider).toHaveBeenCalledWith({
        organizationId: 'organization-a',
        userId: 'user-a',
      })
    })
    expect(mockStopIMProvider).not.toHaveBeenCalled()
  })

  it('starts only the selected organization and ignores organization list refreshes', async () => {
    const unsubscribeA = vi.fn()
    const unsubscribeB = vi.fn()
    mockSubscribeIMProvider.mockImplementation(
      (organizationId: string) =>
        organizationId === 'organization-a' ? unsubscribeA : unsubscribeB,
    )

    const hook = renderHook(() => useIMProviderClient())

    await waitFor(() => {
      expect(mockStartIMProvider).toHaveBeenCalledOnce()
    })
    expect(mockStartIMProvider).toHaveBeenCalledWith({
      organizationId: 'organization-a',
      userId: 'user-a',
    })

    organizationState.organizations = [{ id: 'organization-a' }]
    hook.rerender()

    expect(mockStartIMProvider).toHaveBeenCalledOnce()
    expect(mockStopIMProvider).not.toHaveBeenCalled()
    expect(unsubscribeA).not.toHaveBeenCalled()
    expect(unsubscribeB).not.toHaveBeenCalled()

    hook.unmount()
    expect(unsubscribeA).toHaveBeenCalledOnce()
    expect(mockStopIMProvider).not.toHaveBeenCalled()
  })

  it('lets the main-owned Tencent session switch selected organizations', async () => {
    const hook = renderHook(() => useIMProviderClient())

    await waitFor(() => {
      expect(mockStartIMProvider).toHaveBeenCalledWith({
        organizationId: 'organization-a',
        userId: 'user-a',
      })
    })

    organizationState.selectedOrganization = { id: 'organization-b' }
    hook.rerender()

    await waitFor(() => {
      expect(mockStartIMProvider).toHaveBeenLastCalledWith({
        organizationId: 'organization-b',
        userId: 'user-a',
      })
    })
    expect(mockStopIMProvider).not.toHaveBeenCalled()
  })

  it('stops the shared IM session when the authenticated user changes', async () => {
    const hook = renderHook(() => useIMProviderClient())

    await waitFor(() => {
      expect(mockStartIMProvider).toHaveBeenCalledOnce()
    })

    authState.user = null
    authState.isAuthenticated = false
    hook.rerender()

    await waitFor(() => {
      expect(mockStopIMProvider).toHaveBeenCalledOnce()
    })
    expect(mockSubscribeIMProvider.mock.results[0]?.value).toHaveBeenCalledOnce()
    hook.unmount()
  })

  it('delivers a Tencent provider event through the event bus into the IM store', async () => {
    let providerListener: ((event: unknown) => void) | undefined
    mockSubscribeIMProvider.mockImplementation((organizationId, listener) => {
      if (organizationId === 'organization-a') providerListener = listener
      return vi.fn()
    })
    imState.conversations = [conversation()]

    const hook = renderHook(() => useIMProviderClient())

    await waitFor(() => {
      expect(mockStartIMProvider).toHaveBeenCalledOnce()
    })
    providerListener?.({
      type: 'message.upserted',
      organizationId: 'organization-a',
      message: message(),
    })

    expect(imState.onRealtimeMessage).toHaveBeenCalledWith(
      'conversation-a',
      expect.objectContaining({ id: 42 }),
      { incrementUnread: false },
    )

    hook.unmount()
  })
})
