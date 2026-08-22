import React from 'react'
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { CHAT_CONTENT_FILTER_MESSAGE } from '@/constants/tabchat'

const { conversationsRef, membersRef } = vi.hoisted(() => ({
  conversationsRef: {
    current: [] as Array<Record<string, unknown>>,
  },
  membersRef: { current: [] as Array<Record<string, unknown>> },
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, string>) => {
      if (key === 'fromExternalOrganization' && options?.organization) {
        return `来自${options.organization}`
      }
      if (key === 'externalContacts.external') return '外部'
      return options?.defaultValue ?? key
    },
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
          'dm-1': membersRef.current,
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
  useUserProfile: () => ({ nickname: '李四', username: 'jct', avatar: '' }),
  useUserProfileCache: (selector: (state: { ensureProfiles: () => void }) => unknown) =>
    selector({ ensureProfiles: vi.fn() }),
}))

vi.mock('@stores/useSpaceViewPrefsStore', () => ({
  useSpaceViewPrefsStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      getCanvasCollapsed: () => false,
      getTaskViewMode: () => null,
      setCanvasCollapsedForScope: vi.fn(),
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

describe('ChatHeader 外部组织', () => {
  it('外部私聊副标题显示来自对端组织', async () => {
    conversationsRef.current = [
      {
        id: 'dm-1',
        type: 1,
        name: '',
        is_external: true,
        dm_peer_user_id: 'user-2',
        dm_peer_organization_id: 'org-2',
      },
    ]
    membersRef.current = [
      {
        user_id: 'user-1',
        is_external: false,
        organization_name: '当前组织',
        participant_organization_id: 'org-1',
      },
      {
        user_id: 'user-2',
        is_external: true,
        organization_name: '合作组织',
        participant_organization_id: 'org-2',
      },
    ]
    const { ChatHeader } = await import('./ChatHeader')
    render(
      <ChatHeader
        conversationId="dm-1"
        contentFilter={CHAT_CONTENT_FILTER_MESSAGE}
        onContentFilterChange={vi.fn()}
      />,
    )

    expect(screen.getByRole('heading', { name: '李四' })).toBeTruthy()
    expect(screen.getByText('外部')).toBeTruthy()
    expect(screen.getByText('来自合作组织')).toBeTruthy()
  })
})
