import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CONVERSATION_TYPE_DM, CONVERSATION_TYPE_GROUP } from '@/constants/tabchat'

const {
  imStateRef,
  mockLoadMessages,
  mockLoadPinnedMessages,
  mockSendMessage,
  mockRefreshConversationMembers,
  mockRemoveConversation,
  mockGetMessages,
  mockEnsureFileAttachmentsChecked,
  mockUpsertProfileHint,
  messageListPropsRef,
  mockT,
} = vi.hoisted(() => ({
  imStateRef: {
    current: {
      conversations: [
        {
          id: 'group-1',
          organization_id: 'ws-1',
          type: 2,
          transport_kind: 'group' as 'group' | 'c2c',
          name: 'Group',
          avatar_url: '',
          member_count: 2,
          last_message_at: null,
          last_message_preview: '',
          unread_count: 0,
          created_at: '',
        },
        {
          id: 'dm-1',
          organization_id: 'ws-1',
          type: 1,
          transport_kind: 'group' as 'group' | 'c2c',
          name: 'Alice',
          avatar_url: '',
          member_count: 2,
          last_message_at: null,
          last_message_preview: '',
          unread_count: 0,
          created_at: '',
        },
        {
          id: 'group-2',
          organization_id: 'ws-1',
          type: 2,
          transport_kind: 'group' as 'group' | 'c2c',
          name: 'Other Group',
          avatar_url: '',
          member_count: 2,
          last_message_at: null,
          last_message_preview: '',
          unread_count: 0,
          created_at: '',
        },
      ],
      messages: {} as Record<string, Array<Record<string, unknown>>>,
      conversationMembers: {} as Record<string, Array<Record<string, unknown>>>,
      isSending: false,
      messageLoadingByConversation: {} as Record<string, boolean>,
    },
  },
  mockLoadMessages: vi.fn(() => Promise.resolve([])),
  mockLoadPinnedMessages: vi.fn(),
  mockSendMessage: vi.fn(() => Promise.resolve()),
  mockRefreshConversationMembers: vi.fn(() => Promise.resolve()),
  mockRemoveConversation: vi.fn(),
  mockGetMessages: vi.fn(() => Promise.resolve([])),
  mockEnsureFileAttachmentsChecked: vi.fn(),
  mockUpsertProfileHint: vi.fn(),
  messageListPropsRef: {
    current: undefined as readonly string[] | undefined,
  },
  mockT: (key: string, opts?: Record<string, string>) =>
    opts?.name ? `${key}:${opts.name}` : key,
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: mockT,
  }),
}))

vi.mock('@stores/useIMStore', () => {
  const useIMStore = ((selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      conversations: imStateRef.current.conversations,
      messages: imStateRef.current.messages,
      conversationMembers: imStateRef.current.conversationMembers,
      loadMessages: mockLoadMessages,
      sendMessage: mockSendMessage,
      refreshConversationMembers: mockRefreshConversationMembers,
      isSending: imStateRef.current.isSending,
      messageLoadingByConversation: imStateRef.current.messageLoadingByConversation,
      pinnedMessages: {},
    })) as typeof import('@stores/useIMStore').useIMStore

  useIMStore.getState = () => ({
    currentConversationId: 'group-1',
    loadPinnedMessages: mockLoadPinnedMessages,
    navigateToMessage: vi.fn(),
    onMessageUnpinned: vi.fn(),
    removeConversation: mockRemoveConversation,
  }) as never

  return { useIMStore }
})

vi.mock('@stores/useAuthStore', () => {
  const useAuthStore = ((selector: (state: Record<string, unknown>) => unknown) =>
    selector({ user: { id: 'user-1' } })) as typeof import('@stores/useAuthStore').useAuthStore
  useAuthStore.getState = () => ({ user: { id: 'user-1' } }) as never
  return { useAuthStore }
})

vi.mock('@stores/useFileAttachmentStore', () => ({
  useFileAttachmentStore: {
    getState: () => ({ ensureChecked: mockEnsureFileAttachmentsChecked }),
  },
}))

vi.mock('@stores/useUserProfileCache', () => {
  const useUserProfileCache = ((selector: (state: { ensureProfiles: () => void }) => unknown) =>
    selector({ ensureProfiles: vi.fn() })) as typeof import('@stores/useUserProfileCache').useUserProfileCache
  useUserProfileCache.getState = () => ({
    ensureProfiles: vi.fn(),
    upsertProfileHint: mockUpsertProfileHint,
  }) as never
  return {
    useDisplayName: () => '',
    useDisplayNames: () => ({}),
    useUserProfile: () => undefined,
    useUserProfileCache,
  }
})

vi.mock('@stores/useOrganizationStore', () => {
  const useOrganizationStore = ((selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      selectedOrganization: { id: 'ws-1' },
      members: [],
      loadMembers: vi.fn(),
    })) as typeof import('@stores/useOrganizationStore').useOrganizationStore
  useOrganizationStore.subscribe = vi.fn()
  return { useOrganizationStore }
})

vi.mock('@/services/tabchatApi', () => ({
  getMessages: mockGetMessages,
  addMembers: vi.fn(),
  removeMember: vi.fn(),
  updateConversation: vi.fn(),
  searchOrganizationMembers: vi.fn(() => Promise.resolve([])),
}))

vi.mock('./IMMessageList', () => ({
  IMMessageList: React.forwardRef(({
    messages,
    onReply,
    onReEdit,
    currentHumanMemberIds,
  }: {
    messages: Array<{ id: number; content: string; sender_id: string }>
    onReply?: (message: { id: number; content: string; sender_id: string }) => void
    onReEdit?: (content: string) => void
    currentHumanMemberIds?: readonly string[]
  }, _ref) => {
    messageListPropsRef.current = currentHumanMemberIds
    return React.createElement(
      'div',
      { 'data-testid': 'message-list' },
      messages[0] && onReply
        ? React.createElement(
            'button',
            { type: 'button', onClick: () => onReply(messages[0]) },
            'reply-first-message',
          )
        : null,
      onReEdit
        ? React.createElement(
            'button',
            { type: 'button', onClick: () => onReEdit('撤回消息原文') },
            're-edit-message',
          )
        : null,
    )
  }),
}))

vi.mock('./IMMessageInput', () => ({
  IMMessageInput: ({
    onSend,
    replyTo,
    draft,
  }: {
    onSend: (
      content: string,
      replyTarget?: { id: number },
      messageType?: number,
      metadata?: Record<string, unknown>,
    ) => void
    replyTo?: { id: number } | null
    draft?: { text: string; token: number } | null
  }) => {
    const [text, setText] = React.useState('')
    React.useEffect(() => {
      if (draft) setText(draft.text)
    }, [draft])
    return React.createElement(
      'div',
      { 'data-testid': 'message-input' },
      React.createElement('textarea', {
        'data-testid': 'composer-text',
        value: text,
        readOnly: true,
      }),
      React.createElement(
        'button',
        { type: 'button', onClick: () => onSend('reply text', replyTo ?? undefined, 1) },
        'send-reply-text',
      ),
      React.createElement(
        'button',
        { type: 'button', onClick: () => onSend('', undefined, 3, { file_name: 'brief.pdf' }) },
        'send-non-reply-file',
      ),
    )
  },
}))

vi.mock('./FilteredHistoryList', () => ({
  FilteredHistoryList: ({
    messages,
    contentFilter,
    hasMore,
    onLoadMore,
  }: {
    messages: Array<{ id: number }>
    contentFilter: string
    hasMore?: boolean
    onLoadMore?: () => void
  }) => React.createElement(
    'div',
    { 'data-testid': 'content-history-list', 'data-filter': contentFilter },
    `items:${messages.map((message) => message.id).join(',')}`,
    hasMore
      ? React.createElement('button', { type: 'button', onClick: onLoadMore }, 'load-more-filtered')
      : null,
  ),
}))

vi.mock('./ConversationDetailPanel', () => ({
  ConversationDetailPanel: ({
    isOpen,
    onClose,
    onHistoryCleared,
  }: {
    isOpen: boolean
    onClose: () => void
    onHistoryCleared?: () => void
  }) => (
    isOpen
      ? React.createElement(
          'div',
          { 'data-testid': 'conversation-detail-panel' },
          React.createElement('div', null, 'humanMembers (2)'),
          React.createElement('button', { type: 'button', onClick: onClose }, 'cancel'),
          React.createElement('button', { type: 'button', onClick: onHistoryCleared }, 'clear-history'),
        )
      : null
  ),
}))

vi.mock('./ReplyThreadPanel', () => ({
  ReplyThreadPanel: () => null,
}))

vi.mock('./PinnedMessagesBar', () => ({
  PinnedMessagesBar: () => React.createElement('div', { 'data-testid': 'pinned-messages' }),
}))

vi.mock('@components/common/ListSkeletons', () => ({
  DetailedRowListSkeleton: () => React.createElement('div', { 'data-testid': 'skeleton' }),
}))

vi.stubGlobal('ResizeObserver', class {
  observe() {}
  disconnect() {}
})

describe('ChatView member panel', () => {
  beforeEach(() => {
    cleanup()
    vi.clearAllMocks()
    imStateRef.current.conversations[0].type = CONVERSATION_TYPE_GROUP
    imStateRef.current.conversations[0].transport_kind = 'group'
    imStateRef.current.conversations[1].type = CONVERSATION_TYPE_DM
    imStateRef.current.conversations[1].transport_kind = 'group'
    imStateRef.current.conversations[2].type = CONVERSATION_TYPE_GROUP
    imStateRef.current.conversations[2].transport_kind = 'group'
    imStateRef.current.messages = {}
    imStateRef.current.conversationMembers = {
      'group-1': [
        {
          member_type: 'user',
          user_id: 'user-1',
          agent_id: null,
          nickname: 'Me',
          role: 3,
        },
        {
          member_type: 'user',
          user_id: 'user-2',
          agent_id: null,
          nickname: 'Bob',
          role: 1,
        },
      ],
      'dm-1': [],
      'group-2': [],
    }
    mockRefreshConversationMembers.mockResolvedValue(undefined)
    messageListPropsRef.current = undefined
  })

  it('does not load or render group pin actions for a C2C conversation', async () => {
    imStateRef.current.conversations[1].transport_kind = 'c2c'
    const { ChatView } = await import('./ChatView')

    render(<ChatView conversationId="dm-1" />)

    expect(screen.queryByTestId('pinned-messages')).toBeNull()
    expect(mockLoadPinnedMessages).not.toHaveBeenCalled()
  })

  it('passes Tencent provider identities to read-receipt member filtering', async () => {
    const { ChatView } = await import('./ChatView')

    render(<ChatView conversationId="group-1" />)

    await waitFor(() => {
      expect(messageListPropsRef.current).toEqual(['u_mdxlytf2emhyk2f5fs7xunfiivtpk'])
    })
    expect(mockUpsertProfileHint).toHaveBeenCalledWith({
      id: 'u_mdxlytf2emhyk2f5fs7xunfiivtpk',
      nickname: 'Bob',
      username: '',
      avatar: '',
    })
  })

  it('silently removes a stale conversation when member refresh confirms it is gone', async () => {
    const notFound = Object.assign(new Error('conversation not found'), {
      data: { code: 404, message: 'conversation not found' },
    })
    mockRefreshConversationMembers.mockRejectedValue(notFound)
    const { ChatView } = await import('./ChatView')

    render(<ChatView conversationId="group-1" />)

    await waitFor(() => {
      expect(mockRemoveConversation).toHaveBeenCalledWith('group-1')
    })
  })

  it('does not render a typing indicator', async () => {
    const { ChatView } = await import('./ChatView')

    render(<ChatView conversationId="group-1" />)

    expect(screen.queryByText(/typing$/)).toBeNull()
  }, 20000)

  // ：飞书风 — 底栏透明留两侧暗底；不透明面在输入井卡片（由 IMMessageInput 负责）
  it('keeps the floating composer bottom bar transparent so side gutters stay dark', async () => {
    const { ChatView } = await import('./ChatView')

    render(<ChatView conversationId="group-1" />)

    const bottomBar = screen.getByTestId('im-composer-bottom-bar')
    expect(bottomBar.classList.contains('bg-background')).toBe(false)
    expect(bottomBar.classList.contains('absolute')).toBe(true)
    expect(bottomBar.classList.contains('bottom-0')).toBe(true)
  })

  it('opens the detail panel on demand and closes it with X', async () => {
    const { ChatView } = await import('./ChatView')

    render(<ChatView conversationId="group-1" />)

    // 详情浮层默认不展开（按需滑出）
    expect(screen.queryByTestId('conversation-detail-panel')).toBeNull()
    fireEvent.click(screen.getAllByRole('button', { name: 'members' }).at(-1) as HTMLElement)
    expect(await screen.findByTestId('conversation-detail-panel')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'cancel' }))
    expect(screen.queryByTestId('conversation-detail-panel')).toBeNull()
  }, 20000)

  it('closes the detail panel when switching from a group to a DM', async () => {
    const { ChatView } = await import('./ChatView')

    const { rerender } = render(<ChatView conversationId="group-1" />)
    fireEvent.click(screen.getAllByRole('button', { name: 'members' }).at(-1) as HTMLElement)
    expect(await screen.findByTestId('conversation-detail-panel')).toBeTruthy()

    rerender(<ChatView conversationId="dm-1" />)

    await waitFor(() => {
      expect(screen.queryByTestId('conversation-detail-panel')).toBeNull()
    })
  }, 20000)

  it('closes the detail panel when switching between group conversations', async () => {
    const { ChatView } = await import('./ChatView')

    const { rerender } = render(<ChatView conversationId="group-1" />)
    fireEvent.click(screen.getAllByRole('button', { name: 'members' }).at(-1) as HTMLElement)
    expect(await screen.findByTestId('conversation-detail-panel')).toBeTruthy()

    rerender(<ChatView conversationId="group-2" />)
    await waitFor(() => {
      expect(screen.queryByTestId('conversation-detail-panel')).toBeNull()
    })
  })

  it('does not carry a recalled-message draft into another conversation', async () => {
    const { ChatView } = await import('./ChatView')
    const { rerender } = render(<ChatView conversationId="group-1" />)

    fireEvent.click(screen.getByRole('button', { name: 're-edit-message' }))
    expect((screen.getByTestId('composer-text') as HTMLTextAreaElement).value)
      .toBe('撤回消息原文')

    rerender(<ChatView conversationId="group-2" />)

    await waitFor(() => {
      expect((screen.getByTestId('composer-text') as HTMLTextAreaElement).value).toBe('')
    })
  })

  it('loads filtered document history from the current conversation', async () => {
    const { ChatView } = await import('./ChatView')

    render(<ChatView conversationId="group-1" />)
    fireEvent.click(screen.getByRole('tab', { name: 'contentFilterDocuments' }))

    await waitFor(() => {
      expect(mockGetMessages).toHaveBeenCalledWith(
        'group-1',
        undefined,
        undefined,
        'document',
      )
    })
    expect(await screen.findByTestId('content-history-list')).toBeTruthy()
    expect(screen.queryByTestId('message-list')).toBeNull()
  })

  it('checks attachment availability for filtered file history', async () => {
    const fileMessage = {
      id: 42,
      conversation_id: 'group-1',
      sender_id: 'user-2',
      content: '',
      message_type: 3,
      reply_to_id: null,
      has_attachment: true,
      metadata: { file_name: 'brief.pdf' },
      created_at: '2026-06-23T00:00:00Z',
    }
    mockGetMessages.mockResolvedValueOnce([fileMessage])
    const { ChatView } = await import('./ChatView')

    render(<ChatView conversationId="group-1" />)
    fireEvent.click(screen.getByRole('tab', { name: 'contentFilterFiles' }))

    await waitFor(() => {
      expect(mockEnsureFileAttachmentsChecked).toHaveBeenCalledWith([fileMessage])
    })
    expect((await screen.findByTestId('content-history-list')).getAttribute('data-filter')).toBe('file')
  })

  it('does not show stale filtered history when switching conversations', async () => {
    const firstConversationMessage = {
      id: 77,
      conversation_id: 'group-1',
      sender_id: 'user-2',
      content: '',
      message_type: 1,
      reply_to_id: null,
      has_attachment: false,
      metadata: { card: { type: 'document', resource_id: 'doc-1', name: '方案' } },
      created_at: '2026-06-23T00:00:00Z',
    }
    mockGetMessages.mockResolvedValueOnce([firstConversationMessage])
    const { ChatView } = await import('./ChatView')

    const { rerender } = render(<ChatView conversationId="group-1" />)
    fireEvent.click(screen.getByRole('tab', { name: 'contentFilterDocuments' }))
    expect((await screen.findByTestId('content-history-list')).textContent).toContain('77')

    rerender(<ChatView conversationId="group-2" />)

    expect(screen.getByTestId('content-history-list').textContent).not.toContain('77')
  })

  it('includes realtime store messages in the filtered document list', async () => {
    imStateRef.current.messages = {
      'group-1': [
        {
          id: 66,
          conversation_id: 'group-1',
          sender_id: 'user-2',
          content: '',
          message_type: 1,
          reply_to_id: null,
          has_attachment: false,
          metadata: { card: { type: 'document', resource_id: 'doc-live', name: '实时文档' } },
          created_at: '2026-06-23T00:00:00Z',
        },
        {
          id: 67,
          conversation_id: 'group-1',
          sender_id: 'user-2',
          content: '',
          message_type: 1,
          reply_to_id: null,
          has_attachment: false,
          metadata: { card: { type: 'table', resource_id: 'table-live', name: '实时表格' } },
          created_at: '2026-06-23T00:00:00Z',
        },
      ],
    }
    mockGetMessages.mockResolvedValueOnce([])
    const { ChatView } = await import('./ChatView')

    render(<ChatView conversationId="group-1" />)
    fireEvent.click(screen.getByRole('tab', { name: 'contentFilterDocuments' }))

    const listText = (await screen.findByTestId('content-history-list')).textContent || ''
    expect(listText).toContain('66')
    expect(listText).toContain('67')
  })

  it('uses API filtered history, not merged realtime rows, as load-more cursor', async () => {
    imStateRef.current.messages = {
      'group-1': [
        {
          id: 10,
          conversation_id: 'group-1',
          sender_id: 'user-2',
          content: '',
          message_type: 1,
          reply_to_id: null,
          has_attachment: false,
          metadata: { card: { type: 'document', resource_id: 'doc-store', name: '已加载文档' } },
          created_at: '2026-06-23T00:00:00Z',
        },
      ],
    }
    const apiMessage = {
      id: 50,
      conversation_id: 'group-1',
      sender_id: 'user-2',
      content: '',
      message_type: 1,
      reply_to_id: null,
      has_attachment: false,
      metadata: { card: { type: 'document', resource_id: 'doc-api', name: '接口文档' } },
      created_at: '2026-06-23T00:00:00Z',
    }
    mockGetMessages
      .mockResolvedValueOnce([apiMessage])
      .mockResolvedValueOnce([])
    const { ChatView } = await import('./ChatView')

    render(<ChatView conversationId="group-1" />)
    fireEvent.click(screen.getByRole('tab', { name: 'contentFilterDocuments' }))
    expect((await screen.findByTestId('content-history-list')).textContent).toContain('items:10,50')

    fireEvent.click(screen.getByRole('button', { name: 'load-more-filtered' }))

    await waitFor(() => {
      expect(mockGetMessages).toHaveBeenLastCalledWith('group-1', 50, undefined, 'document')
    })
  })

  it('retries the first filtered page after an initial fetch error', async () => {
    imStateRef.current.messages = {
      'group-1': [
        {
          id: 12,
          conversation_id: 'group-1',
          sender_id: 'user-2',
          content: '',
          message_type: 1,
          reply_to_id: null,
          has_attachment: false,
          metadata: { card: { type: 'document', resource_id: 'doc-live', name: '实时文档' } },
          created_at: '2026-06-23T00:00:00Z',
        },
      ],
    }
    mockGetMessages
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValueOnce([])
    const { ChatView } = await import('./ChatView')

    render(<ChatView conversationId="group-1" />)
    fireEvent.click(screen.getByRole('tab', { name: 'contentFilterDocuments' }))
    expect((await screen.findByTestId('content-history-list')).textContent).toContain('12')

    fireEvent.click(screen.getByRole('button', { name: 'load-more-filtered' }))

    await waitFor(() => {
      expect(mockGetMessages).toHaveBeenLastCalledWith('group-1', undefined, undefined, 'document')
    })
  })

  it('clears local filtered history when chat history is cleared', async () => {
    const filteredMessage = {
      id: 91,
      conversation_id: 'group-1',
      sender_id: 'user-2',
      content: '',
      message_type: 1,
      reply_to_id: null,
      has_attachment: false,
      metadata: { card: { type: 'document', resource_id: 'doc-clear', name: '待清空文档' } },
      created_at: '2026-06-23T00:00:00Z',
    }
    mockGetMessages.mockResolvedValueOnce([filteredMessage])
    const { ChatView } = await import('./ChatView')

    render(<ChatView conversationId="group-1" />)
    fireEvent.click(screen.getByRole('tab', { name: 'contentFilterDocuments' }))
    expect((await screen.findByTestId('content-history-list')).textContent).toContain('91')
    // 打开详情浮层后清空记录
    fireEvent.click(screen.getAllByRole('button', { name: 'members' }).at(-1) as HTMLElement)
    fireEvent.click(screen.getByRole('button', { name: 'clear-history' }))

    expect(screen.queryByText(/91/)).toBeNull()
  })

  it('removes API cached filtered rows when the store marks them deleted', async () => {
    const cachedMessage = {
      id: 92,
      conversation_id: 'group-1',
      sender_id: 'user-2',
      content: '',
      message_type: 1,
      reply_to_id: null,
      has_attachment: false,
      metadata: { card: { type: 'document', resource_id: 'doc-deleted', name: '已撤回文档' } },
      created_at: '2026-06-23T00:00:00Z',
    }
    imStateRef.current.messages = {
      'group-1': [{ ...cachedMessage, is_deleted: true }],
    }
    mockGetMessages.mockResolvedValueOnce([cachedMessage])
    const { ChatView } = await import('./ChatView')

    render(<ChatView conversationId="group-1" />)
    fireEvent.click(screen.getByRole('tab', { name: 'contentFilterDocuments' }))

    expect((await screen.findByTestId('content-history-list')).textContent).not.toContain('92')
  })
})
