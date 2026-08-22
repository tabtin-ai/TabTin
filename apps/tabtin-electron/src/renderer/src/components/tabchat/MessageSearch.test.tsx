import React from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CONVERSATION_TYPE_DM, CONVERSATION_TYPE_GROUP, MESSAGE_TYPE_TEXT } from '@/constants/tabchat'

const {
  mockGetConversation,
  mockNavigateToMessage,
  mockOrganizationId,
  mockSearchGroups,
  mockSearchMessages,
  mockSelectSpaceById,
  mockToast,
} = vi.hoisted(() => ({
  mockGetConversation: vi.fn(),
  mockNavigateToMessage: vi.fn(),
  mockOrganizationId: { value: 'org-1' },
  mockSearchGroups: vi.fn(),
  mockSearchMessages: vi.fn(),
  mockSelectSpaceById: vi.fn(),
  mockToast: vi.fn(),
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key,
  }),
}))
vi.mock('@tabtin/smartsheet-ui', () => ({ toast: mockToast }))
vi.mock('@/services/tabchatApi', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/tabchatApi')>()
  return {
    ...actual,
    searchMessageGroups: mockSearchGroups,
    searchMessages: mockSearchMessages,
    getConversation: mockGetConversation,
  }
})
vi.mock('@stores/useIMStore', () => {
  const conversations = [
    {
      id: 'dm-1',
      organization_id: 'org-1',
      type: CONVERSATION_TYPE_DM,
      name: 'TabTin private conversation',
      avatar_url: 'https://example.invalid/transport-avatar.png',
      dm_peer_user_id: 'user-1',
    },
    { id: 'group-1', organization_id: 'org-1', type: CONVERSATION_TYPE_GROUP, name: '产品群', avatar_url: '' },
  ]
  const useIMStore = Object.assign(
    (selector: (state: { conversations: typeof conversations; navigateToMessage: () => void }) => unknown) =>
      selector({ conversations, navigateToMessage: mockNavigateToMessage }),
    { setState: vi.fn() },
  )
  return { useIMStore }
})
vi.mock('@stores/useSpaceListStore', () => ({
  useSpaceListStore: (selector: (state: { selectSpaceById: () => void }) => unknown) =>
    selector({ selectSpaceById: mockSelectSpaceById }),
}))
vi.mock('@stores/useOrganizationStore', () => ({
  useOrganizationStore: {
    getState: () => ({
      selectedOrganization: mockOrganizationId.value ? { id: mockOrganizationId.value } : null,
    }),
  },
}))
vi.mock('@stores/useUserProfileCache', () => ({
  useUserProfileCache: (selector: (state: {
    ensureProfiles: () => void
    profiles: Record<string, { nickname: string; username: string; avatar: string }>
  }) => unknown) => selector({
    ensureProfiles: vi.fn(),
    profiles: {
      'user-1': { nickname: '小叶', username: 'xiaoye', avatar: 'https://example.invalid/xiaoye.png' },
    },
  }),
  useDisplayNames: () => ({ 'user-1': '小叶' }),
}))
vi.mock('@tabtin/app-shell', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tabtin/app-shell')>()
  return { ...actual, getConversationNavigationKind: () => 'dm' }
})
vi.mock('@/lib/dateUtils', () => ({ formatConversationTime: (value: string | null) => value ?? '' }))
vi.mock('@/lib/imFormat', () => ({ sortConversations: (items: unknown[]) => items }))
vi.mock('@components/common/ListSkeletons', () => ({ DetailedRowListSkeleton: () => <div>loading</div> }))

function message(id: number, conversationId = 'dm-1', overrides: Record<string, unknown> = {}) {
  return {
    id,
    conversation_id: conversationId,
    conversation_name: conversationId === 'dm-1' ? '小叶' : '产品群',
    conversation_type: conversationId === 'dm-1' ? CONVERSATION_TYPE_DM : CONVERSATION_TYPE_GROUP,
    conversation_avatar_url: '',
    sender_id: 'user-1',
    content: `命中 ${id}`,
    message_type: MESSAGE_TYPE_TEXT,
    created_at: `2026-07-0${id}T10:00:00Z`,
    highlight: `命中 ${id}`,
    ...overrides,
  }
}

describe('MessageSearch server pagination', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockOrganizationId.value = 'org-1'
    mockSearchGroups.mockResolvedValueOnce({
      groups: [{
        conversation_id: 'dm-1',
        conversation_name: 'TabTin private conversation',
        conversation_type: CONVERSATION_TYPE_DM,
        conversation_avatar_url: 'https://example.invalid/transport-avatar.png',
        match_count: 5,
        latest_match_at: '2026-07-03T10:00:00Z',
        messages: [message(3), message(2), message(1)],
        messages_has_more: true,
        next_message_offset: 3,
      }],
      has_more: true,
      next_group_offset: 1,
    })
  })

  it('focuses message search when the user presses Cmd+F', async () => {
    const { MessageSearch } = await import('./MessageSearch')
    render(<MessageSearch organizationId="org-1"><div>会话列表</div></MessageSearch>)

    const searchInput = screen.getByLabelText('searchPlaceholder')
    expect(document.activeElement).not.toBe(searchInput)

    const dispatched = fireEvent.keyDown(document, { key: 'f', metaKey: true })

    expect(dispatched).toBe(false)
    expect(document.activeElement).toBe(searchInput)
  })

  it('focuses message search when the user presses Ctrl+F', async () => {
    const { MessageSearch } = await import('./MessageSearch')
    render(<MessageSearch organizationId="org-1"><div>会话列表</div></MessageSearch>)

    const searchInput = screen.getByLabelText('searchPlaceholder')
    const dispatched = fireEvent.keyDown(document, { key: 'f', ctrlKey: true })

    expect(dispatched).toBe(false)
    expect(document.activeElement).toBe(searchInput)
  })

  it('#8756: 切换 organization 时清空旧搜索结果，避免仍可进入旧会话', async () => {
    const { MessageSearch } = await import('./MessageSearch')
    const { rerender } = render(
      <MessageSearch organizationId="org-1"><div>会话列表</div></MessageSearch>,
    )

    fireEvent.change(screen.getByLabelText('searchPlaceholder'), { target: { value: '命中' } })
    await waitFor(() => expect(screen.getByText('小叶')).toBeTruthy())
    expect(screen.queryByText('TabTin private conversation')).toBeNull()

    rerender(<MessageSearch organizationId="org-2"><div>会话列表</div></MessageSearch>)

    await waitFor(() => {
      expect((screen.getByLabelText('searchPlaceholder') as HTMLInputElement).value).toBe('')
    })
    expect(screen.queryByText('小叶')).toBeNull()
    expect(mockSelectSpaceById).not.toHaveBeenCalled()
    expect(mockNavigateToMessage).not.toHaveBeenCalled()
  })

  it('#8756: 搜索结果详情在切换 organization 后返回时不可导航到旧会话', async () => {
    type StaleConversation = {
      id: string
      organization_id: string
      type: number
      name: string
      avatar_url: string
    }
    let resolveConversation: ((conversation: StaleConversation) => void) | null = null
    mockSearchGroups.mockReset()
    mockSearchGroups.mockResolvedValueOnce({
      groups: [{
        conversation_id: 'dm-stale',
        conversation_name: '旧组织会话',
        conversation_type: CONVERSATION_TYPE_DM,
        conversation_avatar_url: '',
        match_count: 1,
        latest_match_at: '2026-07-03T10:00:00Z',
        messages: [message(3, 'dm-stale')],
        messages_has_more: false,
        next_message_offset: 1,
      }],
      has_more: false,
      next_group_offset: 1,
    })
    mockGetConversation.mockImplementationOnce(() => new Promise<StaleConversation>((resolve) => {
      resolveConversation = resolve
    }))
    const { MessageSearch } = await import('./MessageSearch')
    const { rerender } = render(
      <MessageSearch organizationId="org-1"><div>会话列表</div></MessageSearch>,
    )

    fireEvent.change(screen.getByLabelText('searchPlaceholder'), { target: { value: '命中' } })
    const staleResult = await screen.findByRole('button', { name: /小叶.*命中 3/ })
    fireEvent.click(staleResult)
    await waitFor(() => expect(mockGetConversation).toHaveBeenCalledWith('dm-stale'))

    mockOrganizationId.value = 'org-2'
    rerender(<MessageSearch organizationId="org-2"><div>会话列表</div></MessageSearch>)
    resolveConversation?.({
      id: 'dm-stale',
      organization_id: 'org-1',
      type: CONVERSATION_TYPE_DM,
      name: '旧组织会话',
      avatar_url: '',
    })

    await waitFor(() => expect(mockToast).toHaveBeenCalled())
    expect(mockSelectSpaceById).not.toHaveBeenCalled()
    expect(mockNavigateToMessage).not.toHaveBeenCalled()
  })

  it('opens the mapped TabTin conversation and locates the Tencent sequence', async () => {
    const { MessageSearch } = await import('./MessageSearch')
    render(<MessageSearch organizationId="org-1"><div>会话列表</div></MessageSearch>)

    fireEvent.change(screen.getByLabelText('searchPlaceholder'), { target: { value: '命中' } })
    const result = await screen.findByRole('button', { name: /小叶.*命中 3/ })
    fireEvent.click(result)

    await waitFor(() => {
      expect(mockSelectSpaceById).toHaveBeenCalledWith('dm', 'dm-1')
      expect(mockNavigateToMessage).toHaveBeenCalledWith('dm-1', {
        id: 3,
        transport: undefined,
        metadata: {},
      })
    })
    expect(mockGetConversation).not.toHaveBeenCalled()
  })

  it('loads more messages inside one aggregate without loading another aggregate', async () => {
    mockSearchMessages.mockResolvedValueOnce([message(4), message(5)])
    const { MessageSearch } = await import('./MessageSearch')
    render(<MessageSearch organizationId="org-1"><div>会话列表</div></MessageSearch>)

    fireEvent.change(screen.getByLabelText('searchPlaceholder'), { target: { value: '命中' } })
    await waitFor(() => expect(screen.getByText('5 条匹配')).toBeTruthy())
    fireEvent.click(screen.getByText('查看更多结果（剩余 2 条）'))

    await waitFor(() => expect(document.body.textContent).toContain('命中 5'))
    expect(mockSearchMessages).toHaveBeenCalledWith('org-1', '命中', 'dm-1', 10, 3)
    expect(mockSearchGroups).toHaveBeenCalledTimes(1)
  })

  it('keeps C2C search matches when both senders have the same local sequence', async () => {
    mockSearchGroups.mockReset()
    mockSearchGroups.mockResolvedValueOnce({
      groups: [{
        conversation_id: 'dm-1',
        conversation_name: '小叶',
        conversation_type: CONVERSATION_TYPE_DM,
        conversation_avatar_url: '',
        match_count: 2,
        latest_match_at: null,
        messages: [
          message(1, 'dm-1', { sender_id: 'user-1', content: 'mine', highlight: 'mine', metadata: { message_ref: 'mine-ref' } }),
          message(1, 'dm-1', { sender_id: 'user-2', content: 'peer', highlight: 'peer', metadata: { message_ref: 'peer-ref' } }),
        ],
        messages_has_more: false,
        next_message_offset: 2,
      }],
      has_more: false,
      next_group_offset: 1,
    })
    const { MessageSearch } = await import('./MessageSearch')
    render(<MessageSearch organizationId="org-1"><div>会话列表</div></MessageSearch>)

    fireEvent.change(screen.getByLabelText('searchPlaceholder'), { target: { value: 'e' } })

    expect(await screen.findByText('mine')).toBeTruthy()
    expect(screen.getByText('peer')).toBeTruthy()
  })

  it('lazy-loads Tencent details when a multi-match conversation is expanded', async () => {
    mockSearchGroups.mockReset()
    mockSearchGroups.mockResolvedValueOnce({
      groups: [{
        conversation_id: 'dm-1',
        conversation_name: '小叶',
        conversation_type: CONVERSATION_TYPE_DM,
        conversation_avatar_url: '',
        match_count: 5,
        latest_match_at: null,
        messages: [],
        messages_has_more: true,
        next_message_offset: 0,
      }],
      has_more: false,
      next_group_offset: 1,
    })
    mockSearchMessages.mockResolvedValueOnce([message(3), message(2), message(1)])
    const { MessageSearch } = await import('./MessageSearch')
    render(<MessageSearch organizationId="org-1"><div>会话列表</div></MessageSearch>)

    fireEvent.change(screen.getByLabelText('searchPlaceholder'), { target: { value: '命中' } })
    const groupHeader = await screen.findByRole('button', { name: /小叶.*5 条匹配/ })
    expect(groupHeader.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(groupHeader)

    await waitFor(() => expect(document.body.textContent).toContain('命中 3'))
    expect(mockSearchMessages).toHaveBeenCalledWith('org-1', '命中', 'dm-1', 10, 0)
  })

  it('loads the next page of user/group aggregates independently', async () => {
    mockSearchGroups.mockResolvedValueOnce({
      groups: [{
        conversation_id: 'group-1',
        conversation_name: '产品群',
        conversation_type: CONVERSATION_TYPE_GROUP,
        conversation_avatar_url: '',
        match_count: 1,
        latest_match_at: '2026-07-01T10:00:00Z',
        messages: [message(1, 'group-1')],
        messages_has_more: false,
        next_message_offset: 1,
      }],
      has_more: false,
      next_group_offset: 2,
    })
    const { MessageSearch } = await import('./MessageSearch')
    render(<MessageSearch organizationId="org-1"><div>会话列表</div></MessageSearch>)

    fireEvent.change(screen.getByLabelText('searchPlaceholder'), { target: { value: '命中' } })
    await waitFor(() => expect(screen.getByText('查看更多用户和群组')).toBeTruthy())
    fireEvent.click(screen.getByText('查看更多用户和群组'))

    await waitFor(() => expect(screen.getByText('产品群')).toBeTruthy())
    expect(mockSearchGroups).toHaveBeenLastCalledWith('org-1', '命中', 1, 8, 3)
    expect(mockSearchMessages).not.toHaveBeenCalled()
  })
})
