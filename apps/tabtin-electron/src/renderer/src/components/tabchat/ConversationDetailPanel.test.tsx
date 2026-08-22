import React from 'react'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockT = vi.hoisted(() => (key: string, opts?: Record<string, string | number>) => {
  if (key === 'memberBreakdown' && opts) return `${opts.human} 人 · ${opts.agent} AI`
  if (key === 'memberBreakdownHumanOnly' && opts) return `${opts.human} 人`
  return opts?.name ? `${key}:${opts.name}` : key
})

const {
  conversationsRef,
  imStoreRef,
  imStoreListeners,
  mockGetConversation,
  mockRefreshConversationMembers,
  mockClearHistory,
  mockLeaveConversation,
  mockToggleMute,
  mockTogglePin,
  mockAddMembers,
  mockAddAgents,
  mockCreateConversationAgentBinding,
  mockListConversationAgentBindings,
  mockUpdateConversationAgentBinding,
  mockRemoveMember,
  mockSearchOrganizationMembers,
  mockSearchOrganizationAgents,
  mockListExternalContacts,
  mockUpdateExternalContact,
  mockClearConversationMessages,
  mockRemoveConversation,
  mockUpdateConversation,
  mockCreateConversationAndActivate,
  mockToast,
  profilesRef,
  mockEnsureProfiles,
} = vi.hoisted(() => ({
  conversationsRef: {
    current: [
      { id: 'group-1', organization_id: 'ws-1', type: 2, name: 'Group', avatar_url: '', member_count: 2, is_muted: false, pinned: false },
      { id: 'dm-1', organization_id: 'ws-1', type: 1, name: 'Alice', avatar_url: '', dm_peer_user_id: 'user-2', member_count: 2, is_muted: false, pinned: false },
    ],
  },
  imStoreRef: { current: {} as Record<string, unknown> },
  imStoreListeners: new Set<() => void>(),
  mockGetConversation: vi.fn(),
  mockRefreshConversationMembers: vi.fn(),
  mockClearHistory: vi.fn(() => Promise.resolve(null)),
  mockLeaveConversation: vi.fn(() => Promise.resolve(null)),
  mockToggleMute: vi.fn(() => Promise.resolve({ muted: true })),
  mockTogglePin: vi.fn(() => Promise.resolve({ pinned: true })),
  mockAddMembers: vi.fn(() => Promise.resolve(null)),
  mockAddAgents: vi.fn(() => Promise.resolve(null)),
  mockCreateConversationAgentBinding: vi.fn(() => Promise.resolve({
    agent_id: 'agent-2',
    workspace_id: 'ws-home',
    workspace_name: 'Home',
    bound_by_user_id: 'user-1',
    bound_at: null,
    can_rebind: true,
    is_executable: true,
  })),
  mockListConversationAgentBindings: vi.fn(() => Promise.resolve([])),
  mockUpdateConversationAgentBinding: vi.fn(() => Promise.resolve({
    agent_id: 'agent-1',
    workspace_id: 'ws-home',
    workspace_name: 'Home',
    bound_by_user_id: 'user-1',
    bound_at: null,
    can_rebind: true,
    is_executable: true,
  })),
  mockRemoveMember: vi.fn(() => Promise.resolve(null)),
  mockSearchOrganizationMembers: vi.fn(() => Promise.resolve([] as Array<{
    id: string
    nickname: string
    username: string
    email: string
    avatar: string
  }>)),
  mockSearchOrganizationAgents: vi.fn(() => Promise.resolve([] as Array<{
    id: string
    name: string
    avatar: string
  }>)),
  mockListExternalContacts: vi.fn(() => Promise.resolve({ items: [] })),
  mockUpdateExternalContact: vi.fn(),
  mockClearConversationMessages: vi.fn(),
  mockRemoveConversation: vi.fn(),
  mockUpdateConversation: vi.fn(),
  mockCreateConversationAndActivate: vi.fn(() => Promise.resolve('dm-2')),
  mockToast: vi.fn(),
  profilesRef: { current: {} as Record<string, { nickname: string; username: string; avatar: string }> },
  mockEnsureProfiles: vi.fn(),
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: mockT }),
}))

vi.mock('@tabtin/smartsheet-ui', () => ({ toast: mockToast }))

vi.mock('@components/ui', () => ({
  Badge: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement>) =>
    React.createElement('div', props, children),
}))

vi.mock('@components/chat/panel/ChatIconTooltip', () => ({
  ChatIconTooltip: ({ children }: { children: React.ReactNode }) => children,
}))

vi.mock('@components/common/ListSkeletons', () => ({
  DetailedRowListSkeleton: () => React.createElement('div', { 'data-testid': 'skeleton' }),
}))

vi.mock('@stores/useAuthStore', () => ({
  useAuthStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({ user: { id: 'user-1' } }),
}))

vi.mock('@stores/useUserProfileCache', () => ({
  useUserProfile: (userId: string | undefined) => (userId ? profilesRef.current[userId] : undefined),
  useUserProfileCache: (selector: (s: { ensureProfiles: typeof mockEnsureProfiles }) => unknown) =>
    selector({ ensureProfiles: mockEnsureProfiles }),
}))

vi.mock('@stores/useOrganizationStore', () => ({
  useOrganizationStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({ selectedOrganization: { id: 'ws-1' }, members: [], loadMembers: vi.fn() }),
}))

vi.mock('@stores/useIMStore', async () => {
  const ReactModule = await vi.importActual<typeof import('react')>('react')
  const useIMStore = Object.assign(
    (selector: (s: Record<string, unknown>) => unknown) => ReactModule.useSyncExternalStore(
      (listener) => {
        imStoreListeners.add(listener)
        return () => imStoreListeners.delete(listener)
      },
      () => selector(imStoreRef.current),
      () => selector(imStoreRef.current),
    ),
    { getState: () => imStoreRef.current },
  ) as unknown as typeof import('@stores/useIMStore').useIMStore
  return { useIMStore }
})

vi.mock('./AgentWorkspacePickerDialog', () => ({
  AgentWorkspacePickerDialog: ({
    open,
    onConfirm,
  }: {
    open: boolean
    onConfirm: (workspaceId: string) => Promise<void>
  }) => (open
    ? React.createElement('button', {
      type: 'button',
      onClick: () => { void onConfirm('ws-home') },
    }, 'confirmWorkspace')
    : null),
}))

vi.mock('@/services/tabchatApi', () => ({
  getConversation: mockGetConversation,
  addMembers: mockAddMembers,
  addAgents: mockAddAgents,
  createConversationAgentBinding: mockCreateConversationAgentBinding,
  listConversationAgentBindings: mockListConversationAgentBindings,
  updateConversationAgentBinding: mockUpdateConversationAgentBinding,
  removeMember: mockRemoveMember,
  removeAgent: vi.fn(),
  searchOrganizationMembers: mockSearchOrganizationMembers,
  searchOrganizationAgents: mockSearchOrganizationAgents,
  listExternalContacts: mockListExternalContacts,
  updateExternalContact: mockUpdateExternalContact,
  clearHistory: mockClearHistory,
  leaveConversation: mockLeaveConversation,
  toggleMute: mockToggleMute,
  togglePin: mockTogglePin,
  updateConversation: mockUpdateConversation,
}))

vi.mock('@components/shared/AvatarCropUploader', () => ({
  AvatarCropUploader: () => React.createElement('div', { 'data-testid': 'avatar-crop-uploader' }),
}))

function groupDetail() {
  return Promise.resolve({
    id: 'group-1',
    type: 2,
    member_count: 3,
    members: [
      { member_type: 'user', user_id: 'user-1', agent_id: null, nickname: 'Me', username: 'me', avatar: '', role: 3, is_muted: false, pinned: false, joined_at: null },
      { member_type: 'user', user_id: 'user-2', agent_id: null, nickname: 'Bob', username: 'bob', avatar: '', role: 1, is_muted: false, pinned: false, joined_at: null },
      { member_type: 'agent', user_id: null, agent_id: 'agent-1', nickname: 'Bot', username: '', avatar: '', role: 1, is_muted: false, pinned: false, joined_at: null, owner_user_id: 'user-2', owner_display_name: '张三' },
    ],
  })
}

function groupDetailWithMissingUserId() {
  return groupDetail().then((detail) => ({
    ...detail,
    members: [
      ...detail.members,
      { member_type: 'user' as const, user_id: null, agent_id: null, nickname: 'Unknown', username: '', avatar: '', role: 1, is_muted: false, pinned: false, joined_at: null },
    ],
  }))
}

function groupDetailForMember() {
  return groupDetail().then((detail) => ({
    ...detail,
    members: detail.members.map((member) => (
      member.user_id === 'user-1' ? { ...member, role: 1 } : member
    )),
  }))
}

function dmDetail() {
  return Promise.resolve({
    id: 'dm-1',
    type: 1,
    member_count: 2,
    members: [
      { member_type: 'user', user_id: 'user-1', agent_id: null, nickname: 'Me', username: 'me', avatar: '', role: 1, is_muted: false, pinned: false, joined_at: null },
      { member_type: 'user', user_id: 'user-2', agent_id: null, nickname: 'Alice', username: 'alice', avatar: '', role: 1, is_muted: false, pinned: false, joined_at: null },
    ],
  })
}

function setMockIMState(
  update: Record<string, unknown> | ((state: Record<string, unknown>) => Record<string, unknown>),
) {
  const patch = typeof update === 'function' ? update(imStoreRef.current) : update
  imStoreRef.current = { ...imStoreRef.current, ...patch }
  imStoreListeners.forEach((listener) => listener())
}

describe('ConversationDetailPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    conversationsRef.current = [
      { id: 'group-1', organization_id: 'ws-1', type: 2, name: 'Group', avatar_url: '', member_count: 2, is_muted: false, pinned: false },
      { id: 'dm-1', organization_id: 'ws-1', type: 1, name: 'Alice', avatar_url: '', dm_peer_user_id: 'user-2', member_count: 2, is_muted: false, pinned: false },
    ]
    mockGetConversation.mockReset()
    mockSearchOrganizationMembers.mockResolvedValue([])
    mockSearchOrganizationAgents.mockResolvedValue([])
    mockListExternalContacts.mockResolvedValue({ items: [] })
    profilesRef.current = {}
    imStoreListeners.clear()
    imStoreRef.current = {
      conversations: conversationsRef.current,
      conversationMembers: {},
      conversationMembersLoading: {},
      refreshConversationMembers: mockRefreshConversationMembers,
      updateConversation: mockUpdateConversation,
      clearConversationMessages: mockClearConversationMessages,
      removeConversation: mockRemoveConversation,
      createConversationAndActivate: mockCreateConversationAndActivate,
    }
    mockRefreshConversationMembers.mockImplementation(async (conversationId: string) => {
      setMockIMState((state) => ({
        conversationMembersLoading: {
          ...(state.conversationMembersLoading as Record<string, boolean>),
          [conversationId]: true,
        },
      }))
      try {
        const detail = await mockGetConversation(conversationId)
        const members = detail.members ?? []
        setMockIMState((state) => ({
          conversationMembers: {
            ...(state.conversationMembers as Record<string, unknown>),
            [conversationId]: members,
          },
          conversations: (state.conversations as Array<Record<string, unknown>>).map((conversation) => (
            conversation.id === conversationId
              ? { ...conversation, member_count: members.length }
              : conversation
          )),
        }))
      } finally {
        setMockIMState((state) => ({
          conversationMembersLoading: {
            ...(state.conversationMembersLoading as Record<string, boolean>),
            [conversationId]: false,
          },
        }))
      }
    })
  })

  it('在最终位置淡入淡出，避免横向滑入被裁剪成窄栏', async () => {
    mockGetConversation.mockImplementation(() => new Promise(() => undefined))
    const { ConversationDetailPanel } = await import('./ConversationDetailPanel')
    const { container, rerender } = render(
      <ConversationDetailPanel conversationId="dm-1" isOpen={false} onClose={vi.fn()} />,
    )

    const closedPanel = container.querySelector('[data-testid="conversation-detail-panel"]')
    expect(closedPanel?.classList.contains('opacity-0')).toBe(true)
    expect(closedPanel?.classList.contains('transition-[opacity,box-shadow]')).toBe(true)
    expect(Array.from(closedPanel?.classList ?? []).some((name) => name.startsWith('translate-x-'))).toBe(false)
    expect(closedPanel?.getAttribute('aria-hidden')).toBe('true')

    rerender(<ConversationDetailPanel conversationId="dm-1" isOpen onClose={vi.fn()} />)

    const openPanel = container.querySelector('[data-testid="conversation-detail-panel"]')
    expect(openPanel?.classList.contains('opacity-100')).toBe(true)
    expect(Array.from(openPanel?.classList ?? []).some((name) => name.startsWith('translate-x-'))).toBe(false)
    expect(openPanel?.getAttribute('aria-hidden')).toBe('false')
  })

  it('group form shows members count and leave group action', async () => {
    mockGetConversation.mockImplementation(groupDetail)
    const { ConversationDetailPanel } = await import('./ConversationDetailPanel')
    render(<ConversationDetailPanel conversationId="group-1" isOpen onClose={vi.fn()} />)

    expect(await screen.findByText('2 人 · 1 AI')).toBeTruthy()
    expect(screen.getByText('humanMembers (2)')).toBeTruthy()
    expect(screen.getByText('agentMembers (1)')).toBeTruthy()
    expect(screen.getByText('Bot')).toBeTruthy()
    expect(screen.getByText('张三')).toBeTruthy()
    expect(screen.getByText('leaveGroup')).toBeTruthy()
    expect(screen.getByText('mute')).toBeTruthy()
    expect(screen.getByText('clearHistory')).toBeTruthy()
  })

  it('外部私信详情可拉黑并解除联系人关系', async () => {
    conversationsRef.current = [{
      id: 'dm-1', organization_id: 'ws-1', type: 1, name: 'Alice', avatar_url: '',
      dm_peer_user_id: 'user-2', dm_peer_organization_id: 'ws-2', member_count: 2,
      is_muted: false, pinned: false, is_external: true,
    }]
    setMockIMState({ conversations: conversationsRef.current })
    mockListExternalContacts.mockResolvedValue({ items: [{
      contact_id: 'contact-1', organization_id: 'ws-1', peer_organization_id: 'ws-2',
      peer_user_id: 'user-2', display_name: 'Alice', avatar_url: '', relationship: 'friend',
      is_restorable: false, updated_at: '', peer_organization_name: '外部组织',
    }] })
    mockUpdateExternalContact.mockResolvedValue({
      contact_id: 'contact-1', organization_id: 'ws-1', peer_organization_id: 'ws-2',
      peer_user_id: 'user-2', display_name: 'Alice', avatar_url: '', relationship: 'blocked',
      is_restorable: false, updated_at: '', peer_organization_name: '外部组织',
    })
    mockGetConversation.mockImplementation(dmDetail)
    const { ConversationDetailPanel } = await import('./ConversationDetailPanel')
    render(<ConversationDetailPanel conversationId="dm-1" isOpen onClose={vi.fn()} />)

    fireEvent.click(await screen.findByText('externalContacts.block'))
    await waitFor(() => {
      expect(mockUpdateExternalContact).toHaveBeenCalledWith('ws-1', 'contact-1', 'block')
      expect(screen.getByText('externalContacts.unblock')).toBeTruthy()
    })

    fireEvent.click(screen.getByText('externalContacts.remove'))
    expect(screen.getByText('externalContacts.removeConfirm:Alice')).toBeTruthy()
  })

  it('服务端确认置顶前不提前修改本地会话状态', async () => {
    let resolvePin!: (value: { pinned: boolean; pinned_source: 'tabtin' }) => void
    mockTogglePin.mockReturnValueOnce(new Promise((resolve) => {
      resolvePin = resolve
    }))
    mockGetConversation.mockImplementation(groupDetail)
    const { ConversationDetailPanel } = await import('./ConversationDetailPanel')
    render(<ConversationDetailPanel conversationId="group-1" isOpen onClose={vi.fn()} />)

    fireEvent.click(await screen.findByText('pin'))

    expect(mockTogglePin).toHaveBeenCalledWith('group-1', true)
    expect(mockUpdateConversation).not.toHaveBeenCalled()

    resolvePin({ pinned: true, pinned_source: 'tabtin' })
    await waitFor(() => {
      expect(mockUpdateConversation).toHaveBeenCalledWith('group-1', {
        pinned: true,
        pinned_source: 'tabtin',
      })
    })
  })

  it('未发首条消息时免打扰失败会提示明确原因', async () => {
    mockToggleMute.mockRejectedValueOnce(new Error('conversation is not activated'))
    mockGetConversation.mockImplementation(groupDetail)
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const { ConversationDetailPanel } = await import('./ConversationDetailPanel')
    render(<ConversationDetailPanel conversationId="group-1" isOpen onClose={vi.fn()} />)

    fireEvent.click(await screen.findByText('mute'))

    await waitFor(() => {
      expect(mockToast).toHaveBeenCalledWith({
        title: 'muteBeforeFirstMessage',
        variant: 'destructive',
      })
    })
    consoleError.mockRestore()
  })

  it('成员头像加载失败时降级为稳定的姓名头像', async () => {
    mockGetConversation.mockImplementation(() => groupDetail().then((detail) => ({
      ...detail,
      members: detail.members.map((member) => member.user_id === 'user-1'
        ? { ...member, avatar: 'https://assets.example.com/missing-avatar.png' }
        : member),
    })))
    const { ConversationDetailPanel } = await import('./ConversationDetailPanel')
    const { container } = render(<ConversationDetailPanel conversationId="group-1" isOpen onClose={vi.fn()} />)

    const selfAvatar = await waitFor(() => {
      const image = container.querySelector('img')
      if (!image) throw new Error('expected member avatar image')
      return image
    })
    fireEvent.error(selfAvatar)

    expect(container.querySelector('img')).toBeNull()
    expect(screen.getByText('M')).toBeTruthy()
  })

  it('点击其他人类成员的头像或姓名会复用创建并激活私信链路', async () => {
    mockGetConversation.mockImplementation(groupDetail)
    const onClose = vi.fn()
    const { ConversationDetailPanel } = await import('./ConversationDetailPanel')
    render(<ConversationDetailPanel conversationId="group-1" isOpen onClose={onClose} />)

    fireEvent.click(await screen.findByRole('button', { name: 'messageMember:Bob' }))

    await waitFor(() => {
      expect(mockCreateConversationAndActivate).toHaveBeenCalledWith({
        organizationId: 'ws-1',
        kind: 'dm',
        memberIds: ['user-2'],
      })
    })
    expect(mockListExternalContacts).not.toHaveBeenCalled()
    expect(onClose).toHaveBeenCalled()
  })

  it('打开私信期间重复点击成员只发起一次请求', async () => {
    mockGetConversation.mockImplementation(groupDetail)
    let resolve!: (conversationId: string) => void
    mockCreateConversationAndActivate.mockImplementationOnce(() => new Promise((done) => { resolve = done }))
    const { ConversationDetailPanel } = await import('./ConversationDetailPanel')
    render(<ConversationDetailPanel conversationId="group-1" isOpen onClose={vi.fn()} />)

    const button = await screen.findByRole('button', { name: 'messageMember:Bob' })
    fireEvent.click(button)
    fireEvent.click(button)

    await waitFor(() => expect(mockCreateConversationAndActivate).toHaveBeenCalledTimes(1))
    expect(button.getAttribute('disabled')).not.toBeNull()
    resolve('dm-2')
    await waitFor(() => expect(button.getAttribute('disabled')).toBeNull())
  })

  it('打开私信失败时保留抽屉、提示错误并恢复入口', async () => {
    mockGetConversation.mockImplementation(groupDetail)
    mockCreateConversationAndActivate.mockRejectedValueOnce(new Error('network error'))
    const onClose = vi.fn()
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const { ConversationDetailPanel } = await import('./ConversationDetailPanel')
    render(<ConversationDetailPanel conversationId="group-1" isOpen onClose={onClose} />)

    const button = await screen.findByRole('button', { name: 'messageMember:Bob' })
    fireEvent.click(button)

    await waitFor(() => {
      expect(mockToast).toHaveBeenCalledWith({ title: 'createFailed', variant: 'destructive' })
      expect(button.getAttribute('disabled')).toBeNull()
    })
    expect(onClose).not.toHaveBeenCalled()
    consoleError.mockRestore()
  })

  it('从外部群点击已拉黑好友时提示已拉黑，不发起私信', async () => {
    conversationsRef.current = [{
      id: 'group-1', organization_id: 'ws-1', type: 2, name: '外部1', avatar_url: '',
      member_count: 2, is_muted: false, pinned: false, is_external: true,
    }]
    setMockIMState({ conversations: conversationsRef.current })
    mockGetConversation.mockResolvedValue({
      id: 'group-1',
      type: 2,
      member_count: 2,
      members: [
        { member_type: 'user', user_id: 'user-1', agent_id: null, nickname: 'Me', username: 'me', avatar: '', role: 3, is_muted: false, pinned: false, joined_at: null },
        { member_type: 'user', user_id: 'user-2', agent_id: null, nickname: 'zsctest1', username: 'zsctest1', avatar: '', role: 1, is_muted: false, pinned: false, joined_at: null, participant_organization_id: 'ws-2' },
      ],
    })
    mockListExternalContacts.mockResolvedValue({
      items: [{
        contact_id: 'contact-1', organization_id: 'ws-1', peer_organization_id: 'ws-2',
        peer_user_id: 'user-2', display_name: 'zsctest1', avatar_url: '', relationship: 'blocked',
        is_restorable: false, updated_at: '', peer_organization_name: '外部组织',
      }],
    })
    const onClose = vi.fn()
    const { ConversationDetailPanel } = await import('./ConversationDetailPanel')
    render(<ConversationDetailPanel conversationId="group-1" isOpen onClose={onClose} />)

    fireEvent.click(await screen.findByRole('button', { name: 'messageMember:zsctest1' }))

    await waitFor(() => {
      expect(mockToast).toHaveBeenCalledWith({
        title: 'blockedContactCannotMessage',
        variant: 'destructive',
      })
    })
    expect(mockCreateConversationAndActivate).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
  })

  it('从外部群点击已删除好友时提示无法私信，不发起创建', async () => {
    conversationsRef.current = [{
      id: 'group-1', organization_id: 'ws-1', type: 2, name: '外部1', avatar_url: '',
      member_count: 2, is_muted: false, pinned: false, is_external: true,
    }]
    setMockIMState({ conversations: conversationsRef.current })
    mockGetConversation.mockResolvedValue({
      id: 'group-1',
      type: 2,
      member_count: 2,
      members: [
        { member_type: 'user', user_id: 'user-1', agent_id: null, nickname: 'Me', username: 'me', avatar: '', role: 3, is_muted: false, pinned: false, joined_at: null },
        { member_type: 'user', user_id: 'user-2', agent_id: null, nickname: 'zsctest1', username: 'zsctest1', avatar: '', role: 1, is_muted: false, pinned: false, joined_at: null, participant_organization_id: 'ws-2', is_external: true },
      ],
    })
    mockListExternalContacts.mockResolvedValue({
      items: [{
        contact_id: 'contact-1', organization_id: 'ws-1', peer_organization_id: 'ws-2',
        peer_user_id: 'user-2', display_name: 'zsctest1', avatar_url: '', relationship: 'removed',
        is_restorable: false, updated_at: '', peer_organization_name: '外部组织',
      }],
    })
    const onClose = vi.fn()
    const { ConversationDetailPanel } = await import('./ConversationDetailPanel')
    render(<ConversationDetailPanel conversationId="group-1" isOpen onClose={onClose} />)

    fireEvent.click(await screen.findByRole('button', { name: 'messageMember:zsctest1' }))

    await waitFor(() => {
      expect(mockToast).toHaveBeenCalledWith({
        title: 'cannotStartDirectChat',
        variant: 'destructive',
      })
    })
    expect(mockCreateConversationAndActivate).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
  })

  it('从外部群点击仍是好友的外部成员时走外部私信', async () => {
    conversationsRef.current = [{
      id: 'group-1', organization_id: 'ws-1', type: 2, name: '外部1', avatar_url: '',
      member_count: 2, is_muted: false, pinned: false, is_external: true,
    }]
    setMockIMState({ conversations: conversationsRef.current })
    mockGetConversation.mockResolvedValue({
      id: 'group-1',
      type: 2,
      member_count: 2,
      members: [
        { member_type: 'user', user_id: 'user-1', agent_id: null, nickname: 'Me', username: 'me', avatar: '', role: 3, is_muted: false, pinned: false, joined_at: null },
        { member_type: 'user', user_id: 'user-2', agent_id: null, nickname: 'Bob', username: 'bob', avatar: '', role: 1, is_muted: false, pinned: false, joined_at: null, participant_organization_id: 'ws-2', is_external: true },
      ],
    })
    mockListExternalContacts.mockResolvedValue({
      items: [{
        contact_id: 'contact-1', organization_id: 'ws-1', peer_organization_id: 'ws-2',
        peer_user_id: 'user-2', display_name: 'Bob', avatar_url: '', relationship: 'friend',
        is_restorable: false, updated_at: '', peer_organization_name: '外部组织',
      }],
    })
    const onClose = vi.fn()
    const { ConversationDetailPanel } = await import('./ConversationDetailPanel')
    render(<ConversationDetailPanel conversationId="group-1" isOpen onClose={onClose} />)

    fireEvent.click(await screen.findByRole('button', { name: 'messageMember:Bob' }))

    await waitFor(() => {
      expect(mockCreateConversationAndActivate).toHaveBeenCalledWith({
        organizationId: 'ws-1',
        kind: 'dm',
        memberIds: [],
        externalContactIds: ['contact-1'],
      })
    })
    expect(onClose).toHaveBeenCalled()
  })

  it('外部成员未出现在联系人列表时不发起私信', async () => {
    conversationsRef.current = [{
      id: 'group-1', organization_id: 'ws-1', type: 2, name: '外部1', avatar_url: '',
      member_count: 2, is_muted: false, pinned: false, is_external: true,
    }]
    setMockIMState({ conversations: conversationsRef.current })
    mockGetConversation.mockResolvedValue({
      id: 'group-1',
      type: 2,
      member_count: 2,
      members: [
        { member_type: 'user', user_id: 'user-1', agent_id: null, nickname: 'Me', username: 'me', avatar: '', role: 3, is_muted: false, pinned: false, joined_at: null },
        { member_type: 'user', user_id: 'user-2', agent_id: null, nickname: 'Bob', username: 'bob', avatar: '', role: 1, is_muted: false, pinned: false, joined_at: null, participant_organization_id: 'ws-2', is_external: true },
      ],
    })
    mockListExternalContacts.mockResolvedValue({ items: [] })
    const onClose = vi.fn()
    const { ConversationDetailPanel } = await import('./ConversationDetailPanel')
    render(<ConversationDetailPanel conversationId="group-1" isOpen onClose={onClose} />)

    fireEvent.click(await screen.findByRole('button', { name: 'messageMember:Bob' }))

    await waitFor(() => {
      expect(mockToast).toHaveBeenCalledWith({
        title: 'cannotStartDirectChat',
        variant: 'destructive',
      })
    })
    expect(mockCreateConversationAndActivate).not.toHaveBeenCalled()
  })

  it('外部群里的组织成员未命中联系人时仍走组织私信', async () => {
    conversationsRef.current = [{
      id: 'group-1', organization_id: 'ws-1', type: 2, name: '外部1', avatar_url: '',
      member_count: 2, is_muted: false, pinned: false, is_external: true,
    }]
    setMockIMState({ conversations: conversationsRef.current })
    mockGetConversation.mockResolvedValue({
      id: 'group-1',
      type: 2,
      member_count: 2,
      members: [
        { member_type: 'user', user_id: 'user-1', agent_id: null, nickname: 'Me', username: 'me', avatar: '', role: 3, is_muted: false, pinned: false, joined_at: null },
        { member_type: 'user', user_id: 'user-2', agent_id: null, nickname: 'Bob', username: 'bob', avatar: '', role: 1, is_muted: false, pinned: false, joined_at: null, participant_organization_id: 'ws-1' },
      ],
    })
    mockListExternalContacts.mockResolvedValue({ items: [] })
    const onClose = vi.fn()
    const { ConversationDetailPanel } = await import('./ConversationDetailPanel')
    render(<ConversationDetailPanel conversationId="group-1" isOpen onClose={onClose} />)

    fireEvent.click(await screen.findByRole('button', { name: 'messageMember:Bob' }))

    await waitFor(() => {
      expect(mockCreateConversationAndActivate).toHaveBeenCalledWith({
        organizationId: 'ws-1',
        kind: 'dm',
        memberIds: ['user-2'],
      })
    })
    expect(onClose).toHaveBeenCalled()
  })

  it('查询外部联系人失败时不发起私信', async () => {
    conversationsRef.current = [{
      id: 'group-1', organization_id: 'ws-1', type: 2, name: '外部1', avatar_url: '',
      member_count: 2, is_muted: false, pinned: false, is_external: true,
    }]
    setMockIMState({ conversations: conversationsRef.current })
    mockGetConversation.mockResolvedValue({
      id: 'group-1',
      type: 2,
      member_count: 2,
      members: [
        { member_type: 'user', user_id: 'user-1', agent_id: null, nickname: 'Me', username: 'me', avatar: '', role: 3, is_muted: false, pinned: false, joined_at: null },
        { member_type: 'user', user_id: 'user-2', agent_id: null, nickname: 'Bob', username: 'bob', avatar: '', role: 1, is_muted: false, pinned: false, joined_at: null, participant_organization_id: 'ws-2', is_external: true },
      ],
    })
    mockListExternalContacts.mockRejectedValue(new Error('network'))
    const onClose = vi.fn()
    const { ConversationDetailPanel } = await import('./ConversationDetailPanel')
    render(<ConversationDetailPanel conversationId="group-1" isOpen onClose={onClose} />)

    fireEvent.click(await screen.findByRole('button', { name: 'messageMember:Bob' }))

    await waitFor(() => {
      expect(mockToast).toHaveBeenCalledWith({
        title: 'cannotStartDirectChat',
        variant: 'destructive',
      })
    })
    expect(mockCreateConversationAndActivate).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
  })

  it('本人、Agent 与缺失 user_id 的成员不显示私信入口', async () => {
    mockGetConversation.mockImplementation(groupDetailWithMissingUserId)
    const { ConversationDetailPanel } = await import('./ConversationDetailPanel')
    render(<ConversationDetailPanel conversationId="group-1" isOpen onClose={vi.fn()} />)

    await screen.findByText('Bob')
    expect(screen.getAllByRole('button', { name: 'messageMember:Bob' })).toHaveLength(1)
  })

  it('群管理员可从群聊信息面板修改群名', async () => {
    mockGetConversation.mockImplementation(groupDetail)
    mockUpdateConversation.mockResolvedValue(null)
    const { ConversationDetailPanel } = await import('./ConversationDetailPanel')
    render(<ConversationDetailPanel conversationId="group-1" isOpen onClose={vi.fn()} />)

    fireEvent.click(await screen.findByRole('button', { name: 'editGroupName' }))
    fireEvent.change(screen.getByLabelText('groupNameLabel'), { target: { value: '设计讨论群' } })
    fireEvent.click(screen.getByRole('button', { name: 'confirm' }))

    await waitFor(() => {
      expect(mockUpdateConversation).toHaveBeenCalledWith('group-1', { name: '设计讨论群' })
    })
  })

  it('普通成员可加人，但不显示改名入口', async () => {
    mockGetConversation.mockImplementation(groupDetailForMember)
    const { ConversationDetailPanel } = await import('./ConversationDetailPanel')
    render(<ConversationDetailPanel conversationId="group-1" isOpen onClose={vi.fn()} />)

    await screen.findByText('2 人 · 1 AI')

    expect(screen.getByRole('button', { name: 'addMember' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'editGroupName' })).toBeNull()
  })

  it('普通成员可添加自己的 AI 并绑定现场', async () => {
    mockSearchOrganizationAgents.mockResolvedValue([
      { id: 'agent-2', name: 'Member Bot', avatar: '' },
    ])
    const updatedDetail = await groupDetailForMember().then((detail) => ({
      ...detail,
      member_count: 4,
      members: [
        ...detail.members,
        { member_type: 'agent' as const, user_id: null, agent_id: 'agent-2', nickname: 'Member Bot', username: '', avatar: '', role: 1, is_muted: false, pinned: false, joined_at: null },
      ],
    }))
    mockGetConversation
      .mockImplementationOnce(groupDetailForMember)
      .mockResolvedValueOnce(updatedDetail)
    const { ConversationDetailPanel } = await import('./ConversationDetailPanel')
    render(<ConversationDetailPanel conversationId="group-1" isOpen onClose={vi.fn()} />)

    fireEvent.click(await screen.findByRole('button', { name: 'addMember' }))
    fireEvent.click(await screen.findByRole('button', { name: /Member Bot/ }))
    fireEvent.click(await screen.findByRole('button', { name: 'confirmWorkspace' }))

    await waitFor(() => expect(mockCreateConversationAgentBinding).toHaveBeenCalledWith(
      'group-1',
      'agent-2',
      'ws-home',
    ))
    expect(mockAddAgents).not.toHaveBeenCalled()
    expect(await screen.findByText('2 人 · 2 AI')).toBeTruthy()
  })

  it('已有群聊的添加面板不加载或展示外部联系人', async () => {
    mockListExternalContacts.mockResolvedValue({
      items: [{
        contact_id: 'contact-1', peer_user_id: 'external-user-1', display_name: '外部好友',
        avatar_url: '', peer_organization_name: '外部组织', relationship: 'friend',
      }],
    })
    mockGetConversation.mockImplementation(groupDetail)
    const { ConversationDetailPanel } = await import('./ConversationDetailPanel')
    render(<ConversationDetailPanel conversationId="group-1" isOpen onClose={vi.fn()} />)

    fireEvent.click(await screen.findByRole('button', { name: 'addMember' }))

    await waitFor(() => expect(mockListExternalContacts).not.toHaveBeenCalled())
    expect(screen.queryByText('外部好友')).toBeNull()
  })

  it('添加成员后同步会话摘要人数，聊天顶部无需切换会话即可刷新', async () => {
    mockSearchOrganizationMembers.mockResolvedValue([
      { id: 'user-3', nickname: 'Charlie', username: 'charlie', email: '', avatar: '' },
    ])
    const updatedDetail = await groupDetail().then((detail) => ({
      ...detail,
      member_count: 4,
      members: [
        ...detail.members,
        { member_type: 'user' as const, user_id: 'user-3', agent_id: null, nickname: 'Charlie', username: 'charlie', avatar: '', role: 1, is_muted: false, pinned: false, joined_at: null },
      ],
    }))
    mockGetConversation
      .mockImplementationOnce(groupDetail)
      .mockResolvedValueOnce(updatedDetail)
    const { ConversationDetailPanel } = await import('./ConversationDetailPanel')
    render(<ConversationDetailPanel conversationId="group-1" isOpen onClose={vi.fn()} />)

    fireEvent.click(await screen.findByRole('button', { name: 'addMember' }))
    fireEvent.change(screen.getByPlaceholderText('searchMember'), { target: { value: 'Charlie' } })
    fireEvent.click(await screen.findByRole('button', { name: /Charlie/ }))

    await waitFor(() => expect(mockAddMembers).toHaveBeenCalledWith('group-1', ['user-3']))
    expect(await screen.findByText('3 人 · 1 AI')).toBeTruthy()
    expect((imStoreRef.current.conversations as Array<{ member_count: number }>)[0].member_count).toBe(4)
  })

  it('私聊添加第三人时创建新群并保留原私聊', async () => {
    mockSearchOrganizationMembers.mockResolvedValue([
      { id: 'user-3', nickname: 'Charlie', username: 'charlie', email: '', avatar: '' },
    ])
    mockGetConversation.mockImplementation(dmDetail)
    const onClose = vi.fn()
    const { ConversationDetailPanel } = await import('./ConversationDetailPanel')
    render(<ConversationDetailPanel conversationId="dm-1" isOpen onClose={onClose} />)

    fireEvent.click(await screen.findByRole('button', { name: 'addMember' }))
    fireEvent.change(screen.getByPlaceholderText('searchMember'), { target: { value: 'Charlie' } })
    fireEvent.click(await screen.findByRole('button', { name: /Charlie/ }))

    await waitFor(() => expect(mockCreateConversationAndActivate).toHaveBeenCalledWith({
      organizationId: 'ws-1',
      kind: 'group',
      memberIds: ['user-2', 'user-3'],
      externalContactIds: [],
    }))
    expect(mockAddMembers).not.toHaveBeenCalled()
    expect(onClose).toHaveBeenCalled()
  })

  it('移除成员后同步会话摘要人数，聊天顶部无需切换会话即可刷新', async () => {
    const updatedDetail = await groupDetail().then((detail) => ({
      ...detail,
      member_count: 2,
      members: detail.members.filter((member) => member.user_id !== 'user-2'),
    }))
    mockGetConversation
      .mockImplementationOnce(groupDetail)
      .mockResolvedValueOnce(updatedDetail)
    const { ConversationDetailPanel } = await import('./ConversationDetailPanel')
    render(<ConversationDetailPanel conversationId="group-1" isOpen onClose={vi.fn()} />)

    await screen.findByText('2 人 · 1 AI')
    fireEvent.click(screen.getAllByTitle('removeMember')[0])
    fireEvent.click(screen.getByText('confirm'))

    await waitFor(() => expect(mockRemoveMember).toHaveBeenCalledWith('group-1', 'user-2'))
    expect(await screen.findByText('1 人 · 1 AI')).toBeTruthy()
    expect(screen.queryByText('Bob')).toBeNull()
    expect((imStoreRef.current.conversations as Array<{ member_count: number }>)[0].member_count).toBe(2)
  })

  it('腾讯退出事件更新共享快照后，打开中的成员面板立即移除原群主', async () => {
    mockGetConversation.mockImplementation(groupDetail)
    const { ConversationDetailPanel } = await import('./ConversationDetailPanel')
    render(<ConversationDetailPanel conversationId="group-1" isOpen onClose={vi.fn()} />)

    expect(await screen.findByText('Bob')).toBeTruthy()
    const currentMembers = (
      imStoreRef.current.conversationMembers as Record<string, Array<Record<string, unknown>>>
    )['group-1']
    act(() => {
      setMockIMState((state) => ({
        conversationMembers: {
          ...(state.conversationMembers as Record<string, unknown>),
          'group-1': currentMembers.filter((member) => member.user_id !== 'user-2'),
        },
      }))
    })

    await waitFor(() => expect(screen.queryByText('Bob')).toBeNull())
    expect(screen.getByText('1 人 · 1 AI')).toBeTruthy()
  })

  it('添加 AI 成员后立即刷新人类与 AI 人数拆分', async () => {
    mockSearchOrganizationAgents.mockResolvedValue([
      { id: 'agent-2', name: 'Second Bot', avatar: '' },
    ])
    const updatedDetail = await groupDetail().then((detail) => ({
      ...detail,
      member_count: 4,
      members: [
        ...detail.members,
        { member_type: 'agent' as const, user_id: null, agent_id: 'agent-2', nickname: 'Second Bot', username: '', avatar: '', role: 1, is_muted: false, pinned: false, joined_at: null },
      ],
    }))
    mockGetConversation
      .mockImplementationOnce(groupDetail)
      .mockResolvedValueOnce(updatedDetail)
    const { ConversationDetailPanel } = await import('./ConversationDetailPanel')
    render(<ConversationDetailPanel conversationId="group-1" isOpen onClose={vi.fn()} />)

    fireEvent.click(await screen.findByRole('button', { name: 'addMember' }))
    fireEvent.click(await screen.findByRole('button', { name: /Second Bot/ }))
    fireEvent.click(await screen.findByRole('button', { name: 'confirmWorkspace' }))

    await waitFor(() => expect(mockCreateConversationAgentBinding).toHaveBeenCalledWith(
      'group-1',
      'agent-2',
      'ws-home',
    ))
    expect(mockAddAgents).not.toHaveBeenCalled()
    expect(await screen.findByText('2 人 · 2 AI')).toBeTruthy()
    expect((imStoreRef.current.conversations as Array<{ member_count: number }>)[0].member_count).toBe(4)
  })

  it('成员行展示绑定现场，主人可更换', async () => {
    mockListConversationAgentBindings.mockResolvedValue([
      {
        agent_id: 'agent-1',
        workspace_id: 'ws-home',
        workspace_name: '主场',
        bound_by_user_id: 'user-1',
        bound_at: null,
        can_rebind: true,
        is_executable: true,
      },
    ])
    mockGetConversation.mockImplementation(groupDetail)
    const { ConversationDetailPanel } = await import('./ConversationDetailPanel')
    render(<ConversationDetailPanel conversationId="group-1" isOpen onClose={vi.fn()} />)

    expect(await screen.findByText('主场')).toBeTruthy()
    fireEvent.click(await screen.findByRole('button', { name: 'changeAgentWorkspace' }))
    fireEvent.click(await screen.findByRole('button', { name: 'confirmWorkspace' }))
    await waitFor(() => expect(mockUpdateConversationAgentBinding).toHaveBeenCalledWith(
      'group-1',
      'agent-1',
      'ws-home',
    ))
  })

  it('离线 Agent 置灰但仍可更换现场', async () => {
    mockGetConversation.mockImplementation(() => groupDetail().then((detail) => ({
      ...detail,
      members: detail.members.map((member) => (
        member.agent_id === 'agent-1'
          ? { ...member, is_execution_online: false }
          : member
      )),
    })))
    mockListConversationAgentBindings.mockResolvedValue([
      {
        agent_id: 'agent-1',
        workspace_id: 'ws-home',
        workspace_name: '主场',
        bound_by_user_id: 'user-1',
        bound_at: null,
        can_rebind: true,
        is_executable: true,
      },
    ])
    const { ConversationDetailPanel } = await import('./ConversationDetailPanel')
    render(<ConversationDetailPanel conversationId="group-1" isOpen onClose={vi.fn()} />)

    expect(await screen.findByLabelText('offline')).toBeTruthy()
    const identity = document.querySelector('[data-offline="true"]')
    expect(identity).toBeTruthy()
    expect(identity?.className).toContain('opacity-50')
    const changeButton = await screen.findByRole('button', { name: 'changeAgentWorkspace' })
    expect((changeButton as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(changeButton)
    fireEvent.click(await screen.findByRole('button', { name: 'confirmWorkspace' }))
    await waitFor(() => expect(mockUpdateConversationAgentBinding).toHaveBeenCalledWith(
      'group-1',
      'agent-1',
      'ws-home',
    ))
  })

  it('成员行在现场失效时提示重新指定', async () => {
    mockListConversationAgentBindings.mockResolvedValue([
      {
        agent_id: 'agent-1',
        workspace_id: 'ws-home',
        workspace_name: '主场',
        bound_by_user_id: 'user-1',
        bound_at: null,
        can_rebind: true,
        is_executable: false,
      },
    ])
    mockGetConversation.mockImplementation(groupDetail)
    const { ConversationDetailPanel } = await import('./ConversationDetailPanel')
    render(<ConversationDetailPanel conversationId="group-1" isOpen onClose={vi.fn()} />)

    expect(await screen.findByText('workspaceStale:主场')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'changeAgentWorkspace' })).toBeTruthy()
  })

  it('group form shows crop-avatar uploader for admins, dm does not', async () => {
    mockGetConversation.mockImplementation(groupDetail)
    const { ConversationDetailPanel } = await import('./ConversationDetailPanel')
    const { unmount } = render(<ConversationDetailPanel conversationId="group-1" isOpen onClose={vi.fn()} />)
    expect(await screen.findByText('2 人 · 1 AI')).toBeTruthy()
    expect(screen.getByText('humanMembers (2)')).toBeTruthy()
    expect(screen.getByText('agentMembers (1)')).toBeTruthy()
    expect(screen.getByTestId('avatar-crop-uploader')).toBeTruthy()
    unmount()

    mockGetConversation.mockImplementation(dmDetail)
    render(<ConversationDetailPanel conversationId="dm-1" isOpen onClose={vi.fn()} />)
    expect(await screen.findByText('chatInfo')).toBeTruthy()
    expect(screen.queryByTestId('avatar-crop-uploader')).toBeNull()
  })

  it('dm form shows chat info and hides leave group', async () => {
    mockGetConversation.mockImplementation(dmDetail)
    const { ConversationDetailPanel } = await import('./ConversationDetailPanel')
    render(<ConversationDetailPanel conversationId="dm-1" isOpen onClose={vi.fn()} />)

    expect(await screen.findByText('chatInfo')).toBeTruthy()
    expect(screen.getByText('mute')).toBeTruthy()
    expect(screen.getByText('clearHistory')).toBeTruthy()
    expect(screen.queryByText('leaveGroup')).toBeNull()
  })

  it('私聊资料未上传图片时展示与聊天区一致的姓名头像', async () => {
    profilesRef.current = { 'user-2': { nickname: '晨曦', username: 'morning', avatar: '' } }
    mockGetConversation.mockImplementation(dmDetail)
    const { ConversationDetailPanel } = await import('./ConversationDetailPanel')
    render(<ConversationDetailPanel conversationId="dm-1" isOpen onClose={vi.fn()} />)

    expect(await screen.findByText('晨')).toBeTruthy()
    expect(mockEnsureProfiles).toHaveBeenCalledWith(['user-2'])
  })

  it('clear history confirms then calls api and clears local messages', async () => {
    mockGetConversation.mockImplementation(dmDetail)
    const { ConversationDetailPanel } = await import('./ConversationDetailPanel')
    render(<ConversationDetailPanel conversationId="dm-1" isOpen onClose={vi.fn()} />)

    fireEvent.click(await screen.findByText('clearHistory'))
    fireEvent.click(screen.getByText('confirm'))

    await waitFor(() => {
      expect(mockClearHistory).toHaveBeenCalledWith('dm-1')
    })
    expect(mockClearConversationMessages).toHaveBeenCalledWith('dm-1')
  })

  it('keeps local messages when Tencent history clearing fails', async () => {
    mockGetConversation.mockImplementation(dmDetail)
    mockClearHistory.mockRejectedValueOnce(new Error('Tencent clear failed'))
    const { ConversationDetailPanel } = await import('./ConversationDetailPanel')
    render(<ConversationDetailPanel conversationId="dm-1" isOpen onClose={vi.fn()} />)

    fireEvent.click(await screen.findByText('clearHistory'))
    fireEvent.click(screen.getByText('confirm'))

    await waitFor(() => {
      expect(mockToast).toHaveBeenCalledWith({
        title: 'clearHistoryFailed',
        variant: 'destructive',
      })
    })
    expect(mockClearConversationMessages).not.toHaveBeenCalled()
  })

  it('leave group confirms then calls api, removes conversation and closes', async () => {
    mockGetConversation.mockImplementation(groupDetail)
    const onClose = vi.fn()
    const { ConversationDetailPanel } = await import('./ConversationDetailPanel')
    render(<ConversationDetailPanel conversationId="group-1" isOpen onClose={onClose} />)

    fireEvent.click(await screen.findByText('leaveGroup'))
    fireEvent.click(screen.getByText('confirm'))

    await waitFor(() => {
      expect(mockLeaveConversation).toHaveBeenCalledWith('group-1', 'user-1')
    })
    expect(mockRemoveConversation).toHaveBeenCalledWith('group-1')
    expect(onClose).toHaveBeenCalled()
  })

  it('退出请求进行中重复确认只提交一次', async () => {
    let resolveLeave!: () => void
    mockLeaveConversation.mockImplementationOnce(() => new Promise<void>((resolve) => {
      resolveLeave = resolve
    }))
    mockGetConversation.mockImplementation(groupDetail)
    const { ConversationDetailPanel } = await import('./ConversationDetailPanel')
    render(<ConversationDetailPanel conversationId="group-1" isOpen onClose={vi.fn()} />)

    fireEvent.click(await screen.findByText('leaveGroup'))
    const confirmButton = screen.getByText('confirm').closest('button')
    expect(confirmButton).toBeTruthy()

    fireEvent.click(confirmButton!)
    fireEvent.click(confirmButton!)

    expect(mockLeaveConversation).toHaveBeenCalledTimes(1)
    expect(confirmButton?.getAttribute('disabled')).not.toBeNull()

    resolveLeave()
    await waitFor(() => expect(mockRemoveConversation).toHaveBeenCalledWith('group-1'))
  })
})
