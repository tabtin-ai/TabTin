import React from 'react'
import { render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CHAT_CONTENT_FILTER_MESSAGE, MEMBER_ROLE_ADMIN, MEMBER_ROLE_MEMBER, MEMBER_ROLE_OWNER } from '@/constants/tabchat'

const { conversationsRef, membersRef } = vi.hoisted(() => ({
  conversationsRef: {
    current: [
      {
        id: 'group-1',
        type: 2,
        name: '李四123123',
        member_count: 2,
        is_team_space_channel: false,
      },
    ] as Array<{
      id: string
      type: number
      name: string
      member_count: number
      is_team_space_channel: boolean
      space_id?: string
      space_name?: string
    }>,
  },
  membersRef: { current: [] as Array<Record<string, unknown>> },
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, string>) => options?.defaultValue ?? key,
  }),
}))

vi.mock('@tabtin/smartsheet-ui', () => ({ toast: vi.fn() }))

vi.mock('@stores/useAuthStore', () => ({
  useAuthStore: (selector: (state: { user: { id: string } }) => unknown) =>
    selector({ user: { id: 'user-1' } }),
}))

vi.mock('@stores/useIMStore', () => {
  const useIMStore = Object.assign(
    (selector: (state: Record<string, unknown>) => unknown) =>
      selector({
        conversations: conversationsRef.current,
        conversationMembers: {
          'group-1': membersRef.current,
          'channel-1': membersRef.current,
        },
      }),
    {
      getState: () => ({
        updateConversation: vi.fn(),
      }),
    },
  )
  return { useIMStore }
})

vi.mock('@stores/useUserProfileCache', () => ({
  useUserProfile: () => undefined,
  useUserProfileCache: (selector: (state: { ensureProfiles: () => void }) => unknown) =>
    selector({ ensureProfiles: vi.fn() }),
}))

vi.mock('@stores/useSpaceViewPrefsStore', () => ({
  useSpaceViewPrefsStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      getCanvasCollapsed: () => false,
      toggleCanvasCollapsedForScope: vi.fn(),
    }),
}))

vi.mock('@stores/useSpaceContextTabsStore', () => ({
  useSpaceContextTabsStore: (selector: (state: { tabOrderBySpace: Record<string, string[]> }) => unknown) =>
    selector({ tabOrderBySpace: {} }),
}))

vi.mock('./ImConversationCanvasContext', () => ({
  useImConversationCanvas: () => null,
}))

vi.mock('./conversationMembers', () => ({
  countMemberBreakdown: vi.fn(() => ({ human: 2, agent: 0 })),
}))

vi.mock('@components/common/ChipTabBar', () => ({
  ChipTabBar: () => <div data-testid="chip-tab-bar" />,
}))

vi.mock('@/services/tabchatApi', () => ({
  updateConversation: vi.fn(),
}))

function membersWithRole(role: number) {
  return [
    {
      member_type: 'user',
      user_id: 'user-1',
      agent_id: null,
      nickname: 'Me',
      username: 'me',
      avatar: '',
      role,
      is_muted: false,
      pinned: false,
      joined_at: null,
    },
    {
      member_type: 'user',
      user_id: 'user-2',
      agent_id: null,
      nickname: 'Bob',
      username: 'bob',
      avatar: '',
      role: MEMBER_ROLE_MEMBER,
      is_muted: false,
      pinned: false,
      joined_at: null,
    },
  ]
}

describe('ChatHeader 改群名权限', () => {
  beforeEach(() => {
    conversationsRef.current = [
      {
        id: 'group-1',
        type: 2,
        name: '李四123123',
        member_count: 2,
        is_team_space_channel: false,
      },
    ]
  })

  it('群主可见顶栏改名入口', async () => {
    membersRef.current = membersWithRole(MEMBER_ROLE_OWNER)
    const { ChatHeader } = await import('./ChatHeader')
    render(
      <ChatHeader
        conversationId="group-1"
        contentFilter={CHAT_CONTENT_FILTER_MESSAGE}
        onContentFilterChange={vi.fn()}
      />,
    )

    expect(await screen.findByRole('button', { name: 'editGroupName' })).toBeTruthy()
  })

  it('群管理员可见顶栏改名入口', async () => {
    membersRef.current = membersWithRole(MEMBER_ROLE_ADMIN)
    const { ChatHeader } = await import('./ChatHeader')
    render(
      <ChatHeader
        conversationId="group-1"
        contentFilter={CHAT_CONTENT_FILTER_MESSAGE}
        onContentFilterChange={vi.fn()}
      />,
    )

    expect(await screen.findByRole('button', { name: 'editGroupName' })).toBeTruthy()
  })

  it('普通成员不显示顶栏改名入口', async () => {
    membersRef.current = membersWithRole(MEMBER_ROLE_MEMBER)
    const { ChatHeader } = await import('./ChatHeader')
    render(
      <ChatHeader
        conversationId="group-1"
        contentFilter={CHAT_CONTENT_FILTER_MESSAGE}
        onContentFilterChange={vi.fn()}
      />,
    )

    expect(screen.queryByRole('button', { name: 'editGroupName' })).toBeNull()
    expect(screen.getByRole('heading', { name: '李四123123' })).toBeTruthy()
  })

  it('Project 频道即使本人是群主也不显示顶栏改名入口', async () => {
    conversationsRef.current = [
      {
        id: 'channel-1',
        type: 2,
        name: '#general',
        member_count: 2,
        is_team_space_channel: true,
        space_id: 'team-space-1',
        space_name: 'Live验证房间',
      },
    ]
    membersRef.current = membersWithRole(MEMBER_ROLE_OWNER)
    const { ChatHeader } = await import('./ChatHeader')
    render(
      <ChatHeader
        conversationId="channel-1"
        contentFilter={CHAT_CONTENT_FILTER_MESSAGE}
        onContentFilterChange={vi.fn()}
      />,
    )

    await waitFor(() => {
      expect(screen.getByText('Project 频道')).toBeTruthy()
    })
    expect(screen.queryByRole('button', { name: 'editGroupName' })).toBeNull()
  })
})
