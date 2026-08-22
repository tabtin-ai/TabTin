import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CONVERSATION_TYPE_DM, CONVERSATION_TYPE_GROUP, MESSAGE_TYPE_TEXT } from '@/constants/tabchat'
import type { Conversation, IMMessage } from '@/services/tabchatApi'

const { mockEnsureProfiles, mockListExternalContacts } = vi.hoisted(() => ({
  mockEnsureProfiles: vi.fn(),
  mockListExternalContacts: vi.fn(),
}))

vi.mock('@/services/tabchatApi', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/services/tabchatApi')>(),
  listExternalContacts: mockListExternalContacts,
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock('@tabtin/smartsheet-ui', () => ({ toast: vi.fn() }))

vi.mock('@components/ui', () => ({
  Dialog: ({ open, children }: { open: boolean; children: React.ReactNode }) => open ? <>{children}</> : null,
  DialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
}))

const conversations: Conversation[] = [
  {
    id: 'dm-1',
    organization_id: 'org-1',
    type: CONVERSATION_TYPE_DM,
    name: 'TabTin private conversation',
    avatar_url: '',
    member_count: 2,
    last_message_at: null,
    last_message_preview: '',
    unread_count: 0,
    created_at: '2026-08-04T00:00:00Z',
    dm_peer_user_id: 'peer-1',
  },
  {
    id: 'group-1',
    organization_id: 'org-1',
    type: CONVERSATION_TYPE_GROUP,
    name: '产品群',
    avatar_url: '',
    member_count: 3,
    last_message_at: null,
    last_message_preview: '',
    unread_count: 0,
    created_at: '2026-08-04T00:00:00Z',
  },
  {
    id: 'group-external',
    organization_id: 'org-1',
    type: CONVERSATION_TYPE_GROUP,
    name: '外部群',
    avatar_url: '',
    member_count: 3,
    last_message_at: null,
    last_message_preview: '',
    unread_count: 0,
    created_at: '2026-08-04T00:00:00Z',
    is_external: true,
  },
  {
    id: 'dm-removed',
    organization_id: 'org-1',
    type: CONVERSATION_TYPE_DM,
    name: '已移除成员',
    avatar_url: '',
    member_count: 1,
    last_message_at: null,
    last_message_preview: '',
    unread_count: 0,
    created_at: '2026-08-04T00:00:00Z',
    dm_peer_user_id: 'peer-removed',
    can_send: false,
    dm_peer_membership_status: 'removed' as const,
  },
]

vi.mock('@stores/useIMStore', () => ({
  useIMStore: Object.assign(
    (selector: (state: { conversations: typeof conversations }) => unknown) => selector({ conversations }),
    { getState: () => ({ sendMessage: vi.fn() }) },
  ),
}))

vi.mock('@stores/useOrganizationStore', () => ({
  useOrganizationStore: (selector: (state: { selectedOrganization: { id: string } }) => unknown) =>
    selector({ selectedOrganization: { id: 'org-1' } }),
}))

vi.mock('@stores/useUserProfileCache', () => ({
  useUserProfileCache: (selector: (state: {
    profiles: Record<string, { id: string; nickname: string; username: string; avatar: string }>
    ensureProfiles: typeof mockEnsureProfiles
  }) => unknown) => selector({
    profiles: {
      'peer-1': {
        id: 'peer-1',
        nickname: '沈庾涛',
        username: 'carol',
        avatar: 'https://example.com/peer.png',
      },
    },
    ensureProfiles: mockEnsureProfiles,
  }),
}))

import { ConversationPickerDialog } from './ConversationPickerDialog'
import { ForwardDialog } from './ForwardDialog'

const message: IMMessage = {
  id: 1,
  conversation_id: 'group-1',
  sender_id: 'sender-1',
  sender_name: '发送者',
  content: '测试消息',
  message_type: MESSAGE_TYPE_TEXT,
  reply_to_id: null,
  has_attachment: false,
  metadata: {},
  created_at: '2026-08-04T00:00:00Z',
  is_deleted: false,
  reactions: {},
}

const dialogs = [
  {
    name: '转发选择器',
    renderDialog: () => render(<ForwardDialog isOpen onClose={vi.fn()} message={message} />),
  },
  {
    name: '通用会话选择器',
    renderDialog: () => render(
      <ConversationPickerDialog isOpen onClose={vi.fn()} onSelect={vi.fn()} />,
    ),
  },
]

describe.each(dialogs)('$name', ({ renderDialog }) => {
  beforeEach(() => {
    mockEnsureProfiles.mockClear()
    mockListExternalContacts.mockResolvedValue({ items: [] })
  })
  afterEach(cleanup)

  it('私聊展示对方资料并支持按用户名搜索', async () => {
    const { container } = renderDialog()

    expect(screen.getByText('沈庾涛')).toBeTruthy()
    expect(screen.queryByText('TabTin private conversation')).toBeNull()
    expect(screen.getByText('产品群')).toBeTruthy()
    expect(container.querySelector('img')?.getAttribute('src')).toBe('https://example.com/peer.png')

    fireEvent.change(screen.getByPlaceholderText('forwardSearch'), { target: { value: '沈庾' } })

    expect(screen.getByText('沈庾涛')).toBeTruthy()
    expect(screen.queryByText('产品群')).toBeNull()

    fireEvent.change(screen.getByPlaceholderText('forwardSearch'), { target: { value: 'carol' } })

    expect(screen.getByText('沈庾涛')).toBeTruthy()
    await waitFor(() => expect(mockEnsureProfiles).toHaveBeenCalledWith(['peer-1']))
  })

  it('不把已移除成员的只读私聊列为转发或分享目标', () => {
    renderDialog()

    expect(screen.queryByText('已移除成员')).toBeNull()
  })

  it('未配置头像时使用与聊天列表一致的彩色默认头像', () => {
    renderDialog()

    const groupRow = screen.getByText('产品群').closest('button')
    const initial = groupRow?.querySelector('span')
    expect(initial?.textContent).toBe('产')
    expect((initial?.parentElement as HTMLElement).style.backgroundColor).not.toBe('')
  })
})

describe('外部会话富内容限制', () => {
  beforeEach(() => mockListExternalContacts.mockResolvedValue({ items: [] }))
  afterEach(cleanup)

  it('资源分享选择器不展示外部会话', () => {
    render(<ConversationPickerDialog isOpen onClose={vi.fn()} onSelect={vi.fn()} />)

    expect(screen.queryByText('外部群')).toBeNull()
  })

  it('普通文本转发仍展示外部会话', () => {
    render(<ForwardDialog isOpen onClose={vi.fn()} message={message} />)

    expect(screen.getByText('外部群')).toBeTruthy()
  })

  it('同一用户的外部私聊展示并支持搜索对端组织', async () => {
    conversations.push({
      ...conversations[0],
      id: 'dm-external-peer-1',
      is_external: true,
      dm_peer_organization_id: 'peer-org-1',
    })
    mockListExternalContacts.mockResolvedValue({
      items: [{
        contact_id: 'contact-1',
        organization_id: 'org-1',
        peer_organization_id: 'peer-org-1',
        peer_user_id: 'peer-1',
        display_name: '沈庾涛',
        avatar_url: '',
        relationship: 'friend',
        is_restorable: false,
        updated_at: '',
        peer_organization_name: '合作组织',
      }],
    })

    try {
      render(<ForwardDialog isOpen onClose={vi.fn()} message={message} />)

      expect(await screen.findByText('dm · 合作组织')).toBeTruthy()
      fireEvent.change(screen.getByPlaceholderText('forwardSearch'), {
        target: { value: '合作组织' },
      })
      expect(screen.getAllByText('沈庾涛')).toHaveLength(1)
    } finally {
      conversations.pop()
    }
  })

  it('卡片转发不展示外部会话', () => {
    render(
      <ForwardDialog
        isOpen
        onClose={vi.fn()}
        message={{ ...message, metadata: { card: { type: 'table' } } }}
      />,
    )

    expect(screen.queryByText('外部群')).toBeNull()
  })
})
