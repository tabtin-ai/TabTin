import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CONVERSATION_TYPE_DM,
  CONVERSATION_TYPE_GROUP,
  MESSAGE_TYPE_FILE,
  MESSAGE_TYPE_IMAGE,
  MESSAGE_TYPE_SYSTEM,
  MESSAGE_TYPE_TEXT,
} from '@/constants/tabchat'
import { IM_MESSAGE_CONTENT_MAX_BYTES } from '@/services/im/imMessageLimits'

const {
  mockRegisterResetAction,
  mockEmitNavigate,
  mockOnNavigate,
  mockCreateDM,
  mockCreateGroup,
  mockGetConversation,
  mockListLabels,
  mockListConversations,
  mockListExternalContacts,
  mockGetUnreadCount,
  mockGetMessages,
  mockGetPinnedMessages,
  mockSendMessage,
  mockGetSessionShare,
  mockBatchGetSessionShareV2,
  mockCreateClientRequestId,
  mockCreateMessageRef,
  mockEnsureAttachmentChecked,
  mockMarkLocalFile,
  mockActivateConversation,
  mockClearActiveContext,
  mockInvalidateMembershipQuotaUsage,
  mockSelectedOrganizationId,
  mockOrganizationMembers,
  mockLoadMembers,
  mockUserRef,
  mockSelectionState,
  mockMainNavTab,
  mockSetMainNavTab,
  mockUpsertProfile,
  mockUpsertProfileHint,
  mockEnsureProfiles,
} = vi.hoisted(() => ({
  mockRegisterResetAction: vi.fn(),
  mockEmitNavigate: vi.fn(),
  mockOnNavigate: vi.fn(() => vi.fn()),
  mockCreateDM: vi.fn(),
  mockCreateGroup: vi.fn(),
  mockGetConversation: vi.fn(),
  mockListLabels: vi.fn(),
  mockListConversations: vi.fn(),
  mockListExternalContacts: vi.fn(),
  mockGetUnreadCount: vi.fn(),
  mockGetMessages: vi.fn(),
  mockGetPinnedMessages: vi.fn(),
  mockSendMessage: vi.fn(),
  mockGetSessionShare: vi.fn(),
  mockBatchGetSessionShareV2: vi.fn(),
  mockCreateClientRequestId: vi.fn(() => '0198c96d-a000-7000-8000-000000000001'),
  mockCreateMessageRef: vi.fn(() => '0198c96d-a001-7000-8000-000000000002'),
  mockEnsureAttachmentChecked: vi.fn(),
  mockMarkLocalFile: vi.fn(),
  mockActivateConversation: vi.fn(() => true),
  mockClearActiveContext: vi.fn(),
  mockInvalidateMembershipQuotaUsage: vi.fn(),
  mockSelectedOrganizationId: { value: 'ws-1' as string | null },
  mockOrganizationMembers: { value: [] as Array<{ user_id: string; user?: { nickname?: string; username?: string } }> },
  mockLoadMembers: vi.fn(),
  mockUserRef: {
    current: {
      id: 'user-1',
      nickname: 'Alice',
      username: 'alice',
    },
  },
  mockSelectionState: {
    selectedSpaceId: null as string | null,
    selectedSpaceKind: null as 'workspace' | 'dm' | 'im-group' | 'team' | null,
  },
  mockMainNavTab: { value: 'agent' as 'im' | 'agent' | 'project' | 'me' },
  mockSetMainNavTab: vi.fn((tab: 'im' | 'agent' | 'project' | 'me') => {
    mockMainNavTab.value = tab
  }),
  mockUpsertProfile: vi.fn(),
  mockUpsertProfileHint: vi.fn(),
  mockEnsureProfiles: vi.fn(),
}))

vi.mock('../sessionResetRegistry', () => ({
  registerResetAction: mockRegisterResetAction,
}))

vi.mock('../viewNavigation', () => ({
  emitNavigate: mockEmitNavigate,
  onNavigate: mockOnNavigate,
}))

vi.mock('../useOrganizationStore', () => ({
  useOrganizationStore: {
    getState: () => ({
      selectedOrganization: mockSelectedOrganizationId.value
        ? { id: mockSelectedOrganizationId.value }
        : null,
      organizations: mockSelectedOrganizationId.value
        ? [{ id: mockSelectedOrganizationId.value }]
        : [],
      members: mockOrganizationMembers.value,
      loadMembers: mockLoadMembers,
    }),
  },
}))

vi.mock('../useAuthStore', () => ({
  useAuthStore: {
    getState: () => ({
      user: mockUserRef.current,
    }),
    subscribe: vi.fn(() => vi.fn()),
  },
}))

vi.mock('@stores/useSpaceListStore', () => ({
  useSpaceListStore: {
    getState: () => ({
      activateConversation: mockActivateConversation,
      clearActiveContext: mockClearActiveContext,
      selectedSpaceId: mockSelectionState.selectedSpaceId,
      selectedSpaceKind: mockSelectionState.selectedSpaceKind,
    }),
  },
}))

vi.mock('@stores/useMainNavStore', () => ({
  useMainNavStore: {
    getState: () => ({
      currentTab: mockMainNavTab.value,
      setCurrentTab: mockSetMainNavTab,
    }),
  },
}))

vi.mock('@/services/systemNotification', () => ({
  SystemNotification: {
    imMessage: vi.fn(),
  },
}))

vi.mock('@/services/tabchatApi', () => ({
  SYSTEM_LABEL_MENTION_ID: 'sys:mention',
  createDM: mockCreateDM,
  createGroup: mockCreateGroup,
  getConversation: mockGetConversation,
  listLabels: mockListLabels,
  listConversations: mockListConversations,
  listExternalContacts: mockListExternalContacts,
  getMessages: mockGetMessages,
  getPinnedMessages: mockGetPinnedMessages,
  sendMessage: mockSendMessage,
  getSessionShare: mockGetSessionShare,
  batchGetSessionShareV2: mockBatchGetSessionShareV2,
  createClientRequestId: mockCreateClientRequestId,
  createMessageRef: mockCreateMessageRef,
  markRead: vi.fn(),
  getUnreadCount: mockGetUnreadCount,
}))

vi.mock('@/lib/query-client', () => ({
  queryClient: {},
}))

vi.mock('@/hooks/queries/membership', () => ({
  invalidateMembershipQuotaUsage: mockInvalidateMembershipQuotaUsage,
}))

vi.mock('@stores/useFileAttachmentStore', () => ({
  useFileAttachmentStore: {
    getState: () => ({
      ensureChecked: mockEnsureAttachmentChecked,
      markLocalFile: mockMarkLocalFile,
      reset: vi.fn(),
    }),
  },
}))

vi.mock('@stores/useUserProfileCache', () => ({
  useUserProfileCache: {
    getState: () => ({
      upsertProfile: mockUpsertProfile,
      upsertProfileHint: mockUpsertProfileHint,
      ensureProfiles: mockEnsureProfiles,
    }),
  },
}))

let useIMStore: typeof import('../useIMStore').useIMStore

function buildConversation(overrides: Record<string, unknown> = {}) {
  return {
    id: 'conv-1',
    organization_id: 'ws-1',
    space_id: 'space-conv-1',
    type: 1,
    name: '新会话',
    avatar_url: '',
    member_count: 2,
    last_message_at: null,
    last_message_preview: '',
    unread_count: 0,
    created_at: '2026-03-13T00:00:00Z',
    dm_peer_user_id: 'user-2',
    dm_peer_organization_id: 'peer-org',
    pinned: false,
    is_muted: false,
    members: [],
    dm_hash: null,
    created_by: 'user-1',
    ...overrides,
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

function baseMessage(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    seq: 1,
    conversation_id: 'conv-1',
    sender_id: 'user-2',
    content: 'message',
    message_type: MESSAGE_TYPE_TEXT,
    reply_to_id: null,
    has_attachment: false,
    metadata: {},
    created_at: '2026-08-07T00:00:00Z',
    ...overrides,
  }
}

beforeEach(async () => {
  vi.restoreAllMocks()
  vi.clearAllMocks()
  vi.resetModules()
  vi.spyOn(document, 'hasFocus').mockReturnValue(true)
  mockSelectedOrganizationId.value = 'ws-1'
  mockOrganizationMembers.value = []
  mockSelectionState.selectedSpaceId = null
  mockSelectionState.selectedSpaceKind = null
  mockMainNavTab.value = 'agent'
  mockUserRef.current = {
    id: 'user-1',
    nickname: 'Alice',
    username: 'alice',
  }
  mockListExternalContacts.mockResolvedValue({ items: [] })

  const mod = await import('../useIMStore')
  useIMStore = mod.useIMStore
  useIMStore.setState({
    isIMActive: false,
    conversations: [],
    currentConversationId: null,
    messages: {},
    pinnedMessages: {},
    hasMoreMessages: {},
    unreadCounts: {},
    totalUnread: 0,
    isLoadingConversations: false,
    messageLoadingByConversation: {},
    isSending: false,
    connectionStatus: 'disconnected',
    sendError: null,
    loadError: null,
    readReceipts: {},
    scrollTargetConversationId: null,
    scrollToMessageId: null,
    scrollToMessageRef: null,
  })
})

describe('useIMStore navigation state', () => {
  it('进入通讯录时清空会话上下文并保留最近打开记录', () => {
    useIMStore.setState({
      isIMActive: true,
      conversations: [buildConversation({ id: 'conv-1', organization_id: 'ws-1' })],
    })
    useIMStore.getState().setCurrentConversation('conv-1')
    useIMStore.getState().setImSidebarView('contacts')

    expect(mockClearActiveContext).toHaveBeenCalledWith({ preserveOrganizationMemory: true })
    expect(useIMStore.getState()).toEqual(expect.objectContaining({
      currentConversationId: null,
      lastOpenedConversationIdByOrganization: { 'ws-1': 'conv-1' },
      imSidebarView: 'contacts',
    }))
  })

  it('打开具体会话时保持消息模块选中，并回到会话列表语境', () => {
    useIMStore.setState({
      imSidebarView: 'contacts',
      conversations: [buildConversation({ id: 'conv-1', organization_id: 'ws-1' })],
    })

    useIMStore.getState().openIM()
    useIMStore.getState().setCurrentConversation('conv-1')

    expect(mockSetMainNavTab).toHaveBeenCalledWith('im')
    expect(useIMStore.getState()).toEqual(expect.objectContaining({
      isIMActive: true,
      currentConversationId: 'conv-1',
      lastOpenedConversationIdByOrganization: { 'ws-1': 'conv-1' },
      imSidebarView: 'inbox',
    }))
  })

  it('切出消息 tab 清空当前会话时仍保留最近打开记录', () => {
    useIMStore.setState({
      conversations: [buildConversation({ id: 'conv-1', organization_id: 'ws-1' })],
    })

    useIMStore.getState().setCurrentConversation('conv-1')
    useIMStore.getState().setCurrentConversation(null)

    expect(useIMStore.getState()).toEqual(expect.objectContaining({
      currentConversationId: null,
      lastOpenedConversationIdByOrganization: { 'ws-1': 'conv-1' },
    }))
  })
})

describe('useIMStore 消息定位', () => {
  it('跳转到未加载的消息时直接加载该消息所在页，而非逐页回溯', async () => {
    const target = {
      id: 500,
      transport: {
        kind: 'c2c' as const,
        sent_at: '2026-06-24T00:00:00Z',
        sequence: 3,
      },
      conversation_id: 'conv-1',
      sender_id: 'user-2',
      content: '被引用的历史消息',
      message_type: 1,
      created_at: '2026-06-24T00:00:00Z',
      is_deleted: false,
      metadata: { message_ref: 'target-message-ref' },
    }
    mockGetMessages.mockResolvedValueOnce([target])
    useIMStore.setState({
      conversations: [buildConversation()],
      messages: { 'conv-1': [{
        id: 1000,
        conversation_id: 'conv-1',
        sender_id: 'user-1',
        content: '当前消息',
        message_type: 1,
        created_at: '2026-06-25T00:00:00Z',
        is_deleted: false,
        metadata: {},
      }] } as never,
      hasMoreMessages: { 'conv-1': false },
    })

    useIMStore.getState().navigateToMessage('conv-1', target)

    await vi.waitFor(() => {
      expect(mockGetMessages).toHaveBeenCalledWith('conv-1', target)
    })
    expect(useIMStore.getState().messages['conv-1'].map((message) => message.id)).toEqual([500, 1000])
  })
})

describe('useIMStore.loadMessages', () => {
  it('首次历史请求返回旧数据时保留期间到达的实时编辑', async () => {
    const stale = {
      id: 100,
      seq: 100,
      conversation_id: 'conv-1',
      sender_id: 'user-2',
      content: 'before',
      message_type: 1,
      reply_to_id: null,
      has_attachment: false,
      metadata: {},
      created_at: '2026-08-07T11:24:00Z',
    }
    let resolveHistory!: (messages: typeof stale[]) => void
    mockGetMessages.mockImplementationOnce(() => new Promise((resolve) => {
      resolveHistory = resolve
    }))
    useIMStore.setState({
      conversations: [buildConversation()],
      currentConversationId: 'conv-1',
      isIMActive: true,
      messages: { 'conv-1': [stale] },
    } as never)

    const loading = useIMStore.getState().loadMessages('conv-1')
    useIMStore.getState().onRealtimeMessage('conv-1', {
      ...stale,
      content: 'after',
      edited_at: '2026-08-07T11:24:55Z',
    })
    resolveHistory([stale])
    await loading

    expect(useIMStore.getState().messages['conv-1'][0].content).toBe('after')
  })

  it('用历史中的最新消息校正过期的会话摘要', async () => {
    mockGetMessages.mockResolvedValueOnce([
      {
        id: 1,
        seq: 1,
        conversation_id: 'conv-1',
        sender_id: 'user-1',
        content: '12',
        message_type: 1,
        reply_to_id: null,
        has_attachment: false,
        metadata: {},
        created_at: '2026-08-06T02:30:09Z',
      },
      {
        id: 2,
        seq: 2,
        conversation_id: 'conv-1',
        sender_id: 'system',
        content: '矢哲宁将群名修改为设计讨论群',
        message_type: MESSAGE_TYPE_SYSTEM,
        reply_to_id: null,
        has_attachment: false,
        metadata: {},
        created_at: '2026-08-06T02:33:28Z',
      },
    ])
    useIMStore.setState({
      conversations: [buildConversation({
        type: CONVERSATION_TYPE_GROUP,
        last_message_at: '2026-08-06T02:30:09Z',
        last_message_preview: '12',
      })] as never,
    })

    await useIMStore.getState().loadMessages('conv-1')

    expect(useIMStore.getState().conversations[0]).toEqual(expect.objectContaining({
      last_message_at: '2026-08-06T02:33:28Z',
      last_message_preview: '矢哲宁将群名修改为设计讨论群',
    }))
  })

  it('刷新最新页时保留已展开的旧历史和原有 hasMore 状态', async () => {
    const cachedMessages = Array.from({ length: 30 }, (_, index) => ({
      id: index + 1,
      seq: index + 1,
      conversation_id: 'conv-1',
      sender_id: 'user-2',
      content: `cached-${index + 1}`,
      message_type: MESSAGE_TYPE_TEXT,
      reply_to_id: null,
      has_attachment: false,
      metadata: {},
      created_at: `2026-08-07T00:${String(index).padStart(2, '0')}:00Z`,
    }))
    const refreshedMessages = cachedMessages.slice(-20).map((message) => ({
      ...message,
      content: `refreshed-${message.id}`,
    }))
    mockGetMessages.mockResolvedValueOnce(refreshedMessages)
    useIMStore.setState({
      conversations: [buildConversation()],
      messages: { 'conv-1': cachedMessages },
      hasMoreMessages: { 'conv-1': false },
    } as never)

    await useIMStore.getState().loadMessages('conv-1')

    const messages = useIMStore.getState().messages['conv-1']
    expect(messages).toHaveLength(30)
    expect(messages.find((message) => message.id === 1)?.content).toBe('cached-1')
    expect(messages.find((message) => message.id === 30)?.content).toBe('refreshed-30')
    expect(useIMStore.getState().hasMoreMessages['conv-1']).toBe(false)
  })

  it('缓存刷新内容未变化时复用原消息数组和对象引用', async () => {
    const cachedMessages = [
      baseMessage({ id: 1, seq: 1, content: 'first' }),
      baseMessage({ id: 2, seq: 2, content: 'second' }),
    ]
    mockGetMessages.mockResolvedValueOnce(cachedMessages.map((message) => ({
      ...message,
      metadata: { ...message.metadata },
    })))
    useIMStore.setState({
      messages: { 'conv-1': cachedMessages },
      hasMoreMessages: { 'conv-1': false },
    } as never)

    const beforeRefresh = useIMStore.getState().messages['conv-1']
    await useIMStore.getState().loadMessages('conv-1')
    const afterRefresh = useIMStore.getState().messages['conv-1']

    expect(afterRefresh).toBe(beforeRefresh)
    expect(afterRefresh[0]).toBe(cachedMessages[0])
    expect(afterRefresh[1]).toBe(cachedMessages[1])
  })

  it('按会话隔离 loading，并忽略同一会话晚到的旧响应', async () => {
    const firstRequest = deferred<ReturnType<typeof baseMessage>[]>()
    const latestRequest = deferred<ReturnType<typeof baseMessage>[]>()
    const otherConversationRequest = deferred<ReturnType<typeof baseMessage>[]>()
    mockGetMessages
      .mockReturnValueOnce(firstRequest.promise)
      .mockReturnValueOnce(latestRequest.promise)
      .mockReturnValueOnce(otherConversationRequest.promise)

    useIMStore.setState({
      conversations: [buildConversation({ id: 'conv-1' }), buildConversation({ id: 'conv-2' })],
      messages: {},
    } as never)

    const first = useIMStore.getState().loadMessages('conv-1')
    const latest = useIMStore.getState().loadMessages('conv-1')
    const other = useIMStore.getState().loadMessages('conv-2')

    expect(useIMStore.getState().messageLoadingByConversation).toEqual({
      'conv-1': true,
      'conv-2': true,
    })

    latestRequest.resolve([baseMessage({ id: 2, content: 'latest' })])
    await latest
    expect(useIMStore.getState().messages['conv-1'].map((message) => message.content))
      .toEqual(['latest'])
    expect(useIMStore.getState().messageLoadingByConversation).toEqual({
      'conv-1': false,
      'conv-2': true,
    })

    firstRequest.resolve([baseMessage({ id: 1, content: 'stale' })])
    otherConversationRequest.resolve([baseMessage({ id: 3, conversation_id: 'conv-2' })])
    await Promise.all([first, other])

    expect(useIMStore.getState().messages['conv-1'].map((message) => message.content))
      .toEqual(['latest'])
    expect(useIMStore.getState().messageLoadingByConversation).toEqual({
      'conv-1': false,
      'conv-2': false,
    })
  })

  it('缓存刷新失败时保留旧消息并静默结束该会话的 loading', async () => {
    const cached = baseMessage({ id: 10, content: 'cached' })
    mockGetMessages.mockRejectedValueOnce(new Error('network'))
    useIMStore.setState({
      messages: { 'conv-1': [cached] },
      hasMoreMessages: { 'conv-1': false },
      loadError: null,
    } as never)

    await useIMStore.getState().loadMessages('conv-1')

    expect(useIMStore.getState().messages['conv-1']).toEqual([cached])
    expect(useIMStore.getState().messageLoadingByConversation['conv-1']).toBe(false)
    expect(useIMStore.getState().loadError).toBeNull()
  })
})

describe('useIMStore 消息撤回', () => {
  it('Django 撤回事件只有消息 ID 时仍能匹配带 UUID 引用的实时消息', () => {
    const existingMessage = {
      id: 18,
      seq: 6,
      conversation_id: 'conv-1',
      sender_id: 'user-1',
      content: '在线接收方应实时撤回',
      message_type: 1,
      reply_to_id: null,
      has_attachment: false,
      metadata: { message_ref: '01a01e08-b00c-7ddf-a95c-f7828a29c063' },
      created_at: '2026-08-20T07:18:00Z',
      is_deleted: false,
    }
    const deletedEventMessage = {
      id: 18,
      seq: 18,
      transport: { kind: 'group' as const, sequence: 18 },
      conversation_id: 'conv-1',
      sender_id: '',
      content: '',
      message_type: 1,
      reply_to_id: null,
      has_attachment: false,
      metadata: { message_ref: '18', tabtin_message_id: '18' },
      created_at: null,
      is_deleted: true,
    }
    expect(deletedEventMessage.metadata.message_ref).toBe('18')

    useIMStore.setState({
      conversations: [buildConversation({ id: 'conv-1' })],
      messages: { 'conv-1': [existingMessage] },
    } as never)

    useIMStore.getState().onMessageDeleted('conv-1', deletedEventMessage)

    expect(useIMStore.getState().messages['conv-1'][0]).toEqual(expect.objectContaining({
      id: 18,
      is_deleted: true,
      content: '',
    }))
  })

  it('C2C 相同序号的两条消息仍只按稳定引用撤回', () => {
    const first = {
      id: 7,
      seq: 7,
      conversation_id: 'conv-1',
      sender_id: 'user-1',
      content: '第一条',
      message_type: 1,
      reply_to_id: null,
      has_attachment: false,
      metadata: { message_ref: '11111111-1111-4111-8111-111111111111' },
      transport: { kind: 'c2c' as const, sequence: 7, sent_at: '2026-08-20T07:00:00Z' },
      created_at: '2026-08-20T07:00:00Z',
      is_deleted: false,
    }
    const second = {
      ...first,
      sender_id: 'user-2',
      content: '第二条',
      metadata: { message_ref: '22222222-2222-4222-8222-222222222222' },
      transport: { kind: 'c2c' as const, sequence: 7, sent_at: '2026-08-20T07:01:00Z' },
      created_at: '2026-08-20T07:01:00Z',
    }
    useIMStore.setState({
      conversations: [buildConversation({ id: 'conv-1' })],
      messages: { 'conv-1': [first, second] },
    } as never)

    useIMStore.getState().onMessageDeleted('conv-1', second)

    expect(useIMStore.getState().messages['conv-1'].map(message => message.is_deleted))
      .toEqual([false, true])
  })

  it('编辑原消息时同步刷新已加载回复的引用摘要', () => {
    const parent = {
      id: 100,
      conversation_id: 'conv-1',
      sender_id: 'user-1',
      content: '旧文案',
      message_type: 1,
      reply_to_id: null,
      has_attachment: false,
      metadata: {},
      created_at: '2026-07-29T00:00:00Z',
    }
    useIMStore.setState({
      messages: {
        'conv-1': [
          parent,
          {
            ...parent,
            id: 101,
            sender_id: 'user-2',
            content: '回复原消息',
            reply_to_id: 100,
            reply_to_preview: { sender_id: 'user-1', content: '旧文案' },
          },
        ],
      } as never,
    })

    useIMStore.getState().onMessageEdited('conv-1', {
      ...parent,
      content: '新文案',
      edited_at: '2026-07-29T00:05:00Z',
    })

    expect(useIMStore.getState().messages['conv-1'][1].reply_to_preview?.content)
      .toBe('新文案')
  })

  it('C2C 双方序号相同时编辑旧消息不覆盖最新摘要', () => {
    const older = {
      id: 7,
      conversation_id: 'conv-1',
      sender_id: 'user-1',
      content: '旧消息',
      message_type: 1,
      reply_to_id: null,
      has_attachment: false,
      metadata: { message_ref: '11111111-1111-4111-8111-111111111111' },
      transport: { kind: 'c2c' as const, sequence: 7, sent_at: '2026-08-17T08:00:00Z' },
      created_at: '2026-08-17T08:00:00Z',
    }
    const latest = {
      ...older,
      sender_id: 'user-2',
      content: '最新消息',
      metadata: { message_ref: '22222222-2222-4222-8222-222222222222' },
      transport: { kind: 'c2c' as const, sequence: 7, sent_at: '2026-08-17T08:01:00Z' },
      created_at: '2026-08-17T08:01:00Z',
    }
    useIMStore.setState({
      conversations: [buildConversation({ last_message_preview: '最新消息' })] as never,
      messages: { 'conv-1': [older, latest] } as never,
    })

    useIMStore.getState().onMessageEdited('conv-1', {
      ...older,
      content: '旧消息已编辑',
      edited_at: '2026-08-17T08:02:00Z',
    })

    expect(useIMStore.getState().conversations[0].last_message_preview)
      .toBe('最新消息')
  })

  it('重拉历史后仍保留本人撤回消息的重新编辑草稿', async () => {
    const recalledMessage = {
      id: 100,
      conversation_id: 'conv-1',
      sender_id: 'user-1',
      content: '',
      message_type: 1,
      reply_to_id: null,
      has_attachment: false,
      metadata: {},
      created_at: '2026-07-29T00:00:00Z',
      is_deleted: true,
    }
    mockGetMessages.mockResolvedValueOnce([recalledMessage])
    useIMStore.setState({
      messages: {
        'conv-1': [{ ...recalledMessage, _recalledContent: '继续编辑这段文字' }],
      },
    } as never)

    await useIMStore.getState().loadMessages('conv-1')

    expect(useIMStore.getState().messages['conv-1'][0]).toEqual(expect.objectContaining({
      is_deleted: true,
      _recalledContent: '继续编辑这段文字',
    }))
  })

  it('撤回原消息时立即将已加载回复的引用摘要标为不可用', () => {
    useIMStore.setState({
      messages: {
        'conv-1': [
          {
            id: 100,
            conversation_id: 'conv-1',
            sender_id: 'user-1',
            content: '将被撤回的原消息',
            message_type: 1,
            reply_to_id: null,
            has_attachment: false,
            metadata: {},
            created_at: '2026-07-29T00:00:00Z',
          },
          {
            id: 101,
            conversation_id: 'conv-1',
            sender_id: 'user-2',
            content: '回复原消息',
            message_type: 1,
            reply_to_id: 100,
            reply_to_preview: { sender_id: 'user-1', content: '将被撤回的原消息' },
            has_attachment: false,
            metadata: {},
            created_at: '2026-07-29T00:01:00Z',
          },
        ],
      } as never,
    })

    useIMStore.getState().onMessageDeleted(
      'conv-1',
      useIMStore.getState().messages['conv-1'][0],
    )

    expect(useIMStore.getState().messages['conv-1'][1].reply_to_preview?.content)
      .toBe('消息内容不可用')
  })

  it('腾讯撤回最新消息后将会话摘要回退到上一条可见消息', () => {
    const previousMessage = {
      id: 100,
      conversation_id: 'conv-1',
      sender_id: 'user-2',
      content: '上一条可见消息',
      message_type: 1,
      reply_to_id: null,
      has_attachment: false,
      metadata: {},
      created_at: '2026-07-29T00:00:00Z',
    }
    const recalledMessage = {
      ...previousMessage,
      id: 101,
      sender_id: 'user-1',
      content: '即将撤回的消息',
      created_at: '2026-07-29T00:01:00Z',
    }
    useIMStore.setState({
      conversations: [buildConversation({
        last_message_at: recalledMessage.created_at,
        last_message_preview: 'Alice: 即将撤回的消息',
      })],
      messages: { 'conv-1': [previousMessage, recalledMessage] },
    } as never)

    useIMStore.getState().onRealtimeMessage('conv-1', {
      ...recalledMessage,
      content: '',
      is_deleted: true,
    })

    expect(useIMStore.getState().conversations[0]).toEqual(expect.objectContaining({
      last_message_at: previousMessage.created_at,
      last_message_preview: '上一条可见消息',
    }))
  })

  it('陈旧会话更新不会恢复已撤回的最新摘要', () => {
    const previousMessage = {
      id: 100,
      conversation_id: 'conv-1',
      sender_id: 'user-2',
      content: '上一条可见消息',
      message_type: 1,
      reply_to_id: null,
      has_attachment: false,
      metadata: {},
      created_at: '2026-07-29T00:00:00Z',
    }
    const recalledMessage = {
      ...previousMessage,
      id: 101,
      sender_id: 'user-1',
      content: '已撤回的消息',
      created_at: '2026-07-29T00:01:00Z',
    }
    useIMStore.setState({
      conversations: [buildConversation({
        last_message_at: recalledMessage.created_at,
        last_message_preview: 'Alice: 已撤回的消息',
      })],
      messages: { 'conv-1': [previousMessage, recalledMessage] },
    } as never)

    useIMStore.getState().onRealtimeMessage('conv-1', {
      ...recalledMessage,
      content: '',
      is_deleted: true,
    })
    useIMStore.getState().updateConversation('conv-1', {
      last_message_at: recalledMessage.created_at,
      last_message_preview: 'Alice: 已撤回的消息',
    })

    expect(useIMStore.getState().conversations[0]).toEqual(expect.objectContaining({
      last_message_at: previousMessage.created_at,
      last_message_preview: '上一条可见消息',
    }))
  })
})

describe('useIMStore 群聊实时已读回执', () => {
  it('用最新群名系统消息替换会话列表中的普通消息摘要', () => {
    useIMStore.setState({
      conversations: [buildConversation({
        type: CONVERSATION_TYPE_GROUP,
        last_message_preview: '12',
      })] as never,
      messages: {
        'conv-1': [{
          id: 1,
          seq: 1,
          conversation_id: 'conv-1',
          sender_id: 'user-1',
          content: '12',
          message_type: 1,
          reply_to_id: null,
          has_attachment: false,
          metadata: {},
          created_at: '2026-08-06T02:30:09Z',
        }],
      },
    })

    useIMStore.getState().onRealtimeMessage('conv-1', {
      id: 2,
      seq: 2,
      conversation_id: 'conv-1',
      sender_id: 'system',
      content: '矢哲宁将群名修改为设计讨论群',
      message_type: MESSAGE_TYPE_SYSTEM,
      reply_to_id: null,
      has_attachment: false,
      metadata: {},
      created_at: '2026-08-06T02:33:28Z',
    }, { incrementUnread: false })

    // 腾讯的群资料事件和群提示消息没有固定先后顺序。资料事件可能仍携带
    // 改名前的最后一条普通消息，不能把刚收到的系统提示摘要覆盖回去。
    useIMStore.getState().updateConversation('conv-1', {
      name: '设计讨论群',
      last_message_at: '2026-08-06T02:30:09Z',
      last_message_preview: '12',
    })

    expect(useIMStore.getState().conversations[0].last_message_preview).toBe(
      '矢哲宁将群名修改为设计讨论群',
    )
    expect(useIMStore.getState().conversations[0].name).toBe('设计讨论群')
  })

  it('腾讯尚未返回权威回执时不推测群消息的收件人数', () => {
    useIMStore.setState({
      conversations: [buildConversation({ type: 2, member_count: 3 })] as never,
      messages: { 'conv-1': [] },
    })

    useIMStore.getState().onRealtimeMessage('conv-1', {
      id: 101,
      seq: 5,
      conversation_id: 'conv-1',
      sender_id: 'user-1',
      sender_type: 'user',
      content: '等待腾讯回执',
      message_type: 1,
      reply_to_id: null,
      has_attachment: false,
      metadata: {},
      created_at: '2026-07-14T05:20:00Z',
    }, { incrementUnread: false })

    expect(useIMStore.getState().messages['conv-1'][0].read_receipt).toBeUndefined()
  })

  it('成员实时阅读后立即推进发送者群消息的已读人数', () => {
    useIMStore.setState({
      conversations: [buildConversation({ type: 2 })] as never,
      messages: {
        'conv-1': [
          {
            id: 101,
            seq: 5,
            conversation_id: 'conv-1',
            sender_id: 'user-1',
            sender_type: 'user',
            content: '请查收',
            message_type: 1,
            created_at: '2026-07-14T05:20:00Z',
            is_deleted: false,
            metadata: {},
            read_receipt: { read_count: 0, recipient_count: 2 },
          },
        ],
      } as never,
    })

    useIMStore.getState().onReadReceipt('conv-1', 'user-2', 101, 5, 0)

    expect(useIMStore.getState().messages['conv-1'][0].read_receipt).toEqual({
      read_count: 1,
      recipient_count: 2,
    })
  })

  it('发送者自己的已读回执不会计入收件人进度', () => {
    useIMStore.setState({
      conversations: [buildConversation({ type: 2 })] as never,
      messages: {
        'conv-1': [{
          id: 101,
          seq: 5,
          conversation_id: 'conv-1',
          sender_id: 'user-1',
          content: '我的消息',
          message_type: 1,
          created_at: '2026-07-14T05:20:00Z',
          is_deleted: false,
          metadata: {},
          read_receipt: { read_count: 0, recipient_count: 2 },
        }],
      } as never,
    })

    useIMStore.getState().onReadReceipt('conv-1', 'user-1', 101, 5, 0)

    expect(useIMStore.getState().messages['conv-1'][0].read_receipt?.read_count).toBe(0)
  })

  it('只累加实时水位新增区间，保留历史载荷已有的已读人数', () => {
    useIMStore.setState({
      conversations: [buildConversation({ type: 2 })] as never,
      messages: {
        'conv-1': [
          {
            id: 101,
            seq: 5,
            conversation_id: 'conv-1',
            sender_id: 'user-1',
            content: '历史消息',
            message_type: 1,
            created_at: '2026-07-14T05:20:00Z',
            is_deleted: false,
            metadata: {},
            read_receipt: { read_count: 1, recipient_count: 2 },
          },
          {
            id: 102,
            seq: 6,
            conversation_id: 'conv-1',
            sender_id: 'user-1',
            content: '新增消息',
            message_type: 1,
            created_at: '2026-07-14T05:21:00Z',
            is_deleted: false,
            metadata: {},
            read_receipt: { read_count: 0, recipient_count: 2 },
          },
        ],
      } as never,
    })

    useIMStore.getState().onReadReceipt('conv-1', 'user-2', 102, 6, 5)

    expect(useIMStore.getState().messages['conv-1'].map((message) => message.read_receipt?.read_count)).toEqual([1, 1])
  })

  // 刚发出的群消息走乐观确认 / provider echo，本地通常没有 read_receipt；
  // 若实时回执因此被跳过，发送方会一直看到空心环，只有重进会话拉历史才对。
  it('刚发出的群消息缺少 read_receipt 时，实时回执仍应补齐已读进度', () => {
    useIMStore.setState({
      conversations: [buildConversation({ type: 2, member_count: 2 })] as never,
      messages: {
        'conv-1': [
          {
            id: 101,
            seq: 5,
            conversation_id: 'conv-1',
            sender_id: 'user-1',
            sender_type: 'user',
            content: '刚发出',
            message_type: 1,
            created_at: '2026-07-14T05:20:00Z',
            is_deleted: false,
            metadata: {},
          },
        ],
      } as never,
    })

    useIMStore.getState().onReadReceipt('conv-1', 'user-2', 101, 5, 0)

    expect(useIMStore.getState().messages['conv-1'][0].read_receipt).toEqual({
      read_count: 1,
      recipient_count: 1,
    })
  })

  // 私聊气泡只看 message.read_receipt.read_count；对方打开对话框后的
  // im.read.receipt 若只写 store.readReceipts，发送方会一直看到空心圆。
  it('刚发出的私聊消息缺少 read_receipt 时，对方打开后实时回执应标为已读', () => {
    useIMStore.setState({
      conversations: [buildConversation({ type: CONVERSATION_TYPE_DM, member_count: 2 })] as never,
      messages: {
        'conv-1': [
          {
            id: 101,
            seq: 5,
            conversation_id: 'conv-1',
            sender_id: 'user-1',
            sender_type: 'user',
            content: '你好',
            message_type: 1,
            created_at: '2026-08-19T03:43:00Z',
            is_deleted: false,
            metadata: {},
          },
        ],
      } as never,
    })

    useIMStore.getState().onReadReceipt('conv-1', 'user-2', 101, 5, 0)

    expect(useIMStore.getState().messages['conv-1'][0].read_receipt).toEqual({
      read_count: 1,
      recipient_count: 1,
    })
  })
})

describe('useIMStore.createConversationAndActivate', () => {
  it('创建 DM 后优先拉取详情写回 store，并激活会话选择', async () => {
    mockCreateDM.mockResolvedValue({ conversation_id: 'conv-1' })
    mockGetConversation.mockResolvedValue(buildConversation())

    const result = await useIMStore.getState().createConversationAndActivate({
      organizationId: 'ws-1',
      kind: 'dm',
      memberIds: ['user-2'],
    })

    expect(result).toBe('conv-1')
    expect(mockCreateDM).toHaveBeenCalledWith('ws-1', 'user-2')
    expect(mockGetConversation).toHaveBeenCalledWith('conv-1')
    expect(mockListConversations).not.toHaveBeenCalled()
    expect(useIMStore.getState().conversations).toEqual([
      expect.objectContaining({
        id: 'conv-1',
        name: '新会话',
      }),
    ])
    expect(mockActivateConversation).toHaveBeenCalledWith('conv-1', 'dm')
  })

  it('从通讯录打开已有 DM 时，目录详情缺少热消息字段也不改变会话位置', async () => {
    const existingConversation = buildConversation({
      id: 'conv-existing',
      name: 'Bob',
      last_message_at: '2026-08-04T11:38:00Z',
      last_message_preview: '最新消息',
      created_at: '2026-07-01T00:00:00Z',
    })
    const olderConversation = buildConversation({
      id: 'conv-older',
      dm_peer_user_id: 'user-3',
      last_message_at: '2026-08-04T11:37:00Z',
      last_message_preview: '较早消息',
      created_at: '2026-07-02T00:00:00Z',
    })
    useIMStore.setState({
      conversations: [existingConversation, olderConversation] as never,
    })
    mockCreateDM.mockResolvedValue({ conversation_id: 'conv-existing' })
    mockGetConversation.mockResolvedValue(buildConversation({
      id: 'conv-existing',
      name: 'Bob',
      last_message_at: null,
      last_message_preview: '',
      created_at: '2026-07-01T00:00:00Z',
    }))

    await useIMStore.getState().createConversationAndActivate({
      organizationId: 'ws-1',
      kind: 'dm',
      memberIds: ['user-2'],
    })

    expect(useIMStore.getState().conversations.map((conversation) => conversation.id)).toEqual([
      'conv-existing',
      'conv-older',
    ])
    expect(useIMStore.getState().conversations[0]).toEqual(expect.objectContaining({
      last_message_at: '2026-08-04T11:38:00Z',
      last_message_preview: '最新消息',
    }))
  })

  it('详情拉取失败时会回退全量 reload，再激活群聊会话', async () => {
    mockCreateGroup.mockResolvedValue({ conversation_id: 'conv-group-1' })
    mockGetConversation.mockRejectedValue(new Error('detail failed'))
    mockListConversations.mockResolvedValue([
      buildConversation({
        id: 'conv-group-1',
        space_id: 'space-conv-group-1',
        type: CONVERSATION_TYPE_GROUP,
        name: '讨论组',
        member_count: 3,
        dm_peer_user_id: null,
      }),
    ])

    const result = await useIMStore.getState().createConversationAndActivate({
      organizationId: 'ws-1',
      kind: 'group',
      memberIds: ['user-2', 'user-3'],
      groupName: '讨论组',
    })

    expect(result).toBe('conv-group-1')
    expect(mockCreateGroup).toHaveBeenCalledWith(
      'ws-1',
      '讨论组',
      ['user-2', 'user-3'],
      '',
      undefined,
      [],
    )
    expect(mockListConversations).toHaveBeenCalledWith('ws-1')
    expect(useIMStore.getState().conversations).toEqual([
      expect.objectContaining({
        id: 'conv-group-1',
        name: '讨论组',
      }),
    ])
    expect(mockActivateConversation).toHaveBeenCalledWith(
      'conv-group-1',
      'im-group',
    )
  })

  it('未显式填写群名时统一使用所选成员姓名', async () => {
    mockOrganizationMembers.value = [
      { user_id: 'user-2', user: { nickname: '吴九', username: 'dave' } },
      { user_id: 'user-3', user: { nickname: '郑十', username: 'gaoyuanze' } },
    ]
    mockCreateGroup.mockResolvedValue({ conversation_id: 'conv-group-default-name' })
    mockGetConversation.mockResolvedValue(buildConversation({
      id: 'conv-group-default-name',
      type: CONVERSATION_TYPE_GROUP,
      name: '吴九、郑十',
      dm_peer_user_id: null,
    }))

    await useIMStore.getState().createConversationAndActivate({
      organizationId: 'ws-1',
      kind: 'group',
      memberIds: ['user-2', 'user-3'],
    })

    expect(mockCreateGroup).toHaveBeenCalledWith(
      'ws-1',
      '吴九、郑十',
      ['user-2', 'user-3'],
      '',
      undefined,
      [],
    )
  })

  it('未显式填写群名时统一包含外部联系人姓名', async () => {
    mockOrganizationMembers.value = [
      { user_id: 'user-2', user: { nickname: '吴九' } },
    ]
    mockListExternalContacts.mockResolvedValue({
      items: [
        { contact_id: 'contact-1', display_name: '外部联系人甲' },
        { contact_id: 'contact-2', display_name: '外部联系人乙' },
      ],
    })
    mockCreateGroup.mockResolvedValue({ conversation_id: 'conv-external-group-default-name' })
    mockGetConversation.mockResolvedValue(buildConversation({
      id: 'conv-external-group-default-name',
      type: CONVERSATION_TYPE_GROUP,
      name: '吴九、外部联系人甲、外部联系人乙',
      dm_peer_user_id: null,
    }))

    await useIMStore.getState().createConversationAndActivate({
      organizationId: 'ws-1',
      kind: 'group',
      memberIds: ['user-2'],
      externalContactIds: ['contact-1', 'contact-2'],
    })

    expect(mockCreateGroup).toHaveBeenCalledWith(
      'ws-1',
      '吴九、外部联系人甲、外部联系人乙',
      ['user-2'],
      '',
      undefined,
      ['contact-1', 'contact-2'],
    )
  })

  it('创建 Project 会话时可留在团队协作面板内，不触发全局 IM 导航', async () => {
    mockCreateGroup.mockResolvedValue({ conversation_id: 'conv-team-1' })
    mockGetConversation.mockResolvedValue(buildConversation({
      id: 'conv-team-1',
      type: 2,
      name: '团队对话',
      space_id: 'team-space-1',
      dm_peer_user_id: null,
    }))

    const result = await useIMStore.getState().createConversationAndActivate({
      organizationId: 'ws-1',
      kind: 'group',
      memberIds: [],
      groupName: '团队对话',
      spaceId: 'team-space-1',
      activate: false,
    })

    expect(result).toBe('conv-team-1')
    expect(mockCreateGroup).toHaveBeenCalledWith(
      'ws-1',
      '团队对话',
      [],
      '',
      'team-space-1',
      [],
    )
    expect(useIMStore.getState().conversations).toEqual([
      expect.objectContaining({
        id: 'conv-team-1',
        space_id: 'team-space-1',
      }),
    ])
    expect(mockActivateConversation).not.toHaveBeenCalled()
  })

  it('普通群聊可由创建者单独创建', async () => {
    mockCreateGroup.mockResolvedValue({ conversation_id: 'conv-solo-group' })
    mockGetConversation.mockResolvedValue(buildConversation({
      id: 'conv-solo-group',
      type: CONVERSATION_TYPE_GROUP,
      name: '个人群组',
      member_count: 1,
      dm_peer_user_id: null,
    }))

    await expect(useIMStore.getState().createConversationAndActivate({
      organizationId: 'ws-1',
      kind: 'group',
      memberIds: [],
      groupName: '个人群组',
    })).resolves.toBe('conv-solo-group')

    expect(mockCreateGroup).toHaveBeenCalledWith(
      'ws-1',
      '个人群组',
      [],
      '',
      undefined,
      [],
    )
    expect(mockActivateConversation).toHaveBeenCalledWith('conv-solo-group', 'im-group')
  })

  it('普通群聊再选一名成员即可创建', async () => {
    mockCreateGroup.mockResolvedValue({ conversation_id: 'conv-two-person' })
    mockGetConversation.mockResolvedValue(buildConversation({
      id: 'conv-two-person',
      type: CONVERSATION_TYPE_GROUP,
      name: '两人群',
      dm_peer_user_id: null,
    }))

    await expect(useIMStore.getState().createConversationAndActivate({
      organizationId: 'ws-1',
      kind: 'group',
      memberIds: ['user-2'],
      groupName: '两人群',
    })).resolves.toBe('conv-two-person')

    expect(mockCreateGroup).toHaveBeenCalledWith(
      'ws-1',
      '两人群',
      ['user-2'],
      '',
      undefined,
      [],
    )
  })

  it('创建群聊后失效组织权益用量缓存，DM 不触发', async () => {
    mockCreateGroup.mockResolvedValue({ conversation_id: 'conv-group-quota' })
    mockGetConversation.mockResolvedValue(
      buildConversation({
        id: 'conv-group-quota',
        type: CONVERSATION_TYPE_GROUP,
        name: '配额群',
        dm_peer_user_id: null,
      }),
    )

    await useIMStore.getState().createConversationAndActivate({
      organizationId: 'ws-1',
      kind: 'group',
      memberIds: ['user-2', 'user-3'],
      groupName: '配额群',
    })
    expect(mockInvalidateMembershipQuotaUsage).toHaveBeenCalledWith(expect.anything(), 'ws-1')

    mockInvalidateMembershipQuotaUsage.mockClear()
    mockCreateDM.mockResolvedValue({ conversation_id: 'conv-dm-quota' })
    mockGetConversation.mockResolvedValue(buildConversation({ id: 'conv-dm-quota', type: 1 }))
    await useIMStore.getState().createConversationAndActivate({
      organizationId: 'ws-1',
      kind: 'dm',
      memberIds: ['user-2'],
    })
    expect(mockInvalidateMembershipQuotaUsage).not.toHaveBeenCalled()
  })
})

describe('useIMStore.onNewConversation', () => {
  it('外部群实时事件按当前成员目录作用域水合，并清理同 ID 错误归属记录', async () => {
    mockGetConversation.mockResolvedValue(buildConversation({
      id: 'external-conversation',
      organization_id: 'participant-organization',
      is_external: true,
      type: CONVERSATION_TYPE_GROUP,
    }))
    useIMStore.setState({
      conversations: [buildConversation({
        id: 'external-conversation',
        organization_id: 'host-organization',
        is_external: true,
        type: CONVERSATION_TYPE_GROUP,
      })],
    })

    useIMStore.getState().onNewConversation({
      ...buildConversation({
        id: 'external-conversation',
        organization_id: 'host-organization',
        is_external: true,
        type: CONVERSATION_TYPE_GROUP,
      }),
    })

    await vi.waitFor(() => {
      expect(useIMStore.getState().conversations).toEqual([
        expect.objectContaining({
          id: 'external-conversation',
          organization_id: 'participant-organization',
        }),
      ])
    })
    expect(mockGetConversation).toHaveBeenCalledWith('external-conversation')
    expect(mockInvalidateMembershipQuotaUsage).toHaveBeenCalledWith(
      expect.anything(),
      'host-organization',
    )
  })

  it('保留私聊的只读成员状态', () => {
    useIMStore.getState().onNewConversation({
      ...buildConversation({
        id: 'dm-removed',
        member_count: 1,
        can_send: false,
        dm_peer_membership_status: 'removed',
      }),
    })

    expect(useIMStore.getState().conversations[0]).toEqual(expect.objectContaining({
      can_send: false,
      dm_peer_membership_status: 'removed',
    }))
  })

  it('保留私聊对端的组织身份', () => {
    useIMStore.getState().onNewConversation({
      ...buildConversation({
        id: 'dm-scoped-peer',
        dm_peer_user_id: 'peer-user',
        dm_peer_organization_id: 'peer-org',
      }),
    })

    expect(useIMStore.getState().conversations[0]).toEqual(expect.objectContaining({
      dm_peer_user_id: 'peer-user',
      dm_peer_organization_id: 'peer-org',
    }))
  })

  it('保留 Project 频道元信息，避免项目内打开频道时上下文降级', () => {
    useIMStore.getState().onNewConversation({
      id: 'conv-team-channel',
      organization_id: 'ws-1',
      space_id: 'team-space-1',
      space_name: '发布准备',
      is_team_space_channel: true,
      is_archived: false,
      type: 2,
      name: '#general',
      member_count: 3,
      last_message_preview: '准备开始发布讨论',
      unread_count: 1,
      created_at: '2026-07-04T00:00:00Z',
    })

    expect(useIMStore.getState().conversations).toEqual([
      expect.objectContaining({
        id: 'conv-team-channel',
        space_id: 'team-space-1',
        space_name: '发布准备',
        is_team_space_channel: true,
        is_archived: false,
      }),
    ])
  })
})

describe('useIMStore.loadConversations', () => {
  it('被其他设备踢下线后不再请求会话列表', async () => {
    useIMStore.setState({
      conversations: [buildConversation()] as never,
      loadError: null,
    })
    useIMStore.getState().setConnectionStatus('disconnected', 'kicked_out')

    await useIMStore.getState().loadConversations('ws-1')

    expect(mockListConversations).not.toHaveBeenCalled()
    expect(useIMStore.getState().conversations).toHaveLength(1)
    expect(useIMStore.getState().loadError).toBeNull()

    useIMStore.getState().setConnectionStatus('connected')
    mockListConversations.mockResolvedValue([])
    await useIMStore.getState().loadConversations('ws-1')
    expect(mockListConversations).toHaveBeenCalledOnce()
  })

  it('被踢前已发出的会话请求失败时不产生加载错误', async () => {
    let rejectList: ((error: Error) => void) | undefined
    mockListConversations.mockImplementation(() => new Promise((_, reject) => {
      rejectList = reject
    }))

    const load = useIMStore.getState().loadConversations('ws-1')
    useIMStore.getState().setConnectionStatus('disconnected', 'kicked_out')
    rejectList?.(new Error('manual reconnect is required'))
    await load

    expect(useIMStore.getState().isLoadingConversations).toBe(false)
    expect(useIMStore.getState().loadError).toBeNull()
  })

  it('#8756: 不把旧 organization 的标签筛选带入新 organization 请求', async () => {
    mockListConversations.mockResolvedValue([])
    useIMStore.setState({
      activeLabelFilters: ['label-from-ws-1'],
      activeLabelFiltersOrganizationId: 'ws-1',
    })

    await useIMStore.getState().loadConversations('ws-2')

    expect(mockListConversations).toHaveBeenCalledWith('ws-2')
  })

  it('清空后全量列表返回空 last_message_at 时仍保持会话排序位置 ', async () => {
    const active = buildConversation({
      id: 'conv-active',
      name: 'Bob',
      last_message_at: '2026-08-05T10:00:00Z',
      last_message_preview: '',
      created_at: '2026-01-01T00:00:00Z',
    })
    const older = buildConversation({
      id: 'conv-older',
      dm_peer_user_id: 'user-3',
      name: 'Carol',
      last_message_at: '2026-08-05T09:00:00Z',
      last_message_preview: '较早',
      created_at: '2026-02-01T00:00:00Z',
    })
    useIMStore.setState({
      conversations: [active, older] as never,
    })
    mockListConversations.mockResolvedValue([
      buildConversation({
        id: 'conv-active',
        name: 'Bob',
        last_message_at: null,
        last_message_preview: '',
        created_at: '2026-01-01T00:00:00Z',
      }),
      buildConversation({
        id: 'conv-older',
        dm_peer_user_id: 'user-3',
        name: 'Carol',
        last_message_at: '2026-08-05T09:00:00Z',
        last_message_preview: '较早',
        created_at: '2026-02-01T00:00:00Z',
      }),
    ])

    await useIMStore.getState().loadConversations('ws-1')

    expect(useIMStore.getState().conversations.map((c) => c.id)).toEqual([
      'conv-active',
      'conv-older',
    ])
    expect(useIMStore.getState().conversations[0]).toEqual(expect.objectContaining({
      id: 'conv-active',
      last_message_at: '2026-08-05T10:00:00Z',
      last_message_preview: '',
    }))
  })

  it('多 organization 并发补拉时不会把先启动后返回的请求判为 stale', async () => {
    type BuiltConversation = ReturnType<typeof buildConversation>
    let resolveWs1: ((value: BuiltConversation[]) => void) | null = null
    let resolveWs2: ((value: BuiltConversation[]) => void) | null = null
    mockListConversations.mockImplementation((organizationId: string) => (
      new Promise<BuiltConversation[]>((resolve) => {
        if (organizationId === 'ws-1') {
          resolveWs1 = resolve
          return
        }
        if (organizationId === 'ws-2') {
          resolveWs2 = resolve
          return
        }
        resolve([])
      })
    ))

    const ws1Load = useIMStore.getState().loadConversations('ws-1')
    const ws2Load = useIMStore.getState().loadConversations('ws-2')

    resolveWs2?.([
      buildConversation({ id: 'conv-ws-2', organization_id: 'ws-2' }),
    ])
    await Promise.resolve()
    resolveWs1?.([
      buildConversation({ id: 'conv-ws-1', organization_id: 'ws-1' }),
    ])
    await Promise.all([ws1Load, ws2Load])

    expect(useIMStore.getState().conversations).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'conv-ws-1', organization_id: 'ws-1' }),
      expect.objectContaining({ id: 'conv-ws-2', organization_id: 'ws-2' }),
    ]))
  })

  it('补拉到 orphan 会话且 unread_count 为 0 时会清理旧孤儿未读数', async () => {
    mockListConversations.mockResolvedValue([
      buildConversation({
        id: 'conv-orphan',
        organization_id: 'ws-1',
        unread_count: 0,
      }),
    ])
    useIMStore.setState({
      conversations: [],
      unreadCounts: { 'conv-orphan': 3, 'conv-other': 4 },
      totalUnread: 7,
    })

    await useIMStore.getState().loadConversations('ws-1')

    expect(useIMStore.getState().conversations).toEqual([
      expect.objectContaining({ id: 'conv-orphan' }),
    ])
    expect(useIMStore.getState().unreadCounts).toEqual({ 'conv-other': 4 })
    expect(useIMStore.getState().totalUnread).toBe(4)
  })

  it('会话刷新时优先使用同一引用已水合的本地消息预览', async () => {
    const lastMessageAt = '2026-08-04T03:00:00Z'
    const messageRef = '019f0000-0000-7000-8000-000000000042'
    mockListConversations.mockResolvedValue([
      buildConversation({
        last_message_at: lastMessageAt,
        last_message_preview: '[自定义消息]',
        last_message_reference: {
          message_ref: messageRef,
          tabtin_message_id: '42',
        },
      }),
    ])
    useIMStore.setState({
      messages: {
        'conv-1': [{
          id: 42,
          conversation_id: 'conv-1',
          sender_id: 'agent-1',
          content: '本地 Agent 最终回复',
          message_type: 1,
          reply_to_id: null,
          has_attachment: false,
          metadata: {
            kind: 'tabtin_ref',
            message_ref: messageRef,
            tabtin_message_id: '42',
          },
          created_at: '2026-08-04T02:59:59Z',
        }],
      } as never,
    })

    await useIMStore.getState().loadConversations('ws-1')

    expect(useIMStore.getState().conversations[0].last_message_preview).toBe(
      '本地 Agent 最终回复',
    )
  })

  it('切回 TabChat 全量刷新时不恢复已撤回的最新摘要', async () => {
    const previousMessage = {
      id: 100,
      conversation_id: 'conv-1',
      sender_id: 'user-2',
      content: '上一条可见消息',
      message_type: 1,
      reply_to_id: null,
      has_attachment: false,
      metadata: {},
      created_at: '2026-07-29T00:00:00Z',
    }
    const recalledMessage = {
      ...previousMessage,
      id: 101,
      sender_id: 'user-1',
      content: '已撤回的消息',
      created_at: '2026-07-29T00:01:00Z',
    }
    useIMStore.setState({
      conversations: [buildConversation({
        last_message_at: recalledMessage.created_at,
        last_message_preview: 'Alice: 已撤回的消息',
      })],
      messages: { 'conv-1': [previousMessage, recalledMessage] },
    } as never)
    useIMStore.getState().onRealtimeMessage('conv-1', {
      ...recalledMessage,
      content: '',
      is_deleted: true,
    })
    mockListConversations.mockResolvedValueOnce([buildConversation({
      last_message_at: recalledMessage.created_at,
      last_message_preview: 'Alice: 已撤回的消息',
    })])

    await useIMStore.getState().loadConversations('ws-1')

    expect(useIMStore.getState().conversations[0]).toEqual(expect.objectContaining({
      last_message_at: previousMessage.created_at,
      last_message_preview: '上一条可见消息',
    }))
  })

  it('普通消息不会仅凭时间从本地缓存猜测会话摘要', async () => {
    const lastMessageAt = '2026-08-04T03:01:00Z'
    mockListConversations.mockResolvedValue([
      buildConversation({
        last_message_at: lastMessageAt,
        last_message_preview: '更新的远端消息',
      }),
    ])
    useIMStore.setState({
      messages: {
        'conv-1': [{
          id: 41,
          conversation_id: 'conv-1',
          sender_id: 'agent-1',
          content: '旧的本地消息',
          message_type: 1,
          reply_to_id: null,
          has_attachment: false,
          metadata: {},
          created_at: lastMessageAt,
        }],
      } as never,
    })

    await useIMStore.getState().loadConversations('ws-1')

    expect(useIMStore.getState().conversations[0].last_message_preview).toBe(
      '更新的远端消息',
    )
  })
})

describe('useIMStore.loadPinnedMessages', () => {
  it('does not let an older load restore a message unpinned while it was pending', async () => {
    const pinnedMessage = {
      id: 42,
      conversation_id: 'conv-1',
      sender_id: 'user-2',
      content: '需要置顶的消息',
      message_type: 1,
      reply_to_id: null,
      has_attachment: false,
      metadata: {},
      created_at: '2026-08-10T00:00:00Z',
      is_pinned: true,
    }
    let resolveLoad!: (messages: typeof pinnedMessage[]) => void
    mockGetPinnedMessages.mockImplementationOnce(() => new Promise((resolve) => {
      resolveLoad = resolve
    }))
    useIMStore.setState({
      messages: { 'conv-1': [pinnedMessage] },
      pinnedMessages: { 'conv-1': [pinnedMessage] },
    } as never)

    const loading = useIMStore.getState().loadPinnedMessages('conv-1')
    useIMStore.getState().onMessageUnpinned('conv-1', 42)
    resolveLoad([pinnedMessage])
    await loading

    expect(useIMStore.getState().pinnedMessages['conv-1']).toEqual([])
    expect(useIMStore.getState().messages['conv-1'][0].is_pinned).toBe(false)
  })
})

describe('useIMStore conversation member snapshot', () => {
  it('成员重新加入组织后在原私聊发送时自动恢复会话', async () => {
    const currentMember = {
      member_type: 'user' as const,
      user_id: 'user-1',
      agent_id: null,
      nickname: 'Alice',
      username: 'alice',
      avatar: '',
      role: 1,
      is_muted: false,
      pinned: false,
      joined_at: null,
    }
    const rejoinedMember = {
      ...currentMember,
      user_id: 'user-2',
      nickname: 'Bob',
      username: 'bob',
    }
    mockCreateDM.mockResolvedValue({ conversation_id: 'conv-1' })
    mockGetConversation.mockImplementation(async () => {
      const restored = mockCreateDM.mock.calls.length > 0
      return buildConversation({
        member_count: restored ? 2 : 1,
        members: restored ? [currentMember, rejoinedMember] : [currentMember],
      })
    })
    mockSendMessage.mockResolvedValue({
      id: 31,
      seq: 31,
      conversation_id: 'conv-1',
      created_at: '2026-08-10T00:00:00Z',
    })
    useIMStore.setState({
      conversations: [buildConversation({
        member_count: 1,
        can_send: false,
        dm_peer_membership_status: 'removed',
      })] as never,
      messages: { 'conv-1': [] } as never,
    })

    await useIMStore.getState().refreshConversationMembers('conv-1')
    const sent = await useIMStore.getState().sendMessage({
      convId: 'conv-1',
      content: '欢迎回来',
    })

    expect(sent).toBe(true)
    expect(mockCreateDM).toHaveBeenCalledWith('ws-1', 'user-2')
    expect(mockGetConversation).toHaveBeenCalledWith('conv-1')
    expect(mockSendMessage).toHaveBeenCalledOnce()
    expect(useIMStore.getState().conversations[0]).toEqual(expect.objectContaining({
      can_send: true,
      dm_peer_membership_status: 'active',
    }))
  })

  it('publishes one authoritative member array for realtime and rendering consumers', async () => {
    const members = [
      {
        member_type: 'user' as const,
        user_id: 'user-2',
        agent_id: null,
        nickname: 'Bob',
        username: 'bob',
        avatar: 'https://example.com/bob.png',
        role: 1,
        is_muted: false,
        pinned: false,
        joined_at: null,
      },
    ]
    mockGetConversation.mockResolvedValue({
      ...buildConversation({ id: 'conv-1', type: CONVERSATION_TYPE_GROUP }),
      member_count: 1,
      members,
    })
    useIMStore.setState({
      conversations: [buildConversation({
        id: 'conv-1',
        type: CONVERSATION_TYPE_GROUP,
        member_count: 2,
      })] as never,
    })

    await useIMStore.getState().refreshConversationMembers('conv-1')

    expect(useIMStore.getState().conversationMembers['conv-1']).toBe(members)
    expect(useIMStore.getState().conversationMembersLoading['conv-1']).toBe(false)
    expect(useIMStore.getState().conversations[0].member_count).toBe(1)
    expect(mockUpsertProfileHint).toHaveBeenCalledWith({
      id: 'user-2',
      nickname: 'Bob',
      username: 'bob',
      avatar: 'https://example.com/bob.png',
    })
    expect(mockEnsureProfiles).toHaveBeenCalledWith(['user-2'])
    expect(mockUpsertProfile).not.toHaveBeenCalled()
  })

  it('keeps empty member identity snapshots non-authoritative and schedules profile hydration', async () => {
    mockGetConversation.mockResolvedValue({
      ...buildConversation(),
      members: [{
        member_type: 'user' as const,
        user_id: 'user-2',
        agent_id: null,
        nickname: '',
        username: '',
        avatar: '',
        role: 1,
        is_muted: false,
        pinned: false,
        joined_at: null,
      }],
    })
    useIMStore.setState({ conversations: [buildConversation()] as never })

    await useIMStore.getState().refreshConversationMembers('conv-1')

    expect(mockUpsertProfile).not.toHaveBeenCalled()
    expect(mockUpsertProfileHint).not.toHaveBeenCalled()
    expect(mockEnsureProfiles).toHaveBeenCalledWith(['user-2'])
  })

  it('keeps a superseding realtime refresh when an older request resolves last', async () => {
    let resolveOld!: (value: ReturnType<typeof buildConversation>) => void
    let resolveRealtime!: (value: ReturnType<typeof buildConversation>) => void
    mockGetConversation
      .mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve }))
      .mockImplementationOnce(() => new Promise((resolve) => { resolveRealtime = resolve }))
    useIMStore.setState({
      conversations: [buildConversation({
        id: 'conv-1',
        type: CONVERSATION_TYPE_GROUP,
      })] as never,
    })

    const oldRequest = useIMStore.getState().refreshConversationMembers('conv-1')
    const realtimeRequest = useIMStore.getState().refreshConversationMembers(
      'conv-1',
      { supersede: true },
    )
    const realtimeMembers = [{
      member_type: 'user' as const,
      user_id: 'remaining-user',
      agent_id: null,
      nickname: 'Remaining',
      username: 'remaining',
      avatar: '',
      role: 3,
      is_muted: false,
      pinned: false,
      joined_at: null,
    }]
    resolveRealtime(buildConversation({
      member_count: 1,
      members: realtimeMembers,
    }))
    await realtimeRequest

    resolveOld(buildConversation({
      member_count: 2,
      members: [
        ...realtimeMembers,
        { ...realtimeMembers[0], user_id: 'former-owner', nickname: 'Former owner' },
      ],
    }))
    await oldRequest

    expect(useIMStore.getState().conversationMembers['conv-1']).toBe(realtimeMembers)
    expect(useIMStore.getState().conversationMembersLoading['conv-1']).toBe(false)
  })

  it('does not let an entry refresh downgrade an active membership barrier', async () => {
    vi.useFakeTimers()
    try {
      const formerOwner = {
        member_type: 'user' as const,
        user_id: 'former-owner',
        agent_id: null,
        nickname: 'Former owner',
        username: 'former-owner',
        avatar: '',
        role: 3,
        is_muted: false,
        pinned: false,
        joined_at: null,
      }
      const remainingMember = {
        ...formerOwner,
        user_id: 'remaining-user',
        nickname: 'Remaining',
        username: 'remaining',
      }
      mockGetConversation
        .mockResolvedValueOnce(buildConversation({
          members: [formerOwner, remainingMember],
        }))
        .mockResolvedValueOnce(buildConversation({
          members: [remainingMember],
        }))
      useIMStore.setState({
        conversations: [buildConversation({ member_count: 1 })] as never,
        conversationMembers: {
          'conv-1': [formerOwner, remainingMember],
        },
      })

      const eventRequest = useIMStore.getState().refreshConversationMembers('conv-1', {
        supersede: true,
        invalidateSnapshot: true,
        expectedMemberCount: 1,
        expectMembershipChange: true,
      })
      const entryRequest = useIMStore.getState().refreshConversationMembers('conv-1', {
        supersede: true,
        invalidateSnapshot: true,
      })

      expect(entryRequest).toBe(eventRequest)
      await vi.advanceTimersByTimeAsync(0)
      expect(mockGetConversation).toHaveBeenCalledTimes(1)
      expect(useIMStore.getState().conversationMembers['conv-1']).toBeUndefined()

      await vi.advanceTimersByTimeAsync(250)
      await Promise.all([eventRequest, entryRequest])

      expect(mockGetConversation).toHaveBeenCalledTimes(2)
      expect(useIMStore.getState().conversationMembers['conv-1']).toEqual([
        remainingMember,
      ])
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps the original identity baseline across consecutive Tencent events', async () => {
    vi.useFakeTimers()
    try {
      let resolveFirstRequest!: (value: ReturnType<typeof buildConversation>) => void
      const formerOwner = {
        member_type: 'user' as const,
        user_id: 'former-owner',
        agent_id: null,
        nickname: 'Former owner',
        username: 'former-owner',
        avatar: '',
        role: 3,
        is_muted: false,
        pinned: false,
        joined_at: null,
      }
      const remainingMember = {
        ...formerOwner,
        user_id: 'remaining-user',
        nickname: 'Remaining',
        username: 'remaining',
      }
      const staleProjection = buildConversation({
        members: [formerOwner, remainingMember],
      })
      mockGetConversation
        .mockImplementationOnce(() => new Promise((resolve) => {
          resolveFirstRequest = resolve
        }))
        .mockResolvedValueOnce(staleProjection)
        .mockResolvedValueOnce(staleProjection)
        .mockResolvedValueOnce(buildConversation({
          members: [remainingMember],
        }))
      useIMStore.setState({
        conversations: [buildConversation({ member_count: 2 })] as never,
        conversationMembers: {
          'conv-1': [formerOwner, remainingMember],
        },
      })

      const firstEvent = useIMStore.getState().refreshConversationMembers('conv-1', {
        supersede: true,
        invalidateSnapshot: true,
        expectMembershipChange: true,
      })
      const secondEvent = useIMStore.getState().refreshConversationMembers('conv-1', {
        supersede: true,
        invalidateSnapshot: true,
        expectMembershipChange: true,
      })

      await vi.advanceTimersByTimeAsync(250)
      expect(mockGetConversation).toHaveBeenCalledTimes(3)
      expect(useIMStore.getState().conversationMembers['conv-1']).toBeUndefined()

      await vi.advanceTimersByTimeAsync(1_000)
      await secondEvent
      resolveFirstRequest(staleProjection)
      await firstEvent

      expect(mockGetConversation).toHaveBeenCalledTimes(4)
      expect(useIMStore.getState().conversationMembers['conv-1']).toEqual([
        remainingMember,
      ])
    } finally {
      vi.useRealTimers()
    }
  })

  it('waits for the control-plane projection to match Tencent member count', async () => {
    vi.useFakeTimers()
    try {
      const formerOwner = {
        member_type: 'user' as const,
        user_id: 'former-owner',
        agent_id: null,
        nickname: 'Former owner',
        username: 'former-owner',
        avatar: '',
        role: 3,
        is_muted: false,
        pinned: false,
        joined_at: null,
      }
      const remainingMember = {
        ...formerOwner,
        user_id: 'remaining-user',
        nickname: 'Remaining',
        username: 'remaining',
      }
      mockGetConversation
        .mockResolvedValueOnce(buildConversation({
          members: [formerOwner, remainingMember],
        }))
        .mockResolvedValueOnce(buildConversation({
          members: [remainingMember],
        }))
      useIMStore.setState({
        conversations: [buildConversation({ member_count: 1 })] as never,
        conversationMembers: {
          'conv-1': [formerOwner, remainingMember],
        },
      })

      const request = useIMStore.getState().refreshConversationMembers('conv-1', {
        supersede: true,
        invalidateSnapshot: true,
        expectedMemberCount: 1,
        expectMembershipChange: true,
      })
      await vi.advanceTimersByTimeAsync(0)

      expect(mockGetConversation).toHaveBeenCalledTimes(1)
      expect(useIMStore.getState().conversations[0].member_count).toBe(1)
      expect(useIMStore.getState().conversationMembers['conv-1']).toBeUndefined()

      await vi.advanceTimersByTimeAsync(250)
      await request

      expect(mockGetConversation).toHaveBeenCalledTimes(2)
      expect(useIMStore.getState().conversationMembers['conv-1']).toEqual([
        remainingMember,
      ])
    } finally {
      vi.useRealTimers()
    }
  })

  it('waits for a changed member identity when Tencent omits member count', async () => {
    vi.useFakeTimers()
    try {
      const formerOwner = {
        member_type: 'user' as const,
        user_id: 'former-owner',
        agent_id: null,
        nickname: 'Former owner',
        username: 'former-owner',
        avatar: '',
        role: 3,
        is_muted: false,
        pinned: false,
        joined_at: null,
      }
      const remainingMember = {
        ...formerOwner,
        user_id: 'remaining-user',
        nickname: 'Remaining',
        username: 'remaining',
      }
      mockGetConversation
        .mockResolvedValueOnce(buildConversation({
          members: [formerOwner, remainingMember],
        }))
        .mockResolvedValueOnce(buildConversation({
          members: [remainingMember],
        }))
      useIMStore.setState({
        conversations: [buildConversation({ member_count: 2 })] as never,
        conversationMembers: {
          'conv-1': [formerOwner, remainingMember],
        },
      })

      const request = useIMStore.getState().refreshConversationMembers('conv-1', {
        supersede: true,
        invalidateSnapshot: true,
        expectMembershipChange: true,
      })
      await vi.advanceTimersByTimeAsync(0)

      expect(mockGetConversation).toHaveBeenCalledTimes(1)
      expect(useIMStore.getState().conversationMembers['conv-1']).toBeUndefined()

      await vi.advanceTimersByTimeAsync(250)
      await request

      expect(mockGetConversation).toHaveBeenCalledTimes(2)
      expect(useIMStore.getState().conversationMembers['conv-1']).toEqual([
        remainingMember,
      ])
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps the shared snapshot invalid when membership projection never changes', async () => {
    vi.useFakeTimers()
    try {
      const formerOwner = {
        member_type: 'user' as const,
        user_id: 'former-owner',
        agent_id: null,
        nickname: 'Former owner',
        username: 'former-owner',
        avatar: '',
        role: 3,
        is_muted: false,
        pinned: false,
        joined_at: null,
      }
      const remainingMember = {
        ...formerOwner,
        user_id: 'remaining-user',
        nickname: 'Remaining',
        username: 'remaining',
      }
      mockGetConversation.mockResolvedValue(buildConversation({
        members: [formerOwner, remainingMember],
      }))
      useIMStore.setState({
        conversations: [buildConversation({ member_count: 2 })] as never,
        conversationMembers: {
          'conv-1': [formerOwner, remainingMember],
        },
      })

      const request = useIMStore.getState().refreshConversationMembers('conv-1', {
        supersede: true,
        invalidateSnapshot: true,
        expectMembershipChange: true,
      })
      const rejection = expect(request).rejects.toThrow('member identities did not change')

      await vi.advanceTimersByTimeAsync(4_250)
      await rejection

      expect(mockGetConversation).toHaveBeenCalledTimes(4)
      expect(useIMStore.getState().conversationMembers['conv-1']).toBeUndefined()
      expect(useIMStore.getState().conversationMembersLoading['conv-1']).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('retries a transient membership reconciliation failure', async () => {
    vi.useFakeTimers()
    try {
      const remainingMember = {
        member_type: 'user' as const,
        user_id: 'remaining-user',
        agent_id: null,
        nickname: 'Remaining',
        username: 'remaining',
        avatar: '',
        role: 3,
        is_muted: false,
        pinned: false,
        joined_at: null,
      }
      mockGetConversation
        .mockRejectedValueOnce(new Error('temporary network failure'))
        .mockResolvedValueOnce(buildConversation({ members: [remainingMember] }))
      useIMStore.setState({
        conversations: [buildConversation({ member_count: 1 })] as never,
      })

      const request = useIMStore.getState().refreshConversationMembers('conv-1', {
        supersede: true,
        invalidateSnapshot: true,
        expectedMemberCount: 1,
        expectMembershipChange: true,
      })
      await vi.advanceTimersByTimeAsync(250)
      await request

      expect(mockGetConversation).toHaveBeenCalledTimes(2)
      expect(useIMStore.getState().conversationMembers['conv-1']).toEqual([
        remainingMember,
      ])
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not publish a member response after the conversation is removed', async () => {
    let resolveRequest!: (value: ReturnType<typeof buildConversation>) => void
    mockGetConversation.mockImplementationOnce(
      () => new Promise((resolve) => { resolveRequest = resolve }),
    )
    useIMStore.setState({
      conversations: [buildConversation({
        id: 'conv-1',
        type: CONVERSATION_TYPE_GROUP,
      })] as never,
    })

    const request = useIMStore.getState().refreshConversationMembers('conv-1')
    useIMStore.getState().removeConversation('conv-1')
    resolveRequest(buildConversation({
      members: [{
        member_type: 'user',
        user_id: 'former-owner',
        agent_id: null,
        nickname: 'Former owner',
        username: 'former-owner',
        avatar: '',
        role: 3,
        is_muted: false,
        pinned: false,
        joined_at: null,
      }],
    }))
    await request

    expect(useIMStore.getState().conversationMembers['conv-1']).toBeUndefined()
    expect(useIMStore.getState().conversationMembersLoading['conv-1']).toBeUndefined()
  })

  it('treats an empty member response as an authoritative loaded snapshot', async () => {
    mockGetConversation.mockResolvedValue(buildConversation({ members: [] }))
    useIMStore.setState({
      conversations: [buildConversation({ member_count: 2 })] as never,
    })

    await useIMStore.getState().refreshConversationMembers('conv-1')

    expect(useIMStore.getState().conversationMembers['conv-1']).toEqual([])
    expect(useIMStore.getState().conversationMembersLoading['conv-1']).toBe(false)
    expect(useIMStore.getState().conversations[0].member_count).toBe(0)
  })

  it('deduplicates ordinary refreshes and preserves the last snapshot on failure', async () => {
    let resolveRequest!: (value: ReturnType<typeof buildConversation>) => void
    mockGetConversation.mockImplementationOnce(
      () => new Promise((resolve) => { resolveRequest = resolve }),
    )
    useIMStore.setState({
      conversations: [buildConversation()] as never,
      conversationMembers: {
        'conv-1': [{
          member_type: 'user',
          user_id: 'user-2',
          agent_id: null,
          nickname: 'Bob',
          username: 'bob',
          avatar: '',
          role: 1,
          is_muted: false,
          pinned: false,
          joined_at: null,
        }],
      },
    })

    const first = useIMStore.getState().refreshConversationMembers('conv-1')
    const duplicate = useIMStore.getState().refreshConversationMembers('conv-1')
    expect(mockGetConversation).toHaveBeenCalledTimes(1)
    resolveRequest(buildConversation({ members: [] }))
    await Promise.all([first, duplicate])

    mockGetConversation.mockRejectedValueOnce(new Error('network'))
    await expect(
      useIMStore.getState().refreshConversationMembers('conv-1'),
    ).rejects.toThrow('network')
    expect(useIMStore.getState().conversationMembers['conv-1']).toEqual([])
    expect(useIMStore.getState().conversationMembersLoading['conv-1']).toBe(false)
  })
})

describe('useIMStore.updateConversation', () => {
  it('远端事件不能覆盖服务端已确认的置顶状态', () => {
    useIMStore.setState({
      conversations: [buildConversation({
        pinned: true,
        pinned_source: 'tabtin',
        pinned_revision: 3,
      })] as never,
    })

    useIMStore.getState().updateConversation('conv-1', {
      pinned: false,
      pinned_source: 'tencent',
    })

    expect(useIMStore.getState().conversations[0]).toEqual(expect.objectContaining({
      pinned: true,
      pinned_source: 'tabtin',
      pinned_revision: 3,
    }))
  })

  it('较旧的服务端 revision 不能覆盖较新的置顶状态', () => {
    useIMStore.setState({
      conversations: [buildConversation({
        pinned: false,
        pinned_source: 'tabtin',
        pinned_revision: 4,
      })] as never,
    })

    useIMStore.getState().updateConversation('conv-1', {
      pinned: true,
      pinned_source: 'tabtin',
      pinned_revision: 3,
    })

    expect(useIMStore.getState().conversations[0]).toEqual(expect.objectContaining({
      pinned: false,
      pinned_revision: 4,
    }))
  })

  it('同 revision 的晚到事实事件不能覆盖本地已展示的服务端结果', () => {
    useIMStore.setState({
      conversations: [buildConversation({
        pinned: true,
        pinned_source: 'tabtin',
        pinned_revision: 5,
      })] as never,
    })

    useIMStore.getState().updateConversation('conv-1', {
      pinned: false,
      pinned_source: 'tabtin',
      pinned_revision: 5,
    })

    expect(useIMStore.getState().conversations[0]).toEqual(expect.objectContaining({
      pinned: true,
      pinned_revision: 5,
    }))
  })

  it('同一引用的晚到 conversation.updated 不覆盖冷启动补全的摘要', () => {
    const messageRef = '019f0000-0000-7000-8000-000000000042'
    useIMStore.setState({
      conversations: [buildConversation({
        last_message_preview: '冷启动补全的 Agent 回复',
        last_message_reference: {
          message_ref: messageRef,
          tabtin_message_id: '42',
        },
      })] as never,
      messages: {},
    })

    useIMStore.getState().updateConversation('conv-1', {
      last_message_preview: '[自定义消息]',
      last_message_reference: {
        message_ref: messageRef,
        tabtin_message_id: '42',
      },
    })

    expect(useIMStore.getState().conversations[0].last_message_preview).toBe(
      '冷启动补全的 Agent 回复',
    )
  })

  it('conversation.updated 不覆盖同一条已水合的本地 Agent 消息预览', () => {
    const lastMessageAt = '2026-08-04T03:00:00Z'
    const messageRef = '019f0000-0000-7000-8000-000000000042'
    useIMStore.setState({
      conversations: [buildConversation({
        last_message_at: lastMessageAt,
        last_message_reference: {
          message_ref: messageRef,
          tabtin_message_id: '42',
        },
      })] as never,
      messages: {
        'conv-1': [{
          id: 42,
          conversation_id: 'conv-1',
          sender_id: 'agent-1',
          content: '已水合的 Agent 回复',
          message_type: 1,
          reply_to_id: null,
          has_attachment: false,
          metadata: {
            kind: 'tabtin_ref',
            message_ref: messageRef,
            tabtin_message_id: '42',
          },
          created_at: lastMessageAt,
        }],
      } as never,
    })

    useIMStore.getState().updateConversation('conv-1', {
      last_message_at: lastMessageAt,
      last_message_preview: '[自定义消息]',
      last_message_reference: {
        message_ref: messageRef,
        tabtin_message_id: '42',
      },
    })

    expect(useIMStore.getState().conversations[0].last_message_preview).toBe(
      '已水合的 Agent 回复',
    )
  })

  it('新的引用消息不会沿用上一条已水合的本地预览', () => {
    const oldMessageRef = '019f0000-0000-7000-8000-000000000042'
    useIMStore.setState({
      conversations: [buildConversation({
        last_message_reference: {
          message_ref: oldMessageRef,
          tabtin_message_id: '42',
        },
      })] as never,
      messages: {
        'conv-1': [{
          id: 42,
          conversation_id: 'conv-1',
          sender_id: 'agent-1',
          content: '上一条 Agent 回复',
          message_type: 1,
          reply_to_id: null,
          has_attachment: false,
          metadata: {
            kind: 'tabtin_ref',
            message_ref: oldMessageRef,
            tabtin_message_id: '42',
          },
          created_at: '2026-08-04T03:00:00Z',
        }],
      } as never,
    })

    useIMStore.getState().updateConversation('conv-1', {
      last_message_preview: '[自定义消息]',
      last_message_reference: {
        message_ref: '019f0000-0000-7000-8000-000000000043',
        tabtin_message_id: '43',
      },
    })

    expect(useIMStore.getState().conversations[0].last_message_preview).toBe(
      '[自定义消息]',
    )
  })

  it('新普通消息原子清除旧引用，局部更新不会复活旧 Agent 预览', () => {
    const oldMessageRef = '019f0000-0000-7000-8000-000000000042'
    useIMStore.setState({
      conversations: [buildConversation({
        last_message_preview: '旧 Agent 回复',
        last_message_reference: {
          message_ref: oldMessageRef,
          tabtin_message_id: '42',
        },
      })] as never,
      messages: {
        'conv-1': [{
          id: 42,
          conversation_id: 'conv-1',
          sender_id: 'agent-1',
          content: '旧 Agent 回复',
          message_type: 1,
          reply_to_id: null,
          has_attachment: false,
          metadata: {
            kind: 'tabtin_ref',
            message_ref: oldMessageRef,
            tabtin_message_id: '42',
          },
          created_at: '2026-08-04T03:00:00Z',
        }],
      } as never,
    })

    useIMStore.getState().onRealtimeMessage('conv-1', {
      id: 43,
      conversation_id: 'conv-1',
      sender_id: 'user-2',
      content: '新的普通消息',
      message_type: 1,
      reply_to_id: null,
      has_attachment: false,
      metadata: {},
      created_at: '2026-08-04T03:01:00Z',
    })
    useIMStore.getState().updateConversation('conv-1', { pinned: true })

    expect(useIMStore.getState().conversations[0]).toEqual(expect.objectContaining({
      last_message_preview: '新的普通消息',
      last_message_reference: null,
      pinned: true,
    }))
  })

  it('清空聊天记录后腾讯推空 last_message_at 时会话排序位置不变 ', () => {
    const active = buildConversation({
      id: 'conv-active',
      name: 'Bob',
      last_message_at: '2026-08-05T10:00:00Z',
      last_message_preview: '刚聊的一句',
      created_at: '2026-01-01T00:00:00Z',
    })
    const older = buildConversation({
      id: 'conv-older',
      dm_peer_user_id: 'user-3',
      name: 'Carol',
      last_message_at: '2026-08-05T09:00:00Z',
      last_message_preview: '较早',
      created_at: '2026-02-01T00:00:00Z',
    })
    useIMStore.setState({
      conversations: [active, older] as never,
      messages: {
        'conv-active': [{
          id: 1,
          conversation_id: 'conv-active',
          sender_id: 'user-2',
          content: '刚聊的一句',
          message_type: 1,
          reply_to_id: null,
          has_attachment: false,
          metadata: {},
          created_at: '2026-08-05T10:00:00Z',
        }],
      } as never,
    })

    useIMStore.getState().clearConversationMessages('conv-active')
    // 腾讯 clearHistoryMessage 随后推 conversation.updated，lastMessage 为空
    useIMStore.getState().updateConversation('conv-active', {
      ...active,
      last_message_at: null,
      last_message_preview: '',
      last_message_reference: null,
    })

    expect(useIMStore.getState().conversations.map((c) => c.id)).toEqual([
      'conv-active',
      'conv-older',
    ])
    expect(useIMStore.getState().conversations[0]).toEqual(expect.objectContaining({
      id: 'conv-active',
      last_message_at: '2026-08-05T10:00:00Z',
      last_message_preview: '',
    }))
  })
})

describe('useIMStore.loadLabels', () => {
  it('#8756: 忽略旧 organization 晚到的标签响应', async () => {
    type Label = { id: string; name: string; color: string }
    let resolveWs1: ((value: Label[]) => void) | null = null
    let resolveWs2: ((value: Label[]) => void) | null = null
    mockListLabels.mockImplementation((organizationId: string) => (
      new Promise<Label[]>((resolve) => {
        if (organizationId === 'ws-1') {
          resolveWs1 = resolve
          return
        }
        resolveWs2 = resolve
      })
    ))
    useIMStore.setState({
      labels: [{ id: 'label-from-ws-1', name: '旧标签', color: '#000000' }],
      activeLabelFilters: ['label-from-ws-1'],
      activeLabelFiltersOrganizationId: 'ws-1',
      labelsLoadedOrganizationId: 'ws-1',
    })

    const ws1Load = useIMStore.getState().loadLabels('ws-1', true)
    const ws2Load = useIMStore.getState().loadLabels('ws-2')
    await Promise.resolve()
    expect(resolveWs2).not.toBeNull()
    resolveWs2!([{ id: 'label-from-ws-2', name: '新标签', color: '#ffffff' }])
    await ws2Load
    expect(resolveWs1).not.toBeNull()
    resolveWs1!([{ id: 'label-from-ws-1', name: '旧标签', color: '#000000' }])
    await ws1Load

    expect(useIMStore.getState()).toMatchObject({
      activeLabelFilters: [],
      activeLabelFiltersOrganizationId: 'ws-2',
      labelsLoadedOrganizationId: 'ws-2',
    })
    expect(useIMStore.getState().labels).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'label-from-ws-2' }),
    ]))
  })
})

describe('useIMStore.loadUnreadCounts', () => {
  it('发现当前组织有孤儿未读会话时按 conversation detail 补实体，绕过列表筛选', async () => {
    mockGetUnreadCount.mockResolvedValue({
      total: 2,
      conversations: { 'conv-orphan': 2 },
    })
    mockGetConversation.mockResolvedValue(
      buildConversation({
        id: 'conv-orphan',
        organization_id: 'ws-1',
        unread_count: 2,
      }),
    )

    await useIMStore.getState().loadUnreadCounts('ws-1')
    await Promise.resolve()

    expect(useIMStore.getState().unreadCounts).toEqual({ 'conv-orphan': 2 })
    expect(useIMStore.getState().totalUnread).toBe(2)
    expect(useIMStore.getState().conversations).toEqual([
      expect.objectContaining({ id: 'conv-orphan' }),
    ])
    expect(mockGetConversation).toHaveBeenCalledWith('conv-orphan')
    expect(mockListConversations).not.toHaveBeenCalled()
  })

  it('active label filter 下 orphan detail 不匹配筛选时保留未读但不污染当前列表', async () => {
    mockGetUnreadCount.mockResolvedValue({
      total: 2,
      conversations: { 'conv-orphan': 2 },
    })
    mockGetConversation.mockResolvedValue(
      buildConversation({
        id: 'conv-orphan',
        organization_id: 'ws-1',
        unread_count: 2,
        labels: [{ id: 'other-label', name: 'Other', color: '#999999' }],
      }),
    )
    useIMStore.setState({
      activeLabelFilters: ['label-a'],
      activeLabelFiltersOrganizationId: 'ws-1',
    })

    await useIMStore.getState().loadUnreadCounts('ws-1')
    await Promise.resolve()
    await useIMStore.getState().loadUnreadCounts('ws-1')
    await Promise.resolve()

    expect(useIMStore.getState().unreadCounts).toEqual({ 'conv-orphan': 2 })
    expect(useIMStore.getState().conversations).toEqual([])
    expect(mockGetConversation).toHaveBeenCalledTimes(1)
    expect(mockListConversations).not.toHaveBeenCalled()
  })

  it('#8756: 不用旧 organization 的标签筛选隐藏新 organization 未读会话', async () => {
    mockGetUnreadCount.mockResolvedValue({
      total: 2,
      conversations: { 'conv-orphan': 2 },
    })
    mockGetConversation.mockResolvedValue(
      buildConversation({
        id: 'conv-orphan',
        organization_id: 'ws-2',
        unread_count: 2,
        labels: [{ id: 'other-label', name: 'Other', color: '#999999' }],
      }),
    )
    useIMStore.setState({
      activeLabelFilters: ['label-from-ws-1'],
      activeLabelFiltersOrganizationId: 'ws-1',
    })

    await useIMStore.getState().loadUnreadCounts('ws-2')

    expect(useIMStore.getState().conversations).toEqual([
      expect.objectContaining({ id: 'conv-orphan', organization_id: 'ws-2' }),
    ])
  })

  it('未读会话已在本地列表时不重复补拉 conversations', async () => {
    mockGetUnreadCount.mockResolvedValue({
      total: 1,
      conversations: { 'conv-1': 1 },
    })
    useIMStore.setState({
      conversations: [buildConversation({ id: 'conv-1' })] as never,
    })

    await useIMStore.getState().loadUnreadCounts('ws-1')
    await Promise.resolve()

    expect(mockListConversations).not.toHaveBeenCalled()
  })

  it('只替换当前 organization 的未读数，保留其它 organization 缓存', async () => {
    mockGetUnreadCount.mockResolvedValue({
      total: 2,
      conversations: { 'conv-1': 2 },
    })
    useIMStore.setState({
      conversations: [
        buildConversation({ id: 'conv-1', organization_id: 'ws-1' }),
        buildConversation({ id: 'conv-2', organization_id: 'ws-2' }),
      ] as never,
      unreadCounts: { 'conv-1': 1, 'conv-2': 4 },
      totalUnread: 5,
    })

    await useIMStore.getState().loadUnreadCounts('ws-1')
    await Promise.resolve()

    expect(useIMStore.getState().unreadCounts).toEqual({
      'conv-1': 2,
      'conv-2': 4,
    })
    expect(useIMStore.getState().totalUnread).toBe(6)
    expect(mockListConversations).not.toHaveBeenCalled()
  })

  it('腾讯未读快照按绝对值覆盖当前 organization，不做增量累加', () => {
    useIMStore.setState({
      conversations: [
        buildConversation({
          id: 'conv-1',
          organization_id: 'ws-1',
          unread_count: 8,
        }),
        buildConversation({
          id: 'conv-2',
          organization_id: 'ws-2',
          unread_count: 4,
        }),
      ] as never,
      unreadCounts: { 'conv-1': 8, 'conv-2': 4 },
      totalUnread: 12,
    })

    useIMStore.getState().applyUnreadSnapshot('ws-1', {
      total: 2,
      conversations: { 'conv-1': 2 },
    })

    expect(useIMStore.getState().unreadCounts).toEqual({
      'conv-1': 2,
      'conv-2': 4,
    })
    expect(useIMStore.getState().totalUnread).toBe(6)
    expect(useIMStore.getState().conversations).toEqual([
      expect.objectContaining({ id: 'conv-1', unread_count: 2 }),
      expect.objectContaining({ id: 'conv-2', unread_count: 4 }),
    ])
  })
})

describe('useIMStore.sendMessage read receipt', () => {
  it('回复图片时把原消息类型写入引用预览', async () => {
    mockSendMessage.mockResolvedValue({
      id: 43,
      seq: 43,
      conversation_id: 'conv-1',
      created_at: '2026-08-08T08:00:00Z',
    })
    const repliedMessage = {
      id: 42,
      seq: 42,
      conversation_id: 'conv-1',
      sender_id: 'user-2',
      content: '现场照片',
      message_type: MESSAGE_TYPE_IMAGE,
      reply_to_id: null,
      has_attachment: true,
      metadata: { file_id: 'image-1', file_name: 'photo.jpg' },
      created_at: '2026-08-08T07:59:00Z',
    }
    useIMStore.setState({
      conversations: [buildConversation()] as never,
      messages: { 'conv-1': [repliedMessage] } as never,
    })

    await useIMStore.getState().sendMessage({
      convId: 'conv-1',
      content: '收到',
      replyTo: repliedMessage as never,
    })

    expect(useIMStore.getState().messages['conv-1'].find((message) => message.id === 43)?.reply_to_preview)
      .toEqual({
        sender_id: 'user-2',
        content: '现场照片',
        message_type: MESSAGE_TYPE_IMAGE,
      })
  })

  it('发送确认、实时回声和历史刷新后保留本地撤回起点', async () => {
    vi.useFakeTimers()
    vi.setSystemTime('2026-08-08T07:50:16.864Z')
    try {
      mockSendMessage.mockResolvedValue({
        id: 31,
        seq: 31,
        conversation_id: 'conv-1',
        created_at: '2026-08-08T07:47:23.000Z',
      })
      useIMStore.setState({
        conversations: [buildConversation()] as never,
        messages: { 'conv-1': [] } as never,
      })

      await useIMStore.getState().sendMessage({
        convId: 'conv-1',
        content: '刚发送的消息',
      })
      const sent = useIMStore.getState().messages['conv-1'][0]
      const { _localSentAt: _localOnly, ...providerEcho } = sent

      useIMStore.getState().onRealtimeMessage('conv-1', {
        ...providerEcho,
        metadata: { ...sent.metadata },
        created_at: '2026-08-08T07:47:23.000Z',
      })
      expect(_localOnly).toBe('2026-08-08T07:50:16.864Z')

      mockGetMessages.mockResolvedValueOnce([providerEcho])
      await useIMStore.getState().loadMessages('conv-1')

      expect(useIMStore.getState().messages['conv-1'][0]).toEqual(expect.objectContaining({
        created_at: '2026-08-08T07:47:23.000Z',
        _localSentAt: '2026-08-08T07:50:16.864Z',
      }))
    } finally {
      vi.useRealTimers()
    }
  })

  it('发送确认后为群消息补上未读回执，避免切开会话才出现已读圈', async () => {
    mockSendMessage.mockResolvedValue({
      id: 44,
      seq: 44,
      conversation_id: 'conv-1',
      created_at: '2026-08-29T09:15:00Z',
      read_receipt: { read_count: 0, recipient_count: 2 },
    })
    useIMStore.setState({
      conversations: [buildConversation({ type: CONVERSATION_TYPE_GROUP, member_count: 3 })] as never,
      messages: { 'conv-1': [] } as never,
    })

    await useIMStore.getState().sendMessage({
      convId: 'conv-1',
      content: '刚发出',
    })

    expect(useIMStore.getState().messages['conv-1'][0].read_receipt).toEqual({
      read_count: 0,
      recipient_count: 2,
    })
  })

  it('发送确认时服务端未带回执，仍按成员数补未读圈', async () => {
    mockSendMessage.mockResolvedValue({
      id: 45,
      seq: 45,
      conversation_id: 'conv-1',
      created_at: '2026-08-29T09:16:00Z',
    })
    useIMStore.setState({
      conversations: [buildConversation({ type: CONVERSATION_TYPE_GROUP, member_count: 3 })] as never,
      messages: { 'conv-1': [] } as never,
    })

    await useIMStore.getState().sendMessage({
      convId: 'conv-1',
      content: '仍应看见圈',
    })

    expect(useIMStore.getState().messages['conv-1'][0].read_receipt).toEqual({
      read_count: 0,
      recipient_count: 2,
    })
  })

  it('对端回执先于发送确认到达时，确认后仍标已读', async () => {
    const pending = deferred<{
      id: number
      seq: number
      conversation_id: string
      created_at: string
    }>()
    mockSendMessage.mockReturnValue(pending.promise)
    useIMStore.setState({
      conversations: [buildConversation({ type: CONVERSATION_TYPE_GROUP, member_count: 2 })] as never,
      messages: { 'conv-1': [] } as never,
    })

    const sending = useIMStore.getState().sendMessage({
      convId: 'conv-1',
      content: '竞态',
    })
    await Promise.resolve()
    expect(useIMStore.getState().messages['conv-1'][0]._optimistic).toBe(true)

    useIMStore.getState().onReadReceipt('conv-1', 'user-2', 46, 46, 0)

    pending.resolve({
      id: 46,
      seq: 46,
      conversation_id: 'conv-1',
      created_at: '2026-08-29T09:17:00Z',
    })
    await sending

    expect(useIMStore.getState().messages['conv-1'][0].read_receipt).toEqual({
      read_count: 1,
      recipient_count: 1,
    })
  })

  it('拒绝向已移除组织成员的只读私聊发送消息', async () => {
    useIMStore.setState({
      conversations: [buildConversation({
        can_send: false,
        dm_peer_membership_status: 'removed',
      })] as never,
      messages: { 'conv-1': [] } as never,
    })

    const sent = await useIMStore.getState().sendMessage({
      convId: 'conv-1',
      content: '不应送达',
    })

    expect(sent).toBe(false)
    expect(mockSendMessage).not.toHaveBeenCalled()
    expect(useIMStore.getState().messages['conv-1']).toEqual([])
  })

  it('拒绝向已解除外部联系人的只读私聊发送消息', async () => {
    useIMStore.setState({
      conversations: [buildConversation({
        is_external: true,
        external_contact_relationship: 'removed',
      })] as never,
      messages: { 'conv-1': [] } as never,
    })

    const sent = await useIMStore.getState().sendMessage({
      convId: 'conv-1',
      content: '不应送达',
    })

    expect(sent).toBe(false)
    expect(mockSendMessage).not.toHaveBeenCalled()
    expect(useIMStore.getState().messages['conv-1']).toEqual([])
  })

  it.each([
    ['文件', MESSAGE_TYPE_FILE, {}],
    ['图片', MESSAGE_TYPE_IMAGE, {}],
    ['表格卡片', MESSAGE_TYPE_TEXT, { card: { type: 'table' } }],
    ['个人名片', MESSAGE_TYPE_TEXT, { card: { type: 'contact' } }],
    ['Agent mention', MESSAGE_TYPE_TEXT, { mentioned_agent_ids: ['agent-1'] }],
  ])('外部会话拒绝发送%s', async (_label, messageType, metadata) => {
    useIMStore.setState({
      conversations: [buildConversation({
        type: CONVERSATION_TYPE_GROUP,
        is_external: true,
      })] as never,
      messages: { 'conv-1': [] } as never,
    })

    const sent = await useIMStore.getState().sendMessage({
      convId: 'conv-1',
      content: '不应送达',
      messageType,
      metadata,
    })

    expect(sent).toBe(false)
    expect(mockSendMessage).not.toHaveBeenCalled()
    expect(useIMStore.getState().messages['conv-1']).toEqual([])
  })

  it('外部会话仍可发送普通文本', async () => {
    mockSendMessage.mockResolvedValue({
      id: 101,
      seq: 1,
      conversation_id: 'conv-1',
      created_at: '2026-08-15T00:00:00Z',
    })
    useIMStore.setState({
      conversations: [buildConversation({
        type: CONVERSATION_TYPE_GROUP,
        is_external: true,
      })] as never,
      messages: { 'conv-1': [] } as never,
    })

    const sent = await useIMStore.getState().sendMessage({
      convId: 'conv-1',
      content: '允许送达',
    })

    expect(sent).toBe(true)
    expect(mockSendMessage).toHaveBeenCalledTimes(1)
  })

  it('外部会话仍可转发普通文本', async () => {
    mockSendMessage.mockResolvedValue({
      id: 102,
      seq: 2,
      conversation_id: 'conv-1',
      created_at: '2026-08-15T00:00:01Z',
    })
    useIMStore.setState({
      conversations: [buildConversation({
        type: CONVERSATION_TYPE_GROUP,
        is_external: true,
      })] as never,
      messages: { 'conv-1': [] } as never,
    })

    const sent = await useIMStore.getState().sendMessage({
      convId: 'conv-1',
      content: '允许转发',
      metadata: {
        forwarded_from: {
          original_message_id: 100,
          original_conversation_id: 'conv-source',
          original_conversation_name: '来源群',
          original_sender_id: 'user-2',
          original_sender_name: '成员二',
        },
      },
    })

    expect(sent).toBe(true)
    expect(mockSendMessage).toHaveBeenCalledTimes(1)
  })

  it('发送外部联系人私聊前重新校验关系', async () => {
    mockListExternalContacts.mockResolvedValueOnce({
      items: [
        { peer_user_id: 'user-2', peer_organization_id: 'wrong-org', relationship: 'friend' },
        { peer_user_id: 'user-2', peer_organization_id: 'peer-org', relationship: 'removed' },
      ],
    })
    useIMStore.setState({
      conversations: [buildConversation({ is_external: true })] as never,
      messages: { 'conv-1': [] } as never,
    })

    const sent = await useIMStore.getState().sendMessage({
      convId: 'conv-1',
      content: '不应送达',
    })

    expect(sent).toBe(false)
    expect(mockListExternalContacts).toHaveBeenCalledWith('ws-1')
    expect(mockSendMessage).not.toHaveBeenCalled()
    expect(useIMStore.getState().conversations[0].external_contact_relationship)
      .toBe('removed')
  })

  it('外部联系人关系查询失败后允许下次发送重试', async () => {
    mockSendMessage.mockResolvedValue({
      id: 101,
      seq: 1,
      created_at: '2026-08-14T00:00:00Z',
    })
    mockListExternalContacts
      .mockRejectedValueOnce(new Error('network unavailable'))
      .mockResolvedValueOnce({
        items: [{ peer_user_id: 'user-2', peer_organization_id: 'peer-org', relationship: 'friend' }],
      })
    useIMStore.setState({
      conversations: [buildConversation({ is_external: true })] as never,
      messages: { 'conv-1': [] } as never,
    })

    expect(await useIMStore.getState().sendMessage({
      convId: 'conv-1',
      content: '第一次失败',
    })).toBe(false)
    expect(useIMStore.getState().conversations[0].external_contact_relationship)
      .toBeUndefined()

    expect(await useIMStore.getState().sendMessage({
      convId: 'conv-1',
      content: '第二次重试',
    })).toBe(true)
    expect(mockListExternalContacts).toHaveBeenCalledTimes(2)
    expect(mockSendMessage).toHaveBeenCalledTimes(1)
    expect(useIMStore.getState().conversations[0].external_contact_relationship)
      .toBe('friend')
  })

  it.each(['suspended', 'blocked'] as const)(
    '外部联系人为 %s 时拒绝发送',
    async (relationship) => {
      mockSendMessage.mockResolvedValue({
        id: 101,
        seq: 1,
        created_at: '2026-08-14T00:00:00Z',
      })
      mockListExternalContacts.mockResolvedValueOnce({
        items: [{ peer_user_id: 'user-2', peer_organization_id: 'peer-org', relationship }],
      })
      useIMStore.setState({
        conversations: [buildConversation({ is_external: true })] as never,
        messages: { 'conv-1': [] } as never,
      })

      expect(await useIMStore.getState().sendMessage({
        convId: 'conv-1',
        content: '仍按原策略发送',
      })).toBe(false)
      expect(mockSendMessage).not.toHaveBeenCalled()
      expect(useIMStore.getState().conversations[0].external_contact_relationship)
        .toBe(relationship)
    },
  )

  it('超出腾讯正文预算时不创建乐观消息，也不调用发送接口', async () => {
    useIMStore.setState({
      conversations: [buildConversation()] as never,
      messages: { 'conv-1': [] } as never,
    })

    const sent = await useIMStore.getState().sendMessage({
      convId: 'conv-1',
      content: 'a'.repeat(IM_MESSAGE_CONTENT_MAX_BYTES + 1),
    })

    expect(sent).toBe(false)
    expect(mockSendMessage).not.toHaveBeenCalled()
    expect(useIMStore.getState().messages['conv-1']).toEqual([])
    expect(useIMStore.getState().sendError).toBe('messageTooLong')
    expect(useIMStore.getState().isSending).toBe(false)
  })

  it('回复消息前上报最近一条已确认消息为已读', async () => {
    const tabchatApi = await import('@/services/tabchatApi')
    const markRead = vi.mocked(tabchatApi.markRead)
    markRead.mockResolvedValue({ marked_count: 1 })
    mockSendMessage.mockResolvedValue({
      id: 43,
      seq: 43,
      conversation_id: 'conv-1',
      created_at: '2026-08-04T13:31:00Z',
    })
    useIMStore.setState({
      conversations: [buildConversation({ unread_count: 1 })] as never,
      unreadCounts: { 'conv-1': 1 },
      totalUnread: 1,
      messages: {
        'conv-1': [{
          id: 42,
          seq: 42,
          conversation_id: 'conv-1',
          sender_id: 'user-2',
          content: '你看到了吗？',
          message_type: 1,
          reply_to_id: null,
          has_attachment: false,
          metadata: {},
          transport: { kind: 'group', sequence: 42 },
          created_at: '2026-08-04T13:30:00Z',
        }],
      } as never,
    })

    await useIMStore.getState().sendMessage({
      convId: 'conv-1',
      content: '看到了',
    })

    expect(markRead).toHaveBeenCalledWith('conv-1', { kind: 'group', sequence: 42 })
    expect(markRead.mock.invocationCallOrder[0]).toBeLessThan(
      mockSendMessage.mock.invocationCallOrder[0],
    )
  })

  it('C2C 双方 MsgSeq 重复时仍用 message_ref 确认本次发送结果', async () => {
    mockSendMessage.mockResolvedValue({
      id: 7,
      seq: 7,
      conversation_id: 'conv-1',
      created_at: '2026-08-04T13:31:00Z',
      transport: {
        kind: 'c2c',
        sequence: 7,
        sent_at: '2026-08-04T13:31:00Z',
      },
    })
    useIMStore.setState({
      conversations: [buildConversation()] as never,
      messages: {
        'conv-1': [{
          id: 7,
          seq: 7,
          conversation_id: 'conv-1',
          sender_id: 'user-2',
          content: '对方同序号消息',
          message_type: 1,
          reply_to_id: null,
          has_attachment: false,
          metadata: { message_ref: 'peer-message-ref' },
          transport: {
            kind: 'c2c',
            sequence: 7,
            sent_at: '2026-08-04T13:30:00Z',
          },
          created_at: '2026-08-04T13:30:00Z',
        }],
      } as never,
    })

    await useIMStore.getState().sendMessage({
      convId: 'conv-1',
      content: '我的新消息',
    })

    expect(useIMStore.getState().messages['conv-1']).toHaveLength(2)
    expect(useIMStore.getState().conversations[0].last_message_preview).toBe('我的新消息')
  })
})

describe('useIMStore.sendMessage retry', () => {
  it('断网失败后恢复并切回会话时，未确认消息仍留在历史尾部', async () => {
    mockSendMessage.mockRejectedValueOnce(new Error('network offline'))
    mockGetMessages.mockResolvedValueOnce([
      {
        id: 101,
        seq: 101,
        conversation_id: 'conv-1',
        sender_id: 'user-2',
        content: '服务端历史 1',
        message_type: 1,
        reply_to_id: null,
        has_attachment: false,
        metadata: {},
        created_at: '2026-07-29T08:00:00Z',
      },
      {
        id: 102,
        seq: 102,
        conversation_id: 'conv-1',
        sender_id: 'user-2',
        content: '服务端历史 2',
        message_type: 1,
        reply_to_id: null,
        has_attachment: false,
        metadata: {},
        created_at: '2026-07-29T08:01:00Z',
      },
    ])
    useIMStore.setState({
      conversations: [
        buildConversation({ id: 'conv-1' }),
        buildConversation({ id: 'conv-2' }),
      ] as never,
      currentConversationId: 'conv-1',
      messages: { 'conv-1': [] } as never,
    })

    await useIMStore.getState().sendMessage({
      convId: 'conv-1',
      content: '断网期间发送的消息',
    })
    const failedMessage = useIMStore.getState().messages['conv-1'][0]
    expect(failedMessage).toEqual(expect.objectContaining({
      id: -1,
      _optimistic: true,
      _failed: true,
    }))

    // ChatView 切走再返回后会重拉最新历史；这里模拟恢复网络后的这次刷新。
    useIMStore.getState().setCurrentConversation('conv-2')
    useIMStore.getState().setCurrentConversation('conv-1')
    await useIMStore.getState().loadMessages('conv-1')

    const messages = useIMStore.getState().messages['conv-1']
    expect(messages.map((message) => message.id)).toEqual([101, 102, -1])
    expect(messages[messages.length - 1]).toEqual(expect.objectContaining({
      content: '断网期间发送的消息',
      _tempId: failedMessage._tempId,
      _optimistic: true,
      _failed: true,
    }))
  })

  it('失败消息原地重试，并稳定复用首次生成的两个消息身份', async () => {
    mockSendMessage
      .mockRejectedValueOnce(Object.assign(new Error('connection refused'), { code: 'ECONNREFUSED' }))
      .mockResolvedValueOnce({
        id: 201,
        seq: 11,
        conversation_id: 'conv-1',
        created_at: '2026-07-14T06:00:00Z',
      })
    useIMStore.setState({
      conversations: [buildConversation()] as never,
      messages: { 'conv-1': [] } as never,
    })

    await useIMStore.getState().sendMessage({ convId: 'conv-1', content: '请确认' })

    const failed = useIMStore.getState().messages['conv-1'][0]
    const clientRequestId = failed.metadata.client_request_id
    const messageRef = failed.metadata.message_ref
    expect(failed).toEqual(expect.objectContaining({ _failed: true, _optimistic: true }))
    expect(typeof clientRequestId).toBe('string')
    expect(typeof messageRef).toBe('string')
    expect(failed._tempId).toBe(messageRef)

    await useIMStore.getState().retryFailedMessage(failed)

    expect(mockSendMessage).toHaveBeenCalledTimes(2)
    expect(mockCreateClientRequestId).toHaveBeenCalledTimes(1)
    expect(mockCreateMessageRef).toHaveBeenCalledTimes(1)
    expect(mockSendMessage.mock.calls[0][4]).toEqual(expect.objectContaining({
      client_request_id: clientRequestId,
      message_ref: messageRef,
    }))
    expect(mockSendMessage.mock.calls[1][4]).toEqual(expect.objectContaining({
      client_request_id: clientRequestId,
      message_ref: messageRef,
    }))
    expect(useIMStore.getState().messages['conv-1']).toEqual([
      expect.objectContaining({
        id: 201,
        _optimistic: false,
        _failed: undefined,
        metadata: expect.objectContaining({
          client_request_id: clientRequestId,
          message_ref: messageRef,
        }),
      }),
    ])
  })

  it('同一失败消息快速重试两次时只发出一次请求', async () => {
    let resolveSend: ((value: { id: number; seq: number; conversation_id: string; created_at: string }) => void) | undefined
    mockSendMessage.mockReturnValue(new Promise((resolve) => { resolveSend = resolve }))
    const failed = {
      id: -1,
      conversation_id: 'conv-1',
      sender_id: 'user-1',
      content: 'retry me',
      message_type: 1,
      reply_to_id: null,
      has_attachment: false,
      metadata: {
        client_request_id: '_opt_request-1',
        message_ref: 'message-ref-1',
      },
      created_at: null,
      _optimistic: true,
      _failed: true,
      _tempId: 'message-ref-1',
    }
    useIMStore.setState({ messages: { 'conv-1': [failed] } as never })

    const firstRetry = useIMStore.getState().retryFailedMessage(failed as never)
    const secondRetry = useIMStore.getState().retryFailedMessage(failed as never)

    expect(useIMStore.getState().messages['conv-1'][0]).toEqual(expect.objectContaining({ _retrying: true }))
    await Promise.resolve()
    expect(mockSendMessage).toHaveBeenCalledTimes(1)

    resolveSend!({ id: 202, seq: 12, conversation_id: 'conv-1', created_at: '2026-07-14T06:00:00Z' })
    await Promise.all([firstRetry, secondRetry])
  })

  it('不为缺少稳定 message_ref 的失败消息发起重试', async () => {
    const failedWithoutKey = {
      id: -1,
      conversation_id: 'conv-1',
      sender_id: 'user-1',
      content: 'old message',
      message_type: 1,
      reply_to_id: null,
      has_attachment: false,
      metadata: { client_request_id: 'request-without-message-ref' },
      created_at: null,
      _optimistic: true,
      _failed: true,
      _tempId: '_opt_old',
    }
    useIMStore.setState({ messages: { 'conv-1': [failedWithoutKey] } as never })

    await useIMStore.getState().retryFailedMessage(failedWithoutKey as never)

    expect(mockSendMessage).not.toHaveBeenCalled()
  })
})

describe('useIMStore.sendMessage attachments', () => {
  it('图片发送成功后用真实 message id 触发附件可用性探测，避免自己发出的图片 broken', async () => {
    mockSendMessage.mockResolvedValue({
      id: 101,
      seq: 7,
      conversation_id: 'conv-1',
      created_at: '2026-07-14T05:20:00Z',
    })
    useIMStore.setState({
      conversations: [buildConversation()] as never,
      messages: { 'conv-1': [] } as never,
    })

    await useIMStore.getState().sendMessage({
      convId: 'conv-1',
      content: '',
      messageType: MESSAGE_TYPE_IMAGE,
      metadata: {
        file_id: 'file-img-1',
        file_name: 'photo.png',
        file_size: 2048,
        access_url: 'https://oss.example.com/photo.png',
      },
    })

    expect(mockEnsureAttachmentChecked).toHaveBeenCalledWith([
      expect.objectContaining({
        id: 101,
        conversation_id: 'conv-1',
        message_type: MESSAGE_TYPE_IMAGE,
        metadata: expect.objectContaining({
          file_id: 'file-img-1',
          file_name: 'photo.png',
        }),
        _optimistic: false,
      }),
    ])
  })

  it('本人发送文件时本地路径只留在客户端，不写入服务端 metadata', async () => {
    mockSendMessage.mockResolvedValue({
      id: 102,
      seq: 8,
      conversation_id: 'conv-1',
      created_at: '2026-07-14T05:25:00Z',
    })
    useIMStore.setState({
      conversations: [buildConversation()] as never,
      messages: { 'conv-1': [] } as never,
    })

    await useIMStore.getState().sendMessage({
      convId: 'conv-1',
      content: 'main_flow_bench_report.txt',
      messageType: MESSAGE_TYPE_FILE,
      metadata: {
        file_id: 'file-doc-1',
        file_name: 'main_flow_bench_report.txt',
        file_size: 12390,
        access_url: 'https://oss.example.com/main_flow_bench_report.txt',
        __client_local_path: '/Users/me/Downloads/main_flow_bench_report.txt',
      },
    })

    expect(mockSendMessage).toHaveBeenCalledWith(
      'conv-1',
      'main_flow_bench_report.txt',
      MESSAGE_TYPE_FILE,
      undefined,
      expect.not.objectContaining({
        __client_local_path: expect.anything(),
      }),
    )
    expect(mockMarkLocalFile).toHaveBeenCalledWith(
      expect.objectContaining({ id: 102, conversation_id: 'conv-1' }),
      '/Users/me/Downloads/main_flow_bench_report.txt',
      null,
    )
    expect(mockEnsureAttachmentChecked).not.toHaveBeenCalledWith([
      expect.objectContaining({ id: 102 }),
    ])
  })

  it('图片即使误带本地路径也继续触发附件探测，避免自己发图 broken', async () => {
    mockSendMessage.mockResolvedValue({
      id: 103,
      seq: 9,
      conversation_id: 'conv-1',
      created_at: '2026-07-14T05:30:00Z',
    })
    useIMStore.setState({
      conversations: [buildConversation()] as never,
      messages: { 'conv-1': [] } as never,
    })

    await useIMStore.getState().sendMessage({
      convId: 'conv-1',
      content: '',
      messageType: MESSAGE_TYPE_IMAGE,
      metadata: {
        file_id: 'file-img-2',
        file_name: 'photo.png',
        file_size: 2048,
        access_url: 'https://oss.example.com/photo.png',
        __client_local_path: '/Users/me/Pictures/photo.png',
      },
    })

    expect(mockSendMessage).toHaveBeenCalledWith(
      'conv-1',
      '',
      MESSAGE_TYPE_IMAGE,
      undefined,
      expect.not.objectContaining({
        __client_local_path: expect.anything(),
      }),
    )
    expect(mockMarkLocalFile).not.toHaveBeenCalledWith(
      103,
      expect.any(String),
      expect.anything(),
    )
    expect(mockEnsureAttachmentChecked).toHaveBeenCalledWith([
      expect.objectContaining({ id: 103, message_type: MESSAGE_TYPE_IMAGE }),
    ])
  })
})

describe('useIMStore organization isolation', () => {
  it('已被清理的会话收到实时尾部消息时，不写缓存也不弹系统通知', async () => {
    const { SystemNotification } = await import('@/services/systemNotification')

    useIMStore.getState().onRealtimeMessage('revoked-conv', {
      id: 1001,
      conversation_id: 'revoked-conv',
      sender_id: 'user-2',
      sender_type: 'user',
      content: '不应送达',
      message_type: 1,
      metadata: {},
      created_at: '2026-07-21T00:00:00Z',
    } as never)

    expect(useIMStore.getState().messages['revoked-conv']).toBeUndefined()
    expect(vi.mocked(SystemNotification.imMessage)).not.toHaveBeenCalled()
  })

  it('普通实时消息桌面通知优先显示发送人，而不是内部会话名', async () => {
    const { SystemNotification } = await import('@/services/systemNotification')
    useIMStore.setState({
      conversations: [buildConversation({
        id: 'conv-notification-sender',
        name: 'TabTin private conversation',
      })] as never,
    })

    useIMStore.getState().onRealtimeMessage('conv-notification-sender', {
      id: 1002,
      conversation_id: 'conv-notification-sender',
      sender_id: 'user-2',
      sender_name: 'Bob',
      sender_type: 'user',
      content: '你提报吧',
      message_type: 1,
      metadata: { message_ref: 'message-ref-notification' },
      created_at: '2026-08-04T10:00:00Z',
    } as never)

    await vi.waitFor(() =>
      expect(vi.mocked(SystemNotification.imMessage)).toHaveBeenCalledWith(
        expect.objectContaining({
          conversationId: 'conv-notification-sender',
          title: 'Bob',
          body: '你提报吧',
          messageRef: 'message-ref-notification',
        }),
      ),
    )
  })

  it('群聊实时消息桌面通知显示群聊名，正文带发送人', async () => {
    const { SystemNotification } = await import('@/services/systemNotification')
    useIMStore.setState({
      conversations: [buildConversation({
        id: 'group-notification-title',
        type: 2,
        name: '产品讨论群',
        dm_peer_user_id: null,
      })] as never,
    })

    useIMStore.getState().onRealtimeMessage('group-notification-title', {
      id: 1003,
      conversation_id: 'group-notification-title',
      sender_id: 'user-2',
      sender_name: 'Bob',
      sender_type: 'user',
      content: '大家看一下新方案',
      message_type: 1,
      metadata: {},
      created_at: '2026-08-05T10:00:00Z',
    } as never)

    await vi.waitFor(() =>
      expect(vi.mocked(SystemNotification.imMessage)).toHaveBeenCalledWith(
        expect.objectContaining({
          conversationId: 'group-notification-title',
          title: '产品讨论群',
          body: 'Bob: 大家看一下新方案',
        }),
      ),
    )
  })

  it('完整实时 upsert 会覆盖已有消息，但不会重复累计未读', () => {
    useIMStore.setState({
      conversations: [
        buildConversation({ id: 'conv-1', unread_count: 2 }),
      ] as never,
      messages: {
        'conv-1': [{
          id: 42,
          seq: 42,
          conversation_id: 'conv-1',
          sender_id: 'user-2',
          content: '旧内容',
          message_type: 1,
          reply_to_id: null,
          has_attachment: false,
          metadata: { message_ref: 'message-ref-42' },
          created_at: '2026-07-30T08:00:00.000Z',
        }],
      } as never,
      unreadCounts: { 'conv-1': 2 },
      totalUnread: 2,
    })

    useIMStore.getState().onRealtimeMessage('conv-1', {
      id: 42,
      seq: 42,
      conversation_id: 'conv-1',
      sender_id: 'user-2',
      content: '编辑后的内容',
      message_type: 1,
      reply_to_id: null,
      has_attachment: false,
      metadata: { message_ref: 'message-ref-42', revision: 2 },
      created_at: '2026-07-30T08:00:00.000Z',
      edited_at: '2026-07-30T08:05:00.000Z',
    })

    expect(useIMStore.getState().messages['conv-1']).toEqual([
      expect.objectContaining({
        id: 42,
        content: '编辑后的内容',
        edited_at: '2026-07-30T08:05:00.000Z',
        metadata: expect.objectContaining({ revision: 2 }),
      }),
    ])
    expect(useIMStore.getState().unreadCounts).toEqual({ 'conv-1': 2 })
    expect(useIMStore.getState().totalUnread).toBe(2)
  })

  it('腾讯表情控制消息先到时，按 message_ref 等待目标消息渲染', () => {
    useIMStore.setState({
      conversations: [buildConversation({ id: 'conv-1' })] as never,
      messages: { 'conv-1': [] },
    })

    useIMStore.getState().onReactionUpdated(
      'conv-1',
      'message-ref-42',
      '👍',
      'user-2',
      'add',
    )
    useIMStore.getState().onRealtimeMessage('conv-1', {
      id: 42,
      seq: 42,
      conversation_id: 'conv-1',
      sender_id: 'user-1',
      content: '目标消息',
      message_type: 1,
      reply_to_id: null,
      has_attachment: false,
      metadata: { message_ref: 'message-ref-42' },
      created_at: '2026-07-30T08:00:00.000Z',
    })

    expect(useIMStore.getState().messages['conv-1']).toEqual([
      expect.objectContaining({
        id: 42,
        reactions: { '👍': ['user-2'] },
      }),
    ])
  })

  it('腾讯原生表情快照保留精确计数，并幂等合并旧控制消息', () => {
    useIMStore.setState({
      conversations: [buildConversation({ id: 'conv-1' })] as never,
      messages: { 'conv-1': [{
        id: 42,
        seq: 42,
        conversation_id: 'conv-1',
        sender_id: 'user-1',
        content: '目标消息',
        message_type: 1,
        reply_to_id: null,
        has_attachment: false,
        metadata: { message_ref: 'message-ref-42' },
        created_at: '2026-07-30T08:00:00.000Z',
      }] as never },
    })

    useIMStore.getState().onReactionSnapshot(
      'conv-1',
      'message-ref-42',
      { 'tabtin:party:v1': ['provider-user-2', 'provider-user-3'] },
      { 'tabtin:party:v1': 12 },
    )
    useIMStore.getState().onReactionUpdated(
      'conv-1',
      'message-ref-42',
      'tabtin:party:v1',
      'user-2',
      'add',
      'remote',
    )

    expect(useIMStore.getState().messages['conv-1']).toEqual([
      expect.objectContaining({
        reactions: { 'tabtin:party:v1': ['provider-user-2', 'provider-user-3', 'user-2'] },
        reaction_counts: { 'tabtin:party:v1': 12 },
      }),
    ])
  })

  it('腾讯原生删除成功后立即递减计数，不等待后续快照', () => {
    useIMStore.setState({
      conversations: [buildConversation({ id: 'conv-1' })] as never,
      messages: { 'conv-1': [{
        id: 42,
        seq: 42,
        conversation_id: 'conv-1',
        sender_id: 'user-1',
        content: '目标消息',
        message_type: 1,
        reply_to_id: null,
        has_attachment: false,
        metadata: { message_ref: 'message-ref-42' },
        created_at: '2026-07-30T08:00:00.000Z',
      }] as never },
    })

    useIMStore.getState().onReactionSnapshot(
      'conv-1',
      'message-ref-42',
      { '👍': ['user-2'] },
      { '👍': 1 },
    )
    useIMStore.getState().onReactionUpdated(
      'conv-1',
      'message-ref-42',
      '👍',
      'user-2',
      'remove',
      'local',
    )

    expect(useIMStore.getState().messages['conv-1']).toEqual([
      expect.objectContaining({
        reactions: {},
        reaction_counts: {},
      }),
    ])
  })

  it('按数字 message_id 取消其中一个表情时，保留同条消息其它表情', () => {
    useIMStore.setState({
      conversations: [buildConversation({ id: 'conv-1' })] as never,
      messages: { 'conv-1': [{
        id: 50,
        seq: 50,
        conversation_id: 'conv-1',
        sender_id: 'user-1',
        content: '目标消息',
        message_type: 1,
        reply_to_id: null,
        has_attachment: false,
        metadata: { message_ref: '019f0000-0000-7000-8000-000000000042' },
        created_at: '2026-07-30T08:00:00.000Z',
      }] as never },
    })

    for (const emoji of ['🤝', '👌', '😮'] as const) {
      useIMStore.getState().onReactionUpdated(
        'conv-1',
        '019f0000-0000-7000-8000-000000000042',
        emoji,
        'user-1',
        'add',
      )
    }
    useIMStore.getState().onReactionUpdated(
      'conv-1',
      '50',
      '👌',
      'user-1',
      'remove',
      'remote',
    )

    expect(useIMStore.getState().messages['conv-1']).toEqual([
      expect.objectContaining({
        reactions: {
          '🤝': ['user-1'],
          '😮': ['user-1'],
        },
      }),
    ])
  })

  it('旧消息的已读回执更新不会倒退会话最新预览和时间', () => {
    const latestAt = '2026-07-30T08:01:00.000Z'
    useIMStore.setState({
      conversations: [
        buildConversation({
          id: 'conv-1',
          last_message_at: latestAt,
          last_message_preview: '最新消息',
        }),
      ] as never,
      messages: {
        'conv-1': [
          {
            id: 42,
            seq: 42,
            conversation_id: 'conv-1',
            sender_id: 'user-1',
            sender_type: 'user',
            content: '较早消息',
            message_type: 1,
            reply_to_id: null,
            has_attachment: false,
            metadata: { message_ref: 'message-ref-42' },
            created_at: '2026-07-30T08:00:00.000Z',
          },
          {
            id: 43,
            seq: 43,
            conversation_id: 'conv-1',
            sender_id: 'user-2',
            sender_type: 'user',
            content: '最新消息',
            message_type: 1,
            reply_to_id: null,
            has_attachment: false,
            metadata: { message_ref: 'message-ref-43' },
            created_at: latestAt,
          },
        ],
      } as never,
    })

    useIMStore.getState().onRealtimeMessage('conv-1', {
      id: 42,
      seq: 42,
      conversation_id: 'conv-1',
      sender_id: 'user-1',
      sender_type: 'user',
      content: '较早消息',
      message_type: 1,
      reply_to_id: null,
      has_attachment: false,
      metadata: { message_ref: 'message-ref-42' },
      read_receipt: { read_count: 1, recipient_count: 1 },
      created_at: '2026-07-30T08:00:00.000Z',
    }, { incrementUnread: false })

    expect(useIMStore.getState().messages['conv-1']).toEqual([
      expect.objectContaining({
        seq: 42,
        read_receipt: { read_count: 1, recipient_count: 1 },
      }),
      expect.objectContaining({ seq: 43, content: '最新消息' }),
    ])
    expect(useIMStore.getState().conversations[0]).toEqual(
      expect.objectContaining({
        last_message_at: latestAt,
        last_message_preview: '最新消息',
      }),
    )
  })

  it('腾讯消息等待绝对未读快照，默认实时消息仍保留增量语义', () => {
    useIMStore.setState({
      conversations: [
        buildConversation({ id: 'conv-1', unread_count: 2 }),
      ] as never,
      unreadCounts: { 'conv-1': 2 },
      totalUnread: 2,
    })

    useIMStore.getState().onRealtimeMessage(
      'conv-1',
      {
        id: 43,
        seq: 43,
        conversation_id: 'conv-1',
        sender_id: 'user-2',
        content: 'Tencent message',
        message_type: 1,
        reply_to_id: null,
        has_attachment: false,
        metadata: { message_ref: 'message-ref-43' },
        created_at: '2026-07-30T08:01:00.000Z',
      },
      { incrementUnread: false },
    )

    expect(useIMStore.getState().unreadCounts).toEqual({ 'conv-1': 2 })
    expect(useIMStore.getState().totalUnread).toBe(2)

    useIMStore.getState().applyUnreadSnapshot('ws-1', {
      total: 3,
      conversations: { 'conv-1': 3 },
    })
    useIMStore.getState().onRealtimeMessage(
      'conv-1',
      {
        id: 44,
        seq: 44,
        conversation_id: 'conv-1',
        sender_id: 'user-2',
        content: 'Tencent message after snapshot',
        message_type: 1,
        reply_to_id: null,
        has_attachment: false,
        metadata: { message_ref: 'message-ref-44' },
        created_at: '2026-07-30T08:02:00.000Z',
      },
      { incrementUnread: false },
    )

    expect(useIMStore.getState().unreadCounts).toEqual({ 'conv-1': 3 })
    expect(useIMStore.getState().totalUnread).toBe(3)

    useIMStore.getState().onRealtimeMessage('conv-1', {
      id: 45,
      seq: 45,
      conversation_id: 'conv-1',
      sender_id: 'user-2',
      content: 'legacy incremental message',
      message_type: 1,
      reply_to_id: null,
      has_attachment: false,
      metadata: { message_ref: 'message-ref-45' },
      created_at: '2026-07-30T08:03:00.000Z',
    })

    expect(useIMStore.getState().unreadCounts).toEqual({ 'conv-1': 4 })
    expect(useIMStore.getState().totalUnread).toBe(4)
  })

  it('实时回声按 message_ref 收敛乐观消息，并按 seq 放入最终位置', () => {
    useIMStore.setState({
      conversations: [buildConversation({ id: 'conv-1' })] as never,
      messages: {
        'conv-1': [
          {
            id: 60,
            seq: 20,
            conversation_id: 'conv-1',
            sender_id: 'user-2',
            content: 'later',
            message_type: 1,
            reply_to_id: null,
            has_attachment: false,
            metadata: {
              message_ref: 'message-ref-later',
              client_request_id: 'request-later',
            },
            created_at: '2026-07-30T08:02:00.000Z',
          },
          {
            id: -1,
            conversation_id: 'conv-1',
            sender_id: 'user-1',
            content: 'sending',
            message_type: 1,
            reply_to_id: null,
            has_attachment: false,
            metadata: {
              message_ref: 'message-ref-echo',
              client_request_id: 'request-echo',
            },
            created_at: '2026-07-30T08:01:00.000Z',
            _optimistic: true,
            _tempId: 'message-ref-echo',
          },
        ],
      } as never,
    })

    useIMStore.getState().onRealtimeMessage('conv-1', {
      id: 900,
      seq: 10,
      conversation_id: 'conv-1',
      sender_id: 'user-1',
      content: 'confirmed',
      message_type: 1,
      reply_to_id: null,
      has_attachment: false,
      metadata: {
        message_ref: 'message-ref-echo',
        client_request_id: 'request-echo',
      },
      created_at: '2026-07-30T08:01:01.000Z',
    })

    expect(useIMStore.getState().messages['conv-1']).toEqual([
      expect.objectContaining({
        id: 900,
        seq: 10,
        content: 'confirmed',
        _optimistic: false,
        _tempId: undefined,
      }),
      expect.objectContaining({ id: 60, seq: 20 }),
    ])
  })

  it('腾讯 reference 接管顺序时不覆盖已有流式正文', () => {
    const messageRef = '018f4b30-a7ad-7b32-b946-827ea2a26983'
    useIMStore.setState({
      conversations: [buildConversation({ id: 'conv-1' })] as never,
      messages: {
        'conv-1': [{
          id: 0,
          conversation_id: 'conv-1',
          sender_id: 'agent-1',
          sender_type: 'agent',
          content: 'partial response',
          message_type: 1,
          reply_to_id: null,
          has_attachment: false,
          metadata: { kind: 'agent_stream', message_ref: messageRef, stream_seq: 2 },
          created_at: '2026-07-31T00:00:00.000Z',
        }],
      } as never,
    })

    useIMStore.getState().onRealtimeMessage('conv-1', {
      id: 88,
      seq: 88,
      conversation_id: 'conv-1',
      sender_id: 'agent-1',
      sender_type: 'agent',
      content: '',
      message_type: 1,
      reply_to_id: null,
      has_attachment: false,
      metadata: {
        kind: 'tabtin_ref',
        message_ref: messageRef,
        tabtin_message_id: '9223372036854775807',
      },
      created_at: '2026-07-31T00:00:01.000Z',
    }, { incrementUnread: false })

    expect(useIMStore.getState().messages['conv-1']).toEqual([
      expect.objectContaining({
        id: 88,
        seq: 88,
        content: 'partial response',
      }),
    ])

    useIMStore.getState().onRealtimeMessage('conv-1', {
      id: 0,
      conversation_id: 'conv-1',
      sender_id: 'agent-1',
      sender_type: 'agent',
      content: 'final response',
      message_type: 1,
      reply_to_id: null,
      has_attachment: false,
      metadata: {
        kind: 'agent_final',
        message_ref: messageRef,
        tabtin_message_id: '9223372036854775807',
      },
      created_at: '2026-07-31T00:00:02.000Z',
    }, { incrementUnread: false })

    expect(useIMStore.getState().messages['conv-1']).toEqual([
      expect.objectContaining({
        id: 88,
        seq: 88,
        content: 'final response',
      }),
    ])
  })

  it('Agent 过程事件只更新过程消息，不改变会话预览、排序或未读数', async () => {
    const { SystemNotification } = await import('@/services/systemNotification')
    const stableTimestamp = '2026-07-30T08:00:00.000Z'
    useIMStore.setState({
      conversations: [
        buildConversation({
          id: 'conv-other',
          last_message_at: '2026-07-30T09:00:00.000Z',
          last_message_preview: '其他会话',
        }),
        buildConversation({
          id: 'conv-1',
          last_message_at: stableTimestamp,
          last_message_preview: '稳定预览',
          unread_count: 2,
        }),
      ] as never,
      messages: { 'conv-1': [] },
      unreadCounts: { 'conv-1': 2 },
      totalUnread: 2,
    })

    const progressMessage = {
      id: 77,
      seq: 77,
      conversation_id: 'conv-1',
      sender_id: 'agent-1',
      sender_type: 'agent',
      content: '正在检索资料',
      message_type: 1,
      metadata: {
        kind: 'agent_progress',
        agent_session_id: 'session-1',
        progress: 0.4,
      },
      created_at: '2026-07-30T10:00:00.000Z',
    }

    useIMStore.getState().onRealtimeMessage('conv-1', progressMessage as never)
    useIMStore.getState().onRealtimeMessage('conv-1', {
      ...progressMessage,
      content: '正在整理结果',
      metadata: { ...progressMessage.metadata, progress: 0.8 },
      created_at: '2026-07-30T10:01:00.000Z',
    } as never)

    const state = useIMStore.getState()
    expect(state.messages['conv-1']).toEqual([
      expect.objectContaining({ id: 77, content: '正在整理结果' }),
    ])
    expect(state.conversations.map((conversation) => conversation.id)).toEqual([
      'conv-other',
      'conv-1',
    ])
    expect(state.conversations.find((conversation) => conversation.id === 'conv-1')).toEqual(
      expect.objectContaining({
        last_message_at: stableTimestamp,
        last_message_preview: '稳定预览',
        unread_count: 2,
      }),
    )
    expect(state.unreadCounts).toEqual({ 'conv-1': 2 })
    expect(state.totalUnread).toBe(2)
    expect(vi.mocked(SystemNotification.imMessage)).not.toHaveBeenCalled()
  })
})

describe('useIMStore.onUnreadUpdate 桌面通知（TC-4）', () => {
  it('不同 organization 的 unread.update 会分别补拉，不会互相取消 debounce', async () => {
    vi.useFakeTimers()
    mockListConversations.mockResolvedValue([])
    mockGetUnreadCount.mockResolvedValue({ total: 0, conversations: {} })

    try {
      useIMStore.getState().onUnreadUpdate('conv-org-1', {
        senderId: 'user-2',
        preview: 'org1 新消息',
        organizationId: 'ws-1',
      })
      useIMStore.getState().onUnreadUpdate('conv-org-2', {
        senderId: 'user-3',
        preview: 'org2 新消息',
        organizationId: 'ws-2',
      })

      vi.advanceTimersByTime(2000)
      await Promise.resolve()

      expect(mockListConversations).toHaveBeenCalledWith('ws-1')
      expect(mockListConversations).toHaveBeenCalledWith('ws-2')
    } finally {
      vi.useRealTimers()
    }
  })

  it('resetIMState 会清理待触发的 unread 补拉 timer', async () => {
    vi.useFakeTimers()
    mockListConversations.mockResolvedValue([])
    mockGetUnreadCount.mockResolvedValue({ total: 0, conversations: {} })

    try {
      useIMStore.getState().onUnreadUpdate('conv-org-1', {
        senderId: 'user-2',
        preview: 'org1 新消息',
        organizationId: 'ws-1',
      })

      useIMStore.getState().resetIMState()
      vi.advanceTimersByTime(2000)
      await Promise.resolve()

      expect(mockListConversations).not.toHaveBeenCalled()
      expect(mockGetUnreadCount).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('非当前会话收到带 preview 的 unread.update → 弹桌面通知', async () => {
    const { SystemNotification } = await import('@/services/systemNotification')
    useIMStore.setState({ conversations: [buildConversation()] as never })

    useIMStore.getState().onUnreadUpdate('conv-1', {
      senderId: 'user-2',
      senderName: 'Bob',
      preview: '你好呀',
      organizationId: 'ws-1',
    })

    await vi.waitFor(() =>
      expect(vi.mocked(SystemNotification.imMessage)).toHaveBeenCalledWith(
        expect.objectContaining({
          conversationId: 'conv-1',
          body: '你好呀',
          organizationId: 'ws-1',
          title: 'Bob',
        }),
      ),
    )
    expect(useIMStore.getState().unreadCounts).toMatchObject({ 'conv-1': 1 })
    expect(useIMStore.getState().conversations[0]).toMatchObject({
      id: 'conv-1',
      unread_count: 1,
      last_message_preview: '你好呀',
    })
  })

  it('群聊的 unread.update 桌面通知显示群聊名', async () => {
    const { SystemNotification } = await import('@/services/systemNotification')
    useIMStore.setState({
      conversations: [buildConversation({
        id: 'group-1',
        type: 2,
        name: '产品讨论群',
        dm_peer_user_id: null,
      })] as never,
    })

    useIMStore.getState().onUnreadUpdate('group-1', {
      senderId: 'user-2',
      senderName: 'Bob',
      preview: 'Bob: 大家看一下新方案',
      organizationId: 'ws-1',
    })

    await vi.waitFor(() =>
      expect(vi.mocked(SystemNotification.imMessage)).toHaveBeenCalledWith(
        expect.objectContaining({
          conversationId: 'group-1',
          title: '产品讨论群',
          body: 'Bob: 大家看一下新方案',
        }),
      ),
    )
  })

  it('群聊 unread preview 无发送人前缀时由通知层补上 ', async () => {
    const { SystemNotification } = await import('@/services/systemNotification')
    useIMStore.setState({
      conversations: [buildConversation({
        id: 'group-2',
        type: 2,
        name: '改改群名',
        dm_peer_user_id: null,
      })] as never,
    })

    useIMStore.getState().onUnreadUpdate('group-2', {
      senderId: 'user-2',
      senderName: 'Alice',
      preview: '121',
      organizationId: 'ws-1',
    })

    await vi.waitFor(() =>
      expect(vi.mocked(SystemNotification.imMessage)).toHaveBeenCalledWith(
        expect.objectContaining({
          conversationId: 'group-2',
          title: '改改群名',
          body: 'Alice: 121',
        }),
      ),
    )
  })

  it('当前会话的 unread.update 不弹通知（与 onRealtimeMessage 去重）', async () => {
    const { SystemNotification } = await import('@/services/systemNotification')
    mockSelectionState.selectedSpaceKind = 'dm'
    mockMainNavTab.value = 'im'
    useIMStore.setState({
      conversations: [buildConversation()] as never,
      currentConversationId: 'conv-1',
      isIMActive: true,
    })

    useIMStore.getState().onUnreadUpdate('conv-1', {
      senderId: 'user-2',
      senderName: 'Bob',
      preview: '你好',
      organizationId: 'ws-1',
    })

    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(vi.mocked(SystemNotification.imMessage)).not.toHaveBeenCalled()
  })

  it('当前会话先收到 unread.update 再收到消息时按最新序号补报已读', async () => {
    const tabchatApi = await import('@/services/tabchatApi')
    mockSelectionState.selectedSpaceId = 'dm:conv-1'
    mockSelectionState.selectedSpaceKind = 'dm'
    mockMainNavTab.value = 'im'
    useIMStore.setState({
      conversations: [buildConversation()] as never,
      currentConversationId: 'conv-1',
      isIMActive: true,
      messages: {
        'conv-1': [{
          id: 1,
          seq: 1,
          conversation_id: 'conv-1',
          sender_id: 'user-2',
          content: '旧消息',
          message_type: 1,
          reply_to_id: null,
          has_attachment: false,
          metadata: {},
          transport: {
            kind: 'c2c',
            sequence: 1,
            sent_at: '2026-08-05T09:00:00Z',
          },
          created_at: '2026-08-05T09:00:00Z',
        }],
      } as never,
    })

    useIMStore.getState().onUnreadUpdate('conv-1', {
      senderId: 'user-2',
      senderName: 'Bob',
      preview: '新消息',
      organizationId: 'ws-1',
    })
    await vi.waitFor(() => expect(tabchatApi.markRead).toHaveBeenCalledWith('conv-1', {
      kind: 'c2c',
      sequence: 1,
      sent_at: '2026-08-05T09:00:00Z',
    }))

    useIMStore.getState().onRealtimeMessage('conv-1', {
      id: 2,
      seq: 2,
      conversation_id: 'conv-1',
      sender_id: 'user-2',
      content: '新消息',
      message_type: 1,
      reply_to_id: null,
      has_attachment: false,
      metadata: {},
      transport: {
        kind: 'c2c',
        sequence: 2,
        sent_at: '2026-08-05T09:01:00Z',
      },
      created_at: '2026-08-05T09:01:00Z',
    })

    await vi.waitFor(() => expect(tabchatApi.markRead).toHaveBeenCalledWith('conv-1', {
      kind: 'c2c',
      sequence: 2,
      sent_at: '2026-08-05T09:01:00Z',
    }))
  })

  it('当前会话的 AI 流式占位取得腾讯序号后补报已读', async () => {
    const tabchatApi = await import('@/services/tabchatApi')
    const messageRef = 'agent-message-ref'
    mockSelectionState.selectedSpaceId = 'im-group:conv-1'
    mockSelectionState.selectedSpaceKind = 'im-group'
    mockMainNavTab.value = 'im'
    useIMStore.setState({
      conversations: [buildConversation({ type: 2 })] as never,
      currentConversationId: 'conv-1',
      isIMActive: true,
      messages: {
        'conv-1': [{
          id: 0,
          conversation_id: 'conv-1',
          sender_id: 'agent-1',
          sender_type: 'agent',
          content: 'AI 回复',
          message_type: 1,
          reply_to_id: null,
          has_attachment: false,
          metadata: { kind: 'agent_final', message_ref: messageRef },
          created_at: '2026-08-07T08:40:20Z',
        }],
      } as never,
    })

    useIMStore.getState().onRealtimeMessage('conv-1', {
      id: 18,
      seq: 18,
      conversation_id: 'conv-1',
      sender_id: 'agent-1',
      sender_type: 'agent',
      content: 'AI 回复',
      message_type: 1,
      reply_to_id: null,
      has_attachment: false,
      metadata: { kind: 'agent_final', message_ref: messageRef },
      transport: { kind: 'group', sequence: 18 },
      created_at: '2026-08-07T08:40:20Z',
    })

    await vi.waitFor(() => expect(tabchatApi.markRead).toHaveBeenCalledWith('conv-1', {
      kind: 'group',
      sequence: 18,
    }))
  })

  it('切到 workspace Space 后即使 IM 态残留，unread.update 仍弹桌面通知', async () => {
    const { SystemNotification } = await import('@/services/systemNotification')
    const tabchatApi = await import('@/services/tabchatApi')
    // 模拟：侧栏已选 workspace，但 currentConversationId / isIMActive 未清干净
    mockSelectionState.selectedSpaceId = 'workspace:space-1'
    mockSelectionState.selectedSpaceKind = 'workspace'
    mockMainNavTab.value = 'agent'
    useIMStore.setState({
      conversations: [buildConversation({ unread_count: 0 })] as never,
      currentConversationId: 'conv-1',
      isIMActive: true,
      unreadCounts: {},
      totalUnread: 0,
    })

    useIMStore.getState().onUnreadUpdate('conv-1', {
      senderId: 'user-2',
      senderName: 'Bob',
      preview: '离开会话后的新消息',
      organizationId: 'ws-1',
    })

    await vi.waitFor(() => expect(vi.mocked(SystemNotification.imMessage)).toHaveBeenCalled())
    expect(tabchatApi.markRead).not.toHaveBeenCalled()
    expect(useIMStore.getState().unreadCounts).toMatchObject({ 'conv-1': 1 })
  })

  it('workspace 选中时即使仍停在消息 tab + isIMActive，也不抑制通知', async () => {
    const { SystemNotification } = await import('@/services/systemNotification')
    mockSelectionState.selectedSpaceId = 'workspace:space-1'
    mockSelectionState.selectedSpaceKind = 'workspace'
    mockMainNavTab.value = 'im'
    useIMStore.setState({
      conversations: [buildConversation()] as never,
      currentConversationId: 'conv-1',
      isIMActive: true,
    })

    useIMStore.getState().onUnreadUpdate('conv-1', {
      senderId: 'user-2',
      senderName: 'Bob',
      preview: '消息 tab 残留',
      organizationId: 'ws-1',
    })

    await vi.waitFor(() => expect(vi.mocked(SystemNotification.imMessage)).toHaveBeenCalled())
  })

  it('当前会话即使不在 IM tab 激活态，也会清未读而不是累计角标', async () => {
    const { SystemNotification } = await import('@/services/systemNotification')
    const tabchatApi = await import('@/services/tabchatApi')
    mockSelectionState.selectedSpaceId = 'dm:conv-1'
    mockSelectionState.selectedSpaceKind = 'dm'
    useIMStore.setState({
      conversations: [buildConversation({ unread_count: 8 })] as never,
      currentConversationId: 'conv-1',
      isIMActive: false,
      unreadCounts: { 'conv-1': 8 },
      totalUnread: 8,
    })

    useIMStore.getState().onUnreadUpdate('conv-1', {
      senderId: 'user-2',
      senderName: 'Bob',
      preview: '还在当前会话里',
      organizationId: 'ws-1',
    })

    await vi.waitFor(() => expect(tabchatApi.markRead).toHaveBeenCalledWith('conv-1', undefined))
    expect(vi.mocked(SystemNotification.imMessage)).not.toHaveBeenCalled()
    expect(useIMStore.getState().unreadCounts).not.toHaveProperty('conv-1')
  })

  it('窗口失焦但页面仍可见时，当前会话收到消息立即上报已读', async () => {
    const { SystemNotification } = await import('@/services/systemNotification')
    const tabchatApi = await import('@/services/tabchatApi')
    vi.mocked(document.hasFocus).mockReturnValue(false)
    mockSelectionState.selectedSpaceId = 'dm:conv-1'
    mockSelectionState.selectedSpaceKind = 'dm'
    useIMStore.setState({
      conversations: [buildConversation({ unread_count: 8 })] as never,
      currentConversationId: 'conv-1',
      isIMActive: true,
      unreadCounts: { 'conv-1': 8 },
      totalUnread: 8,
    })

    useIMStore.getState().onUnreadUpdate('conv-1', {
      senderId: 'user-2',
      senderName: 'Bob',
      preview: '后台窗口的新消息',
      organizationId: 'ws-1',
    })

    await vi.waitFor(() => expect(tabchatApi.markRead).toHaveBeenCalledWith('conv-1', undefined))
    expect(vi.mocked(SystemNotification.imMessage)).not.toHaveBeenCalled()
    expect(useIMStore.getState().unreadCounts).not.toHaveProperty('conv-1')
  })

  it('页面隐藏时，当前会话收到消息仍保留未读角标', async () => {
    const { SystemNotification } = await import('@/services/systemNotification')
    const tabchatApi = await import('@/services/tabchatApi')
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    mockSelectionState.selectedSpaceId = 'dm:conv-1'
    mockSelectionState.selectedSpaceKind = 'dm'
    useIMStore.setState({
      conversations: [buildConversation({ unread_count: 8 })] as never,
      currentConversationId: 'conv-1',
      isIMActive: true,
      unreadCounts: { 'conv-1': 8 },
      totalUnread: 8,
    })

    useIMStore.getState().onUnreadUpdate('conv-1', {
      senderId: 'user-2',
      senderName: 'Bob',
      preview: '隐藏窗口的新消息',
      organizationId: 'ws-1',
    })

    await vi.waitFor(() => expect(vi.mocked(SystemNotification.imMessage)).toHaveBeenCalled())
    expect(tabchatApi.markRead).not.toHaveBeenCalled()
    expect(useIMStore.getState().unreadCounts).toMatchObject({ 'conv-1': 9 })
  })

  it('设置页隐藏当前会话时，不会误清已读', async () => {
    const { SystemNotification } = await import('@/services/systemNotification')
    const tabchatApi = await import('@/services/tabchatApi')
    mockMainNavTab.value = 'me'
    mockSelectionState.selectedSpaceId = 'dm:conv-1'
    mockSelectionState.selectedSpaceKind = 'dm'
    useIMStore.setState({
      conversations: [buildConversation({ unread_count: 8 })] as never,
      currentConversationId: 'conv-1',
      isIMActive: false,
      unreadCounts: { 'conv-1': 8 },
      totalUnread: 8,
    })

    useIMStore.getState().onUnreadUpdate('conv-1', {
      senderId: 'user-2',
      senderName: 'Bob',
      preview: '设置页期间的新消息',
      organizationId: 'ws-1',
    })

    await vi.waitFor(() => expect(vi.mocked(SystemNotification.imMessage)).toHaveBeenCalled())
    expect(tabchatApi.markRead).not.toHaveBeenCalled()
    expect(useIMStore.getState().unreadCounts).toMatchObject({ 'conv-1': 9 })
  })
})

describe('useIMStore markAsRead', () => {
  function buildMessage(overrides: Record<string, unknown> = {}) {
    return {
      id: 10,
      conversation_id: 'conv-1',
      sender_id: 'user-2',
      content: 'hi',
      message_type: 1,
      reply_to_id: null,
      has_attachment: false,
      metadata: {},
      transport: { kind: 'group', sequence: 10 },
      created_at: '2026-07-22T12:00:00Z',
      ...overrides,
    }
  }

  it('末尾是乐观消息时不传 id=-1，改为传最近已确认消息 id', async () => {
    const tabchatApi = await import('@/services/tabchatApi')
    vi.mocked(tabchatApi.markRead).mockResolvedValue({ marked_count: 0 })

    useIMStore.setState({
      conversations: [buildConversation({ unread_count: 2 })] as never,
      unreadCounts: { 'conv-1': 2 },
      totalUnread: 2,
      messages: {
        'conv-1': [
          buildMessage({
            id: 42,
            content: 'confirmed',
            transport: { kind: 'group', sequence: 42 },
          }),
          buildMessage({
            id: -1,
            sender_id: 'user-1',
            content: 'sending…',
            _optimistic: true,
            _tempId: '_opt_1',
          }),
        ] as never,
      },
    })

    await useIMStore.getState().markAsRead('conv-1')

    expect(tabchatApi.markRead).toHaveBeenCalledWith('conv-1', {
      kind: 'group',
      sequence: 42,
    })
    expect(useIMStore.getState().loadError).toBeNull()
    expect(useIMStore.getState().unreadCounts).not.toHaveProperty('conv-1')
  })

  it('只有乐观消息时传 undefined，让后端推进到会话最新 seq', async () => {
    const tabchatApi = await import('@/services/tabchatApi')
    vi.mocked(tabchatApi.markRead).mockResolvedValue({ marked_count: 0 })

    useIMStore.setState({
      conversations: [buildConversation()] as never,
      messages: {
        'conv-1': [
          buildMessage({
            id: -1,
            sender_id: 'user-1',
            _optimistic: true,
            _tempId: '_opt_only',
          }),
        ] as never,
      },
    })

    await useIMStore.getState().markAsRead('conv-1')

    expect(tabchatApi.markRead).toHaveBeenCalledWith('conv-1', undefined)
  })
})

describe('useIMStore notifications', () => {
  it('muted 会话不弹通知', async () => {
    const { SystemNotification } = await import('@/services/systemNotification')
    useIMStore.setState({
      conversations: [buildConversation({ is_muted: true })] as never,
    })

    useIMStore.getState().onUnreadUpdate('conv-1', {
      senderId: 'user-2',
      preview: '在吗',
      organizationId: 'ws-1',
    })

    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(vi.mocked(SystemNotification.imMessage)).not.toHaveBeenCalled()
  })

  it('无 preview（如 mark_read 推送）不弹通知', async () => {
    const { SystemNotification } = await import('@/services/systemNotification')
    useIMStore.setState({ conversations: [buildConversation()] as never })

    useIMStore.getState().onUnreadUpdate('conv-1')

    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(vi.mocked(SystemNotification.imMessage)).not.toHaveBeenCalled()
  })

  it('发送者是自己时不弹通知', async () => {
    const { SystemNotification } = await import('@/services/systemNotification')
    useIMStore.setState({ conversations: [buildConversation()] as never })

    useIMStore.getState().onUnreadUpdate('conv-1', {
      senderId: 'user-1',
      preview: '自己发的',
      organizationId: 'ws-1',
    })

    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(vi.mocked(SystemNotification.imMessage)).not.toHaveBeenCalled()
  })
})

describe('useIMStore sessionShareDetailVersions ', () => {
  it('详情接口只写入 IM Store 的唯一 SessionShare 对象', async () => {
    mockGetSessionShare.mockResolvedValue({
      id: 'share-1',
      session_id: 'session-1',
      session_title: '测试执行',
      owner_user_id: 'user-1',
      grantee_user_id: 'user-2',
      can_fork: false,
      can_chat: false,
      status: 'active',
      forked_session_id: null,
      created_at: '2026-08-06T00:00:00Z',
      revoked_at: null,
    })
    useIMStore.getState().denySessionShareAccess('share-1')

    await useIMStore.getState().loadSessionShare('share-1')

    expect(useIMStore.getState().sessionShares['share-1']).toEqual({
      detail: expect.objectContaining({
        id: 'share-1',
        session_id: 'session-1',
        status: 'active',
      }),
      loadState: 'loaded',
      detailLoaded: true,
      accessDenied: false,
    })
  })

  it('腾讯撤销事件插入详情请求期间时，旧 active 响应不能覆盖 revoked', async () => {
    let resolveFirst!: (share: Record<string, unknown>) => void
    const activeResponse = {
      id: 'share-race',
      session_id: 'session-1',
      session_title: '测试执行',
      owner_user_id: 'user-1',
      grantee_user_id: 'user-2',
      can_fork: false,
      can_chat: false,
      status: 'active',
      forked_session_id: null,
      created_at: '2026-08-06T00:00:00Z',
      revoked_at: null,
    }
    mockGetSessionShare
      .mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve }))
      .mockResolvedValueOnce({
        ...activeResponse,
        status: 'revoked',
        revoked_at: '2026-08-06T10:00:00Z',
      })

    const loading = useIMStore.getState().loadSessionShare('share-race')
    useIMStore.getState().patchSessionShare('share-race', { status: 'revoked' })
    useIMStore.getState().bumpSessionShareDetailVersion('share-race')
    resolveFirst(activeResponse)
    await loading

    expect(mockGetSessionShare).toHaveBeenCalledTimes(2)
    expect(useIMStore.getState().sessionShares['share-race']).toEqual(expect.objectContaining({
      detail: expect.objectContaining({ status: 'revoked' }),
      detailLoaded: true,
      accessDenied: false,
    }))
  })

  it('bumpSessionShareDetailVersion 按 shareId 递增', () => {
    useIMStore.getState().bumpSessionShareDetailVersion('share-1')
    useIMStore.getState().bumpSessionShareDetailVersion('share-1')
    useIMStore.getState().bumpSessionShareDetailVersion('share-2')
    expect(useIMStore.getState().sessionShareDetailVersions['share-1']).toBe(2)
    expect(useIMStore.getState().sessionShareDetailVersions['share-2']).toBe(1)
  })

  it('reconcileSessionShareStatus 同步全部重复卡并 bump 详情版本与列表版本', () => {
    useIMStore.setState({
      messages: {
        'conv-1': [
          {
            id: 1,
            conversation_id: 'conv-1',
            metadata: {
              card: { type: 'session_share', share_id: 'share-1', status: 'active' },
            },
          },
          {
            id: 2,
            conversation_id: 'conv-1',
            metadata: {
              card: { type: 'session_share', share_id: 'share-1', status: 'active' },
            },
          },
        ] as never,
      },
      sessionShareListVersions: {},
      sessionShareDetailVersions: {},
    })

    useIMStore.getState().reconcileSessionShareStatus({
      share_id: 'share-1',
      conversation_id: 'conv-1',
      status: 'revoked',
    })

    const state = useIMStore.getState()
    expect(state.sessionShareDetailVersions['share-1']).toBe(1)
    expect(state.sessionShareListVersions['conv-1']).toBe(1)
    expect(state.sessionShares['share-1']?.detail?.status).toBe('revoked')
    expect(state.messages['conv-1']).toHaveLength(2)
    expect(state.messages['conv-1'].every(
      (message) => message.metadata?.card?.status === 'revoked',
    )).toBe(true)
  })

  it('并发详情加载通过 singleflight 合并为一次批量请求', async () => {
    mockBatchGetSessionShareV2.mockResolvedValue([
      {
        object_id: 'share-1',
        ok: true,
        detail: {
          id: 'share-1',
          object_id: 'share-1',
          session_id: 'session-1',
          status: 'active',
          version: 3,
        },
      },
      {
        object_id: 'share-2',
        ok: true,
        detail: {
          id: 'share-2',
          object_id: 'share-2',
          session_id: 'session-2',
          status: 'revoked',
          version: 2,
        },
      },
    ])

    const loads = [
      useIMStore.getState().loadSessionShareV2('share-1', 1),
      useIMStore.getState().loadSessionShareV2('share-2', 2),
      useIMStore.getState().loadSessionShareV2('share-1', 3),
    ]

    await Promise.all(loads)

    expect(mockBatchGetSessionShareV2).toHaveBeenCalledTimes(1)
    expect(mockBatchGetSessionShareV2).toHaveBeenCalledWith(['share-1', 'share-2'])
    expect(useIMStore.getState().sessionShares['share-1']?.detail?.version).toBe(3)
    expect(useIMStore.getState().sessionShares['share-2']?.detail?.status).toBe('revoked')
  })

  it('singleflight 按接口上限拆分超过一百张卡', async () => {
    mockBatchGetSessionShareV2.mockImplementation(async (objectIds: string[]) => (
      objectIds.map((objectId) => ({
        object_id: objectId,
        ok: true,
        detail: {
          id: objectId,
          object_id: objectId,
          session_id: `session-${objectId}`,
          status: 'active',
          version: 1,
        },
      }))
    ))

    await Promise.all(Array.from({ length: 101 }, (_, index) => (
      useIMStore.getState().loadSessionShareV2(`share-${index}`, 1)
    )))

    expect(mockBatchGetSessionShareV2).toHaveBeenCalledTimes(2)
    expect(mockBatchGetSessionShareV2.mock.calls.map(([ids]) => ids.length)).toEqual([100, 1])
  })

  it('批量请求命中 429 后按 retryAfter 在同一 singleflight 中重试', async () => {
    vi.useFakeTimers()
    try {
      mockBatchGetSessionShareV2
        .mockRejectedValueOnce({ status: 429, retryAfter: 2 })
        .mockResolvedValueOnce([
          {
            object_id: 'share-1',
            ok: true,
            detail: {
              id: 'share-1',
              object_id: 'share-1',
              session_id: 'session-1',
              status: 'revoked',
              version: 4,
            },
          },
        ])

      const loading = useIMStore.getState().loadSessionShareV2('share-1', 4)
      await vi.runAllTimersAsync()
      await loading

      expect(mockBatchGetSessionShareV2).toHaveBeenCalledTimes(2)
      expect(useIMStore.getState().sessionShares['share-1']?.detail?.status).toBe('revoked')
    } finally {
      vi.useRealTimers()
    }
  })

  it('混合重试次数时将耗尽重试的卡标记为失败', async () => {
    vi.useFakeTimers()
    try {
      mockBatchGetSessionShareV2
        .mockRejectedValueOnce({ status: 429, retryAfter: 1 })
        .mockRejectedValueOnce({ status: 429, retryAfter: 1 })
        .mockRejectedValueOnce({ status: 429, retryAfter: 1 })
        .mockResolvedValueOnce([{
          object_id: 'share-2',
          ok: true,
          detail: {
            id: 'share-2',
            object_id: 'share-2',
            session_id: 'session-2',
            status: 'active',
            version: 1,
          },
        }])
      useIMStore.setState({
        sessionShares: {
          'share-1': {
            detail: { id: 'share-1', status: 'active', version: 1 },
            loadState: 'loaded',
            detailLoaded: true,
            accessDenied: false,
          },
        },
      })

      const exhaustedLoad = useIMStore.getState().loadSessionShareV2('share-1', 1)
      await vi.advanceTimersByTimeAsync(0)
      expect(mockBatchGetSessionShareV2).toHaveBeenCalledTimes(1)
      const laterLoad = useIMStore.getState().loadSessionShareV2('share-2', 1)
      await vi.runAllTimersAsync()

      await expect(exhaustedLoad).resolves.toBeNull()
      await expect(laterLoad).resolves.toEqual(expect.objectContaining({ id: 'share-2' }))
      expect(useIMStore.getState().sessionShares['share-1']?.loadState).toBe('error')
      expect(mockBatchGetSessionShareV2).toHaveBeenCalledTimes(4)
    } finally {
      vi.useRealTimers()
    }
  })

  it('同卡重复加载复用已经在途的批量请求', async () => {
    let resolveBatch!: (items: Array<Record<string, unknown>>) => void
    mockBatchGetSessionShareV2.mockImplementationOnce(
      () => new Promise((resolve) => { resolveBatch = resolve }),
    )

    const firstLoad = useIMStore.getState().loadSessionShareV2('share-1', 5)
    await vi.waitFor(() => expect(mockBatchGetSessionShareV2).toHaveBeenCalledTimes(1))
    const repeatedLoad = useIMStore.getState().loadSessionShareV2('share-1', 5)
    resolveBatch([
      {
        object_id: 'share-1',
        ok: true,
        detail: {
          id: 'share-1',
          object_id: 'share-1',
          session_id: 'session-1',
          status: 'active',
          version: 5,
        },
      },
    ])

    await Promise.all([firstLoad, repeatedLoad])

    expect(mockBatchGetSessionShareV2).toHaveBeenCalledTimes(1)
    expect(useIMStore.getState().sessionShares['share-1']?.detail?.version).toBe(5)
  })

  it('批次收尾时入队的新卡不会滞留在 loading', async () => {
    let resolveFirst!: (items: Array<Record<string, unknown>>) => void
    mockBatchGetSessionShareV2
      .mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve }))
      .mockResolvedValueOnce([{
        object_id: 'share-2',
        ok: true,
        detail: {
          id: 'share-2',
          object_id: 'share-2',
          session_id: 'session-2',
          status: 'active',
          version: 1,
        },
      }])

    const firstLoad = useIMStore.getState().loadSessionShareV2('share-1', 1)
    await vi.waitFor(() => expect(mockBatchGetSessionShareV2).toHaveBeenCalledTimes(1))
    resolveFirst([{
      object_id: 'share-1',
      ok: true,
      detail: {
        id: 'share-1',
        object_id: 'share-1',
        session_id: 'session-1',
        status: 'active',
        version: 1,
      },
    }])
    const trailingLoad = Promise.resolve().then(() => (
      useIMStore.getState().loadSessionShareV2('share-2', 1)
    ))

    await Promise.all([firstLoad, trailingLoad])

    expect(mockBatchGetSessionShareV2).toHaveBeenCalledTimes(2)
    expect(useIMStore.getState().sessionShares['share-2']?.loadState).toBe('loaded')
  })

})
